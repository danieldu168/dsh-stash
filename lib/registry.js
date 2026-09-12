/**
 * 注册表加载、校验与代写。
 *
 * 注册表有两个来源，合并后使用：
 *   1. `~/.dsh/stash/sources.mjs`        人写（可写注释、可写表达式）——**程序永不改写它**
 *   2. `~/.dsh/stash/sources.local.json` 工具代写（stash_source_add 落这里）
 * 同 id 时 .mjs 优先，冲突会在 problems 里报出来。
 *
 * 这样分工的理由：手写文件里有你的注释和排版，让程序去改它迟早会毁掉你的编辑；
 * 而"我在对话里加一个库"又不该要求你手动编辑文件。两份文件各管一件事。
 *
 * 关键行为：**每次工具调用都重新读取**（mjs 用 mtime 穿透 ESM 缓存），
 * 所以改完无需重启 harness。
 *
 * @module dsh-stash/registry
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { SOURCES_FILE, SOURCES_LOCAL_FILE, ensureLibDirs } from './home.js'
import { readLocalShard, upsertLocalSource, removeLocalSource } from './shard.js'

const VALID_KINDS = new Set(['remote', 'files'])
const VALID_HANDLERS = new Set(['trade_stats', 'policy_alerts', 'http'])
/**
 * 使用边界：这条库**允许怎么取数**。
 *
 * 它是本插件的定位落点——文库不只回答"能不能取到"，还要回答"这样取算不算越界"。
 * 一个会尽力而为地绕过登录、脚本化抓付费库的取数层，对它的主人是负债。
 *
 *   public-api    公开免登录接口，程序可以直连取数
 *   official-api  需要官方机构 API 或授权凭据，凭据在「设置 → 钥匙」里配
 *   export-import 只能人工在网页端导出后放进 corpus/，**程序不得代为取数**
 *   unsupported   明确不做（条款禁止、需绕过访问控制等）
 */
export const ACCESS_MODES = ['public-api', 'official-api', 'export-import', 'unsupported']
const ACCESS_SET = new Set(ACCESS_MODES)
/** 声明了这两种边界的库，stash_fetch 一律拒绝。 */
export const FETCH_REFUSED_ACCESS = new Set(['export-import', 'unsupported'])

/**
 * 凭据引用名必须是"环境变量风格"：全大写字母、数字、下划线，至少 3 位。
 * 这条约束同时是一道防呆：口令往往是混合大小写，不会通过这个形状。
 * 例：MY_API_KEY、EXAMPLE_DB_PASSWORD、DEEPSEEK_API_KEY。
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/

const TEMPLATE = `// dsh-stash 文库注册表 —— 手写文件，程序不会改写它。
// 对话里让模型添加的库会落到同目录的 sources.local.json，两者自动合并（同 id 以本文件为准）。
//
// 编辑后无需重启：每次工具调用都会重新读这个文件。
//
// 每条库的字段：
//   id          唯一标识（英文小写；stash_fetch 用它）
//   name        展示名
//   kind        'remote' 远程接口 | 'files' 本地语料
//   handler     kind=remote 必填：trade_stats | policy_alerts | http
//                 - trade_stats / policy_alerts 是内置专用实现（含已知坑的固化）
//                 - http 是声明式通用取数，配合下面的 request 用，无需写代码
//   request     handler=http 时必填，形如：
//                 { url, method?, query?, headers?, body?, pick?, limit?, required? }
//               值里可以用 {参数名} 代入调用参数、用 {credential:引用名} 注入凭据
//   paths       kind=files 时必填，本地文件或目录的绝对路径数组
//   credentials 需要的凭据"引用名"数组
//   access      使用边界：public-api | official-api | export-import | unsupported
//                 - export-import 与 unsupported 会被 stash_fetch 拒绝（只留痕，不取数）
//                 - 不写表示"未声明"，取数放行但在 stash_doctor 里提示补上
//   actions     动作说明，会出现在 stash_catalog 里
//   notes       注意事项，会一起回给模型
//   boundary    明确的禁止边界，会一起回给模型
//
// ⛔ 绝不要把口令 / token / key 写进这个文件：它会被备份、被 git、被读进上下文。
//    只写引用名（如 MY_API_KEY），值放在 ~/.dsh/.credentials.yaml，
//    由 credentials 服务按引用名解析——插件每次调用都重新解析，改值无需重启。

export default []
`

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * 校验并规范化一条库条目。
 * @returns {{ entry?: object, problem?: string }}
 */
function normalizeEntry(raw, at, seen) {
  if (!isPlainObject(raw)) return { problem: `${at}：不是对象，已跳过。` }

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return { problem: `${at}：缺少 id，已跳过。` }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    return { problem: `${at}：id "${id}" 不合法（只允许小写字母、数字、- 和 _，且不能以符号开头）。` }
  }
  if (seen.has(id)) return { problem: `${at}：id "${id}" 重复，已跳过。` }

  const kind = typeof raw.kind === 'string' ? raw.kind : 'remote'
  if (!VALID_KINDS.has(kind)) {
    return { problem: `${at}（${id}）：kind 只能是 remote 或 files，实际是 "${kind}"。` }
  }

  let handler
  let request
  if (kind === 'remote') {
    handler = typeof raw.handler === 'string' ? raw.handler : ''
    if (!handler) return { problem: `${at}（${id}）：kind=remote 必须给 handler。` }
    if (!VALID_HANDLERS.has(handler)) {
      return {
        problem: `${at}（${id}）：handler "${handler}" 没有实现。可用：${[...VALID_HANDLERS].join(' / ')}。`
          + '（trade_stats/policy_alerts 是专用实现；自有 REST 接口用 handler:"http" + request）',
      }
    }
    if (handler === 'http') {
      if (!isPlainObject(raw.request) || typeof raw.request.url !== 'string' || !raw.request.url) {
        return { problem: `${at}（${id}）：handler=http 必须给 request.url。` }
      }
      const ttl = raw.request.cacheTtlMs
      if (ttl !== undefined && (!Number.isFinite(Number(ttl)) || Number(ttl) < 0)) {
        return { problem: `${at}（${id}）：request.cacheTtlMs 必须是不小于 0 的数字（毫秒）。` }
      }
      const capture = raw.request.captureHeaders
      if (capture !== undefined
        && (!Array.isArray(capture) || capture.some((name) => typeof name !== 'string' || !name.trim()))) {
        return { problem: `${at}（${id}）：request.captureHeaders 必须是响应头名的字符串数组。` }
      }
      request = raw.request
    }
  }

  if (kind === 'files' && (!Array.isArray(raw.paths) || raw.paths.length === 0)) {
    return { problem: `${at}（${id}）：kind=files 必须给非空 paths 数组。` }
  }

  const credentials = Array.isArray(raw.credentials) ? raw.credentials : []
  for (const ref of credentials) {
    if (typeof ref !== 'string' || !CREDENTIAL_REF_PATTERN.test(ref)) {
      return {
        problem: `${at}（${id}）：credentials 里只能填"引用名"（全大写字母/数字/下划线，如 MY_API_KEY），`
          + `实际收到 ${JSON.stringify(ref)}。口令值请放到 ~/.dsh/.credentials.yaml，不要写进注册表。`,
      }
    }
  }

  // 使用边界：写错就是一条没人执行的承诺，所以在加载期就报错而不是取数时才发现。
  let access = null
  if (raw.access !== undefined && raw.access !== null && raw.access !== '') {
    if (typeof raw.access !== 'string' || !ACCESS_SET.has(raw.access)) {
      return {
        problem: `${at}（${id}）：access 只能是 ${ACCESS_MODES.join(' / ')}，实际是 ${JSON.stringify(raw.access)}。`,
      }
    }
    access = raw.access
  }

  return {
    entry: {
      id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id,
      kind,
      handler,
      request,
      paths: kind === 'files' ? raw.paths.filter((p) => typeof p === 'string') : [],
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      coverage: typeof raw.coverage === 'string' ? raw.coverage : '',
      credentials: credentials.filter((c) => typeof c === 'string'),
      access,
      actions: isPlainObject(raw.actions) ? raw.actions : {},
      notes: Array.isArray(raw.notes) ? raw.notes.filter((n) => typeof n === 'string') : [],
      boundary: typeof raw.boundary === 'string' ? raw.boundary : '',
      origin: raw.__origin ?? 'unknown',
    },
  }
}

/** 从 request 里收集 {credential:REF} 用到的引用名（与 handlers/http.js 同一套占位符语法）。 */
export function collectRequestCredentialRefs(request) {
  const refs = new Set()
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/g)) refs.add(match[1])
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item)
    }
  }
  walk(request)
  return refs
}

/** 收集 request 里用到的 {占位符} 名（不含 credential:）。 */
function collectRequestPlaceholders(request) {
  const names = new Set()
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1])
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item)
    }
  }
  walk(request)
  return names
}

/**
 * 条目自身的深度校验 —— 加载期结构校验查不出来的那部分。
 *
 * 这些问题过去要等真正取数才暴露（发出去 404、或者拿不到凭据），而"注册表写错了"
 * 和"上游挂了"是两件事，不该长得一样。stash_doctor 用它做体检，
 * stash_source_add 用它做登记前拦截。
 *
 * @param {object} source 规范化后的条目
 * @returns {{ level: 'error'|'warn', message: string }[]}
 */
export function validateSourceDeep(source) {
  const issues = []
  const at = `库 "${source.id}"`

  if (source.kind === 'remote' && source.handler === 'http') {
    const request = source.request ?? {}
    let parsed = null
    try {
      parsed = new URL(String(request.url))
    } catch {
      issues.push({ level: 'error', message: `${at}：request.url 不是合法 URL：${JSON.stringify(request.url)}` })
    }
    if (parsed && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      issues.push({ level: 'error', message: `${at}：request.url 只能是 http(s)，实际是 ${parsed.protocol}` })
    }

    const used = collectRequestCredentialRefs(request)
    const declared = new Set(source.credentials ?? [])
    for (const ref of used) {
      if (!declared.has(ref)) {
        issues.push({
          level: 'error',
          message: `${at}：request 里用了 {credential:${ref}}，但 credentials 数组没声明它（取数会拿不到值）。`,
        })
      }
    }
    for (const ref of declared) {
      if (!used.has(ref)) {
        issues.push({
          level: 'warn',
          message: `${at}：credentials 声明了 ${ref}，但 request 里没有用到它。`,
        })
      }
    }

    const placeholders = collectRequestPlaceholders(request)
    for (const name of Array.isArray(request.required) ? request.required : []) {
      if (!placeholders.has(name)) {
        issues.push({
          level: 'error',
          message: `${at}：required 里的 "${name}" 没有出现在 request 的任何占位符里，它只会白挡调用。`,
        })
      }
    }
  }

  if (source.kind === 'files') {
    for (const path of source.paths ?? []) {
      const absolute = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
      if (!absolute) {
        issues.push({ level: 'error', message: `${at}：paths 里的 "${path}" 不是绝对路径。` })
      }
    }
  }

  if (source.kind === 'remote' && source.access === null) {
    issues.push({
      level: 'warn',
      message: `${at}：没有声明 access（使用边界）。补上 ${ACCESS_MODES.join(' / ')} 之一，`
        + '取数层才知道这条库允许怎么取。',
    })
  } else if (source.kind === 'remote' && FETCH_REFUSED_ACCESS.has(source.access)) {
    issues.push({
      level: 'warn',
      message: `${at}：access="${source.access}"，stash_fetch 会拒绝这条库（只留痕）；`
        + '数据请走人工导出 → corpus/ → stash_files 的路径。',
    })
  }

  return issues
}

/**
 * 库条目的代写分片读写 —— 委托给 shard.js。
 *
 * 0.4.0 起 sources.local.json 从「数组」扩成「{ sources, credentials }」对象，
 * 因为台账条目也要有地方落地；读取端两种形状都接受。导出名保持不变，
 * 所以 tools.js / credential-route.js 不需要跟着改。
 */
function readLocalEntries(problems) {
  const shard = readLocalShard()
  problems.push(...shard.problems)
  return shard.sources
}

export function listLocalEntries() {
  return readLocalShard().sources
}

/** 新增或替换一条代写的库条目。 */
export function upsertLocalEntry(entry) {
  return upsertLocalSource(entry)
}

/** 删除一条代写的库条目。手写文件里的条目删不掉（那是你的文件）。 */
export function removeLocalEntry(id) {
  return removeLocalSource(id)
}

/**
 * 载入并合并校验注册表。
 * @param {{ logger?: { warn?: (message: string) => void } }} [options]
 */
export async function loadRegistry(options = {}) {
  ensureLibDirs()

  const problems = []

  // 手写文件：不存在就种一份模板。
  let rawHandwritten = []
  let fatal
  if (!existsSync(SOURCES_FILE)) {
    try {
      writeFileSync(SOURCES_FILE, TEMPLATE, 'utf8')
    } catch (error) {
      fatal = `无法创建注册表：${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!fatal) {
    try {
      const stamp = statSync(SOURCES_FILE).mtimeMs
      const imported = await import(`${pathToFileURL(SOURCES_FILE).href}?v=${stamp}`)
      if (Array.isArray(imported?.default)) {
        rawHandwritten = imported.default.map((entry) => ({ ...entry, __origin: 'handwritten' }))
      } else {
        problems.push('sources.mjs 必须 `export default [ ... ]` 一个数组；本文件已按空表处理。')
      }
    } catch (error) {
      fatal = `sources.mjs 语法错误，无法加载：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const local = readLocalEntries(problems)

  const sources = []
  const seen = new Set()

  rawHandwritten.forEach((entry, index) => {
    const result = normalizeEntry(entry, `sources.mjs 第 ${index + 1} 条`, seen)
    if (result.problem) problems.push(result.problem)
    if (result.entry) {
      seen.add(result.entry.id)
      sources.push(result.entry)
    }
  })

  local.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      problems.push(`sources.local.json 第 ${index + 1} 条（${entry.id}）：与手写文件同 id，手写文件优先，本条被忽略。`)
      return
    }
    const result = normalizeEntry(entry, `sources.local.json 第 ${index + 1} 条`, seen)
    if (result.problem) problems.push(result.problem)
    if (result.entry) {
      seen.add(result.entry.id)
      sources.push(result.entry)
    }
  })

  // 深度校验与结构校验分开：结构问题（problems）让注册表"不可用"，
  // 深度问题（deepIssues）是"能加载但取不到数"，两者的修复动作不同。
  const deepIssues = sources.flatMap((source) =>
    validateSourceDeep(source).map((issue) => ({ ...issue, source: source.id })))

  return {
    ok: problems.length === 0,
    sources,
    problems,
    deepIssues,
    sourcesFile: SOURCES_FILE,
    localFile: SOURCES_LOCAL_FILE,
    fatal,
  }
}

/** 按 id 找一条库。 */
export function findSource(registry, id) {
  return registry.sources.find((source) => source.id === id)
}

export { VALID_HANDLERS }
