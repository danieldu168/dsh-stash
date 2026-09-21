/**
 * 贸易统计取数处理器：公开 JSON 接口，免登录。
 *
 * 这个文件存在的唯一理由：把四个"会算错数"的坑从"文档里的叮嘱"变成"代码里的保证"。
 *
 *   坑 1  product 必填            —— 缺它返回 HTTP 400，这里在发请求前就拦下。
 *   坑 2  records 是兄弟码        —— byProduct 必须读 aggregateRecords；
 *                                    读 records 会拿到隔壁 HS 码（实测 020220/020210）。
 *   坑 3  byPartner 需要翻页      —— 实测 nbPages=2（25+2=27 条），这里自动拼页。
 *   坑 4  伙伴值各自舍入          —— 实测伙伴之和 713,750 ≠ 合计 713,748（舍入差）。
 *                                    所以合计只取 aggregateRecords，绝不求和。
 *
 * 全部数值已在本机实测复现（2026 复核）：
 *   中国 020230 2025 进口 VAL = 12,893,515 千美元（中国海关总署）
 *   阿联酋 020230 2024 进口合计 = 713,748（巴西 463,753 / 印度 161,224 / 美国 47,252）
 *
 * @module dsh-stash/handlers/trade_stats
 */
import { fetchJson, SourceHttpError } from '../http.js'

const BASE = 'https://www.trademap.org/api'
const HOST = 'www.trademap.org'
/** 免费无鉴权接口：保持人类级调用频率。 */
const MIN_GAP_MS = 1500
const COUNTRIES_CACHE = 'trade-stats-countries.json'
const FLOWS = new Set(['I', 'E'])
const INDICATORS = new Set(['VAL', 'QTY'])
const CURRENCIES = new Set(['USD', 'EUR'])
const HS_LEVELS = new Set(['2', '4', '6', '10'])

export const GUARANTEES = [
  'product 缺失在发请求前拦截，不依赖 HTTP 400 才发现',
  'byProduct 只读 aggregateRecords 作为该编码的合计；records 仅作为兄弟码参考列出',
  'byPartner 按 nbPages 自动拼全部页，不只看第一页',
  '合计一律取 aggregateRecords，从不用逐伙伴求和（避免逐项舍入误差）',
]

export const ACTIONS = {
  countries: '列出/搜索国别码与各国可用年份区间（254 条，带磁盘缓存）',
  product: '单个 HS 编码在某报告国的合计（含同期返回的兄弟编码对照）',
  partner: '单个 HS 编码在某报告国的逐伙伴国明细，按金额降序并给出份额',
}

const fail = (kind, error, hint) => ({ ok: false, kind, error, hint: hint ?? null })
const orNull = (value) => (value === undefined ? null : value)
const str = (value) => (value === undefined || value === null ? '' : String(value).trim())

/** 规范化并校验参数；返回 { error } 或 { params }。 */
function normalize(raw) {
  const params = {
    reporter: str(raw.reporter),
    partner: str(raw.partner) || '000',
    product: str(raw.product),
    hsLevel: str(raw.hsLevel) || '6',
    flow: str(raw.flow) || 'I',
    indicator: str(raw.indicator) || 'VAL',
    currency: str(raw.currency) || 'USD',
    year: str(raw.year),
  }
  if (!params.reporter) return { error: fail('usage', '缺少 reporter（报告国数字码）', '例：156 中国、784 阿联酋、842 美国。先用 action=countries 查码。') }
  if (!params.product) return { error: fail('usage', '缺少 product（HS 编码）', '这是该接口的必填项，缺它会 HTTP 400。') }
  if (!/^\d{4}$/.test(params.year)) return { error: fail('usage', `year 必须是 4 位年份，实际是 "${params.year}"`, '先用 action=countries 查该国的可用年份区间（逐年不同）。') }
  if (!FLOWS.has(params.flow)) return { error: fail('usage', `flow 只能是 I（进口）或 E（出口），实际是 "${params.flow}"`) }
  if (!INDICATORS.has(params.indicator)) return { error: fail('usage', `indicator 只能是 VAL（金额）或 QTY（数量），实际是 "${params.indicator}"`) }
  if (!CURRENCIES.has(params.currency)) return { error: fail('usage', `currency 只能是 USD 或 EUR，实际是 "${params.currency}"`) }
  if (!HS_LEVELS.has(params.hsLevel)) return { error: fail('usage', `hsLevel 只能是 2/4/6/10，实际是 "${params.hsLevel}"`) }
  return { params }
}

function buildUrl(kind, params, page) {
  const url = new URL(`${BASE}/goods/timeSeries/yearly/${kind}`)
  const query = {
    country: params.reporter,
    partner: params.partner,
    product: params.product,
    hsLevel: params.hsLevel,
    tradeFlow: params.flow,
    indicator: params.indicator,
    directMirror: 'D',
    currency: params.currency,
    periodFrom: params.year,
    periodTo: params.year,
  }
  if (page > 1) query.page = String(page)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

/** 摊平 aggregateRecords / records 为统一点集。 */
function points(records) {
  const out = []
  for (const record of records ?? []) {
    for (const point of record?.data ?? []) {
      out.push({
        productCd: str(record.productCd),
        partnerCd: str(record.partnerCd),
        period: orNull(point?.period),
        value: Number(point?.value ?? 0),
        flag: orNull(point?.flag),
      })
    }
  }
  return out
}

function provenanceOf(payload) {
  return (payload?.sources ?? [])
    .map((source) => source?.labelEn)
    .filter((label) => typeof label === 'string' && label.length > 0)
}

function labelFor(code, table) {
  const row = table.find((item) => str(item?.countryCd) === code)
  return row ? str(row.label) || code : code
}

function toFailure(error, hint) {
  if (error instanceof SourceHttpError) {
    return fail('http', `${error.message}${error.url ? ` @ ${error.url}` : ''}`, error.hint || hint)
  }
  return fail('internal', error?.message ?? String(error), hint)
}

async function loadCountries(refresh) {
  const response = await fetchJson(`${BASE}/countries`, {
    cache: COUNTRIES_CACHE,
    refresh,
    minGapMs: MIN_GAP_MS,
    host: HOST,
  })
  return { table: Array.isArray(response.data) ? response.data : [], meta: response }
}

/** 按 nbPages 取全部页，返回 { first, records, pages }。 */
async function loadAllPages(kind, params, refresh) {
  const first = await fetchJson(buildUrl(kind, params, 1), { refresh, minGapMs: MIN_GAP_MS, host: HOST })
  const payload = first.data ?? {}
  const all = [...(payload.records ?? [])]
  const pages = Math.max(1, Number(payload.nbPages ?? 1))
  for (let page = 2; page <= pages; page += 1) {
    const next = await fetchJson(buildUrl(kind, params, page), { refresh, minGapMs: MIN_GAP_MS, host: HOST })
    all.push(...(next.data?.records ?? []))
  }
  return { first: payload, records: all, pages, cached: first.cached, fetchedAt: first.fetchedAt }
}

function headerFor(params, reporterLabel, table) {
  return {
    reporter: params.reporter,
    reporterLabel,
    partner: params.partner,
    partnerLabel: labelFor(params.partner, table),
    product: params.product,
    hsLevel: params.hsLevel,
    flow: params.flow === 'I' ? 'import' : 'export',
    indicator: params.indicator,
    currency: params.currency,
    year: params.year,
    unit: params.indicator === 'VAL' ? 'USD thousand' : 'tonnes',
  }
}

async function runCountries(raw) {
  const search = str(raw.search).toLowerCase()
  const limit = Math.min(Math.max(Number(raw.limit ?? 40) || 40, 1), 254)
  try {
    const { table, meta } = await loadCountries(Boolean(raw.refresh))
    const filtered = search
      ? table.filter((row) => str(row?.label).toLowerCase().includes(search))
      : table
    return {
      ok: true,
      source: 'trade_stats',
      action: 'countries',
      totalCountries: table.length,
      matched: filtered.length,
      returned: Math.min(limit, filtered.length),
      rows: filtered.slice(0, limit).map((row) => ({
        code: str(row?.countryCd),
        label: str(row?.label),
        firstPeriod: orNull(row?.yearly246?.firstPeriod),
        lastPeriod: orNull(row?.yearly246?.lastPeriod),
      })),
      cached: meta.cached,
      fetchedAt: meta.fetchedAt,
      note: '取数前先看 lastPeriod：各国报送进度不同，最新年份常为空，需要退回上一年。',
    }
  } catch (error) {
    return toFailure(error, '检查网络；该接口需直连（不要走代理）。')
  }
}

async function runProduct(raw) {
  const normalized = normalize(raw)
  if (normalized.error) return normalized.error
  const params = normalized.params
  try {
    const { table } = await loadCountries(false)
    const { first, records, pages, cached, fetchedAt } = await loadAllPages('byProduct', params, Boolean(raw.refresh))

    // 坑 2：只有 aggregateRecords 是本编码的合计。
    const aggregate = points(first.aggregateRecords)
    const total = aggregate.length > 0 ? aggregate[0].value : 0
    const siblings = points(records).sort((a, b) => b.value - a.value)

    return {
      ok: true,
      source: 'trade_stats',
      action: 'product',
      header: headerFor(params, labelFor(params.reporter, table), table),
      total,
      aggregate: aggregate.map((point) => ({ productCd: point.productCd, period: point.period, value: point.value, flag: point.flag })),
      siblings: siblings.map((point) => ({ productCd: point.productCd, value: point.value })),
      siblingNote: 'siblings 是接口同时返回的兄弟 HS 码，仅供参考，不是本编码的答案。',
      provenance: provenanceOf(first),
      pages,
      cached,
      fetchedAt,
      guarantees: GUARANTEES,
    }
  } catch (error) {
    return toFailure(error, '检查网络；该接口需直连（不要走代理）。')
  }
}

async function runPartner(raw) {
  const normalized = normalize(raw)
  if (normalized.error) return normalized.error
  const params = normalized.params
  const top = Math.max(0, Number(raw.top ?? 0) || 0)
  try {
    const { table } = await loadCountries(false)
    const { first, records, pages, cached, fetchedAt } = await loadAllPages('byPartner', params, Boolean(raw.refresh))

    const aggregate = points(first.aggregateRecords)
    const total = aggregate.length > 0 ? aggregate[0].value : 0

    let rows = points(records)
      .filter((point) => point.partnerCd !== '000')
      .map((point) => ({
        partnerCd: point.partnerCd,
        partnerLabel: labelFor(point.partnerCd, table),
        value: point.value,
        sharePct: total > 0 ? Number(((point.value / total) * 100).toFixed(3)) : 0,
      }))
      .sort((a, b) => b.value - a.value)

    if (top > 0) rows = rows.slice(0, top)
    const shownSubtotal = rows.reduce((sum, row) => sum + row.value, 0)

    return {
      ok: true,
      source: 'trade_stats',
      action: 'partner',
      header: headerFor(params, labelFor(params.reporter, table), table),
      total,
      totalNote: 'total 取自 aggregateRecords。不要用 rows 求和代替它——逐伙伴值各自舍入到千美元，'
        + '实测同伴之和会与合计差 2 个单位。',
      returnedPartners: rows.length,
      shownSubtotal,
      rows,
      provenance: provenanceOf(first),
      pages,
      cached,
      fetchedAt,
      guarantees: GUARANTEES,
    }
  } catch (error) {
    return toFailure(error, '检查网络；该接口需直连（不要走代理）。')
  }
}

/** 处理器入口：action 分发。 */
export async function run(action, params = {}) {
  switch (action) {
    case 'countries':
      return runCountries(params)
    case 'product':
      return runProduct(params)
    case 'partner':
      return runPartner(params)
    default:
      return fail(
        'unknown-action',
        `不认识动作 "${action}"`,
        `可用动作：${Object.keys(ACTIONS).join(' / ')}`,
      )
  }
}
