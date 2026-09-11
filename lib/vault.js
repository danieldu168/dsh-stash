/**
 * 钥匙台账 v0.5 —— 「同一个账号/服务 = 目录里的一条」。
 *
 * 两个不同的问题，两张不同的表：
 *   库注册表：这个库**需要**哪些钥匙（`source.credentials`，一串引用名）
 *   钥匙台账：我**有**哪些账号、每个账号下有哪些字段（本文档）
 *
 * ── 为什么是两层（account + fields）────────────────────────────────────────
 * 一个 ref 在宿主凭据库里就是**一个字符串值**，取值也永远是 by-ref 的
 * （handlers 按 ref 取值、`source.credentials` 按 ref 声明需求）。所以"把同一网站的
 * 几条钥匙并成一条"只能在**目录这一层**做：一条账号记录（示例：某网站）下面挂
 * 账号 / 密码 / 代理三个字段，每个字段仍是独立 ref、独立配置状态。
 * 值这一层不合并——合并了就只剩一个粗布尔，缺哪个字段看不出来。
 *
 * ── 存储 ──────────────────────────────────────────────────────────────────
 *   手写：`sources.mjs` 的 `export const accounts = [...]`（程序永不改写）
 *         兼容旧形状 `export const credentials = [{ ref, label, ... }]`
 *   代写：`sources.local.json` 的 `accounts`（界面与模型写这里）
 *         兼容旧形状 `credentials` 与更早的纯数组
 * 同 id 以手写为准；同一个 ref 不能出现在两个账号里（后出现的会被丢弃并报 problem）。
 *
 * ⛔ 台账只存**引用名与元数据**，永不存值。值只有一条路径：
 *    浏览器输入框 → ctx.remote.credentials.set → 宿主凭据服务 → .credentials.yaml
 *
 * @module dsh-stash/vault
 */
import { statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { SOURCES_FILE } from './home.js'
import { readLocalShard, writeLocalAccounts } from './shard.js'
import { CREDENTIAL_REF_PATTERN, findSecretPath } from './secrets.js'

export const CATEGORY_LABELS = {
  site: '网站账号',
  api: 'API 密钥',
  database: '数据库',
  token: '令牌',
  mcp: 'MCP / 智能体服务',
  other: '其他',
}
const CATEGORIES = new Set(Object.keys(CATEGORY_LABELS))
export const CATEGORY_IDS = [...CATEGORIES]
export { CREDENTIAL_REF_PATTERN }

/** 账号 id：小写字母/数字/-/_，用于编辑与删除时指认这一条。 */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
/**
 * 注入点：值最终要写进哪个位置。登记它，模型才知道"这个值该填到哪"，
 * 而不用每次现猜。形式：env:FOO_API_KEY / header:Authorization / query:key /
 * file:/path/to/file / arg:--token / env-file:/path/to/.env
 */
const INJECT_PATTERN = /^(env|header|query|file|arg|env-file):\S+$/

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const str = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null)

/** 由任意可读串派生一个合法账号 id（`MY_API_KEY` → `my_api_key`）。 */
export function deriveAccountId(seed) {
  const slug = String(seed ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  return ACCOUNT_ID_PATTERN.test(slug) ? slug : ''
}

/**
 * 校验一个字段。
 * @returns {{ field?: object, problem?: string }}
 */
function normalizeField(raw, at) {
  if (!isPlainObject(raw)) return { problem: `${at}：字段不是对象。` }
  const ref = typeof raw.ref === 'string' ? raw.ref.trim() : ''
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    return {
      problem: `${at}：引用名不合法（须为全大写字母/数字/下划线，且不以数字开头）：${JSON.stringify(raw.ref)}`,
    }
  }
  const inject = str(raw.inject, 200)
  if (inject && !INJECT_PATTERN.test(inject)) {
    return {
      problem: `${at}（${ref}）：inject "${inject}" 形式不对，应为 env:FOO_API_KEY、header:Authorization、query:key、file:/path 这类。`,
    }
  }
  return {
    field: {
      ref,
      label: str(raw.label, 120) ?? ref,
      secret: raw.secret !== false,
      inject,
      multiline: raw.multiline === true,
      notes: str(raw.notes, 500),
    },
  }
}

/**
 * 校验并规范化一条账号。接受两种形状：
 *   新：{ id?, label, category, url?, notes?, usedBy?, fields: [{ ref, label?, secret?, inject?, multiline? }] }
 *   旧：{ ref, label, category, url?, notes?, usedBy?, secret?, inject?, multiline? }（= 单字段账号）
 *
 * @returns {{ account?: object, problem?: string }}
 */
export function normalizeAccount(raw, at = '账号') {
  if (!isPlainObject(raw)) return { problem: `${at}：不是对象。` }

  const leakPath = findSecretPath({
    id: raw.id,
    account: raw.account,
    label: raw.label,
    category: raw.category,
    url: raw.url,
    notes: raw.notes,
    usedBy: raw.usedBy,
    fields: raw.fields,
  })
  if (leakPath) {
    return {
      problem: `${at}：疑似口令/密钥值出现在字段 ${leakPath}，已拒绝。`
        + '台账是明文文件（会被备份、被 git、被读进模型上下文），值只能在「设置 → 钥匙」里录入。',
    }
  }

  const rawFields = Array.isArray(raw.fields) && raw.fields.length > 0
    ? raw.fields
    : [{ ref: raw.ref, label: raw.label, secret: raw.secret, inject: raw.inject, multiline: raw.multiline }]
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return { problem: `${at}：至少需要一个字段（fields）。` }
  }

  const fields = []
  const seen = new Set()
  for (let index = 0; index < rawFields.length; index += 1) {
    const result = normalizeField(rawFields[index], `${at} 字段 ${index + 1}`)
    if (result.problem) return { problem: result.problem }
    if (seen.has(result.field.ref)) return { problem: `${at}：字段 ${result.field.ref} 重复。` }
    seen.add(result.field.ref)
    fields.push(result.field)
  }

  const idSeed = raw.id ?? raw.account ?? raw.group ?? (Array.isArray(raw.fields) ? raw.label : fields[0].ref)
  let id = typeof raw.id === 'string' && ACCOUNT_ID_PATTERN.test(raw.id.trim())
    ? raw.id.trim()
    : deriveAccountId(idSeed)
  // 中文名派生不出 id 时，退回第一个引用名（MY_API_KEY → my_api_key）
  if (!id) id = deriveAccountId(fields[0].ref)
  if (!id) {
    return { problem: `${at}：无法确定账号 id（请显式给 id，如 "bid_portal"）。` }
  }

  const category = CATEGORIES.has(raw.category) ? raw.category : 'other'
  const label = str(raw.label, 120) ?? fields[0].label ?? fields[0].ref

  return {
    account: {
      id,
      label,
      category,
      url: str(raw.url, 500),
      notes: str(raw.notes, 1000),
      usedBy: Array.isArray(raw.usedBy) ? raw.usedBy.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [],
      fields,
    },
  }
}

/**
 * 校验一份账号输入（Model Tool 与浏览器写端点共用，保证两边同一套标准）。
 * 入参可以是 `{ account, fields }`，也可以直接是旧形状的单字段对象。
 * @returns {{ account?: object, error?: string, hint?: string }}
 */
export function validateAccountInput(raw) {
  if (!isPlainObject(raw)) return { error: '入参必须是对象' }

  // 值的形状永远不该出现在这里：值是浏览器 → 凭据服务的单向通道。
  for (const key of ['value', 'password', 'token', 'secretValue']) {
    if (key in raw && typeof raw[key] === 'string' && raw[key].length > 0) {
      return {
        error: `入参里出现了 ${key}，已拒绝`,
        hint: '台账端点只接受元数据。值只能在「设置 → 钥匙」的输入框里录入，经宿主凭据服务单向写入。',
      }
    }
  }
  // 顶层与嵌套一起扫：`{ account: {...}, fields: [...], notes: 'sk-…' }` 这种写法也要拦得住。
  const leakPath = findSecretPath(raw)
  if (leakPath) {
    return {
      error: `检测到疑似口令/密钥值（字段 ${leakPath}），已拒绝登记`,
      hint: '台账是明文文件：会被备份、被 git、并进入模型上下文。'
        + '只登记"有哪些钥匙"，值请在「设置 → 钥匙」里由本人录入。',
    }
  }

  const combined = isPlainObject(raw.account)
    ? {
      ...raw.account,
      id: raw.account.id ?? raw.id,
      label: raw.account.label ?? raw.label,
      category: raw.account.category ?? raw.category,
      url: raw.account.url ?? raw.url,
      notes: raw.account.notes ?? raw.notes,
      usedBy: raw.account.usedBy ?? raw.usedBy,
      fields: Array.isArray(raw.fields) ? raw.fields : raw.account.fields,
    }
    : raw

  if (Array.isArray(raw.fields)) {
    for (const field of raw.fields) {
      if (isPlainObject(field) && typeof field.value === 'string' && field.value.length > 0) {
        return {
          error: 'fields 里出现了 value，已拒绝',
          hint: '字段只登记"引用名 + 显示名 + 注入点"；值请在面板上录入。',
        }
      }
    }
  }

  if (!Array.isArray(combined.fields) && !CREDENTIAL_REF_PATTERN.test(String(combined.ref ?? '').trim())) {
    return {
      error: `引用名 ${JSON.stringify(combined.ref)} 不合法`,
      hint: '必须是全大写字母/数字/下划线，且不以数字开头（如 MY_API_KEY、BID_PORTAL_PASSWORD）。'
        + '如果你填的是口令本身，请改成引用名——口令永远不写进任何注册表文件。',
    }
  }
  if (!CATEGORIES.has(combined.category)) {
    return { error: `类别 ${JSON.stringify(combined.category)} 不合法`, hint: `可用：${CATEGORY_IDS.join(' / ')}` }
  }
  if (!str(combined.label, 120)) return { error: 'label 必填（面板上显示的中文名）' }

  const normalized = normalizeAccount(combined, '账号')
  if (normalized.problem) return { error: normalized.problem }
  return { account: normalized.account }
}

/** 从 sources.mjs 取手写台账（新形状 accounts 优先，兼容旧 credentials）。 */
async function readHandwrittenLedger() {
  try {
    const stamp = statSync(SOURCES_FILE).mtimeMs
    const mod = await import(`${pathToFileURL(SOURCES_FILE).href}?v=${stamp}`)
    if (Array.isArray(mod.accounts)) return { list: mod.accounts, at: 'sources.mjs accounts', problems: [] }
    if (Array.isArray(mod.credentials)) return { list: mod.credentials, at: 'sources.mjs credentials', problems: [] }
    return { list: [], at: 'sources.mjs', problems: [] }
  } catch (error) {
    return {
      list: [],
      at: 'sources.mjs',
      problems: [`sources.mjs 的账号台账无法读取：${error instanceof Error ? error.message : String(error)}`],
    }
  }
}

/**
 * 把一串原始条目按账号 id 归并（同 id 的字段合并进同一条）。
 * @returns {{ accounts: object[], problems: string[] }}
 */
function collapse(rawList, at) {
  const problems = []
  const byId = new Map()
  const list = Array.isArray(rawList) ? rawList : []
  list.forEach((raw, index) => {
    const result = normalizeAccount(raw, `${at} 第 ${index + 1} 条`)
    if (result.problem) {
      problems.push(result.problem)
      return
    }
    const { account } = result
    const existing = byId.get(account.id)
    if (!existing) {
      byId.set(account.id, account)
      return
    }
    // 同 id 归并：元数据取第一个非空，字段合并（重复 ref 报 problem）
    const fields = [...existing.fields]
    for (const field of account.fields) {
      if (fields.some((item) => item.ref === field.ref)) {
        problems.push(`${at}：字段 ${field.ref} 在账号 ${account.id} 里重复，已忽略后一条。`)
        continue
      }
      fields.push(field)
    }
    byId.set(account.id, {
      ...existing,
      label: existing.label ?? account.label,
      category: existing.category !== 'other' ? existing.category : account.category,
      url: existing.url ?? account.url,
      notes: existing.notes ?? account.notes,
      usedBy: [...new Set([...existing.usedBy, ...account.usedBy])],
      fields,
    })
  })
  return { accounts: [...byId.values()], problems }
}

/**
 * 读取合并后的台账（手写优先；同一个 ref 只能属于一个账号）。
 * @returns {Promise<{ accounts: object[], problems: string[] }>}
 */
export async function loadVault() {
  const problems = []
  const handwrittenRaw = await readHandwrittenLedger()
  problems.push(...handwrittenRaw.problems)
  const shard = readLocalShard()
  problems.push(...shard.problems)

  const handwritten = collapse(handwrittenRaw.list, handwrittenRaw.at)
  problems.push(...handwritten.problems)
  const local = collapse([...(shard.accounts ?? []), ...(shard.credentials ?? [])], 'sources.local.json')
  problems.push(...local.problems)

  const byId = new Map()
  for (const account of handwritten.accounts) byId.set(account.id, { ...account, origin: 'handwritten' })
  for (const account of local.accounts) {
    if (byId.has(account.id)) {
      problems.push(`sources.local.json 的账号 ${account.id}：与手写台账同 id，手写优先，本条被忽略。`)
      continue
    }
    byId.set(account.id, { ...account, origin: 'local' })
  }

  // ref 级去重：一个引用名只能属于一个账号，否则界面会出现两个"同一把钥匙"
  const claimed = new Map()
  for (const account of byId.values()) {
    const kept = []
    for (const field of account.fields) {
      const owner = claimed.get(field.ref)
      if (owner && owner !== account.id) {
        problems.push(`字段 ${field.ref} 同时出现在账号 ${owner} 与 ${account.id}，已从后者移除。`)
        continue
      }
      claimed.set(field.ref, account.id)
      kept.push(field)
    }
    account.fields = kept
  }

  const accounts = [...byId.values()].filter((account) => account.fields.length > 0)
  return { accounts, problems }
}

/** 写回代写的账号台账（会顺带把旧形状的 credentials 迁移成 accounts）。 */
export function saveVault(accounts) {
  const clean = accounts.map(({ origin, ...rest }) => rest)
  return writeLocalAccounts(clean)
}

/**
 * 新增或替换一条**代写**账号。手写同 id 的账号由调用方先拦（会抛错）。
 */
export function upsertVaultAccount(account, allAccounts = []) {
  const next = allAccounts
    .filter((item) => item.origin !== 'handwritten')
    .map(({ origin, ...rest }) => rest)
    .filter((item) => item.id !== account.id)
  next.push(account)
  return saveVault(next)
}

/** 删除一条代写账号（其余保持不变）。 */
export function removeVaultAccount(id, allAccounts = []) {
  const next = allAccounts
    .filter((item) => item.origin !== 'handwritten')
    .map(({ origin, ...rest }) => rest)
    .filter((item) => item.id !== id)
  return saveVault(next)
}

/**
 * 把「台账」与「库声明的引用名」合并成面板用的清单。
 *
 * 三种情形：
 *   台账有 + 库声明 → 完整元数据 + 被哪些库引用
 *   仅台账有        → 完整元数据，inVault=true
 *   仅库声明        → 合成一条占位账号（id 由 ref 派生），inVault=false，面板标 ⚠️
 *
 * @param {object[]} sources 来自 loadRegistry().sources
 * @param {object[]} accounts 来自 loadVault().accounts
 */
export function buildLedger(sources, accounts) {
  const declaredByRef = new Map()
  for (const source of sources ?? []) {
    for (const ref of source.credentials ?? []) {
      const list = declaredByRef.get(ref) ?? []
      if (!list.includes(source.id)) list.push(source.id)
      declaredByRef.set(ref, list)
    }
  }

  const ledgerAccounts = []
  const claimed = new Set()

  for (const account of accounts ?? []) {
    const fields = account.fields.map((field) => {
      claimed.add(field.ref)
      return {
        ref: field.ref,
        label: field.label,
        secret: field.secret !== false,
        inject: field.inject ?? null,
        multiline: field.multiline === true,
        notes: field.notes ?? null,
        declaredBy: declaredByRef.get(field.ref) ?? [],
        configured: null,
        writable: null,
        source: null,
      }
    })
    const declaredBy = [...new Set(fields.flatMap((field) => field.declaredBy))]
    ledgerAccounts.push({
      id: account.id,
      label: account.label,
      category: account.category,
      categoryLabel: CATEGORY_LABELS[account.category] ?? CATEGORY_LABELS.other,
      url: account.url ?? null,
      notes: account.notes ?? null,
      usedBy: [...new Set([...(account.usedBy ?? []), ...declaredBy])],
      declaredBy,
      origin: account.origin ?? 'local',
      inVault: true,
      fields,
    })
  }

  // 只被库声明、台账里没有的引用名：合成占位账号，引导补登记
  for (const [ref, declaredBy] of declaredByRef) {
    if (claimed.has(ref)) continue
    ledgerAccounts.push({
      id: deriveAccountId(ref) || 'entry',
      label: ref,
      category: 'other',
      categoryLabel: CATEGORY_LABELS.other,
      url: null,
      notes: null,
      usedBy: [...declaredBy],
      declaredBy: [...declaredBy],
      origin: 'library',
      inVault: false,
      fields: [{
        ref,
        label: ref,
        secret: true,
        inject: null,
        multiline: false,
        notes: null,
        declaredBy: [...declaredBy],
        configured: null,
        writable: null,
        source: null,
      }],
    })
  }

  const order = Object.keys(CATEGORY_LABELS)
  ledgerAccounts.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.label.localeCompare(b.label))

  for (const account of ledgerAccounts) {
    account.stats = summarizeFields(account.fields)
  }

  return { accounts: ledgerAccounts, problems: [] }
}

function summarizeFields(fields) {
  const configured = fields.filter((field) => field.configured === true).length
  return {
    fields: fields.length,
    configured,
    missing: fields.filter((field) => field.configured === false).length,
    unknown: fields.filter((field) => field.configured === null).length,
  }
}

/** 由已解析出 configured 的账号算统计（host 侧算好，客户端只渲染）。 */
export function computeStats(accounts) {
  const fields = accounts.flatMap((account) => account.fields)
  const byCategory = []
  for (const [category, label] of Object.entries(CATEGORY_LABELS)) {
    const group = accounts.filter((account) => account.category === category)
    if (group.length === 0) continue
    const groupFields = group.flatMap((account) => account.fields)
    byCategory.push({
      category,
      categoryLabel: label,
      accounts: group.length,
      fields: groupFields.length,
      configured: groupFields.filter((field) => field.configured === true).length,
    })
  }
  return {
    accounts: accounts.length,
    fields: fields.length,
    configured: fields.filter((field) => field.configured === true).length,
    missing: fields.filter((field) => field.configured === false).length,
    unknown: fields.filter((field) => field.configured === null).length,
    byCategory,
  }
}

/** 找到某个引用名所属的账号。 */
export function findAccountByRef(accounts, ref) {
  return (accounts ?? []).find((account) => account.fields.some((field) => field.ref === ref)) ?? null
}
