/**
 * 对象存储 / 文件传输处理器（handler: 'objstore'）—— C 类形态。
 *
 * 两种协议，零依赖：
 *   · `s3`     —— S3 兼容（AWS S3 / MinIO / 阿里云 OSS 的 S3 兼容端点）。
 *                 私有桶用 SigV4 签名（见 handlers/sigv4.js，已用官方测试向量核对）；
 *                 公开桶不声明凭据即匿名读取。路径式寻址（endpoint/bucket/key），MinIO 直接可用。
 *   · `webdav` —— WebDAV / Nextcloud / 群晖等，PROPFIND 列目录 + GET 取文件，可选 Basic 认证。
 *
 * 注册表里的形状：
 *   handler: 'objstore'
 *   request: {
 *     protocol: 's3',                      // 's3' | 'webdav'
 *     endpoint: 'https://s3.us-east-1.amazonaws.com',   // s3：端点；webdav：目录 URL
 *     bucket:   'my-bucket',               // s3 必填
 *     prefix:   'reports/',                // 可选：list 的默认前缀
 *     region:   'us-east-1',               // s3 签名必填
 *     accessKeyIdRef:     'S3_ACCESS_KEY_ID',      // 引用名，不是值
 *     secretAccessKeyRef: 'S3_SECRET_ACCESS_KEY',
 *     sessionTokenRef:    null,            // 可选
 *     usernameRef: 'WEBDAV_USER', passwordRef: 'WEBDAV_PASSWORD',  // webdav 可选
 *     limit: 50,
 *   }
 *
 * 安全约束：
 *   · 凭据只从宿主凭据服务按引用名解析，绝不进注册表、绝不进返回值（回报的 URL 已脱敏）；
 *   · `get` 只把**文本类**且小于上限的正文回传，二进制只回元信息，避免把图片/压缩包灌进上下文。
 *
 * @module dsh-stash/handlers/objstore
 */
import { signV4Request } from './sigv4.js'

const MAX_BODY_BYTES = 256 * 1024
const LIST_CAP = 1000
const DEFAULT_LIMIT = 50

export const GUARANTEES = [
  '凭据按引用名从宿主凭据服务解析，注册表与返回值里都只有引用名',
  'S3 私有桶用 SigV4 签名（实现已对官方测试向量逐字节核对）',
  'get 只回传文本类且小于 256 KB 的正文；二进制只给元信息，避免撑爆上下文',
  'list 有条数上限，且支持前缀收窄',
]

export const ACTIONS = {
  list: '列出对象/文件；可选 prefix 收窄（s3）或直接列目录（webdav）',
  get: '取一个对象/文件；s3 需要 key，webdav 需要 path 或 key',
}

const fail = (kind, error, hint) => ({ ok: false, kind, error, hint: hint ?? null })
const TEXTUAL = /^(text\/|application\/(json|xml|x-ndjson|csv|javascript|yaml|x-yaml)|image\/svg)/i

/** 解析一个凭据引用名；没有声明就返回 null（合法的"匿名"路径）。 */
async function resolveRef(credentials, ref, what) {
  if (!ref) return { value: null }
  if (!credentials || typeof credentials.resolve !== 'function') {
    return { error: fail('no-credentials', `该库需要凭据 ${ref}（${what}），但本部署没有 credentials 服务`) }
  }
  try {
    const resolved = await credentials.resolve(ref)
    if (!resolved?.value) {
      return {
        error: fail(
          'credential-missing',
          `凭据 "${ref}"（${what}）未配置`,
          '把值写进 ~/.dsh/.credentials.yaml 的 refs 段，或在「设置 → 钥匙」面板粘贴（只登记引用名，不写进注册表）。',
        ),
      }
    }
    return { value: resolved.value }
  } catch (error) {
    return { error: fail('credential-error', `解析凭据 "${ref}" 失败：${error?.message ?? String(error)}`) }
  }
}

const unescapeXml = (text) => String(text)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** 极简 XML 提取：对象存储返回体只有这几个字段要用，够用且不引入依赖。 */
function extractAll(xml, tag) {
  const out = []
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  let match
  while ((match = re.exec(xml)) !== null) out.push(unescapeXml(match[1]))
  return out
}

function parseS3List(xml, limit) {
  const keys = extractAll(xml, 'Key')
  const sizes = extractAll(xml, 'Size')
  const dates = extractAll(xml, 'LastModified')
  return keys.slice(0, limit).map((key, index) => ({
    key,
    size: Number(sizes[index] ?? 0) || 0,
    lastModified: dates[index] ?? null,
  }))
}

function parseWebdavList(xml, limit) {
  const hrefs = [...String(xml).matchAll(/<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/gi)].map((m) => unescapeXml(m[1]))
  const unique = [...new Set(hrefs)]
  return unique.slice(0, limit).map((href) => ({ href }))
}

/** 由 base URL 与若干段拼一个 URL（每段单独编码，避免把 `reports/a b.csv` 拼坏）。 */
function joinUrl(base, ...segments) {
  const trimmed = String(base).replace(/\/+$/, '')
  return `${trimmed}/${segments.map((segment) => encodeURIComponent(segment).replace(/%2F/gi, '/')).join('/')}`
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} params
 * @param {{ source?: object, credentials?: unknown }} [context]
 */
export async function run(action, params = {}, context = {}) {
  const source = context?.source
  const request = source?.request
  if (!request || typeof request !== 'object') {
    return fail('bad-config', '该库声明了 handler:"objstore"，但注册表里缺少 request', '补上 request: { protocol, endpoint, ... }')
  }
  const protocol = String(request.protocol ?? '').toLowerCase()
  if (protocol !== 's3' && protocol !== 'webdav') {
    return fail('bad-config', `protocol 只能是 "s3" 或 "webdav"，实际是 ${JSON.stringify(request.protocol ?? null)}`)
  }
  if (typeof request.endpoint !== 'string' || !/^https?:\/\//i.test(request.endpoint)) {
    return fail('bad-config', 'request.endpoint 必须是 http(s) URL')
  }
  if (action !== 'list' && action !== 'get') {
    return fail('unknown-action', `handler:"objstore" 没有动作 "${action}"`, `可用：${Object.keys(ACTIONS).join(' / ')}`)
  }
  const limit = Math.min(Math.max(Number(request.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), LIST_CAP)

  try {
    if (protocol === 's3') {
      if (!request.bucket) return fail('bad-config', 'protocol:"s3" 需要 request.bucket')
      const keyId = await resolveRef(context?.credentials, request.accessKeyIdRef, 'access key id')
      if (keyId.error) return keyId.error
      const secret = await resolveRef(context?.credentials, request.secretAccessKeyRef, 'secret access key')
      if (secret.error) return secret.error
      const token = await resolveRef(context?.credentials, request.sessionTokenRef, 'session token')
      if (token.error) return token.error

      if (action === 'list') {
        const prefix = params.prefix ?? request.prefix ?? ''
        const url = new URL(joinUrl(request.endpoint, request.bucket))
        url.searchParams.set('list-type', '2')
        url.searchParams.set('max-keys', String(limit))
        if (prefix) url.searchParams.set('prefix', String(prefix))
        const response = await send(url.toString(), { method: 'GET', keyId: keyId.value, secret: secret.value, token: token.value, region: request.region })
        if (!response.ok) return response.error
        const items = parseS3List(response.text, limit)
        return success({ source, action, url: redact(response.url), status: response.status, items, count: items.length, bytes: Buffer.byteLength(response.text, 'utf8'), prefix: prefix || null })
      }

      const key = params.key ?? request.key
      if (typeof key !== 'string' || !key.trim()) return fail('usage', 'action=get 需要 key', '传 params: { key: "reports/x.csv" }')
      const url = joinUrl(request.endpoint, request.bucket, key)
      const response = await send(url, { method: 'GET', keyId: keyId.value, secret: secret.value, token: token.value, region: request.region })
      if (!response.ok) return response.error
      return objectPayload({ source, action, url: redact(response.url), response, key })
    }

    // webdav
    const user = await resolveRef(context?.credentials, request.usernameRef, 'username')
    if (user.error) return user.error
    const password = await resolveRef(context?.credentials, request.passwordRef, 'password')
    if (password.error) return password.error
    const authHeader = user.value
      ? `Basic ${Buffer.from(`${user.value}:${password.value ?? ''}`, 'utf8').toString('base64')}`
      : null
    const target = params.path ?? params.key ?? request.path

    if (action === 'list') {
      const url = target ? joinUrl(request.endpoint, target) : String(request.endpoint)
      const response = await send(url, { method: 'PROPFIND', headers: { Depth: '1' }, authHeader })
      if (!response.ok) return response.error
      const items = parseWebdavList(response.text, limit)
      return success({ source, action, url: redact(response.url), status: response.status, items, count: items.length, bytes: Buffer.byteLength(response.text, 'utf8') })
    }

    if (typeof target !== 'string' || !target.trim()) return fail('usage', 'action=get 需要 path', '传 params: { path: "folder/file.csv" }')
    const url = joinUrl(request.endpoint, target)
    const response = await send(url, { method: 'GET', authHeader })
    if (!response.ok) return response.error
    return objectPayload({ source, action, url: redact(response.url), response, key: target })
  } catch (error) {
    return fail('objstore', error?.message ?? String(error), '确认 endpoint、bucket/key 与网络可达性。')
  }
}

/** 发请求；s3 走 SigV4 签名，webdav 走 Basic。返回体一律按文本读（对象存储的清单是 XML）。 */
async function send(url, { method, headers = {}, keyId = null, secret = null, token = null, region = null, authHeader = null }) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout?.(30000) }
  if (keyId && secret) {
    const signed = signV4Request({ method, url, headers: init.headers, region, service: 's3', accessKeyId: keyId, secretAccessKey: secret, sessionToken: token })
    init.headers = signed.headers
  } else if (authHeader) {
    init.headers.Authorization = authHeader
  }
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    return { ok: false, error: fail('network', `${method} 失败：${error?.message ?? String(error)}`, '检查网络可达性；本机端点不要走代理。'), url }
  }
  const text = await response.text()
  if (!response.ok) {
    return {
      ok: false,
      url,
      error: {
        ...fail('http', `HTTP ${response.status} @ ${redact(url)}`, '404 多为 bucket/key 写错；403 多为签名或权限问题。'),
        status: response.status,
        body: text.slice(0, 400),
        redacted: true,
      },
    }
  }
  return {
    ok: true,
    url,
    status: response.status,
    text,
    contentType: response.headers.get('content-type') ?? '',
    contentLength: Number(response.headers.get('content-length') ?? 0) || Buffer.byteLength(text, 'utf8'),
    etag: response.headers.get('etag') ?? null,
    lastModified: response.headers.get('last-modified') ?? null,
  }
}

/** 文本类才回正文；二进制只回元信息。 */
function objectPayload({ source, action, url, response, key }) {
  const textual = TEXTUAL.test(response.contentType ?? '')
  const tooBig = response.contentLength > MAX_BODY_BYTES
  if (!textual || tooBig) {
    return success({
      source, action, url, status: response.status,
      items: [{ key, contentType: response.contentType || null, bytes: response.contentLength, etag: response.etag, lastModified: response.lastModified, body: null }],
      count: 1,
      bytes: 0,
      note: tooBig
        ? `对象 ${response.contentLength} 字节，超过 ${MAX_BODY_BYTES} 字节上限，只回元信息（正文没有进上下文）。`
        : `内容类型 ${response.contentType || '未知'} 不是文本类，只回元信息。`,
    })
  }
  return success({
    source, action, url, status: response.status,
    items: [{ key, contentType: response.contentType || null, bytes: response.contentLength, etag: response.etag, lastModified: response.lastModified, body: response.text }],
    count: 1,
    bytes: Buffer.byteLength(response.text, 'utf8'),
  })
}

function success({ source, action, url, status, items, count, bytes, prefix = null, note = null }) {
  return {
    ok: true,
    source: source?.id ?? null,
    action,
    status,
    url,
    prefix,
    count,
    items,
    bytes,
    note,
    fetchedAt: new Date().toISOString(),
    guarantees: GUARANTEES,
    redactionNote: url === redact(url) ? null : 'URL 里的凭据已替换为 ***引用名***。',
  }
}

/** 脱敏：query 里的签名参数不入返回值（SigV4 的签名串本身不该外传）。 */
function redact(url) {
  try {
    const parsed = new URL(url)
    for (const name of ['X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Security-Token', 'Signature']) {
      if (parsed.searchParams.has(name)) parsed.searchParams.set(name, '***')
    }
    return parsed.toString()
  } catch {
    return url
  }
}
