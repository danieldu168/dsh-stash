// 多机迁移（导出 / 导入 / 清空）测试 —— 全程跑在临时 DSH_HOME 下，不读不写真实 ~/.dsh。
//
// 用法：node test/portability.mjs
//
// 这里锁的是 `DESIGN-portability.md` 里那几条**语义**，而不是实现细节：
//   · 值覆盖、积累并集（对集合用覆盖就是删数据）
//   · 去重键不能用含时间戳的 id
//   · 三类冲突都报出来且**保留本机**，不自动决定
//   · 值的落点按每个字段自己的 inject 分流
//   · 清空的前置铁律，以及"清单外的引用名一律不动"
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-stash-port-'))
process.env.DSH_HOME = TEST_HOME
const LIB = join(TEST_HOME, 'stash')
mkdirSync(LIB, { recursive: true })
process.on('exit', () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true })
  } catch {
    // 临时目录留在 temp 里也无妨。
  }
})

const results = []
const check = (label, ok, detail = '') => results.push(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`)

const port = await import(new URL('../lib/portability.js', import.meta.url))

// ── 夹具 ─────────────────────────────────────────────────────────────────
const write = (rel, text) => {
  const path = join(LIB, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}
const read = (rel) => {
  const path = join(LIB, rel)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/** 内存版凭据服务：只实现 portability 用到的那几个方法。 */
function fakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  const calls = []
  return {
    store,
    calls,
    async resolve(ref) {
      calls.push(['resolve', ref])
      return store.has(ref) ? { value: store.get(ref) } : undefined
    },
    async set(ref, value) {
      calls.push(['set', ref])
      store.set(ref, value)
    },
    async unset(ref) {
      calls.push(['unset', ref])
      store.delete(ref)
    },
    async describe(ref) {
      return { configured: store.has(ref), writable: true }
    },
  }
}

const ACCOUNT = {
  id: 'svc',
  label: '某服务',
  category: 'api',
  url: 'https://example.com/tokens',
  fields: [
    { ref: 'SVC_KEY', label: 'API Key', secret: true, inject: 'header:apikey', multiline: false, notes: '在 example.com/tokens 生成' },
    { ref: 'SVC_ENV', label: 'Env 落点', secret: true, inject: 'env:SVC_ENV', multiline: false, notes: null },
  ],
}

// ── 一、纯合并器 ─────────────────────────────────────────────────────────
{
  const merged = port.mergeLessons(
    { lib_a: [{ title: '坑一', body: 'x' }] },
    { lib_a: [{ title: '坑二', body: 'y' }], lib_b: [{ title: '坑三', body: 'z' }] },
  )
  check(
    '经验并集：两侧都留',
    Object.keys(merged.merged).length === 2 && merged.merged.lib_a.length === 2 && merged.merged.lib_b.length === 1,
    JSON.stringify(Object.keys(merged.merged)),
  )
  check('经验并集：新增计数', merged.added.length === 2 && merged.duplicated === 0)

  const same = { title: '坑一', body: 'x', action: null, tags: [], evidence: null }
  const dedupe = port.mergeLessons(
    { lib_a: [{ ...same, id: 'aaaaaaaaaaaa', at: '2026-01-01T00:00:00.000Z' }] },
    { lib_a: [{ ...same, id: 'bbbbbbbbbbbb', at: '2026-02-02T00:00:00.000Z' }] },
  )
  check(
    '经验去重按 (来源库, title)，不按含时间戳的 id',
    dedupe.merged.lib_a.length === 1 && dedupe.duplicated === 1 && dedupe.conflicts.length === 0,
    `len=${dedupe.merged.lib_a.length} dup=${dedupe.duplicated}`,
  )

  const conflict = port.mergeLessons(
    { lib_a: [{ title: '坑一', body: '本机版' }] },
    { lib_a: [{ title: '坑一', body: '包里的版本' }] },
  )
  check('经验同标题不同正文：报冲突', conflict.conflicts.length === 1)
  check('经验冲突保留本机版本，不自动覆盖', conflict.merged.lib_a[0].body === '本机版')
}

{
  const byId = port.mergeById([{ id: 's1', name: '本机' }], [{ id: 's1', name: '包' }, { id: 's2', name: '新增' }], 'source')
  check('库条目并集：新 id 加入', byId.merged.length === 2 && byId.added.length === 1)
  check('库条目同 id 不同定义：报冲突且保留本机', byId.conflicts.length === 1 && byId.merged.find((e) => e.id === 's1').name === '本机')

  const order = port.mergeById([{ id: 's1', a: 1, b: 2 }], [{ b: 2, a: 1, id: 's1' }], 'source')
  check('键序不同不算冲突（稳定序列化）', order.conflicts.length === 0 && order.duplicated === 1)
}

{
  const text = port.mergeLedgerText('{"a":1}\n', '{"a":1}\n{"b":2}\n')
  check('台账只拼接不去重（重复也是事实）', text.text.trim().split('\n').length === 3, String(text.text.trim().split('\n').length))

  const many = `${Array.from({ length: 1500 }, (_, i) => JSON.stringify({ i })).join('\n')}\n`
  const big = port.mergeLedgerText(many, many)
  check('台账合并超上限时按 2000/1000 规则裁剪', big.trimmed > 0 && big.total === 1000, `trimmed=${big.trimmed} total=${big.total}`)
}

{
  const base = '# 注释\nFOO=1\nBAR=2\n'
  const up = port.upsertEnvValues(base, [['BAR', '9'], ['NEW', 'x']])
  check(
    'env 写入：替换已有键、追加新键、保留注释与其他行',
    up.text.includes('# 注释') && up.text.includes('BAR=9') && up.text.includes('NEW=x')
      && !up.text.includes('BAR=2') && up.text.includes('FOO=1'),
  )
  const rm = port.removeEnvKeys(up.text, ['FOO'])
  check('env 按名删行：只删指定键', !rm.text.includes('FOO=') && rm.text.includes('BAR=9') && rm.removed.length === 1)
}

// ── 二、导出 ─────────────────────────────────────────────────────────────
write('sources.local.json', json({
  sources: [{ id: 'lib_home', name: 'A 机的库', kind: 'files', paths: ['D:/x'] }],
  accounts: [ACCOUNT],
}))
write('lessons.json', json({ lib_home: [{ id: 'aaaaaaaaaaaa', at: '2026-01-01T00:00:00.000Z', title: '本机的坑', body: 'A 版' }] }))
write('ledger.ndjson', '{"source":"lib_home","ok":true}\n')
write('corpus/note.txt', 'hello')

const credA = fakeCredentials({ SVC_KEY: 'secret-value', SVC_ENV: 'env-value' })
const plainDir = join(TEST_HOME, 'export-plain')
const plain = await port.exportStash({ outDir: plainDir, getCredentials: () => credA, now: '2026-09-25T00:00:00.000Z' })

check('导出成功', plain.ok === true, JSON.stringify(plain).slice(0, 160))
check('导出默认不产出 values.json', !existsSync(join(plainDir, 'values.json')))
check('导出产出 manifest 与办理指南', existsSync(join(plainDir, 'manifest.json')) && existsSync(join(plainDir, 'credentials-guide.md')))
check('导出返回 8 位校验码', typeof plain.verifyCode === 'string' && plain.verifyCode.length === 8, String(plain.verifyCode))
check('不带 --corpus 时包里没有 corpus', !existsSync(join(plainDir, 'corpus')))
check('manifest 校验通过', port.verifyBundle(plainDir).ok === true)

// ── 格式规格：README「导出包的格式」一节逐条锁住，免得文档与代码走散 ──────
const mf = JSON.parse(readFileSync(join(plainDir, 'manifest.json'), 'utf8'))
check('识别标记：kind = dsh-stash-export', mf.kind === 'dsh-stash-export', String(mf.kind))
check('格式版本：format = 1（旧版本遇到未知版本要明确拒绝，而不是误读）', mf.format === port.EXPORT_FORMAT && mf.format === 1, String(mf.format))
check(
  '每个文件都进校验清单，且带 path / bytes / sha256',
  Array.isArray(mf.files) && mf.files.length > 0
    && mf.files.every((f) => typeof f.path === 'string' && Number.isFinite(f.bytes) && /^[0-9a-f]{64}$/.test(f.sha256)),
  JSON.stringify(mf.files?.map((f) => f.path)),
)
// 校验清单必须**覆盖包内每个会被导入读取的文件**，不能只列一部分。
check(
  '清单覆盖了实际存在的载荷文件（sources.mjs 在本测试环境里不存在，故不在）',
  ['sources.local.json', 'ledger.ndjson', 'lessons.json'].every((name) => mf.files.some((f) => f.path === name)),
  JSON.stringify(mf.files?.map((f) => f.path)),
)
check('清单里的路径都是包内相对路径（所以整包可以随便改名、移动、压缩传输）', mf.files.every((f) => !/[\\/]/.test(f.path) || !f.path.startsWith('/')))
check('refs 只有引用名与落点，**没有值**', Array.isArray(mf.refs) && mf.refs.every((r) => typeof r.ref === 'string' && !('value' in r)))
check(
  '校验码由文件哈希、引用名与两个开关算出——改了任何文件就会变',
  typeof mf.verifyCode === 'string' && mf.verifyCode === plain.verifyCode && mf.verifyCode.length === 8,
)

const guide = readFileSync(join(plainDir, 'credentials-guide.md'), 'utf8')
check(
  '办理指南带出引用名与各自落点',
  guide.includes('SVC_KEY') && guide.includes('header:apikey') && guide.includes('env:SVC_ENV'),
)
check('办理指南带出来源提示（换机器不必凭记忆）', guide.includes('example.com/tokens'))
check('不带值的指南不出现"带了值"的警告', !guide.includes('本次导出**带了值**'))

// ── 三、导入：多机并存，值覆盖 / 积累并集 ────────────────────────────────
// 把本机改成"另一台机器"的状态：有同名库的不同定义、自己的经验、自己的台账。
function seedMachineB() {
  write('sources.local.json', json({
    sources: [
      { id: 'lib_home', name: 'B 机的同名库', kind: 'files', paths: ['E:/y'] },
      { id: 'lib_b', name: 'B 独有', kind: 'files', paths: ['E:/z'] },
    ],
    accounts: [{ id: 'svc_b', label: 'B 账号', category: 'api', url: null, fields: [{ ref: 'B_KEY', label: 'B Key', secret: true, inject: 'header:x', multiline: false, notes: null }] }],
  }))
  write('lessons.json', json({
    lib_home: [{ id: 'cccccccccccc', at: '2026-03-03T00:00:00.000Z', title: '本机的坑', body: 'B 版' }],
    lib_b: [{ id: 'dddddddddddd', at: '2026-03-04T00:00:00.000Z', title: 'B 的坑', body: 'b' }],
  }))
  write('ledger.ndjson', '{"source":"lib_b","ok":true}\n')
}
seedMachineB()

const credB = fakeCredentials({ B_KEY: 'b-value' })
const imported = await port.importStash({ dir: plainDir, getCredentials: () => credB })
check('导入成功', imported.ok === true, JSON.stringify(imported).slice(0, 200))

const shardAfter = JSON.parse(read('sources.local.json'))
const lessonsAfter = JSON.parse(read('lessons.json'))
check(
  '导入：库条目是并集（本机同名库保留 + B 独有 + 包里的）',
  shardAfter.sources.length === 2 && shardAfter.sources.some((s) => s.id === 'lib_b'),
  shardAfter.sources.map((s) => s.id).join(','),
)
check(
  '导入：同名库冲突保留本机定义',
  shardAfter.sources.find((s) => s.id === 'lib_home').name === 'B 机的同名库',
)
check(
  '导入：钥匙账号是并集（不覆盖本机账号）',
  shardAfter.accounts.length === 2 && shardAfter.accounts.some((a) => a.id === 'svc_b') && shardAfter.accounts.some((a) => a.id === 'svc'),
  shardAfter.accounts.map((a) => a.id).join(','),
)
check(
  '导入：经验并集，本机同标题的正文不被覆盖',
  lessonsAfter.lib_home.length === 1 && lessonsAfter.lib_home[0].body === 'B 版' && lessonsAfter.lib_b.length === 1,
)
check('导入：台账只拼接', (read('ledger.ndjson') ?? '').trim().split('\n').length === 2)
check(
  '三类冲突都被报出且保留本机',
  imported.conflicts.some((c) => c.kind === 'lesson') && imported.conflicts.some((c) => c.kind !== 'lesson'),
  imported.conflicts.map((c) => c.kind).join(','),
)
check('导入对账单给出校验码（清空时要用）', imported.verifyCode === plain.verifyCode)
check('不带值的包不写任何值', imported.summary.values.length === 0 && credB.store.size === 1)

// 幂等：再导一次，集合不变
const again = await port.importStash({ dir: plainDir, getCredentials: () => credB })
const shardAgain = JSON.parse(read('sources.local.json'))
check(
  '重复导入幂等：库与账号不再增长',
  again.ok === true && shardAgain.sources.length === 2 && shardAgain.accounts.length === 2,
  JSON.stringify(again.summary.sources),
)
check(
  '重复导入：经验不增长（同标题冲突保留本机，不会越导越多）',
  again.summary.lessons.added === 0 && JSON.parse(read('lessons.json')).lib_home.length === 1,
  JSON.stringify(again.summary.lessons),
)

// ── 四、导入：包的完整性是硬门禁，不通过就绝不动本机 ──────────────────────
const tamperedDir = join(TEST_HOME, 'export-tampered')
mkdirSync(tamperedDir, { recursive: true })
for (const name of ['manifest.json', 'sources.local.json', 'lessons.json', 'ledger.ndjson', 'credentials-guide.md']) {
  writeFileSync(join(tamperedDir, name), readFileSync(join(plainDir, name), 'utf8'))
}
writeFileSync(join(tamperedDir, 'lessons.json'), json({ lib_home: [{ title: '被改过的', body: 'x' }] }), 'utf8')

const beforeTamper = read('sources.local.json')
const tampered = await port.importStash({ dir: tamperedDir, getCredentials: () => credB })
check('包被改过：导入被拒', tampered.ok === false && tampered.kind === 'verify', tampered.error)
check('包被改过：本机文件一字未动', read('sources.local.json') === beforeTamper)

// ── 五、导入：dry-run 不动任何文件 ───────────────────────────────────────
const beforeDry = read('lessons.json')
const dry = await port.importStash({ dir: plainDir, getCredentials: () => credB, dryRun: true })
check('dry-run 返回计划且标记未改动', dry.ok === true && dry.dryRun === true)
check('dry-run 不动本机文件', read('lessons.json') === beforeDry)

// ── 六、值的落点：env → .env（并要重启），其余 → 凭据服务 ─────────────────
const valueDir = join(TEST_HOME, 'export-values')
const withValues = await port.exportStash({ outDir: valueDir, withValues: true, getCredentials: () => credA, now: '2026-09-25T01:00:00.000Z' })
check('带值导出成功且写明带了值', withValues.ok === true && withValues.valueCount === 2, JSON.stringify(withValues.valueProblems))
check('带值导出产出 values.json', existsSync(join(valueDir, 'values.json')))
// values.json 的形状照 README「导出包的格式」锁住：它有**自己的** kind 与 format，
// 所以单看一个文件也能认出它是什么。
const valPack = JSON.parse(readFileSync(join(valueDir, 'values.json'), 'utf8'))
check(
  'values.json 有自己的 kind 与 format（单看一个文件也认得出）',
  valPack.kind === 'dsh-stash-values' && valPack.format === 1 && typeof valPack.values === 'object',
  JSON.stringify(Object.keys(valPack)),
)
check('values.json 里的键是引用名，值就是明文', valPack.values?.SVC_KEY === 'secret-value')
const valuesGuide = readFileSync(join(valueDir, 'credentials-guide.md'), 'utf8')
check('带值的指南给出明文警告', valuesGuide.includes('本次导出**带了值**'))

// 模拟一台干净的新机器：没有账号、.env 里有无关的键
write('sources.local.json', json({ sources: [], accounts: [] }))
writeFileSync(join(TEST_HOME, '.env'), '# 宿主环境层\nOTHER_KEY=keep-me\n', 'utf8')

const credNew = fakeCredentials({})
const valueImport = await port.importStash({ dir: valueDir, getCredentials: () => credNew })
check('带值导入成功', valueImport.ok === true, JSON.stringify(valueImport).slice(0, 200))
check(
  '值按 inject 分流：header 落点进凭据服务',
  credNew.store.get('SVC_KEY') === 'secret-value'
    && valueImport.summary.values.some((v) => v.ref === 'SVC_KEY' && v.target === 'credentials' && v.result === 'written'),
  JSON.stringify(valueImport.summary.values),
)
const envAfter = readFileSync(join(TEST_HOME, '.env'), 'utf8')
check(
  '值按 inject 分流：env 落点写进 .env',
  envAfter.includes('SVC_ENV=env-value') && valueImport.summary.values.some((v) => v.ref === 'SVC_ENV' && v.target === 'env:SVC_ENV'),
  envAfter.replace(/\n/g, ' | '),
)
check('.env 里无关的键与注释原样保留', envAfter.includes('OTHER_KEY=keep-me') && envAfter.includes('# 宿主环境层'))
// 这条是本次修的 bug：env 落点原先只写 .env，不写凭据服务 —— 重启前面板会误报"未配置"，
// 而面板贴值的路径是两处都写。两条路必须落到同样的状态。
check(
  'env 落点的值**两处都写**（凭据服务 + .env），与面板贴值一致',
  credNew.store.get('SVC_ENV') === 'env-value',
  `凭据服务里的 SVC_ENV = ${JSON.stringify(credNew.store.get('SVC_ENV'))}`,
)
check('env 落点要求重启', valueImport.restartRequired.includes('SVC_ENV'))
check('对账单渲染提到必须重启', port.renderImport(valueImport).includes('必须重启'))

// ── 六之二、语料也进校验清单 ──────────────────────────────────────────────
const corpusDir = join(TEST_HOME, 'export-corpus')
const withCorpus = await port.exportStash({ outDir: corpusDir, includeCorpus: true, getCredentials: () => credA })
const corpusManifest = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8'))
check(
  '带语料导出的包把语料也写进校验清单',
  withCorpus.ok === true && corpusManifest.files.some((f) => f.path === 'corpus/note.txt' && f.sha256),
  `corpusFiles=${withCorpus.corpusFiles}`,
)
writeFileSync(join(corpusDir, 'corpus', 'note.txt'), 'tampered', 'utf8')
check('包内语料被改过：校验不通过（语料不是暗门）', port.verifyBundle(corpusDir).ok === false)

// ── 七、清空：前置铁律 + 清单外引用名一律不动 ────────────────────────────
const code = valueImport.verifyCode
const plan = await port.planWipe({})
check('清空计划列出将删条目', plan.targets.includes('sources.local.json') && plan.targets.includes('lessons.json'))
check('清空计划默认不含 corpus', !plan.targets.includes('corpus'))
check('清空计划把不认识的条目列为不动', Array.isArray(plan.untouched))

const wrongCode = await port.wipeStash({ confirm: 'deadbeef', getCredentials: () => credNew })
check('确认码不对：拒绝执行', wrongCode.ok === false && wrongCode.kind === 'unconfirmed', wrongCode.error)

// 清单外的一把钥匙（不属于任何 stash 账号）必须活着
credNew.store.set('FOREIGN_KEY', 'not-ours')
const noConfirmPlan = await port.planWipe({})
check('清空清单只含 stash 认得的引用名', noConfirmPlan.refs.includes('SVC_KEY') && !noConfirmPlan.refs.includes('FOREIGN_KEY'), noConfirmPlan.refs.join(','))

// 再塞一个"名字与引用名同名、但台账没记 env 落点"的键——它也该被清掉
writeFileSync(join(TEST_HOME, '.env'), `${readFileSync(join(TEST_HOME, '.env'), 'utf8')}B_KEY=legacy-in-env\n`, 'utf8')

const wiped = await port.wipeStash({ confirm: code, getCredentials: () => credNew })
check('确认码正确：清空执行', wiped.ok === true, JSON.stringify(wiped).slice(0, 200))
check(
  '清空删掉 stash 目录里的 stash 文件',
  !existsSync(join(LIB, 'sources.local.json')) && !existsSync(join(LIB, 'lessons.json')) && !existsSync(join(LIB, 'ledger.ndjson')),
)
check('清空默认保留 corpus', existsSync(join(LIB, 'corpus', 'note.txt')))
check('清空按名删除凭据值', !credNew.store.has('SVC_KEY') && wiped.values.some((v) => v.ref === 'SVC_KEY' && v.result === 'removed'))
check('清空不动清单外的引用名', credNew.store.get('FOREIGN_KEY') === 'not-ours')
check('清空移除 .env 里 stash 写过的键', !readFileSync(join(TEST_HOME, '.env'), 'utf8').includes('SVC_ENV='), readFileSync(join(TEST_HOME, '.env'), 'utf8').replace(/\n/g, ' | '))
check(
  '清空也删掉「名字与引用名同名」的 .env 键（台账没记 env 落点也会被找到）',
  !readFileSync(join(TEST_HOME, '.env'), 'utf8').includes('B_KEY='),
  readFileSync(join(TEST_HOME, '.env'), 'utf8').replace(/\n/g, ' | '),
)
check('清空仍保留 .env 里无关的键', readFileSync(join(TEST_HOME, '.env'), 'utf8').includes('OTHER_KEY=keep-me'))

// 没有导出记录时，清空必须拒绝
rmSync(join(LIB, '.last-export.json'), { force: true })
const noExport = await port.wipeStash({ confirm: code, getCredentials: () => credNew })
check('没有导出记录：清空被拒（顺序铁律）', noExport.ok === false && noExport.kind === 'no-export', noExport.error)

// ── 八、命令层 ───────────────────────────────────────────────────────────
const { registerStashCommand } = await import(new URL('../lib/command.js', import.meta.url))
const captured = {}
const registered = []
const hostCtx = { commands: { register: (definition) => { captured.definition = definition; return () => {} } } }
const catalogTool = {
  execute: async () => ({ ok: true, sources: [] }),
  output: { render: () => [{ text: '📚 文库清单' }] },
}
registerStashCommand(hostCtx, {
  catalogTool,
  getCredentials: () => credA,
  disposers: registered,
  warn: () => {},
})
check('/stash 命令已注册', captured.definition?.name === 'stash')

const list = await captured.definition.handler({ rawInput: '' })
check('/stash 无参仍然是列清单', list.kind === 'success' && list.text.includes('文库清单'))
const one = await captured.definition.handler({ rawInput: 'some_library_id' })
check('/stash <id> 仍然按库 id 走', one.kind === 'success')
const usage = await captured.definition.handler({ rawInput: 'help' })
check('/stash help 给用法', usage.text.includes('export') && usage.text.includes('wipe'))

const spacedDir = join(TEST_HOME, 'dir with spaces')
const cmdExport = await captured.definition.handler({ rawInput: `export --out "${spacedDir}"` })
check('导出命令支持带空格的目录（双引号）', cmdExport.kind === 'success' && existsSync(join(spacedDir, 'manifest.json')), cmdExport.text.slice(0, 120))

const cmdNoConfirm = await captured.definition.handler({ rawInput: 'wipe' })
check('wipe 不带确认码时只给计划，不执行', cmdNoConfirm.kind === 'error' && cmdNoConfirm.text.includes('确认码'), cmdNoConfirm.text.slice(0, 160))

const cmdImportBad = await captured.definition.handler({ rawInput: 'import' })
check('import 缺目录时给用法', cmdImportBad.kind === 'error' && cmdImportBad.text.includes('用法'))

// ── 九、catalog 暴露注入点 ───────────────────────────────────────────────
// 值不能出现在这里，但「值该放哪」必须出现：它决定这把钥匙写 $DSH_HOME/.env 还是写面板，
// 而这正是「面板一片绿、功能却是断的」那类故障的分界线。
write('sources.local.json', json({
  sources: [
    {
      id: 'lib_env',
      name: '需要 env 落点的库',
      kind: 'remote',
      handler: 'http',
      access: 'official-api',
      credentials: ['SVC_ENV'],
      actions: { search: '查' },
      request: {
        url: 'https://example.com/a',
        query: { q: '{q}' },
        headers: { 'X-K': '{credential:SVC_ENV}' },
        required: ['q'],
      },
    },
    {
      id: 'lib_blocked',
      name: '只能人工导出的库',
      kind: 'remote',
      handler: 'http',
      access: 'export-import',
      request: { url: 'https://example.com/b' },
    },
  ],
  accounts: [{
    id: 'svc2',
    label: '某服务',
    category: 'api',
    url: null,
    fields: [{ ref: 'SVC_ENV', label: 'Env', secret: true, inject: 'env:SVC_ENV', multiline: false, notes: null }],
  }],
}))
// 台账：让 catalog 的「以前通不通」有据可依
write('ledger.ndjson',
  '{"source":"lib_env","ok":true,"at":"2026-09-25T02:00:00.000Z"}\n'
  + '{"source":"lib_env","ok":false,"at":"2026-09-25T03:00:00.000Z","error":"HTTP 400 @ https://example.com/a"}\n')
const { buildTools } = await import(new URL('../lib/tools.js', import.meta.url))
const catalog = buildTools({ getCredentials: () => fakeCredentials({ SVC_ENV: 'real-secret' }), logger: { warn: () => {} } })
  .find((tool) => tool.name === 'stash_catalog')
const catalogValue = await catalog.execute({ id: 'lib_env' })
const credentialEntry = catalogValue.sources?.[0]?.credentials?.[0]
check(
  'catalog 的凭据条目带出 inject 落点',
  credentialEntry?.ref === 'SVC_ENV' && credentialEntry?.inject === 'env:SVC_ENV',
  JSON.stringify(credentialEntry),
)
const catalogText = catalog.output.render({ id: 'lib_env' }, catalogValue).map((block) => block.text).join('\n')
check(
  'catalog 渲染写明落点，并点明 env 落点要写 .env',
  catalogText.includes('落点') && catalogText.includes('env:SVC_ENV') && catalogText.includes('.env'),
  catalogText.split('\n').find((line) => line.includes('凭据')) ?? '',
)
check('catalog 只报落点与状态，绝不出现值', !catalogText.includes('real-secret'))

// ── 九之二、catalog 要让人「一次定案」 ───────────────────────────────────
// 决定要不要用一条库，靠三件事：能不能用、要带什么参数、以前通不通。
const entryReady = catalogValue.sources?.find((item) => item.id === 'lib_env')
check(
  'catalog 带出必填参数（省掉发出去等 400）',
  Array.isArray(entryReady?.requiredParams) && entryReady.requiredParams[0] === 'q',
  JSON.stringify(entryReady?.requiredParams),
)
check('catalog 标记就绪状态', entryReady?.ready === true && (entryReady?.blockers ?? []).length === 0, JSON.stringify(entryReady?.blockers))
check(
  'catalog 带出按库台账汇总（调过几次、失败几次、最近什么时候）',
  entryReady?.usage?.calls === 2 && entryReady?.usage?.failures === 1 && typeof entryReady?.usage?.lastAt === 'string',
  JSON.stringify(entryReady?.usage),
)
const blockedEntry = (await catalog.execute({ id: 'lib_blocked' })).sources?.[0]
check(
  'catalog 对越界的库给出不可用原因',
  blockedEntry?.ready === false && (blockedEntry?.blockers ?? []).some((item) => item.includes('人工导出')),
  JSON.stringify(blockedEntry?.blockers),
)
check(
  'catalog 渲染写明必填参数与就绪状态',
  catalogText.includes('必填参数：q') && catalogText.includes('✅ 就绪'),
  catalogText.split('\n').filter((line) => line.includes('必填参数') || line.includes('就绪')).join(' | '),
)
const blockedText = catalog.output.render({ id: 'lib_blocked' }, await catalog.execute({ id: 'lib_blocked' })).map((block) => block.text).join('\n')
check('catalog 渲染越界库时写明原因', blockedText.includes('⛔') && blockedText.includes('人工导出'), blockedText.split('\n').find((line) => line.includes('⛔')) ?? '')

console.log(results.join('\n'))
console.log(`\n结论：${results.every((r) => r.startsWith('✅')) ? '✅ 全部通过' : '❌ 有失败项'}`)
