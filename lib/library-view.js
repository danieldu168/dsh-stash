/**
 * 文库视图：把注册表里的库整理成**面板可直接渲染**的形状（只读、面向人）。
 *
 * 为什么单独一个模块：同一个事实现在有两个消费者——
 *   · `stash_catalog`（Model 侧）自己那份更宽，含 request / 必填参数 / 经验全文；
 *   · 设置面板「文库」页（本模块）只回答"我登记了什么、现在能不能用、卡在哪"。
 * 两份输出共用同一套**判定口径**（就绪 / 阻塞 / 边界），因此把口径写在这里一处，
 * 免得面板说"就绪"而工具说"取不到"。
 *
 * ⛔ 本模块不接触任何凭据值：只调 `credentials.describe()` 问"配没配"。
 *
 * @module dsh-stash/library-view
 */
import { statSync } from 'node:fs'
import { FETCH_REFUSED_ACCESS, BUCKET_MODES } from './registry.js'
import { getHandler } from './handlers/index.js'
import { ledgerStatsBySource } from './ledger.js'
import { lessonsStats } from './lessons.js'
import { loadVault } from './vault.js'

/** 取数边界的中文标签。取值来自 registry.ACCESS_MODES，改一处即两边同步。 */
export const ACCESS_LABELS = {
  'public-api': '公开免登录',
  'official-api': '官方 API / 需授权',
  'export-import': '只能人工导出',
  unsupported: '明确不做',
}

export const KIND_LABELS = {
  remote: '远程接口',
  files: '本地语料',
  mcp: 'MCP 服务',
}

export const HANDLER_LABELS = {
  http: '声明式 HTTP',
  trade_stats: '贸易统计',
  policy_alerts: '政策通报',
  db: '本地数据库',
  objstore: '对象存储',
}

export const ORIGIN_LABELS = {
  handwritten: '手写',
  local: '代写',
}

/** 大类 = 程序触达外部世界的物理通道。穷尽性论证见 DESIGN-taxonomy.md 第三节。 */
export const CHANNEL_LABELS = {
  net: '网络套接字',
  files: '文件系统',
  subprocess: '子进程',
  human: '人的输入',
}

/**
 * 面板上的**三类**（人话）。这是用户看到的那一级，也是唯一一级分类。
 * 它按"东西怎么进来的"分，与上面的物理通道是两个视角，映射见 DESIGN-taxonomy.md。
 * id 列表来自 registry（数据在那儿定义），这里只负责中文名，避免两处各写一份而漂移。
 */
const BUCKET_NAMES = { remote: '远端接口', 'local-service': '本机服务', 'local-files': '本机文件' }
export const BUCKET_LABELS = Object.fromEntries(BUCKET_MODES.map((id) => [id, BUCKET_NAMES[id] ?? id]))

/** 本机回环：这类地址走的是本机在跑的服务（本地聚合后端的 6900 端口就是）。 */
const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i

/**
 * 一条资源归入哪一类。
 *
 * 规则（写死在代码里，界面上的「归入」只是它的显示）：
 *   · files / db（SQLite 文件）→ 本机文件
 *   · MCP 走 stdio            → 本机服务
 *   · 其余 http 且地址是回环   → 本机服务
 *   · 其余                    → 远端接口
 *
 * 允许注册表里的 `bucket` 覆盖它——本地反向代理把远端伪装成 127.0.0.1 是真实存在的，
 * 那种情况自动判定会错，由人说了算。
 */
export function bucketOf(source) {
  if (source?.bucket && BUCKET_LABELS[source.bucket]) return source.bucket
  if (source?.kind === 'files') return 'local-files'
  if (source?.kind === 'remote' && source?.handler === 'db') return 'local-files'
  if (source?.kind === 'mcp') return source?.transport === 'stdio' ? 'local-service' : 'remote'
  if (source?.kind === 'remote' && source?.handler === 'http' && LOOPBACK.test(String(source?.request?.url ?? ''))) {
    return 'local-service'
  }
  return 'remote'
}

export const BUCKET_IDS = Object.keys(BUCKET_LABELS)

/**
 * 形态表：一条库长什么形状，它走哪条通道、能不能经 stash 取数。
 *
 * - `channel` 是物理承载。注意 db（SQLite）读的是本地文件 → 文件系统；
 *   MCP 的 stdio 走子进程管道、另两种走网络，所以按 transport 再分（见 formOf）。
 * - `accessMode`：fetch = stash_fetch 取数；files = stash_files 检索 + read；
 *   external = 不经 stash（DSH 直连）。
 */
const FORMS = {
  http: { label: '声明式 HTTP', channel: 'net', accessMode: 'fetch' },
  trade_stats: { label: '贸易统计', channel: 'net', accessMode: 'fetch' },
  policy_alerts: { label: '政策通报', channel: 'net', accessMode: 'fetch' },
  db: { label: '本地数据库', channel: 'files', accessMode: 'fetch' },
  objstore: { label: '对象存储', channel: 'net', accessMode: 'fetch' },
  files: { label: '本地语料', channel: 'files', accessMode: 'files' },
  mcp: { label: 'MCP 服务', channel: 'net', accessMode: 'external' },
}

/** 一条库的形态键：files / mcp 按 kind，其余按 handler（kind 缺省的历史条目按 remote 处理）。 */
export const formKeyOf = (source) => {
  if (source?.kind === 'files' || source?.kind === 'mcp') return source.kind
  return source?.handler ?? 'remote'
}

/** 形态 + 大类 + 取数方式。 */
export function formOf(source) {
  const key = formKeyOf(source)
  const base = FORMS[key] ?? { label: '未指明形态', channel: 'net', accessMode: 'fetch' }
  const channel = key === 'mcp' && source?.transport === 'stdio' ? 'subprocess' : base.channel
  return {
    form: key,
    formLabel: source?.kind === 'mcp' && source?.transport ? `${base.label}（${source.transport}）` : base.label,
    channel,
    channelLabel: CHANNEL_LABELS[channel] ?? channel,
    accessMode: base.accessMode,
  }
}

export const accessLabel = (access) => (access ? (ACCESS_LABELS[access] ?? access) : '未声明')
export const kindLabel = (kind) => KIND_LABELS[kind] ?? kind
export const originLabel = (origin) => ORIGIN_LABELS[origin] ?? '代写'

/** 凭据就绪状态：只问"配没配"，不问"值是什么"。与 stash_catalog 同一口径。 */
async function credentialStatus(credentials, refs) {
  if (!refs || refs.length === 0) return []
  if (!credentials) {
    return refs.map((ref) => ({ ref, configured: null, note: '本部署没有 credentials 服务' }))
  }
  const out = []
  for (const ref of refs) {
    try {
      const info = await credentials.describe(ref)
      out.push({ ref, configured: Boolean(info?.configured), source: info?.source ?? null })
    } catch (error) {
      out.push({ ref, configured: null, note: error?.message ?? String(error) })
    }
  }
  return out
}

function statPath(path) {
  try {
    const info = statSync(path)
    return {
      path,
      exists: true,
      kind: info.isDirectory() ? 'directory' : 'file',
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    }
  } catch {
    return { path, exists: false, kind: null, bytes: null, modifiedAt: null }
  }
}

/** 落点（inject）：决定这把钥匙的值该写 .env 还是写面板。值本身永远不在这里。 */
async function injectByRef() {
  const map = new Map()
  try {
    const vault = await loadVault()
    for (const account of vault.accounts ?? []) {
      for (const field of account.fields ?? []) {
        if (field?.ref) map.set(field.ref, field.inject ?? null)
      }
    }
  } catch {
    // 台账读不出来时降级为"落点未知"，不影响清单本身。
  }
  return map
}

/**
 * 组装文库清单。
 *
 * @param {object} options
 * @param {object[]} [options.sources] 已规范化的库条目（registry.sources）
 * @param {object[]} [options.deepIssues] registry.deepIssues：能加载但注定取不到数的问题
 * @param {object|null} [options.credentials] 宿主凭据服务（可缺省）
 * @returns {Promise<{ libraries: object[], stats: object, problems: string[] }>}
 */
export async function buildLibraryView({ sources = [], deepIssues = [], credentials = null } = {}) {
  const lessons = lessonsStats()
  const usage = ledgerStatsBySource()
  const injects = await injectByRef()
  const issuesBySource = new Map()
  for (const issue of deepIssues) {
    const id = issue?.source
    if (!id) continue
    if (!issuesBySource.has(id)) issuesBySource.set(id, [])
    issuesBySource.get(id).push({ level: issue.level ?? 'warn', message: issue.message ?? String(issue) })
  }

  const libraries = []
  for (const source of sources) {
    const credentialEntries = (await credentialStatus(credentials, source.credentials)).map((item) => ({
      ...item,
      inject: injects.get(item.ref) ?? null,
    }))
    const paths = source.kind === 'files' ? source.paths.map(statPath) : []
    const refused = FETCH_REFUSED_ACCESS.has(source.access ?? '')
    const handlerAvailable = source.kind === 'remote' ? Boolean(getHandler(source.handler)) : null
    // 深度校验的问题（request.url 写错、{credential:REF} 没声明之类）在这里逐条落到该库身上。
    const deep = issuesBySource.get(source.id) ?? []

    // 「现在能不能直接用」连同不能的原因一次说清——与 stash_catalog 同一套判定。
    const shape = formOf(source)
    const blockers = []
    if (refused && shape.accessMode !== 'external') {
      blockers.push(`access=${source.access}：stash_fetch 会拒绝，只能人工导出 → corpus/`)
    }
    if (handlerAvailable === false) blockers.push(`handler "${source.handler}" 在本插件里没有实现`)
    const missingRefs = credentialEntries.filter((item) => item.configured === false).map((item) => item.ref)
    if (missingRefs.length > 0) blockers.push(`凭据未配置：${missingRefs.join(', ')}`)
    const unknownRefs = credentialEntries.filter((item) => item.configured === null).map((item) => item.ref)
    if (unknownRefs.length > 0) blockers.push(`凭据状态未知（本部署没有 credentials 服务）：${unknownRefs.join(', ')}`)
    const missingPaths = paths.filter((item) => !item.exists)
    if (missingPaths.length > 0) blockers.push(`有 ${missingPaths.length} 条路径不存在`)
    for (const issue of deep) blockers.push(issue.message)

    libraries.push({
      id: source.id,
      name: source.name,
      kind: source.kind,
      kindLabel: kindLabel(source.kind),
      handler: source.handler ?? null,
      handlerLabel: source.handler ? (HANDLER_LABELS[source.handler] ?? source.handler) : null,
      handlerAvailable,
      // 分类学（DESIGN-taxonomy.md）：形态 / 大类 / 取数方式，三处消费同一份派生。
      form: shape.form,
      formLabel: shape.formLabel,
      channel: shape.channel,
      channelLabel: shape.channelLabel,
      accessMode: shape.accessMode,
      // 面板上那一级：三类（人话）。bucketOverridden 表示这条是人指定的，不是自动判定。
      bucket: bucketOf(source),
      bucketLabel: BUCKET_LABELS[bucketOf(source)],
      bucketOverridden: Boolean(source.bucket && BUCKET_LABELS[source.bucket]),
      // MCP 服务的登记字段：取数由 DSH 直连，这里只登记"怎么调"。
      server: source.server ?? null,
      transport: source.transport ?? null,
      tools: source.tools ?? '',
      origin: source.origin ?? 'local',
      originLabel: originLabel(source.origin),
      access: source.access ?? null,
      accessLabel: accessLabel(source.access),
      fetchRefused: refused,
      ready: blockers.length === 0,
      blockers,
      // 编辑表单要回填取数描述。这里只有 URL / SQL / 引用名，**没有任何值**。
      request: source.request ?? null,
      summary: source.summary ?? '',
      coverage: source.coverage ?? '',
      boundary: source.boundary ?? '',
      actions: Object.entries(source.actions ?? {}).map(([name, help]) => ({ name, help: String(help) })),
      notesCount: Array.isArray(source.notes) ? source.notes.length : 0,
      deepIssues: deep,
      credentials: credentialEntries,
      paths,
      lessons: { count: lessons.perSource[source.id] ?? 0 },
      usage: usage.get(source.id) ?? null,
      // 「有失败取数却没记经验」——stash_doctor 早就这么判，这里把它带到面板上，
      // 好让使用者一眼看到"哪条库栽过跟头、却没人写下为什么"。
      lessonGap: (usage.get(source.id)?.failures ?? 0) > 0 && (lessons.perSource[source.id] ?? 0) === 0,
    })
  }

  // 面板上的三类：这是**唯一一级分类**，按"东西怎么进来的"分。
  const byBucket = []
  for (const [bucket, label] of Object.entries(BUCKET_LABELS)) {
    const list = libraries.filter((item) => item.bucket === bucket)
    byBucket.push({
      bucket,
      label,
      count: list.length,
      ready: list.filter((item) => item.ready).length,
      blocked: list.filter((item) => !item.ready).length,
      missingRefs: list.reduce(
        (sum, item) => sum + item.credentials.filter((field) => field.configured === false).length,
        0,
      ),
      refs: list.reduce((sum, item) => sum + item.credentials.length, 0),
      lessonGaps: list.filter((item) => item.lessonGap).length,
    })
  }

  // 统计：先按大类（物理通道），再按形态。面板一级/二级就用这两个数组，不再另算一套。
  const byChannel = []
  for (const [channel, label] of Object.entries(CHANNEL_LABELS)) {
    const list = libraries.filter((item) => item.channel === channel)
    if (list.length === 0) continue
    byChannel.push({
      channel,
      label,
      count: list.length,
      ready: list.filter((item) => item.ready).length,
      blocked: list.filter((item) => !item.ready).length,
    })
  }
  const byForm = []
  for (const item of libraries) {
    const found = byForm.find((group) => group.form === item.form)
    if (found) {
      found.count += 1
      if (item.ready) found.ready += 1
      else found.blocked += 1
      continue
    }
    byForm.push({
      form: item.form,
      label: item.formLabel,
      channel: item.channel,
      count: 1,
      ready: item.ready ? 1 : 0,
      blocked: item.ready ? 0 : 1,
    })
  }

  const stats = {
    total: libraries.length,
    remote: libraries.filter((item) => item.kind === 'remote').length,
    files: libraries.filter((item) => item.kind === 'files').length,
    mcp: libraries.filter((item) => item.kind === 'mcp').length,
    ready: libraries.filter((item) => item.ready).length,
    blocked: libraries.filter((item) => !item.ready).length,
    refs: libraries.reduce((sum, item) => sum + item.credentials.length, 0),
    missingRefs: libraries.reduce(
      (sum, item) => sum + item.credentials.filter((field) => field.configured === false).length,
      0,
    ),
    undeclaredAccess: libraries.filter((item) => item.access === null).length,
    lessons: lessons.total,
    lessonGaps: libraries.filter((item) => item.lessonGap).length,
    byBucket,
    byChannel,
    byForm,
  }

  return { libraries, stats, problems: [] }
}
