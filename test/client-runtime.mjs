// 客户端半边的运行时回归测试。
//
// 为什么需要它：node --check 与静态字符串断言都抓不到"变量遮蔽"这类运行时错误。
// 0.3.1 的故障正是如此 —— createSection 的入参叫 api，而新加的 URL helper 也叫 api，
// 于是 async load() 里抛 TypeError，effect 不 await，只剩 unhandled rejection，
// 界面永远停在"正在读取凭据状态…"。本测试专门抓这个形状。
//
// v0.5 起还覆盖：账号/字段两层渲染、默认折叠、「更换值」才出现输入框、
// 「移除值」必须二次确认、值不做 trim（首尾空格必须原样交给凭据服务）、
// 多行值用 textarea、「编辑信息」复用新建表单。
//
// v0.8 起覆盖三层视图：默认落在 L1 概览，**必须点进去**才看得到 L2 清单与 L3 详情。
// 所以本测试的形状是「先断言 L1 的统计索引 → 点类别行/筛选器进 L2 → 点「打开」进 L3」，
// 旧版那些"渲染一次就能看到账号卡"的断言全部改成点进去之后再断言，覆盖内容一条没删。
//
// 用法：node test/client-runtime.mjs [被测文件]
//      STASH_TEST_BASE=http://host/app/ 可测试非根路径部署
// 变异验证：把 client.js 里的 resolveEndpoint(ENDPOINT_PATH) 改回 api(ENDPOINT_PATH)，
//          本测试必须失败 —— 已实测。
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const results = []
const check = (label, ok, detail = '') => results.push(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`)

// async 函数里的 reject 不会同步抛出，只会变成 unhandled rejection ——
// 这才是"永远停在加载态"这类 bug 的真实形状，必须专门抓。
const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })

// ── 最小 React 运行时（够驱动 useState/useCallback/useEffect）─────────────
function makeReactRuntime() {
  const store = { states: [], index: 0, effects: [] }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => {
      const i = store.index++
      if (!(i in store.states)) store.states[i] = typeof init === 'function' ? init() : init
      return [store.states[i], (next) => { store.states[i] = typeof next === 'function' ? next(store.states[i]) : next }]
    },
    useCallback: (fn) => { store.index++; return fn },
    useEffect: (fn) => { store.index++; store.effects.push(fn) },
  }
  return { React, store }
}

// ── 文本提取与节点收集 ───────────────────────────────────────────────────
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) textOf(c, out); return out }
  if (typeof node === 'object' && node.children) { for (const c of node.children) textOf(c, out) }
  return out
}
function collect(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const c of node) collect(c, out); return out }
  if (typeof node === 'object' && node.type) {
    out.push(node)
    for (const c of node.children ?? []) collect(c, out)
  }
  return out
}

// ── 装载 bundle ──────────────────────────────────────────────────────────
const { React, store } = makeReactRuntime()
let definition = null
const fakeWindow = { __ModuleLoader__: { load: (def) => { definition = def } } }
// 假 document 带一张可写的 head，用来验证样式表真的被注入了。
const injectedStyles = []
const fakeHead = {
  appendChild(node) {
    injectedStyles.push({ id: node.id, text: node.textContent })
    fakeDocument._byId.set(node.id, node)
  },
}
const fakeDocument = {
  baseURI: process.env.STASH_TEST_BASE ?? 'http://example.test/',
  head: fakeHead,
  _byId: new Map(),
  createElement: (tag) => ({ tagName: tag, id: "", textContent: "" }),
  getElementById: (id) => fakeDocument._byId.get(id) ?? null,
}
const EXPECTED_PATH = new URL('stash/credentials', fakeDocument.baseURI).pathname
const EXPECTED_PORT_PATH = new URL('stash/portability', fakeDocument.baseURI).pathname
const requireStub = (id) => { if (id === 'react') return React; throw new Error('unexpected require: ' + id) }

try {
  new Function('window', 'document', 'require', src)(fakeWindow, fakeDocument, requireStub)
  check('bundle 可执行并注册 factory', Boolean(definition?.factory))
} catch (error) {
  check('bundle 可执行并注册 factory', false, error.message)
}

const exportsObj = definition.factory(requireStub)
check('factory 导出 apply/inject', typeof exportsObj.apply === 'function' && Array.isArray(exportsObj.inject))

// ── 装配插件，捕获设置页组件 ─────────────────────────────────────────────
// v0.12 起「资源」是**这一页里的一层**（概览 → 大类/形态 → 资源层），不是并列的第二个设置页，
// 所以这里仍然只有一个 settings.section（id=stash）。
const sections = []
let Component = null
let slotOptions = null
// 假凭据服务：记录写入调用，验证值确实走这条路且不进任何渲染输出
const credentialCalls = []
const fakeCredentials = {
  set: async (ref, value) => { credentialCalls.push({ op: 'set', ref, value }); return { ok: true } },
  unset: async (ref) => { credentialCalls.push({ op: 'unset', ref }); return { ok: true } },
}

const ctx = {
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => {
      sections.push({ options, component })
      slotOptions = options
      Component = component
      return () => {}
    },
  },
  // 模拟真实 ctx.inject：就绪时回调，把 remote 命名空间交出来。
  // （真正实现里这条路径是主路径，ctx.get 只是兜底 —— host 侧 webServer 的教训）
  inject: (deps, callback) => {
    for (const dep of deps) callback({ remote: { credentials: fakeCredentials } })
    return () => {}
  },
  get: () => undefined,
}
try {
  exportsObj.apply(ctx)
  check('apply 不抛', true)
} catch (error) {
  check('apply 不抛', false, error.message)
}
check('捕获到设置页组件', typeof Component === 'function')
check('槽位 id 为 stash', slotOptions?.id === 'stash', String(slotOptions?.id))
check('只注册一个设置页（资源层不是并列设置页）', sections.length === 1, sections.map((s) => s.options?.id).join(', '))

const render = () => {
  store.index = 0
  store.effects = []
  return Component({ close: () => {} })
}
const textOfTree = (tree) => textOf(tree).join(' ')
const nodesOf = (tree) => collect(tree)
const buttons = (tree, label) => nodesOf(tree).filter((n) => n.type === 'button' && (n.children ?? []).includes(label))
const settle = async () => { await new Promise((r) => setTimeout(r, 30)) }

// 三层视图是"渲染 → 点 → 重新 render"的循环。
// ⚠️ 断言永远读**刚渲染出来的**那棵树：中间任何一次重新 render 之后再读旧树，
// 读到的就是点击之前的界面（这个坑本测试第一版就踩过）。
const cards = (node) => nodesOf(node).filter((n) => n.type === 'div' && n.props?.className === 'dshs-card')
const click = (node) => { node.props.onClick(); return render() }
/** 找到那张含指定文字的账号卡（用卡片自己的文本定位，不靠下标）。 */
const cardWith = (node, needle) => cards(node).find((card) => textOfTree(card).includes(needle)) ?? null
/** 找到某张卡里某个引用名所在的字段行——值输入框的断言必须限定在这一行里，
 *  否则会被同一张卡上其它字段的「保存」按钮带偏。 */
// 类层（资源视图）是**子组件**：textOf 不会下钻，测试要自己取出来渲染。
const libNode = (node) => nodesOf(node).find((n) => typeof n.type === 'function' && n.props && Array.isArray(n.props.libraries)) ?? null
const libTreeAt = (node) => { const el = libNode(node); return el ? el.type(el.props) : null }
// 整行就是那一颗按钮（不再单独放「详情」）：找 class 为 dshs-rowbtn 的行，用行尾的 ▴/▾ 判断是否已展开。
const cardRow = (card) => nodesOf(card).find((n) => n.props?.className === 'dshs-rowbtn') ?? null
const cardOpen = (card) => nodesOf(card).some((n) => n.type === 'span' && (n.children ?? [])[0] === '▴')
/** 新建页的「新建什么」下拉：resource / account（对象轴；三类由形态派生）。 */
const pickCreateType = (value) => {
  const sel = nodesOf(tree).find((n) => n.type === 'select'
    && (n.children ?? []).some((c) => c && c.props && c.props.value === 'account'))
  if (!sel) throw new Error('找不到「新建什么」下拉')
  sel.props.onChange({ target: { value } })
  tree = render()
  return tree
}
const openCard = (tree0, name) => {
  const card = cardWith(libTreeOf(tree0), name)
  const row = card ? cardRow(card) : null
  if (row && !cardOpen(card)) row.props.onClick()
  return render()
}
const fieldRow = (node, ref) => nodesOf(node)
  .filter((n) => n.type === 'div' && n.props?.className === 'dshs-field')
  .find((row) => textOfTree(row).includes(ref)) ?? null

// ── 第一次渲染：这一步会抓到遮蔽类错误 ───────────────────────────────────
let firstTree = null
let firstError = null
try {
  firstTree = render()
} catch (error) {
  firstError = error
}
check('首次渲染不抛异常', firstError === null, firstError ? `${firstError.name}: ${firstError.message}` : '')
if (firstTree) {
  check('首次渲染显示加载态', textOfTree(firstTree).includes('正在读取凭据状态'), textOfTree(firstTree).slice(0, 80))
}

// ── 假数据：账号 + 字段两层 ──────────────────────────────────────────────
const field = (over) => ({
  ref: 'X', label: 'X', secret: true, inject: null, multiline: false,
  declaredBy: [], configured: false, writable: true, source: null, ...over,
})
const PAYLOAD = {
  ok: true,
  credentialsAvailable: true,
  sourcesFile: 'C:/dsh/stash/sources.mjs',
  localFile: 'C:/dsh/stash/sources.local.json',
  categories: [
    { id: 'site', label: '网站账号' },
    { id: 'api', label: 'API 密钥' },
    { id: 'mcp', label: 'MCP / 智能体服务' },
  ],
  libraries: [
    {
      id: 'trade_stats', name: '贸易统计（公开接口）', kind: 'remote', kindLabel: '远程接口',
      handler: 'trade_stats', handlerLabel: '贸易统计', handlerAvailable: true,
      form: 'trade_stats', formLabel: '贸易统计', channel: 'net', channelLabel: '网络套接字', accessMode: 'fetch',
      server: null, transport: null, tools: '',
      origin: 'handwritten', originLabel: '手写', access: 'official-api', accessLabel: '官方 API / 需授权',
      fetchRefused: false, ready: false, blockers: ['凭据未配置：TRADE_KEY'],
      summary: '按 HS 码取贸易统计的公开接口。', coverage: '月度 · 伙伴国 · 金额与数量',
      boundary: '只取公开聚合数据，不代抓需登录的报关明细。',
      actions: [{ name: 'byProduct', help: '按商品取数' }, { name: 'byPartner', help: '按伙伴取数' }],
      notesCount: 4,
      credentials: [{ ref: 'TRADE_KEY', configured: false, inject: 'header:X-Api-Key' }],
      paths: [], lessons: { count: 2 }, deepIssues: [],
      usage: { calls: 5, failures: 1, lastAt: '2026-01-02T03:04:05.000Z', lastOk: true, lastError: null },
    },
    {
      id: 'corpus', name: '本地语料（导出件）', kind: 'files', kindLabel: '本地语料',
      handler: null, handlerLabel: null, handlerAvailable: null,
      form: 'files', formLabel: '本地语料', channel: 'files', channelLabel: '文件系统', accessMode: 'files',
      server: null, transport: null, tools: '',
      origin: 'local', originLabel: '代写', access: 'export-import', accessLabel: '只能人工导出',
      fetchRefused: true, ready: false,
      blockers: ['access=export-import：stash_fetch 会拒绝，只能人工导出 → corpus/'],
      summary: '人工导出的数据库导出件。', coverage: '2024–2025 年',
      boundary: '不外发。', actions: [], notesCount: 1,
      credentials: [],
      paths: [{ path: 'C:/dsh/stash/corpus/a.csv', exists: true, kind: 'file', bytes: 2048 }],
      lessons: { count: 0 }, deepIssues: [], usage: null,
    },
    {
      id: 'sec_edgar', name: 'SEC EDGAR（年报）', kind: 'remote', kindLabel: '远程接口',
      handler: 'http', handlerLabel: '声明式 HTTP', handlerAvailable: true,
      form: 'http', formLabel: '声明式 HTTP', channel: 'net', channelLabel: '网络套接字', accessMode: 'fetch',
      server: null, transport: null, tools: '',
      request: { url: 'https://data.sec.gov/submissions/CIK{cik}.json', method: 'GET', required: ['cik'] },
      origin: 'local', originLabel: '代写', access: 'public-api', accessLabel: '公开免登录',
      fetchRefused: false, ready: true, blockers: [],
      summary: 'SEC 官方公开申报接口。', coverage: '10-K / 10-Q',
      boundary: '只做取数，不做投资建议。', actions: [{ name: 'filings', help: '取申报清单' }], notesCount: 2,
      credentials: [{ ref: 'SEC_UA', configured: true, inject: 'header:User-Agent' }],
      paths: [], lessons: { count: 0 }, deepIssues: [],
      usage: { calls: 2, failures: 0, lastAt: '2026-01-03T00:00:00.000Z', lastOk: true, lastError: null },
    },
    {
      id: 'my_mcp', name: '某 MCP 服务', kind: 'mcp', kindLabel: 'MCP 服务',
      handler: null, handlerLabel: null, handlerAvailable: null,
      form: 'mcp', formLabel: 'MCP 服务（streamable-http）', channel: 'net', channelLabel: '网络套接字',
      accessMode: 'external', server: 'my_mcp', transport: 'streamable-http', tools: 'mcp__my_mcp__*',
      origin: 'local', originLabel: '代写', access: 'official-api', accessLabel: '官方 API / 需授权',
      fetchRefused: false, ready: true, blockers: [],
      summary: '本机登记的 MCP 服务。', coverage: '该服务暴露的全部工具', boundary: '只读查询，不写回。',
      actions: [], notesCount: 1, credentials: [], paths: [], lessons: { count: 0 }, deepIssues: [],
      // 失败过、但一条经验都没有 → 卡上必须点出这个缺口（lessonGap）。
      usage: { calls: 3, failures: 2, lastAt: '2026-01-05T00:00:00.000Z', lastOk: false, lastError: 'ETIMEDOUT' },
      lessonGap: true,
    },
    {
      id: 'internal_db', name: '内部库（SQLite）', kind: 'remote', kindLabel: '远程接口',
      handler: 'db', handlerLabel: '本地数据库', handlerAvailable: true,
      form: 'db', formLabel: '本地数据库', channel: 'files', channelLabel: '文件系统', accessMode: 'fetch',
      server: null, transport: null, tools: '',
      origin: 'local', originLabel: '代写', access: 'official-api', accessLabel: '官方 API / 需授权',
      fetchRefused: false, ready: true, blockers: [],
      summary: '一条只读 SQL 查询。', coverage: 'users 表', boundary: '只读。',
      actions: [{ name: 'query', help: '执行声明的那条查询' }], notesCount: 0,
      credentials: [], paths: [], lessons: { count: 0 }, deepIssues: [], usage: null,
    },
  ],
  libraryStats: {
    total: 5, remote: 3, files: 1, mcp: 1, ready: 3, blocked: 2,
    refs: 2, missingRefs: 1, undeclaredAccess: 0, lessons: 2,
    byChannel: [
      { channel: 'net', label: '网络套接字', count: 3, ready: 2, blocked: 1 },
      { channel: 'files', label: '文件系统', count: 2, ready: 1, blocked: 1 },
    ],
    byForm: [
      { form: 'http', label: '声明式 HTTP', channel: 'net', count: 1, ready: 1, blocked: 0 },
      { form: 'trade_stats', label: '贸易统计', channel: 'net', count: 1, ready: 0, blocked: 1 },
      { form: 'mcp', label: 'MCP 服务（streamable-http）', channel: 'net', count: 1, ready: 1, blocked: 0 },
      { form: 'files', label: '本地语料', channel: 'files', count: 1, ready: 0, blocked: 1 },
      { form: 'db', label: '本地数据库', channel: 'files', count: 1, ready: 1, blocked: 0 },
    ],
  },
  records: {
    ledger: { records: 28, failed: 5, lastAt: '2026-09-29T15:16:36.000Z', file: 'C:/dsh/stash/ledger.ndjson' },
    lessons: { total: 10, sources: 4, latestAt: '2026-09-28T11:17:50.000Z', file: 'C:/dsh/stash/lessons.json' },
  },
  stats: {
    accounts: 4, fields: 7, configured: 3, missing: 4, unknown: 0,
    byCategory: [
      { category: 'site', categoryLabel: '网站账号', accounts: 2, fields: 4, configured: 3 },
      { category: 'api', categoryLabel: 'API 密钥', accounts: 1, fields: 1, configured: 0 },
      { category: 'mcp', categoryLabel: 'MCP / 智能体服务', accounts: 1, fields: 2, configured: 0 },
    ],
  },
  accounts: [
    {
      id: 'sample_site', label: '示例：某网站', category: 'site', categoryLabel: '网站账号',
      url: 'https://example.com/login', notes: '非机密提示', usedBy: [], declaredBy: [],
      origin: 'handwritten', inVault: true,
      fields: [field({ ref: 'EXAMPLE_ACCOUNT', label: '账号', configured: true }), field({ ref: 'EXAMPLE_PASSWORD', label: '密码', configured: true })],
      stats: { fields: 2, configured: 2, missing: 0, unknown: 0 },
    },
    {
      id: 'bid_portal', label: '某招标网站', category: 'site', categoryLabel: '网站账号',
      url: 'https://bid.example.com', notes: null, usedBy: [], declaredBy: [],
      origin: 'local', inVault: true,
      fields: [
        field({ ref: 'BID_PORTAL_PASSWORD', label: '密码', configured: true, inject: 'env:BID_PORTAL_PASSWORD' }),
        field({ ref: 'BID_PORTAL_TOTP', label: '动态口令种子', configured: false }),
      ],
      stats: { fields: 2, configured: 1, missing: 1, unknown: 0 },
    },
    {
      id: 'notion_mcp', label: 'Notion MCP', category: 'mcp', categoryLabel: 'MCP / 智能体服务',
      url: 'https://mcp.notion.example', notes: 'stdio 启动', usedBy: [], declaredBy: [],
      origin: 'local', inVault: true,
      fields: [
        field({ ref: 'NOTION_MCP_TOKEN', label: '访问令牌', configured: false, inject: 'header:Authorization' }),
        field({ ref: 'NOTION_MCP_SA_JSON', label: '服务账号 JSON', configured: false, multiline: true }),
      ],
      stats: { fields: 2, configured: 0, missing: 2, unknown: 0 },
    },
    {
      // 这条账号是给「远端接口」那一类用的：类层里的账号块靠"引用名交叉"认出来
      // （钥匙跟着它服务的资源走），所以它必须和某条库声明的 ref 对上。
      id: 'odds_service', label: '某赔率服务', category: 'api', categoryLabel: 'API 密钥',
      url: 'https://odds.example.com', notes: null, usedBy: ['trade_stats'], declaredBy: [],
      origin: 'local', inVault: true,
      fields: [field({ ref: 'TRADE_KEY', label: '接口密钥', configured: false, inject: 'query:apiKey' })],
      stats: { fields: 1, configured: 0, missing: 1, unknown: 0 },
    },
  ],
  problems: [],
  note: '只返回状态与元数据',
}

// 迁移端点：默认「没有导出记录」——这样清空块必须是引导文字而不是按钮。
const PORTABILITY = {
  ok: true,
  defaultExportDir: 'C:/dsh/stash-export-20260101-0000',
  exportHome: 'C:/dsh',
  hasExportRecord: false,
  recent: [],
}

let requestedUrl = null
let requestedMethods = []
const mirrorCalls = []
const portCalls = []
const sourceCalls = []
let sourceFailNext = null
globalThis.fetch = (url, init) => {
  const target = String(url)
  // 面板写完值 / 移除值之后的镜像通知：单独记下来，别污染 requestedUrl 的断言。
  if (target.includes('mirror=')) {
    mirrorCalls.push({ url: target, method: (init && init.method) || 'GET', body: init && init.body })
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, written: ['EXAMPLE_ACCOUNT'], removed: [], pendingRestart: true }),
    })
  }
  // 迁移端点单独记：它不该污染凭据端点的断言。
  // 按 ?action= 分支返回，这样导出/导入/计划清空/执行清空四条路径都能被点到。
  if (target.includes('portability')) {
    const action = /[?&]action=([^&]+)/.exec(target)?.[1] ?? null
    portCalls.push({ url: target, method: (init && init.method) || 'GET', body: init && init.body, action })
    const portResponse = action === 'export'
      ? {
        ok: true, action, dir: PORTABILITY.defaultExportDir, verifyCode: 'AB12CD34',
        files: ['sources.local.json', 'ledger.ndjson'], valueCount: 0, corpusFiles: 0,
        report: '导出完成\n目录：C:/dsh/stash-export-20260101-0000\n含 2 个文件\n校验码 AB12CD34',
      }
      : action === 'plan-wipe'
        ? {
          ok: true, action,
          report: '将删除以下内容\n  sources.local.json\n  ledger.ndjson\n凭据值 2 把：EXAMPLE_ACCOUNT、EXAMPLE_PASSWORD',
        }
        : action === 'wipe'
          ? { ok: true, action, report: '已清空\n删掉 5 个文件、2 把凭据值' }
          : action === 'import'
            ? { ok: true, action, report: '导入完成\n库条目 +1' }
            : PORTABILITY
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(portResponse) })
  }
  // 资源写端点：面板的新建 / 编辑 / 删除走这里。单独记调用，并可注入失败结果，
  // 用来验证"host 说不行 → 界面上字段就地标红"这条路径。
  if (target.includes('/stash/sources')) {
    const method = (init && init.method) || 'GET'
    let body = null
    try { body = init && init.body ? JSON.parse(init.body) : null } catch { body = null }
    sourceCalls.push({ url: target, method, body })
    const result = sourceFailNext
      ? {
        ok: false,
        error: sourceFailNext.error,
        hint: sourceFailNext.hint ?? null,
        problems: sourceFailNext.problems ?? [],
      }
      : {
        ok: true,
        entry: body,
        note: '写入 sources.local.json（无值）',
        accountsUpdated: method === 'DELETE' ? 1 : 0,
      }
    sourceFailNext = null
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(result), json: async () => result })
  }
  requestedUrl = target
  requestedMethods.push((init && init.method) || 'GET')
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(PAYLOAD),
  })
}

check('effect 已注册', store.effects.length > 0)
for (const effect of store.effects) {
  try { effect() } catch (error) { check('effect 执行不抛', false, error.message) }
}
check('effect 执行不抛', true)
await settle()

check('已发出请求', requestedUrl !== null, requestedUrl ?? '(未发出)')
check(`请求路径随 baseURI 解析（base=${fakeDocument.baseURI}）`, requestedUrl === EXPECTED_PATH, `${requestedUrl} vs ${EXPECTED_PATH}`)
check(
  '迁移端点也用 resolveEndpoint 构造（同一套 baseURI 解析）',
  portCalls.some((call) => call.url === EXPECTED_PORT_PATH),
  portCalls.map((call) => call.url).join(', ') || '(未请求)',
)

// ── 二次渲染：默认落在 L1 概览 ───────────────────────────────────────────
let tree = null
try {
  tree = render()
} catch (error) {
  check('二次渲染不抛异常', false, error.message)
}
if (!tree) {
  console.log(results.join('\n'))
  process.exit(1)
}
check('二次渲染不抛异常', true)

// ── 视觉体系：颜色走主题令牌，交互态走注入的样式表 ───────────────────────
check(
  '渲染时注入了一次样式表（幂等，重复渲染不再注入）',
  injectedStyles.length === 1 && injectedStyles[0].id === 'dsh-stash-keys-style',
  JSON.stringify(injectedStyles.map((s) => s.id)),
)
check(
  '样式表本身也走主题令牌',
  (injectedStyles[0]?.text.match(/--dsw-alias-/g) ?? []).length >= 8,
  String((injectedStyles[0]?.text.match(/--dsw-alias-/g) ?? []).length),
)
check(
  '交互态（hover / focus）写在样式表里——内联 style 表达不了',
  /button:hover/.test(injectedStyles[0]?.text ?? '') && /focus-visible/.test(injectedStyles[0]?.text ?? ''),
)
check('颜色不再硬编码灰（rgba(128,128,128,…) 在亮/暗里必有一边发虚）', !/rgba\(128,\s*128,\s*128/.test(src))
check('组件里引用的主题令牌不少于 10 处', (src.match(/--dsw-alias-/g) ?? []).length >= 10, String((src.match(/--dsw-alias-/g) ?? []).length))
check('危险操作用 danger 变体', /dshs-danger/.test(src))
check('主操作与次级操作分开了', /dshs-primary/.test(src) && /dshs-ghost/.test(src))
// ⚠️ 实机截图抓到的坑：主按钮写成"品牌色底 + 写死的 #fff 字"，品牌令牌一解析不出来
// 背景就变透明、文字还是白的 —— 白底白字，按钮在、标签看不见。全仓 5 颗主按钮都中招。
check('主按钮不再写死白字（那是白底白字的成因）', !/color:\s*#fff/i.test(src), '源码里还有 color:#fff')
check(
  '每个主题令牌都带系统色兜底，令牌缺失时也不会消失',
  (src.match(/var\(--dsw-alias-[a-z0-9-]+,/g) ?? []).length >= 11,
  String((src.match(/var\(--dsw-alias-[a-z0-9-]+,/g) ?? []).length),
)
// 令牌写死在别处（不经过 C 对象）就会漏掉兜底，这条拦住那种写法。
check(
  '没有绕过 C 对象的裸令牌写法',
  (src.match(/var\(--dsw-alias-[a-z0-9-]+\)/g) ?? []).length === 0,
  String((src.match(/var\(--dsw-alias-[a-z0-9-]+\)/g) ?? []).length),
)

// ── 首页（总览）：数字优先——资源总数 + 三类各多少 ────────────────────────
let text = textOfTree(tree)
check('不再停留在加载态', !text.includes('正在读取凭据状态'))
check('首页标题就是面板名「stash」', text.includes('stash') && buttons(tree, '＋ 新建条目').length === 1)

const heroNums = nodesOf(tree).filter((n) => n.type === 'span' && n.props?.style?.fontSize === '52px')
check('首页给出资源总数（52px 大号字）', heroNums.length === 1, String(heroNums.length))
check('资源总数是全部资源的条数', heroNums[0] && textOf(heroNums[0]).join('') === '5', heroNums[0] ? textOf(heroNums[0]).join('') : '(无)')
check('资源总数带 tabular-nums', heroNums[0]?.props?.style?.fontVariantNumeric === 'tabular-nums')

const cellNums = nodesOf(tree).filter((n) => n.type === 'span' && n.props?.style?.fontSize === '34px')
check('首页三格：三类各多少（34px）', cellNums.length === 3, String(cellNums.length))
check('三格的数字对得上', cellNums.map((n) => textOf(n).join('')).join(',') === '3,0,2', cellNums.map((n) => textOf(n).join('')).join(','))
check('三类名字都在', text.includes('远端接口') && text.includes('本机服务') && text.includes('本机文件'))
check('远端接口那格标出账号与未配置', text.includes('1 个账号') && text.includes('1 把钥匙未配置'))
check('首页给出记账行（台账 / 经验）', text.includes('取数台账 28 条（失败 5）') && text.includes('经验库 10 条 · 覆盖 4 个库'))
check('有阻塞时首页给可点的直达入口（本 fixture 全就绪，故不出现）', buttons(tree, '1 有阻塞 →').length === 0)

// 迁移区块：默认折叠，点开才有内容。
check('首页迁移区块默认折叠（只看到一行标题）', text.includes('迁移') && text.includes('导出 · 导入 · 清空') && !text.includes('① 导出'))
const migFold = buttons(tree, '▸  迁移')
check('首页迁移折叠按钮可点', migFold.length === 1, String(migFold.length))
tree = click(migFold[0])
text = textOfTree(tree)
check('迁移展开后三个小节都在', text.includes('① 导出') && text.includes('② 导入') && text.includes('③ 清空'))
check('迁移展开后折叠按钮变成展开态', buttons(tree, '▾  迁移').length === 1)
check('迁移写明顺序铁律', text.includes('导出 → 在另一台机器导入成功 → 再回来清空'))
check(
  '没有导出记录时，清空按钮**照常渲染但禁用**，旁边写明原因',
  buttons(tree, '查看将删除什么').length === 1
    && buttons(tree, '查看将删除什么')[0].props.disabled === true
    && text.includes('本机还没有导出记录'),
)
check('迁移按钮写的是「导 出」/「导 入」（不与保存混淆）', buttons(tree, '导 出').length === 1 && buttons(tree, '导 入').length === 1)
tree = click(buttons(tree, '▾  迁移')[0])
check('迁移可以收起', !textOfTree(tree).includes('① 导出'))
check('首页不含任何密钥值', !textOfTree(tree).includes('pa ss word'))

// ── 首页 →「远端接口」类层 → 账号清单（全部）────────────────────────────
const bucketCell = nodesOf(tree).find((n) => n.type === 'button' && textOfTree(n).includes('远端接口'))
check('首页三格里的「远端接口」可点', Boolean(bucketCell))
tree = click(bucketCell)
text = textOfTree(tree)
check('类层面包屑从「stash」起，并标出「远端接口」', buttons(tree, 'stash').length === 1 && text.includes('远端接口'))
const classTree = libTreeAt(tree)
const classText = classTree ? textOfTree(classTree) : ''
check('类层渲染出来了（账号 / 资源两块）', Boolean(classTree) && classText.includes('账号') && classText.includes('资源'), classText.slice(0, 80))
check('类层标题是「远端接口」，带「← 概览」', classText.includes('远端接口') && buttons(classTree, '← 概览').length === 1)
check('账号块排在资源前面（钥匙跟着资源走）', classText.indexOf('某赔率服务') < classText.indexOf('贸易统计（公开接口）'))
check('类层不放 52px 大数字（数字归到两个块的标题行，避免重复）', !nodesOf(classTree).some((n) => n.props?.style?.fontSize === '52px'), classText.slice(0, 80))
libNode(tree).props.onOpenLedger()
tree = render()
text = textOfTree(tree)
check('进入 L2 清单', text.includes('清单') && buttons(tree, '← 概览').length === 1)
check('L2 面包屑从「stash」起', buttons(tree, 'stash').length === 1)
check('L2 筛选器四挡齐全（作用于字段）', buttons(tree, '● 全部 7').length === 1 && buttons(tree, '未配置 4').length === 1 && buttons(tree, '已配置 3').length === 1 && buttons(tree, '未登记 0').length === 1)
check('L2 显示账号中文名', text.includes('示例：某网站') && text.includes('某招标网站') && text.includes('Notion MCP'))
check('L2 统计条显示账号数与字段数', text.includes('账号') && text.includes('字段') && text.includes('4') && text.includes('7'))
check('L2 统计条显示已配置 / 未配置', text.includes('已配置') && text.includes('未配置'))
check('按类别分组显示账号与字段计数', text.includes('网站账号 (2 个账号 · 4 个字段)') && text.includes('MCP / 智能体服务 (1 个账号 · 2 个字段)'))
check('每账号显示 n/m 已配置', text.includes('2/2 已配置'))
check('分箱标题后面接 3/4 已配置', text.includes('3/4 已配置'))

// 默认折叠：全配置的账号收起（不渲染字段行）；有未配置的展开。
check('全配置账号默认折叠（看不到字段引用名）', !text.includes('EXAMPLE_ACCOUNT'), 'EXAMPLE_ACCOUNT 不应出现在收起状态')
check('有未配置字段的账号默认展开', text.includes('BID_PORTAL_TOTP') && text.includes('NOTION_MCP_TOKEN'))
check('折叠/展开按钮并存', text.includes('展开 ▾') && text.includes('收起 ▴'))
check('L2 卡片只给缺的那几个字段行', text.includes('BID_PORTAL_TOTP 未配置') && text.includes('NOTION_MCP_TOKEN 未配置'))
// 展开的卡把该账号的字段行都列出来（含已配置的），已配置的行只给「贴值」——
// 换值/删值留在 L3，免得卡片上出现两套同义的按钮。
check('展开的卡列出已配置字段行（作为参照）', text.includes('BID_PORTAL_PASSWORD 已配置') && text.includes('落点 env:BID_PORTAL_PASSWORD'))
check('L2 卡上不给「更换值」（换值留在 L3）', buttons(tree, '更换值').length === 0 && buttons(tree, '移除值').length === 0)

// 手写条目只读（L2 卡片上标注；L3 里按钮禁用）
check('手写条目标注界面只读', text.includes('手写 · 界面只读'))
check('手写条目给出文件路径提示', text.includes('程序不改写它') && text.includes('sources.mjs'))

// 多行值用 textarea；单行未配置值用 password input
const textareas = nodesOf(tree).filter((n) => n.type === 'textarea')
check('多行字段渲染成 textarea', textareas.length === 1, String(textareas.length))
check('多行字段的占位提示是粘贴值', String(textareas[0]?.props?.placeholder ?? '').includes('粘贴值'))
const passwordInputsShown = nodesOf(tree).filter((n) => n.type === 'input' && n.props?.type === 'password')
check('未配置的单行字段直接给出输入框', passwordInputsShown.length >= 2, String(passwordInputsShown.length))
check('已配置字段不摊开输入框，而是给「贴值」', buttons(tree, '贴值').length === 1, String(buttons(tree, '贴值').length))

// ── 卡片就地贴值：调用凭据服务，值不 trim ───────────────────────────────
const totpCard = cardWith(tree, 'BID_PORTAL_TOTP')
check('按文本定位到某招标网站的卡片', Boolean(totpCard))
check('未配置字段在卡上直接给「保存」', buttons(totpCard, '保存').length === 1, String(buttons(totpCard, '保存').length))
const totpInput = nodesOf(totpCard).find((n) => n.type === 'input' && n.props?.type === 'password')
check('卡上输入框受控且初始为空', Boolean(totpInput) && totpInput.props.value === '')

// ⚠️ 首尾空格必须原样保留（P0：不再 trim）
const PADDED = '  pa ss word  '
totpInput.props.onChange({ target: { value: PADDED } })
// onChange 不是导航，重新 render 一次即可看到受控值。
tree = render()
const totpInput2 = nodesOf(cardWith(tree, 'BID_PORTAL_TOTP')).find((n) => n.type === 'input' && n.props?.type === 'password')
check('输入后 draft 进入受控值（未被 trim）', totpInput2?.props?.value === PADDED, JSON.stringify(totpInput2?.props?.value))

const totpSave = buttons(cardWith(tree, 'BID_PORTAL_TOTP'), '保存')
check('渲染出保存按钮', totpSave.length === 1, String(totpSave.length))
totpSave[0].props.onClick()
await settle()
tree = render()
text = textOfTree(tree)
check('保存调用到了凭据服务', credentialCalls.length === 1, JSON.stringify(credentialCalls))
check('调用的是 set 且 ref 正确', credentialCalls[0]?.op === 'set' && credentialCalls[0]?.ref === 'BID_PORTAL_TOTP', JSON.stringify(credentialCalls[0]))
check('首尾空格原样传给凭据服务（未 trim）', credentialCalls[0]?.value === PADDED, JSON.stringify(credentialCalls[0]?.value))

// 值进凭据服务之后，再通知宿主把落点对齐（env:NAME 的字段要同步进 .env）
check(
  '保存后通知宿主做落点镜像',
  mirrorCalls.length === 1 && mirrorCalls[0].url.includes('mirror=sync'),
  JSON.stringify(mirrorCalls.map((call) => call.url)),
)
check(
  '镜像通知只送引用名，不送值',
  !String(mirrorCalls[0]?.body ?? '').includes('pa ss word')
    && JSON.parse(String(mirrorCalls[0]?.body ?? '{}')).ref === 'BID_PORTAL_TOTP',
  String(mirrorCalls[0]?.body),
)

check('保存后渲染输出不含密钥值', !text.includes('pa ss word'))
check('保存后显示成功提示', text.includes('已保存'))
check('保存提示写明已同步到 .env 且需重启', text.includes('.env') && text.includes('重启'), text.slice(0, 200))

// ── 点「打开 →」→ L3 详情 ───────────────────────────────────────────────
tree = click(buttons(cardWith(tree, '某招标网站'), '打开 →')[0])
text = textOfTree(tree)
check('L3 面包屑含分类与账号名', text.includes('网站账号') && text.includes('stash') && text.includes('某招标网站'))
check('L3 头部元信息：分类 · id · 网址 · 来源', text.includes('bid_portal') && text.includes('bid.example.com') && text.includes('来源：代写'))
check('L3 列出字段表与字段数', text.includes('字段（2）') && text.includes('BID_PORTAL_PASSWORD') && text.includes('BID_PORTAL_TOTP'))
check('L3 已配置字段默认收着，给「更换值」', buttons(tree, '更换值').length === 1, String(buttons(tree, '更换值').length))
check('L3 已配置字段有「移除值」', buttons(tree, '移除值').length === 1, String(buttons(tree, '移除值').length))
check('L3 未配置字段直接给输入框', nodesOf(tree).some((n) => n.type === 'input' && n.props?.type === 'password'))
check('L3 显示落点', text.includes('落点 env:BID_PORTAL_PASSWORD'))
check('L3 编辑/删除可用（代写条目）', buttons(tree, '编辑信息').length === 1 && buttons(tree, '删除条目').length === 1)

// ── 更换值：才展开输入框，旧值不回显 ─────────────────────────────────────
tree = click(buttons(tree, '更换值')[0])
const pwRow = fieldRow(tree, 'BID_PORTAL_PASSWORD')
check('点「更换值」才出现密码输入框', Boolean(pwRow) && nodesOf(pwRow).some((n) => n.type === 'input' && n.props?.type === 'password'))
const changedInput = pwRow ? nodesOf(pwRow).find((n) => n.type === 'input' && n.props?.type === 'password') : null
check('输入框受控且初始为空（旧值不回显）', changedInput?.props?.value === '')
check('更换值态下同时给「保存」与「取消」', buttons(pwRow, '保存').length === 1 && buttons(pwRow, '取消').length === 1)
check('未配置字段仍在自己的行里给「保存」', buttons(fieldRow(tree, 'BID_PORTAL_TOTP'), '保存').length === 1)
tree = click(buttons(pwRow, '取消')[0])
check('取消后回到「更换值」态', buttons(tree, '更换值').length === 1 && !fieldRow(tree, 'BID_PORTAL_PASSWORD')?.children.some((c) => c?.type === 'input'))

// ── 移除值必须二次确认 ──────────────────────────────────────────────────
tree = click(buttons(tree, '移除值')[0])
text = textOfTree(tree)
check('移除前出现二次确认', text.includes('确定移除') && text.includes('不可撤销'))
tree = click(buttons(tree, '取消')[0])
check('取消后不会删值', !credentialCalls.some((c) => c.op === 'unset'))

tree = click(buttons(tree, '移除值')[0])
tree = click(buttons(tree, '确认移除')[0])
await settle()
tree = render()
check('确认后才调用 unset', credentialCalls.some((c) => c.op === 'unset' && c.ref === 'BID_PORTAL_PASSWORD'), JSON.stringify(credentialCalls))
check(
  '移除后也通知宿主清 .env（值可能落在任一处，两个都要清）',
  mirrorCalls.some((call) => call.url.includes('mirror=clear')),
  JSON.stringify(mirrorCalls.map((call) => call.url)),
)

// ── 编辑信息：复用新建表单并回填元数据 ──────────────────────────────────
tree = click(buttons(tree, '编辑信息')[0])
text = textOfTree(tree)
check('编辑表单已打开', text.includes('编辑条目'))
const formInputs = nodesOf(tree).filter((n) => n.type === 'input')
check('编辑表单回填中文名', formInputs.some((n) => n.props?.value === '某招标网站'))
check('编辑表单回填字段引用名', formInputs.some((n) => n.props?.value === 'BID_PORTAL_PASSWORD'))
check('编辑表单有保存修改按钮', buttons(tree, '保存修改').length === 1)
check('编辑表单不出现任何值', !text.includes('pa ss word') && !text.includes('super-secret'))
tree = click(buttons(tree, '取消')[0])
check('取消编辑回到详情', !textOfTree(tree).includes('编辑条目'))

// ── 手写条目：整页只读 ──────────────────────────────────────────────────
// 注意：类层的账号块只列"这一类资源用到的账号"。没被任何资源引用的账号（本 fixture 的
// 「示例：某网站」）走「全部账号 →」进 L2 找——这正是"钥匙跟着资源走"的另一面。
tree = click(buttons(tree, 'stash')[0])
tree = click(nodesOf(tree).find((n) => n.type === 'button' && textOfTree(n).includes('远端接口')))
libNode(tree).props.onOpenLedger()
tree = render()
tree = click(buttons(cardWith(tree, '示例：某网站'), '打开 →')[0])
text = textOfTree(tree)
check('L3 手写条目写明来源', text.includes('来源：手写') && text.includes('程序不改写它'))
const disabledMeta = nodesOf(tree)
  .filter((n) => n.type === 'button' && ['编辑信息', '删除条目'].includes((n.children ?? [])[0]))
  .filter((n) => n.props?.disabled === true)
check('手写条目的编辑/删除按钮禁用', disabledMeta.length === 2, String(disabledMeta.length))
check('手写条目的值操作也禁用', nodesOf(tree).filter((n) => n.type === 'button' && (n.children ?? []).includes('更换值')).every((n) => n.props?.disabled === true))

// ── 新建表单：库清单（usedBy）与字段表 ──────────────────────────────────
// 「＋ 新建条目」直接进**一个新建页**，第一个控件是「新建什么」下拉。
tree = click(buttons(tree, 'stash')[0])
tree = click(buttons(tree, '＋ 新建条目')[0])
tree = pickCreateType('account')
text = textOfTree(tree)
// 「被哪些库使用」是**可选补充**，收在「高级」里；默认不摊一屏复选框。
check('账号表单默认不摊库清单（收在高级里）',
  !text.includes('贸易统计（公开接口）') && text.includes('高级：这条账号还给哪些库用（可选）'))
tree = click(buttons(tree, '▸ 高级：这条账号还给哪些库用（可选）')[0])
text = textOfTree(tree)
check('展开高级后列出可关联的库，并写清什么时候才需要勾',
  text.includes('贸易统计（公开接口）') && text.includes('本地语料（导出件）') && text.includes('库里写了 credentials 的不用勾'))
check('新建表单有创建按钮', buttons(tree, '创建').length === 1)
check('新建表单可加字段', buttons(tree, '＋ 加一个字段').length === 1)
check('新建表单提示 inject 用法', text.includes('注入到哪里') || text.includes('env:FOO_API_KEY'))

// ── PATCH 路径：改元数据不发值 ──────────────────────────────────────────
// 新建页的「取消」直接回首页；再从「远端接口 → 全部账号」找那条账号。
tree = click(buttons(tree, '取消')[0])
tree = click(nodesOf(tree).find((n) => n.type === 'button' && textOfTree(n).includes('远端接口')))
libNode(tree).props.onOpenLedger()
tree = render()
tree = click(buttons(cardWith(tree, '某招标网站'), '打开 →')[0])
tree = click(buttons(tree, '编辑信息')[0])
const beforePatch = credentialCalls.length
tree = click(buttons(tree, '保存修改')[0])
await settle()
tree = render()
check('保存修改发出了 PATCH 请求', requestedMethods.includes('PATCH'), requestedMethods.join(','))
check('PATCH 不经过凭据服务', credentialCalls.length === beforePatch, JSON.stringify(credentialCalls.slice(beforePatch)))

// ── 类别不再排在首页：它们进了「远端接口」类层的账号块 ──────────────────
tree = click(buttons(tree, 'stash')[0])
text = textOfTree(tree)
check('首页不再按类别排行（类别收进类层的账号块）', !text.includes('4 把（2 个账号）') && !text.includes('未完成配置'))
const classTree2 = libTreeAt(click(nodesOf(tree).find((n) => n.type === 'button' && textOfTree(n).includes('远端接口'))))
const classText2 = textOfTree(classTree2)
check('账号块里每个账号一张卡，带「N 把未配置」药丸',
  classText2.includes('某赔率服务') && classText2.includes('1 把钥匙') && classText2.includes('1 把未配置'),
  classText2.slice(0, 120))
check('账号卡只列这一类的账号（钥匙跟着资源走）', classText2.includes('某赔率服务') && !classText2.includes('Notion MCP'), classText2.slice(0, 200))
const acctOnlyCard = cardWith(classTree2, '某赔率服务')
check('账号卡也是一行：字段引用名不摊在列表上（细节进账号详情）', Boolean(acctOnlyCard) && !textOfTree(acctOnlyCard).includes('TRADE_KEY') && textOfTree(acctOnlyCard).includes('1 把钥匙'), textOfTree(acctOnlyCard).slice(0, 160))

// ── 反过来：从账号块进 L2，再按「未配置」筛选 ──────────────────────────
// 上一段的 click() 只赋给了 classTree2，tree 本身还停在首页；这里直接点三格。
tree = click(nodesOf(tree).find((n) => n.type === 'button' && textOfTree(n).includes('远端接口')))
libNode(tree).props.onOpenLedger()
tree = render()
const missingFilterBtn = nodesOf(tree).find((n) => n.type === 'button' && (n.children ?? []).includes('未配置 4'))
check('L2 有「未配置」筛选且计数正确', Boolean(missingFilterBtn))
tree = click(missingFilterBtn)
text = textOfTree(tree)
check('未配置视图只剩未配置字段行', text.includes('BID_PORTAL_TOTP') && text.includes('NOTION_MCP_TOKEN') && !text.includes('BID_PORTAL_PASSWORD'), text.slice(0, 160))
check('未配置视图里筛选非全部时自动展开', text.includes('收起 ▴'))
check('未配置视图里没有输入框之外的字段行', buttons(tree, '贴值').length === 0)

// 筛选「已配置」：反过来只留已配置的字段行
const configuredFilter = nodesOf(tree).find((n) => n.type === 'button' && (n.children ?? []).includes('已配置 3'))
tree = click(configuredFilter)
text = textOfTree(tree)
check('已配置视图只剩已配置字段行', text.includes('BID_PORTAL_PASSWORD') && !text.includes('BID_PORTAL_TOTP'), text.slice(0, 160))
// 一个字段都不命中的账号卡整张不显示：MCP 那两个字段全未配置。
check('一个字段都不命中的账号卡整张不显示', !text.includes('NOTION_MCP_TOKEN') && !text.includes('Notion MCP'))

// 点总数回到「全部」
const allFilter = nodesOf(tree).find((n) => n.type === 'button' && (n.children ?? []).includes('全部 7'))
tree = click(allFilter)
check('点筛选「全部」回到全量', textOfTree(tree).includes('BID_PORTAL_TOTP') && textOfTree(tree).includes('BID_PORTAL_PASSWORD'))

// ── 写入路径无未处理拒绝 ────────────────────────────────────────────────
check('写入路径无未处理拒绝', unhandled.length === 0, unhandled.map((e) => (e && e.message) ? e.message : String(e)).join(' | '))

// ── 迁移区块：点击级回归 ────────────────────────────────────────────────
// 这一段放在文件末尾，因为它要把 fixture 翻成"有导出记录"；
// 翻早了会影响前面那些依赖 hasExportRecord:false 的断言。
PORTABILITY.hasExportRecord = true
PORTABILITY.recent = [{ at: '2026-01-01T00:00:00.000Z', dir: PORTABILITY.defaultExportDir, hasValues: false, includesCorpus: false }]
tree = render()
await settle()
tree = render() // 读回 setState 之后的新树，否则拿到的是点击前的界面

// 迁移区块只在 L1，而文件前面最后停在 L2 —— 先回概览。
const backToOverview = buttons(tree, '← 概览')[0]
if (backToOverview) tree = click(backToOverview)
await settle()
tree = render()
check('回到 L1 才看得到迁移区块', buttons(tree, '▸  迁移').length + buttons(tree, '▾  迁移').length === 1, textOfTree(tree).slice(0, 60))

const migToggle = buttons(tree, '▸  迁移')[0] ?? buttons(tree, '▾  迁移')[0]
tree = click(migToggle)
check(
  '还没导出时：按钮在、灰着、有理由',
  buttons(tree, '查看将删除什么').length === 1
    && buttons(tree, '查看将删除什么')[0].props.disabled === true
    && textOfTree(tree).includes('本机还没有导出记录'),
  JSON.stringify(buttons(tree, '查看将删除什么').map((n) => n.props.disabled)),
)

// ① 导出 → 回显校验码。导出完成后客户端会重跑 loadPort()，
//    所以这一步同时也是"清空块什么时候开放"的验证。
click(buttons(tree, '导 出')[0])
await settle()
tree = render()
check('导出后出结果卡', textOfTree(tree).includes('导出完成'), textOfTree(tree).slice(0, 80))
check('导出结果卡回显校验码', textOfTree(tree).includes('AB12CD34'))
const exportCall = portCalls.find((call) => call.action === 'export')
check(
  '⚠ 导出请求体只有动作/目录/开关，**没有值**',
  exportCall && Object.keys(JSON.parse(String(exportCall.body))).every((k) => ['dir', 'withValues', 'includeCorpus'].includes(k)),
  String(exportCall?.body),
)
check(
  '导出之后清空块才给出按钮（顺序铁律：先导出，清空才开放）',
  buttons(tree, '查看将删除什么').length === 1,
  String(buttons(tree, '查看将删除什么').length),
)

// ② 计划清空 → 删除清单 + 空的校验码输入框
// 先把导出结果卡关掉：导出后必须回显校验码（那是给人带走的），
// 所以"不回显"这条只对**清空确认框**成立，不能拿整页文本去断言。
const closeExportCard = buttons(tree, '关闭')[0]
if (closeExportCard) tree = click(closeExportCard)
await settle()
tree = render()
click(buttons(tree, '查看将删除什么')[0])
await settle()
tree = render()
const planText = textOfTree(tree)
check('计划清空返回删除清单', planText.includes('将删除以下内容'), planText.slice(0, 80))
check('清单里点出将删的凭据引用名', planText.includes('EXAMPLE_PASSWORD'))
const codeInputs = nodesOf(tree).filter((n) => n.type === 'input' && n.props?.type === 'password')
check('清空确认框给一个**空的**校验码输入框', codeInputs.length >= 1 && String(codeInputs[codeInputs.length - 1].props.value ?? '') === '', String(codeInputs.length))
// 这条是安全约束：面板若把码回显出来，用户直接抄进去，门槛就没了。
check('⚠ 清空确认框**不回显**校验码', !planText.includes('AB12CD34'))

// ③ 填入校验码 → 确认清空
codeInputs[codeInputs.length - 1].props.onChange({ target: { value: 'AB12CD34' } })
tree = render()
click(buttons(tree, '确认清空')[0])
await settle()
tree = render()
check('执行清空后出结果卡', textOfTree(tree).includes('已清空'), textOfTree(tree).slice(0, 80))
const wipeCall = portCalls.find((call) => call.action === 'wipe')
check(
  '⚠ 清空请求体只有开关与校验码，没有值',
  wipeCall && Object.keys(JSON.parse(String(wipeCall.body))).every((k) => ['includeCorpus', 'confirm'].includes(k)),
  String(wipeCall?.body),
)
check('清空请求带上了用户输入的校验码', String(wipeCall?.body ?? '').includes('AB12CD34'))

// ══ 「资源」层（v0.12）：分类学的第一级/第二级就在面板上 ═════════════════════
// 它**不是**并列的设置页，而是同一个面板里的一层：概览 → 资源（大类/形态）→ 资源层（只读）。
// ⚠️ 资源视图是无 hook 的纯渲染：数据与筛选状态由页面持有、通过 props 传入。
//    所以测试路径是「渲染页面 → 从树里取出资源元素 → 直接调它的 type(props)」；
//    交互（筛选 / 搜索 / 展开）走 props 里的 setter，再重渲染页面取新的 props。
const rowButton = (node, needle) => nodesOf(node)
  .find((n) => n.type === 'button' && n.props?.className === 'dshs-rowbtn' && textOfTree(n).includes(needle)) ?? null
const libTreeOf = libTreeAt

// 回到概览：上面那段清空流程结束时可能停在概览，也可能停在 L2——有面包屑就点回去。
const crumbToOverview = buttons(tree, 'stash')[0]
tree = crumbToOverview ? click(crumbToOverview) : render()

// ① 首页：数字优先——资源总数 + 三类各多少
const overviewText = textOfTree(tree)
check('首页第一段是资源，不是账号', overviewText.indexOf('资源') < overviewText.indexOf('账号'), overviewText.slice(0, 120))
check('首页给出资源总数与状态', overviewText.includes('3 就绪') && overviewText.includes('2 有阻塞'), overviewText.slice(0, 160))
check('首页三格就是三类（空的那类也显示）', overviewText.includes('远端接口') && overviewText.includes('本机服务') && overviewText.includes('本机文件'))
const bucketNums = nodesOf(tree).filter((n) => n.props?.style?.fontSize === '34px')
check(
  '三格数字对得上（远端 3 / 本机服务 0 / 本机文件 2）',
  bucketNums.map((n) => textOf(n).join('')).join(',') === '3,0,2',
  bucketNums.map((n) => textOf(n).join('')).join(','),
)
check('首页给出记录段（台账 / 经验）', overviewText.includes('取数台账 28 条（失败 5）') && overviewText.includes('经验库 10 条 · 覆盖 4 个库'), overviewText.slice(-220))
check('首页给出迁移块', overviewText.includes('迁移'))

// ② 点三格进类层：账号在前、资源在后，数字只算这一类
const bucketBtn = (node, name) => nodesOf(node).find((n) => n.type === 'button' && textOfTree(n).includes(name))
tree = click(bucketBtn(tree, '远端接口'))
check('点三格进入类层', Boolean(libNode(tree)))
check('面包屑从「stash」起并标出「远端接口」', buttons(tree, 'stash').length === 1 && textOfTree(tree).includes('远端接口'))

let libTree = libTreeOf(tree)
const libText = textOfTree(libTree)
check('资源块的数字与账号块同构（名称 · 自身数字 · 动作）', libText.includes('资源') && libText.includes('3 条 · 2 就绪 · 1 有阻塞'), libText.slice(0, 200))
check('账号块在前，资源块在后（账号卡排在资源卡之前）', libText.indexOf('某赔率服务') < libText.indexOf('贸易统计（公开接口）'))
check('账号块给自己的数字（个数 · 钥匙数 · 未配置数）', libText.includes('1 个 · 1 把钥匙') && libText.includes('1 把未配置'), libText.slice(0, 200))
const numberHits = (libText.match(/3 条/g) ?? []).length
check('同一组数字在类层只出现一次（不再三次）', numberHits === 1, '出现 ' + numberHits + ' 次：' + libText.slice(0, 160))
check(
  '两个二级块各有一个下拉（账号：全部/已配置/有未配置；资源：全部/就绪/有阻塞）',
  (() => {
    const sels = nodesOf(libTree).filter((n) => n.type === 'select')
    if (sels.length !== 2) return false
    const optsOf = (s) => (s.children ?? [])
      .filter((c) => c && c.props && c.props.value !== undefined)
      .map((c) => c.props.value).join(',')
    return optsOf(sels[0]) === 'all,ready,missing' && optsOf(sels[1]) === 'all,ready,blocked'
      && buttons(libTree, '全部').length === 0 && buttons(libTree, '有阻塞').length === 0
  })(),
  String(nodesOf(libTree).filter((n) => n.type === 'select').length),
)
check('卡片既装资源也装账号（3 资源 + 1 账号）', cards(libTree).length === 4, String(cards(libTree).length))

// 阻塞的库：卡在哪 + 凭据未配置 + 落点，一眼看全。
const blockedCard = cardWith(libTree, '贸易统计（公开接口）')
const blockedText = blockedCard ? textOfTree(blockedCard) : ''
check('卡片显示库 id', blockedText.includes('trade_stats'), blockedText.slice(0, 80))
check('卡片显示形态标签', blockedText.includes('贸易统计'), blockedText.slice(0, 80))
check('卡片显示取数边界的中文标签', blockedText.includes('官方 API / 需授权'), blockedText.slice(0, 80))
check('阻塞的库在行上直接写卡点', blockedText.includes('凭据未配置：TRADE_KEY'), blockedText.slice(0, 160))
check('未配置的凭据在详情里逐条标出并给落点', (() => { const row = cardRow(blockedCard); if (row && !cardOpen(blockedCard)) row.props.onClick(); return true })() && (() => { const tx = textOfTree(cardWith(libTreeOf(render()), '贸易统计（公开接口）')); return tx.includes('TRADE_KEY') && tx.includes('未配置') && tx.includes('header:X-Api-Key') })())
check('卡片带上取数用量（阻塞时也显示）', blockedText.includes('用过 5 次（失败 1）'), blockedText.slice(0, 220))
check('卡片带上经验条数', blockedText.includes('经验 2 条'), blockedText.slice(0, 120))
check('失败过却没记经验的库在行上点出来', textOfTree(cardWith(libTree, '某 MCP 服务')).includes('失败过未记经验'), textOfTree(cardWith(libTree, '某 MCP 服务')).slice(0, 220))

const readyCard = cardWith(libTree, 'SEC EDGAR（年报）')
const readyText = readyCard ? textOfTree(readyCard) : ''
check('就绪的库显示「就绪」而不是「有阻塞」', readyText.includes('就绪') && !readyText.includes('有阻塞'), readyText.slice(0, 80))
check('已配置的凭据在详情里显示「已配置」', (() => { const row = cardRow(readyCard); if (row && !cardOpen(readyCard)) row.props.onClick(); return true })() && (() => { const t2 = textOfTree(cardWith(libTreeOf(render()), 'SEC EDGAR（年报）')); return t2.includes('已配置') && t2.includes('SEC_UA') })())

// MCP 服务：卡上必须写明"不经 stash 取数、怎么调、台账覆盖不到"。
const mcpCard = cardWith(libTree, '某 MCP 服务')
const mcpText = mcpCard ? textOfTree(mcpCard) : ''
check('MCP 行上标出「引用型」', mcpText.includes('引用型'), mcpText.slice(0, 160))
check('MCP 行上只留「引用型」，调用方式在详情里', mcpText.includes('引用型') && !mcpText.includes('mcp__'))
check('MCP 详情点明调用不进取数台账', (() => { const c = cardWith(libTree, '某 MCP 服务'); const row = cardRow(c); if (row && !cardOpen(c)) row.props.onClick(); return true })() && textOfTree(cardWith(libTreeOf(render()), '某 MCP 服务')).includes('不进取数台账'))
check('MCP 卡片用法不同于本地语料', !mcpText.includes('用法：stash_files'))

// 筛选与搜索：状态在页面这一层，视图只是把 props 渲染出来。
libNode(tree).props.setFilter('blocked')
tree = render()
libTree = libTreeOf(tree)
// 账号下拉真的会筛（与资源同一个套路：标题改报命中数）。
libNode(tree).props.setAcctFilter('missing')
tree = render()
libTree = libTreeOf(tree)
check('账号下拉「有未配置」只留该有的账号', textOfTree(libTree).includes('某赔率服务') && textOfTree(libTree).includes('命中 1 / 1'), textOfTree(libTree).slice(0, 200))
libNode(tree).props.setAcctFilter('ready')
tree = render()
libTree = libTreeOf(tree)
check('账号下拉「已配置」筛掉未配置的账号', !textOfTree(libTree).includes('某赔率服务') && textOfTree(libTree).includes('没有匹配的账号'), textOfTree(libTree).slice(0, 200))
libNode(tree).props.setAcctFilter('all')
tree = render()
libTree = libTreeOf(tree)
check('账号下拉回到全部后恢复原样', textOfTree(libTree).includes('某赔率服务') && textOfTree(libTree).includes('1 个 · 1 把钥匙'), textOfTree(libTree).slice(0, 200))
check('点「有阻塞」筛掉就绪的资源（标题改报命中数）', textOfTree(libTree).includes('命中 1 / 3'), textOfTree(libTree).slice(0, 200))

libNode(tree).props.setFilter('all')
tree = render()
libTree = libTreeOf(tree)
nodesOf(libTree).find((n) => n.type === 'input').props.onChange({ target: { value: 'mcp' } })
tree = render()
libTree = libTreeOf(tree)
check('搜索框按 id / 名称 / 摘要过滤', textOfTree(libTree).includes('1 条') && textOfTree(libTree).includes('某 MCP 服务'))

nodesOf(libTree).find((n) => n.type === 'input').props.onChange({ target: { value: '' } })
tree = render()
libTree = libTreeOf(tree)
check('清空搜索后这一类回到 3 条', textOfTree(libTree).includes('3 条'), textOfTree(libTree).slice(0, 200))


// 「详情」是"点一下切换"的，所以测试里的展开必须**幂等**：只在该展开时展开，
// 否则前面某条断言已经把它打开过，这里再点一下反而关掉，后面的详情断言就全落空。
// （cardRow / cardOpen / openCard 三个助手定义在文件顶部。）

// 「详情」展开：按钮回调走的是页面的 setter，所以由真实点击路径驱动。
const tradeCard = cardWith(libTree, '贸易统计（公开接口）')
check('整行可点开详情（没有单独的「详情」按钮）', Boolean(cardRow(tradeCard)) && !nodesOf(tradeCard).some((n) => n.type === 'button'))
tree = openCard(tree, '贸易统计（公开接口）')
libTree = libTreeOf(tree)
const tradeDetail = textOfTree(cardWith(libTree, '贸易统计（公开接口）'))
check('详情展开后给出禁止边界', tradeDetail.includes('禁止边界：只取公开聚合数据'), tradeDetail.slice(0, 160))
check('详情展开后给出动作清单', tradeDetail.includes('byProduct') && tradeDetail.includes('byPartner'))
check('详情展开后给出该库的取数命令', tradeDetail.includes('stash_fetch source="trade_stats"'))
check('详情展开后提示注意事项所在（不把全文灌进面板）', tradeDetail.includes('注意事项 4 条'))
check('详情展开后凭据行才出现（列表上不摊凭据）', tradeDetail.includes('落点 header:X-Api-Key'))

tree = openCard(tree, '某 MCP 服务')
libTree = libTreeOf(tree)
const mcpDetail = textOfTree(cardWith(libTree, '某 MCP 服务'))
check('MCP 详情给出服务名与工具前缀', mcpDetail.includes('服务名 my_mcp') && mcpDetail.includes('mcp__my_mcp__*'), mcpDetail.slice(0, 200))
check('MCP 详情不说「取数：stash_fetch」', !mcpDetail.includes('取数：stash_fetch'))
check('MCP 详情点明调用不进取数台账', mcpDetail.includes('不进取数台账'))

check('类层说明只读与等效命令', libText.includes('本层只读') && libText.includes('/stash'))
check('类层给出「← 概览」回退（同页内的一层，不是另一个设置页）', buttons(libTree, '← 概览').length === 1)

// ③ 换一类：本机文件装的是文件型资源（形态不再是分组，而是每张卡上的标签）
tree = click(buttons(tree, 'stash')[0])
tree = click(bucketBtn(tree, '本机文件'))
let filesTree = libTreeOf(tree)
check('本机文件那一类装文件型资源', textOfTree(filesTree).includes('本地语料') && textOfTree(filesTree).includes('本地数据库'))
check('人工导出型库显示其边界标签', textOfTree(cardWith(filesTree, '本地语料（导出件）')).includes('只能人工导出'))
check('列表上不摊用法（用法在详情里）', !textOfTree(cardWith(filesTree, '本地语料（导出件）')).includes('用法：stash_files'))
tree = openCard(tree, '本地语料（导出件）')
filesTree = libTreeOf(tree)
const corpusDetailText = textOfTree(cardWith(filesTree, '本地语料（导出件）'))
check('本地语料卡展开后写明用法', corpusDetailText.includes('用法：stash_files 检索 + read'))
check('本地语料卡展开后列出路径', corpusDetailText.includes('corpus/a.csv'))


// 回退：点「← 概览」回到首页，类层消失。
tree = click(buttons(filesTree, '← 概览')[0])
check('「← 概览」回到首页，类层不再渲染', !libNode(tree) && textOfTree(tree).includes('资源总数'))

// ── 新建页：一个页面 + 下拉（新建什么 → 形态）→ 直接提 POST ─────────────
const setByPlaceholder = (needle, value) => {
  const node = nodesOf(tree).find((n) => (n.type === 'input' || n.type === 'textarea')
    && String(n.props?.placeholder ?? '').includes(needle))
  if (!node) throw new Error('找不到输入框：' + needle)
  node.props.onChange({ target: { value } })
  tree = render()
}
/** 表单里的「形态」下拉：六项形态，与技术名一起列。 */
const pickForm = (value) => {
  const sel = nodesOf(tree).find((n) => n.type === 'select'
    && (n.children ?? []).some((c) => c && c.props && c.props.value === value))
  if (!sel) throw new Error('找不到形态下拉')
  sel.props.onChange({ target: { value } })
  tree = render()
}
check('首页有「＋ 新建条目」', buttons(tree, '＋ 新建条目').length === 1)
tree = click(buttons(tree, '＋ 新建条目')[0])
const createText = textOfTree(tree)
check('点开就是**一个新建页**（没有中间菜单）', createText.includes('新建条目') && createText.includes('新建什么'))
check('「新建什么」是**对象**下拉：资源 / 账号（三类不在这里并列）', (() => {
  const sel = nodesOf(tree).find((n) => n.type === 'select'
    && (n.children ?? []).some((c) => c && c.props && c.props.value === 'account'))
  if (!sel) return false
  const opts = (sel.children ?? []).filter((c) => c && c.props && c.props.value !== undefined).map((c) => c.props.value)
  return opts.join(',') === 'resource,account'
})())
check('默认落在「资源」，形态下拉是那六项且**没有类范围**', (() => {
  const formSel = nodesOf(tree).find((n) => n.type === 'select'
    && (n.children ?? []).some((c) => c && c.props && c.props.value === 'objstore'))
  if (!formSel) return false
  const opts = (formSel.children ?? []).filter((c) => c && c.props && c.props.value !== undefined).map((c) => c.props.value)
  return opts.join(',') === 'http,builtin,db,objstore,files,mcp'
})())
check('形态只列一次 MCP（不再在两个类里重复出现）', (() => {
  const formSel = nodesOf(tree).find((n) => n.type === 'select'
    && (n.children ?? []).some((c) => c && c.props && c.props.value === 'mcp'))
  if (!formSel) return false
  const texts = (formSel.children ?? []).filter((c) => c && c.props && c.props.value !== undefined).map((c) => String(textOfTree(c)))
  return texts.filter((x) => x.includes('MCP')).length === 1
})())
let resText = textOfTree(tree)
check('形态那一项旁边给出能力边界', resText.includes('最常见的一种：一个 http(s) 地址'), resText.slice(0, 200))
check('内置处理器不再带本机专有名字（没有贸易 / 政策这类词）',
  !resText.includes('贸易') && !resText.includes('政策') && resText.includes('内置处理器'))
check('边界是一个下拉，两个硬门禁带 ◇', (() => {
  const sel = nodesOf(tree).find((n) => n.type === 'select' && (n.children ?? []).some((c) => c && c.props && c.props.value === 'export-import'))
  if (!sel) return false
  const labels = (sel.children ?? []).map((c) => String(textOfTree(c)))
  return labels.length === 4 && labels.some((x) => x.includes('◇')) && labels.some((x) => x.includes('公开免登录'))
})())
check('归入是一个下拉，默认「自动判定」并写明会归到哪一类', (() => {
  const sel = nodesOf(tree).find((n) => n.type === 'select' && (n.children ?? []).some((c) => c && c.props && c.props.value === 'local-files'))
  if (!sel) return false
  const auto = (sel.children ?? []).find((c) => c && c.props && c.props.value === '')
  return String(sel.props.value) === '' && String(textOfTree(auto)).includes('自动判定')
})())
check('钥匙只登记引用名，并说明值不走这里', resText.includes('只登记') && resText.includes('值在账号详情里贴'))

// 换形态：字段跟着换，形态与归类提示也跟着换
pickForm('objstore')
resText = textOfTree(tree)
check('换成「对象存储 / 文件传输」后取数字段跟着换', resText.includes('端点') && resText.includes('bucket'))
check('归入提示跟着形态走（对象存储 → 远端接口）', textOfTree(tree).includes('会归入「远端接口」'), textOfTree(tree).slice(0, 200))

// 用「本地数据库」走完整条提交路径
pickForm('db')
resText = textOfTree(tree)
check('换成「本地数据库」后取数字段跟着换', resText.includes('SQLite 路径') && resText.includes('只读 SQL'))

sourceCalls.length = 0
setByPlaceholder('小写字母', 'my_sqlite')
setByPlaceholder('人看的名字', '本地 SQLite（只读）')
setByPlaceholder('绝对路径', 'D:/data/app.db')
setByPlaceholder('SELECT', 'SELECT id, name FROM people WHERE dept = :dept')
setByPlaceholder('逗号分隔', 'dept')
tree = click(buttons(tree, '创建')[0])
await settle()
tree = render()
const posted = sourceCalls.find((call) => call.method === 'POST')
check('提交走 POST /stash/sources', Boolean(posted) && posted.url.includes('/stash/sources'), JSON.stringify(sourceCalls).slice(0, 160))
check(
  'payload 组装成注册表形状（kind / handler / request.engine / required）',
  posted && posted.body.kind === 'remote' && posted.body.handler === 'db'
    && posted.body.request.engine === 'sqlite' && posted.body.request.path === 'D:/data/app.db'
    && posted.body.request.required?.[0] === 'dept',
  JSON.stringify(posted && posted.body).slice(0, 220),
)
check('payload 里没有任何值（只有引用名与元数据）', !JSON.stringify(posted && posted.body).includes('pa ss word'))
check('创建成功后回到类层并给出写入提示', textOfTree(libTreeOf(tree)).includes('已写入 sources.local.json'), textOfTree(libTreeOf(tree)).slice(0, 160))

// HTTP 形态的 payload：请求头按行解析成对象、必填参数成数组、上限成数字。
// 这几条盯的是"表单组装出来的形状，注册表能收"——形状错了要等真取数才发现。
tree = click(buttons(tree, 'stash')[0])
tree = click(buttons(tree, '＋ 新建条目')[0])
pickCreateType('resource')
pickForm('http')
tree = click(buttons(tree, '▸ 高级（请求头 / 必填参数 / 条数上限 / 前缀 / 摘要 / 禁止边界）')[0])
setByPlaceholder('小写字母', 'my_api')
setByPlaceholder('example.com/api', 'https://api.example.com/v1/items')
setByPlaceholder('每行一条', 'User-Agent: dsh-stash/1.0\nX-Trace: {trace}')
setByPlaceholder('逗号分隔', 'trace')
setByPlaceholder('如 100', '50')
sourceCalls.length = 0
tree = click(buttons(tree, '创建')[0])
await settle()
const httpPosted = sourceCalls.find((call) => call.method === 'POST')
check(
  'HTTP 表单：请求头解析成对象、必填成数组、上限成数字',
  httpPosted?.body?.handler === 'http'
    && httpPosted.body.request.headers?.['User-Agent'] === 'dsh-stash/1.0'
    && httpPosted.body.request.headers?.['X-Trace'] === '{trace}'
    && httpPosted.body.request.required?.[0] === 'trace'
    && httpPosted.body.request.limit === 50,
  JSON.stringify(httpPosted?.body).slice(0, 260),
)

// 对象存储：两个引用名按顺序进 request（accessKeyIdRef / secretAccessKeyRef），不是只进顶层 credentials。
tree = click(buttons(tree, 'stash')[0])
tree = click(buttons(tree, '＋ 新建条目')[0])
pickCreateType('resource')
pickForm('objstore')
setByPlaceholder('小写字母', 'my_bucket')
setByPlaceholder('s3.example.com', 'https://s3.example.com')
setByPlaceholder('webdav 不用填', 'example-bucket')
sourceCalls.length = 0
tree = click(buttons(tree, '创建')[0])
await settle()
const objPosted = sourceCalls.find((call) => call.method === 'POST')
check(
  '对象存储表单：协议/端点/bucket 都对',
  objPosted?.body?.handler === 'objstore'
    && objPosted.body.request.protocol === 's3'
    && objPosted.body.request.endpoint === 'https://s3.example.com'
    && objPosted.body.request.bucket === 'example-bucket',
  JSON.stringify(objPosted?.body).slice(0, 260),
)



// ── 表单错误态：host 说不行 → 顶部汇总 + 字段就地标红 ──────────────────
tree = click(buttons(tree, 'stash')[0])
tree = click(buttons(tree, '＋ 新建条目')[0])
pickCreateType('resource')
pickForm('http')
resText = textOfTree(tree)
check('HTTP 表单有「高级」折叠，默认收起（请求头输入框不渲染）', resText.includes('▸ 高级') && !nodesOf(tree).some((n) => n.type === 'textarea' && String(n.props?.placeholder ?? '').includes('每行一条')))
tree = click(buttons(tree, '▸ 高级（请求头 / 必填参数 / 条数上限 / 前缀 / 摘要 / 禁止边界）')[0])
resText = textOfTree(tree)
check('展开后出现请求头与禁止边界', resText.includes('请求头') && resText.includes('禁止边界'))

sourceFailNext = {
  error: 'id 已被占用：现有 声明式 HTTP · trade_stats（写在 sources.local.json）',
  hint: '换个 id，或去那条卡片上点「编辑」。',
  problems: ['request.url 不是合法 URL：缺少协议，应以 https:// 开头。'],
}
setByPlaceholder('小写字母', 'trade_stats')
setByPlaceholder('example.com/api', 'data.example.com/x')
tree = click(buttons(tree, '创建')[0])
await settle()
tree = render()
resText = textOfTree(tree)
check('失败时顶部给汇总（含"共 N 处需要改"与 host 的 hint）', resText.includes('id 已被占用') && resText.includes('处需要改') && resText.includes('换个 id'), resText.slice(0, 220))
check('失败时按字段就地标红（id 与地址各一条）', resText.includes('id 已被占用') && resText.includes('不是合法 URL'))
check('失败后仍停在新建页上（不误跳走）', resText.includes('新建条目') && !resText.includes('已写入 sources.local.json'))

// ── 编辑与删除：只对代写条目开放 ────────────────────────────────────────
// 新建页的「取消」直接回首页；再点三格进「远端接口」。
tree = click(buttons(tree, '取消')[0])
tree = click(nodesOf(tree).find((n) => n.type === 'button' && textOfTree(n).includes('远端接口')))
libTree = libTreeOf(tree)
const openDetail = (libTree0, name) => {
  const card = cardWith(libTree0, name)
  const row = card ? cardRow(card) : null
  if (row && !cardOpen(card)) row.props.onClick()
}
openDetail(libTree, '贸易统计（公开接口）')
tree = render()
libTree = libTreeOf(tree)
const handCard = cardWith(libTree, '贸易统计（公开接口）')
check('手写条目没有「编辑」「删除」按钮', !nodesOf(handCard).some((n) => n.type === 'button' && ['编辑', '删除'].includes((n.children ?? [])[0])))
check('手写条目写明程序不改写它', textOfTree(handCard).includes('写在 sources.mjs（手写），程序不改写它'))

openDetail(libTree, 'SEC EDGAR（年报）')
tree = render()
libTree = libTreeOf(tree)
const localCard = cardWith(libTree, 'SEC EDGAR（年报）')
const editBtn = nodesOf(localCard).find((n) => n.type === 'button' && (n.children ?? [])[0] === '编辑')
const delBtn = nodesOf(localCard).find((n) => n.type === 'button' && (n.children ?? [])[0] === '删除')
check('代写条目有「编辑」「删除」两个按钮', Boolean(editBtn) && Boolean(delBtn))
check('代写条目标注来源（sources.local.json）', textOfTree(localCard).includes('sources.local.json'))

tree = click(editBtn)
resText = textOfTree(tree)
check('编辑表单预填 id 与名称', nodesOf(tree).some((n) => n.type === 'input' && n.props?.value === 'sec_edgar'))
check('编辑表单预填取数描述（url / method 回填）', nodesOf(tree).some((n) => n.type === 'input' && String(n.props?.value ?? '').includes('data.sec.gov')))
check('编辑时形态只读（换形态等于换一条库）', !resText.includes('内置处理器 · 贸易统计'), resText.slice(0, 160))

sourceCalls.length = 0
tree = click(buttons(tree, '保存修改')[0])
await settle()
tree = render()
const patched = sourceCalls.find((call) => call.method === 'POST')
check('编辑提交带 overwrite: true（覆盖语义）', patched?.body?.overwrite === true && patched?.body?.id === 'sec_edgar', JSON.stringify(patched?.body).slice(0, 200))

// 删除：二次确认 → DELETE
// 保存成功后回到类层；点根面包屑回首页，再从三格进来（不依赖当前停在哪一类）。
tree = click(buttons(tree, 'stash')[0])
tree = click(nodesOf(tree).find((n) => n.type === 'button' && textOfTree(n).includes('远端接口')))
libTree = libTreeOf(tree)
openDetail(libTree, 'SEC EDGAR（年报）')
tree = render()
libTree = libTreeOf(tree)
tree = click(nodesOf(cardWith(libTree, 'SEC EDGAR（年报）')).find((n) => n.type === 'button' && (n.children ?? [])[0] === '删除'))
libTree = libTreeOf(tree)
const confirmText = textOfTree(libTree)
check('删除前有二次确认（不是一点就没）', confirmText.includes('确认删除 sec_edgar') && buttons(libTree, '取消').length >= 1)
check('确认框说明台账不走、经验仍在', confirmText.includes('取数台账不会删') && confirmText.includes('经验'))
libNode(tree).props.onCancelDelete()
tree = render()
check('取消后不删（没有发出 DELETE）', !sourceCalls.some((call) => call.method === 'DELETE'), JSON.stringify(sourceCalls.map((c) => c.method)))
tree = click(nodesOf(cardWith(libTreeOf(tree), 'SEC EDGAR（年报）')).find((n) => n.type === 'button' && (n.children ?? [])[0] === '删除'))
libNode(tree).props.onConfirmDelete()
await settle()
tree = render()
const deleted = sourceCalls.find((call) => call.method === 'DELETE')
check('确认后发出 DELETE 且带 id', deleted && deleted.url.includes('id=sec_edgar'), JSON.stringify(deleted))
check('删除后给出结果提示（含账号关联被摘掉）', textOfTree(libTreeOf(tree)).includes('已删除 sec_edgar'), textOfTree(libTreeOf(tree)).slice(0, 200))

// ── 搜索：一个框管两边（账号 + 资源），不重复 ────────────────────────────
tree = click(buttons(tree, 'stash')[0])
tree = click(nodesOf(tree).find((n) => n.type === 'button' && textOfTree(n).includes('远端接口')))
let acctTree = libTreeOf(tree)
const searchInputs = nodesOf(acctTree).filter((n) => n.type === 'input' && String(n.props?.placeholder ?? '').includes('搜索'))
check('类层只有一个搜索框（不再账号、资源各一个）', searchInputs.length === 1, String(searchInputs.length))
check('那一个搜索框写明同时管账号与资源', String(searchInputs[0]?.props?.placeholder ?? '').includes('账号') && String(searchInputs[0]?.props?.placeholder ?? '').includes('资源'))
check('状态筛选紧贴资源块（在「资源」标题之后，不在账号块上面）',
  textOfTree(acctTree).indexOf('账号') < textOfTree(acctTree).lastIndexOf('全部'),
  textOfTree(acctTree).slice(0, 160))
libNode(tree).props.setQuery('绝不可能命中的名字')
tree = render()
acctTree = libTreeOf(tree)
check('搜不到账号时给出提示', textOfTree(acctTree).includes('没有匹配的账号'), textOfTree(acctTree).slice(0, 200))
check('搜不到资源时给出提示', textOfTree(acctTree).includes('没有命中当前筛选的资源'), textOfTree(acctTree).slice(0, 240))
libNode(tree).props.setQuery('某赔率服务')
tree = render()
acctTree = libTreeOf(tree)
check('按账号名搜索：账号留下、资源被筛掉', textOfTree(acctTree).includes('某赔率服务') && !textOfTree(acctTree).includes('SEC EDGAR'), textOfTree(acctTree).slice(0, 200))
libNode(tree).props.setQuery('sec_edgar')
tree = render()
acctTree = libTreeOf(tree)
check('按资源 id 搜索：资源留下、账号被筛掉', textOfTree(acctTree).includes('SEC EDGAR') && textOfTree(acctTree).includes('没有匹配的账号'), textOfTree(acctTree).slice(0, 200))
libNode(tree).props.setQuery('')
tree = render()
check('清空搜索后两边都回到原样', textOfTree(libTreeOf(tree)).includes('某赔率服务') && textOfTree(libTreeOf(tree)).includes('SEC EDGAR'))


globalThis.fetch = () => Promise.resolve({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ ok: true, libraries: [{ id: 'legacy_lib', name: '旧形状库' }] }),
})
store.states = []
store.index = 0
store.effects = []
tree = Component({ close: () => {} })
for (const effect of store.effects) {
  try { effect() } catch { /* 降级路径不关心 effect 错误 */ }
}
await settle()
tree = render()
check('旧 payload 在首页也能显示资源总数', nodesOf(tree).some((n) => n.props?.style?.fontSize === '52px' && textOf(n).join('') === '1'), textOfTree(tree).slice(0, 120))
tree = click(bucketBtn(tree, '远端接口'))
libTree = libTreeOf(tree)
check('旧 payload 降级为 id / 名称，不白屏', textOfTree(libTree).includes('旧形状库'), textOfTree(libTree).slice(0, 80))

console.log(results.join('\n'))
console.log(`\n结论：${results.every((r) => r.startsWith('✅')) ? '✅ 全部通过' : '❌ 有失败项'}`)
