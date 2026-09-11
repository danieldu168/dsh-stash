/**
 * 三个 Model Tool 的定义。
 *
 * 这三个工具的 description 是模型"每步都看得见"的那一层——所以它们必须说明
 * *有哪类库、什么时候用*，而**不能**试图把库内容塞进来。内容永远按需取。
 *
 * @module dsh-stash/tools
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIB_HOME, CACHE_DIR, CORPUS_DIR, SOURCES_FILE, SOURCES_LOCAL_FILE } from './home.js'
import { loadRegistry, findSource, listLocalEntries, upsertLocalEntry, CREDENTIAL_REF_PATTERN } from './registry.js'
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
 * 构造三个工具定义。
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
            if (source.summary) lines.push(`   ${source.summary}`)
            if (source.coverage) lines.push(`   覆盖：${source.coverage}`)
            const actions = Object.keys(source.actions ?? {})
            if (actions.length) lines.push(`   动作：${actions.join(' / ')}`)
            for (const credential of source.credentials ?? []) {
              const mark = credential.configured === true ? '✅' : credential.configured === false ? '❌' : '❔'
              lines.push(`   凭据 ${mark} ${credential.ref}${credential.configured === false ? '（未配置，取数会失败）' : ''}`)
            }
            for (const path of source.paths ?? []) {
              lines.push(`   ${path.exists ? '📄' : '∅'} ${path.path}${path.exists ? `  ${path.bytes} B  ${path.modifiedAt}` : '（不存在）'}`)
            }
            if (source.boundary) lines.push(`   ⛔ 边界：${source.boundary}`)
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

        const enriched = []
        for (const source of sources) {
          enriched.push({
            id: source.id,
            name: source.name,
            kind: source.kind,
            handler: orNull(source.handler),
            handlerAvailable: source.kind === 'remote' ? Boolean(getHandler(source.handler)) : null,
            summary: source.summary,
            coverage: source.coverage,
            actions: source.actions,
            notes: source.notes,
            boundary: orNull(source.boundary),
            credentials: await credentialStatus(credentials, source.credentials),
            paths: source.kind === 'files' ? source.paths.map(statPath) : [],
            origin: source.origin,
          })
        }

        return {
          ok: true,
          sourcesFile: registry.sourcesFile,
          localFile: registry.localFile ?? SOURCES_LOCAL_FILE,
          libraryHome: LIB_HOME,
          cacheDir: CACHE_DIR,
          corpusDir: CORPUS_DIR,
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
          const head = `📥 stash_fetch  ${args?.source ?? '?'} / ${args?.action ?? '?'}`
          if (!value?.ok) {
            return text(
              `${head}`,
              `❌ ${value?.kind ?? 'error'}：${value?.error ?? '未知错误'}`,
              value?.hint ? `提示：${value.hint}` : '',
              value?.available ? `可用：${value.available.join(' / ')}` : '',
            )
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

        const result = await handler.run(action, params, { source, credentials: getCredentials() })
        return {
          ...result,
          summaryText: result.ok ? buildSummaryText(sourceId, action, result) : undefined,
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
        for (const key of ['handler', 'request', 'paths', 'credentials', 'summary', 'coverage', 'actions', 'notes', 'boundary']) {
          if (args?.[key] !== undefined) entry[key] = args[key]
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
        + '凭据是否已配置、本地语料路径是否存在、缓存目录里有多少文件。',
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
            `   钥匙台账：${value.ledger.accounts} 个账号 / ${value.ledger.fields} 个字段`
              + `（已配置 ${value.ledger.configured}${value.ledger.missing ? ` · 未配置 ${value.ledger.missing}` : ''}`
              + `${value.ledger.handwritten > 0 ? ` · 手写 ${value.ledger.handwritten} 条（界面只读）` : ''}）`,
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
          for (const problem of value.problems) lines.push(`⚠️ ${problem}`)
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

        const healthy = !registry.fatal
          && problems.length === 0
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
          handlers: listHandlers(),
          sources: checks,
          ledger,
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
