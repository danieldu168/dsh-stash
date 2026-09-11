/**
 * `/stash` 人类命令。
 *
 * 为什么需要它：**插件名不是可调用对象**。`dsh-stash` 是加载器行的 id，能被调用的只有
 * tool。所以"输入名字就有反应"这件事在插件里必须靠 commands 服务实现——而不是靠工具名。
 *
 * 它比让模型调工具更好：契约原话是 execute "without sending it to the model"，
 * 所以 `/stash` 不消耗 token、不产生对话轮次，结果直接出现在对话里。
 *
 * 实现上直接复用 stash_catalog 的 execute + render，保证两个面的输出完全一致。
 *
 * @module dsh-stash/command
 */
import { SOURCES_FILE } from './home.js'

const COMMAND_NAME = 'stash'

/**
 * 注册 `/stash`。
 *
 * ⚠️ 必须在 `ctx.inject(['commands'], (hostCtx) => ...)` 的回调里调用。
 * 0.3.2 及以前用 `ctx.get('commands')` + setTimeout 重试去碰运气 —— 那是错的做法。
 * `ctx.inject` 才是"服务就绪时回调、且不阻塞本插件"的正规机制
 * （官方 bundle 见 dshmarket/lib/index.js 第 36 行）。
 *
 * @param {object} hostCtx 已注入 commands 的上下文
 * @param {{
 *   catalogTool: { execute: Function, output: { render: Function } },
 *   disposers: Array<() => void>,
 *   warn: (message: string) => void,
 * }} deps
 */
export function registerStashCommand(hostCtx, { catalogTool, disposers, warn }) {
  const commands = hostCtx?.commands
    ?? (typeof hostCtx?.get === 'function' ? hostCtx.get('commands') : undefined)
  if (!commands || typeof commands.register !== 'function') {
    warn('[dsh-stash] commands 服务不可用，/stash 命令未注册（5 个工具不受影响）')
    return () => {}
  }

  const handler = async (invocation) => {
    const id = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
    try {
      const value = await catalogTool.execute(id ? { id } : {})
      const blocks = catalogTool.output.render({}, value)
      const body = blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
      const footer = `\n\n注册表：${SOURCES_FILE}\n（等效工具：stash_catalog；取数用 stash_fetch，体检用 stash_doctor）`
      return value?.ok
        ? { kind: 'success', text: `${body}${footer}` }
        : { kind: 'error', text: `${body}${footer}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `/stash 执行失败：${message}` }
    }
  }

  const description = '列出已登记的文库、覆盖范围、凭据配置状态与本地语料路径（不经模型）'

  try {
    disposers.push(commands.register({ name: COMMAND_NAME, description, handler }))
  } catch (error) {
    warn(`[dsh-stash] /${COMMAND_NAME} 命令注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return () => {}
}
