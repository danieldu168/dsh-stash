/**
 * 数据库直连处理器（handler: 'db'）—— B 类形态。
 *
 * 零依赖约束下只有一条路走得通：**本地 SQLite**（Node 内置 `node:sqlite`）。
 * 服务端数据库（Postgres / MySQL / 数仓）需要驱动，而本包零依赖，因此那类走 A 类形态的
 * HTTP 门面（例如给只读视图套一层 PostgREST 式的接口），或等以后引入带驱动的 handler。
 *
 * 注册表里的形状：
 *   handler: 'db'
 *   request: {
 *     engine: 'sqlite',
 *     path:   'D:/data/app.db',        // 绝对路径
 *     sql:    'SELECT id, name FROM users WHERE dept = :dept LIMIT 50',
 *     required: ['dept'],
 *     limit:  200,                     // 返回行数上限
 *   }
 *
 * 安全约束（三条，写死在代码里）：
 *   1. **只读打开**：`readOnly: true`，写操作在引擎层就失败；
 *   2. **只放行 SELECT / WITH**：注册表写别的语句在登记时就被拒（见 registry.validateSourceDeep）；
 *   3. **单语句**：出现分号后还有内容一律拒绝，避免"一条源"变成脚本。
 *
 * @module dsh-stash/handlers/db
 */
const MAX_ROWS_CAP = 1000
const DEFAULT_ROWS = 100

export const GUARANTEES = [
  '只读打开：写操作在 SQLite 引擎层就失败，不靠语句检查',
  '只放行 SELECT / WITH 单语句，多语句与写语句在登记与取数两处都被拒',
  '返回行数有上限，避免一次工具调用把整张表倒进上下文',
]

export const ACTIONS = {
  query: '执行注册表里声明的那条只读查询；参数用 :name 占位，由调用参数绑定',
  tables: '列出库里的表与视图（不含行数，避免扫描全库）',
}

const fail = (kind, error, hint) => ({ ok: false, kind, error, hint: hint ?? null })

const isAbsolutePath = (value) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')

/** 只读语句判定：允许 SELECT / WITH，其余一律不放行。 */
export function isReadOnlySql(sql) {
  const text = String(sql ?? '').trim()
  if (!text) return false
  // 去掉结尾分号后，语句内部不允许再出现分号（挡住 "SELECT 1; DROP TABLE x"）。
  const body = text.replace(/;\s*$/, '')
  if (body.includes(';')) return false
  // 允许前置注释，但注释里不能藏第二条语句（上面已经挡了分号）。
  const withoutComments = body.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, '')
  return /^(select|with)\b/i.test(withoutComments)
}

/** 把 SQLite 取回的值转成 JSON 安全的形状（BLOB 只报长度，BigInt 转字符串）。 */
function sanitizeValue(value) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeValue(item)
    return out
  }
  return value
}

/** 懒加载 node:sqlite：Node 22 上它可能需要 --experimental-sqlite，缺了就给出明确提示。 */
async function loadSqlite() {
  try {
    return await import('node:sqlite')
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} params
 * @param {{ source?: object, credentials?: unknown }} [context]
 */
export async function run(action, params = {}, context = {}) {
  const request = context?.source?.request
  if (!request || typeof request !== 'object') {
    return fail('bad-config', '该库声明了 handler:"db"，但注册表里缺少 request', '补上 request: { engine, path, sql }')
  }
  if (String(request.engine ?? '').toLowerCase() !== 'sqlite') {
    return fail(
      'unsupported-engine',
      `handler:"db" 目前只支持 engine:"sqlite"，实际是 ${JSON.stringify(request.engine ?? null)}`,
      '服务端数据库请走 handler:"http" 的只读门面（本包零依赖，不内置数据库驱动）。',
    )
  }
  if (typeof request.path !== 'string' || !isAbsolutePath(request.path)) {
    return fail('bad-config', 'request.path 必须是绝对路径（SQLite 文件）', '例：D:/data/app.db 或 /var/data/app.db')
  }

  const sqlite = await loadSqlite()
  if (sqlite.error) {
    return fail(
      'engine-unavailable',
      `本机 Node 没有可用的 node:sqlite：${sqlite.error}`,
      '需要 Node 22.5+ 且启用 --experimental-sqlite，或 Node 23.4+ / 24（内置）。',
    )
  }

  let sql
  if (action === 'tables') {
    sql = "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
  } else {
    if (action !== 'query') {
      return fail('unknown-action', `handler:"db" 没有动作 "${action}"`, `可用：${Object.keys(ACTIONS).join(' / ')}`)
    }
    sql = request.sql
    if (typeof sql !== 'string' || !sql.trim()) {
      return fail('bad-config', 'action=query 需要注册表里的 request.sql', '一条源 = 一条只读查询；多条请各登一条。')
    }
    if (!isReadOnlySql(sql)) {
      return fail('not-read-only', '这条 SQL 不是单条 SELECT / WITH 只读语句，已拒绝执行', '写语句与多语句一律不放行（只读打开是第二道锁）。')
    }
    const required = Array.isArray(request.required) ? request.required : []
    const missing = required.filter((name) => params[name] === undefined || params[name] === null || params[name] === '')
    if (missing.length > 0) {
      return fail('usage', `缺少必填参数：${missing.join(', ')}`, `本动作需要的参数：${required.join(', ')}`)
    }
  }

  const limit = Math.min(Math.max(Number(request.limit ?? DEFAULT_ROWS) || DEFAULT_ROWS, 1), MAX_ROWS_CAP)
  let handle = null
  try {
    // 只读打开：写操作在引擎层失败，语句检查只是第一道锁。
    handle = new sqlite.DatabaseSync(request.path, { readOnly: true })
    const statement = handle.prepare(sql)
    // 调用参数里只会用到 SQL 里出现的 :name；多余参数忽略，缺失的由 SQLite 报错。
    const bound = {}
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue
      bound[key] = typeof value === 'object' ? JSON.stringify(value) : value
    }
    const rows = statement.all(bound).map(sanitizeValue)
    const items = rows.slice(0, limit)
    const payloadBytes = Buffer.byteLength(JSON.stringify(items), 'utf8')
    return {
      ok: true,
      source: context?.source?.id ?? null,
      action,
      engine: 'sqlite',
      path: request.path,
      mode: 'read-only',
      sql,
      count: items.length,
      truncated: rows.length > limit,
      items,
      bytes: payloadBytes,
      fetchedAt: new Date().toISOString(),
      guarantees: GUARANTEES,
    }
  } catch (error) {
    return fail('db', error?.message ?? String(error), '确认路径存在、SQL 里的列名与参数名正确；本处理器只读。')
  } finally {
    try { handle?.close() } catch { /* 关闭失败不影响结果 */ }
  }
}
