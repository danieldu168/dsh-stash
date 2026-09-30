/**
 * AWS Signature Version 4 签名（零依赖，只用 node:crypto）。
 *
 * 为什么自己写：本包**零依赖**，而 S3 / MinIO / 对象存储的私有桶必须签名才能读。
 * 签名是纯计算，没有网络与状态，因此可以拿官方测试向量逐字段核对——
 * `test/handlers-bc.mjs` 里用的就是 aws-sig-v4-test-suite 的 `get-vanilla`：
 * canonical request、string to sign、signature 三项都必须与官方文件逐字节相同。
 *
 * 参考：AWS「Signature Calculations for the Authorization Header」。
 * 本模块只负责签名，不发请求；调用方（handlers/objstore.js）负责拼 URL 与发请求。
 *
 * @module dsh-stash/handlers/sigv4
 */
import { createHash, createHmac } from 'node:crypto'

const ALGORITHM = 'AWS4-HMAC-SHA256'
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')

/** RFC 3986 编码（AWS 要求：除 A-Za-z0-9-_.~ 外全部百分号编码）。 */
const encodeRfc3986 = (value) => encodeURIComponent(String(value))
  .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

/** 路径规范化：逐段编码，保留分隔符 `/`；S3 不做二次编码。 */
function canonicalUri(pathname) {
  const path = pathname && pathname.length > 0 ? pathname : '/'
  return path.split('/').map((segment) => encodeRfc3986(segment)).join('/')
}

/** 查询串规范化：按名、再按值排序，逐项编码。 */
function canonicalQuery(searchParams) {
  const pairs = []
  for (const [key, value] of searchParams.entries()) pairs.push([key, value])
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1)))
  return pairs.map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`).join('&')
}

/** 头部值规范化：去首尾空白，把连续空白压成一个空格。 */
const trimHeaderValue = (value) => String(value).replace(/\s+/g, ' ').trim()

/** `2015-08-30T12:36:00Z` → `20150830T123600Z` */
function amzDate(timestamp) {
  const iso = (timestamp instanceof Date ? timestamp : new Date(timestamp)).toISOString()
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest()
const sha256Hex = (data) => createHash('sha256').update(data ?? '').digest('hex')

/**
 * 对一次请求签名。
 *
 * @param {object} input
 * @param {string} input.method HTTP 方法
 * @param {string} input.url 完整 URL（含 query）
 * @param {Record<string,string>} [input.headers] 参与签名的头（host 会被补上）
 * @param {string|Buffer} [input.body] 请求体（参与 payload 哈希）
 * @param {string} input.region 区域，如 us-east-1
 * @param {string} [input.service] 服务名，对象存储固定 s3
 * @param {string} input.accessKeyId
 * @param {string} input.secretAccessKey
 * @param {string} [input.sessionToken] 临时凭据
 * @param {Date|string} [input.timestamp] 默认现在（UTC）
 * @returns {{ headers: Record<string,string>, canonicalRequest: string,
 *   stringToSign: string, signature: string, authorization: string, amzDate: string,
 *   credentialScope: string, signedHeaders: string, payloadHash: string }}
 */
export function signV4Request({
  method,
  url,
  headers = {},
  body,
  region,
  service = 's3',
  accessKeyId,
  secretAccessKey,
  sessionToken = null,
  timestamp = new Date(),
}) {
  if (!accessKeyId || !secretAccessKey) throw new Error('SigV4 需要 accessKeyId 与 secretAccessKey')
  if (!region) throw new Error('SigV4 需要 region')

  const parsed = new URL(url)
  const dateTime = amzDate(timestamp)
  const dateStamp = dateTime.slice(0, 8)
  const payloadHash = body === undefined || body === null || body === '' ? EMPTY_SHA256 : sha256Hex(body)

  // 参与签名的头：调用方给的 + host + x-amz-date（+ 临时凭据）。
  const signed = new Map()
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'authorization') continue // 绝不能把上一次的签名再签一遍
    signed.set(lower, trimHeaderValue(value))
  }
  if (!signed.has('host')) signed.set('host', parsed.host)
  signed.set('x-amz-date', dateTime)
  if (sessionToken) signed.set('x-amz-security-token', trimHeaderValue(sessionToken))

  const names = [...signed.keys()].sort()
  const canonicalHeaders = names.map((name) => `${name}:${signed.get(name)}\n`).join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(parsed.pathname),
    canonicalQuery(parsed.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [ALGORITHM, dateTime, credentialScope, sha256Hex(canonicalRequest)].join('\n')

  // 派生签名密钥：kDate → kRegion → kService → kSigning
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  const authorization = `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    headers: {
      ...headers,
      'x-amz-date': dateTime,
      ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
      Authorization: authorization,
    },
    canonicalRequest,
    stringToSign,
    signature,
    authorization,
    amzDate: dateTime,
    credentialScope,
    signedHeaders,
    payloadHash,
  }
}

export { EMPTY_SHA256, encodeRfc3986 }
