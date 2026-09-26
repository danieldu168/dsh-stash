/**
 * Model Tool 的定义。
 *
 * 这些工具的 description 是模型"每步都看得见"的那一层——所以它们必须说明
 * *有哪类库、什么时候用*，而**不能**试图把库内容塞进来。内容永远按需取。
 *
 * @module dsh-stash/tools
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIB_HOME, CACHE_DIR, CORPUS_DIR, SOURCES_FILE, SOURCES_LOCAL_FILE } from './home.js'
import {
  ACCESS_MODES,
  CREDENTIAL_REF_PATTERN,
  FETCH_REFUSED_ACCESS,
  findSource,
  listLocalEntries,
  loadRegistry,
  upsertLocalEntry,
  validateSourceDeep,
} from './registry.js'
import {
  CATEGORY_IDS,
  CATEGORY_LABELS,
  findAccountByRef,
  loadVault,
  removeVaultAccount,
  upsertVaultAccount,
  validateAccountInput,
} from './vault.js'
import { findSecretPath } from './secrets.js'
import { ledgerStats, ledgerStatsBySource, readLedger, recordFetch, LEDGER_READ_MAX, LEDGER_READ_DEFAULT } from './ledger.js'
import {
  LESSON_READ_DEFAULT,
  LESSON_READ_MAX,
  addLesson,
  lessonsForSource,
  lessonsStats,
  listLessons,
  removeLesson,
} from './lessons.js'
import { describeHandlers, getHandler, listHandlers } from './handlers/index.js'

const text = (...lines) => [{ type: 'text', text: lines.join('\n') }]
const json = (value) => `${JSON.stringify(value, null, 2)}`
const orNull = (value) => (value === undefined ? null : value)

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * 疑似口令值的兜底检测。
 *
 * 用户很自然会想把"账号密码 key token"直接登记进文库——但注册表是明文文件，
 * 会被 git、被备份、被读进模型上下文。所以入口处主动拒绝，并指明正确存放位置。
 *
 * 这里只用**高置信度的厂商前缀特征**，不用"长且随机"这类熵启发式：
 * 后者会把 D:/data/archive-2024-quarterly-report 这种合法路径误判成密钥，
 * 误伤比漏报更糟。凭据引用名另有一条更严的格式约束（全大写 + 下划线）。
 *
 * 实现已抽到 secrets.js —— 浏览器写端点用同一套，避免安全规则两边漂移。
 */

/** 凭据就绪状态：只问"配没配"，不问"值是什么"。 */
async function credentialStatus(credentials, refs) {
  if (!refs || refs.length === 0) return []
  if (!credentials) {
    return refs.map((ref) => ({ ref, configured: null, source: null, writable: null, note: '本部署没有 credentials 服务' }))
  }
  const out = []
  for (const ref of refs) {
    try {
      const info = await credentials.describe(ref)
      out.push({
        ref,
        configured: Boolean(info?.configured),
        source: orNull(info?.source),
        writable: orNull(info?.writable),
      })
    } catch (error) {
      out.push({ ref, configured: null, source: null, writable: null, note: error?.message ?? String(error) })
    }
  }
  return out
}

function statPath(path) {
  try {
    const info = statSync(path)
    return {
      path,
      exists: true,
      kind: info.isDirectory() ? 'directory' : 'file',
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    }
  } catch {
    return { path, exists: false, kind: null, bytes: null, modifiedAt: null }
  }
}

function walkFiles(root, maxFiles, maxDepth = 3) {
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile()) out.push(full)
    }
  }
  walk(root, 0)
  return out
}

/**
 * 构造本包的全部 Model Tool 定义。
 *
 * 刻意不在这里写死工具个数：这个数字曾经漂过（README 写 7、实际 8），
 * 所以注释只说明职责，让数字由 `definitions.length` 自己说话。
 * @param {{
 *   getCredentials: () => any,
 *   logger?: { warn?: (message: string) => void },
 * }} deps
 */
export function buildTools(deps) {
  const { getCredentials, logger } = deps

  return [
    {
      name: 'stash_catalog',
      description: [
        '列出本机已登记的「外部文库」清单：库 id、覆盖范围、可用动作、凭据是否就绪、本地语料文件是否存在。',
        '这里的"文库"指用户登记的外部数据库/资料库/文献库（如贸易统计接口、政策通报、专利导出件、内部案例库）。',
        '要取数前先调用它拿到准确的库 id 与 action 名，再用 stash_fetch 取数；',
        '要查本地语料文件（导出件、案例库）用 stash_files。',
        '库清单由用户维护在 sources.mjs，本工具每次调用都重新读取，所以清单永远是最新的。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '可选：只看某一条库的详情（不要传则返回全部）' },
        },
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          if (!value?.ok) return text(`❌ 文库清单不可用：${value?.error ?? '未知错误'}`, value?.hint ? `提示：${value.hint}` : '')
          const lines = [
            `📚 文库清单（共 ${value.sources.length} 条）  ${value.sourcesFile}`,
            `   文库根目录：${value.libraryHome}`,
          ]
          if (value.problems?.length) lines.push(`   ⚠️ 注册表有 ${value.problems.length} 处问题，见返回值的 problems`)
          lines.push('')
          for (const source of value.sources) {
            const originMark = source.origin === 'handwritten' ? '手写' : '代写'
            lines.push(`• ${source.id} — ${source.name}  [${source.kind} · ${originMark}]`)
            // 越界的后果由下面那行 ⛔ 统一说明，这里只报模式本身，不重复。
            if (source.access) lines.push(`   取数边界：${source.access}`)
            if (source.summary) lines.push(`   ${source.summary}`)
            if (source.coverage) lines.push(`   覆盖：${source.coverage}`)
            const actions = Object.keys(source.actions ?? {})
            if (actions.length) lines.push(`   动作：${actions.join(' / ')}`)
            if (source.requiredParams?.length) lines.push(`   必填参数：${source.requiredParams.join(' / ')}`)
            // 能不能用、不能用的原因——一次说清，省掉一轮试错。
            if (source.ready) lines.push('   ✅ 就绪')
            else for (const blocker of source.blockers ?? []) lines.push(`   ⛔ ${blocker}`)
            if (source.usage?.calls > 0) {
              const when = typeof source.usage.lastAt === 'string'
                ? source.usage.lastAt.replace('T', ' ').slice(0, 16)
                : '时间未知'
              const lastError = source.usage.lastOk === false && source.usage.lastError
                ? `（最近一次失败：${source.usage.lastError.slice(0, 80)}）`
                : ''
              lines.push(`   🕘 用过 ${source.usage.calls} 次，失败 ${source.usage.failures} 次，最近 ${when}${lastError}`)
            }
            for (const credential of source.credentials ?? []) {
              const mark = credential.configured === true ? '✅' : credential.configured === false ? '❌' : '❔'
              // 落点决定值该放哪：env: 只认 $DSH_HOME/.env（面板写了也没用），其余走凭据服务。
              const where = credential.inject
                ? `  · 落点 \`${credential.inject}\`${credential.inject.startsWith('env:') ? '（写 $DSH_HOME/.env，改完要重启；面板对它无效）' : ''}`
                : ''
              // 未配置的后果由上面那行 ⛔ 统一说明，这里只报状态与落点。
              lines.push(`   凭据 ${mark} ${credential.ref}${where}`)
            }
            for (const path of source.paths ?? []) {
              lines.push(`   ${path.exists ? '📄' : '∅'} ${path.path}${path.exists ? `  ${path.bytes} B  ${path.modifiedAt}` : '（不存在）'}`)
            }
            if (source.boundary) lines.push(`   ⛔ 边界：${source.boundary}`)
            for (const note of source.notes ?? []) lines.push(`   📝 ${note}`)
            if (source.lessons?.count > 0) {
              if (source.lessons.entries) {
                lines.push(`   🧠 经验 ${source.lessons.count} 条（踩过的坑与正确写法）：`)
                for (const lesson of source.lessons.entries) {
                  lines.push(`      · ${lesson.title}${lesson.action ? `（action: ${lesson.action}）` : ''}  [${lesson.id}]`)
                  if (lesson.body) for (const bodyLine of lesson.body.split(/\r?\n/)) lines.push(`        ${bodyLine}`)
                  if (lesson.tags?.length) lines.push(`        标签：${lesson.tags.join(' / ')}`)
                  if (lesson.evidence) lines.push(`        证据：${lesson.evidence}`)
                }
              } else {
                lines.push(`   🧠 经验 ${source.lessons.count} 条：${(source.lessons.latest ?? []).map((item) => item.title).join('｜')}`)
                lines.push(`      （要看全文：stash_catalog id="${source.id}" 或 stash_lesson_list source="${source.id}"）`)
              }
            }
          }
          return text(...lines)
        },
      },
      async execute(args) {
        const registry = await loadRegistry({ logger })
        if (registry.fatal) {
          return { ok: false, error: registry.fatal, sourcesFile: registry.sourcesFile, sources: [] }
        }

        const credentials = getCredentials()
        const wanted = typeof args?.id === 'string' && args.id.trim() ? args.id.trim() : null

        let sources = registry.sources
        if (wanted) {
          const found = findSource(registry, wanted)
          if (!found) {
            return {
              ok: false,
              error: `没有 id 为 "${wanted}" 的库`,
              available: registry.sources.map((source) => source.id),
            }
          }
          sources = [found]
        }

        const lessonInfo = lessonsStats()
        // 台账按库汇总。「这条库以前通不通」是决定要不要用的依据，全局统计答不了。
        const usageBySource = ledgerStatsBySource()
        // 落点（inject）是**迁移必需信息**：它决定这把钥匙的值该写 $DSH_HOME/.env 还是写面板，
        // 而这正是"面板一片绿、功能却是断的"那类故障的分界线。值本身永远不在这里出现。
        const injectByRef = new Map()
        try {
          const vault = await loadVault()
          for (const account of vault.accounts ?? []) {
            for (const field of account.fields ?? []) {
              if (field?.ref) injectByRef.set(field.ref, field.inject ?? null)
            }
          }
        } catch {
          // 台账读不出来时降级为"落点未知"，不影响清单本身。
        }
        const enriched = []
        for (const source of sources) {
          // 注意别叫 credentials —— 会遮住外层那个「凭据服务」。
          const credentialEntries = (await credentialStatus(credentials, source.credentials)).map((item) => ({
            ...item,
            inject: injectByRef.get(item.ref) ?? null,
          }))
          const paths = source.kind === 'files' ? source.paths.map(statPath) : []
          const refused = FETCH_REFUSED_ACCESS.has(source.access ?? '')
          const handlerAvailable = source.kind === 'remote' ? Boolean(getHandler(source.handler)) : null

          // 「现在能不能直接用」连同不能的原因一次说清——省掉一轮试错。
          const blockers = []
          if (refused) blockers.push(`access=${source.access}：stash_fetch 会拒绝，只能人工导出 → corpus/`)
          if (handlerAvailable === false) blockers.push(`handler "${source.handler}" 在本插件里没有实现`)
          const missingRefs = credentialEntries.filter((item) => item.configured === false).map((item) => item.ref)
          if (missingRefs.length > 0) blockers.push(`凭据未配置：${missingRefs.join(', ')}`)
          const unknownRefs = credentialEntries.filter((item) => item.configured === null).map((item) => item.ref)
          if (unknownRefs.length > 0) blockers.push(`凭据状态未知（本部署没有 credentials 服务）：${unknownRefs.join(', ')}`)
          const missingPaths = paths.filter((item) => !item.exists).map((item) => item.path)
          // 具体是哪几条路径下面那行会逐条列出，这里只报数。
          if (missingPaths.length > 0) blockers.push(`有 ${missingPaths.length} 条路径不存在（见下）`)

          enriched.push({
            id: source.id,
            name: source.name,
            kind: source.kind,
            handler: orNull(source.handler),
            handlerAvailable,
            summary: source.summary,
            coverage: source.coverage,
            actions: source.actions,
            // 必填参数：调用前就知道要带什么，而不是发出去等上游 400。
            requiredParams: Array.isArray(source.request?.required) ? [...source.request.required] : [],
            notes: source.notes,
            boundary: orNull(source.boundary),
            access: orNull(source.access),
            fetchRefused: refused,
            ready: blockers.length === 0,
            blockers,
            credentials: credentialEntries,
            paths,
            origin: source.origin,
            usage: usageBySource.get(source.id) ?? null,
            // 单库查询时给全文（那一刻正是要动手取数/排查的时候）；
            // 全量清单只给条数与最近 3 条标题，避免把经验库整个灌进上下文。
            lessons: {
              count: lessonInfo.perSource[source.id] ?? 0,
              ...(wanted
                ? { entries: lessonsForSource(source.id) }
                : { latest: lessonInfo.preview[source.id] ?? [] }),
            },
          })
        }

        return {
          ok: true,
          sourcesFile: registry.sourcesFile,
          localFile: registry.localFile ?? SOURCES_LOCAL_FILE,
          libraryHome: LIB_HOME,
          cacheDir: CACHE_DIR,
          corpusDir: CORPUS_DIR,
          lessonsFile: lessonInfo.file,
          lessonsTotal: lessonInfo.total,
          problems: registry.problems,
          handlers: describeHandlers(),
          sources: enriched,
        }
      },
    },

    {
      name: 'stash_fetch',
      description: [
        '从已登记的外部文库确定性地取数。',
        '参数 source 是库 id、action 是动作名，两者都必须先用 stash_catalog 查到。',
        '已知的取数陷阱已被固化成代码保证（例如某接口必须读聚合字段而不是明细、'
        + '必须按 nbPages 翻页、合计不能由逐伙伴求和得出），因此不要绕过本工具去手拼 HTTP 请求。',
        '每次取数都会写一条台账，id 在返回值的 ledgerId 里。引用数据时把 ledgerId 一并报出来，'
        + '这样别人（以及三个月后的你）才能复现这一步依据的是哪一次取数。',
        '声明了 access="export-import" 或 "unsupported" 的库会被本工具拒绝并只留痕——那是使用边界，'
        + '不要绕过它去手拼请求；这类库的数据走人工导出 → corpus/ → stash_files → read。',
        '额外参数放在 params 对象里。结果里的 ok=false 表示失败，error 与 hint 会说明原因和修复方式。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '库 id，例如 trade_stats / policy_alerts' },
          action: { type: 'string', description: '动作名，例如 countries / product / partner / search' },
          params: { type: 'object', description: '动作参数对象，字段见 stash_catalog 的 actions', additionalProperties: true },
          refresh: { type: 'boolean', description: 'true 表示跳过磁盘缓存重新取数（默认用缓存）' },
        },
        required: ['source', 'action'],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(args, value) {
          const head = `📥 stash_fetch  ${args?.source ?? '?'} / ${args?.action ?? '?'}${value?.ledgerId ? `  · 台账 ${value.ledgerId}` : ''}`
          if (!value?.ok) {
            const lines = [
              `${head}`,
              `❌ ${value?.kind ?? 'error'}：${value?.error ?? '未知错误'}`,
            ]
            if (value?.hint) lines.push(`提示：${value.hint}`)
            // 上游回包的正文往往比 hint 精确（例如 PostgREST 用 42703 点名哪一列不存在）。
            // handlers/http.js 已经把它截断到 400 字符并存进失败对象，这里只负责带出来。
            if (value?.body) lines.push(`上游正文：${value.body}`)
            if (value?.available) lines.push(`可用：${value.available.join(' / ')}`)
            // 失败正是"学到东西"的时刻——在这里提示记经验，但不代替使用者决定该不该记。
            if (value?.ledgerId) {
              lines.push(
                `已留痕：台账 ${value.ledgerId}。若这次失败暴露了新的坑（口径 / 参数写法 / 鉴权 / 翻页），`
                + `可用 stash_lesson_add source="${args?.source ?? ''}" 记一条，evidence 填这个 ledgerId。`,
              )
            }
            return text(...lines)
          }
          return text(head, value.summaryText ?? json(value))
        },
      },
      async execute(args) {
        const sourceId = typeof args?.source === 'string' ? args.source.trim() : ''
        const action = typeof args?.action === 'string' ? args.action.trim() : ''
        if (!sourceId || !action) {
          return { ok: false, kind: 'usage', error: 'source 与 action 都是必填', hint: '先用 stash_catalog 查库 id 与动作名。' }
        }

        const registry = await loadRegistry({ logger })
        if (registry.fatal) return { ok: false, kind: 'registry', error: registry.fatal }

        const source = findSource(registry, sourceId)
        if (!source) {
          return {
            ok: false,
            kind: 'unknown-source',
            error: `没有 id 为 "${sourceId}" 的库`,
            available: registry.sources.map((entry) => entry.id),
          }
        }
        if (source.kind !== 'remote') {
          return {
            ok: false,
            kind: 'wrong-kind',
            error: `库 "${sourceId}" 是本地语料（kind=files），不能用 stash_fetch 取数`,
            hint: '改用 stash_files 列出/检索它，或用 read 工具直接读文件。',
          }
        }
        const handler = getHandler(source.handler)
        if (!handler) {
          return {
            ok: false,
            kind: 'no-handler',
            error: `库 "${sourceId}" 声明的 handler "${source.handler}" 在插件里没有实现`,
            hint: `当前可用的 handler：${listHandlers().join(' / ')}。需要新增取数实现时改插件代码，而不是注册表。`,
          }
        }

        const params = args?.params && typeof args.params === 'object' ? { ...args.params } : {}
        if (args?.refresh === true) params.refresh = true

        const startedAt = Date.now()
        const remember = (result, boundary = null) => recordFetch({
          source: sourceId,
          action,
          result,
          params,
          origin: source.origin,
          ms: Date.now() - startedAt,
          boundary,
        })

        // 使用边界：越界不取数，只留痕。文库不只回答"能不能取到"，还要回答"这样取算不算越界"。
        if (FETCH_REFUSED_ACCESS.has(source.access ?? '')) {
          const refused = {
            ok: false,
            kind: 'boundary',
            error: `库 "${sourceId}" 声明了 access="${source.access}"，本插件不代为取数`,
            hint: source.access === 'export-import'
              ? '这条库只允许人工在网页端导出后放进 corpus/，再用 stash_files 登记、read 读取。'
              : '这条库被明确标记为不支持程序取数（条款禁止，或需要绕过访问控制）。',
            boundary: source.boundary || null,
            access: source.access,
          }
          const record = remember(refused, source.access)
          return { ...refused, ledgerId: record?.id ?? null }
        }

        let result
        try {
          result = await handler.run(action, params, { source, credentials: getCredentials() })
        } catch (error) {
          // handler 的约定是"把错误转成结构化结果"，所以走到这里说明实现有 bug。
          // 仍然记一条台账：抛异常也是一次取数尝试。
          const failed = { ok: false, kind: 'exception', error: error?.message ?? String(error) }
          const record = remember(failed)
          return {
            ...failed,
            ledgerId: record?.id ?? null,
            hint: '取数实现抛出了异常，而不是返回结构化失败。这属于 bug，请连台账 id 一起报告。',
          }
        }
        const record = remember(result)
        return {
          ...result,
          ledgerId: record?.id ?? null,
          contentHash: record?.contentHash ?? null,
          // 失败时绝不能是 undefined：undefined 不是 lossless JSON，宿主在输出边界整份拒收，
          // 于是 kind / error / hint / body / ledgerId 一个都到不了调用方——偏偏失败路径最需要它们。
          // 「没有摘要」的正解是 null。
          summaryText: result.ok ? buildSummaryText(sourceId, action, result) : null,
        }
      },
    },

    {
      name: 'stash_files',
      description: [
        '列出本机已登记的本地文库语料：数据库导出件、文档、数据集，以及其他放进去的文献文件。',
        '返回每个文件的绝对路径、大小与修改时间；给出 contains 时还会在文本文件里做子串检索并返回命中行。',
        '它不做内容分析——拿到路径后用 read 工具读具体文件。',
        '登记新目录或新文件在 sources.mjs 的 kind:"files" 条目里。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '可选：只查某一条本地语料库的 id' },
          contains: { type: 'string', description: '可选：在文本文件里做子串检索（不区分大小写）' },
          limit: { type: 'number', description: '可选：最多返回多少个文件 / 命中，默认 100' },
        },
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          if (!value?.ok) return text(`❌ ${value?.error ?? '未知错误'}`, value?.hint ? `提示：${value.hint}` : '')
          const lines = [`🗂 本地文库语料`]
          for (const group of value.groups) {
            lines.push('', `• ${group.id} — ${group.name}`)
            if (group.boundary) lines.push(`   ⛔ ${group.boundary}`)
            if (group.files.length === 0) lines.push('   （没有文件）')
            for (const file of group.files) {
              lines.push(`   ${file.exists ? '📄' : '∅'} ${file.path}${file.exists ? `  ${file.bytes} B` : '（不存在）'}`)
            }
          }
          if (value.search) {
            lines.push('', `🔍 检索 "${value.search.contains}"：命中 ${value.search.matches.length} 行${value.search.truncated ? '（已截断）' : ''}`)
            for (const hit of value.search.matches) {
              lines.push(`   ${hit.path}:${hit.line}  ${hit.text}`)
            }
          }
          return text(...lines)
        },
      },
      async execute(args) {
        const registry = await loadRegistry({ logger })
        if (registry.fatal) return { ok: false, error: registry.fatal }

        const wanted = typeof args?.source === 'string' && args.source.trim() ? args.source.trim() : null
        const contains = typeof args?.contains === 'string' && args.contains.trim()
          ? args.contains.trim().toLowerCase()
          : null
        const limit = Math.min(Math.max(Number(args?.limit ?? 100) || 100, 1), 500)

        let sources = registry.sources.filter((source) => source.kind === 'files')
        if (wanted) {
          const found = sources.find((source) => source.id === wanted)
          if (!found) {
            return {
              ok: false,
              error: `没有 id 为 "${wanted}" 的本地语料库`,
              available: sources.map((source) => source.id),
            }
          }
          sources = [found]
        }

        const groups = []
        const candidates = []
        for (const source of sources) {
          const files = []
          for (const path of source.paths) {
            const info = statPath(path)
            if (!info.exists) {
              files.push(info)
              continue
            }
            if (info.kind === 'file') {
              files.push(info)
              candidates.push({ source: source.id, path })
              continue
            }
            files.push(info)
            for (const child of walkFiles(path, limit)) {
              const childInfo = statPath(child)
              files.push(childInfo)
              candidates.push({ source: source.id, path: child })
            }
          }
          groups.push({ id: source.id, name: source.name, boundary: orNull(source.boundary), files: files.slice(0, limit) })
        }

        let search = null
        if (contains) {
          const matches = []
          let scanned = 0
          let truncated = false
          for (const candidate of candidates) {
            if (matches.length >= limit) {
              truncated = true
              break
            }
            let info
            try {
              info = statSync(candidate.path)
            } catch {
              continue
            }
            if (info.size > 4_000_000) continue
            scanned += 1
            let content
            try {
              content = readFileSync(candidate.path, 'utf8')
            } catch {
              continue
            }
            const lines = content.split(/\r?\n/)
            for (let index = 0; index < lines.length; index += 1) {
              if (!lines[index].toLowerCase().includes(contains)) continue
              matches.push({ source: candidate.source, path: candidate.path, line: index + 1, text: lines[index].slice(0, 300) })
              if (matches.length >= limit) {
                truncated = true
                break
              }
            }
          }
          search = { contains, matches, scannedFiles: scanned, truncated }
        }

        return { ok: true, sourcesFile: registry.sourcesFile, groups, search }
      },
    },

    {
      name: 'stash_ledger',
      description: [
        '取数台账：查"这个库以前取过什么、什么时候取的、取到多大一份、成功还是失败"。',
        '台账**只记指纹不记内容**——每条记录有 contentHash、bytes、count、fetchedAt、状态与 ledgerId，'
        + '没有响应体。要内容本身请用 stash_fetch 再取一次（缓存命中时哈希与台账里那条一致，说明拿到的是同一份数据）。',
        '用途：引用某个数字之前先查它最近是怎么来的；怀疑数据变了就比对两次的 contentHash；'
        + '排查"这个库到底通不通"看失败记录与 kind。',
        'contentHash 相同表示服务端返回的数据逐字节一致（相同则包含相同的 fetchedAt）；它不含 cached，'
        + '所以首次取数与之后命中缓存会得到同一个哈希。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '可选：只看某个库的取数记录' },
          limit: { type: 'number', description: `可选：最多返回多少条，默认 ${LEDGER_READ_DEFAULT}，上限 ${LEDGER_READ_MAX}` },
          onlyFailed: { type: 'boolean', description: '可选：只看失败的记录（含被使用边界拒绝的）' },
        },
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          if (!value?.ok) return text(`❌ 台账不可用：${value?.error ?? '未知错误'}`)
          const lines = [
            `🧾 取数台账（文件共 ${value.total} 条，命中 ${value.matched} 条，显示 ${value.records.length} 条）`,
            `   ${value.file}`,
          ]
          if (value.broken > 0) lines.push(`   ⚠️ 有 ${value.broken} 行无法解析，已跳过`)
          if (value.records.length === 0) lines.push('', '（没有匹配的记录。台账从安装本版本起才开始记。）')
          for (const record of value.records) {
            const mark = record.ok ? '✅' : '❌'
            lines.push('')
            lines.push(`${mark} ${record.at}  ${record.source} / ${record.action}  · ${record.id}`)
            const facts = [
              record.cacheHit ? '缓存命中' : '实际请求',
              record.status === null ? null : `HTTP ${record.status}`,
              record.bytes === null ? null : `${record.bytes} B`,
              record.count === null ? null : `${record.count} 条`,
              record.ms === null ? null : `${record.ms} ms`,
              `哈希 ${record.contentHash}`,
            ].filter(Boolean)
            lines.push(`   ${facts.join(' · ')}`)
            if (record.fetchedAt) lines.push(`   上游取数时刻：${record.fetchedAt}`)
            if (!record.ok) lines.push(`   失败 kind=${record.kind}：${record.error ?? ''}`)
            if (record.boundary) lines.push(`   ⛔ 因 access="${record.boundary}" 被拒绝，未发出请求`)
            if (record.paramsRedacted) lines.push('   参数命中密钥特征，台账未记录原文')
          }
          return text(...lines)
        },
      },
      async execute(args) {
        try {
          const ledger = readLedger({
            source: typeof args?.source === 'string' ? args.source : null,
            limit: args?.limit,
            onlyFailed: args?.onlyFailed === true,
          })
          return { ok: true, ...ledger }
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) }
        }
      },
    },

    {
      name: 'stash_lesson_add',
      description: [
        '把这条库踩过的坑、摸清的口径记下来，按库 id 存进经验库（~/.dsh/stash/lessons.json），下次 stash_catalog 会带出来。',
        '用途：取数失败后记下"为什么失败、正确写法是什么"；或把一条已确认的口径固定住，免得下次重算。',
        '只存你写的文本，**不存密钥**——正文会过一遍密钥特征扫描，命中即拒绝。',
        '手写 sources.mjs 里的库同样能记（经验库独立于注册表，两类库一视同仁）。',
        '各库的经验形态本就不同，所以除 title 外全是可选的，**不设分类、不设枚举**——判断内容属于使用它的人。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '库 id（必填，必须是已登记的库；先跑 stash_catalog 拿准确 id）' },
          title: { type: 'string', description: '一句话说清这条经验是什么（必填），如「byProduct 的 records 是兄弟 HS 码，不是答案」' },
          body: { type: 'string', description: '可选：细节。现象、原因、正确写法、复现步骤都可以' },
          action: { type: 'string', description: '可选：这条经验针对哪个 action' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选：自由标签，如 ["口径","翻页"]。不设枚举' },
          evidence: { type: 'string', description: '可选：关联证据，通常填台账 ledgerId（stash_ledger 返回的 id）' },
        },
        required: ['source', 'title'],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          if (!value?.ok) return text(`❌ 没能记下：${value?.error ?? '未知错误'}`, value?.hint ? `提示：${value.hint}` : '')
          const lines = [
            `🧠 已记入经验库：${value.entry.title}`,
            `   所属库：${value.source}（该库共 ${value.sourceTotal} 条 · 全库 ${value.total} 条）`,
            `   条目 id：${value.entry.id}`,
          ]
          if (value.entry.action) lines.push(`   针对 action：${value.entry.action}`)
          if (value.entry.tags.length > 0) lines.push(`   标签：${value.entry.tags.join(' / ')}`)
          if (value.entry.evidence) lines.push(`   证据：${value.entry.evidence}`)
          lines.push(`   文件：${value.file}`)
          return text(...lines)
        },
      },
      async execute(args) {
        const registry = await loadRegistry({ logger })
        if (registry.fatal) return { ok: false, error: registry.fatal }
        const available = registry.sources.map((source) => source.id).join(', ') || '（无）'
        const wanted = typeof args?.source === 'string' ? args.source.trim() : ''
        if (!wanted) return { ok: false, error: '必须给 source（库 id）。', hint: `已登记的库：${available}` }
        if (!findSource(registry, wanted)) {
          return {
            ok: false,
            error: `没有 id 为 "${wanted}" 的库——经验只挂在已登记的库上。`,
            hint: `已登记的库：${available}`,
          }
        }
        const result = addLesson({ ...args, source: wanted })
        if (!result.ok) return result
        return { ...result, source: wanted }
      },
    },

    {
      name: 'stash_lesson_list',
      description: [
        '读经验库：某个库（或全部库）记过哪些坑与正确写法。',
        '用途：动手取数之前先看一眼这条库有什么已知陷阱；或检查自己写过的经验对不对。',
        'query 是**子串匹配**（不区分大小写），不是语义检索——它不该被当成"文库检索"用。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '可选：只看某个库' },
          query: { type: 'string', description: '可选：在标题/正文/action/标签/证据里做子串过滤' },
          limit: { type: 'number', description: `可选：每个库最多显示多少条，默认 ${LESSON_READ_DEFAULT}，上限 ${LESSON_READ_MAX}` },
        },
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          if (!value?.ok) return text(`❌ 经验库不可用：${value?.error ?? '未知错误'}`)
          const lines = [
            `🧠 经验库（全库 ${value.total} 条 · ${value.sources} 个库${value.matched === value.total ? '' : ` · 命中 ${value.matched} 条`}）`,
            `   ${value.file}`,
          ]
          if (value.broken > 0) lines.push(`   ⚠️ 有 ${value.broken} 处无法解析，已跳过`)
          if (value.groups.length === 0) lines.push('', '（没有匹配的经验。经验库从 0.8.0 起才开始记。）')
          for (const group of value.groups) {
            lines.push('', `• ${group.source}`)
            for (const lesson of group.lessons) {
              lines.push(`   · ${lesson.title}  [${lesson.id}]${lesson.at ? `  ${lesson.at}` : ''}`)
              if (lesson.action) lines.push(`     针对 action：${lesson.action}`)
              if (lesson.body) for (const line of lesson.body.split(/\r?\n/)) lines.push(`     ${line}`)
              if (lesson.tags.length > 0) lines.push(`     标签：${lesson.tags.join(' / ')}`)
              if (lesson.evidence) lines.push(`     证据：${lesson.evidence}`)
            }
          }
          return text(...lines)
        },
      },
      async execute(args) {
        try {
          return listLessons({
            source: typeof args?.source === 'string' ? args.source : null,
            query: typeof args?.query === 'string' ? args.query : null,
            limit: args?.limit,
          })
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) }
        }
      },
    },

    {
      name: 'stash_lesson_remove',
      description: [
        '从经验库里删掉一条记错的或过时的经验。必须同时给 source 与 id——只给 id 会在多个库里误删。',
        '经验写错了比没写更糟（下次会照着错的做法来），所以删除路径是必要的，不是可选项。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '库 id（必填）' },
          id: { type: 'string', description: '经验条目 id（必填），可从 stash_catalog / stash_lesson_list 看到' },
        },
        required: ['source', 'id'],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          if (!value?.ok) {
            const lines = [`❌ 没能删除：${value?.error ?? '未知错误'}`]
            const ids = (value?.available ?? []).filter(Boolean)
            if (ids.length > 0) lines.push(`   该库现有条目 id：${ids.join(', ')}`)
            return text(...lines)
          }
          return text(
            `🗑️ 已删除经验：${value.removed.title}`,
            `   ${value.removed.id}（该库剩余 ${value.sourceTotal} 条 · 全库 ${value.total} 条）`,
          )
        },
      },
      async execute(args) {
        try {
          return removeLesson({ source: args?.source, id: args?.id })
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) }
        }
      },
    },

    {
      name: 'stash_source_add',
      description: [
        '在对话里登记一个新的「外部文库」，写入 ~/.dsh/stash/sources.local.json（不动手写的 sources.mjs）。',
        '两种用法：kind="files" 登记本地文件或目录（给 paths）；kind="remote" 登记远程接口'
        + '（普通 REST 用 handler="http" + request 描述，无需写代码；trade_stats/policy_alerts 是内置专用实现）。',
        'credentials 里只能填凭据的**引用名**（如 MY_API_KEY），绝不能填口令值——口令请放到 ~/.dsh/.credentials.yaml。',
        '被登记进注册表的参数都会进入模型上下文，所以不要把任何密钥、token、密码写进来；本工具会主动拒绝疑似密钥的值。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '唯一标识，小写字母/数字/-/_，如 customs_db' },
          name: { type: 'string', description: '展示名' },
          kind: { type: 'string', enum: ['remote', 'files'], description: 'remote 远程接口 / files 本地文件或目录' },
          handler: { type: 'string', enum: ['http', 'trade_stats', 'policy_alerts'], description: 'kind=remote 时必填' },
          request: {
            type: 'object',
            description: 'handler=http 时的取数描述：{ url, method, query, headers, body, pick, limit, required, minGapMs, paginate }。'
              + '值里用 {参数名} 代入调用参数、用 {credential:引用名} 注入凭据。',
            additionalProperties: true,
          },
          paths: { type: 'array', items: { type: 'string' }, description: 'kind=files 时的本地路径数组' },
          credentials: { type: 'array', items: { type: 'string' }, description: '凭据引用名数组（不是值！）' },
          access: {
            type: 'string',
            enum: ACCESS_MODES,
            description: '使用边界。public-api 公开免登录可直连；official-api 需官方 API/授权凭据；'
              + 'export-import 只能人工导出后放 corpus（会被 stash_fetch 拒绝）；unsupported 明确不做。'
              + '不填表示未声明，取数放行但 stash_doctor 会提示补上。',
          },
          summary: { type: 'string', description: '一句话说明这个库是什么' },
          coverage: { type: 'string', description: '覆盖范围，如年份区间、字段、条数' },
          actions: { type: 'object', description: '动作名 → 说明', additionalProperties: true },
          notes: { type: 'array', items: { type: 'string' }, description: '注意事项' },
          boundary: { type: 'string', description: '明确的禁止边界' },
          overwrite: { type: 'boolean', description: 'true 时覆盖同 id 的既有代写条目' },
        },
        required: ['id', 'name', 'kind'],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          if (!value?.ok) return text(`❌ 登记失败：${value?.error ?? '未知错误'}`, value?.hint ? `提示：${value.hint}` : '')
          return text(
            `✅ 已登记文库 "${value.entry.id}" — ${value.entry.name}`,
            `写入：${value.localFile}`,
            `当前共 ${value.totalSources} 个文库（含手写注册表）。`,
            value.reminder ? `\n⚠️ ${value.reminder}` : '',
          )
        },
      },
      async execute(args) {
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
          return { ok: false, error: 'id 不合法', hint: '只允许小写字母、数字、- 和 _，且不能以符号开头。例：customs_db' }
        }

        // 防呆 0：credentials 只接受"环境变量风格"的引用名 —— 口令不会长这样。
        for (const ref of Array.isArray(args?.credentials) ? args.credentials : []) {
          if (typeof ref !== 'string' || !CREDENTIAL_REF_PATTERN.test(ref)) {
            return {
              ok: false,
              error: `credentials 里的 ${JSON.stringify(ref)} 不是合法的凭据引用名`,
              hint: '引用名必须是全大写字母/数字/下划线的环境变量风格，例如 MY_API_KEY、MY_ACCOUNT。'
                + '如果你填的是口令本身，请改成引用名，并把真实值写进 ~/.dsh/.credentials.yaml 的 refs 段。',
            }
          }
        }

        // 防呆 1：疑似口令值一律拒收。
        const secretPath = findSecretPath({
          id,
          name: args?.name,
          summary: args?.summary,
          coverage: args?.coverage,
          credentials: args?.credentials,
          notes: args?.notes,
          boundary: args?.boundary,
          paths: args?.paths,
          request: args?.request,
        })
        if (secretPath) {
          return {
            ok: false,
            error: `检测到疑似口令/密钥值（字段 ${secretPath}），已拒绝登记`,
            hint: '注册表是明文文件，会被备份、被 git、并进入模型上下文。'
              + '请只在 credentials 里填引用名（如 MY_API_KEY），把真实值写进 ~/.dsh/.credentials.yaml 的 refs 段。',
          }
        }

        const registry = await loadRegistry({ logger })
        if (registry.fatal) return { ok: false, error: registry.fatal }

        const existing = findSource(registry, id)
        if (existing && args?.overwrite !== true) {
          return {
            ok: false,
            error: `已存在 id 为 "${id}" 的库（来源：${existing.origin === 'handwritten' ? '手写 sources.mjs' : '代写 json'}）`,
            hint: existing.origin === 'handwritten'
              ? '手写文件里的条目以你为准，程序不改写它。请换个 id，或自己编辑 sources.mjs。'
              : '传 overwrite:true 覆盖代写条目。',
          }
        }

        const entry = { id, name: args.name, kind: args.kind }
        for (const key of ['handler', 'request', 'paths', 'credentials', 'summary', 'coverage', 'actions', 'notes', 'boundary', 'access']) {
          if (args?.[key] !== undefined) entry[key] = args[key]
        }

        // 防呆 2：会导致取数失败的条目在登记前就拒收。
        // "注册表写错了"和"上游挂了"是两件事，不该长得一样。
        const normalized = {
          id,
          kind: entry.kind,
          handler: entry.handler ?? null,
          request: entry.request ?? null,
          paths: Array.isArray(entry.paths) ? entry.paths : [],
          credentials: Array.isArray(entry.credentials) ? entry.credentials : [],
          access: typeof entry.access === 'string' && entry.access ? entry.access : null,
        }
        if (normalized.access !== null && !ACCESS_MODES.includes(normalized.access)) {
          return { ok: false, error: `access 只能是 ${ACCESS_MODES.join(' / ')}`, hint: '不填表示未声明。' }
        }
        const deepErrors = validateSourceDeep(normalized).filter((issue) => issue.level === 'error')
        if (deepErrors.length > 0) {
          return {
            ok: false,
            error: `登记被拒绝：条目有 ${deepErrors.length} 处会让取数失败的问题`,
            problems: deepErrors.map((issue) => issue.message),
            hint: '这些问题不会自己变好，只会在真正取数时才炸——先修好再登记。',
          }
        }

        try {
          upsertLocalEntry(entry)
        } catch (error) {
          return { ok: false, error: `写入失败：${error?.message ?? String(error)}`, localFile: SOURCES_LOCAL_FILE }
        }

        const after = await loadRegistry({ logger })
        const added = findSource(after, id)
        return {
          ok: true,
          entry: { id, name: entry.name, kind: entry.kind },
          localFile: SOURCES_LOCAL_FILE,
          totalSources: after.sources.length,
          validationProblems: after.problems,
          handlerImplemented: entry.kind === 'remote' ? Boolean(getHandler(entry.handler)) : null,
          reminder: entry.credentials?.length
            ? `该库声明了凭据 ${entry.credentials.join(', ')}。请把对应的值写进 ~/.dsh/.credentials.yaml 的 refs 段，否则 stash_fetch 会报"凭据未配置"。`
            : (added ? '' : '注意：登记后重新加载时该条目未被接受，请查看 validationProblems。'),
        }
      },
    },

    {
      name: 'stash_doctor',
      description: [
        '文库本地体检：注册表能不能加载、有没有语法/字段问题、目录是否可写、每个库的 handler 是否已实现、'
        + '凭据是否已配置、本地语料路径是否存在、缓存目录里有多少文件、取数台账有多少条。',
        '它还会做**条目深度校验**：能加载但注定取不到数的写法（request.url 写错、'
        + '{credential:REF} 用的引用名没在 credentials 里声明、required 的参数没出现在请求里、'
        + 'paths 不是绝对路径、没声明 access 使用边界）都在这里报出来，'
        + '而不是等真正取数时才炸——"注册表写错了"和"上游挂了"是两件事。',
        '它只做本地检查，**不联网**——要验证接口连通性就直接调用 stash_fetch。',
        '文库出现任何异常时先跑它，比自己翻文件快。',
      ].join(' '),
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          const lines = [
            `${value.healthy ? '✅' : '⚠️'} 文库体检：${value.healthy ? '全部正常' : '发现问题'}`,
            `   注册表：${value.sourcesFile}`,
            `   代写分片：${value.localFile}`,
            `   目录可写：${value.dirsWritable ? '是' : '否'}`,
            `   缓存文件：${value.cacheFiles} 个`,
            `   取数台账：${value.fetchLedger.records} 条`
              + `${value.fetchLedger.failed > 0 ? `（失败 ${value.fetchLedger.failed}）` : ''}`
              + `${value.fetchLedger.last ? ` · 最近 ${value.fetchLedger.last.at}` : ''}`,
            `   钥匙台账：${value.ledger.accounts} 个账号 / ${value.ledger.fields} 个字段`
              + `（已配置 ${value.ledger.configured}${value.ledger.missing ? ` · 未配置 ${value.ledger.missing}` : ''}`
              + `${value.ledger.handwritten > 0 ? ` · 手写 ${value.ledger.handwritten} 条（界面只读）` : ''}）`,
            `   经验库：${value.lessons.total} 条 · ${value.lessons.sources} 个库`
              + `${value.lessons.latestAt ? ` · 最近 ${value.lessons.latestAt}` : ''}`,
          ]
          for (const check of value.sources) {
            const marks = [
              check.handlerImplemented === null ? null : (check.handlerImplemented ? 'handler ✅' : 'handler ❌未实现'),
              check.credentials.length > 0
                ? `凭据 ${check.credentials.filter((c) => c.configured === true).length}/${check.credentials.length} 已配置`
                : '免凭据',
              check.missingPaths.length > 0 ? `路径缺失 ${check.missingPaths.length} 个 ❌` : null,
            ].filter(Boolean)
            lines.push(`• ${check.id} [${check.kind}] ${marks.join(' · ')}`)
            for (const credential of check.credentials) {
              if (credential.configured !== true) lines.push(`    ❌ 凭据 ${credential.ref} 未配置`)
            }
            for (const path of check.missingPaths) lines.push(`    ❌ 路径不存在：${path}`)
          }
          for (const issue of value.deepIssues ?? []) {
            lines.push(`${issue.level === 'error' ? '❌' : '⚠️'} ${issue.message}`)
          }
          for (const problem of value.problems) lines.push(`⚠️ ${problem}`)
          for (const gap of value.lessonGaps ?? []) {
            lines.push(
              `⚠️ ${gap.source} 有 ${gap.failures} 次失败取数却没记经验——`
              + `用 stash_lesson_add 记一条，下次就不用再踩一遍。`,
            )
          }
          return text(...lines)
        },
      },
      async execute() {
        const registry = await loadRegistry({ logger })

        let dirsWritable = true
        const probe = join(CACHE_DIR, '.write-probe')
        try {
          writeFileSync(probe, 'ok', 'utf8')
          rmSync(probe, { force: true })
        } catch {
          dirsWritable = false
        }

        let cacheFiles = 0
        try {
          cacheFiles = readdirSync(CACHE_DIR).length
        } catch {
          cacheFiles = 0
        }

        const credentials = getCredentials()
        const checks = []
        for (const source of registry.sources) {
          const statuses = []
          for (const ref of source.credentials) {
            let configured = null
            try {
              configured = credentials ? Boolean((await credentials.describe(ref))?.configured) : null
            } catch {
              configured = null
            }
            statuses.push({ ref, configured })
          }
          checks.push({
            id: source.id,
            kind: source.kind,
            origin: source.origin,
            handler: source.handler ?? null,
            handlerImplemented: source.kind === 'remote' ? Boolean(getHandler(source.handler)) : null,
            credentials: statuses,
            missingPaths: source.paths.filter((path) => !existsSync(path)),
          })
        }

        // 钥匙台账（账号 + 字段）也纳入体检：台账读不出来时面板会空白，这属于"有问题"。
        const vault = await loadVault()
        const ledgerFields = vault.accounts.flatMap((account) => account.fields)
        let ledgerConfigured = 0
        let ledgerMissing = 0
        for (const field of ledgerFields) {
          let configured = null
          try {
            configured = credentials ? Boolean((await credentials.describe(field.ref))?.configured) : null
          } catch {
            configured = null
          }
          if (configured === true) ledgerConfigured += 1
          if (configured === false) ledgerMissing += 1
        }
        const ledger = {
          accounts: vault.accounts.length,
          fields: ledgerFields.length,
          configured: ledgerConfigured,
          missing: ledgerMissing,
          unknown: ledgerFields.length - ledgerConfigured - ledgerMissing,
          handwritten: vault.accounts.filter((account) => account.origin === 'handwritten').length,
        }

        const problems = [...registry.problems, ...vault.problems]
        // 深度问题是"能加载但取不到数"，与结构问题分开报；只有 error 级影响 healthy。
        const deepIssues = registry.deepIssues ?? []
        const deepErrors = deepIssues.filter((issue) => issue.level === 'error')

        // 经验库体检：失败台账是"证据"，经验是"结论"。有证据却没结论的库，
        // 下次还会以同样的方式失败一遍——所以在这里点出来。
        // 只影响提示，不影响 healthy：经验是补充，不是健康条件。
        const lessons = lessonsStats()
        const recentFailures = readLedger({ onlyFailed: true, limit: LEDGER_READ_MAX })
        const failedBySource = {}
        for (const record of recentFailures.records) {
          if (typeof record.source !== 'string') continue
          failedBySource[record.source] = (failedBySource[record.source] ?? 0) + 1
        }
        const lessonGaps = Object.keys(failedBySource)
          .filter((sourceId) => !((lessons.perSource[sourceId] ?? 0) > 0))
          .sort()
          .map((sourceId) => ({ source: sourceId, failures: failedBySource[sourceId] }))

        const healthy = !registry.fatal
          && problems.length === 0
          && deepErrors.length === 0
          && dirsWritable
          && checks.every((check) =>
            check.handlerImplemented !== false
            && check.missingPaths.length === 0
            && check.credentials.every((credential) => credential.configured !== false))

        return {
          healthy,
          fatal: registry.fatal ?? null,
          sourcesFile: SOURCES_FILE,
          localFile: SOURCES_LOCAL_FILE,
          libraryHome: LIB_HOME,
          corpusDir: CORPUS_DIR,
          dirsWritable,
          cacheFiles,
          problems,
          deepIssues,
          deepErrors: deepErrors.length,
          handlers: listHandlers(),
          sources: checks,
          ledger,
          fetchLedger: ledgerStats(),
          lessons,
          lessonGaps,
          lessonGapWindow: LEDGER_READ_MAX,
          note: '本地体检，不联网。要验证接口连通性直接调用 stash_fetch。',
        }
      },
    },

    {
      name: 'stash_credential_add',
      description: [
        '往「钥匙台账」登记一条账号条目：**一个网站 / API / MCP 服务 = 一条**，条目下面是若干"字段"。',
        '每个字段对应一个凭据引用名（= 宿主凭据库里的一条值）。三件套就写成三个字段，而不是三条目录。',
        '两种用法：单字段账号给 ref (+ fieldLabel/secret/inject/multiline)；多字段账号给 fields: [{ ref, label?, secret?, inject?, multiline? }]。',
        'inject 是"值该注入到哪里"（env:FOO_API_KEY / header:Authorization / query:key / file:/path），登记它模型才知道配好之后怎么用；它不是值。',
        '典型用法：用户说"我有个 XX 网站的账号，帮我登记"，你建条目 → 「设置 → 钥匙」页出现一条「未配置」→ 用户自己在界面上贴值。',
        '⚠️ 本工具**没有 value 参数，也永远不会有**：密钥的值只能由用户在浏览器里输入，经宿主凭据服务单向写入。',
        '值一旦经过 tool 参数就会写进会话记录并发送给模型服务商——这是机械后果，不是策略偏好。所以不要试图把值塞进 notes 或 url（会被密钥特征扫描拦下）。',
        '也不要登记"账号名/手机号/邮箱"这类标识：如果它在你的场景里算机密（把账号名当密钥存），它就该是另一个引用名，而不是台账里的一行文本。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '账号 id（小写字母/数字/-/_，如 bid_portal）。省略时由 ref 或 label 派生；编辑既有条目时要给对。' },
          label: { type: 'string', description: '中文可读名（如「某招标网站」），面板上显示的就是它' },
          category: { type: 'string', enum: CATEGORY_IDS, description: `类别：${CATEGORY_IDS.map((id) => `${id}=${CATEGORY_LABELS[id]}`).join('、')}` },
          url: { type: 'string', description: '可选：相关网址（如 https://bid.example.com）' },
          notes: { type: 'string', description: '可选：非机密提示（如「用读者卡手机号登录」）。绝不要写口令。' },
          usedBy: { type: 'array', items: { type: 'string' }, description: '可选：关联的库 id 数组（库里已声明的不必重复）' },
          ref: { type: 'string', description: '单字段账号的引用名，全大写字母/数字/下划线（如 BID_PORTAL_PASSWORD）。与 fields 二选一。' },
          fieldLabel: { type: 'string', description: '单字段账号时该字段的显示名（如「密码」）' },
          secret: { type: 'boolean', description: '单字段账号时：这个字段是不是机密（默认 true）。像"代理地址"这种非机密配置填 false。' },
          inject: { type: 'string', description: '单字段账号时：注入点，如 env:FOO_API_KEY / header:Authorization / query:key / file:/path' },
          multiline: { type: 'boolean', description: '单字段账号时：值是否多行（PEM 私钥、service account JSON）' },
          fields: {
            type: 'array',
            description: '多字段账号的字段表：[{ ref, label?, secret?, inject?, multiline?, notes? }]',
            items: { type: 'object', additionalProperties: true },
          },
          overwrite: { type: 'boolean', description: 'true 时覆盖同 id 的既有代写条目（手写台账里的条目不会被覆盖）' },
        },
        required: ['label', 'category'],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          if (!value?.ok) return text(`❌ 登记失败：${value?.error ?? '未知错误'}`, value?.hint ? `提示：${value.hint}` : '')
          return text(
            `✅ 已登记钥匙条目「${value.entry.label}」(${value.entry.id}) · ${value.entry.categoryLabel}`,
            `   字段：${value.entry.fields.map((f) => `${f.label}=${f.ref}${f.secret ? '' : '（非机密）'}${f.inject ? ` → ${f.inject}` : ''}`).join(' · ')}`,
            `写入：${value.vaultFile}`,
            `当前台账共 ${value.totalAccounts} 个账号 / ${value.totalFields} 个字段。`,
            '',
            '下一步（需要用户本人操作）：打开「设置 → 钥匙」展开该条目，在相应字段上粘贴值。',
            '模型无法也不应该接触该值。',
          )
        },
      },
      async execute(args) {
        const input = { ...(args ?? {}) }
        const overwrite = input.overwrite === true
        delete input.overwrite

        // 单字段写法：把 ref / fieldLabel / secret / inject / multiline 折进 fields，
        // 之后下游只认一种形状（= 账号 + 字段表）。
        if (!Array.isArray(input.fields)) {
          if (typeof input.ref === 'string' && input.ref.trim()) {
            input.fields = [{
              ref: input.ref,
              label: input.fieldLabel ?? input.label,
              secret: input.secret,
              inject: input.inject,
              multiline: input.multiline,
            }]
          } else {
            return { ok: false, error: '至少要有一个字段：给 ref（单字段），或给 fields 数组（多字段）。' }
          }
        }
        for (const key of ['ref', 'fieldLabel', 'secret', 'inject', 'multiline']) delete input[key]

        // 校验与浏览器写端点共用 validateAccountInput —— 安全规则不能两边各写一套
        const validated = validateAccountInput(input)
        if (validated.error) return { ok: false, error: validated.error, hint: validated.hint }
        const account = validated.account

        const vault = await loadVault()
        const existing = vault.accounts.find((item) => item.id === account.id)
        if (existing && existing.origin === 'handwritten' && !overwrite) {
          return {
            ok: false,
            error: `账号 "${account.id}" 已在手写的 sources.mjs 台账里`,
            hint: '手写文件以你为准，程序不改写它。请直接编辑 sources.mjs，或换一个账号 id。',
          }
        }

        const clash = vault.accounts.find((item) => item.id !== account.id
          && item.fields.some((field) => account.fields.some((mine) => mine.ref === field.ref)))
        if (clash) {
          const dup = clash.fields.find((field) => account.fields.some((mine) => mine.ref === field.ref))
          return {
            ok: false,
            error: `引用名 ${dup.ref} 已经属于账号 "${clash.id}"`,
            hint: '一个引用名只能属于一个账号。要往已有账号里加字段，用那个账号的 id 再登记一次（字段会并进去）。',
          }
        }

        try {
          upsertVaultAccount(account, vault.accounts)
        } catch (error) {
          return { ok: false, error: `写入失败：${error?.message ?? String(error)}` }
        }

        const after = await loadVault()
        return {
          ok: true,
          entry: {
            id: account.id,
            label: account.label,
            category: account.category,
            categoryLabel: CATEGORY_LABELS[account.category],
            fields: account.fields.map((field) => ({
              ref: field.ref,
              label: field.label,
              secret: field.secret,
              inject: field.inject,
            })),
          },
          vaultFile: SOURCES_LOCAL_FILE,
          totalAccounts: after.accounts.length,
          totalFields: after.accounts.reduce((sum, item) => sum + item.fields.length, 0),
          problems: after.problems,
        }
      },
    },

    {
      name: 'stash_credential_remove',
      description: [
        '从「钥匙台账」删除代写内容：给 id 删整条账号，给 ref 只删那个字段。',
        '⚠️ 它**不会**删除宿主凭据库里的值——清值请在「设置 → 钥匙」页点该字段的「移除值」，那走的是凭据服务，只有用户本人能做。',
        '手写 sources.mjs 里的条目删不掉：那是用户的文件，请让他自己编辑。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的账号 id（删整条）' },
          ref: { type: 'string', description: '要删除的字段引用名（只删这个字段；若它是账号里最后一个字段，整条账号一起删）' },
        },
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          if (!value?.ok) return text(`❌ ${value?.error ?? '未知错误'}`, value?.hint ? `提示：${value.hint}` : '')
          return text(
            value.removedRef
              ? `✅ 已从账号「${value.id}」删除字段 ${value.removedRef}`
              : `✅ 已删除账号「${value.id}」`,
            `剩余台账：${value.totalAccounts} 个账号 / ${value.totalFields} 个字段`,
            value.valueStillStored ? 'ℹ️ 宿主凭据库里的值仍然存在——要清掉请在「设置 → 钥匙」里点「移除值」。' : '',
          )
        },
      },
      async execute(args) {
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        const ref = typeof args?.ref === 'string' ? args.ref.trim() : ''
        if (!id && !ref) return { ok: false, error: '需要 id（删整条账号）或 ref（删一个字段）' }

        const vault = await loadVault()
        const account = id
          ? vault.accounts.find((item) => item.id === id)
          : findAccountByRef(vault.accounts, ref)
        if (!account) {
          return {
            ok: false,
            error: id ? `台账里没有账号 "${id}"` : `台账里没有引用名 "${ref}"`,
            hint: `当前账号：${vault.accounts.map((item) => item.id).join(', ') || '（空）'}`,
          }
        }
        if (account.origin === 'handwritten') {
          return {
            ok: false,
            error: `账号 "${account.id}" 在手写的 sources.mjs 台账里，程序不改写它`,
            hint: '请让用户自己编辑 sources.mjs 删掉那一条。',
          }
        }

        try {
          if (ref) {
            const rest = account.fields.filter((field) => field.ref !== ref)
            if (rest.length === 0) removeVaultAccount(account.id, vault.accounts)
            else {
              upsertVaultAccount(
                {
                  id: account.id,
                  label: account.label,
                  category: account.category,
                  url: account.url,
                  notes: account.notes,
                  usedBy: account.usedBy,
                  fields: rest,
                },
                vault.accounts,
              )
            }
          } else {
            removeVaultAccount(account.id, vault.accounts)
          }
        } catch (error) {
          return { ok: false, error: `删除失败：${error?.message ?? String(error)}` }
        }

        const after = await loadVault()
        return {
          ok: true,
          id: account.id,
          removedRef: ref || null,
          valueStillStored: true,
          totalAccounts: after.accounts.length,
          totalFields: after.accounts.reduce((sum, item) => sum + item.fields.length, 0),
        }
      },
    },
  ]
}

/** 给 stash_fetch 的成功结果拼一段可读摘要（结构化值仍完整返回）。 */
function buildSummaryText(sourceId, action, result) {
  const lines = []
  if (sourceId === 'trade_stats' && action === 'countries') {
    lines.push(`匹配 ${result.matched} / ${result.totalCountries} 个国家，返回前 ${result.returned} 条${result.cached ? '（缓存）' : ''}`)
    for (const row of result.rows ?? []) {
      lines.push(`  ${row.code}  ${row.label}  可用年份 ${row.firstPeriod}-${row.lastPeriod}`)
    }
    if (result.note) lines.push(`ℹ️ ${result.note}`)
  } else if (sourceId === 'trade_stats' && result.header) {
    const h = result.header
    lines.push(`${h.reporterLabel} (${h.reporter}) · HS${h.hsLevel} ${h.product} · ${h.flow} · ${h.indicator} ${h.currency} · ${h.year}`)
    lines.push(`数据来源：${(result.provenance ?? []).join(' / ') || 'n/a'}${result.cached ? '（缓存）' : ''}`)
    if (action === 'product') {
      lines.push(`合计 ${h.product} = ${Number(result.total).toLocaleString('en-US')} ${h.unit}`)
      if (result.siblings?.length) {
        lines.push('（同期返回的兄弟编码，不是答案：' + result.siblings.map((s) => `${s.productCd}=${Number(s.value).toLocaleString('en-US')}`).join('，') + '）')
      }
    } else if (action === 'partner') {
      lines.push(`合计 = ${Number(result.total).toLocaleString('en-US')} ${h.unit}（取自 aggregateRecords，勿用逐伙伴求和）`)
      for (const row of result.rows ?? []) {
        lines.push(`  ${row.partnerCd} ${row.partnerLabel}  ${Number(row.value).toLocaleString('en-US')}  ${row.sharePct}%`)
      }
      lines.push(`  已列 ${result.returnedPartners} 个伙伴，小计 ${Number(result.shownSubtotal).toLocaleString('en-US')}`)
    }
  } else if (sourceId === 'policy_alerts') {
    lines.push(`全库 ${result.totalCount} 条，抓取 ${result.fetched} 条，命中 ${result.matched} 条（${result.pagesFetched} 页）`)
    for (const item of (result.items ?? []).slice(0, 20)) {
      lines.push(`  ${item.distributionDate?.slice(0, 10) ?? '?'}  ${item.area}  ${item.notifyingMember}  ${item.documentSymbol ?? ''}`)
      if (item.title) lines.push(`      ${item.title.slice(0, 140)}`)
    }
    if (result.filterScopeNote) lines.push(`⚠️ ${result.filterScopeNote}`)
  } else {
    lines.push(json(result).slice(0, 4000))
  }
  return lines.join('\n')
}
