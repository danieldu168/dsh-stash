/**
 * 文库的磁盘布局。所有路径只由 DSH_HOME 派生，不硬编码用户目录。
 *
 *   ${DSH_HOME}/stash/sources.mjs     注册表（人写）
 *   ${DSH_HOME}/stash/sources.local.json 代写分片（库 + 钥匙台账）
 *   ${DSH_HOME}/stash/ledger.ndjson   取数台账（机器写，只记指纹不记内容）
 *   ${DSH_HOME}/stash/lessons.json    经验库（工具写，按库 id 分组；人可自由整理）
 *   ${DSH_HOME}/stash/cache/          取数缓存（机器写）
 *   ${DSH_HOME}/stash/corpus/         原始语料，如数据库导出件（人放）
 *
 * @module dsh-stash/home
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const fromEnv = process.env.DSH_HOME?.trim()
export const DSH_HOME = fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')

export const LIB_HOME = join(DSH_HOME, 'stash')
export const CACHE_DIR = join(LIB_HOME, 'cache')
export const CORPUS_DIR = join(LIB_HOME, 'corpus')
export const SOURCES_FILE = join(LIB_HOME, 'sources.mjs')
/** 由工具代写的注册表分片；手写的 sources.mjs 永不被程序改写。 */
export const SOURCES_LOCAL_FILE = join(LIB_HOME, 'sources.local.json')
/** 取数台账：一行一条 NDJSON，只追加。 */
export const LEDGER_FILE = join(LIB_HOME, 'ledger.ndjson')
/**
 * 经验库：按库 id 分组的教训/口径记录。
 *
 * 为什么单独一个文件，而不是塞进库条目的 `notes`：**手写的 sources.mjs 永不被程序改写**，
 * 而现实里的库常常住在手写文件里（本机就有这样的库）。经验若只能挂在库条目上，
 * 这批库就永远记不了经验——而它们恰恰是最需要记的。
 */
export const LESSONS_FILE = join(LIB_HOME, 'lessons.json')

/** 幂等创建文库目录；插件启动时调用一次。 */
export function ensureLibDirs() {
  for (const dir of [LIB_HOME, CACHE_DIR, CORPUS_DIR]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // 目录创建失败（权限等）不应弄崩宿主；后续操作各自报错。
    }
  }
}
