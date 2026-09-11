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
const fakeDocument = { baseURI: process.env.STASH_TEST_BASE ?? 'http://127.0.0.1:3080/' }
const EXPECTED_PATH = new URL('stash/credentials', fakeDocument.baseURI).pathname
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

let requestedUrl = null
let requestedMethods = []
globalThis.fetch = (url, init) => {
  requestedUrl = String(url)
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

// ── 二次渲染：账号 + 字段两层 ────────────────────────────────────────────
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
let text = textOfTree(tree)
check('不再停留在加载态', !text.includes('正在读取凭据状态'))
check('显示账号中文名', text.includes('示例：某网站') && text.includes('某招标网站') && text.includes('Notion MCP'))
check('统计条显示账号数与字段数', text.includes('账号') && text.includes('字段') && text.includes('3') && text.includes('5'))
check('统计条显示已配置 / 未配置', text.includes('已配置') && text.includes('未配置'))
check('按类别分组显示账号与字段计数', text.includes('网站账号 (2 个账号 · 4 个字段)') && text.includes('MCP / 智能体服务 (1 个账号 · 2 个字段)'))
check('每账号显示 n/m 已配置', text.includes('2/2 已配置'))

// 默认折叠：全配置的账号收起（不渲染字段行）
check('全配置账号默认折叠（看不到字段引用名）', !text.includes('EXAMPLE_ACCOUNT'), 'EXAMPLE_ACCOUNT 不应出现在收起状态')
check('有未配置字段的账号默认展开', text.includes('BID_PORTAL_TOTP') && text.includes('NOTION_MCP_TOKEN'))
check('折叠/展开按钮并存', text.includes('展开 ▾') && text.includes('收起 ▴'))

// 手写条目只读
check('手写条目标注界面只读', text.includes('手写 · 界面只读'))

// 多行值用 textarea；单行值用 password input
const textareas = nodesOf(tree).filter((n) => n.type === 'textarea')
check('多行字段渲染成 textarea', textareas.length === 1, String(textareas.length))
check('多行字段的占位提示是粘贴值', String(textareas[0]?.props?.placeholder ?? '').includes('粘贴值'))
const passwordInputsShown = nodesOf(tree).filter((n) => n.type === 'input' && n.props?.type === 'password')
check('未配置的单行字段直接给出输入框', passwordInputsShown.length >= 2, String(passwordInputsShown.length))
check('已配置字段不摊开输入框，而是给「更换值」', buttons(tree, '更换值').length === 1, String(buttons(tree, '更换值').length))

// ── 展开手写账号 → 更换值 → 保存（值不 trim）────────────────────────────
const expandButtons = buttons(tree, '展开 ▾')
check('渲染出展开按钮', expandButtons.length > 0, String(expandButtons.length))
expandButtons[0].props.onClick()
tree = render()
text = textOfTree(tree)
check('展开后能看到字段引用名', text.includes('EXAMPLE_ACCOUNT') && text.includes('EXAMPLE_PASSWORD'))
check('展开后显示字段状态', text.includes('已配置'))
check('展开后已配置字段同样只给「更换值」', buttons(tree, '更换值').length === 3, String(buttons(tree, '更换值').length))
const disabledMeta = nodesOf(tree)
  .filter((n) => n.type === 'button' && ['编辑信息', '删除条目'].includes((n.children ?? [])[0]))
  .filter((n) => n.props?.disabled === true)
check('手写条目的编辑/删除按钮禁用', disabledMeta.length === 2, String(disabledMeta.length))
check('手写条目给出文件路径提示', text.includes('程序不改写它') && text.includes('sources.mjs'))

const changeButtons = buttons(tree, '更换值')
changeButtons[0].props.onClick()
tree = render()
let pwInputs = nodesOf(tree).filter((n) => n.type === 'input' && n.props?.type === 'password')
const firstInput = pwInputs[0]
check('点「更换值」才出现密码输入框', Boolean(firstInput))
check('输入框受控且初始为空', firstInput?.props?.value === '')

// ⚠️ 首尾空格必须原样保留（P0：不再 trim）
const PADDED = '  pa ss word  '
firstInput.props.onChange({ target: { value: PADDED } })
tree = render()
pwInputs = nodesOf(tree).filter((n) => n.type === 'input' && n.props?.type === 'password')
check('输入后 draft 进入受控值（未被 trim）', pwInputs[0]?.props?.value === PADDED, JSON.stringify(pwInputs[0]?.props?.value))

const saveButtons = buttons(tree, '保存')
check('渲染出保存按钮', saveButtons.length > 0, String(saveButtons.length))
saveButtons[0].props.onClick()
await settle()

check('保存调用到了凭据服务', credentialCalls.length === 1, JSON.stringify(credentialCalls))
check('调用的是 set 且 ref 正确', credentialCalls[0]?.op === 'set' && credentialCalls[0]?.ref === 'EXAMPLE_ACCOUNT', JSON.stringify(credentialCalls[0]))
check('首尾空格原样传给凭据服务（未 trim）', credentialCalls[0]?.value === PADDED, JSON.stringify(credentialCalls[0]?.value))

tree = render()
text = textOfTree(tree)
check('保存后渲染输出不含密钥值', !text.includes('pa ss word'))
check('保存后显示成功提示', text.includes('已保存'))

// ── 移除值必须二次确认 ──────────────────────────────────────────────────
tree = render()
const removeButtons = buttons(tree, '移除值')
check('已配置字段有「移除值」', removeButtons.length >= 1, String(removeButtons.length))
removeButtons[0].props.onClick()
tree = render()
text = textOfTree(tree)
check('移除前出现二次确认', text.includes('确定移除') && text.includes('不可撤销'))
buttons(tree, '取消')[0].props.onClick()
tree = render()
check('取消后不会删值', !credentialCalls.some((c) => c.op === 'unset'))

buttons(tree, '移除值')[0].props.onClick()
tree = render()
buttons(tree, '确认移除')[0].props.onClick()
await settle()
check('确认后才调用 unset', credentialCalls.some((c) => c.op === 'unset' && c.ref === 'EXAMPLE_ACCOUNT'), JSON.stringify(credentialCalls))

// ── 编辑信息：复用新建表单并回填元数据 ──────────────────────────────────
tree = render()
const editButtons = buttons(tree, '编辑信息').filter((n) => n.props?.disabled !== true)
check('代写账号的「编辑信息」可用', editButtons.length > 0, String(editButtons.length))
editButtons[0].props.onClick()
tree = render()
text = textOfTree(tree)
check('编辑表单已打开', text.includes('编辑「某招标网站」的信息'))
const formInputs = nodesOf(tree).filter((n) => n.type === 'input')
check('编辑表单回填中文名', formInputs.some((n) => n.props?.value === '某招标网站'))
check('编辑表单回填字段引用名', formInputs.some((n) => n.props?.value === 'BID_PORTAL_PASSWORD'))
check('编辑表单有保存修改按钮', buttons(tree, '保存修改').length === 1)
check('编辑表单不出现任何值', !text.includes('pa ss word') && !text.includes('super-secret'))

// ── 新建表单：库清单（usedBy）与字段表 ──────────────────────────────────
buttons(tree, '取消')[0].props.onClick()
tree = render()
buttons(tree, '＋ 新建钥匙条目')[0].props.onClick()
tree = render()
text = textOfTree(tree)
check('新建表单列出可关联的库', text.includes('贸易统计（公开接口）') && text.includes('本地语料（导出件）'))
check('新建表单有创建按钮', buttons(tree, '创建').length === 1)
check('新建表单可加字段', buttons(tree, '＋ 加一个字段').length === 1)
check('新建表单提示 inject 用法', text.includes('注入到哪里') || text.includes('env:FOO_API_KEY'))

// ── PATCH 路径：改元数据不发值 ──────────────────────────────────────────
tree = render()
buttons(tree, '取消')[0].props.onClick()
tree = render()
buttons(tree, '编辑信息').filter((n) => n.props?.disabled !== true)[0].props.onClick()
tree = render()
const beforePatch = credentialCalls.length
buttons(tree, '保存修改')[0].props.onClick()
await settle()
check('保存修改发出了 PATCH 请求', requestedMethods.includes('PATCH'), requestedMethods.join(','))
check('PATCH 不经过凭据服务', credentialCalls.length === beforePatch, JSON.stringify(credentialCalls.slice(beforePatch)))
check('写入路径无未处理拒绝', unhandled.length === 0, unhandled.map((e) => (e && e.message) ? e.message : String(e)).join(' | '))

console.log(results.join('\n'))
console.log(`\n结论：${results.every((r) => r.startsWith('✅')) ? '✅ 全部通过' : '❌ 有失败项'}`)
