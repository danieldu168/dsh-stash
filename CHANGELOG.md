# 更新日志

本文件记录 dsh-stash 的版本变化。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，
结构参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> **关于 0.5.1 之前的版本**
> 本仓库的首个提交即 0.5.1，更早版本（0.1.0–0.4.0）的提交记录未随仓库保留。
> 下方「0.4.0 及更早」一节据 `README.md` 的踩坑记录与 `DESIGN-vault.md`（决策记录）整理，
> **只保留有据可查的部分**；这部分没有日期，因为它们的具体发布日已不可考。

---

## [0.7.1] — 2026-09-12

### 新增

- `handler: 'http'` 支持 `request.cacheTtlMs`：缓存寿命，过期自动重取；**不写则保持「永不过期」的旧行为**（向后兼容 0.6.0）。
- `handler: 'http'` 支持 `request.captureHeaders`：点名带出的响应头，用于配额计数器一类的用途。**不点名的一律不带出**，所以 `set-cookie` 之类不会被顺手捞进结果。响应头随缓存落盘，命中缓存时同样能拿到配额数。

## [0.7.0] — 2026-09-12

### 变更

- 定位明确为「外接数据源的门禁 / 钥匙 / 台账」。

### 新增

- `access` 使用边界：`public-api` / `official-api` / `export-import` / `unsupported`。声明为 `export-import` 或 `unsupported` 的库会被 `stash_fetch` **拒绝并只留痕**，而不是尽力而为地绕过。
- 取数台账 `$DSH_HOME/stash/ledger.ndjson` 与查询工具 `stash_ledger`。每条记录带 `ledgerId` 与 `contentHash`，**只记指纹不记内容**；失败与被边界拒绝同样留痕。
- `stash_doctor` 增加**条目深度校验**：把「能加载但注定取不到数的写法」提前报出来（`request.url` 写错、`{credential:REF}` 的引用名没在 `credentials` 里声明、`required` 的参数没出现在请求里、`paths` 不是绝对路径、没声明 `access`）。
- `stash_source_add` 在登记前**当场拒收**会导致取数失败的条目。

### 兼容

- 全部为增量：旧注册表不用改；不写 `access` 只是会在体检里被提示补上。

## [0.6.0] — 2026-09-12

### 变更

- 钥匙台账从手写 `sources.mjs` 的 `export const credentials = [...]` 迁到代写分片 `sources.local.json` 的 `accounts`。手写文件界面只读，**迁走才能真正编辑**。
- 数据模型升级为**两层：账号 + 字段**。「同一个网站只占一条目录」在目录层做；值这一层不合并，否则「缺账号还是缺密码」看不出来。
- 类别枚举补 `mcp`（MCP / 智能体服务）。
- 面板行为：已配置条目默认折叠、「更换值」才出现输入框、「移除值」必须二次确认、**值不再 trim**（口令首尾空格有意义）、多行值走 textarea。
- 「编辑信息」与「新建」复用同一张字段表，字段带 `secret` / `inject` / `multiline` / `notes`。

### 兼容

- 旧形状（`export const credentials = [...]`）仍可读；迁移前的原文件留在 `$DSH_HOME/stash/backup/`。

## [0.5.1] — 2026-09-11

- 首个进入本仓库的版本，当时的定位是「个人资源堆放处（Profile Bundle）」。

## 0.4.0 及更早

- **0.4.0**：钥匙台账成为**一等公民**——钥匙可独立于库存在、带人类可读元数据（中文名 / 类别 / 网址 / 备注）、面板按类别分组、模型可建条目但**拿不到值**。
- **0.3.2**：修复 host 半边在 `apply` 时同步 `ctx.get('webServer')` 拿到 `undefined` → 静默跳过路由注册，表现为**界面 HTTP 404 而工具与页面一切正常**。改为 `ctx.inject(['webServer'], (hostCtx) => ...)`。
- **0.3.1**：修复客户端把 URL helper 命名为 `api`、与 `createSection(api)` 的形参同名造成**遮蔽** → async `load()` 抛 `TypeError` → effect 未 await → 只剩 unhandled rejection、界面永远停在「正在读取」。为此新增 `test/client-runtime.mjs`（`node --check` 抓不到这类运行时错误）。
- **0.2.1**：修复 `exports.inject` 里填了**包名**（而非 Cordis 服务键）→ 被当作服务名死等 → 客户端插件永远 `pending`，开机报 `did not activate`。
- **0.1.0–0.2.0**：早期开发阶段，记录未保留。

---

## 版本对照

| 版本 | 提交 | 日期 |
|---|---|---|
| 0.7.1 | `fcbd29b` | 2026-09-12 |
| 0.7.0 | `9cd3cbb` | 2026-09-12 |
| 0.5.1 | `219dd8d` | 2026-09-11 |

> 0.6.0 未单独留提交（与 0.7.0 合并于 `9cd3cbb`），其内容见上文。
