/**
 * 政策通报预警（TBT/SPS）取数处理器。免登录、公开 JSON 接口。
 *
 * 实测确认的接口事实（2026 复核，本机直连）：
 *   端点   https://epingalert.org/api/v1/azureSearch/getAll
 *   可用   language=1 · distributionDateFrom · distributionDateTo · page（1 起）· pageSize
 *   被忽略 currentPage · startRow · area · notifyingMember · searchText
 *          —— 后三个传了也返回同一批数据（firstId 不变），所以筛选只能客户端做。
 *
 * 因此本处理器的诚实边界：**筛选作用于已抓取的窗口，不是全库**。结果里会带
 * filterScopeNote 和 matched/fetched/totalCount 三个数，避免把窗口内命中误读为全库命中。
 *
 * @module dsh-stash/handlers/policy_alerts
 */
import { fetchJson, SourceHttpError } from '../http.js'

const ENDPOINT = 'https://epingalert.org/api/v1/azureSearch/getAll'
const HOST = 'epingalert.org'
const MIN_GAP_MS = 1000
const MAX_LIMIT = 200
/** 单次调用最多抓几页，防止一次工具调用打太多请求。 */
const MAX_PAGES = 5

export const GUARANTEES = [
  '分页用实测有效的 page 参数（1 起），不用被服务器忽略的 currentPage',
  '筛选在客户端对已抓取窗口进行，并显式回报窗口大小与全库总量，不伪装成全库筛选',
  'items 只保留可引用的关键字段，避免把 120KB 原始响应灌进上下文',
]

export const ACTIONS = {
  search: '按通报分发日期区间检索 TBT/SPS 通报；可按 area / member / keyword 在已抓取窗口内过滤',
}

const fail = (kind, error, hint) => ({ ok: false, kind, error, hint: hint ?? null })
const orNull = (value) => (value === undefined ? null : value)
const str = (value) => (value === undefined || value === null ? '' : String(value).trim())
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 摊平该接口的数组字段。实测形状：
 *   hsCodes   [{ id, code, name }]   → 用 code
 *   objectives[{ id, name }]         → 用 name
 *   keywords  [{ id, name }]         → 用 name
 * 直接 str() 会把它们变成 "[object Object]"。
 */
function flatten(value, key = 'name') {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object') return str(entry[key] ?? entry.code ?? entry.name) || null
        return str(entry) || null
      })
      .filter((part) => part !== null && part !== '')
    return parts.length > 0 ? parts.join('; ').slice(0, 600) : null
  }
  return str(value) || null
}

function trimItem(item) {
  return {
    id: str(item?.id),
    area: str(item?.area),
    notificationType: str(item?.notificationType),
    documentSymbol: str(item?.documentSymbol).trim() || null,
    notifyingMember: str(item?.notifyingMember) || null,
    notifyingMemberCode: str(item?.notifyingMemberCode) || null,
    distributionDate: str(item?.distributionDate) || null,
    commentDeadlineDate: str(item?.commentDeadlineDate) || null,
    title: str(item?.title).slice(0, 600) || null,
    hsCodes: flatten(item?.hsCodes, 'code'),
    objectives: flatten(item?.objectives, 'name'),
    keywords: flatten(item?.keywords, 'name'),
    linkToNotification: str(item?.linkToNotification) || null,
  }
}

function matches(item, { area, member, keyword }) {
  if (area && str(item?.area).toUpperCase() !== area) return false
  if (member && !str(item?.notifyingMember).toLowerCase().includes(member)) return false
  if (keyword) {
    const haystack = [
      item?.title,
      item?.description,
      item?.keywords,
      item?.documentSymbol,
      item?.productsFreeText,
    ].map(str).join(' ').toLowerCase()
    if (!haystack.includes(keyword)) return false
  }
  return true
}

function pageUrl({ from, to }, page, pageSize) {
  const url = new URL(ENDPOINT)
  url.searchParams.set('language', '1')
  url.searchParams.set('distributionDateFrom', from)
  url.searchParams.set('distributionDateTo', to)
  if (page > 1) url.searchParams.set('page', String(page))
  if (pageSize !== 20) url.searchParams.set('pageSize', String(pageSize))
  return url.toString()
}

async function runSearch(raw) {
  const from = str(raw.from)
  const to = str(raw.to)
  const area = str(raw.area).toUpperCase()

  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return fail('usage', 'from / to 必须是 YYYY-MM-DD 格式', `实际收到 from="${from}" to="${to}"`)
  }
  if (from > to) {
    return fail('usage', 'from 不能晚于 to', `from=${from} to=${to}`)
  }
  if (area && area !== 'SPS' && area !== 'TBT') {
    return fail('usage', `area 只能是 SPS 或 TBT，实际是 "${area}"`, '省略该参数表示不按领域过滤。')
  }

  const limit = Math.min(Math.max(Number(raw.limit ?? 40) || 40, 1), MAX_LIMIT)
  const pageSize = Math.min(100, limit)
  const member = str(raw.member).toLowerCase()
  const keyword = str(raw.keyword).toLowerCase()
  const filtering = Boolean(member || keyword || area)

  try {
    const collected = []
    let totalCount = 0
    let isCountExceeded = null
    let pagesFetched = 0
    let cached = false
    let facets = { areas: [], notifyingMembers: [] }

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await fetchJson(pageUrl({ from, to }, page, pageSize), {
        refresh: Boolean(raw.refresh),
        minGapMs: MIN_GAP_MS,
        host: HOST,
      })
      const payload = response.data ?? {}
      pagesFetched = page
      cached = response.cached
      totalCount = Number(payload.totalCount ?? 0)
      isCountExceeded = orNull(payload.isCountExceeded)

      if (page === 1) {
        facets = {
          areas: (payload.areas ?? []).slice(0, 20).map((facet) => ({
            name: str(facet?.name),
            count: orNull(facet?.count),
          })),
          notifyingMembers: (payload.notifyingMembers ?? []).slice(0, 20).map((facet) => ({
            name: str(facet?.displayName ?? facet?.name),
            count: orNull(facet?.count),
          })),
        }
      }

      const items = Array.isArray(payload.items) ? payload.items : []
      collected.push(...items)
      if (items.length < pageSize) break
      if (collected.length >= limit) break
      if (totalCount > 0 && collected.length >= totalCount) break
    }

    const window = collected.slice(0, limit)
    const matched = filtering ? window.filter((item) => matches(item, { area, member, keyword })) : window

    return {
      ok: true,
      source: 'policy_alerts',
      action: 'search',
      query: { from, to, area: area || null, member: member || null, keyword: keyword || null, limit },
      totalCount,
      isCountExceeded,
      pagesFetched,
      fetched: window.length,
      matched: matched.length,
      returned: matched.length,
      filterScopeNote: filtering
        ? `筛选只作用于已抓取的 ${window.length} 条（全库 ${totalCount} 条）。若要更大范围命中，请收窄日期区间或提高 limit。`
        : null,
      facets,
      items: matched.map(trimItem),
      cached,
      guarantees: GUARANTEES,
    }
  } catch (error) {
    if (error instanceof SourceHttpError) {
      return fail('http', `${error.message}${error.url ? ` @ ${error.url}` : ''}`, error.hint)
    }
    return fail('internal', error?.message ?? String(error), '检查网络连通性。')
  }
}

/** 处理器入口。 */
export async function run(action, params = {}) {
  switch (action) {
    case 'search':
      return runSearch(params)
    default:
      return fail(
        'unknown-action',
        `不认识动作 "${action}"`,
        `可用动作：${Object.keys(ACTIONS).join(' / ')}`,
      )
  }
}
