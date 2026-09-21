/**
 * 经验库 —— 按库归档「下次别再踩」的东西。
 *
 * ## 它解决什么
 *
 * 台账回答「取过什么」，注册表回答「这条库允许怎么取」，经验库回答第三个问题：
 * **「这条库踩过什么坑、正确写法是什么」**。
 * 三者互补：台账只有指纹，注册表只有声明，而坑通常是在**失败之后**才被认识的。
 *
 * ## 为什么是独立文件
 *
 * 经验**不能挂在库条目上**。手写的 `sources.mjs` 永不被程序改写，而现实里的库
 * 常常就住在手写文件里——经验若只能挂在条目上，这批库永远记不了经验。
 * 所以经验按**库 id 分组**存在独立文件 `$DSH_HOME/stash/lessons.json` 里，
 * 于是手写库与代写库一视同仁。
 *
 * ## 刻意不做的
 *
 * 1. **不规定经验长什么样。** 各库的坑各不相同：贸易数据是口径陷阱，文献库是检索语法，
 *    MCP 服务是鉴权流程。所以除 `title` 外全是可选的自由字段，**不设枚举、不做分类**。
 *    stash 只提供存放、校验、按库带出的便利，判断内容属于使用它的人。
 * 2. **不碰密钥。** 正文与标签都要过一遍密钥特征扫描——经验常常是"当初我把 key 写错了"
 *    这类叙述，很容易顺手把值抄进去，而这是一个明文文件。
 * 3. **不做语义检索。** `query` 是子串匹配，和 `stash_files` 一致。
 *
 * ## 有界
 *
 * 每个库最多 MAX_PER_SOURCE 条。**到顶时拒绝写入而不是静默淘汰**——
 * 悄悄丢掉别人写下的教训，比报错糟糕得多。
 *
 * @module dsh-stash/lessons
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { LESSONS_FILE, ensureLibDirs } from './home.js'
import { findSecretPath } from './secrets.js'

/** 每个库最多保留的经验条数；到顶后拒绝新写入，由人自行整理。 */
const MAX_PER_SOURCE = 200
/** 最多多少个库有经验记录（防止把库 id 写错时无限生成分组）。 */
const MAX_SOURCES = 1000

const TITLE_MAX = 200
const BODY_MAX = 4000
const TAG_MAX = 40
const TAGS_MAX = 12
const ACTION_MAX = 64
const EVIDENCE_MAX = 80

/** stash_lesson_list 的默认与上限条数。 */
export const LESSON_READ_DEFAULT = 20
export const LESSON_READ_MAX = 200

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0

/** 截断到上限，超长时末尾加省略标记（经验是给人读的，不该因为超长整条丢掉）。 */
function clamp(value, max) {
  const text = String(value)
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * 读取经验库。任何异常都不上抛——经验库坏掉不该让工具链瘫掉。
 * @returns {{ groups: Record<string, object[]>, total: number, sources: number, broken: number, file: string }}
 */
export function readLessons() {
  const empty = { groups: {}, total: 0, sources: 0, broken: 0, file: LESSONS_FILE }
  if (!existsSync(LESSONS_FILE)) return empty

  let parsed
  try {
    parsed = JSON.parse(readFileSync(LESSONS_FILE, 'utf8'))
  } catch {
    return { ...empty, broken: 1 }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...empty, broken: 1 }

  const groups = {}
  let total = 0
  let broken = 0
  for (const [sourceId, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) {
      broken += 1
      continue
    }
    const kept = []
    for (const entry of list) {
      if (entry && typeof entry === 'object' && typeof entry.title === 'string') {
        kept.push({
          id: typeof entry.id === 'string' ? entry.id : null,
          at: typeof entry.at === 'string' ? entry.at : null,
          title: entry.title,
          body: typeof entry.body === 'string' ? entry.body : '',
          action: typeof entry.action === 'string' ? entry.action : null,
          tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string') : [],
          evidence: typeof entry.evidence === 'string' ? entry.evidence : null,
        })
      } else {
        broken += 1
      }
    }
    if (kept.length > 0) {
      groups[sourceId] = kept
      total += kept.length
    }
  }
  return { groups, total, sources: Object.keys(groups).length, broken, file: LESSONS_FILE }
}

/** 写回经验库（只写规范化后的形状）。 */
function writeLessons(groups) {
  ensureLibDirs()
  const sorted = {}
  // 按 key 排序，让文件在 diff / 手工整理时稳定可读。
  for (const key of Object.keys(groups).sort()) {
    if (groups[key].length > 0) sorted[key] = groups[key]
  }
  writeFileSync(LESSONS_FILE, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
}

/**
 * 记一条经验。
 *
 * @param {{ source: string, title: string, body?: string, action?: string,
 *           tags?: string[], evidence?: string }} input
 * @returns {{ ok: true, entry: object, file: string, sourceTotal: number, total: number }
 *          | { ok: false, error: string, hint?: string }}
 */
export function addLesson(input) {
  const source = typeof input?.source === 'string' ? input.source.trim() : ''
  if (!isNonEmptyString(source)) {
    return { ok: false, error: '必须给 source（库 id）。', hint: '先跑 stash_catalog 拿到准确的库 id。' }
  }
  if (!isNonEmptyString(input?.title)) {
    return { ok: false, error: '必须给 title（一句话说清这条经验是什么）。' }
  }

  // 密钥扫描：经验正文最容易顺手把口令抄进去，而这是个明文文件。
  const scanTarget = {
    title: input.title,
    body: input.body,
    action: input.action,
    tags: input.tags,
    evidence: input.evidence,
  }
  const hit = findSecretPath(scanTarget)
  if (hit) {
    return {
      ok: false,
      error: `检测到疑似口令/密钥值（字段 ${hit}），已拒绝写入经验库。`,
      hint: '经验库是明文文件。要记钥匙请用 stash_credential_add 登记引用名，值请在「设置 → 钥匙」里填。',
    }
  }

  if (input.action !== undefined && input.action !== null && input.action !== ''
      && (typeof input.action !== 'string' || input.action.length > ACTION_MAX)) {
    return { ok: false, error: `action 必须是字符串且不超过 ${ACTION_MAX} 字符。` }
  }
  if (input.evidence !== undefined && input.evidence !== null && input.evidence !== ''
      && (typeof input.evidence !== 'string' || input.evidence.length > EVIDENCE_MAX)) {
    return { ok: false, error: `evidence 必须是字符串且不超过 ${EVIDENCE_MAX} 字符（通常填台账 ledgerId）。` }
  }

  let tags = []
  if (input.tags !== undefined && input.tags !== null) {
    if (!Array.isArray(input.tags)) return { ok: false, error: 'tags 必须是字符串数组。' }
    if (input.tags.length > TAGS_MAX) return { ok: false, error: `tags 最多 ${TAGS_MAX} 个。` }
    for (const tag of input.tags) {
      if (typeof tag !== 'string' || tag.trim().length === 0) return { ok: false, error: 'tags 里每一项都必须是非空字符串。' }
      if (tag.length > TAG_MAX) return { ok: false, error: `单个标签不超过 ${TAG_MAX} 字符：${tag.slice(0, 40)}…` }
    }
    tags = [...new Set(input.tags.map((tag) => tag.trim()))]
  }

  const { groups } = readLessons()
  const list = groups[source] ?? []
  if (list.length >= MAX_PER_SOURCE) {
    return {
      ok: false,
      error: `库 "${source}" 的经验已有 ${list.length} 条，达到上限 ${MAX_PER_SOURCE}。`,
      hint: `请先整理 ${LESSONS_FILE}（合并同类、删掉过时的），或把过时的那几条用 stash_lesson_remove 删掉。`,
    }
  }
  if (!groups[source] && Object.keys(groups).length >= MAX_SOURCES) {
    return { ok: false, error: `经验库最多容纳 ${MAX_SOURCES} 个库的分组，已达上限。`, hint: '请先整理 lessons.json。' }
  }

  const at = new Date().toISOString()
  const entry = {
    id: createHash('sha256').update(`${at}|${source}|${input.title}`).digest('hex').slice(0, 12),
    at,
    title: clamp(input.title.trim(), TITLE_MAX),
    body: input.body === undefined || input.body === null ? '' : clamp(input.body, BODY_MAX),
    action: isNonEmptyString(input.action) ? clamp(input.action.trim(), ACTION_MAX) : null,
    tags,
    evidence: isNonEmptyString(input.evidence) ? clamp(input.evidence.trim(), EVIDENCE_MAX) : null,
  }

  groups[source] = [...list, entry]
  writeLessons(groups)

  return {
    ok: true,
    entry,
    file: LESSONS_FILE,
    sourceTotal: groups[source].length,
    total: Object.values(groups).reduce((sum, item) => sum + item.length, 0),
  }
}

/**
 * 读经验，最新写的在前。
 * @param {{ source?: string|null, query?: string|null, limit?: number }} [options]
 * @returns {{ ok: true, groups: Array<{source: string, lessons: object[]}>, matched: number,
 *             total: number, sources: number, broken: number, file: string }}
 */
export function listLessons(options = {}) {
  const wanted = isNonEmptyString(options.source) ? options.source.trim() : null
  const needle = isNonEmptyString(options.query) ? options.query.trim().toLowerCase() : null
  const rawLimit = Number(options.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), LESSON_READ_MAX)
    : LESSON_READ_DEFAULT

  const { groups, total, sources, broken, file } = readLessons()
  const out = []
  let matched = 0

  for (const sourceId of Object.keys(groups).sort()) {
    if (wanted && sourceId !== wanted) continue
    let list = [...groups[sourceId]].reverse()
    if (needle) {
      list = list.filter((entry) => [entry.title, entry.body, entry.action, entry.evidence, ...entry.tags]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle)))
    }
    if (list.length === 0) continue
    matched += list.length
    out.push({ source: sourceId, lessons: list.slice(0, limit) })
  }

  return { ok: true, groups: out, matched, total, sources, broken, file }
}

/**
 * 删一条经验。必须同时给 source 与 id——只给 id 会在多个库里误删。
 * @returns {{ ok: true, removed: object, sourceTotal: number, total: number }
 *          | { ok: false, error: string, available?: string[] }}
 */
export function removeLesson({ source, id } = {}) {
  const sourceId = typeof source === 'string' ? source.trim() : ''
  const lessonId = typeof id === 'string' ? id.trim() : ''
  if (!isNonEmptyString(sourceId)) return { ok: false, error: '必须给 source（库 id）。' }
  if (!isNonEmptyString(lessonId)) return { ok: false, error: '必须给 id（经验条目 id）。', available: (readLessons().groups[sourceId] ?? []).map((entry) => entry.id) }

  const { groups } = readLessons()
  const list = groups[sourceId] ?? []
  const index = list.findIndex((entry) => entry.id === lessonId)
  if (index < 0) {
    return {
      ok: false,
      error: `库 "${sourceId}" 下没有 id 为 "${lessonId}" 的经验。`,
      available: list.map((entry) => entry.id),
    }
  }

  const [removed] = list.splice(index, 1)
  if (list.length > 0) groups[sourceId] = list
  else delete groups[sourceId]
  writeLessons(groups)

  return {
    ok: true,
    removed,
    sourceTotal: (groups[sourceId] ?? []).length,
    total: Object.values(groups).reduce((sum, item) => sum + item.length, 0),
  }
}

/**
 * 经验概况，供 stash_doctor 与 stash_catalog 展示。
 * @returns {{ file: string, sources: number, total: number, broken: number,
 *             perSource: Record<string, number>, preview: Record<string, object[]>,
 *             latestAt: string|null }}
 */
export function lessonsStats() {
  const { groups, total, sources, broken, file } = readLessons()
  const perSource = {}
  const preview = {}
  let latestAt = null
  for (const [sourceId, list] of Object.entries(groups)) {
    perSource[sourceId] = list.length
    // 最近写的在前，最多留 3 条标题做预览（避免把整个经验库灌进上下文）。
    preview[sourceId] = [...list]
      .reverse()
      .slice(0, 3)
      .map(({ id, title, at }) => ({ id, title, at }))
    for (const entry of list) {
      if (entry.at && (latestAt === null || entry.at > latestAt)) latestAt = entry.at
    }
  }
  return { file, sources, total, broken, perSource, preview, latestAt }
}

/**
 * 某个库的经验，最新在前；供 stash_catalog 单库查询时带出全文。
 * @param {string} sourceId
 * @returns {object[]}
 */
export function lessonsForSource(sourceId) {
  const { groups } = readLessons()
  return [...(groups[sourceId] ?? [])].reverse()
}
