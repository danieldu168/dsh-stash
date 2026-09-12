/**
 * dsh-stash —— 外接数据源的门禁、钥匙与台账（Profile Bundle 的 host 半边）。
 *
 * 它做四件事：
 *   1. 把外部数据库/资料库/文献库登记成一份人可编辑的注册表（~/.dsh/stash/sources.mjs）
 *   2. 用每条库的 access 声明"这条库允许怎么取数"，越界时拒绝执行而不是尽力而为
 *   3. 把"取数时最容易算错的地方"固化成代码保证，而不是文档里的叮嘱
 *   4. 每次取数写一条台账（~/.dsh/stash/ledger.ndjson）：记指纹，不记内容
 *
 * 它**不**做：存口令（口令归 credentials 服务）、把语料灌进上下文（索引进上下文，内容按需取）、
 * 存内容（台账只有 contentHash，内容在 cache/ 与 corpus/）。
 *
 * @module dsh-stash
 */
import { ensureLibDirs } from './home.js'
import { registerCredentialRoute } from './credential-route.js'
import { registerStashCommand } from './command.js'
import { loadRegistry } from './registry.js'
import { buildTools } from './tools.js'

/** 注册工具需要 tools 注册表；credentials 是可选依赖，用 ctx.get 拿。 */
export const inject = ['tools']
export const name = 'dsh-stash'

const describeError = (error) => (error instanceof Error ? error.message : String(error))

export function apply(ctx, _config = {}) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // 日志失败不影响插件工作。
    }
  }

  // 先把清理钩子挂上：即使后面构造工具失败，也不会留下半挂状态。
  const disposers = []
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 卸载期的清理失败不值得打断其他 disposer。
        }
      }
    })
  }

  try {
    ensureLibDirs()

    // 可选服务：本部署没有 credentials 时，工具照样注册，只是凭据状态显示为"未知"。
    const getCredentials = () => ctx.get('credentials')

    const definitions = buildTools({ getCredentials, logger: ctx.logger })
    for (const definition of definitions) {
      try {
        disposers.push(ctx.tools.register(definition))
      } catch (error) {
        warn(`[dsh-stash] 工具 ${definition.name} 注册失败：${describeError(error)}`)
      }
    }

    // ── 需要"稍后就绪"的服务的两处注册 ──────────────────────────────────────
    //
    // 必须用 ctx.inject([...], cb)：它在服务就绪时回调，且**不阻塞本插件**。
    // 0.3.2 及以前是在这里同步 ctx.get('webServer') —— 那时服务还没就绪，
    // 拿到 undefined 就静默跳过，界面只看到 HTTP 404（空 body），其余一切正常。
    // 注意这与插件对象上的 inject: [...] 不是一回事：那个会让 fiber 一直等。
    //
    // （官方 bundle 的同一机制：dshmarket/lib/index.js 第 36 行
    //   ctx.inject(['webServer', 'loader'], (hostCtx) => ...)）
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (hostCtx) => {
        try {
          const disposeRoute = registerCredentialRoute(hostCtx, { getCredentials })
          if (disposeRoute) disposers.push(disposeRoute)
          else warn('[dsh-stash] webServer 已就绪但 register 不可用，凭据面板读不到状态（写入仍可用）')
        } catch (error) {
          warn(`[dsh-stash] 凭据端点注册失败：${describeError(error)}`)
        }
      })

      const catalogTool = definitions.find((definition) => definition.name === 'stash_catalog')
      if (catalogTool) {
        ctx.inject(['commands'], (hostCtx) => {
          try {
            registerStashCommand(hostCtx, { catalogTool, disposers, warn })
          } catch (error) {
            warn(`[dsh-stash] /stash 命令注册失败：${describeError(error)}`)
          }
        })
      }
    } else {
      warn('[dsh-stash] 本 ctx 没有 inject，无法注册 webServer 路由与 /stash 命令（Model Tool 不受影响）')
    }
  } catch (error) {
    // 文库不可用时宿主必须照常启动 —— 这是"绝不弄崩启动"的实际含义。
    warn(`[dsh-stash] 启动失败，已隔离（不影响宿主其他能力）：${describeError(error)}`)
    return
  }

  // 启动时体检一次注册表，把问题写进宿主日志（不阻断启动）。
  void loadRegistry()
    .then((registry) => {
      if (registry.fatal) warn(`[dsh-stash] 文库注册表不可用：${registry.fatal}`)
      else if (registry.problems.length > 0) {
        warn(`[dsh-stash] 文库注册表有 ${registry.problems.length} 处问题：${registry.problems.join(' | ')}`)
      } else {
        const deepErrors = (registry.deepIssues ?? []).filter((issue) => issue.level === 'error')
        if (deepErrors.length > 0) {
          warn(`[dsh-stash] 有 ${deepErrors.length} 处会让取数失败的条目问题，跑 stash_doctor 看详情：${deepErrors.map((issue) => issue.message).join(' | ')}`)
        }
        ctx.logger?.info?.(`[dsh-stash] 已登记 ${registry.sources.length} 个文库：${registry.sources.map((s) => s.id).join(', ')}`)
      }
    })
    .catch((error) => warn(`[dsh-stash] 注册表体检失败：${describeError(error)}`))
}
