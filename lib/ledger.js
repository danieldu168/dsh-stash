/**
 * 取数台账 —— 记「取过什么」，不记「取到了什么」。
 *
 * 为什么需要它：文库的价值不只是"能取到数"，而是"三个月后还能说清这个结论
 * 依据的是哪一次取数"。harness 的会话日志只保证"模型看到了什么"，它无法回答
 * "外部源当时返回了什么"——那条线由本文件补上。
 *
 * 三条不可协商的设计决定：
 *
 *   1. **只落指纹，不落内容。** 台账写的是 contentHash / bytes / count / fetchedAt，
 *      不是响应体本身。内容属于 cache/ 与 corpus/，台账只回答"取过、取到了多大一份、
 *      指纹是什么"。这既让台账永远很小，也让它天然不可能成为密钥的第二个落点。
 *   2. **失败也记。** 取数失败、被边界拒绝，都要留痕——"我当时试过、它拒绝了"
 *      和"我没试过"是两件不同的事。
 *   3. **台账写失败绝不影响取数。** 它是审计旁路，不是取数路径上的依赖。
 *
 * 文件是有界追加的 NDJSON（一行一条 JSON），超过 MAX_RECORDS 时裁掉最旧的。
 *
 * @module dsh-stash/ledger
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { LEDGER_FILE, ensureLibDirs } from './home.js'
import { findSecretPath } from './secrets.js'

/** 台账最多保留的条数；超过后裁到 KEEP_RECORDS。 */
const MAX_RECORDS = 2000
const KEEP_RECORDS = 1000

/** stash_ledger 的默认与上限条数。 */
export const LEDGER_READ_DEFAULT = 20
export const LEDGER_READ_MAX = 200

/** 插件版本，写进每条台账，用于回答"这条是哪个版本取的"。 */
function engineVersion() {
  try {
    const url = new URL('../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(url, 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

const ENGINE = engineVersion()

/**
 * 结果指纹：同一份数据必须给出同一个指纹，**所以刻意排除 `cached`**——
 * 首次取数与之后命中缓存，数据是同一份，指纹就必须相同。
 * @param {object} result handler 的返回值
 * @returns {string} 16 位十六进制
 */
export function fingerprint(result) {
  const projection = {
    status: result?.status ?? null,
    bytes: result?.bytes ?? null,
    count: result?.count ?? null,
    fetchedAt: result?.fetchedAt ?? null,
    items: result?.items ?? null,
  }
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex').slice(0, 16)
}

/**
 * 规范化要写进台账的参数。
 *
 * 参数由模型给出，凭据是在 handler 内部按引用名注入的，正常不会出现在这里；
 * 但仍然扫一遍高置信度的密钥特征——台账是明文文件，宁可记成占位符。
 * @param {unknown} params
 * @returns {{ params: unknown, redacted: boolean }}
 */
function sanitizeParams(params) {
  if (params === undefined || params === null) return { params: null, redacted: false }
  if (typeof params !== 'object') return { params, redacted: false }
  const hit = findSecretPath(params)
  if (hit) return { params: { __redacted: `疑似密钥值（字段 ${hit}），台账未记录原文` }, redacted: true }
  return { params, redacted: false }
}

/** 读取现有台账行（坏行跳过并计数）。 */
function readRecords() {
  if (!existsSync(LEDGER_FILE)) return { records: [], broken: 0 }
  let text
  try {
    text = readFileSync(LEDGER_FILE, 'utf8')
  } catch {
    return { records: [], broken: 0 }
  }
  const records = []
  let broken = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') records.push(parsed)
      else broken += 1
    } catch {
      broken += 1
    }
  }
  return { records, broken }
}

/** 超过上限时裁掉最旧的一半，保持文件有界。 */
function pruneIfNeeded() {
  const { records } = readRecords()
  if (records.length < MAX_RECORDS) return 0
  const kept = records.slice(-KEEP_RECORDS)
  try {
    writeFileSync(LEDGER_FILE, `${kept.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  } catch {
    // 裁剪失败只是文件继续变大，不影响正确性。
  }
  return records.length - kept.length
}

/**
 * 追加一条取数记录。
 *
 * @param {{
 *   source: string, action: string, result: object, params?: unknown,
 *   origin?: string, ms?: number, boundary?: string|null,
 * }} input
 * @returns {object|null} 写入的记录；写失败时 null（绝不抛）
 */
export function recordFetch(input) {
  const {
    source, action, result, params, origin = 'unknown', ms = null, boundary = null,
  } = input
  try {
    const at = new Date().toISOString()
    const hash = fingerprint(result)
    const { params: safeParams, redacted } = sanitizeParams(params)
    const record = {
      id: createHash('sha256').update(`${at}|${source}|${action}|${hash}`).digest('hex').slice(0, 12),
      at,
      source,
      action,
      ok: result?.ok === true,
      kind: result?.ok === true ? null : (result?.kind ?? 'unknown'),
      error: result?.ok === true ? null : (result?.error ?? null),
      boundary,
      cacheHit: result?.cached === true,
      fetchedAt: result?.fetchedAt ?? null,
      status: result?.status ?? null,
      bytes: result?.bytes ?? null,
      count: typeof result?.count === 'number' ? result.count : null,
      contentHash: hash,
      request: typeof result?.request?.url === 'string' ? result.request.url : null,
      params: safeParams,
      paramsRedacted: redacted,
      origin,
      engine: ENGINE,
      ms,
    }
    ensureLibDirs()
    pruneIfNeeded()
    appendFileSync(LEDGER_FILE, `${JSON.stringify(record)}\n`, 'utf8')
    return record
  } catch {
    // 台账是审计旁路：写不进去不该让取数失败。
    return null
  }
}

/**
 * 读取台账，最新的在前。
 * @param {{ source?: string|null, limit?: number, onlyFailed?: boolean }} [query]
 * @returns {{ records: object[], total: number, matched: number, broken: number, file: string }}
 */
export function readLedger(query = {}) {
  const wanted = typeof query.source === 'string' && query.source.trim() ? query.source.trim() : null
  const rawLimit = Number(query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), LEDGER_READ_MAX)
    : LEDGER_READ_DEFAULT
  const onlyFailed = query.onlyFailed === true

  const { records, broken } = readRecords()
  let matched = records
  if (wanted) matched = matched.filter((record) => record.source === wanted)
  if (onlyFailed) matched = matched.filter((record) => record.ok !== true)

  return {
    records: matched.slice(-limit).reverse(),
    total: records.length,
    matched: matched.length,
    broken,
    file: LEDGER_FILE,
  }
}

/** 台账文件概况，供 stash_doctor 与 stash_catalog 展示。 */
export function ledgerStats() {
  const { records, broken } = readRecords()
  const failed = records.filter((record) => record.ok !== true).length
  return {
    file: LEDGER_FILE,
    records: records.length,
    failed,
    broken,
    last: records.length > 0 ? records[records.length - 1] : null,
    engine: ENGINE,
  }
}

/**
 * 按库汇总台账：调过几次、失败几次、最近一次什么时候、最近一次错在哪。
 *
 * 为什么要它：`stash_catalog` 要让调用者**一次定案**——「这条库以前通不通」是决策的一部分，
 * 而全局的 {@link ledgerStats} 答不了这个问题。文件按时间追加，所以循环里后写的会覆盖先写的，
 * 结束时留下的就是最近一次。
 *
 * @returns {Map<string, {calls: number, failures: number, lastAt: string|null,
 *   lastOk: boolean|null, lastError: string|null}>}
 */
export function ledgerStatsBySource() {
  const { records } = readRecords()
  const out = new Map()
  for (const record of records) {
    const id = typeof record?.source === 'string' && record.source ? record.source : null
    if (id === null) continue
    const entry = out.get(id) ?? { calls: 0, failures: 0, lastAt: null, lastOk: null, lastError: null }
    entry.calls += 1
    const ok = record.ok === true
    if (!ok) entry.failures += 1
    if (typeof record.at === 'string') entry.lastAt = record.at
    entry.lastOk = ok
    entry.lastError = ok ? null : (typeof record.error === 'string' ? record.error : null)
    out.set(id, entry)
  }
  return out
}
