/**
 * 凭据值的落点：一处录入，两处一致。
 *
 * 为什么需要它：宿主有**两个**凭据存储，服务于两套消费协议——
 *
 * | 存储 | 谁读得到 | 生效方式 |
 * |---|---|---|
 * | `$DSH_HOME/.credentials.yaml`（凭据服务） | 只有读 seam 的（stash 自己的取数） | 热重载 |
 * | `$DSH_HOME/.env` | seam **与** `process.env` 消费者都读得到 | 要重启 |
 *
 * 面板写值走 `credentials.set()`，只落前者。于是"读 `process.env` 的组件"
 * （例如 harness 的 MCP 行）永远拿不到，用户只能手工去编辑 `.env`——
 * 那条手工步骤正是这个模块要消掉的。
 *
 * 字段的 `inject` 说值该放哪，就写到哪；同时把**会遮蔽新值的旧落脚**清掉
 * （`.env` 里的值一旦被物化进进程环境，在 seam 里排在 `.credentials.yaml` 之前）。
 *
 * ⚠️ 只在两个受控入口被调用：
 *   1. 面板写完值之后的镜像通知——**浏览器只送引用名，不送值**，值由宿主编从凭据服务读出；
 *   2. `/stash import` 按 `inject` 恢复值时。
 *
 * 动的键只限该引用名自己，别的一律不碰。
 *
 * @module dsh-stash/credential-store
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_HOME } from './home.js'

/** 宿主的进程环境层。读它的消费者不查凭据 seam。 */
export const ENV_FILE = join(DSH_HOME, '.env')

/** `env:NAME` 落点 → NAME；其余（含没记落点的）→ null。 */
export function envTargetOf(inject) {
  if (typeof inject !== 'string' || !inject.startsWith('env:')) return null
  const name = inject.slice('env:'.length).trim()
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null
}

const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

/** `.env` 里出现过的键名。 */
export function envKeysIn(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/))
    .filter(Boolean)
    .map((match) => match[1])
}

/** `.env` 里按名写入/替换若干键，其余行原样保留（含注释与空行）。 */
export function upsertEnvValues(text, pairs) {
  const eol = String(text ?? '').includes('\r\n') ? '\r\n' : '\n'
  const pending = new Map(pairs)
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (match && pending.has(match[1])) {
      out.push(`${match[1]}=${pending.get(match[1])}`)
      pending.delete(match[1])
    } else {
      out.push(line)
    }
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  const written = [...pending.keys()]
  for (const [name, value] of pending) out.push(`${name}=${value}`)
  return { text: out.length > 0 ? `${out.join(eol)}${eol}` : '', written }
}

/** `.env` 里按名删行，其余行原样保留。 */
export function removeEnvKeys(text, names) {
  const wanted = new Set(names)
  const eol = String(text ?? '').includes('\r\n') ? '\r\n' : '\n'
  const removed = []
  const kept = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (match && wanted.has(match[1])) {
      removed.push(match[1])
      continue
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  return { text: kept.length > 0 ? `${kept.join(eol)}${eol}` : '', removed }
}

/**
 * 把一把钥匙的值镜像进 `.env`（仅当它的落点是 `env:NAME`），
 * 并清掉会遮蔽它的旧落脚 `.env[ref]`。
 *
 * @param {{ ref: string, value: string, inject?: string|null }} input
 * @returns {{ written: string[], removed: string[], pendingRestart: boolean, problems: string[] }}
 */
export function mirrorRefToEnv({ ref, value, inject }) {
  const problems = []
  const target = envTargetOf(inject)
  let text = readText(ENV_FILE)
  const written = []
  const removed = []

  if (target !== null) {
    const result = upsertEnvValues(text, [[target, String(value)]])
    text = result.text
    written.push(...result.written)
  }

  // 同名落脚会遮蔽凭据服务里的值（.env 物化后排在 seam 之前），必须清掉。
  if (ref !== target) {
    const result = removeEnvKeys(text, [ref])
    if (result.removed.length > 0) {
      text = result.text
      removed.push(...result.removed)
    }
  }

  if (written.length > 0 || removed.length > 0) {
    try {
      writeText(ENV_FILE, text)
    } catch (error) {
      problems.push(`写 ${ENV_FILE} 失败：${error instanceof Error ? error.message : String(error)}`)
      return { written: [], removed: [], pendingRestart: false, problems }
    }
  }

  return { written, removed, pendingRestart: written.length > 0, problems }
}

/**
 * 从 `.env` 里清掉这个引用名的落脚——引用名本身，以及它 `inject` 指向的键名。
 *
 * 两个都清是必要的：值历史可能落在任一处，留一个就是"幽灵值"。
 *
 * @param {{ ref: string, inject?: string|null }} input
 * @returns {{ removed: string[], problems: string[] }}
 */
export function clearRefFromEnv({ ref, inject }) {
  const target = envTargetOf(inject)
  const names = [...new Set([ref, ...(target === null ? [] : [target])])].filter((name) => name)
  const text = readText(ENV_FILE)
  const result = removeEnvKeys(text, names)
  if (result.removed.length === 0) return { removed: [], problems: [] }
  try {
    writeText(ENV_FILE, result.text)
  } catch (error) {
    return { removed: [], problems: [`写 ${ENV_FILE} 失败：${error instanceof Error ? error.message : String(error)}`] }
  }
  return { removed: result.removed, problems: [] }
}

/**
 * **装上一把钥匙的值：两处一起写。**
 *
 * 面板贴值走的是"浏览器 → 凭据服务 → 镜像通知"两跳；`/stash import` 没有浏览器那一跳，
 * 所以在这里合成一个入口，保证两条路最终落到同样的状态。
 *
 * 为什么必须两处都写：只写 `.env` 的话，**重启前读 seam 的消费者看不见**（`.env` 是启动快照），
 * 面板还会误报"未配置"；只写凭据服务的话，读 `process.env` 的组件永远拿不到。
 *
 * @param {{ ref: string, value: string, inject?: string|null, credentials?: object }} input
 * @returns {Promise<{ stored: string, written: string[], removed: string[],
 *   pendingRestart: boolean, problems: string[] }>}
 */
export async function installCredentialValue({ ref, value, inject, credentials }) {
  const problems = []
  let stored = 'skipped:no-credentials'
  if (credentials && typeof credentials.set === 'function') {
    try {
      await credentials.set(ref, String(value))
      stored = 'written'
    } catch (error) {
      stored = `failed:${error instanceof Error ? error.message : String(error)}`
    }
  }
  const mirror = mirrorRefToEnv({ ref, value, inject })
  problems.push(...mirror.problems)
  if (stored.startsWith('failed:')) problems.push(`${ref} 未写进凭据服务：${stored.slice('failed:'.length)}`)
  return {
    stored,
    written: mirror.written,
    removed: mirror.removed,
    pendingRestart: mirror.pendingRestart,
    problems,
  }
}
