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
      actions: isPlainObject(raw.actions) ? raw.actions : {},
      notes: Array.isArray(raw.notes) ? raw.notes.filter((n) => typeof n === 'string') : [],
      boundary: typeof raw.boundary === 'string' ? raw.boundary : '',
      origin: raw.__origin ?? 'unknown',
    },
  }
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

  return {
    ok: problems.length === 0,
    sources,
    problems,
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
