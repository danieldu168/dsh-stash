/**
 * 给浏览器半边用的**迁移端点**。
 *
 *   GET  /stash/portability                         只读：默认导出目录、有没有导出记录、最近几次导出
 *   POST /stash/portability?action=export          导出（body: { dir?, withValues?, includeCorpus? }）
 *   POST /stash/portability?action=import          导入 / 预演（body: { dir, dryRun? }）
 *   POST /stash/portability?action=plan-wipe       出清空清单（body: { includeCorpus? }）
 *   POST /stash/portability?action=wipe            执行清空（body: { includeCorpus?, confirm }）
 *
 * ⛔ **值永远不经过这条端点。**
 *    - 导出带值时，值由宿主从凭据服务读出后**直接落盘**到包里的 values.json；请求体里没有值。
 *    - 导入时值从包里读出，由宿主按 inject 落点写进凭据服务与 `.env`。
 *    - 客户端送过来的只有：动作、目录、开关、校验码。
 *
 * ⛔ **校验码只在执行清空时收，任何返回里都不带它。**
 *    这是有意的：清空要求输入"另一台机器导入成功时回显的那个码"，如果本端点把码回给界面，
 *    门槛就形同虚设（界面可以直接把它填进输入框）。所以 GET 与 plan-wipe 都刻意省略它。
 *
 * ⚠️ 必须由 `ctx.inject(['webServer'], (hostCtx) => ...)` 注册（不能在 apply 时 ctx.get）。
 *
 * @module dsh-stash/portability-route
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './home.js'
import {
  LAST_EXPORT_FILE,
  exportStash,
  importStash,
  planWipe,
  renderExport,
  renderImport,
  renderWipe,
  wipeStash,
} from './portability.js'

export const PORTABILITY_ROUTE_PATH = '/stash/portability'
const MAX_BODY_BYTES = 16 * 1024

const asString = (value, max = 400) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '')

/** 默认导出目录名用本地时间戳，人一眼能认出是哪次导的。 */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

function defaultExportDir(date) {
  return join(DSH_HOME, `stash-export-${stamp(date)}`)
}

/** 读导出记录。**刻意只取这几个字段，verifyCode 不外传。** */
function readExportHistory() {
  try {
    const parsed = JSON.parse(readFileSync(LAST_EXPORT_FILE, 'utf8'))
    const list = Array.isArray(parsed?.history) ? parsed.history : (parsed?.at ? [parsed] : [])
    return list
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        at: asString(item.at, 40),
        dir: asString(item.dir, 400),
        hasValues: item.hasValues === true,
        includesCorpus: item.includesCorpus === true,
      }))
  } catch {
    return []
  }
}

export function registerPortabilityRoute(hostCtx, { getCredentials } = {}) {
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
    const raw = await readBody(req)
    if (raw?.error) return { error: raw.error }
    try {
      const parsed = raw?.text ? JSON.parse(raw.text) : {}
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: '请求体必须是 JSON 对象' }
      }
      return { parsed }
    } catch {
      return { error: '请求体不是合法 JSON' }
    }
  }

  const resolveCredentials = () => (typeof getCredentials === 'function'
    ? getCredentials()
    : (typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined))

  const handleStatus = (res) => {
    const history = readExportHistory()
    return send(res, 200, {
      ok: true,
      defaultExportDir: defaultExportDir(),
      exportHome: DSH_HOME,
      hasExportRecord: history.length > 0,
      // 只给"导过没有、什么时候、到哪、带没带值和语料"；**不给校验码**。
      recent: history,
      note: '本端点只报状态；导出/导入/清空走同路径的 POST，值不经过浏览器。',
    })
  }

  const handleExport = async (parsed) => {
    const dir = asString(parsed.dir) || defaultExportDir()
    const result = await exportStash({
      outDir: dir,
      withValues: parsed.withValues === true,
      includeCorpus: parsed.includeCorpus === true,
      getCredentials: resolveCredentials,
    })
    if (result?.ok !== true) {
      return { status: 400, payload: { ok: false, action: 'export', dir, ...result } }
    }
    // 校验码**这一处必须回**：用户要把它带到另一台机器去对账。
    return { status: 200, payload: { ...result, action: 'export', report: renderExport(result) } }
  }

  const handleImport = async (parsed) => {
    const dir = asString(parsed.dir)
    if (!dir) {
      return {
        status: 400,
        payload: {
          ok: false,
          action: 'import',
          error: '缺少包目录',
          hint: '填上导出包的目录路径。浏览器拿不到本地路径，只能手输或粘贴。',
        },
      }
    }
    const result = await importStash({
      dir,
      dryRun: parsed.dryRun === true,
      getCredentials: resolveCredentials,
    })
    if (result?.ok !== true) {
      return { status: 400, payload: { ok: false, action: 'import', dir, ...result } }
    }
    return { status: 200, payload: { ...result, action: 'import', report: renderImport(result) } }
  }

  const handlePlanWipe = async (parsed) => {
    const result = await planWipe({
      includeCorpus: parsed.includeCorpus === true,
      getCredentials: resolveCredentials,
    })
    if (result?.ok !== true) {
      return { status: 400, payload: { ok: false, action: 'plan-wipe', ...result } }
    }
    return { status: 200, payload: { ...result, action: 'plan-wipe', report: renderWipe(result) } }
  }

  const handleWipe = async (parsed) => {
    const result = await wipeStash({
      includeCorpus: parsed.includeCorpus === true,
      confirm: asString(parsed.confirm, 64),
      getCredentials: resolveCredentials,
    })
    if (result?.ok !== true) {
      return { status: 400, payload: { ok: false, action: 'wipe', ...result } }
    }
    return { status: 200, payload: { ...result, action: 'wipe', report: renderWipe(result) } }
  }

  return webServer.register({
    kind: 'exact',
    path: PORTABILITY_ROUTE_PATH,
    async handler(req, res) {
      try {
        const method = (req?.method ?? 'GET').toUpperCase()
        if (method === 'GET') return handleStatus(res)
        if (method !== 'POST') {
          return send(res, 405, { ok: false, error: `不支持 ${method}；可用 GET / POST` })
        }

        let action = ''
        try {
          action = new URL(req.url ?? '/', 'http://localhost').searchParams.get('action') ?? ''
        } catch {
          action = ''
        }
        if (!action) {
          return send(res, 400, {
            ok: false,
            error: '缺少 action',
            hint: 'action 取 export / import / plan-wipe / wipe 之一。',
          })
        }

        const body = await parseBody(req)
        if (body.error) return send(res, 400, { ok: false, error: body.error })

        const result = action === 'export' ? await handleExport(body.parsed)
          : action === 'import' ? await handleImport(body.parsed)
            : action === 'plan-wipe' ? await handlePlanWipe(body.parsed)
              : action === 'wipe' ? await handleWipe(body.parsed)
                : { status: 400, payload: { ok: false, error: `不认识的 action：${action}` } }
        return send(res, result.status, result.payload)
      } catch (error) {
        return send(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })
}
