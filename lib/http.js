/**
 * 取数底座：超时、磁盘缓存、按主机串行节流、结构化错误。
 *
 * 设计要点（都是被实践打出来的）：
 *  - 免费无鉴权接口要"保持人类级调用频率"，所以按主机串行 + 最小间隔。
 *  - 必须直连的接口不能被代理劫持：Node 的 fetch 默认不读
 *    HTTP_PROXY，所以这里什么也不做，反而正好是"直连"语义。
 *  - 错误一律转成结构化结果，让工具能给出可读的修复建议，而不是抛栈。
 *
 * @module dsh-stash/http
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE_DIR, ensureLibDirs } from './home.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 45_000

/** 每个主机的"上一次调用结束时间"，用于全局节流（跨工具、跨会话）。 */
const lastCallFinishedAt = new Map()
/** 每个主机一条串行链，保证并发调用也排队而不是并发打点。 */
const hostChain = new Map()

export class SourceHttpError extends Error {
  constructor(message, { status = 0, url = '', body = '', hint = '' } = {}) {
    super(message)
    this.name = 'SourceHttpError'
    this.status = status
    this.url = url
    this.body = body
    this.hint = hint
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 在某个主机上串行执行一次调用，并保证两次调用之间至少间隔 minGapMs。
 * @param {string} host
 * @param {number} minGapMs
 * @param {() => Promise<unknown>} operation
 */
function onHost(host, minGapMs, operation) {
  const previous = hostChain.get(host) ?? Promise.resolve()
  const next = previous.then(async () => {
    const last = lastCallFinishedAt.get(host) ?? 0
    const wait = minGapMs - (Date.now() - last)
    if (wait > 0) await sleep(wait)
    try {
      return await operation()
    } finally {
      lastCallFinishedAt.set(host, Date.now())
    }
  })
  // 链上吞掉异常，避免一次失败毒化后续排队。
  hostChain.set(host, next.then(() => undefined, () => undefined))
  return next
}

/** 显式缓存文件名（相对 CACHE_DIR），只允许安全字符。 */
export function cacheFileName(url) {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16)
  return `http-${hash}.json`
}

export function readCache(fileName) {
  ensureLibDirs()
  const path = join(CACHE_DIR, fileName)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

export function writeCache(fileName, value) {
  ensureLibDirs()
  try {
    writeFileSync(join(CACHE_DIR, fileName), JSON.stringify(value), 'utf8')
  } catch {
    // 缓存写失败不影响本次取数结果。
  }
}

/**
 * 取一个 JSON 端点。
 * @param {string} url
 * @param {{
 *   cache?: string | false,
 *   refresh?: boolean,
 *   minGapMs?: number,
 *   timeoutMs?: number,
 *   host?: string,
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: unknown,
 * }} [options]
 * @returns {Promise<{ data: unknown, status: number, bytes: number, cached: boolean, fetchedAt: string, url: string }>}
 */
export async function fetchJson(url, options = {}) {
  const {
    cache = cacheFileName(url),
    refresh = false,
    minGapMs = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    host = new URL(url).host,
    method = 'GET',
    headers: extraHeaders,
    body,
  } = options

  const upperMethod = method.toUpperCase()
  // 只缓存 GET：POST 带 body，缓存等于返回过期结果。
  const cacheable = upperMethod === 'GET' && cache !== false

  if (cacheable && cache && !refresh) {
    const hit = readCache(cache)
    if (hit !== undefined) {
      return {
        data: hit.data,
        status: hit.status ?? 200,
        bytes: hit.bytes ?? 0,
        cached: true,
        fetchedAt: hit.fetchedAt ?? 'unknown',
        url,
      }
    }
  }

  const result = await onHost(host, minGapMs, async () => {
    const headers = { 'User-Agent': UA, Accept: 'application/json', ...(extraHeaders ?? {}) }
    const init = { method: upperMethod, headers, signal: AbortSignal.timeout(timeoutMs) }
    if (body !== undefined && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
      init.body = JSON.stringify(body)
    }

    let response
    try {
      response = await fetch(url, init)
    } catch (error) {
      const cause = error?.cause?.message ?? error?.message ?? String(error)
      throw new SourceHttpError(`请求失败：${cause}`, {
        url,
        hint: '检查网络与 DNS；部分端点必须直连（不要走代理）。',
      })
    }

    const text = await response.text()
    if (!response.ok) {
      throw new SourceHttpError(`HTTP ${response.status}`, {
        status: response.status,
        url,
        body: text.slice(0, 400),
        hint: response.status === 400
          ? '多数情况是缺少必填参数（该接口的 product 必填）。'
          : response.status === 401 || response.status === 403
            ? '多半是凭据未配置或无效：检查注册表里的 credentials 引用名是否已在凭据库中配置。'
            : '',
      })
    }

    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new SourceHttpError('响应不是 JSON', {
        status: response.status,
        url,
        body: text.slice(0, 200),
        hint: '端点可能已改变返回格式，或需要登录态。',
      })
    }

    return { data, status: response.status, bytes: text.length, fetchedAt: new Date().toISOString() }
  })

  if (cacheable && cache) {
    writeCache(cache, {
      status: result.status,
      bytes: result.bytes,
      fetchedAt: result.fetchedAt,
      data: result.data,
    })
  }

  return { ...result, cached: false, url }
}
