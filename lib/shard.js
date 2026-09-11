/**
 * `sources.local.json` —— 唯一由程序代写的分片。
 *
 * 形状演进（读取端永远兼容旧形状，写入端只写新形状）：
 *   0.3.x  纯数组                     = 只有库条目
 *   0.4.0  { sources, credentials }   = 库 + 平铺的台账条目
 *   0.5.0  { sources, accounts }      = 库 + 两层台账（账号 + 字段）
 *
 * 写入端只写 `{ sources, accounts }`：读取时若发现旧形状，会在下一次写入时
 * 被规范成新形状（vault.js 负责把旧条目折成账号）。
 *
 * 手写的 sources.mjs 仍然由人维护，程序永不改写 —— 这条不变量不变。
 *
 * @module dsh-stash/shard
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { SOURCES_LOCAL_FILE, ensureLibDirs } from './home.js'

const asLocal = (list) => (Array.isArray(list) ? list.map((entry) => ({ ...entry, __origin: 'local' })) : [])

/**
 * 读取代写分片（三种形状都接受）。
 * @returns {{ sources: object[], accounts: object[], credentials: object[], problems: string[] }}
 */
export function readLocalShard() {
  const problems = []
  if (!existsSync(SOURCES_LOCAL_FILE)) return { sources: [], accounts: [], credentials: [], problems }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(SOURCES_LOCAL_FILE, 'utf8'))
  } catch (error) {
    problems.push(`sources.local.json 解析失败，已忽略：${error instanceof Error ? error.message : String(error)}`)
    return { sources: [], accounts: [], credentials: [], problems }
  }

  if (Array.isArray(parsed)) {
    // 0.3.x 的形状：整个文件就是一个库条目数组
    return { sources: asLocal(parsed), accounts: [], credentials: [], problems }
  }
  if (parsed && typeof parsed === 'object') {
    return {
      sources: asLocal(parsed.sources),
      accounts: asLocal(parsed.accounts),
      credentials: asLocal(parsed.credentials),
      problems,
    }
  }
  problems.push('sources.local.json 顶层既不是数组也不是对象，已忽略。')
  return { sources: [], accounts: [], credentials: [], problems }
}

/** 写回代写分片（去掉内部字段，只写新形状）。 */
export function writeLocalShard({ sources, accounts }) {
  ensureLibDirs()
  const clean = (list) => (Array.isArray(list) ? list.map(({ __origin, ...rest }) => rest) : [])
  writeFileSync(
    SOURCES_LOCAL_FILE,
    `${JSON.stringify({ sources: clean(sources), accounts: clean(accounts) }, null, 2)}\n`,
    'utf8',
  )
}

/** 用一份完整的新账号清单覆盖代写台账（其余字段原样保留）。 */
export function writeLocalAccounts(accounts) {
  const shard = readLocalShard()
  writeLocalShard({ sources: shard.sources, accounts })
  return accounts.length
}

/** 新增或替换一条代写的库条目。 */
export function upsertLocalSource(entry) {
  const shard = readLocalShard()
  const index = shard.sources.findIndex((existing) => existing.id === entry.id)
  if (index >= 0) shard.sources[index] = entry
  else shard.sources.push(entry)
  writeLocalShard({ sources: shard.sources, accounts: cleanAccounts(shard) })
  return shard.sources.length
}

/** 删除一条代写的库条目。 */
export function removeLocalSource(id) {
  const shard = readLocalShard()
  const next = shard.sources.filter((entry) => entry.id !== id)
  if (next.length === shard.sources.length) return false
  writeLocalShard({ sources: next, accounts: cleanAccounts(shard) })
  return true
}

/**
 * 库条目写入时要顺带保留已有账号。
 *
 * 注意：旧形状的平铺 credentials 在这里**不做折算**（折算属于 vault.js 的职责），
 * 但也不能就这么丢掉——用它们的原样保底，下一次账号写入时会规范化。
 */
function cleanAccounts(shard) {
  const strip = (list) => (Array.isArray(list) ? list.map(({ __origin, ...rest }) => rest) : [])
  return [...strip(shard.accounts), ...strip(shard.credentials)]
}
