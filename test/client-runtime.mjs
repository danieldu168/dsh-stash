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

const src = readFileSync(process.argv[2] ?? new URL('../client/client.js', import.meta.url), 'utf8')
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
  baseURI: process.env.STASH_TEST_BASE ?? 'http://127.0.0.1:3080/',
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
    register: (options, component) => { slotOptions = options; Component = component; return () => {} },
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
    { id: 'trade_stats', name: '贸易统计（公开接口）' },
    { id: 'corpus', name: '本地语料（导出件）' },
  ],
  stats: {
    accounts: 3, fields: 5, configured: 3, missing: 2, unknown: 0,
    byCategory: [
      { category: 'site', categoryLabel: '网站账号', accounts: 2, fields: 4, configured: 3 },
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

// ── L1 概览：一张可点的统计索引 ─────────────────────────────────────────
let text = textOfTree(tree)
check('不再停留在加载态', !text.includes('正在读取凭据状态'))
check('L1 顶部就是「钥匙」与新建入口', text.includes('钥匙') && buttons(tree, '＋ 新建条目').length === 1)

const bigNums = nodesOf(tree).filter((n) => n.type === 'span' && n.props?.style?.fontSize === '28px')
check('L1 总数用 28px 大号字', bigNums.length >= 1, String(bigNums.length))
check('L1 总数是引用名把数', bigNums[0] && textOf(bigNums[0]).join('') === '5', bigNums[0] ? textOf(bigNums[0]).join('') : '(无)')
check('L1 总数带 tabular-nums', bigNums[0]?.props?.style?.fontVariantNumeric === 'tabular-nums')
check('L1 写明「把引用名」', text.includes('把引用名'))
check('L1 三个数字：已配置 / 未配置 / 百分比', text.includes('3 已配置') && text.includes('2 未配置') && text.includes('60%'))
check('L1 有进度条（高 4px、圆角 999px）', nodesOf(tree).some((n) => n.type === 'div' && n.props?.style?.height === '4px' && n.props?.style?.borderRadius === '999px'))
check('L1 有「其中」块', text.includes('其中'))
check('L1 有「注意」块（missing>0 时才出现）', text.includes('注意'))
check('L1 类别行按「把」计数、账号数括注', text.includes('网站账号') && text.includes('4 把（2 个账号）') && text.includes('2 把（1 个账号）'))
check('L1 未完成配置行给出把数', text.includes('未完成配置') && text.includes('2 把'))
check('L1 副行：账号数 / 被几条库引用 / 详情已登记', text.includes('3 个账号') && text.includes('被 2 条库引用') && text.includes('详情已登记 3/3'))

// 迁移区块：默认折叠，点开才有内容。
check('L1 迁移区块默认折叠（只看到一行标题）', text.includes('迁移') && text.includes('导出 · 导入 · 清空') && !text.includes('① 导出'))
const migFold = buttons(tree, '▸  迁移')
check('L1 迁移折叠按钮可点', migFold.length === 1, String(migFold.length))
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
check('L1 不含任何密钥值', !textOfTree(tree).includes('pa ss word'))

// ── 点总数 → L2 清单（全部）─────────────────────────────────────────────
const seeAll = buttons(tree, '查看全部 →')
check('L1 的「查看全部」可点', seeAll.length === 1, String(seeAll.length))
tree = click(seeAll[0])
text = textOfTree(tree)
check('进入 L2 清单', text.includes('清单') && buttons(tree, '← 概览').length === 1)
check('L2 面包屑从「钥匙」起', buttons(tree, '钥匙').length === 1)
check('L2 筛选器四挡齐全（作用于字段）', buttons(tree, '● 全部 5').length === 1 && buttons(tree, '未配置 2').length === 1 && buttons(tree, '已配置 3').length === 1 && buttons(tree, '未登记 0').length === 1)
check('L2 显示账号中文名', text.includes('示例：某网站') && text.includes('某招标网站') && text.includes('Notion MCP'))
check('L2 统计条显示账号数与字段数', text.includes('账号') && text.includes('字段') && text.includes('3') && text.includes('5'))
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
check('L3 面包屑含分类与账号名', text.includes('网站账号') && text.includes('钥匙') && text.includes('某招标网站'))
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
tree = click(buttons(tree, '钥匙')[0])
tree = click(buttons(tree, '查看全部 →')[0])
tree = click(buttons(cardWith(tree, '示例：某网站'), '打开 →')[0])
text = textOfTree(tree)
check('L3 手写条目写明来源', text.includes('来源：手写') && text.includes('程序不改写它'))
const disabledMeta = nodesOf(tree)
  .filter((n) => n.type === 'button' && ['编辑信息', '删除条目'].includes((n.children ?? [])[0]))
  .filter((n) => n.props?.disabled === true)
check('手写条目的编辑/删除按钮禁用', disabledMeta.length === 2, String(disabledMeta.length))
check('手写条目的值操作也禁用', nodesOf(tree).filter((n) => n.type === 'button' && (n.children ?? []).includes('更换值')).every((n) => n.props?.disabled === true))

// ── 新建表单：库清单（usedBy）与字段表 ──────────────────────────────────
tree = click(buttons(tree, '钥匙')[0])
tree = click(buttons(tree, '＋ 新建条目')[0])
text = textOfTree(tree)
check('新建表单列出可关联的库', text.includes('贸易统计（公开接口）') && text.includes('本地语料（导出件）'))
check('新建表单有创建按钮', buttons(tree, '创建').length === 1)
check('新建表单可加字段', buttons(tree, '＋ 加一个字段').length === 1)
check('新建表单提示 inject 用法', text.includes('注入到哪里') || text.includes('env:FOO_API_KEY'))

// ── PATCH 路径：改元数据不发值 ──────────────────────────────────────────
tree = click(buttons(tree, '取消')[0])
tree = click(buttons(cardWith(tree, '某招标网站'), '打开 →')[0])
tree = click(buttons(tree, '编辑信息')[0])
const beforePatch = credentialCalls.length
tree = click(buttons(tree, '保存修改')[0])
await settle()
tree = render()
check('保存修改发出了 PATCH 请求', requestedMethods.includes('PATCH'), requestedMethods.join(','))
check('PATCH 不经过凭据服务', credentialCalls.length === beforePatch, JSON.stringify(credentialCalls.slice(beforePatch)))

// ── 点击映射：点类别行 → 只显示该类别 ───────────────────────────────────
tree = click(buttons(tree, '钥匙')[0])
const catRow = nodesOf(tree).find((n) => n.type === 'button'
  && textOfTree(n).includes('MCP / 智能体服务') && textOfTree(n).includes('2 把（1 个账号）'))
check('L1 类别行是一颗可点的行按钮', Boolean(catRow))
tree = click(catRow)
text = textOfTree(tree)
check('点类别行进了 L2 且只剩该类别', text.includes('MCP / 智能体服务 (1 个账号 · 2 个字段)') && !text.includes('网站账号 (2 个账号 · 4 个字段)'), text.slice(0, 120))
check('只看该类别时别的账号卡不出现', text.includes('Notion MCP') && !text.includes('某招标网站'))

// ── 点击映射：点「未完成配置」→ 只显示未配置字段 ────────────────────────
tree = click(buttons(tree, '钥匙')[0])
const missingRow = nodesOf(tree).find((n) => n.type === 'button'
  && textOfTree(n).includes('未完成配置') && textOfTree(n).includes('2 把'))
check('L1「未完成配置」行是一颗可点的行按钮', Boolean(missingRow))
tree = click(missingRow)
text = textOfTree(tree)
check('点未完成配置进了 L2 且筛选器落在「未配置」', buttons(tree, '● 未配置 2').length === 1, text.slice(0, 120))
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
const allFilter = nodesOf(tree).find((n) => n.type === 'button' && (n.children ?? []).includes('全部 5'))
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

console.log(results.join('\n'))
console.log(`\n结论：${results.every((r) => r.startsWith('✅')) ? '✅ 全部通过' : '❌ 有失败项'}`)
