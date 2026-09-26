/**
 * 给浏览器半边用的凭据端点。
 *
 *   GET    /stash/credentials              只读：账号台账 + 库声明合并后的清单、统计、类别表、库清单
 *   POST   /stash/credentials              新建/替换一条账号（JSON body：{ account, fields } 或旧形状单字段对象）
 *   PATCH  /stash/credentials              只改元数据（body 必须带 id）；默认**不许删掉已配置的字段**
 *   DELETE /stash/credentials?id=xx        删除整条代写账号（?force=1 才能连带已配置字段一起删）
 *   DELETE /stash/credentials?ref=XX       从所属账号里删掉一个字段（同样需要 force=1）
 *
 * ⛔ 这些方法**都绝不接触密钥值**：
 *    - GET 只用 credentials.describe()，而凭据服务本身没有回值方法；
 *    - POST/PATCH/DELETE 只写台账元数据，校验用 validateAccountInput，
 *      与 Model Tool 同一套规则（含厂商密钥特征扫描，且显式拒绝 value 字段）。
 *    值的唯一路径是浏览器 → ctx.remote.credentials.set()，不经过本端点。
 *
 * ⚠️ 必须由 `ctx.inject(['webServer'], (hostCtx) => ...)` 注册（不能在 apply 时 ctx.get）。
 *
 * @module dsh-stash/credential-route
 */
import { LIB_HOME, SOURCES_FILE, SOURCES_LOCAL_FILE } from './home.js'
import { clearRefFromEnv, mirrorRefToEnv } from './credential-store.js'
import { loadRegistry } from './registry.js'
import {
  CATEGORY_LABELS,
  buildLedger,
  computeStats,
  findAccountByRef,
  loadVault,
  removeVaultAccount,
  upsertVaultAccount,
  validateAccountInput,
} from './vault.js'

export const CREDENTIAL_ROUTE_PATH = '/stash/credentials'
const MAX_BODY_BYTES = 16 * 1024

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function registerCredentialRoute(hostCtx, { getCredentials } = {}) {
  const webServer = hostCtx?.webServer
    ?? (typeof hostCtx?.get === 'function' ? hostCtx.get('webServer') : undefined)
  if (!webServer || typeof webServer.register !== 'function') return null
  const ctx = hostCtx

  const send = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /** 读请求体，带大小上限。 */
  const readBody = (req) => new Promise((resolve) => {
    let size = 0
    const chunks = []
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    try {
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) { done({ error: `请求体超过 ${MAX_BODY_BYTES} 字节上限` }); return }
        chunks.push(chunk)
      })
      req.on('end', () => done({ text: Buffer.concat(chunks).toString('utf8') }))
      req.on('error', (error) => done({ error: error instanceof Error ? error.message : String(error) }))
    } catch (error) {
      done({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  const parseBody = async (req) => {
    const body = await readBody(req)
    if (body.error) return { error: body.error }
    try {
      return { parsed: JSON.parse(body.text || '{}') }
    } catch {
      return { error: '请求体不是合法 JSON' }
    }
  }

  const resolveCredentials = () => (typeof getCredentials === 'function'
    ? getCredentials()
    : (typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined))

  /** 问凭据服务这些 ref 里哪些已经有值了（只问配没配，不问值）。 */
  const configuredRefs = async (refs) => {
    const credentials = resolveCredentials()
    if (!credentials) return []
    const out = []
    for (const ref of refs) {
      try {
        if ((await credentials.describe(ref))?.configured === true) out.push(ref)
      } catch {
        // describe 失败按"未知"处理，不谎报
      }
    }
    return out
  }

  /** 同一个引用名不能属于两个账号：冲突就拒绝写入。 */
  const findRefConflict = (accounts, account) => {
    for (const existing of accounts) {
      if (existing.id === account.id) continue
      for (const field of existing.fields) {
        if (account.fields.some((item) => item.ref === field.ref)) {
          return { ref: field.ref, id: existing.id, origin: existing.origin ?? 'local' }
        }
      }
    }
    return null
  }

  const upsertFromParsed = async (parsed) => {
    const validated = validateAccountInput(parsed)
    if (validated.error) return { status: 400, payload: { ok: false, error: validated.error, hint: validated.hint } }
    const account = validated.account

    const vault = await loadVault()
    const existing = vault.accounts.find((item) => item.id === account.id)
    if (existing && existing.origin === 'handwritten') {
      return {
        status: 409,
        payload: {
          ok: false,
          error: `账号 ${account.id} 已在手写的 sources.mjs 台账里`,
          hint: '手写文件以你为准，程序不改写它。请直接编辑 sources.mjs，或换一个账号 id。',
        },
      }
    }

    const conflict = findRefConflict(vault.accounts, account)
    if (conflict) {
      return {
        status: 409,
        payload: {
          ok: false,
          error: `引用名 ${conflict.ref} 已经属于账号 ${conflict.id}`,
          hint: '一个引用名只能属于一个账号。请把它从原账号里删掉，或换个引用名。',
        },
      }
    }

    try {
      upsertVaultAccount(
        {
          id: account.id,
          label: account.label,
          category: account.category,
          url: account.url,
          notes: account.notes,
          usedBy: account.usedBy,
          fields: account.fields,
        },
        vault.accounts,
      )
    } catch (error) {
      return { status: 500, payload: { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` } }
    }

    const after = await loadVault()
    return {
      status: 200,
      payload: {
        ok: true,
        id: account.id,
        created: !existing,
        totalAccounts: after.accounts.length,
        totalFields: after.accounts.reduce((sum, item) => sum + item.fields.length, 0),
        vaultFile: SOURCES_LOCAL_FILE,
      },
    }
  }

  const handleCreate = async (req, res) => {
    const body = await parseBody(req)
    if (body.error) return send(res, 400, { ok: false, error: body.error })
    const result = await upsertFromParsed(body.parsed)
    return send(res, result.status, result.payload)
  }

  /**
   * 只改元数据。刻意**不**允许把已配置的字段悄悄删掉——那会留下一个没人认领的值。
   * 真要删，传 dropConfigured: true。
   */
  const handlePatch = async (req, res) => {
    const body = await parseBody(req)
    if (body.error) return send(res, 400, { ok: false, error: body.error })
    const parsed = isPlainObject(body.parsed) ? body.parsed : {}
    const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
    if (!id) return send(res, 400, { ok: false, error: 'PATCH 必须带 id' })

    const vault = await loadVault()
    const existing = vault.accounts.find((item) => item.id === id)
    if (!existing) return send(res, 404, { ok: false, error: `台账里没有账号 ${id}` })
    if (existing.origin === 'handwritten') {
      return send(res, 409, {
        ok: false,
        error: `账号 ${id} 在手写的 sources.mjs 台账里`,
        hint: '界面只读。请直接编辑 sources.mjs，或把台账迁到 sources.local.json。',
      })
    }

    const nextFields = Array.isArray(parsed.fields) ? parsed.fields : existing.fields
    const droppedRefs = existing.fields.map((field) => field.ref)
      .filter((ref) => !nextFields.some((field) => field?.ref === ref))
    if (droppedRefs.length > 0 && parsed.dropConfigured !== true) {
      const configured = await configuredRefs(droppedRefs)
      if (configured.length > 0) {
        return send(res, 409, {
          ok: false,
          error: `这次修改会删掉已配置的字段：${configured.join(', ')}`,
          configuredRefs: configured,
          hint: '删字段不会删值，值会变成没人认领的孤儿。确认要删就带 dropConfigured: true。',
        })
      }
    }

    const merged = {
      id,
      label: parsed.label ?? existing.label,
      category: parsed.category ?? existing.category,
      url: parsed.url === undefined ? existing.url : parsed.url,
      notes: parsed.notes === undefined ? existing.notes : parsed.notes,
      usedBy: Array.isArray(parsed.usedBy) ? parsed.usedBy : existing.usedBy,
      fields: nextFields,
    }

    const validated = validateAccountInput(merged)
    if (validated.error) return send(res, 400, { ok: false, error: validated.error, hint: validated.hint })

    const conflict = findRefConflict(vault.accounts, validated.account)
    if (conflict) {
      return send(res, 409, {
        ok: false,
        error: `引用名 ${conflict.ref} 已经属于账号 ${conflict.id}`,
        hint: '一个引用名只能属于一个账号。',
      })
    }

    try {
      upsertVaultAccount(
        {
          id: validated.account.id,
          label: validated.account.label,
          category: validated.account.category,
          url: validated.account.url,
          notes: validated.account.notes,
          usedBy: validated.account.usedBy,
          fields: validated.account.fields,
        },
        vault.accounts,
      )
    } catch (error) {
      return send(res, 500, { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` })
    }

    return send(res, 200, { ok: true, id, updated: true, vaultFile: SOURCES_LOCAL_FILE })
  }

  const handleDelete = async (req, res) => {
    let params
    try {
      params = new URL(req.url ?? '/', 'http://localhost').searchParams
    } catch {
      return send(res, 400, { ok: false, error: '无法解析查询参数' })
    }
    const id = (params.get('id') ?? '').trim()
    const ref = (params.get('ref') ?? '').trim()
    const force = params.get('force') === '1'
    if (!id && !ref) return send(res, 400, { ok: false, error: '需要 id 或 ref 查询参数' })

    const vault = await loadVault()
    const account = id
      ? vault.accounts.find((item) => item.id === id)
      : findAccountByRef(vault.accounts, ref)
    if (!account) return send(res, 404, { ok: false, error: id ? `台账里没有账号 ${id}` : `台账里没有引用名 ${ref}` })
    if (account.origin === 'handwritten') {
      return send(res, 409, {
        ok: false,
        error: `账号 ${account.id} 在手写的 sources.mjs 台账里`,
        hint: '程序不改写手写文件。请自己编辑 sources.mjs，或把台账迁到 sources.local.json。',
      })
    }

    const targetRefs = ref ? [ref] : account.fields.map((field) => field.ref)
    if (!force) {
      const configured = await configuredRefs(targetRefs)
      if (configured.length > 0) {
        return send(res, 409, {
          ok: false,
          error: `${configured.join(', ')} 在凭据库里已有值`,
          configuredRefs: configured,
          hint: '删除台账条目不会删除值（值会变成孤儿）。确认要删就带 force=1；要连值一起清掉请在面板上先「移除值」。',
        })
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
      return send(res, 500, { ok: false, error: `删除失败：${error instanceof Error ? error.message : String(error)}` })
    }

    const after = await loadVault()
    return send(res, 200, {
      ok: true,
      id: account.id,
      removedRef: ref || null,
      accountRemoved: Boolean(id) || account.fields.length === 1,
      valueStillStored: true,
      totalAccounts: after.accounts.length,
      totalFields: after.accounts.reduce((sum, item) => sum + item.fields.length, 0),
    })
  }

  const handleRead = async (res) => {
    const registry = await loadRegistry()
    const vault = await loadVault()
    const ledger = buildLedger(registry.fatal ? [] : registry.sources, vault.accounts)

    const credentials = resolveCredentials()
    for (const account of ledger.accounts) {
      for (const field of account.fields) {
        let configured = null
        let writable = null
        let source = null
        if (credentials) {
          try {
            const info = await credentials.describe(field.ref)
            configured = Boolean(info?.configured)
            writable = info?.writable ?? null
            source = info?.source ?? null
          } catch {
            // describe 失败时保持 null（未知），不谎报状态
          }
        }
        field.configured = configured
        field.writable = writable
        field.source = source
      }
      account.stats = {
        fields: account.fields.length,
        configured: account.fields.filter((field) => field.configured === true).length,
        missing: account.fields.filter((field) => field.configured === false).length,
        unknown: account.fields.filter((field) => field.configured === null).length,
      }
    }

    send(res, 200, {
      ok: true,
      credentialsAvailable: Boolean(credentials),
      sourcesFile: SOURCES_FILE,
      localFile: SOURCES_LOCAL_FILE,
      libraryHome: LIB_HOME,
      categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
      libraries: (registry.sources ?? []).map((source) => ({ id: source.id, name: source.name })),
      stats: computeStats(ledger.accounts),
      accounts: ledger.accounts,
      problems: [
        ...(registry.fatal ? [registry.fatal] : []),
        ...registry.problems,
        ...vault.problems,
        ...ledger.problems,
      ],
      note: '本端点只返回配置状态与元数据，不返回任何密钥值。',
    })
  }

  /**
   * 值写完 / 移除之后的**镜像通知**。
   *
   * 面板写值走浏览器直连的 `credentials.set()`，只落到 `.credentials.yaml`；
   * 而读 `process.env` 的组件（harness 的 MCP 行之类）只认 `.env`。这一步把两者的
   * 落点对齐：`env:NAME` 落点的字段同步进 `.env`，其余落点则清掉可能遮蔽新值的旧 `.env` 键。
   *
   * ⚠️ 请求体**只有引用名，没有值**——值由宿主从凭据服务读出。值始终没有经过浏览器→本端点这条路。
   *
   * @param {object} req
   * @param {object} res
   * @param {string} action 'sync' 写完值之后 | 'clear' 移除值之后
   */
  const handleMirror = async (req, res, action) => {
    const raw = await readBody(req)
    if (raw?.error) return send(res, 400, { ok: false, error: raw.error })
    let payload
    try {
      payload = raw?.text ? JSON.parse(raw.text) : {}
    } catch {
      return send(res, 400, { ok: false, error: '请求体不是 JSON' })
    }
    const ref = typeof payload?.ref === 'string' ? payload.ref.trim() : ''
    if (!ref) return send(res, 400, { ok: false, error: '镜像通知需要 ref' })

    const vault = await loadVault()
    const account = findAccountByRef(vault.accounts, ref)
    const field = account?.fields?.find((item) => item.ref === ref) ?? null

    if (action === 'clear') {
      const result = clearRefFromEnv({ ref, inject: field?.inject ?? null })
      return send(res, 200, {
        ok: true, action, ref, removed: result.removed, problems: result.problems,
      })
    }

    // sync：值由宿主从凭据服务读出，浏览器不送值。
    const credentials = typeof getCredentials === 'function' ? getCredentials() : undefined
    if (!credentials || typeof credentials.resolve !== 'function') {
      return send(res, 200, { ok: false, error: '本部署没有凭据服务，无法镜像到 .env' })
    }
    let resolved
    try {
      resolved = await credentials.resolve(ref)
    } catch (error) {
      return send(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    if (!resolved?.value) {
      return send(res, 200, { ok: false, error: `凭据服务里读不到 ${ref} 的值` })
    }
    const result = mirrorRefToEnv({ ref, value: resolved.value, inject: field?.inject ?? null })
    return send(res, 200, {
      ok: true,
      action,
      ref,
      inject: field?.inject ?? null,
      written: result.written,
      removed: result.removed,
      pendingRestart: result.pendingRestart,
      problems: result.problems,
    })
  }

  return webServer.register({
    kind: 'exact',
    path: CREDENTIAL_ROUTE_PATH,
    async handler(req, res) {
      try {
        const method = (req?.method ?? 'GET').toUpperCase()
        if (method === 'POST') {
          // 镜像通知：只送引用名，不送值。所以单独一条判断，不进 handleCreate。
          let params
          try {
            params = new URL(req.url ?? '/', 'http://localhost').searchParams
          } catch {
            params = null
          }
          const mirror = params?.get('mirror')
          if (mirror === 'sync' || mirror === 'clear') return await handleMirror(req, res, mirror)
          return await handleCreate(req, res)
        }
        if (method === 'GET') return await handleRead(res)
        if (method === 'PATCH') return await handlePatch(req, res)
        if (method === 'DELETE') return await handleDelete(req, res)
        return send(res, 405, { ok: false, error: `不支持 ${method}；可用 GET / POST / PATCH / DELETE` })
      } catch (error) {
        send(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          accounts: [],
          stats: null,
        })
      }
    },
  })
}
