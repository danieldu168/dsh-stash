// host 半边装配测试 —— 专门复现"服务稍后就绪"的竞态，外加台账 v0.5 的账号/字段模型。
//
// 为什么需要它：0.3.2 的路由注册用了 `ctx.get('webServer')`，在 apply 时服务还没就绪，
// 拿到 undefined 就静默跳过注册。表现为：工具正常、客户端页面正常渲染、
// 但凭据端点 HTTP 404（空 body）。本测试里 `ctx.get` 一律返回 undefined，
// 只有 `ctx.inject` 的回调能拿到服务 —— 旧写法必然失败，新写法必然通过。
//
// 用法：node test/host-assembly.mjs
const results = []
const check = (label, ok, detail = '') => results.push(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`)

const mod = await import(new URL('../lib/index.js', import.meta.url))

const tools = []
const registered = { route: null, command: null }
const warns = []
const injected = []

const ctx = {
  logger: { warn: (m) => warns.push(m), info: () => {} },
  // 关键：一律拿不到 —— 这正是旧代码失败的场景
  get: () => undefined,
  inject: (deps, callback) => {
    injected.push(...deps)
    for (const dep of deps) {
      if (dep === 'webServer') callback({ webServer: { register: (r) => { registered.route = r; return () => {} } } })
      if (dep === 'commands') callback({ commands: { register: (d) => { registered.command = d; return () => {} } } })
    }
    return () => {}
  },
  tools: { register: (d) => { tools.push(d); return () => {} } },
  on: () => {},
}

check('插件导出契约', mod.name === 'dsh-stash' && Array.isArray(mod.inject) && typeof mod.apply === 'function')

try {
  mod.apply(ctx)
  check('apply 不抛', true)
} catch (error) {
  check('apply 不抛', false, error.message)
}

check('声明了 ctx.inject 依赖', injected.includes('webServer') && injected.includes('commands'), injected.join(', '))
check('注册 7 个工具', tools.length === 7, tools.map((t) => t.name).join(', '))
check('凭据路由已注册（经 ctx.inject）', registered.route?.path === '/stash/credentials', registered.route ? `${registered.route.kind} ${registered.route.path}` : '未注册')
check('/stash 命令已注册（经 ctx.inject）', registered.command?.name === 'stash', registered.command?.name ?? '未注册')
check('无启动告警', warns.length === 0, warns.join(' | '))

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
  await registered.route.handler(makeReq(method, url, body), { writeHead: () => {}, end: (b) => { raw = b } })
  return raw
}
const callRoute = async (method, url, body) => {
  try { return JSON.parse(await callRaw(method, url, body)) } catch { return null }
}
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
  check('/stash 输出含 4 个库', ['trade_stats', 'policy_alerts', 'corpus', 'cases'].every((id) => result.text.includes(id)))
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
  const report = await doctor.execute()
  check('体检 healthy', report.healthy === true, JSON.stringify(report.problems))
  check('体检报告含台账统计', Boolean(report.ledger) && report.ledger.accounts >= 1 && report.ledger.fields >= 1, JSON.stringify(report.ledger))
  check('体检 render 含台账行', doctor.output.render({}, report).map((b) => b.text).join('\n').includes('钥匙台账'))
}

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
