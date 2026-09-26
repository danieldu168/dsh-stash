// host 半边装配测试 —— 专门复现"服务稍后就绪"的竞态，外加台账 v0.5 的账号/字段模型。
//
// 为什么需要它：0.3.2 的路由注册用了 `ctx.get('webServer')`，在 apply 时服务还没就绪，
// 拿到 undefined 就静默跳过注册。表现为：工具正常、客户端页面正常渲染、
// 但凭据端点 HTTP 404（空 body）。本测试里 `ctx.get` 一律返回 undefined，
// 只有 `ctx.inject` 的回调能拿到服务 —— 旧写法必然失败，新写法必然通过。
//
// 用法：node test/host-assembly.mjs
//
// 隔离：整个测试跑在一个临时 DSH_HOME 下，既不读也不写你真实的 ~/.dsh/stash。
// 注册表用包内附带的 sources.example.mjs 种进去，所以这个脚本在别人机器上也能通过。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-stash-test-'))
process.env.DSH_HOME = TEST_HOME
mkdirSync(join(TEST_HOME, 'stash'), { recursive: true })
copyFileSync(new URL('../sources.example.mjs', import.meta.url), join(TEST_HOME, 'stash', 'sources.mjs'))
process.on('exit', () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true })
  } catch {
    // 临时目录留在系统 temp 里也无妨。
  }
})

const results = []
const check = (label, ok, detail = '') => results.push(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`)

const mod = await import(new URL('../lib/index.js', import.meta.url))

const tools = []
const registered = { routes: {}, command: null }
const promptSections = []
const handlers = {}
const warns = []
const injected = []

const ctx = {
  logger: { warn: (m) => warns.push(m), info: () => {} },
  // 关键：一律拿不到 —— 这正是旧代码失败的场景
  get: () => undefined,
  inject: (deps, callback) => {
    injected.push(...deps)
    for (const dep of deps) {
      // 按路径收集：插件现在注册两条路由（凭据 + 迁移）。只存一条的话，
      // 后注册的那条会把前一条盖掉，测试就会拿错路由去调。
      if (dep === 'webServer') callback({ webServer: { register: (r) => { registered.routes[r.path] = r; return () => {} } } })
      if (dep === 'commands') callback({ commands: { register: (d) => { registered.command = d; return () => {} } } })
      if (dep === 'systemPrompt') {
        callback({
          systemPrompt: {
            getSectionOrder: () => 9900,
            section: (definition) => { promptSections.push(definition); return () => {} },
          },
        })
      }
    }
    return () => {}
  },
  tools: { register: (d) => { tools.push(d); return () => {} } },
  on: (event, handler) => { (handlers[event] ??= []).push(handler); return () => {} },
}

check('插件导出契约', mod.name === 'dsh-stash' && Array.isArray(mod.inject) && typeof mod.apply === 'function')

try {
  mod.apply(ctx)
  check('apply 不抛', true)
} catch (error) {
  check('apply 不抛', false, error.message)
}

check('声明了 ctx.inject 依赖', injected.includes('webServer') && injected.includes('commands'), injected.join(', '))
check('注册 11 个工具', tools.length === 11, tools.map((t) => t.name).join(', '))
const REQUIRED_TOOLS = [
  'stash_catalog', 'stash_fetch', 'stash_files', 'stash_ledger', 'stash_source_add', 'stash_doctor',
  'stash_credential_add', 'stash_credential_remove',
  'stash_lesson_add', 'stash_lesson_list', 'stash_lesson_remove',
]
check(
  '每个必需工具都注册了',
  REQUIRED_TOOLS.every((name) => tools.some((t) => t.name === name)),
  REQUIRED_TOOLS.filter((name) => !tools.some((t) => t.name === name)).join(', ') || '齐全',
)
check('凭据路由已注册（经 ctx.inject）', registered.routes['/stash/credentials']?.path === '/stash/credentials', Object.keys(registered.routes).join(', ') || '未注册')
check('迁移路由已注册（经 ctx.inject）', registered.routes['/stash/portability']?.path === '/stash/portability', Object.keys(registered.routes).join(', ') || '未注册')
check('/stash 命令已注册（经 ctx.inject）', registered.command?.name === 'stash', registered.command?.name ?? '未注册')
// ── 凭据落点：一处录入，两处一致 ─────────────────────────────────────────
// 宿主有两个凭据存储（凭据服务 / .env），服务于两套消费协议。这几个函数是
// 「值该放哪」的唯一权威——纯文件操作，直接打。
const store = await import(new URL('../lib/credential-store.js', import.meta.url))
const envPath = join(TEST_HOME, '.env')
const readEnv = () => (existsSync(envPath) ? readFileSync(envPath, 'utf8') : '')

check('envTargetOf：认 env: 落点', store.envTargetOf('env:MY_KEY') === 'MY_KEY')
check('envTargetOf：非 env 落点返回 null', store.envTargetOf('header:apikey') === null && store.envTargetOf(null) === null)
check('envTargetOf：非法键名也返回 null', store.envTargetOf('env:') === null && store.envTargetOf('env:1BAD') === null)

writeFileSync(envPath, '# 注释\nUNRELATED=keep-me\n', 'utf8')
// 1) env 落点且名字同引用名 → 写进 .env
const mirrored = store.mirrorRefToEnv({ ref: 'MY_KEY', value: 'v1', inject: 'env:MY_KEY' })
check('镜像：env 落点写进 .env', mirrored.written.includes('MY_KEY') && readEnv().includes('MY_KEY=v1'), JSON.stringify(mirrored))
check('镜像：无关的键与注释原样保留', readEnv().includes('UNRELATED=keep-me') && readEnv().includes('# 注释'))
check('镜像：env 落点要求重启', mirrored.pendingRestart === true)

// 2) 非 env 落点 → 不写 .env，但清掉会遮蔽它的同名旧键
writeFileSync(envPath, 'SHADOW=stale\nUNRELATED=keep-me\n', 'utf8')
const cleaned = store.mirrorRefToEnv({ ref: 'SHADOW', value: 'v2', inject: 'header:apikey' })
check('镜像：非 env 落点不写 .env', (cleaned.written ?? []).length === 0)
check('镜像：清掉会遮蔽面板值的旧 .env 键', cleaned.removed.includes('SHADOW') && !readEnv().includes('SHADOW='), JSON.stringify(cleaned))
check('镜像：清理时不动无关的键', readEnv().includes('UNRELATED=keep-me'))

// 3) 落点名与引用名不同 → 写新名，清旧名
writeFileSync(envPath, 'OLD_REF=stale\n', 'utf8')
const renamed = store.mirrorRefToEnv({ ref: 'OLD_REF', value: 'v3', inject: 'env:NEW_NAME' })
check(
  '镜像：落点名变了时写新名、清旧名（不留幽灵值）',
  renamed.written.includes('NEW_NAME') && renamed.removed.includes('OLD_REF')
    && readEnv().includes('NEW_NAME=v3') && !readEnv().includes('OLD_REF='),
  JSON.stringify(renamed),
)

// 4) 清除：引用名与落点名两个都清
writeFileSync(envPath, 'BOTH_REF=a\nTARGET_NAME=b\nUNRELATED=keep-me\n', 'utf8')
const cleared = store.clearRefFromEnv({ ref: 'BOTH_REF', inject: 'env:TARGET_NAME' })
check(
  '清除：引用名与落点名两个都清掉',
  cleared.removed.includes('BOTH_REF') && cleared.removed.includes('TARGET_NAME')
    && !readEnv().includes('BOTH_REF=') && !readEnv().includes('TARGET_NAME='),
  JSON.stringify(cleared),
)
check('清除：不动无关的键', readEnv().includes('UNRELATED=keep-me'))

check('无启动告警', warns.length === 0, warns.join(' | '))

// ── 按需资源线索：agent/pre-step 上的条件注入 ─────────────────────────────
// 位置的选取本身就是设计：这条接缝带着本轮用户的 messages（harness 注入 AGENTS.md 也用同一条），
// 所以能**只在相关时**注入；systemPrompt.section 看不到用户说了什么，只能每步常驻。
const prompt = await import(new URL('../lib/prompt.js', import.meta.url))
const preSteps = handlers['agent/pre-step'] ?? []
check('在 agent/pre-step 上注册了监听', preSteps.length === 1, String(preSteps.length))

const userMessage = (text, id = 'm1') => ({
  id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
})
const enterDecision = (messages) => ({ kind: 'enter', messages })
const runPreStep = async (payload, next) => preSteps[0](payload, next ?? (() => Promise.resolve(enterDecision(payload.messages ?? []))))

// 纯函数层：从 claims 里只认用户真正说的那句话
check(
  '只认用户说的话，跳过 AGENTS.md 与本插件自己注入的消息',
  prompt.latestUserText([
    { id: 'a', role: 'user', content: [{ type: 'text', text: 'AGENTS 指令' }], source: { kind: 'agent-instructions' } },
    { id: 'b', role: 'user', content: [{ type: 'text', text: '帮我查一下数据' }], source: { kind: 'user' } },
    { id: 'c', role: 'user', content: [{ type: 'text', text: '我自己注入的' }], source: { kind: prompt.INJECTION_SOURCE_KIND } },
  ]) === '帮我查一下数据',
)
check('没有任何用户消息时返回空串', prompt.latestUserText([{ id: 'a', role: 'user', content: [], source: { kind: 'user' } }]) === '')

const LIB = [
  { id: 'trade_stats', name: '贸易统计', access: 'official-api', credentials: [{ ref: 'TRADE_KEY', inject: 'header:X-Api-Key' }] },
  { id: 'paid_db', name: '需人工导出的库', access: 'export-import' },
]
check('命中库 id 时认出那几条', prompt.matchLibraries('trade_stats 里那个数是多少', LIB).map((s) => s.id).join(',') === 'trade_stats')
check('命中中文名时也认出', prompt.matchLibraries('帮我看看贸易统计', LIB).map((s) => s.id).join(',') === 'trade_stats')
check('都没提到时不认', prompt.matchLibraries('今天天气怎么样', LIB).length === 0)

check('无意图 → 不注入（返回 null）', prompt.composeInjection('今天天气怎么样', { sources: LIB }) === null)
// 这两条是实测误报的原话：讨论界面分类时写了"API 密钥 Y"和"具体统计数据"，
// 旧触发词把裸名词也算作取数意图，于是往上下文里塞了一段资源线索。
check(
  '裸名词不再误触发（"API密钥Y" 是真实误报的原话）',
  prompt.composeInjection('而是总数、其中：网站账号X、API密钥Y......；注意，未完成配置Z', { sources: LIB }) === null,
)
check('"具体统计数据" 也不再触发', prompt.composeInjection('点击X、Y、Z等具体统计数据，就可以到L2界面了', { sources: LIB }) === null)
check('带动作的短语仍然触发（收紧不能收死）', prompt.composeInjection('帮我查一下数据', { sources: LIB }) !== null)
check('库 id 这条高精度路径不受影响', prompt.composeInjection('trade_stats 里那个数是多少', { sources: LIB }) !== null)
const intentText = prompt.composeInjection('帮我把外部数据取一下', { sources: LIB, ledger: { records: 2, failed: 0 } })
check('有取数意图 → 注入通用线索', typeof intentText === 'string' && intentText.includes('已登记 2 条'), String(intentText).split('\n')[0])
const hitText = prompt.composeInjection('trade_stats 里那个数是多少', { sources: LIB })
check(
  '点到具体库 → 注入那几条的要点（含边界与凭据落点）',
  typeof hitText === 'string' && hitText.includes('trade_stats') && hitText.includes('official-api')
    && hitText.includes('header:X-Api-Key') && hitText.includes('stash_fetch'),
  String(hitText),
)
check(
  '点到越界的库时点明它取不了',
  String(prompt.composeInjection('paid_db 有数据吗', { sources: LIB })).includes('只能人工导出'),
)
check('快照没就绪时绝不注入', prompt.composeInjection('帮我取外部数据', { sources: null, ledger: null }) === null)

// 监听器层：拿一个可控的 load，避免依赖异步读盘
const disposePrompt = prompt.registerStashPrompt(
  { on: (event, handler) => { (handlers[`test:${event}`] ??= []).push(handler); return () => {} } },
  { warn: () => {}, load: async () => ({ sources: LIB, ledger: { records: 0, failed: 0 } }) },
)
const testPreStep = handlers['test:agent/pre-step'][0]
// 真实 harness 的 waterfall 一定会传 next；测试里照做，返回默认的 enter 决定。
const drive = (payload, decision) => testPreStep(
  payload,
  () => Promise.resolve(decision ?? { kind: 'enter', messages: payload.messages ?? [] }),
)
await new Promise((resolve) => setTimeout(resolve, 10)) // 等快照就绪

const irrelevant = await drive({ messages: [userMessage('今天天气怎么样')] })
check('监听器：不相关的一轮原样返回，不注入', irrelevant.messages.length === 1, JSON.stringify(irrelevant.messages.length))

const relevant = await drive({ messages: [userMessage('帮我取一下 trade_stats 的数据')] })
check(
  '监听器：相关的一轮追加一条线索消息',
  relevant.messages.length === 2 && relevant.messages[1].role === 'user'
    && relevant.messages[1].content[0].text.includes('trade_stats')
    && relevant.messages[1].source.kind === prompt.INJECTION_SOURCE_KIND,
  JSON.stringify(relevant.messages[1]?.content?.[0]?.text ?? '').slice(0, 160),
)

const repeat = await drive({ messages: [userMessage('帮我取一下 trade_stats 的数据')] })
check('监听器：同一条用户消息不会重复注入', repeat.messages.length === 1, String(repeat.messages.length))

const rejected = await runPreStep({ messages: [userMessage('帮我取数')] }, () => Promise.resolve({ kind: 'reject' }))
check('监听器：拒绝的决定原样返回，不注入', rejected.kind === 'reject')
void disposePrompt

// ── 路由工具 ──────────────────────────────────────────────────────────────
const makeReq = (method, url, body) => {
  const handlers = {}
  const req = {
    method, url,
    on(event, handler) { (handlers[event] ??= []).push(handler); return req },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body) for (const h of handlers.data ?? []) h(Buffer.from(body, 'utf8'))
    for (const h of handlers.end ?? []) h()
  })
  return req
}
const callRaw = async (method, url, body) => {
  let raw = null
  await registered.routes['/stash/credentials'].handler(makeReq(method, url, body), { writeHead: () => {}, end: (b) => { raw = b } })
  return raw
}
const callRoute = async (method, url, body) => {
  try { return JSON.parse(await callRaw(method, url, body)) } catch { return null }
}

// ── 迁移端点：/stash/portability ────────────────────────────────────────
const callPort = async (method, url, body) =>
  registered.routes['/stash/portability'].handler(
    makeReq(method, url, body),
    { writeHead: () => {}, end: (b) => { portRaw = b } },
  )
let portRaw = null
const portRoute = async (method, action, body) => {
  portRaw = null
  const url = action ? `/stash/portability?action=${action}` : '/stash/portability'
  await callPort(method, url, body === undefined ? null : JSON.stringify(body))
  try { return JSON.parse(portRaw) } catch { return null }
}

const portStatus = await portRoute('GET')
check('迁移端点 GET 报状态', portStatus?.ok === true && typeof portStatus.defaultExportDir === 'string', JSON.stringify(portStatus).slice(0, 120))
check('迁移端点 GET 报有没有导出记录', portStatus?.hasExportRecord === false && Array.isArray(portStatus.recent))
// 这条是安全约束：GET 若把校验码回给界面，清空的门槛就形同虚设。
check('⚠ 迁移端点 GET **不回**校验码', !JSON.stringify(portStatus ?? {}).includes('verifyCode'), '返回里出现了 verifyCode')

const portUnknown = await portRoute('POST', 'nope', {})
check('未知 action 被拒', portUnknown?.ok === false && String(portUnknown.error).includes('不认识的 action'))

const portNoDir = await portRoute('POST', 'import', {})
check('导入缺目录时明确报错，并说明浏览器拿不到本地路径', portNoDir?.ok === false && String(portNoDir.hint).includes('浏览器拿不到本地路径'), String(portNoDir?.hint))

const portPlanNoExport = await portRoute('POST', 'plan-wipe', {})
check('没有导出记录时清空被拒（顺序铁律在 host 侧，不靠 UI 禁用）', portPlanNoExport?.ok === false, JSON.stringify(portPlanNoExport).slice(0, 160))
check('⚠ 迁移端点 plan-wipe 也不回校验码', !JSON.stringify(portPlanNoExport ?? {}).includes('verifyCode'))

const portWipeNoConfirm = await portRoute('POST', 'wipe', {})
check('清空不带校验码时被拒', portWipeNoConfirm?.ok === false, JSON.stringify(portWipeNoConfirm).slice(0, 160))

const portMethod = await portRoute('DELETE')
check('迁移端点不支持的方法返回 ok:false', portMethod?.ok === false)
const TEST_ID = 'zz_test_account'

// ── GET：账号 + 字段两层模型 ───────────────────────────────────────────────
const initial = await callRoute('GET', '/stash/credentials')
const initialRaw = await callRaw('GET', '/stash/credentials')
const accounts = initial?.accounts ?? []
const allFields = accounts.flatMap((account) => account.fields ?? [])

check('GET 返回 ok', initial?.ok === true)
check('GET 返回账号数组', Array.isArray(initial?.accounts) && accounts.length > 0, String(accounts.length))
check('每条账号都有 id 与非空字段表', accounts.every((a) => typeof a.id === 'string' && a.id.length > 0 && Array.isArray(a.fields) && a.fields.length > 0))
check('每个字段都有 ref', allFields.every((f) => typeof f.ref === 'string' && f.ref.length > 0))
check('引用名全局唯一（一个 ref 只属于一个账号）', new Set(allFields.map((f) => f.ref)).size === allFields.length)
check('账号 id 唯一', new Set(accounts.map((a) => a.id)).size === accounts.length)
check('字段带 secret/inject/multiline 形状', allFields.every((f) => typeof f.secret === 'boolean' && 'inject' in f && typeof f.multiline === 'boolean'))
check('端点不回传任何值字段', !/"(value|payload|secretValue)"\s*:/.test(String(initialRaw)))
check('类别表含 mcp', (initial?.categories ?? []).some((c) => c.id === 'mcp'))
check('返回库清单（供表单勾选 usedBy）', Array.isArray(initial?.libraries) && initial.libraries.length >= 4, String(initial?.libraries?.length))
check('返回台账文件路径', typeof initial?.localFile === 'string' && typeof initial?.sourcesFile === 'string')

const s0 = initial?.stats
check('统计：账号数一致', s0?.accounts === accounts.length, `${s0?.accounts} vs ${accounts.length}`)
check('统计：字段数一致', s0?.fields === allFields.length, `${s0?.fields} vs ${allFields.length}`)
check('统计：configured+missing+unknown = 字段数', (s0?.configured ?? -1) + (s0?.missing ?? -1) + (s0?.unknown ?? -1) === s0?.fields, JSON.stringify(s0))
check('统计：分类字段数之和 = 总字段数', (s0?.byCategory ?? []).reduce((sum, g) => sum + g.fields, 0) === s0?.fields, JSON.stringify(s0?.byCategory))
check('统计：分类账号数之和 = 总账号数', (s0?.byCategory ?? []).reduce((sum, g) => sum + g.accounts, 0) === s0?.accounts, JSON.stringify(s0?.byCategory))
check('每条账号自带字段统计', accounts.every((a) => a.stats?.fields === a.fields.length), JSON.stringify(accounts.map((a) => a.stats)))

// ── POST：新建（多字段，含注入点）─────────────────────────────────────────
const badRef = await callRoute('POST', '/stash/credentials', JSON.stringify({ account: { id: 'zz_bad', label: 'x', category: 'api' }, fields: [{ ref: 'lower', label: 'x' }] }))
check('POST 拒绝非法引用名', badRef?.ok === false, badRef?.error ?? '')

const badCat = await callRoute('POST', '/stash/credentials', JSON.stringify({ account: { id: 'zz_bad', label: 'x', category: 'nope' }, fields: [{ ref: 'ZZ_BAD_CAT' }] }))
check('POST 拒绝非法类别', badCat?.ok === false, badCat?.error ?? '')

const leak = await callRoute('POST', '/stash/credentials', JSON.stringify({ account: { id: 'zz_leak', label: 'x', category: 'api' }, fields: [{ ref: 'ZZ_LEAK' }], notes: 'sk-' + 'b'.repeat(30) }))
check('POST 拒绝疑似密钥值', leak?.ok === false, leak?.error ?? '')

const value = await callRoute('POST', '/stash/credentials', JSON.stringify({ account: { id: 'zz_value', label: 'x', category: 'api' }, fields: [{ ref: 'ZZ_VALUE', value: 'hunter2' }] }))
check('POST 拒绝带 value 的字段', value?.ok === false, value?.error ?? '')

const created = await callRoute('POST', '/stash/credentials', JSON.stringify({
  account: { id: TEST_ID, label: 'ZZ 路由测试账号', category: 'api', url: 'https://example.com', usedBy: ['trade_stats'] },
  fields: [
    { ref: 'ZZ_TEST_ACCOUNT', label: '账号' },
    { ref: 'ZZ_TEST_TOKEN', label: '令牌', inject: 'env:ZZ_TEST_TOKEN' },
  ],
}))
check('POST 创建两字段账号', created?.ok === true, JSON.stringify(created))

const afterCreate = await callRoute('GET', '/stash/credentials')
const found = (afterCreate?.accounts ?? []).find((a) => a.id === TEST_ID)
check('GET 能看到新账号', Boolean(found))
check('新账号有两个字段', found?.fields?.length === 2, String(found?.fields?.length))
check('inject 被保留', found?.fields?.find((f) => f.ref === 'ZZ_TEST_TOKEN')?.inject === 'env:ZZ_TEST_TOKEN')
check('usedBy 与库声明合并', (found?.usedBy ?? []).includes('trade_stats'))
check('统计账号数 +1', afterCreate?.stats?.accounts === s0.accounts + 1, `${afterCreate?.stats?.accounts} vs ${s0.accounts + 1}`)

// ── 旧形状仍然可写（向后兼容）─────────────────────────────────────────────
const legacy = await callRoute('POST', '/stash/credentials', JSON.stringify({ ref: 'ZZ_TEST_LEGACY', label: '旧形状条目', category: 'api' }))
check('POST 兼容旧形状（单字段对象）', legacy?.ok === true, JSON.stringify(legacy))
const afterLegacy = await callRoute('GET', '/stash/credentials')
const legacyAccount = (afterLegacy?.accounts ?? []).find((a) => a.fields.some((f) => f.ref === 'ZZ_TEST_LEGACY'))
check('旧形状落成单字段账号', legacyAccount?.fields?.length === 1, JSON.stringify(legacyAccount))

// ── 一个引用名不能属于两个账号 ────────────────────────────────────────────
const clash = await callRoute('POST', '/stash/credentials', JSON.stringify({ account: { id: 'zz_clash', label: 'x', category: 'api' }, fields: [{ ref: 'ZZ_TEST_ACCOUNT' }] }))
check('POST 拒绝一 ref 两账号', clash?.ok === false, clash?.error ?? '')

// ── PATCH：只改元数据 ─────────────────────────────────────────────────────
const patched = await callRoute('PATCH', '/stash/credentials', JSON.stringify({
  id: TEST_ID,
  label: 'ZZ 改名后的账号',
  notes: '改过的备注',
}))
check('PATCH 改元数据成功', patched?.ok === true, JSON.stringify(patched))
const afterPatch = await callRoute('GET', '/stash/credentials')
const patchedAccount = (afterPatch?.accounts ?? []).find((a) => a.id === TEST_ID)
check('PATCH 后中文名已更新', patchedAccount?.label === 'ZZ 改名后的账号', String(patchedAccount?.label))
check('PATCH 不丢字段', patchedAccount?.fields?.length === 2, String(patchedAccount?.fields?.length))
check('PATCH 后备注已更新', patchedAccount?.notes === '改过的备注')

const patchMissing = await callRoute('PATCH', '/stash/credentials', JSON.stringify({ id: 'zz_not_here', label: 'x' }))
check('PATCH 未知 id 返回失败', patchMissing?.ok === false)

// ── DELETE：字段级 / 账号级 ───────────────────────────────────────────────
const removedField = await callRoute('DELETE', '/stash/credentials?ref=ZZ_TEST_TOKEN', null)
check('DELETE 单个字段', removedField?.ok === true, JSON.stringify(removedField))
const afterFieldDelete = await callRoute('GET', '/stash/credentials')
check('删字段后账号仍在（剩 1 个字段）', ((afterFieldDelete?.accounts ?? []).find((a) => a.id === TEST_ID)?.fields?.length) === 1)

const removedAccount = await callRoute('DELETE', `/stash/credentials?id=${TEST_ID}&force=1`, null)
check('DELETE 整条账号', removedAccount?.ok === true, JSON.stringify(removedAccount))

// ── 镜像端点：只送引用名，值由宿主自己读 ─────────────────────────────────
const mirrorBadRef = await callRoute('POST', '/stash/credentials?mirror=sync', JSON.stringify({}))
check('镜像端点：缺 ref 时拒绝', mirrorBadRef?.ok === false && String(mirrorBadRef.error).includes('ref'), JSON.stringify(mirrorBadRef))
const mirrorNoService = await callRoute('POST', '/stash/credentials?mirror=sync', JSON.stringify({ ref: 'ZZ_MIRROR_PROBE' }))
check(
  '镜像端点：本部署没有凭据服务时明确报错，而不是静默',
  mirrorNoService?.ok === false && String(mirrorNoService.error).includes('凭据服务'),
  JSON.stringify(mirrorNoService),
)
const mirrorClear = await callRoute('POST', '/stash/credentials?mirror=clear', JSON.stringify({ ref: 'ZZ_MIRROR_PROBE' }))
check('镜像端点：清除路径不需要凭据服务', mirrorClear?.ok === true && mirrorClear.action === 'clear', JSON.stringify(mirrorClear))

const removedLegacy = await callRoute('DELETE', '/stash/credentials?ref=ZZ_TEST_LEGACY&force=1', null)
check('DELETE 旧形状条目', removedLegacy?.ok === true)

const afterDelete = await callRoute('GET', '/stash/credentials')
check('删除后统计回到初始', afterDelete?.stats?.accounts === s0.accounts, `${afterDelete?.stats?.accounts} vs ${s0.accounts}`)

const missing = await callRoute('DELETE', '/stash/credentials?id=NOT_THERE_AT_ALL', null)
check('DELETE 不存在的条目返回失败', missing?.ok === false)

const badMethod = await callRoute('PUT', '/stash/credentials', null)
check('不支持的方法返回失败', badMethod?.ok === false)

// ── 命令 ─────────────────────────────────────────────────────────────────
if (registered.command) {
  const result = await registered.command.handler({ rawInput: '', agent: { id: 'x' } })
  check('/stash 返回 success', result.kind === 'success')
  // 不硬编码某个人的库 id：命令输出必须覆盖注册表里的每一条。
  const ids = (initial?.libraries ?? []).map((library) => library.id)
  check('/stash 输出覆盖注册表全部库', ids.length >= 4 && ids.every((id) => result.text.includes(id)), ids.join(', '))
}

// ── Model Tool：模型能建条目、但拿不到值 ──────────────────────────────────
const credAdd = tools.find((t) => t.name === 'stash_credential_add')
const credRemove = tools.find((t) => t.name === 'stash_credential_remove')
const doctor = tools.find((t) => t.name === 'stash_doctor')
check('注册了 stash_credential_add', Boolean(credAdd))
check('注册了 stash_credential_remove', Boolean(credRemove))
if (credAdd) {
  check('credential_add 没有 value 参数', !Object.keys(credAdd.parameters.properties ?? {}).includes('value'))
  check('credential_add 支持 fields 与 inject', 'fields' in (credAdd.parameters.properties ?? {}) && 'inject' in (credAdd.parameters.properties ?? {}))
  const lower = await credAdd.execute({ ref: 'lowercase', label: 'x', category: 'api' })
  check('工具拒绝非法引用名', lower.ok === false, lower.error ?? '')
  const leakNote = await credAdd.execute({ ref: 'GOOD_REF', label: 'x', category: 'api', notes: 'sk-' + 'a'.repeat(30) })
  check('工具拒绝把疑似密钥写进 notes', leakNote.ok === false, leakNote.error ?? '')

  const addMulti = await credAdd.execute({
    id: 'zz_tool_account',
    label: 'ZZ 工具条目',
    category: 'mcp',
    fields: [
      { ref: 'ZZ_TOOL_KEY', label: '密钥', inject: 'header:Authorization' },
      { ref: 'ZZ_TOOL_SECRET', label: '签名密钥', multiline: true },
    ],
  })
  check('工具能建多字段账号', addMulti.ok === true, JSON.stringify(addMulti))
  check('工具返回字段表', addMulti.entry?.fields?.length === 2 && addMulti.entry.fields[0].ref === 'ZZ_TOOL_KEY')

  const dupAdd = await credAdd.execute({ id: 'zz_tool_other', label: 'x', category: 'api', ref: 'ZZ_TOOL_KEY' })
  check('工具拒绝一 ref 两账号', dupAdd.ok === false, dupAdd.error ?? '')
}
if (credRemove) {
  const removedTool = await credRemove.execute({ id: 'zz_tool_account' })
  check('工具能删账号', removedTool.ok === true, JSON.stringify(removedTool))
  const unknown = await credRemove.execute({ id: 'zz_never_existed' })
  check('工具拒绝未知 id', unknown.ok === false)
  const noArgs = await credRemove.execute({})
  check('工具要求 id 或 ref', noArgs.ok === false)
}

// ── 体检 ─────────────────────────────────────────────────────────────────
if (doctor) {
  // 先造一条账号，台账统计才有确定性的东西可断言 —— 否则这个测试会依赖"这台机器上
  // 恰好有真实账号"，在别人机器和 CI 上必失败。
  if (credAdd) {
    await credAdd.execute({
      id: 'zz_doctor_account',
      label: 'ZZ 体检账号',
      category: 'api',
      fields: [{ ref: 'ZZ_DOCTOR_KEY', label: '密钥' }],
    })
  }
  const report = await doctor.execute()
  check('体检 healthy', report.healthy === true, JSON.stringify(report.problems))
  check('体检报告含台账统计', report.ledger.accounts >= 1 && report.ledger.fields >= 1, JSON.stringify(report.ledger))
  check('体检 render 含台账行', doctor.output.render({}, report).map((b) => b.text).join('\n').includes('钥匙台账'))
  check('体检返回条目深度校验结果', Array.isArray(report.deepIssues) && report.deepErrors === 0, JSON.stringify(report.deepIssues))
  check('体检返回取数台账统计', Boolean(report.fetchLedger) && report.fetchLedger.records >= 0)
  check('体检 render 含取数台账行', doctor.output.render({}, report).map((b) => b.text).join('\n').includes('取数台账'))
  if (credRemove) await credRemove.execute({ id: 'zz_doctor_account' })
}

// ── 输出边界自检 ──────────────────────────────────────────────────────────
// 宿主要求工具输出是 lossless JSON（core/tools 在边界处跑这条校验）：`undefined`、
// 非有限数、类实例都会让**整份输出**被拒收，调用方只看到一句 "value is not lossless JSON"，
// 插件精心组织的 error / hint / body 全丢。这里复刻那条规则，用来锁住"失败路径也要过边界"。
// 注意 JSON.stringify 不能替代它——它会把 undefined 字段静默丢掉，于是断言照样通过。
const isLossless = (value) => {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (type !== 'object') return false
  if (Array.isArray(value)) return value.every(isLossless)
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) return false
  return Object.values(value).every(isLossless)
}
check(
  '边界自检自身可靠：识破 undefined 字段、不误伤 null',
  isLossless({ a: undefined }) === false && isLossless({ a: null, b: [1, 'x', true] }) === true,
)

// ── 使用边界 + 取数台账 ──────────────────────────────────────────────────
const sourceAdd = tools.find((t) => t.name === 'stash_source_add')
const fetchTool = tools.find((t) => t.name === 'stash_fetch')
const ledgerTool = tools.find((t) => t.name === 'stash_ledger')
check('注册了 stash_ledger', Boolean(ledgerTool))
check('注册了 stash_source_add / stash_fetch', Boolean(sourceAdd) && Boolean(fetchTool))

if (sourceAdd && fetchTool && ledgerTool) {
  // 深度校验：能加载但注定取不到数的写法，在登记前就拒收
  const badUrl = await sourceAdd.execute({ id: 'zz_bad_url', name: 'x', kind: 'remote', handler: 'http', request: { url: '不是URL' } })
  check('登记时拒绝非法 request.url', badUrl.ok === false, badUrl.error ?? '')

  const badRef = await sourceAdd.execute({
    id: 'zz_bad_ref', name: 'x', kind: 'remote', handler: 'http', access: 'official-api',
    request: { url: 'https://example.com/a', headers: { 'X-K': '{credential:NOT_DECLARED}' } },
  })
  check('登记时拒绝未声明的凭据引用', badRef.ok === false, badRef.error ?? '')

  const badRequired = await sourceAdd.execute({
    id: 'zz_bad_required', name: 'x', kind: 'remote', handler: 'http', access: 'public-api',
    request: { url: 'https://example.com/a', required: ['query'] },
  })
  check('登记时拒绝没出现在请求里的 required', badRequired.ok === false, badRequired.error ?? '')

  const badAccess = await sourceAdd.execute({
    id: 'zz_bad_access', name: 'x', kind: 'remote', handler: 'http', access: 'whatever',
    request: { url: 'https://example.com/a' },
  })
  check('登记时拒绝非法 access', badAccess.ok === false, badAccess.error ?? '')

  // 使用边界：声明了 export-import 的库，取数被拒且留痕
  const bounded = await sourceAdd.execute({
    id: 'zz_boundary', name: 'ZZ 边界库', kind: 'remote', handler: 'http', access: 'export-import',
    request: { url: 'https://example.com/never-called' },
  })
  check('能登记一条声明了边界的库', bounded.ok === true, JSON.stringify(bounded))

  const refused = await fetchTool.execute({ source: 'zz_boundary', action: 'search' })
  check('access=export-import 的库被 stash_fetch 拒绝', refused.ok === false && refused.kind === 'boundary', JSON.stringify(refused).slice(0, 160))
  check('被拒绝也返回 ledgerId（留痕）', typeof refused.ledgerId === 'string' && refused.ledgerId.length === 12, String(refused.ledgerId))

  const ledger = await ledgerTool.execute({ source: 'zz_boundary' })
  check('台账能查到刚才那条拒绝记录', ledger.ok === true && ledger.matched >= 1 && ledger.records[0].ok === false, JSON.stringify(ledger).slice(0, 160))
  check('台账记录带 contentHash 与 engine', typeof ledger.records[0]?.contentHash === 'string' && typeof ledger.records[0]?.engine === 'string')
  check('台账只记指纹不记内容', !/"items":/.test(JSON.stringify(ledger.records)))
  check('台账 render 显示拒绝原因', ledgerTool.output.render({}, ledger).map((b) => b.text).join('\n').includes('export-import'))

  const onlyFailed = await ledgerTool.execute({ onlyFailed: true })
  check('onlyFailed 只返回失败记录', onlyFailed.records.every((record) => record.ok !== true))
  check('只有一条台账时 total 一致', ledger.total === 1, String(ledger.total))

  const unknown = await ledgerTool.execute({ source: 'zz_no_such_library' })
  check('查未知库的台账返回空集而不是报错', unknown.ok === true && unknown.matched === 0)

  // ── 失败路径必须过输出边界 ─────────────────────────────────────────────
  // 回归背景：summaryText 曾在失败时被写成 undefined，而 undefined 不是 lossless JSON，
  // 宿主于是拒收**整份输出**，调用方只拿到一句 "value is not lossless JSON"，
  // kind / error / hint / body / ledgerId 全丢——失败路径恰恰最需要这些字段。
  // 触发手段：声明一个必填参数 query，调用时不传。handler 在发请求之前就返回结构化失败
  // （handlers/http.js 的必填参数前置校验），走的正是当初坏掉的那条 `return { ...result }`。
  // 特意不声明凭据——那会合成一条占位账号，让清场谓词判它没清干净。全程离线、不联网。
  const offline = await sourceAdd.execute({
    id: 'zz_offline', name: 'ZZ 离线失败库', kind: 'remote', handler: 'http', access: 'public-api',
    request: { url: 'https://example.com/never-called', query: { q: '{query}' }, required: ['query'] },
  })
  check('能登记一条声明了必填参数的库', offline.ok === true, JSON.stringify(offline).slice(0, 160))

  const offlineFetch = await fetchTool.execute({ source: 'zz_offline', action: 'search' })
  check(
    '取数失败返回结构化失败而不是抛',
    offlineFetch.ok === false && typeof offlineFetch.error === 'string',
    JSON.stringify(offlineFetch).slice(0, 160),
  )
  check('失败结果的 summaryText 是 null 而不是 undefined', offlineFetch.summaryText === null)
  check(
    '失败结果通过 lossless JSON 边界',
    isLossless(offlineFetch),
    Object.keys(offlineFetch).filter((k) => offlineFetch[k] === undefined).join(', ') || '无 undefined 字段',
  )
  check(
    '失败也不丢 ledgerId',
    typeof offlineFetch.ledgerId === 'string' && offlineFetch.ledgerId.length === 12,
    String(offlineFetch.ledgerId),
  )

  // 上游正文（handlers/http.js 已截断到 400 字符）必须带到渲染层
  const failedRender = fetchTool.output.render(
    { source: 'zz_offline', action: 'search' },
    {
      ok: false, kind: 'http', error: 'HTTP 400', hint: '通用提示',
      body: '{"code":"42703","message":"column cases.slug does not exist"}', ledgerId: 'abc123def456',
    },
  ).map((b) => b.text).join('\n')
  check('失败渲染带出上游正文', failedRender.includes('42703') && failedRender.includes('上游正文'), failedRender.replace(/\n/g, ' | '))
  check('没有正文时渲染不多出一行', !fetchTool.output.render({}, { ok: false, kind: 'http', error: 'HTTP 400' })
    .map((b) => b.text).join('\n').includes('上游正文'))

  // ── 可选占位符 {?name}：缺参数时整键丢弃，而不是代入空串 ────────────────
  // 用本机回环起一个临时服务（不是外网），直接断言**真正发出去的查询串**。
  // 背景：`eq.{category}` 在缺参数时代入成 `eq.`，看着合法、实际必被上游拒；
  // 而"可选过滤器"用 required 表达不了（那会把它变成必填）。
  const seenUrls = []
  const probe = createServer((req, res) => {
    seenUrls.push(req.url)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ items: [{ ok: true }] }))
  })
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const probePort = probe.address().port

  const optionalSource = await sourceAdd.execute({
    id: 'zz_optional', name: 'ZZ 可选参数库', kind: 'remote', handler: 'http', access: 'public-api',
    request: { url: `http://127.0.0.1:${probePort}/search`, query: { filter: 'eq.{?category}' }, pick: 'items' },
  })
  check('能登记带可选占位符 {?name} 的库', optionalSource.ok === true, JSON.stringify(optionalSource).slice(0, 200))

  const misplaced = await sourceAdd.execute({
    id: 'zz_optional_bad', name: 'x', kind: 'remote', handler: 'http', access: 'public-api',
    request: { url: 'https://example.com/{?id}' },
  })
  check('可选占位符用在 query 之外时，登记即拒收', misplaced.ok === false, misplaced.error ?? '')

  await fetchTool.execute({ source: 'zz_optional', action: 'search' })
  check(
    '缺参数时整键丢弃（不发 filter=eq. 那种畸形串）',
    seenUrls[0] !== undefined && !seenUrls[0].includes('filter='),
    String(seenUrls[0]),
  )

  await fetchTool.execute({ source: 'zz_optional', action: 'search', params: { category: 'case_study' } })
  check(
    '给了参数时按普通占位符代入',
    String(seenUrls[1]).includes('filter=eq.case_study'),
    String(seenUrls[1]),
  )

  await fetchTool.execute({ source: 'zz_optional', action: 'search', params: { category: '' } })
  check('参数是空串也按缺参数处理（整键丢弃）', !String(seenUrls[2]).includes('filter='), String(seenUrls[2]))

  await new Promise((resolve) => probe.close(resolve))
}

// ── 经验库（0.8.0）：按库记「下次别再踩」的坑与正确写法 ──────────────────
const lessonAdd = tools.find((t) => t.name === 'stash_lesson_add')
const lessonList = tools.find((t) => t.name === 'stash_lesson_list')
const lessonRemove = tools.find((t) => t.name === 'stash_lesson_remove')
const catalogTool = tools.find((t) => t.name === 'stash_catalog')
check('注册了 stash_lesson_add / list / remove', Boolean(lessonAdd) && Boolean(lessonList) && Boolean(lessonRemove))
check(
  '经验存在独立文件里（所以手写库也能记）',
  (await import(new URL('../lib/home.js', import.meta.url))).LESSONS_FILE.endsWith('lessons.json'),
)

if (lessonAdd && lessonList && lessonRemove && catalogTool) {
  const LESSON_TITLE = 'byProduct 的 records 是兄弟 HS 码，不是答案'
  const added = await lessonAdd.execute({
    source: 'trade_stats',
    title: LESSON_TITLE,
    body: '只读 aggregateRecords。实测返回 020220/020210。',
    action: 'byProduct',
    tags: ['口径'],
    evidence: 'abc123def456',
  })
  // 关键点：trade_stats 住在手写的 sources.mjs 里——旧设计（经验挂库条目上）根本写不进去。
  check('能给手写 sources.mjs 里的库记经验', added.ok === true, JSON.stringify(added).slice(0, 160))
  check('返回经验条目 id（12 位）', typeof added.entry?.id === 'string' && added.entry.id.length === 12, String(added.entry?.id))
  check('写入的是独立经验文件', typeof added.file === 'string' && added.file.endsWith('lessons.json'))

  const unknownSource = await lessonAdd.execute({ source: 'zz_no_such_library', title: 'x' })
  check('拒绝给未登记的库记经验', unknownSource.ok === false, unknownSource.error ?? '')

  const noTitle = await lessonAdd.execute({ source: 'trade_stats' })
  check('拒绝没有 title 的经验', noTitle.ok === false)

  const leakLesson = await lessonAdd.execute({ source: 'trade_stats', title: 'x', body: 'sk-' + 'c'.repeat(30) })
  check('经验正文命中密钥特征时拒绝写入', leakLesson.ok === false, leakLesson.error ?? '')

  const listed = await lessonList.execute({ source: 'trade_stats' })
  check('能读回刚记的经验', listed.ok === true && listed.matched === 1, JSON.stringify(listed).slice(0, 160))
  check('读回条目字段完整', listed.groups[0]?.lessons[0]?.title === LESSON_TITLE && listed.groups[0]?.lessons[0]?.tags?.[0] === '口径')
  check('经验 render 含标题', lessonList.output.render({}, listed).map((b) => b.text).join('\n').includes('兄弟 HS 码'))

  const filtered = await lessonList.execute({ query: 'aggregaterecords' })
  check('query 是子串匹配且不区分大小写', filtered.matched === 1, String(filtered.matched))
  const miss = await lessonList.execute({ query: '绝不存在的字符串' })
  check('query 无命中时返回空集而不是报错', miss.ok === true && miss.matched === 0)

  // catalog 带出：全量清单只给条数与预览，单库查询才给全文（免得把经验库整个灌进上下文）
  const all = await catalogTool.execute({})
  const tradeStats = all.sources.find((s) => s.id === 'trade_stats')
  check('catalog 全量清单带出经验条数', tradeStats?.lessons?.count === 1, JSON.stringify(tradeStats?.lessons).slice(0, 160))
  check('catalog 全量清单不给全文', !tradeStats?.lessons?.entries)
  check('catalog 全量清单给标题预览', tradeStats?.lessons?.latest?.[0]?.title === LESSON_TITLE)
  const one = await catalogTool.execute({ id: 'trade_stats' })
  check('catalog 单库查询给经验全文', one.sources[0]?.lessons?.entries?.[0]?.body?.includes('aggregateRecords') === true)
  check('catalog render 出现经验行', catalogTool.output.render({}, all).map((b) => b.text).join('\n').includes('经验 1 条'))

  // doctor：失败台账是证据、经验是结论；有证据没结论的库要点出来
  const gapReport = await doctor.execute()
  check('doctor 返回经验库统计', Boolean(gapReport.lessons) && gapReport.lessons.total === 1, JSON.stringify(gapReport.lessons))
  check('doctor render 含经验库行', doctor.output.render({}, gapReport).map((b) => b.text).join('\n').includes('经验库'))
  check(
    'doctor 点出「有失败取数却没记经验」的库',
    (gapReport.lessonGaps ?? []).some((gap) => gap.source === 'zz_boundary'),
    JSON.stringify(gapReport.lessonGaps),
  )
  check('已记经验的库不进 gap 名单', !(gapReport.lessonGaps ?? []).some((gap) => gap.source === 'trade_stats'))
  check('经验不参与 healthy 判定（只是提示）', typeof gapReport.healthy === 'boolean')

  const removed = await lessonRemove.execute({ source: 'trade_stats', id: added.entry.id })
  check('能删掉记错的经验', removed.ok === true, JSON.stringify(removed).slice(0, 160))
  const afterRemove = await lessonList.execute({})
  check('删除后读回为空', afterRemove.matched === 0, JSON.stringify(afterRemove).slice(0, 120))

  const wrongId = await lessonRemove.execute({ source: 'trade_stats', id: 'nope' })
  check('删不存在的 id 时返回可用 id 列表', wrongId.ok === false && Array.isArray(wrongId.available))
  const missingSource = await lessonRemove.execute({ id: 'nope' })
  check('删除时必须同时给 source 与 id', missingSource.ok === false)
}

// ── 手动录入：人直接编辑 lessons.json（与工具并列的另一条写入路径）──────────
if (lessonAdd && lessonList && lessonRemove) {
  const { LESSONS_FILE } = await import(new URL('../lib/home.js', import.meta.url))
  const { writeFileSync } = await import('node:fs')

  // 完全按"人手写"的样子：只给 title 与 body，没有 id / at / tags
  writeFileSync(LESSONS_FILE, `${JSON.stringify({
    trade_stats: [{ title: '手写的经验：只看 aggregateRecords', body: '我手敲进去的' }],
  }, null, 2)}\n`, 'utf8')

  const handListed = await lessonList.execute({ source: 'trade_stats' })
  check('手写条目能被读出', handListed.ok === true && handListed.matched === 1, JSON.stringify(handListed).slice(0, 160))
  const handId = handListed.groups[0]?.lessons[0]?.id
  check('没给 id 的手写条目会派生一个 id', typeof handId === 'string' && handId.length === 12, String(handId))
  const reread = await lessonList.execute({ source: 'trade_stats' })
  check('派生 id 稳定（重读不变）', reread.groups[0]?.lessons[0]?.id === handId)

  const handRemoved = await lessonRemove.execute({ source: 'trade_stats', id: handId })
  check('手写条目能被工具删掉（与工具写的条目等价）', handRemoved.ok === true, JSON.stringify(handRemoved).slice(0, 160))
  const emptyAfterHand = await lessonList.execute({})
  check('删完手写条目后经验库为空', emptyAfterHand.matched === 0, String(emptyAfterHand.matched))

  // 畸形手写条目只该被跳过并计数，不该让整个经验库读不出来
  writeFileSync(LESSONS_FILE, `${JSON.stringify({ trade_stats: [{ title: '好的' }, { title: 123 }, 'x'] }, null, 2)}\n`, 'utf8')
  const messy = await lessonList.execute({})
  check('畸形手写条目被跳过而不是报错', messy.ok === true && messy.matched === 1 && messy.broken === 2, `matched=${messy.matched} broken=${messy.broken}`)

  // 顶层不是对象时按空处理
  writeFileSync(LESSONS_FILE, '[]\n', 'utf8')
  const notObject = await lessonList.execute({})
  check('顶层形状不对时按空经验库处理', notObject.ok === true && notObject.total === 0 && notObject.broken === 1, `total=${notObject.total} broken=${notObject.broken}`)

  writeFileSync(LESSONS_FILE, '{}\n', 'utf8')
}

// ── 缓存寿命与响应头捕获（纯函数，不联网） ────────────────────────────────
const { isFresh, pickHeaders } = await import(new URL('../lib/http.js', import.meta.url))

const now = new Date().toISOString()
const old = new Date(Date.now() - 10 * 60_000).toISOString()
check('未声明 TTL 时缓存永不过期（保持旧行为）', isFresh(old, 0) === true && isFresh(old, undefined) === true)
check('TTL 内的缓存算新鲜', isFresh(now, 60_000) === true)
check('超过 TTL 的缓存算过期', isFresh(old, 60_000) === false)
check('声明了 TTL 但时间戳不可解析时判为过期', isFresh('unknown', 60_000) === false && isFresh(undefined, 60_000) === false)

const raw = { 'X-Requests-Remaining': '472', 'x-requests-used': '28', 'set-cookie': 'sid=abc' }
check('captureHeaders 按名带出，且大小写不敏感',
  pickHeaders(raw, ['x-requests-remaining', 'X-Requests-Used'])['x-requests-remaining'] === '472')
check('未点名的响应头一律不带出（set-cookie 不会漏）',
  !('set-cookie' in pickHeaders(raw, ['x-requests-remaining'])))
check('未声明 captureHeaders 时返回空对象', Object.keys(pickHeaders(raw, [])).length === 0)

// ── 清场：任何测试残留都要删干净 ─────────────────────────────────────────
const leftover = (await callRoute('GET', '/stash/credentials'))?.accounts ?? []
for (const account of leftover) {
  const dirty = account.id.startsWith('zz_') || account.fields.some((f) => f.ref.startsWith('ZZ_TEST'))
  if (dirty) await callRoute('DELETE', `/stash/credentials?id=${encodeURIComponent(account.id)}&force=1`, null)
}
const finalState = await callRoute('GET', '/stash/credentials')
check('测试条目已清理干净', !(finalState?.accounts ?? []).some((a) => a.id.startsWith('zz_') || a.fields.some((f) => f.ref.startsWith('ZZ_TEST'))))

console.log(results.join('\n'))
console.log(`\n结论：${results.every((r) => r.startsWith('✅')) ? '✅ 全部通过' : '❌ 有失败项'}`)
