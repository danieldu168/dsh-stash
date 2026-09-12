# dsh-stash —— 外接数据源的门禁、钥匙与台账

让 agent 能取数，但看不到钥匙；能引用，但说不清来源就不算数。

它把散落的外部数据库 / 资料库 / 文献库 / MCP 服务登记成**一组可检索的 Model Tool**，
并为每条库回答三件 MCP 不回答的事：

| 问题 | 谁来回答 |
|---|---|
| 这条库**允许怎么取**？公开接口 / 官方 API / 只能人工导出 / 明确不做 | 库的 `access` 声明。**越界时拒绝执行，而不是尽力而为** |
| 取数要**哪把钥匙**、配没配、值放哪？ | 钥匙台账 + 宿主 credentials 服务。**模型全程看不到值** |
| 这次取数**取到了什么**？ | 取数台账。每条记录一个 `ledgerId` 与 `contentHash`，**只记指纹不记内容** |

分工分清楚：**MCP 是插座，stash 是配电箱**——谁有权限、走哪一路、什么时候用过。
通用连接会被标准化掉，凭据边界、口径陷阱和取数留痕不会。

装在 Profile 层（host 半边），所以：**每个新会话自动可用，不需要切 preset**，并出现在「设置 → 插件 → 插件清单」里。

## 安装

在 harness 源码目录执行（本地路径受支持）：

```powershell
# 路径换成这份代码所在的实际目录
pnpm dsh plugin --profile web add "<这份代码所在目录>"
# 例：Windows "D:\code\dsh-stash" · macOS/Linux "~/code/dsh-stash"
pnpm dsh plugin --profile web remove dsh-stash   # 卸载
```

`dsh plugin` 会把剩余参数转给 profile 目录里的 pnpm，然后 reconcile：读到本包的 `dsh.bundle.patch` 就自动把 `dsh-stash` 写进 `profiles/web/package.json` 的 `dsh.profile.bundles`。

> **新增包需要重启 Profile 才装载。** 重启前「设置 → 插件」里看不到它，这是正常的——那份清单读的是当前已装载的插件行。

## 在另一台电脑上使用

这个包 **零依赖、零构建脚本**（`dependencies` / `peerDependencies` / `devDependencies` / `scripts` 全空），代码里也没有任何机器专属路径——所有路径都由 `DSH_HOME` 或 `os.homedir()` 派生。

### 一、代码：拷目录，然后一条命令

把整个 `dsh-stash` 目录拷到新机器任意位置，然后：

```powershell
pnpm dsh plugin --profile web add "<新位置>/dsh-stash"
```

两种安装语义，按用途选：

| 方式 | 结果 | 适合 |
|---|---|---|
| **拷目录**（`link:`） | profile 软链到你的目录，改代码后重启即生效 | 自己用、还要继续改 |
| **tarball**（`npm pack` 后 `add ./dsh-stash-0.6.0.tgz`） | pnpm 解包成**副本**，与源码解耦 | 给别人、固定版本 |

### 二、数据：四块，处理方式不同

| 内容 | 位置 | 怎么办 |
|---|---|---|
| 库清单 | `$DSH_HOME/stash/sources.mjs` | 拷（可移植） |
| 工具代写的库 **与钥匙台账** | `$DSH_HOME/stash/sources.local.json` | 拷（`accounts` 在这里） |
| 取数台账 | `$DSH_HOME/stash/ledger.ndjson` | 按需拷（只含指纹，不含内容） |
| 原始语料 | `$DSH_HOME/stash/corpus/` | 按需拷（可能很大） |
| 取数缓存 | `$DSH_HOME/stash/cache/` | **别拷**，会重建 |

两份注册表都没有也不怕：插件首次启动会自种一份空模板；想直接从有内容的起点开始，包里附了 `sources.example.mjs`：

```powershell
mkdir -p "$DSH_HOME/stash" && cp sources.example.mjs "$DSH_HOME/stash/sources.mjs"
```

它包含四种形态的样例：内置 handler 的库（免登录、有已知坑）、免登录公开 JSON、**声明式 REST**（改注册表即可接入自有接口）、以及本地语料。

### 三、凭据：不要拷文件，用钥匙页重录

⚠️ `$DSH_HOME/.credentials.yaml` 里**不只有这个插件的钥匙**——它同时装着 `DEEPSEEK_API_KEY`、各集成 token、以及浏览器会话记录（`records:` 段）。整份拷过去等于把你**所有**密钥明文搬一遍，而且两边磁盘上都留一份。

- **推荐**：新机器上打开 **设置 → 钥匙**，列出的引用名逐个粘值。值从浏览器直连新机器的凭据服务，不进对话。
- **若必须搬运**：走加密信道（age / gpg / 密码管理器），不要网盘或 U 盘裸拷。

### 四、新机器上属正常的"异常"

- `stash_doctor` 报某个本地语料路径缺失 → 那台机器上没有那批文件，**正常**，不是 bug。
- 某条本地语料的目录不存在 → 插件启动时自动创建（`stash_doctor` 会报出来）。
- 若那个 harness 版本没有 `webServer` / `credentials` 服务 → 插件降级并在日志告警，**不会弄崩启动**（两条降级路径都已验证）。

## 它提供什么

| 工具 | 用途 |
|---|---|
| `stash_catalog` | 列出已登记的库：id、覆盖范围、可用动作、**取数边界**、凭据是否就绪、本地语料是否存在 |
| `stash_fetch` | 按 `source` + `action` 确定性取数（陷阱已固化成代码保证），**越界只留痕不取数**，返回 `ledgerId` |
| `stash_files` | 列出/检索本地语料（导出件、文档、数据集），返回路径供 `read` 使用 |
| `stash_ledger` | **查取数台账**：某个库以前取过什么、什么时候、多大一份、成功还是失败 |
| `stash_source_add` | **在对话里登记新库**，写入 `sources.local.json`；会导致取数失败的条目当场拒收 |
| `stash_doctor` | 文库本地体检（不联网）：注册表、条目深度校验、目录可写、handler、凭据、路径、台账 |
| `stash_credential_add` | **登记一条钥匙条目**（一个网站/API/MCP 服务 = 一条，下面挂若干字段）。没有 `value` 参数，永远不会有 |
| `stash_credential_remove` | 删除代写的条目或字段（不动凭据库里的值） |

## 使用边界（`access`）

文库不只回答"能不能取到"，还要回答"**这样取算不算越界**"。
一个尽力而为地绕过登录、脚本化抓付费库的取数层，对它的主人是负债——账号会被封，许可会违约，
而后果落在使用者自己头上。所以每条库都要声明边界：

| `access` | 含义 | `stash_fetch` 的行为 |
|---|---|---|
| `public-api` | 公开免登录接口 | 正常取数 |
| `official-api` | 需要官方机构 API 或授权凭据 | 正常取数（凭据在「设置 → 钥匙」里配） |
| `export-import` | 只允许人工在网页端导出后放进 `corpus/` | **拒绝**，返回 `kind:"boundary"`，并写一条台账 |
| `unsupported` | 明确不做（条款禁止、需绕过访问控制等） | **拒绝**，同上 |

不写 `access` 表示"未声明"：取数放行，但 `stash_doctor` 会把每条未声明的库列成提示，
`stash_source_add` 也允许你登记时一并声明。

**拒绝不是静默失败**：它同样写进台账，所以"我当时试过、它拒绝了"和"我没试过"是两件不同的事。

## 取数台账

研究的底线不是"能查到"，是"**三个月后还能说清这个数字是哪一次取来的**"。
harness 的会话日志保证"模型看到了什么"，它答不了"外部源当时返回了什么"——这条线由台账补上。

每次 `stash_fetch`（成功、失败、被边界拒绝）都追加一条记录到 `$DSH_HOME/stash/ledger.ndjson`：

```json
{
  "id": "d80b36b7553c",            // 引用这一步时把这个 id 一并报出去
  "at": "2026-09-12T02:54:40.850Z",
  "source": "trade_stats", "action": "product",
  "ok": true, "kind": null, "error": null,
  "cacheHit": false,               // 实际请求还是命中磁盘缓存
  "fetchedAt": "2026-09-12T02:54:38.101Z",   // 上游/缓存给出的取数时刻
  "status": 200, "bytes": 18422, "count": 27,
  "contentHash": "9f2c3a1b8e7d6405",         // 结果指纹
  "request": "https://www.trademap.org/...?product=020230",  // 已脱敏
  "params": { "product": "020230" },
  "origin": "handwritten", "engine": "0.7.0", "ms": 412
}
```

三条不可协商的设计决定：

1. **只落指纹，不落内容。** 台账写的是 `contentHash` / `bytes` / `count` / `fetchedAt`，不是响应体。
   内容归 `cache/` 与 `corpus/`，台账只回答"取过、取到多大一份、指纹是什么"。
   这既让台账永远很小，也让它天然不可能成为密钥的第二个落点。
2. **失败也记。** 取数失败、被边界拒绝，都留痕。
3. **台账写失败绝不影响取数。** 它是审计旁路，不在取数路径上。

`contentHash` **刻意排除 `cached` 字段**：同一份数据首次取数和之后命中缓存会得到同一个哈希。
所以「两次哈希相同」= 服务端返回的数据逐字节一致；「哈希变了」= 上游数据动过，值得看一眼。

文件是**有界追加**的 NDJSON：超过 2000 条时自动裁到最近 1000 条。

## 钥匙台账（与库注册表是两个问题）

| 清单 | 回答的问题 | 写在哪 |
|---|---|---|
| 库注册表 `export default [...]` | 某个库**需要**哪些钥匙 | 各库自己的 `credentials: [...]` 数组（一串引用名） |
| **钥匙台账 `accounts: [...]`** | 我**有**哪些账号、每个账号下有哪些字段 | `sources.local.json` 的 `accounts` |

### 为什么是「账号 + 字段」两层

一个引用名在宿主凭据库里就是**一个字符串值**，取值永远是 by-ref 的（`handler` 按 ref 取值、`source.credentials` 按 ref 声明需求）。所以"同一个网站只占一条目录"只能在**目录这一层**做：

```
示例：某网站          ← 一条账号：中文名 / 类别 / 网址 / 被谁引用
├── 账号   EXAMPLE_ACCOUNT    ✅ 已配置
├── 密码   EXAMPLE_PASSWORD   ✅ 已配置
└── 代理   EXAMPLE_PROXY      （非机密）
```

值这一层**不合并**：并成一条就只剩一个粗布尔，"缺账号还是缺密码"看不出来，库绑定也会从"我需要账号"退化成"我需要那一坨"。

条目字段：`id`（账号 id，小写）· `label`（中文名）· `category`（`site` 网站账号 / `api` API 密钥 / `database` 数据库 / `token` 令牌 / **`mcp` MCP / 智能体服务** / `other` 其他）· `url` · `notes` · `usedBy`（关联的库 id）。
字段可选键：`label`（显示名）· `secret`（是否机密，默认 true）· `multiline`（值是否多行：PEM 私钥 / service account JSON）· `inject`（值该注入到哪里，如 `env:FOO_API_KEY` / `header:Authorization` / `query:key` / `file:/path`）· `notes`（字段级非机密备注）。

三种登记方式，写的是同一份数据：

1. **面板**：设置 → 钥匙 → 「＋ 新建钥匙条目」（可加/删字段、勾选关联的库）
2. **模型**：说"帮我登记一个 XX 网站的账号" → `stash_credential_add`（单字段给 `ref`；多字段给 `fields`）
3. **编辑文件**：`sources.local.json`（**推荐**，界面可写）；写在手写 `sources.mjs` 里的条目界面**只读**（程序永不改写手写文件）

`stash_credential_add` 与写端点共用 `validateAccountInput`（含 `lib/secrets.js` 的密钥特征扫描，并显式拒绝 `value` 字段），所以两条路的校验规则不会漂移。

另外注册一条**人类命令**：

| 输入 | 输出 |
|---|---|
| `/stash` | 文库清单 + 每个库的凭据配置状态 + 本地语料路径 |
| `/stash <库id>` | 只看某一条库 |

它**不经模型**——契约原话是 execute "Parse and execute a known command **without sending it to the model**"，所以不消耗 token、不产生对话轮次，结果直接出现。

### 为什么是 `/stash`，而不是"跑一下 dsh-stash"

**插件名不是可调用对象。** 能被调用的只有 tool 和 command：

| 名字 | 是什么 | 怎么用 |
|---|---|---|
| `dsh-stash` | Profile Bundle id / 加载器行 | 只出现在「设置 → 插件清单」和 `cordis.yml` 里；**它本身没有动作可执行** |
| `stash_catalog` 等 | 7 个 Model Tool | 模型调用 |
| `/stash` | 人类命令 | 你直接输入，不经模型 |
| `stash` | 设置页的格子键（`settings.section` 的 id） | 「设置 → 钥匙」 |
| `$DSH_HOME/stash/` | 数据目录 | 注册表与语料 |

这与 **skill 不同**：skill 是"输入名字就激活"（把一段说明载入上下文），所以技能名可以直接敲。插件没有这个面——它往运行时里注册能力，你调用的是**那些能力**。

## 目录布局

```
${DSH_HOME}/stash/
├── sources.mjs          ← 手写注册表（库清单 + 台账形状说明）。程序永不改写它
├── sources.local.json   ← 代写分片：{ sources: [...库...], accounts: [...账号台账...] }
├── ledger.ndjson        ← 取数台账，机器写（指纹，不是内容；可随时删，删了就没了历史）
├── cache/               ← 取数缓存，机器写（可随时删）
├── corpus/              ← 原始语料，你放（如数据库导出件）
└── backup/              ← 迁移前留的 .bak（可随时删）
```

两份注册表**合并使用**，同 id 以手写文件为准（冲突会报进 `problems`）。这样分工的理由：手写文件里有你的注释和排版，让程序去改它迟早毁掉你的编辑；而"在对话里加一个库"或"在界面上改一条钥匙"又不该要求你手动编辑文件。

**每次工具调用都重新读取**（`.mjs` 用 mtime 穿透 ESM 缓存），所以改完无需重启 harness。

> **0.6.0 的台账迁移**：钥匙台账原本写在手写 `sources.mjs` 的 `export const credentials = [...]` 里，界面只读。现在它迁到 `sources.local.json` 的 `accounts`（两层：账号 + 字段），界面可以真正编辑。旧形状仍然可读（向后兼容），迁移前的原文件留在 `backup/`。

> **0.7.0 的变化**：新增 `access` 使用边界（声明 `export-import` / `unsupported` 的库会被 `stash_fetch` 拒绝并只留痕）、
> 新增取数台账 `ledger.ndjson` 与 `stash_ledger` 工具、`stash_doctor` 增加条目深度校验、
> `stash_source_add` 在登记前拒收会导致取数失败的条目（URL 写错、`{credential:REF}` 没声明、`required` 没出现在请求里、`paths` 不是绝对路径）。
> 全部是增量：**旧注册表不用改**，不写 `access` 只是会在体检里被提示补上。

> **0.7.1 的变化**：`handler: 'http'` 新增两个请求字段——
> `request.cacheTtlMs`（缓存寿命，过期自动重取；不写保持"永不过期"的旧行为）与
> `request.captureHeaders`（点名带出的响应头，用于配额一类的计数器；**不点名的一律不带出**，
> 所以 `set-cookie` 之类不会被顺手捞进结果）。响应头同时随缓存落盘，命中缓存时也能拿到配额数。

## 加库的三种方式

### ① 普通 REST 接口 —— 只改注册表，不用写代码

```js
{
  id: 'myapi',
  name: '我的接口',
  kind: 'remote',
  handler: 'http',
  credentials: ['MY_API_KEY'],          // 只写引用名
  access: 'official-api',               // 使用边界：public-api | official-api | export-import | unsupported
  actions: { query: '按关键词检索' },
  request: {
    url: 'https://api.example.com/search',
    method: 'GET',
    query:   { q: '{query}', limit: 20 },              // {参数名} 代入调用参数
    headers: { 'X-Api-Key': '{credential:MY_API_KEY}' },// {credential:引用名} 注入凭据
    pick:    'data.items',                             // 从响应里取哪一段（点路径）
    limit:   50,
    required: ['query'],                               // 缺了在发请求前报错
    minGapMs: 1000,                                    // 礼节性节流
    paginate: { param: 'page', start: 1, pages: 3 },   // 或 totalPath: 'meta.totalPages'
    cacheTtlMs: 60000,                                 // 缓存寿命（毫秒）；不写 = 永不过期
    captureHeaders: ['x-ratelimit-remaining'],         // 点名带出的响应头（配额计数器一类）
  },
}
```

也可以直接在对话里说"把这个接口登记成文库"，由 `stash_source_add` 落盘。

**凭据值只出现在真实请求里，回报的 URL / headers / body 一律脱敏为 `***引用名***`**——成功路径和失败路径都是。失败时不回报真实 URL（否则 query 里的凭据会泄漏到对话里）。

### ② 内置专用实现 —— 有已知坑的库

`handler: 'trade_stats'` / `'policy_alerts'`。这两个不是通用取数，而是把"容易算错的地方"固化成了代码：

1. `product` 缺失**在发请求前拦截**（否则 HTTP 400）。
2. `byProduct` 的 `records` 是**兄弟 HS 码**不是答案（实测返回 020220/020210），只读 `aggregateRecords`。
3. `byPartner` 按 `nbPages` **自动拼全部页**（实测阿联酋 020230 2024 共 27 条 = 25+2）。
4. 合计**只取 `aggregateRecords`**，绝不用逐伙伴求和——逐项舍入到千美元会差（实测 713,750 vs 713,748）。

复现样例：中国 020230 2025 进口 VAL = 12,893,515 千美元（中国海关总署）。

### ③ 本地语料

```js
{ id: 'mydocs', name: '我的文献', kind: 'files', paths: ['D:/papers'] }
```

## 安全边界（重要）

- **本插件不存储任何口令。** 注册表只写凭据**引用名**（全大写字母/数字/下划线，如 `MY_API_KEY`），值由 credentials 服务从 `~/.dsh/.credentials.yaml` 解析。
- `resolve` **每次调用重新解析**，所以改口令无需重启。
- `stash_catalog` 只用 `credentials.describe()`，只报"配没配"，**永不读取或回显口令值**。
- **两道防呆**：`credentials` 强制"环境变量风格"引用名（口令通常是混合大小写，不通过）；所有入库字符串再扫一遍高置信度的厂商密钥前缀（`sk-` / `ghp_` / `AKIA` / `AIza` / `eyJ` / `-----BEGIN PRIVATE KEY-----` 等）。命中就拒绝登记，并告诉你正确存放位置。
  - 刻意**不用**"长且随机"这类熵启发式：它会把 `D:/data/archive-2024-quarterly-report-final` 这种合法路径误判成密钥，误伤比漏报更糟。

## 需登录的商业数据库：不做 SSO 自动化

**不模拟登录拿会话态、不调加密接口、不用页面函数解密。**

理由：这条链路会从"调用公开接口"越界到**绕过访问控制与技术保护措施**；而且实名制读者卡与商业许可数据库的条款普遍禁止脚本化访问，后果落在持卡人自己的账号上。响应加密这一点，使其在著作权法与反不正当竞争法的框架下与"多调几次 API"不属同一类。

正当路径（本插件采用第一条）：

1. 浏览器手动检索 → 导出 → 放进 `corpus/` 下该库自己的子目录 → `stash_files` 登记 → `read` 分析；
2. 申请该数据库的官方机构 API；
3. 改用公开数据源（如 WIPO PATENTSCOPE）。

## 钥匙页（浏览器半边）

插件带一个客户端半边，在「设置」里加一页「钥匙」（`settings.section`，`order: 30`）：

- 顶部**统计条**：账号数 / 字段数 / ✅ 已配置 / ❌ 未配置（都按**字段**计，因为一个字段才是一条值）
- 按**类别**分组，组头写 `网站账号 (2 个账号 · 4 个字段) · 3/4 已配置`
- **一条账号一行**，默认折叠；**有未配置字段的默认展开**（下一步就是贴值）。展开后每个字段一行：显示名 + 引用名 + 注入点 + 状态
- **已配置的字段不摊开输入框**，只给「更换值」；点它才出现密码框（空提交不会清掉旧值）
- **「移除值」必须二次确认**——那是不可撤销地删凭据库里的值
- **「编辑信息」与「新建」是同一张字段表**：中文名 / 类别 / 网址 / 关联库（勾选）/ 提示 + 字段表（引用名、显示名、机密、多行值、注入点、字段备注、加/删行）。编辑时回填**元数据**；**值永远不回填**
- 手写 `sources.mjs` 里的条目标注「手写 · 界面只读」，编辑/删除按钮禁用（程序不改写手写文件）

**密钥怎么走**：输入框 → `ctx.remote.credentials.set(ref, value)` → 宿主凭据服务 → `~/.dsh/.credentials.yaml`。
**不经过 agent**：不进 tool 参数、不进会话记录、不进模型上下文。值也**不做 trim**——口令的首尾空格有意义，PEM / JSON 多行值不能被裁。

**台账读写**走 host 的同一个端点，按方法分发：

```
GET    /stash/credentials                 账号台账 + 库声明合并、统计、类别表、库清单
POST   /stash/credentials                 新建/替换一条账号（{ account, fields } 或旧形状单字段对象）
PATCH  /stash/credentials                 只改元数据（必须带 id）
DELETE /stash/credentials?id=xx&force=1   删整条代写账号
DELETE /stash/credentials?ref=XX&force=1  从所属账号里删掉一个字段
```

两个刻意的保护：

- **PATCH 默认不许删掉已配置的字段**（否则会留下没人认领的值）。真要删，回 409 并列出 `configuredRefs`，界面弹二次确认后才带 `dropConfigured: true` 重发。
- **DELETE 遇到已配置字段要 `force=1`**，且**只删台账条目、绝不动值**——删条目时值会变成孤儿，界面会明说这一点。

这些方法**都绝不接触密钥值**：GET 只用 `credentials.describe()`；POST/PATCH/DELETE 只写台账元数据，校验走 `validateAccountInput`（与 Model Tool 同一套），并且**显式拒绝带 `value` 的入参**。

**界面读不回已存的密钥**——不是靠代码自律，而是 `credentialsController` 契约原文：

> "Secret values cross in one direction only — **no method here returns one**."

客户端要的"有哪些引用名"由 host 半边的只读端点 `GET /stash/credentials` 提供，它内部只用 `credentials.describe()`，同样没有回值路径。

**客户端不是构建产物**：本包手写 `client/client.js`，格式与官方产物一致（`window.__ModuleLoader__.load({ id, factory })`），只 `require("react")` 这一项基线模块，因此不需要打包器（本机也没装 tsdown/esbuild/rollup/vite）。

### ⚠️ 三种"取服务"的方式，含义完全不同

| 位置 | 是什么 | 合法值 | 本包取值 |
|---|---|---|---|
| `package.json` → `dsh.client.inject` | 依赖的**客户端插件包名**（加载顺序） | 声明了 `dsh.client` 的包，如 `dshmarket`、`dsh-better-sidebar` | `[]`（不依赖任何动态客户端插件） |
| `client/client.js` → `exports.inject` | **Cordis 服务键**（fiber inject） | 客户端服务目录里的键：`layout` / `locale` / `sessions` / **`slots`** / `theme` / `timer` / `uiWorkspace` / `workspaces` | `["slots"]` |
| `lib/index.js` → `ctx.inject([...], cb)` | **服务就绪时回调**，不阻塞本插件 | 任何服务键，如 `webServer` / `commands` | `webServer`、`commands` |

**三条踩坑记录，代价递减但都真实发生过：**

1. **0.2.1**：`exports.inject` 里填了**包名**（`@deepseek-ai/dsh-client-ui-settings` 等）→ Cordis 把它们当服务名死等 → 客户端插件永远 `pending`，开机报 `did not activate`。注意 `@deepseek-ai/dsh-client-*` 这些**基线内核包本身没有 `dsh.client` 声明**，不能作为依赖项。
2. **0.3.2**：host 侧用 `ctx.get('webServer')` 在 `apply` 时**同步取**服务 → 那时还没就绪，拿到 `undefined` 就静默跳过路由注册 → 界面只看到 `HTTP 404`（空 body），而工具和页面一切正常。
   **正确做法是 `ctx.inject(['webServer'], (hostCtx) => ...)`** —— 见 `dshmarket/lib/index.js` 第 36 行，同一个 profile 里就有能工作的样板。
3. **0.3.1**：客户端里把 URL helper 命名成 `api`，与 `createSection(api)` 的**形参同名**→ 遮蔽 → async `load()` 抛 `TypeError` → effect 不 await → 只剩 unhandled rejection → 界面永远停在「正在读取」。`node --check` 抓不到这类运行时错误，所以有了 `test/client-runtime.mjs`。

**填错的后果不对称**：`exports.inject` 里放一个不存在的服务，会让整个客户端插件**永远 pending**，开机直接报

```
web boot: 1 entry did not activate
dsh-stash: pending (waiting for services: ...)
```

而**惰性获取**一个不存在的服务，只是那一次操作报错。所以本包的策略是：`inject` 只声明确实存在的 `slots`；凭据命名空间改为点击时用 `ctx.get("remote")` 取，取不到就给出可读提示。

注意：`@deepseek-ai/dsh-client-ui-settings` / `@deepseek-ai/dsh-api-remotes` / `@deepseek-ai/dsh-client-locale` 这些**没有** `dsh.client` 声明——它们是**基线内核**（built into the shell），不是可依赖的动态客户端插件。把它们写进任何一个 `inject` 都是错的。

## 已知限制

- 取数缓存**默认不过期**（向后兼容 0.6.0 行为）。注册表声明 `request.cacheTtlMs` 之后才有寿命，过期即自动重取；
  声明了 TTL 却拿不到可解析的 `fetchedAt` 时判为过期。**赔率、行情这类快变数据必须声明 TTL**，否则你会一直拿到旧快照。
  台账里的 `fetchedAt` 是判断数据新旧的第二道依据。
- **台账只记指纹不记内容**，所以它不能替代 `corpus/`。想复现内容本身，仍然要靠缓存或人工导出件。
- 台账目前只记 `source` / `action` / `params` 与结果指纹，**不记是哪个会话或哪个 agent 调的**。
- `stash_files` 的检索是子串匹配，不是语义检索；不做内容分析。它就不该被当成"文库检索"用。
- 给全新 API 加"通用取数"用 `handler: 'http'` 即可；只有当接口有特殊语义（翻页/聚合字段名/加密）时才需要写 handler 模块。
- `stash_doctor` 只做本地检查，不联网——它验证不了接口连通性，那是 `stash_fetch` 的事。
- **不做通用网页抓取**：一次性检索交给 harness 的 `web_search` / `web_fetch`；
  需要长期盯的页面本质是语料，走 `corpus/` + `stash_files`。再包一层是重复建设。
- **凭据引用名无法枚举**：宿主凭据服务的"引用"半边按设计没有列表接口（配置界面靠 schema 得知引用名）。所以钥匙页显示的是**台账里的账号**与**注册表里声明过的引用名**的并集——只被库声明、台账里没登记的会合成一条占位账号，标 ⚠️ 并提供「补登记」。
- **手写 `sources.mjs` 里的台账条目界面只读**：程序永不改写手写文件。想用界面编辑，就让条目住在 `sources.local.json`（默认落点）。
