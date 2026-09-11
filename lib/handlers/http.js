/**
 * 声明式通用取数处理器（handler: 'http'）。
 *
 * 存在的理由：大多数库就是一个普通 REST 接口——拼 URL、代入参数、注入凭据、从响应里取一段。
 * 把这些用注册表里的 `request` 描述出来，就不必为每个新库写一个 handler 模块，
 * "以后加库只改注册表"对普通接口才真正成立。
 *
 * 注册表里的形状：
 *   handler: 'http'
 *   request: {
 *     url: 'https://api.example.com/search',
 *     method: 'GET',                                  // 默认 GET
 *     query:   { q: '{query}', limit: 20 },           // {参数名} 代入调用参数
 *     headers: { 'X-Api-Key': '{credential:MY_KEY}' },// {credential:引用名} 注入凭据
 *     body:    { ... },                               // POST 时用
 *     pick:    'data.items',                          // 从响应里取哪一段（点路径）
 *     limit:   50,                                    // 数组最多返回多少条
 *     required: ['query'],                            // 缺了就在发请求前报错
 *     minGapMs: 1000,                                 // 礼节性节流
 *     paginate: { param: 'page', start: 1, pages: 3 },// 或 totalPath: 'meta.totalPages'
 *   }
 *
 * 安全约束：凭据值只出现在真实请求里，**永不进入返回值**——回报的 URL 与 headers 都是脱敏版。
 *
 * @module dsh-stash/handlers/http
 */
import { fetchJson, SourceHttpError } from '../http.js'

const MAX_PAGES_CAP = 10
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*|credential:[A-Za-z_][A-Za-z0-9_]*)\}/g

export const GUARANTEES = [
  '凭据值只出现在真实请求中，回传的 URL / headers / body 一律脱敏为 ***引用名***',
  'required 里声明的参数缺失时在发请求前报错，不靠服务端 400 才发现',
  '分页有页数上限，避免一次工具调用打出无界请求',
]

export const ACTIONS = {
  '<注册表里自定义>': '动作名由注册表的 actions 决定；可用 {action} 占位符代入请求',
}

const fail = (kind, error, hint) => ({ ok: false, kind, error, hint: hint ?? null })

/** 从任意嵌套结构里收集 {credential:REF} 用到的引用名。 */
function collectCredentialRefs(value, into = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER)) {
      const token = match[1]
      if (token.startsWith('credential:')) into.add(token.slice('credential:'.length))
    }
    return into
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialRefs(item, into)
    return into
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectCredentialRefs(item, into)
    return into
  }
  return into
}

/**
 * 代入占位符。
 * @param {unknown} value
 * @param {Record<string, unknown>} env 可用值：调用参数 + action + page
 * @param {Map<string, string>} secrets 引用名 → 真值
 * @param {boolean} redact true 时凭据替换为 ***引用名***
 */
function substitute(value, env, secrets, redact) {
  if (typeof value === 'string') {
    // 整串就是一个占位符时保留原始类型（数字/布尔传进 query 更有用）。
    const whole = value.match(/^\{([A-Za-z_][A-Za-z0-9_]*|credential:[A-Za-z_][A-Za-z0-9_]*)\}$/)
    if (whole) {
      const token = whole[1]
      if (token.startsWith('credential:')) {
        const ref = token.slice('credential:'.length)
        return redact ? `***${ref}***` : (secrets.get(ref) ?? '')
      }
      return env[token] ?? ''
    }
    return value.replace(PLACEHOLDER, (_match, token) => {
      if (token.startsWith('credential:')) {
        const ref = token.slice('credential:'.length)
        return redact ? `***${ref}***` : (secrets.get(ref) ?? '')
      }
      const resolved = env[token]
      return resolved === undefined || resolved === null ? '' : String(resolved)
    })
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, env, secrets, redact))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = substitute(item, env, secrets, redact)
    return out
  }
  return value
}

/** 点路径取值：'data.items' / 'rows.0.name'。 */
function pickPath(value, path) {
  if (!path) return value
  let current = value
  for (const key of String(path).split('.')) {
    if (current === null || current === undefined) return undefined
    current = Array.isArray(current) && /^\d+$/.test(key) ? current[Number(key)] : current[key]
  }
  return current
}

function buildUrl(template, query, redact, env, secrets) {
  const substitutedUrl = substitute(template, env, secrets, redact)
  let url
  try {
    url = new URL(substitutedUrl)
  } catch {
    return null
  }
  for (const [key, raw] of Object.entries(query ?? {})) {
    const value = substitute(raw, env, secrets, redact)
    if (value === '' || value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * @param {string} action 注册表里声明的动作名
 * @param {Record<string, unknown>} params 调用参数
 * @param {{ source?: object, credentials?: unknown }} [context]
 */
export async function run(action, params = {}, context = {}) {
  const request = context?.source?.request
  if (!request || typeof request.url !== 'string') {
    return fail('bad-config', '该库声明了 handler:"http"，但注册表里缺少 request.url', '在 sources.mjs 里补上 request: { url: ... }')
  }

  const env = { ...params, action, page: 1 }

  // 1. 必填参数前置校验
  const required = Array.isArray(request.required) ? request.required : []
  const missing = required.filter((name) => params[name] === undefined || params[name] === null || params[name] === '')
  if (missing.length > 0) {
    return fail('usage', `缺少必填参数：${missing.join(', ')}`, `本动作需要的参数：${required.join(', ')}`)
  }

  // 2. 解析本次请求涉及的所有凭据（每次都重新解析，不缓存）
  const refs = collectCredentialRefs(request)
  const secrets = new Map()
  if (refs.size > 0) {
    const credentials = context?.credentials
    if (!credentials) {
      return fail('no-credentials', `该库需要凭据 ${[...refs].join(', ')}，但本部署没有 credentials 服务`)
    }
    for (const ref of refs) {
      try {
        const resolved = await credentials.resolve(ref)
        if (!resolved?.value) {
          return fail(
            'credential-missing',
            `凭据 "${ref}" 未配置`,
            `把它的值写进 ~/.dsh/.credentials.yaml 的 refs 段（只写引用名与值，不要写进注册表），然后重试。`,
          )
        }
        secrets.set(ref, resolved.value)
      } catch (error) {
        return fail('credential-error', `解析凭据 "${ref}" 失败：${error?.message ?? String(error)}`)
      }
    }
  }

  const method = String(request.method ?? 'GET').toUpperCase()
  const headers = substitute(request.headers ?? {}, env, secrets, false)
  const redactedHeaders = substitute(request.headers ?? {}, env, secrets, true)
  const body = request.body === undefined ? undefined : substitute(request.body, env, secrets, false)

  // 3. 分页抓取
  const paginate = request.paginate && typeof request.paginate === 'object' ? request.paginate : null
  const pageParam = typeof paginate?.param === 'string' && paginate.param ? paginate.param : 'page'
  const startPage = Number.isFinite(Number(paginate?.start)) ? Number(paginate.start) : 1
  const maxPages = Math.min(Math.max(Number(paginate?.maxPages ?? MAX_PAGES_CAP) || MAX_PAGES_CAP, 1), MAX_PAGES_CAP)

  const collected = []
  let objectResult
  let listMode = false
  let pagesFetched = 0
  /** 失败时也要回报脱敏 URL —— 凭据可能出现在 query 里。 */
  let lastRedactedUrl = null
  let firstUrl = null
  let firstRedactedUrl = null
  let status = null
  let bytes = 0
  let cached = false
  let fetchedAt = null

  try {
    for (let index = 0; index < (paginate ? maxPages : 1); index += 1) {
      const page = startPage + index
      const pageEnv = { ...env, page }
      const query = { ...(request.query ?? {}) }
      if (paginate && page !== 0) query[pageParam] = page

      const url = buildUrl(request.url, query, false, pageEnv, secrets)
      const redactedUrl = buildUrl(request.url, query, true, pageEnv, secrets)
      if (!url) return fail('bad-config', `request.url 不是合法 URL：${request.url}`)
      lastRedactedUrl = redactedUrl

      const host = new URL(url).host
      const response = await fetchJson(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        refresh: Boolean(params.refresh),
        minGapMs: Number(request.minGapMs ?? 0) || 0,
        host,
      })

      pagesFetched += 1
      status = response.status
      bytes += response.bytes
      fetchedAt = response.fetchedAt
      if (index === 0) {
        firstUrl = url
        firstRedactedUrl = redactedUrl
        cached = response.cached
      }

      const picked = pickPath(response.data, request.pick)
      if (Array.isArray(picked)) {
        listMode = true
        collected.push(...picked)
      } else {
        objectResult = picked
      }

      if (!paginate) break
      // 只有第一页能告诉我们总页数
      if (index === 0 && typeof paginate.totalPath === 'string') {
        const total = Number(pickPath(response.data, paginate.totalPath))
        if (Number.isFinite(total) && total > 0) {
          const wanted = Math.min(total - startPage + 1, maxPages)
          if (wanted <= 1) break
        }
      }
      if (Array.isArray(picked) && picked.length === 0) break
    }
  } catch (error) {
    if (error instanceof SourceHttpError) {
      // 绝不回报 error.url：那是代入凭据后的真实 URL。用脱敏版本。
      return {
        ...fail('http', `${error.message}${lastRedactedUrl ? ` @ ${lastRedactedUrl}` : ''}`, error.hint),
        status: error.status || null,
        body: error.body || null,
        redacted: true,
      }
    }
    return fail('internal', error?.message ?? String(error))
  }

  const limit = Math.max(1, Number(request.limit ?? 100) || 100)
  const payload = listMode ? collected : objectResult
  const items = Array.isArray(payload) ? payload.slice(0, limit) : payload

  return {
    ok: true,
    source: context?.source?.id ?? null,
    action,
    request: {
      method,
      url: firstRedactedUrl,
      headers: redactedHeaders,
      body: body === undefined ? null : substitute(request.body, env, secrets, true),
    },
    status,
    bytes,
    pagesFetched,
    pick: request.pick ?? null,
    count: Array.isArray(items) ? items.length : 1,
    truncated: Array.isArray(payload) && payload.length > limit,
    items,
    cached,
    fetchedAt,
    guarantees: GUARANTEES,
    redactionNote: 'URL 与 headers 中的凭据已替换为 ***引用名***，真实值只用于本次请求。',
  }
}
