/**
 * 给浏览器半边用的**资源写端点**。
 *
 *   POST   /stash/sources              新建 / 覆盖一条资源（代写，写进 sources.local.json）
 *   DELETE /stash/sources?id=xx        删除一条**代写**资源（手写条目拒绝，程序永不改写 sources.mjs）
 *
 * 为什么要有它：在这之前，资源只能由模型工具 `stash_source_add` 或手写文件登记——
 * 面板能看不能改，删更是哪都没有入口（removeLocalSource 有实现却没暴露）。
 * 现在面板具备了「新建 / 编辑 / 删除」，走的**还是同一套校验**：
 * 直接调用 `stash_source_add` 工具本身，而不是把校验再抄一遍。
 * 这样"面板放行的、模型侧一定也放行"，不会两头两套规则。
 *
 * ⚠️ 必须由 `ctx.inject(['webServer'], ...)` 注册（与凭据端点同样的理由）。
 *
 * @module dsh-stash/sources-route
 */
import { loadRegistry, findSource, removeLocalEntry } from './registry.js'
import { loadVault, saveVault } from './vault.js'

export const SOURCES_ROUTE_PATH = '/stash/sources'
const MAX_BODY_BYTES = 64 * 1024

export function registerSourcesRoute(hostCtx, { sourceAddTool } = {}) {
  const webServer = hostCtx?.webServer
    ?? (typeof hostCtx?.get === 'function' ? hostCtx.get('webServer') : undefined)
  if (!webServer || typeof webServer.register !== 'function') return null

  const send = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  }

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

  /** 新建 / 覆盖：交给 stash_source_add 本体，校验、安全扫描、写入都在那边。 */
  const handleCreate = async (req, res) => {
    const raw = await readBody(req)
    if (raw?.error) return send(res, 400, { ok: false, error: raw.error })
    let parsed
    try {
      parsed = JSON.parse(raw?.text || '{}')
    } catch {
      return send(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return send(res, 400, { ok: false, error: '请求体必须是一个对象' })
    }
    if (!sourceAddTool || typeof sourceAddTool.execute !== 'function') {
      return send(res, 500, { ok: false, error: '本插件未注册 stash_source_add，资源写端点不可用' })
    }
    // 面板新建默认按"新建"语义；编辑时客户端显式带 overwrite: true。
    const result = await sourceAddTool.execute({ ...parsed, overwrite: parsed.overwrite === true })
    // 校验失败是"预期的失败"，用 200 回结构化结果，客户端好把 errors 落到字段上。
    return send(res, 200, result)
  }

  /** 删除一条代写资源，并把它从账号的 usedBy 里摘掉（否则会留下一个死 id）。 */
  const handleDelete = async (req, res, url) => {
    const id = (url.searchParams.get('id') ?? '').trim()
    if (!id) return send(res, 400, { ok: false, error: '缺少 id' })

    const registry = await loadRegistry()
    if (registry.fatal) return send(res, 200, { ok: false, error: registry.fatal })
    const existing = findSource(registry, id)
    if (!existing) return send(res, 200, { ok: false, error: `没有 id 为 "${id}" 的资源` })
    if (existing.origin === 'handwritten') {
      return send(res, 200, {
        ok: false,
        error: `"${id}" 写在 sources.mjs（手写），程序不改写它`,
        hint: '要删它请自己编辑 sources.mjs；面板只改代写条目（sources.local.json）。',
      })
    }

    try {
      removeLocalEntry(id)
    } catch (error) {
      return send(res, 500, { ok: false, error: `删除失败：${error instanceof Error ? error.message : String(error)}` })
    }

    // 顺带清理：账号的 usedBy 里可能还指着这条库。
    let accountsUpdated = 0
    try {
      const vault = await loadVault()
      let dirty = false
      const next = vault.accounts.map((account) => {
        if (!Array.isArray(account.usedBy) || !account.usedBy.includes(id)) return account
        dirty = true
        accountsUpdated += 1
        return { ...account, usedBy: account.usedBy.filter((item) => item !== id) }
      })
      if (dirty) saveVault(next)
    } catch {
      // 清理失败不该让"库已删除"这件事变成失败——回报里说明即可。
      accountsUpdated = -1
    }

    return send(res, 200, {
      ok: true,
      removed: { id, name: existing.name },
      accountsUpdated,
      note: '取数台账不会删（只追加不删）；该库的经验仍留在 lessons.json，但界面上按已登记库聚合，所以不再显示。',
    })
  }

  const handler = async (req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      return send(res, 400, { ok: false, error: 'URL 不合法' })
    }
    try {
      if (req.method === 'POST') return await handleCreate(req, res)
      if (req.method === 'DELETE') return await handleDelete(req, res, url)
      return send(res, 405, { ok: false, error: `不支持的方法 ${req.method}` })
    } catch (error) {
      return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return webServer.register({ kind: 'exact', path: SOURCES_ROUTE_PATH, handler })
}
