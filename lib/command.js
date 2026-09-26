/**
 * `/stash` 人类命令。
 *
 * 为什么需要它：**插件名不是可调用对象**。`dsh-stash` 是加载器行的 id，能被调用的只有
 * tool。所以"输入名字就有反应"这件事在插件里必须靠 commands 服务实现——而不是靠工具名。
 *
 * 它比让模型调工具更好：契约原话是 execute "without sending it to the model"，
 * 所以 `/stash` 不消耗 token、不产生对话轮次，结果直接出现在对话里。
 *
 * 三件事只能走这条路，不能做成 Model Tool：**导出 / 导入 / 清空**。
 * 它们要搬运凭据的值，而"值不进 tool 参数、不进上下文"是整套设计的前提。
 *
 * @module dsh-stash/command
 */
import { join } from 'node:path'
import { DSH_HOME, SOURCES_FILE } from './home.js'
import {
  exportStash, importStash, planWipe, renderExport, renderImport, renderWipe, wipeStash,
} from './portability.js'

const COMMAND_NAME = 'stash'
const SUBCOMMANDS = new Set(['export', 'import', 'wipe', 'help'])

const USAGE = [
  '用法：',
  '  /stash                              列出已登记的文库',
  '  /stash <库id>                       只看一条库',
  '  /stash export [--out <目录>] [--with-values] [--corpus]',
  '  /stash import <目录> [--dry-run]',
  '  /stash wipe [--corpus] [--confirm <校验码>]',
  '',
  '导出默认不带值；带值则明文（--with-values）。',
  '清空要求先导出、并在另一台机器导入成功，再输入那边回显的校验码。',
].join('\n')

/** 按空白切词，但双引号内不切——导出目录常带空格。 */
function tokenize(input) {
  const out = []
  let current = ''
  let quoted = false
  for (const ch of String(input ?? '')) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

const hasFlag = (tokens, name) => tokens.includes(name)

/** 取 `--name value` 的值；后面跟的是另一个旗标或没有值就算缺。 */
function optionValue(tokens, name) {
  const index = tokens.indexOf(name)
  if (index < 0) return null
  const value = tokens[index + 1]
  if (value === undefined || value.startsWith('--')) return null
  return value
}

const stamp = (date) => {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

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
 *   getCredentials?: () => object | undefined,
 *   disposers: Array<() => void>,
 *   warn: (message: string) => void,
 * }} deps
 */
export function registerStashCommand(hostCtx, { catalogTool, getCredentials, disposers, warn }) {
  const commands = hostCtx?.commands
    ?? (typeof hostCtx?.get === 'function' ? hostCtx.get('commands') : undefined)
  if (!commands || typeof commands.register !== 'function') {
    warn('[dsh-stash] commands 服务不可用，/stash 命令未注册（Model Tool 不受影响）')
    return () => {}
  }

  const listLibraries = async (id) => {
    const value = await catalogTool.execute(id ? { id } : {})
    const blocks = catalogTool.output.render({}, value)
    const body = blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
    const footer = `\n\n注册表：${SOURCES_FILE}\n（等效工具：stash_catalog；取数用 stash_fetch，体检用 stash_doctor）\n迁移用：/stash export | import | wipe`
    return value?.ok
      ? { kind: 'success', text: `${body}${footer}` }
      : { kind: 'error', text: `${body}${footer}` }
  }

  const handleExport = async (tokens) => {
    const outDir = optionValue(tokens, '--out')
      ?? join(DSH_HOME, `stash-export-${stamp(new Date())}`)
    const value = await exportStash({
      outDir,
      withValues: hasFlag(tokens, '--with-values'),
      includeCorpus: hasFlag(tokens, '--corpus'),
      getCredentials,
    })
    return { kind: value.ok ? 'success' : 'error', text: renderExport(value) }
  }

  const handleImport = async (tokens) => {
    const dir = tokens.find((token, index) => index > 0 && !token.startsWith('--'))
    if (!dir) {
      return { kind: 'error', text: `❌ 用法：/stash import <目录> [--dry-run]\n\n${USAGE}` }
    }
    const value = await importStash({ dir, getCredentials, dryRun: hasFlag(tokens, '--dry-run') })
    return { kind: value.ok ? 'success' : 'error', text: renderImport(value) }
  }

  const handleWipe = async (tokens) => {
    const confirm = optionValue(tokens, '--confirm')
    const includeCorpus = hasFlag(tokens, '--corpus')
    if (!confirm) {
      // 第一次调用只给计划——清空是两次输入的动作，不是一次点击。
      const plan = await planWipe({ includeCorpus })
      const value = plan.requireCode
        ? { ok: false, kind: 'unconfirmed', error: '清空需要确认码（二次确认）', requireCode: plan.requireCode, plan }
        : { ok: false, kind: 'no-export', error: '本机没有导出记录', plan }
      return { kind: 'error', text: renderWipe(value) }
    }
    const value = await wipeStash({ includeCorpus, confirm, getCredentials })
    return { kind: value.ok ? 'success' : 'error', text: renderWipe(value) }
  }

  const handler = async (invocation) => {
    const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
    const tokens = tokenize(raw)
    const sub = tokens[0]

    try {
      if (!SUBCOMMANDS.has(sub)) return await listLibraries(raw)
      if (sub === 'help') return { kind: 'success', text: USAGE }
      if (sub === 'export') return await handleExport(tokens)
      if (sub === 'import') return await handleImport(tokens)
      return await handleWipe(tokens)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `/stash ${sub ?? ''} 执行失败：${message}\n\n${USAGE}` }
    }
  }

  const description = '列出已登记的文库、覆盖范围、凭据配置状态与本地语料路径；并提供导出 / 导入 / 清空（不经模型）'

  try {
    disposers.push(commands.register({ name: COMMAND_NAME, description, handler }))
  } catch (error) {
    warn(`[dsh-stash] /${COMMAND_NAME} 命令注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return () => {}
}
