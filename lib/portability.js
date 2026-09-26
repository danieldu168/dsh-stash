/**
 * 多机迁移：导出 / 导入 / 清空。
 *
 * 为什么单独一个模块：这三件事共享同一套**合并语义**与**落点规则**，
 * 而它们都不该出现在 Model Tool 里——值的搬运不能经过模型
 * （见 `DESIGN-portability.md` 第三节）。所以入口是 `/stash export|import|wipe`。
 *
 * 三条不变量：
 *   1. 值的落点由每个字段自己的 `inject` 决定：`env:NAME` 写 `$DSH_HOME/.env`，
 *      其余走凭据服务。写错落点就会重现"面板一片绿、功能却是断的"。
 *   2. 导入是**值覆盖、积累并集**。值和积累是两种语义：前者单值，后者是集合；
 *      对集合用覆盖等于删数据。
 *   3. 清空必须先有一次成功的导入验证。删除不可逆，而"导出件丢了"比"本机残留"现实得多。
 *
 * @module dsh-stash/portability
 */
import { createHash } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CORPUS_DIR, DSH_HOME, LEDGER_FILE, LESSONS_FILE, LIB_HOME, SOURCES_FILE,
  SOURCES_LOCAL_FILE, ensureLibDirs,
} from './home.js'
import { readLocalShard, writeLocalShard } from './shard.js'
import { loadVault } from './vault.js'
import { loadRegistry } from './registry.js'

export const EXPORT_FORMAT = 1
export const MANIFEST_NAME = 'manifest.json'
export const GUIDE_NAME = 'credentials-guide.md'
export const VALUES_NAME = 'values.json'
/** 最近几次导出的记录（保留 5 次）。清空要求输入其中一枚校验码——那是"别处导入成功"的凭据。 */
export const LAST_EXPORT_FILE = join(LIB_HOME, '.last-export.json')

/** 与 ledger.js 保持一致的裁剪规则，避免导入把台账撑成无界文件。 */
const LEDGER_MAX_RECORDS = 2000
const LEDGER_KEEP_RECORDS = 1000

/** 会被导出的载荷（包内相对名 → 本机绝对路径）。 */
const PAYLOAD_FILES = [
  { name: 'sources.mjs', abs: SOURCES_FILE },
  { name: 'sources.local.json', abs: SOURCES_LOCAL_FILE },
  { name: 'ledger.ndjson', abs: LEDGER_FILE },
  { name: 'lessons.json', abs: LESSONS_FILE },
]

/** 清空时认得的条目。列在 `untouched` 里的东西**不删**——它们不是 stash 写的东西。 */
const KNOWN_ENTRIES = new Set([
  'sources.mjs', 'sources.local.json', 'ledger.ndjson', 'lessons.json',
  'cache', 'corpus', 'backup', '.last-export.json',
])

// ── 通用工具 ──────────────────────────────────────────────────────────────

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** 稳定序列化：键排序，避免"键顺序不同"被误判成冲突。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

/**
 * 流式哈希。语料可能是几百 MB 的数据库导出件，整份读进内存会炸，
 * 所以按 1 MiB 分块喂给 hash。
 */
export function hashFile(path) {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1 << 20)
    let bytes = readSync(fd, buffer, 0, buffer.length, null)
    while (bytes > 0) {
      hash.update(buffer.subarray(0, bytes))
      bytes = readSync(fd, buffer, 0, buffer.length, null)
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** 列出目录下所有文件（相对路径，正斜杠）。 */
function listFiles(dir, prefix = '') {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** 校验清单里的一条：包内相对路径 + 字节数 + 哈希。 */
function manifestEntry(root, rel) {
  const abs = join(root, ...rel.split('/'))
  return { path: rel, bytes: statSync(abs).size, sha256: hashFile(abs) }
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const fail = (kind, error, extra = {}) => ({ ok: false, kind, error, ...extra })

// ── 合并器（纯函数，测试直接打这些）──────────────────────────────────────

/** 同一条经验的内容是否相同（id / at 不参与——跨机必然不同，比了会全是冲突）。 */
function sameLessonContent(a, b) {
  const pick = (entry) => stableStringify({
    body: entry.body ?? '',
    action: entry.action ?? null,
    tags: entry.tags ?? [],
    evidence: entry.evidence ?? null,
  })
  return pick(a) === pick(b)
}

/**
 * 经验库合并：并集 + 按 (来源库, title) 去重。
 *
 * 去重键**不能用 id**：id 含时间戳（`lessons.js` 的 `sha256(at|source|title)`），
 * 同一件事在两台机器上各记一次，id 必然不同。
 */
export function mergeLessons(currentGroups = {}, incomingGroups = {}) {
  const merged = {}
  const added = []
  let duplicated = 0
  const conflicts = []
  const sources = [...new Set([...Object.keys(currentGroups), ...Object.keys(incomingGroups)])].sort()

  for (const sourceId of sources) {
    const byKey = new Map()
    const out = []
    for (const entry of currentGroups[sourceId] ?? []) {
      const key = String(entry.title ?? '').trim().toLowerCase()
      byKey.set(key, entry)
      out.push(entry)
    }
    for (const entry of incomingGroups[sourceId] ?? []) {
      const key = String(entry.title ?? '').trim().toLowerCase()
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, entry)
        out.push(entry)
        added.push({ source: sourceId, title: entry.title })
        continue
      }
      if (sameLessonContent(existing, entry)) {
        duplicated += 1
        continue
      }
      // 同标题不同正文：保留现有，报冲突，由人决定——不自动覆盖
      conflicts.push({ kind: 'lesson', source: sourceId, title: entry.title, kept: existing, incoming: entry })
    }
    if (out.length > 0) merged[sourceId] = out
  }
  return { merged, added, duplicated, conflicts }
}

/** 按 id 做并集：新的加入，同 id 同内容跳过，同 id 不同内容记为冲突（保留现有）。 */
export function mergeById(currentList = [], incomingList = [], label = 'entry') {
  const out = [...currentList]
  const byId = new Map(out.map((entry) => [entry?.id, entry]))
  const added = []
  let duplicated = 0
  const conflicts = []

  for (const entry of incomingList) {
    const id = entry?.id
    const existing = id === undefined ? undefined : byId.get(id)
    if (existing === undefined) {
      out.push(entry)
      if (id !== undefined) byId.set(id, entry)
      added.push(id ?? entry)
      continue
    }
    if (stableStringify(existing) === stableStringify(entry)) {
      duplicated += 1
      continue
    }
    conflicts.push({ kind: label, id, kept: existing, incoming: entry })
  }
  return { merged: out, added, duplicated, conflicts }
}

/** 台账合并：**只拼接、不去重**。 */
export function mergeLedgerText(currentText = '', incomingText = '') {
  const lines = (text) => String(text ?? '').split(/\r?\n/).filter((line) => line.trim().length > 0)
  const current = lines(currentText)
  const incoming = lines(incomingText)
  let all = [...current, ...incoming]
  let trimmed = 0
  if (all.length >= LEDGER_MAX_RECORDS) {
    trimmed = all.length - LEDGER_KEEP_RECORDS
    all = all.slice(-LEDGER_KEEP_RECORDS)
  }
  return {
    text: all.length > 0 ? `${all.join('\n')}\n` : '',
    incoming: incoming.length,
    current: current.length,
    total: all.length,
    trimmed,
  }
}

/** 语料合并：文件级并集；同路径不同内容记为冲突，不覆盖。 */
export function mergeCorpus(srcDir, dstDir) {
  const added = []
  const identical = []
  const conflicts = []
  const walk = (src, dst, prefix) => {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const from = join(src, entry.name)
      const to = join(dst, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        mkdirSync(to, { recursive: true })
        walk(from, to, rel)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = readFileSync(from)
      if (!existsSync(to)) {
        mkdirSync(dirname(to), { recursive: true })
        writeFileSync(to, bytes)
        added.push(rel)
        continue
      }
      if (sha256(readFileSync(to)) === sha256(bytes)) identical.push(rel)
      else conflicts.push({ kind: 'corpus', path: rel })
    }
  }
  if (existsSync(srcDir)) walk(srcDir, dstDir, '')
  return { added, identical, conflicts }
}

/** 递归拷贝，返回文件数。 */
function copyTree(src, dst) {
  let count = 0
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const inner = join(from, entry.name)
      const outer = join(to, entry.name)
      if (entry.isDirectory()) walk(inner, outer)
      else if (entry.isFile()) {
        copyFileSync(inner, outer)
        count += 1
      }
    }
  }
  walk(src, dst)
  return count
}

// `.env` 的读写搬到了 credential-store.js —— 那里是"值该放哪"的唯一权威。
// 这里 import 进来自己用，同时再导出一遍，不破坏已有的导入路径与测试。
import { installCredentialValue, removeEnvKeys, upsertEnvValues } from './credential-store.js'

export { removeEnvKeys, upsertEnvValues }

// ── 凭据引用名清单 ────────────────────────────────────────────────────────

/**
 * 列出 stash 认得的全部引用名及其元数据。
 *
 * 来源两处：钥匙台账（台账里的账号与字段）+ 库声明的 `credentials`。
 * 宿主凭据服务**无法枚举引用名**，所以这份清单是能做"按名删除"的唯一依据。
 */
export async function collectRefs() {
  const map = new Map()
  try {
    const { accounts } = await loadVault()
    for (const account of accounts ?? []) {
      for (const field of account.fields ?? []) {
        if (!field?.ref) continue
        map.set(field.ref, {
          ref: field.ref,
          label: field.label ?? field.ref,
          url: account.url ?? null,
          notes: field.notes ?? account.notes ?? null,
          inject: field.inject ?? null,
          account: account.label ?? account.id ?? null,
          secret: field.secret !== false,
          declaredBy: [],
        })
      }
    }
  } catch {
    // 台账读不出来不该让导出/清空整个失败——下面还有库声明这条来源。
  }
  try {
    const registry = await loadRegistry()
    for (const source of registry?.sources ?? []) {
      for (const ref of source.credentials ?? []) {
        if (!map.has(ref)) {
          map.set(ref, {
            ref, label: ref, url: null, notes: null, inject: null,
            account: null, secret: true, declaredBy: [],
          })
        }
        map.get(ref).declaredBy.push(source.id)
      }
    }
  } catch {
    // 同上。
  }
  return [...map.values()].sort((a, b) => a.ref.localeCompare(b.ref))
}

/** `env:NAME` 落点的字段，取回那个 NAME。 */
const envTargetsOf = (refs) => refs
  .filter((item) => typeof item.inject === 'string' && item.inject.startsWith('env:'))
  .map((item) => item.inject.slice('env:'.length).trim())
  .filter((name) => name.length > 0)

// ── 导出 ──────────────────────────────────────────────────────────────────

function buildGuide(refs, { withValues }) {
  const lines = [
    '# 凭据办理指南',
    '',
    '这份清单由 `dsh-stash` 导出时生成，记的是**每把钥匙从哪来、该放到哪**，不含值。',
    '换机器 / 新机器上照着办一遍即可，不必凭记忆。',
    '',
  ]
  if (refs.length === 0) {
    lines.push('（本机没有登记任何凭据引用名。）', '')
    return `${lines.join('\n')}\n`
  }
  lines.push('| 引用名 | 名称 | 归属账号 | 值该放哪 | 从哪来 |', '|---|---|---|---|---|')
  for (const item of refs) {
    const where = item.inject
      ? `\`${item.inject}\``
      : '凭据服务（面板「设置 → 钥匙」）'
    const note = [item.url, item.notes].filter(Boolean).join(' — ').replace(/\|/g, '\\|') || '—'
    lines.push(`| \`${item.ref}\` | ${item.label ?? '—'} | ${item.account ?? '—'} | ${where} | ${note} |`)
  }
  lines.push('')
  lines.push('## 落点规则')
  lines.push('')
  lines.push('- `env:NAME` → 写 `$DSH_HOME/.env` 的 `NAME=`，**改完要重启**才生效。')
  lines.push('  走这条路的值也常被别的消费者读（那些组件只认 `process.env`，不查凭据服务），写面板对它们无效。')
  lines.push('- `header:*` / `query:*` → 走凭据服务，粘「设置 → 钥匙」面板即可，热重载。')
  if (withValues) {
    lines.push('')
    lines.push('> ⚠️ 本次导出**带了值**（`values.json`，明文）。导出件等同完整密钥库，')
    lines.push('> 请只在私有介质上流转，且别把它放进桌面 / 文档这类默认同步目录。')
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

/** 校验码：包的指纹。导入成功时回显它，清空时要求输入它。 */
function computeVerifyCode(manifest) {
  const basis = {
    files: (manifest.files ?? []).map((file) => `${file.path}:${file.sha256}`).sort(),
    refs: (manifest.refs ?? []).map((item) => item.ref).sort(),
    includesCorpus: manifest.includesCorpus === true,
    hasValues: manifest.hasValues === true,
  }
  return sha256(stableStringify(basis)).slice(0, 8)
}

/**
 * 导出一个目录包。
 * @param {{ outDir: string, withValues?: boolean, includeCorpus?: boolean, getCredentials?: Function, now?: string }} options
 */
export async function exportStash(options = {}) {
  const { outDir, withValues = false, includeCorpus = false, getCredentials } = options
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    return fail('usage', '缺少导出目录。用法：/stash export [--out <目录>] [--with-values] [--corpus]')
  }
  const at = options.now ?? new Date().toISOString()
  const target = outDir.trim()

  try {
    mkdirSync(target, { recursive: true })
    const files = []
    for (const item of PAYLOAD_FILES) {
      if (!existsSync(item.abs)) continue
      writeText(join(target, item.name), readFileSync(item.abs, 'utf8'))
      files.push(manifestEntry(target, item.name))
    }

    let corpusFiles = 0
    if (includeCorpus && existsSync(CORPUS_DIR)) {
      const corpusTarget = join(target, 'corpus')
      copyTree(CORPUS_DIR, corpusTarget)
      // 语料也进校验清单——否则包被动过时只有载荷看得见，语料是一道暗门。
      for (const rel of listFiles(corpusTarget)) {
        files.push(manifestEntry(target, `corpus/${rel}`))
        corpusFiles += 1
      }
    }

    const refs = await collectRefs()
    writeText(join(target, GUIDE_NAME), buildGuide(refs, { withValues }))

    let valueCount = 0
    const valueProblems = []
    if (withValues) {
      const credentials = typeof getCredentials === 'function' ? getCredentials() : undefined
      const values = {}
      for (const item of refs) {
        if (!credentials || typeof credentials.resolve !== 'function') {
          valueProblems.push(`${item.ref}：本部署没有凭据服务，值未能导出`)
          continue
        }
        try {
          const resolved = await credentials.resolve(item.ref)
          if (resolved?.value) {
            values[item.ref] = resolved.value
            valueCount += 1
          } else {
            valueProblems.push(`${item.ref}：未配置，无值可导出`)
          }
        } catch (error) {
          valueProblems.push(`${item.ref}：解析失败（${error instanceof Error ? error.message : String(error)}）`)
        }
      }
      writeText(join(target, VALUES_NAME), `${JSON.stringify({ format: EXPORT_FORMAT, kind: 'dsh-stash-values', exportedAt: at, values }, null, 2)}\n`)
      files.push(manifestEntry(target, VALUES_NAME))
    }

    const manifest = {
      format: EXPORT_FORMAT,
      kind: 'dsh-stash-export',
      exportedAt: at,
      hasValues: withValues,
      includesCorpus: includeCorpus,
      corpusFiles,
      files,
      refs: refs.map((item) => ({ ref: item.ref, inject: item.inject, account: item.account })),
      verifyCode: '',
    }
    manifest.verifyCode = computeVerifyCode(manifest)
    writeText(join(target, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)

    // 记一笔：清空时要拿它里面的校验码做对账。
    // 保留最近 5 次——人常常导出好几遍，只留最后一次会让早先那个包导入回来的码对不上。
    const previous = readJson(LAST_EXPORT_FILE)
    const history = Array.isArray(previous?.history)
      ? previous.history
      : (typeof previous?.verifyCode === 'string' ? [previous] : [])
    history.unshift({ at, dir: target, verifyCode: manifest.verifyCode, hasValues: withValues, includesCorpus: includeCorpus })
    const recent = history.slice(0, 5)
    writeText(LAST_EXPORT_FILE, `${JSON.stringify({ ...recent[0], history: recent }, null, 2)}\n`)

    return {
      ok: true,
      dir: target,
      at,
      files: files.map((file) => file.path),
      refs: refs.map((item) => item.ref),
      valueCount,
      valueProblems,
      corpusFiles,
      withValues,
      includeCorpus,
      verifyCode: manifest.verifyCode,
    }
  } catch (error) {
    return fail('io', `导出失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 导入 ──────────────────────────────────────────────────────────────────

function normalizeLessonGroups(parsed) {
  const groups = {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return groups
  for (const [sourceId, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue
    const kept = []
    for (const entry of list) {
      if (entry && typeof entry === 'object' && typeof entry.title === 'string') {
        kept.push({
          id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null,
          at: typeof entry.at === 'string' ? entry.at : null,
          title: entry.title,
          body: typeof entry.body === 'string' ? entry.body : '',
          action: typeof entry.action === 'string' ? entry.action : null,
          tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string') : [],
          evidence: typeof entry.evidence === 'string' ? entry.evidence : null,
        })
      }
    }
    if (kept.length > 0) groups[sourceId] = kept
  }
  return groups
}

function writeLessonGroups(groups) {
  const sorted = {}
  for (const key of Object.keys(groups).sort()) {
    if (groups[key].length > 0) sorted[key] = groups[key]
  }
  writeText(LESSONS_FILE, `${JSON.stringify(sorted, null, 2)}\n`)
}

/** 校验导出包：manifest 存在、格式对、每个文件哈希对得上。 */
export function verifyBundle(dir) {
  const manifestPath = join(dir, MANIFEST_NAME)
  if (!existsSync(manifestPath)) {
    return { ok: false, error: `不是导出包：${dir} 下没有 ${MANIFEST_NAME}` }
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { ok: false, error: `${MANIFEST_NAME} 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (manifest?.kind !== 'dsh-stash-export') {
    return { ok: false, error: `${MANIFEST_NAME} 不是 dsh-stash 导出包` }
  }
  if (manifest.format !== EXPORT_FORMAT) {
    return { ok: false, error: `导出包格式为 ${manifest.format}，本版只认 ${EXPORT_FORMAT}` }
  }
  const problems = []
  for (const entry of manifest.files ?? []) {
    const path = join(dir, entry.path)
    if (!existsSync(path)) {
      problems.push(`缺少文件 ${entry.path}`)
      continue
    }
    if (hashFile(path) !== entry.sha256) {
      problems.push(`${entry.path} 校验不符（包可能损坏或被改过）`)
    }
  }
  if (problems.length > 0) return { ok: false, error: '导出包校验未通过，已中止（未改动本机任何文件）', problems, manifest }
  return { ok: true, manifest }
}

/**
 * 导入一个导出包。
 *
 * 合并规则见 `DESIGN-portability.md`：值覆盖、经验并集、库条目并集、
 * 台账只拼接、语料文件级、`sources.mjs` 永不改写。
 *
 * @param {{ dir: string, getCredentials?: Function, dryRun?: boolean }} options
 */
export async function importStash(options = {}) {
  const { dir, getCredentials, dryRun = false } = options
  if (typeof dir !== 'string' || dir.trim() === '') {
    return fail('usage', '缺少导出包目录。用法：/stash import <目录> [--dry-run]')
  }
  const root = dir.trim()
  const verified = verifyBundle(root)
  if (!verified.ok) return fail('verify', verified.error, { problems: verified.problems })
  const { manifest } = verified

  const conflicts = []
  const summary = {
    sources: { added: 0, duplicated: 0 },
    accounts: { added: 0, duplicated: 0 },
    lessons: { added: 0, duplicated: 0, incoming: 0 },
    ledger: { incoming: 0, current: 0, total: 0, trimmed: 0 },
    corpus: { added: 0, identical: 0 },
    values: [],
    problems: [],
    sourcesFile: 'skipped',
  }
  const restartRequired = []

  try {
    // 1) sources.local.json —— 库条目与钥匙台账，按 id 并集
    const incomingLocalPath = join(root, 'sources.local.json')
    const incomingLocal = existsSync(incomingLocalPath) ? JSON.parse(readFileSync(incomingLocalPath, 'utf8')) : null
    const currentShard = readLocalShard()
    let nextSources = currentShard.sources
    let nextAccounts = [...currentShard.accounts, ...currentShard.credentials]
    if (incomingLocal && typeof incomingLocal === 'object' && !Array.isArray(incomingLocal)) {
      const sourcesMerge = mergeById(currentShard.sources, incomingLocal.sources ?? [], 'source')
      const accountsMerge = mergeById(nextAccounts, incomingLocal.accounts ?? [], 'account')
      nextSources = sourcesMerge.merged
      nextAccounts = accountsMerge.merged
      summary.sources = { added: sourcesMerge.added.length, duplicated: sourcesMerge.duplicated }
      summary.accounts = { added: accountsMerge.added.length, duplicated: accountsMerge.duplicated }
      conflicts.push(...sourcesMerge.conflicts, ...accountsMerge.conflicts)
    } else if (Array.isArray(incomingLocal)) {
      // 0.3.x 老形状：整个文件是库条目数组
      const merged = mergeById(currentShard.sources, incomingLocal, 'source')
      nextSources = merged.merged
      summary.sources = { added: merged.added.length, duplicated: merged.duplicated }
      conflicts.push(...merged.conflicts)
    }

    // 2) lessons.json —— 并集 + 按 (来源库, title) 去重
    const incomingLessonsPath = join(root, 'lessons.json')
    const incomingGroups = existsSync(incomingLessonsPath)
      ? normalizeLessonGroups(JSON.parse(readFileSync(incomingLessonsPath, 'utf8')))
      : {}
    // 读现有：直接解析，避免依赖 readLessons 的全局路径常量在测试替换时的时序。
    const currentGroups = existsSync(LESSONS_FILE)
      ? normalizeLessonGroups(JSON.parse(readFileSync(LESSONS_FILE, 'utf8')))
      : {}
    const lessonsMerge = mergeLessons(currentGroups, incomingGroups)
    summary.lessons = {
      added: lessonsMerge.added.length,
      duplicated: lessonsMerge.duplicated,
      incoming: Object.values(incomingGroups).reduce((sum, list) => sum + list.length, 0),
    }
    conflicts.push(...lessonsMerge.conflicts)

    // 3) ledger.ndjson —— 只拼接
    const ledgerMerge = mergeLedgerText(
      readText(LEDGER_FILE) ?? '',
      existsSync(join(root, 'ledger.ndjson')) ? readFileSync(join(root, 'ledger.ndjson'), 'utf8') : '',
    )
    summary.ledger = {
      incoming: ledgerMerge.incoming,
      current: ledgerMerge.current,
      total: ledgerMerge.total,
      trimmed: ledgerMerge.trimmed,
    }

    // 4) corpus/ —— 文件级并集（仅当导出包带了它）
    let corpusMerge = { added: [], identical: [], conflicts: [] }
    if (manifest.includesCorpus && existsSync(join(root, 'corpus'))) {
      corpusMerge = mergeCorpus(join(root, 'corpus'), CORPUS_DIR)
      conflicts.push(...corpusMerge.conflicts)
    }
    summary.corpus = { added: corpusMerge.added.length, identical: corpusMerge.identical.length }

    // 5) sources.mjs —— 手写件，程序永不改写
    const incomingSourcesPath = join(root, 'sources.mjs')
    if (existsSync(incomingSourcesPath)) {
      const incomingText = readFileSync(incomingSourcesPath, 'utf8')
      const currentText = readText(SOURCES_FILE)
      if (currentText === null) {
        summary.sourcesFile = 'copied'
      } else if (currentText === incomingText) {
        summary.sourcesFile = 'identical'
      } else {
        summary.sourcesFile = 'conflict'
        conflicts.push({ kind: 'sources.mjs', note: '本机已有 sources.mjs 且内容不同；手写件程序永不改写，请人工合并' })
      }
    }

    // 6) 值 —— 先只做计划，落盘之后才真正写（先写文件再写值，失败方向更安全）
    //    允许写进 .env 的键，只认**合并后**账号集里声明了 env: 落点的字段。
    const envNames = new Set()
    for (const account of nextAccounts ?? []) {
      for (const field of account?.fields ?? []) {
        if (typeof field?.inject === 'string' && field.inject.startsWith('env:')) {
          envNames.add(field.inject.slice('env:'.length).trim())
        }
      }
    }

    const valuePlan = []
    if (manifest.hasValues && existsSync(join(root, VALUES_NAME))) {
      const pack = JSON.parse(readFileSync(join(root, VALUES_NAME), 'utf8'))
      for (const [ref, value] of Object.entries(pack?.values ?? {})) {
        const meta = (manifest.refs ?? []).find((item) => item.ref === ref)
        const inject = typeof meta?.inject === 'string' ? meta.inject : null
        const name = inject && inject.startsWith('env:') ? inject.slice('env:'.length).trim() : null
        if (name && envNames.has(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          valuePlan.push({ ref, kind: 'env', name, value, inject })
        } else {
          // 没声明 env 落点的，一律走凭据服务——绝不凭包里的说法去改 .env 的任意键。
          valuePlan.push({ ref, kind: 'credentials', value, inject })
        }
      }
    }

    if (dryRun) {
      summary.values = valuePlan.map((item) => ({
        ref: item.ref,
        target: item.kind === 'env' ? `env:${item.name}` : 'credentials',
        result: 'planned',
      }))
      return {
        ok: true, dryRun: true, dir: root, manifest, summary, conflicts,
        verifyCode: manifest.verifyCode, restartRequired: [],
      }
    }

    // ── 落盘（校验通过之后才动本机任何一个文件）──
    writeLocalShard({ sources: nextSources, accounts: nextAccounts })
    if (Object.keys(lessonsMerge.merged).length > 0) writeLessonGroups(lessonsMerge.merged)
    if (ledgerMerge.incoming > 0) writeText(LEDGER_FILE, ledgerMerge.text)
    if (summary.sourcesFile === 'copied') {
      writeText(SOURCES_FILE, readFileSync(incomingSourcesPath, 'utf8'))
    }

    // ── 写值：**两处都写**（凭据服务 + .env），与面板贴值走同一条路 ──
    // 只写 .env 的话，重启前读 seam 的消费者看不见（.env 是启动快照），面板还会误报"未配置"；
    // 只写凭据服务的话，读 process.env 的组件永远拿不到。两条路必须落到同样的状态。
    const credentials = typeof getCredentials === 'function' ? getCredentials() : undefined
    for (const item of valuePlan) {
      const installed = await installCredentialValue({
        ref: item.ref,
        value: item.value,
        inject: item.inject,
        credentials,
      })
      const target = installed.written.length > 0 ? `env:${installed.written[0]}` : 'credentials'
      summary.values.push({
        ref: item.ref,
        target,
        result: installed.stored === 'written' ? 'written' : installed.stored,
      })
      if (installed.pendingRestart) restartRequired.push(...installed.written)
      summary.problems.push(...installed.problems)
    }

    return {
      ok: true,
      dryRun: false,
      dir: root,
      manifest,
      summary,
      conflicts,
      verifyCode: manifest.verifyCode,
      restartRequired,
      hasValues: manifest.hasValues === true,
    }
  } catch (error) {
    return fail('io', `导入失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 清空 ──────────────────────────────────────────────────────────────────

/**
 * 只做计划，不动任何东西。清空键必须先看到这份清单。
 */
export async function planWipe(options = {}) {
  const { includeCorpus = false } = options
  const refs = await collectRefs()
  // 要清出 .env 的键有两类：声明了 `env:` 落点的，以及**名字与引用名同名**的
  // （用户可能把值放进了 .env 却没在台账里记 inject——只按 inject 找会漏掉它）。
  const refNames = new Set(refs.map((item) => item.ref))
  const envKeysInFile = (readText(join(DSH_HOME, '.env')) ?? '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/))
    .filter(Boolean)
    .map((match) => match[1])
  const envTargets = [...new Set([
    ...envTargetsOf(refs),
    ...envKeysInFile.filter((name) => refNames.has(name)),
  ])]
  let entries = []
  try {
    entries = readdirSync(LIB_HOME)
  } catch {
    entries = []
  }
  const targets = entries.filter((name) => KNOWN_ENTRIES.has(name) && (name !== 'corpus' || includeCorpus))
  const untouched = entries.filter((name) => !KNOWN_ENTRIES.has(name))
  const lastExport = readJson(LAST_EXPORT_FILE)
  const history = Array.isArray(lastExport?.history)
    ? lastExport.history
    : (typeof lastExport?.verifyCode === 'string' ? [lastExport] : [])
  const codes = history.map((item) => item?.verifyCode).filter((code) => typeof code === 'string')
  return {
    targets: targets.sort(),
    untouched: untouched.sort(),
    refs: refs.map((item) => item.ref),
    envTargets,
    lastExport,
    codes,
    requireCode: codes[0] ?? null,
  }
}

/**
 * 按名删除凭据的值。宿主的凭据服务没有列表接口，所以只能删**清单内**的引用名。
 * @returns {Promise<Array<{ ref: string, result: string }>>}
 */
async function unsetRefs(refs, getCredentials) {
  const credentials = typeof getCredentials === 'function' ? getCredentials() : undefined
  const out = []
  for (const ref of refs) {
    if (!credentials || typeof credentials.unset !== 'function') {
      out.push({ ref, result: 'skipped:no-credentials' })
      continue
    }
    try {
      await credentials.unset(ref)
      out.push({ ref, result: 'removed' })
    } catch (error) {
      out.push({ ref, result: `failed:${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return out
}

/**
 * 清空本机的 stash 痕迹。
 *
 * 前置铁律：本机必须有一次导出记录，且 `confirm` 等于那份导出包在**另一台机器**
 * 导入成功后回显的校验码。这是人工对账——插件无法证明别处真的导入成功，
 * 但它把"删"绑在了一次真实的恢复验证上，而不是绑在"我记得我导出过"。
 *
 * @param {{ includeCorpus?: boolean, confirm?: string, getCredentials?: Function, dryRun?: boolean }} options
 */
export async function wipeStash(options = {}) {
  const plan = await planWipe(options)
  if (plan.requireCode === null) {
    return fail('no-export', '本机没有导出记录。清空前必须先导出，并在另一台机器导入成功——顺序反了就没有退路。', { plan })
  }
  if (!plan.codes.includes(options.confirm)) {
    return fail('unconfirmed', '确认码不符。请填入某一次导出在另一台机器导入成功时回显的校验码。', { plan, requireCode: plan.requireCode })
  }
  if (options.dryRun) return { ok: true, dryRun: true, plan }

  const removed = []
  const problems = []
  try {
    for (const name of plan.targets) {
      const path = join(LIB_HOME, name)
      try {
        rmSync(path, { recursive: true, force: true })
        removed.push(name)
      } catch (error) {
        problems.push(`${name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const values = await unsetRefs(plan.refs, options.getCredentials)

    const envPath = join(DSH_HOME, '.env')
    const envText = readText(envPath)
    let envRemoved = []
    if (envText !== null && plan.envTargets.length > 0) {
      const result = removeEnvKeys(envText, plan.envTargets)
      envRemoved = result.removed
      if (envRemoved.length > 0) writeText(envPath, result.text)
    }

    ensureLibDirs()
    return {
      ok: true,
      dryRun: false,
      removed,
      values,
      envRemoved,
      untouched: plan.untouched,
      problems,
    }
  } catch (error) {
    return fail('io', `清空失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 渲染（给 `/stash` 命令用）─────────────────────────────────────────────

export function renderExport(value) {
  if (!value?.ok) return `❌ 导出失败：${value?.error ?? '未知错误'}`
  const lines = [
    `📦 导出完成  ·  ${value.dir}`,
    `校验码 ${value.verifyCode}（在另一台机器导入成功后会回显同一个码；清空时要输入它）`,
    `含 ${value.files.length} 个文件${value.corpusFiles > 0 ? ` + corpus ${value.corpusFiles} 个文件` : ''}`,
    `值：${value.withValues ? `明文打包 ${value.valueCount} 条` : '未带（默认）。要带值请加 --with-values'}`,
  ]
  if (value.valueProblems?.length > 0) {
    lines.push(`⚠️ 部分值未能导出：`)
    for (const item of value.valueProblems) lines.push(`   · ${item}`)
  }
  if (value.withValues) {
    lines.push('⚠️ 这个包等同完整密钥库（明文）。只在私有介质上流转，别放进桌面 / 文档这类默认同步目录。')
  }
  return lines.join('\n')
}

export function renderImport(value) {
  if (!value?.ok) {
    const lines = [`❌ 导入失败：${value?.error ?? '未知错误'}`]
    for (const problem of value?.problems ?? []) lines.push(`   · ${problem}`)
    if (value?.kind === 'verify') lines.push('本机未改动任何文件。')
    return lines.join('\n')
  }
  const s = value.summary
  const lines = [
    `${value.dryRun ? '🔎 预演（未改动任何文件）' : '📥 导入完成'}  ·  ${value.dir}`,
    `库条目 +${s.sources.added}（重复跳过 ${s.sources.duplicated}） · 钥匙账号 +${s.accounts.added}（重复跳过 ${s.accounts.duplicated}）`,
    `经验 +${s.lessons.added}（包内 ${s.lessons.incoming}，重复跳过 ${s.lessons.duplicated}）`,
    `台账 拼接 ${s.ledger.incoming} 条（本机 ${s.ledger.current} → ${s.ledger.total}${s.ledger.trimmed > 0 ? `，按 2000/1000 规则裁掉 ${s.ledger.trimmed}` : ''}）`,
    `语料 +${s.corpus.added}（相同跳过 ${s.corpus.identical}）`,
    `sources.mjs：${{ copied: '本机原无，已拷入', identical: '一致，未动', skipped: '包内没有', conflict: '冲突，未动（手写件程序永不改写）' }[s.sourcesFile] ?? s.sourcesFile}`,
  ]
  if (s.values.length > 0) {
    lines.push('值的落点：')
    for (const item of s.values) lines.push(`   · ${item.ref} → ${item.target}：${item.result}`)
  }
  if (value.conflicts.length > 0) {
    lines.push(`⚠️ ${value.conflicts.length} 处冲突，均**保留本机版本**，请你研判：`)
    for (const item of value.conflicts.slice(0, 20)) {
      if (item.kind === 'lesson') lines.push(`   · 经验「${item.title}」（${item.source}）两边内容不同`)
      else if (item.kind === 'corpus') lines.push(`   · 语料 ${item.path} 同名不同内容`)
      else if (item.kind === 'sources.mjs') lines.push(`   · ${item.note}`)
      else lines.push(`   · ${item.kind} ${item.id} 定义不同`)
    }
    if (value.conflicts.length > 20) lines.push(`   · …还有 ${value.conflicts.length - 20} 处`)
  }
  if (value.restartRequired?.length > 0) {
    lines.push(`⏻ 写进了 $DSH_HOME/.env 的 ${value.restartRequired.join(', ')}：**必须重启 DSH 才生效**。`)
  }
  if (!value.dryRun) {
    lines.push('提示：值的写入按每个字段自己的 inject 落点分流；落点写错会表现为「面板是绿的、功能却是断的」。')
  }
  return lines.join('\n')
}

export function renderWipe(value) {
  if (!value?.ok) {
    const lines = [`❌ 清空未执行：${value?.error ?? '未知错误'}`]
    const plan = value?.plan
    if (plan) {
      lines.push(`   将删除：${plan.targets.join(', ') || '（无）'}`)
      lines.push(`   将按名删除 ${plan.refs.length} 个引用名的凭据值${plan.envTargets.length > 0 ? `，并移除 .env 的 ${plan.envTargets.join(', ')}` : ''}`)
      if (plan.untouched.length > 0) lines.push(`   不认识的条目（不动）：${plan.untouched.join(', ')}`)
    }
    if (value?.kind === 'no-export') lines.push('   顺序：先导出 → 在另一台机器导入成功 → 再回来清空。')
    if (value?.kind === 'unconfirmed' && value.requireCode) lines.push(`   用法：/stash wipe --confirm ${value.requireCode}`)
    return lines.join('\n')
  }
  if (value.dryRun) return `🔎 清空预演：将删除 ${value.plan.targets.join(', ')}`
  const lines = [
    '🧹 清空完成',
    `已删除：${value.removed.join(', ') || '（无）'}`,
  ]
  const removedValues = value.values.filter((item) => item.result === 'removed')
  const failedValues = value.values.filter((item) => item.result !== 'removed' && !item.result.startsWith('skipped'))
  lines.push(`凭据值：按名删除 ${removedValues.length} 个${removedValues.length > 0 ? `（${removedValues.map((item) => item.ref).join(', ')}）` : ''}`)
  const skipped = value.values.filter((item) => item.result.startsWith('skipped'))
  if (skipped.length > 0) lines.push(`   跳过 ${skipped.length} 个（${skipped[0].result}）`)
  if (failedValues.length > 0) lines.push(`   ⚠️ 失败 ${failedValues.length} 个：${failedValues.map((item) => `${item.ref}(${item.result})`).join(', ')}`)
  if (value.envRemoved.length > 0) lines.push(`.env：移除 ${value.envRemoved.join(', ')}`)
  if (value.untouched.length > 0) lines.push(`未认识的条目**未删**（不是 stash 写的东西）：${value.untouched.join(', ')}`)
  if (value.problems.length > 0) lines.push(`⚠️ ${value.problems.join('; ')}`)
  lines.push('这台机器上 stash 的数据已清干净；插件本身还在，要一并卸载请用 pnpm dsh plugin --profile web remove dsh-stash。')
  return lines.join('\n')
}
