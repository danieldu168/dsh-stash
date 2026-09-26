/**
 * 按需注入的资源线索。
 *
 * **位置选在 `agent/pre-step`**——每步之前的 waterfall，payload 里带着本轮用户的 `messages`，
 * 返回值可以往这一步的上下文里追加一条消息。harness 自己注入 `AGENTS.md`
 * （`packages/context/agent-instructions`）用的就是同一个接缝。
 *
 * 为什么不放在 `systemPrompt.section`：
 *   · `AssembleContext` 只有 `scope` / `signal`，**看不到用户这一轮说了什么**，只能报静态状态；
 *   · 而且它每步常驻，一直占 token。
 * 放在 `pre-step` 就能**只在相关时注入**：用户这轮提到外部数据、取数、或某个已登记的库，
 * 才把线索递上去；不相关时一个 token 都不加。
 *
 * 为什么不做成 Model Tool：这一段不是"取数"，是"递线索"。真正取数仍由模型调 `stash_fetch` 完成——
 * 只有工具返回值会作为 observation 回到模型，这条分工没变。
 *
 * @module dsh-stash/prompt
 */
import { randomUUID } from 'node:crypto'
import { SOURCES_FILE } from './home.js'
import { FETCH_REFUSED_ACCESS, loadRegistry } from './registry.js'
import { ledgerStats } from './ledger.js'

/** 注入消息的来源标记：用来把自己注入的消息同用户真正说的话区分开。 */
export const INJECTION_SOURCE_KIND = 'dsh-stash'

/** 最多列几个库 id。这一段要让人知道"有东西可查"，不是列全。 */
const MAX_IDS = 12

/** 已注入过的用户消息 id 的记账上限——防一个回合多步重复注入。 */
const MAX_SERVED = 200

/**
 * 取数意图词。刻意保守：宁可漏，不可处处命中——
 * 每命中一次就要往上下文里塞一段话，乱命中等于常驻。
 */
/**
 * 取数意图词。**刻意收得很紧**：只认带动作的短语，不认裸名词。
 *
 * 为什么去掉 `API` / `密钥` / `接口` / `数据库` / `语料` / `台账` 这些裸词：
 * 它们在日常对话里太常见——讨论界面分类时说一句"API 密钥 Y"就会误触发，
 * 把一段资源线索塞进上下文。每命中一次都要花 token，误命中等于常驻噪音。
 *
 * 代价是会漏：只说"那个接口的东西"不会触发。这就是「宁可漏，不可处处命中」。
 * 兜底还有一条更准的路——**点名提到了某条已登记的库**（见 {@link matchLibraries}）。
 */
const INTENT = /(外部数据|外部资源|数据源|取数|取一下|拉取|抓取|调接口|调一下接口|查一下.{0,8}(数据|接口|语料)|帮我查.{0,8}(数据|接口|语料))/i

/**
 * 组装"通用线索"文本（不知道具体是哪条库时用）。
 * 纯函数，便于测试。
 *
 * @param {{ registry?: { sources?: object[] } | null, ledger?: { records?: number, failed?: number } | null }} [input]
 * @returns {string}
 */
export function buildInventoryText({ registry, ledger } = {}) {
  const action = '要取外部数据、账号或凭据时：先 `stash_catalog` 看取数边界与凭据落点，再 `stash_fetch`；'
    + '**不要向用户索要密钥的值**——它由宿主凭据服务保管。'

  const sources = registry?.sources
  if (!Array.isArray(sources)) {
    return `DSH 外部资源库（dsh-stash）：正在读取本机清单。\n${action}`
  }
  if (sources.length === 0) {
    return `DSH 外部资源库（dsh-stash）：本机尚未登记外部资源。登记用 \`stash_source_add\`，或写 ${SOURCES_FILE}。\n${action}`
  }

  const ids = sources.map((source) => source?.id).filter((id) => typeof id === 'string')
  const shown = ids.slice(0, MAX_IDS).join(' / ')
  const more = ids.length > MAX_IDS ? ` 等 ${ids.length} 条` : ''
  const refused = sources.filter((source) => FETCH_REFUSED_ACCESS.has(source?.access ?? '')).length
  const refusedNote = refused > 0
    ? `其中 ${refused} 条只能人工导出（access=export-import/unsupported），\`stash_fetch\` 会拒绝。`
    : ''
  const usage = ledger && Number(ledger.records) > 0
    ? `取数台账 ${ledger.records} 条${Number(ledger.failed) > 0 ? `（失败 ${ledger.failed}）` : ''}。`
    : '取数台账还是空的。'

  return `DSH 外部资源库（dsh-stash）：本机已登记 ${sources.length} 条——${shown}${more}。${refusedNote}\n${action}${usage}`
}

/** 从 claims 里取出用户**真正说的那句话**——跳过 AGENTS.md 与本插件自己注入的消息。 */
export function latestUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    const kind = message.source?.kind
    if (typeof kind === 'string' && kind !== 'user') continue
    const text = (message.content ?? [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

/** 这句话里点到了哪几条已登记的库（按 id 或中文名）。 */
export function matchLibraries(text, sources) {
  if (!text || !Array.isArray(sources)) return []
  const lower = text.toLowerCase()
  const matched = []
  for (const source of sources) {
    const id = typeof source?.id === 'string' ? source.id : ''
    const name = typeof source?.name === 'string' ? source.name : ''
    if (id && lower.includes(id.toLowerCase())) matched.push(source)
    else if (name.length >= 2 && text.includes(name)) matched.push(source)
  }
  return matched
}

/**
 * 决定这一步要不要注入、注入什么。**返回 null 表示不注入。**
 *
 * 三条判据，从严到宽：
 *   1. 这句话点到了某条已登记的库 → 注入那几条的要点；
 *   2. 这句话有取数意图词 → 注入通用线索；
 *   3. 都不是 → 不注入（一个 token 都不加）。
 *
 * @returns {string|null}
 */
export function composeInjection(text, { sources, ledger } = {}) {
  const list = Array.isArray(sources) ? sources : null
  if (list === null) return null

  const matched = matchLibraries(text, list)
  if (matched.length > 0) {
    const lines = [`外部资源线索（dsh-stash）：你这句话提到了 ${matched.map((item) => item.id).join('、')}。`]
    for (const source of matched.slice(0, 4)) {
      const bits = [`id=${source.id}`]
      if (source.name) bits.push(source.name)
      if (source.access) bits.push(`边界 ${source.access}`)
      const refs = (source.credentials ?? []).filter((item) => item?.ref)
      if (refs.length > 0) {
        bits.push(`凭据 ${refs.map((item) => `${item.ref}${item.inject ? `（落点 ${item.inject}）` : ''}`).join('、')}`)
      }
      if (FETCH_REFUSED_ACCESS.has(source.access ?? '')) bits.push('只能人工导出，stash_fetch 会拒绝')
      lines.push(`· ${bits.join(' · ')}`)
    }
    lines.push('取数用 `stash_fetch`；先 `stash_catalog` 可看全量边界与凭据落点。不要向用户索要密钥的值。')
    return lines.join('\n')
  }

  if (INTENT.test(text) && list.length > 0) {
    return buildInventoryText({ registry: { sources: list }, ledger })
  }
  return null
}

/** 造一条可注入的用户角色消息。来源标成自己的 kind，便于下次跳过它。 */
function createReminderMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: INJECTION_SOURCE_KIND, form: 'reminder' }),
  })
}

/**
 * 注册按需注入。
 *
 * 返回 Cordis 的 disposer。注册失败（没有事件总线）时返回空函数，**其余能力不受影响**。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ warn?: (message: string) => void }} [deps]
 * @returns {() => void}
 */
export function registerStashPrompt(ctx, { warn = () => {}, load } = {}) {
  if (!ctx || typeof ctx.on !== 'function') {
    warn('[dsh-stash] 本 ctx 没有事件总线，按需资源线索未注册（其余能力不受影响）')
    return () => {}
  }

  const loadSnapshot = typeof load === 'function'
    ? load
    : async () => {
      const registry = await loadRegistry()
      return { sources: registry?.sources ?? [], ledger: ledgerStats() }
    }

  // 快照：组装路径上绝不 await，读取放后台。读不到就留着旧的，不编。
  let snapshot = { sources: null, ledger: null }
  let inflight = null
  let lastAt = 0

  async function refresh() {
    if (inflight) return inflight
    if (Date.now() - lastAt < 2000) return undefined
    inflight = (async () => {
      try {
        snapshot = await loadSnapshot()
      } catch {
        // 读不出来就留旧快照——线索不该连带弄坏别的东西。
      } finally {
        lastAt = Date.now()
        inflight = null
      }
    })()
    return inflight
  }

  const served = new Set()

  let dispose
  try {
    dispose = ctx.on('agent/pre-step', async ({ messages } = {}, next) => {
      // 先拿到默认决定：别的监听器与驱动自己追加的运行上下文都在里面。
      const decision = typeof next === 'function' ? await next() : undefined
      try {
        if (!decision || decision.kind !== 'enter') return decision

        const userText = latestUserText(messages)
        if (!userText) return decision

        // 一个回合有多个 step，同一条用户消息只注入一次。
        const lastId = messages?.[messages.length - 1]?.id
        const key = typeof lastId === 'string' ? lastId : null
        if (key !== null && served.has(key)) return decision

        const text = composeInjection(userText, snapshot)
        if (text === null) return decision

        if (key !== null) {
          served.add(key)
          if (served.size > MAX_SERVED) served.clear()
        }
        return { ...decision, messages: [...decision.messages, createReminderMessage(text)] }
      } catch {
        // 注入是锦上添花：出任何问题都退回默认决定，绝不挡住这一步。
        return decision
      }
    })
  } catch (error) {
    warn(`[dsh-stash] 按需资源线索注册失败：${error instanceof Error ? error.message : String(error)}`)
    return () => {}
  }

  void refresh()
  return dispose ?? (() => {})
}
