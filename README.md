# dsh-stash —— 外接数据源的门禁、钥匙与台账

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![tests](https://img.shields.io/badge/tests-184%20assertions-brightgreen)
![ci](https://github.com/danieldu168/dsh-stash/actions/workflows/ci.yml/badge.svg)

让 agent 能取数，但看不到钥匙；能引用，但说不清来源就不算数。

把散落在外部数据库 / 资料库 / 文献库 / MCP 服务登记成**一组可检索的 Model Tool**，并回答 MCP 不回答的四件事：

| 问题 | 由谁回答 |
|---|---|
| 这条库**允许怎么取**？ | 库的 `access` 声明。**越界时拒绝执行，而不是尽力而为** |
| 取数要**哪把钥匙**、配没配？ | 钥匙台账 + 宿主 credentials 服务。**模型全程看不到值** |
| 这次取数**取到了什么**？ | 取数台账：每条记录一个 `ledgerId` 与 `contentHash`，**只记指纹不记内容** |
| 这条库**踩过什么坑**？ | 经验库：按库归档"下次别再踩"的东西 |

装在 Profile 层（host 半边），所以每个新会话自动可用，不需要切 preset。

## 安装

```powershell
pnpm dsh plugin --profile web add "<这份代码所在目录>"
pnpm dsh plugin --profile web remove dsh-stash   # 卸载
```

- 新增包**需要重启 Profile** 才装载。
- 本包**零依赖、零构建脚本**，且 `private: true`（只发 GitHub、不发 npm）；换机器拷目录即可——所有路径由 `DSH_HOME` / `os.homedir()` 派生，没有机器专属硬编码。
- 包内附 `sources.example.mjs`，含四种形态的样例（内置 handler / 公开 JSON / 声明式 REST / 本地语料），可直接拷作起点。

## 工具

| 工具 | 用途 |
|---|---|
| `stash_catalog` | 列出已登记的库：id、覆盖范围、动作、**取数边界**、凭据是否就绪、经验条数 |
| `stash_fetch` | 按 `source` + `action` 确定性取数；**越界只留痕不取数**，返回 `ledgerId` |
| `stash_files` | 列出/检索本地语料，返回路径供 `read` 使用 |
| `stash_ledger` | 查取数台账：某个库以前取过什么、多大一份、成功还是失败 |
| `stash_source_add` | **在对话里登记新库**（写入 `sources.local.json`）；会导致取数失败的条目当场拒收 |
| `stash_doctor` | 本地体检（**不联网**）：注册表、条目深度校验、目录可写、handler、凭据、路径、台账、经验缺口 |
| `stash_lesson_add` / `_list` / `_remove` | **经验库**：按库记「踩过的坑与正确写法」 |
| `stash_credential_add` / `_remove` | 钥匙台账条目。**没有 `value` 参数，永远不会有** |

另有两条不经模型的入口：人类命令 `/stash`（不耗 token），以及「设置 → 钥匙」页。

## 数据布局

```
${DSH_HOME}/stash/
├── sources.mjs          手写注册表（库清单 + 台账形状说明）。**程序永不改写它**
├── sources.local.json   代写分片：{ sources, accounts }
├── ledger.ndjson        取数台账（只有指纹）
├── lessons.json         经验库（按库 id 分组）
├── cache/               取数缓存（可删，会重建）
├── corpus/              原始语料，你放
└── backup/              迁移前留的 .bak（可删）
```

两份注册表**合并使用，同 id 以手写文件为准**。每次工具调用都重新读取，改完无需重启。

## 使用边界（`access`）

| 值 | 含义 | `stash_fetch` 行为 |
|---|---|---|
| `public-api` | 公开免登录接口 | 正常取数 |
| `official-api` | 需官方机构 API 或授权凭据 | 正常取数（凭据在「设置 → 钥匙」配） |
| `export-import` | 只允许人工在网页端导出后放进 `corpus/` | **拒绝**，返回 `kind:"boundary"` 并留痕 |
| `unsupported` | 明确不做（条款禁止、需绕过访问控制） | **拒绝**，同上 |

不写 `access` 表示未声明：取数放行，但 `stash_doctor` 会把每条未声明的库列成提示。
**拒绝不是静默失败**——它同样写台账，所以"我试过、它拒绝了"和"我没试过"是两件不同的事。

## 取数台账

研究的底线不是"能查到"，是"**三个月后还能说清这个数字是哪一次取来的**"。

三条不可协商：**只落指纹不落内容**（`contentHash` / `bytes` / `count` / `fetchedAt`，不是响应体）；**失败也记**；**写台账失败绝不影响取数**。
`contentHash` 刻意排除 `cached`，所以"两次哈希相同"= 服务端返回逐字节一致；"哈希变了"= 上游数据动过。文件有界：超 2000 条裁到最近 1000 条。

## 经验库

台账记「取过什么」，注册表记「允许怎么取」，经验库补上第三件事——而坑通常是**失败之后**才被认识的。

各库的坑本就不一样（贸易数据是口径陷阱，文献库是检索语法，MCP 服务是鉴权流程），所以 stash **不规定经验长什么样**：除 `title` 外全是可选字段，**不设分类、不设枚举**——判断内容属于使用它的人。

```jsonc
// ${DSH_HOME}/stash/lessons.json —— 按库 id 分组
{ "myapi": [ { "id": "…", "at": "…",
               "title": "byProduct 的 records 是兄弟编码，不是答案",
               "body": "只读聚合字段。",
               "action": "byProduct", "tags": ["口径"], "evidence": "<ledgerId>" } ] }
```

- **两条写入路径地位相同**：人直接编辑这个文件（**没有 `id` 的条目在读取时会派生一个稳定 id**，所以照样能列出、能删）；或让模型用 `stash_lesson_add` / `_remove`。工具回写会规范化排版（排序 + 缩进 + 落盘派生 id）。
- `evidence` 填台账的 `ledgerId`，把「这次踩的坑」和「这一次取数的留痕」接起来，于是可复现。
- **三处带出**：`stash_catalog` 全量清单给**条数 + 最近 3 条标题**（只有单库查询才给全文，免得灌爆上下文）；`stash_doctor` 报总量并点出**有失败台账却没记经验**的库；`stash_fetch` 失败时提示可记一条，并附本次 `ledgerId`。
- 每库上限 200 条，**到顶拒绝写入而不是静默淘汰**——悄悄丢掉别人写下的教训比报错糟糕。

⚠️ 经验库是**明文文件**。工具那条路会过密钥特征扫描，手写那条路不会（那是你自己的文件）——但别把口令写进去，钥匙请走「设置 → 钥匙」。

## 钥匙台账

一个引用名在凭据库里就是**一个字符串值**，所以"同一个网站只占一条目录"只能在**目录这一层**做：

```
示例：某网站                ← 一条账号：中文名 / 类别 / 网址 / 被谁引用
├── 账号   EXAMPLE_ACCOUNT    ✅ 已配置
├── 密码   EXAMPLE_PASSWORD   ✅ 已配置
└── 代理   EXAMPLE_PROXY      （非机密）
```

值这一层**不合并**：并成一条就只剩一个粗布尔，"缺账号还是缺密码"看不出来。

三种登记路径写同一份数据：**面板**（设置 → 钥匙）、**模型**（`stash_credential_add`）、**手改** `sources.local.json`。手写 `sources.mjs` 里的条目**界面只读**——程序永不改写手写文件。

**值只有一条路径**：浏览器输入框 → `ctx.remote.credentials.set()` → 宿主凭据服务 → `$DSH_HOME/.credentials.yaml`。
不进 tool 参数、不进会话记录、不进模型上下文；值**不做 trim**（口令首尾空格有意义，多行 PEM 也不能裁）。

## 安全边界

- **本插件不存储任何口令。** 注册表只写凭据**引用名**（如 `MY_API_KEY`），值由 credentials 服务解析，每次调用重新解析，所以改值无需重启。
- `stash_catalog` 只用 `credentials.describe()`，只报"配没配"，**永不读取或回显口令值**。
- **两道防呆**：引用名强制"环境变量风格"（口令通常是混合大小写，不通过）；所有入库字符串再扫一遍高置信度的厂商密钥前缀（`sk-` / `ghp_` / `AKIA` / `AIza` / `eyJ` / `-----BEGIN PRIVATE KEY-----`），命中即拒绝并告诉你正确存放位置。
  - 刻意**不用**"长且随机"这类熵启发式：它会把 `D:/data/archive-2024-quarterly-report-final` 这种合法路径误判成密钥，误伤比漏报更糟。

## 加库的三种方式

**① 声明式 REST —— 只改注册表，不用写代码**

```js
{
  id: 'myapi', name: '我的接口', kind: 'remote', handler: 'http',
  credentials: ['MY_API_KEY'],            // 只写引用名，绝不写值
  access: 'official-api',
  actions: { search: '按关键词检索' },
  request: {
    url: 'https://api.example.com/search',
    query:   { q: '{query}' },                            // {参数名} 代入调用参数
    headers: { 'X-Api-Key': '{credential:MY_API_KEY}' },  // {credential:引用名} 注入凭据
    pick: 'data.items', limit: 50, required: ['query'], minGapMs: 1000,
    // cacheTtlMs: 60000,                       // 缓存寿命；不写=永不过期（快变数据务必声明）
    // captureHeaders: ['x-ratelimit-remaining'], // 点名带出的响应头（配额计数器一类）
    // paginate: { param: 'page', start: 1, totalPath: 'meta.totalPages' },
  },
}
```

回报的 URL / headers / body 一律脱敏为 `***引用名***`——成功路径与失败路径都是。

**② 内置专用实现** —— `handler: 'trade_stats'` / `'policy_alerts'`。这两个不是通用取数，而是把"容易算错的地方"固化成了代码：缺参在发请求前拦截、只读聚合字段而非明细、按 `nbPages` 自动拼全部页、合计绝不逐项求和（逐项舍入会差）。细节见 `lib/handlers/` 里的模块注释。

**③ 本地语料** —— `{ id: 'mydocs', name: '我的文献', kind: 'files', paths: ['D:/papers'] }`

## 换一台机器

| 内容 | 位置 | 怎么办 |
|---|---|---|
| 库清单 | `sources.mjs` | 拷（可移植） |
| 代写的库与钥匙台账 | `sources.local.json` | 拷（`accounts` 在这里） |
| 取数台账 | `ledger.ndjson` | 按需拷（只含指纹，不含内容） |
| 经验库 | `lessons.json` | 拷（这是你的判断，值得带走） |
| 原始语料 | `corpus/` | 按需拷（可能很大） |
| 取数缓存 | `cache/` | **别拷**，会重建 |
| 凭据的**值** | `.credentials.yaml` | **不要拷**——它装着本机所有密钥。到新机器后在「设置 → 钥匙」里逐个重录 |

## 开发与测试

零依赖、零构建，测试是手写的 `check()` 断言 + 计数汇总，不引任何测试框架：

```powershell
node test/host-assembly.mjs     # host 半边：127 项断言
node test/client-runtime.mjs    # client 半边：57 项断言
```

`host-assembly.mjs` 跑在临时 `DSH_HOME`（`os.tmpdir()` 下）里，跑完自清理，**既不读也不写你真实的 `~/.dsh/`**；`client-runtime.mjs` 只读取 `client/client.js` 源码，用最小 React 运行时驱动它，不碰磁盘。
当前状态：**184 项断言全部通过**。CI 在 `.github/workflows/ci.yml`（node 22 / 24）。

`client-runtime.mjs` 存在的理由：`node --check` 抓不到"变量遮蔽导致 async `load()` 抛错"这类运行时错误——那种 bug 的表现是界面永远停在"正在读取"，必须有一步真跑渲染。

## 不做的事

- **不做通用网页抓取**：一次性检索交给 harness 的 `web_search` / `web_fetch`；需要长期盯的页面本质是语料，走 `corpus/` + `stash_files`。再包一层是重复建设。
- **不做需登录数据库的 SSO 自动化**：不模拟登录拿会话态、不调加密接口、不用页面函数解密。那条链路会从"调用公开接口"越界到**绕过访问控制与技术保护措施**，而且实名制读者卡与商业许可数据库的条款普遍禁止脚本化访问，后果落在持卡人自己的账号上。正当路径：人工导出 → `corpus/` 下该库的子目录 → `stash_files` → `read`。
- **不做值的存储与回读**：凭据服务本身没有回值方法，这是框架保证，不是代码自律。
- 经验库**不做语义检索**（`query` 是子串匹配）、**不自动写入**（失败只提示，不替你决定该不该记）。

## 已知限制

- 取数缓存**默认不过期**（向后兼容）。行情、赔率这类快变数据必须在注册表里声明 `request.cacheTtlMs`，否则你会一直拿到旧快照；台账里的 `fetchedAt` 是判断数据新旧的第二道依据。
- 台账**只记指纹不记内容**，所以它不能替代 `corpus/`——想复现内容本身仍要靠缓存或人工导出件。
- 台账目前不记"是哪个会话 / 哪个 agent 调的"。
- `stash_files` 的检索是**子串匹配**，不是语义检索；不做内容分析。它不该被当成"文库检索"用。
- `stash_doctor` 只做本地检查、**不联网**，验证不了接口连通性——那是 `stash_fetch` 的事。
- **凭据引用名无法枚举**：宿主凭据服务的"引用"半边按设计没有列表接口。所以钥匙页显示的是"台账里的账号"与"注册表里声明过的引用名"的并集；只被库声明、台账里没登记的会合成一条占位账号并标 ⚠️。

## 许可

MIT。设计决策记录见 `DESIGN-vault.md`（钥匙台账）与 `DESIGN-lessons.md`（经验库）；版本变化见 `CHANGELOG.md`。
