/**
 * 内置取数处理器注册表。注册表里的 `handler` 字段指向这里的名字。
 *
 * 加一个全新 API 的自动取数能力 = 在这里加一个模块；加一个已支持形态的库
 * = 只改 sources.mjs，不需要动代码。
 *
 * @module dsh-stash/handlers
 */
import * as policy_alerts from './policy_alerts.js'
import * as http from './http.js'
import * as trade_stats from './trade_stats.js'

const HANDLERS = new Map([
  ['trade_stats', trade_stats],
  ['policy_alerts', policy_alerts],
  ['http', http],
])

export function getHandler(handlerId) {
  return HANDLERS.get(handlerId)
}

export function listHandlers() {
  return [...HANDLERS.keys()]
}

/** 供 stash_catalog 展示：每个 handler 支持哪些动作。 */
export function describeHandlers() {
  return [...HANDLERS.entries()].map(([id, module]) => ({
    id,
    actions: Object.keys(module.ACTIONS),
    actionHelp: module.ACTIONS,
    guarantees: module.GUARANTEES,
  }))
}
