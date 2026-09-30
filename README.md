# dsh-stash —— 个人在 DSH 里的外部资源库

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![tests](https://img.shields.io/badge/tests-409%20assertions-brightgreen)
![ci](https://github.com/danieldu168/dsh-stash/actions/workflows/ci.yml/badge.svg)

我在三台机器上用 DSH：家里的、公司的、还有一台旧的。

常用的数据库、资料库，十几个起步。每换一台机器，就得重新交代一遍——哪个接口、要哪把钥匙、上次那个数字是从哪儿来的。交代完过两个星期，自己都记不清了。

这个插件把这些收在一处。登记一次，三台机器都知道。

---

## 这是什么？

**一个目录，装着你所有外部资源的取法、钥匙和来路。**

工作生活要用的外部数据源，连同「允许怎么取、要哪把钥匙、取到了什么、踩过什么坑」，一起登记到 `${DSH_HOME}/stash/` 一个目录里。

登记的**资源**按**形态**分（完整分类与穷尽性论证见 [`DESIGN-taxonomy.md`](DESIGN-taxonomy.md)）：

| 形态 | 登记写法 | 怎么用 |
|---|---|---|
| 声明式 HTTP 端点 | `kind: "remote"` + `handler: "http"` | `stash_fetch` |
| 内置专用处理器（贸易统计 / 政策通报） | `kind: "remote"` + 对应 `handler` | `stash_fetch` |
| **本地数据库（SQLite，只读单查询）** | `kind: "remote"` + `handler: "db"` | `stash_fetch` |
| **对象存储 / 文件传输（S3、WebDAV）** | `kind: "remote"` + `handler: "objstore"` | `stash_fetch` |
| **本地语料** | `kind: "files"` | `stash_files` 检索 + `read` |
| **MCP 服务**（只登记，不代为取数） | `kind: "mcp"` | 用 DSH 直连 `mcp__<server>__<tool>` |

资源之外还管着四样**记录**：钥匙台账、取数台账、经验库，加上该库允许怎么取的那份声明。

对模型暴露 11 个工具：取数（`stash_fetch`）、看有什么（`stash_catalog` / `stash_files`）、查历史（`stash_ledger`）、体检（`stash_doctor`）、登记（`stash_source_add` / `stash_credential_add` / `stash_credential_remove`）、经验（`stash_lesson_add` / `_list` / `_remove`）。

另外两个入口不经过模型：`/stash` 命令行，同「设置 → stash」面板。

它装在 Profile 层，每个新会话自动可用，不用切 preset。拷走 `${DSH_HOME}/stash/` 这个目录，换机器就完了。

## 为什么需要 stash？

DSH 已经能连 MCP，也能上网查（`web_search` / `web_fetch`）。再包一层，是不是重复建设？

先看一个常见的省事答案：把网站、key、注意事项写进笔记，或者写进 `AGENTS.md`。

够不够？四处补不上：

| 缺口 | 笔记只能 | stash 补上 |
|---|---|---|
| 取数 | 写"这个网站怎么用"，模型还得自己拼 HTTP | 登记成库，`stash_fetch` 直接取 |
| 钥匙 | key 写进笔记，就是明文进每一次会话 | 只写引用名，值走宿主凭据服务 |
| 来源 | 说不清这个数字是哪一次取的 | 每次取数留 `ledgerId` 同 `contentHash` |
| 换机器 | 绝对路径同手抄清单一起失效 | 整个目录导出导入 |

再退一层：MCP 只回答"连得上"，不回答"允许怎么取、要哪把钥匙、取到了什么、踩过什么坑"。这四件事没有归属，代价是你每次都要重新交代一遍。

而个人用 DSH，偏偏最经不起"重新交代"。要用的资源是长期的，是自己的，还要在几台机器上都能用。三条叠起来，记性不够用——而这还只是十几个的时候。

人工智能时代要灌进来的数据、资料、资源是海量的。拿人的记性去对齐，**不是差距，是代差**——用互联网时代的那套经验，应付人工智能时代的需求。

**没有它，你和模型每次从零对齐；有了它，交代一次，以后它自己知道。**

反过来说，它回答的就是 MCP 不回答的那四个问题：

| 问题 | 谁来回答 |
|---|---|
| 这条库允许怎么取？ | 库的 `access` 声明。越界时拒绝执行，不尽力而为 |
| 要哪把钥匙、配没配？ | 钥匙台账 + 宿主凭据服务。模型全程看不到值 |
| 这次取到了什么？ | 取数台账：一条记录一个 `ledgerId` 同 `contentHash`，只记指纹 |
| 这条库踩过什么坑？ | 经验库：按库归档"下次别再踩"的东西 |

## 如何安装？

```powershell
pnpm dsh plugin --profile web add "<这份代码所在目录>"
```

装完**重启 Profile** 才装载。卸载：

```powershell
pnpm dsh plugin --profile web remove dsh-stash
```

**怎么确认装上了？** 重启后随便问一句：

> 我登记了哪些库？

没登记过，它会回"本机尚未登记外部资源"。要更细的自检，跑 `stash_doctor`——它不联网，只查注册表、目录可写、handler、凭据、路径、台账、经验缺口。

本包零依赖、零构建脚本，`private: true`（只发 GitHub）。换机器拷目录即可：所有路径由 `DSH_HOME` / `os.homedir()` 派生，没有机器专属硬编码。

### 已经装了，怎么升级？

DSH 没有"升级"这个动作。`plugin_manager` 只有四类动作——列举、启停、安装、移除，没有 update。**升级就是拿新版本重新装一次，再重启 Profile。**

有个坑值得先说。装完之后，管理器靠比对 `package.json` 里这个包的依赖串前后有没有变化，来判断这次装上了哪个包。**串没变，它就认为什么都没装成**，报 `ambiguous-install`，并把 `package.json` 同 `pnpm-lock.yaml` 一起还原。所以升级时让规格字符串动一下——**带上 tag**：

```powershell
pnpm dsh plugin --profile web add "github:danieldu168/dsh-stash#v0.11.0"
```

不带 tag 的 `github:danieldu168/dsh-stash` 只适合首次安装；升级时它一个字符都不变，正好踩上面那条。

如果你是从本机目录装的（依赖里是 `link:`），那就没有版本可升——`git pull` 完重启 Profile 就是最新版。

重启 Profile 之后新的 host 代码才装载；浏览器那一半硬刷新即可。

> 收录进 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 之后，用插件市场装的用户不必记这些：市场会逐插件比对 npm 版本或锁定 commit 与 HEAD，给出待更新行与一键更新，更新完同样提示重启。

### 目录长什么样

```
${DSH_HOME}/stash/
├── sources.mjs          手写注册表
├── sources.local.json   代写分片：{ sources, accounts }
├── ledger.ndjson        取数台账（只有指纹）
├── lessons.json         经验库（按库 id 分组）
├── cache/               取数缓存（可删，会重建）
├── corpus/              原始语料，你放
├── backup/              迁移前留的 .bak（可删）
└── .last-export.json    最近几次导出的记录
```

两份注册表**合并使用，同 id 以手写文件为准**。每次工具调用重新读取，改完不用重启。

## 如何登记第一条库？

注册表是 `${DSH_HOME}/stash/sources.mjs`。它是一个数组，**一条库 = 数组里的一个对象**。

首次启动时插件发现没有这个文件，会自种一份空表。想从样例起步，拷一份：

```powershell
mkdir -p "$DSH_HOME/stash"
cp sources.example.mjs "$DSH_HOME/stash/sources.mjs"
```

```
export default [
  { id: 'trade_stats', … },      ← 样例里已有的
  { id: 'policy_alerts', … },
  // 新的一条加在这里
]
```

**先分清两件事**——你说的"库信息"，在插件里是两个地方：

| | 存什么 | 存在哪 | 谁写 | 界面能改吗 |
|---|---|---|---|---|
| **库** | 某条数据源允许怎么取 | `sources.mjs` | 你手写 | 只能看 |
| **钥匙台账** | 我实际有哪几个账号、各是什么 | `sources.local.json` | 界面同工具代写 | 能改 |

库在 `credentials` 里声明"我需要哪几把钥匙"，但**账号与值都不写在 `sources.mjs` 里**。

拿一个公开接口练手，三步。

### 一、在数组里加一条

```js
{
  id: 'myapi', name: '我的接口', kind: 'remote', handler: 'http',
  access: 'public-api',
  actions: { search: '按关键词检索' },
  request: {
    url: 'https://api.example.com/search',
    query: { q: '{query}' },
    pick: 'data.items', limit: 50, required: ['query'],
  },
}
```

字段不多。`id` 是你在对话里叫它的名字，`kind` 决定这是远程接口还是本地语料，`handler` 决定用哪套取数实现，`access` 说明允许怎么取，`request` 是取数怎么拼。

要凭据的库，再加一行 `credentials: ['MY_API_KEY']`。只写引用名，不写值。

`{query}` 会被参数代入。**可选参数写成 `{?参数名}`**，缺参时整个查询键被丢弃，参数在时同 `{参数名}` 完全一样；它只能出现在 `request.query` 的值里。

为什么单有一种写法：`'eq.{category}'` 缺参数会代入成 `eq.`，看着合法、必被上游拒；而"可选过滤器"没法用 `required` 表达（那会把它变成必填）。

**不用重启**，每次工具调用都会重新读这个文件。

### 二、取一次

直接问：

> 用 myapi 查一下「光伏」

模型会先跑 `stash_catalog`，看这条库允许怎么取、参数叫什么、凭据配没配；再跑 `stash_fetch`。

### 三、看台账

问它"刚才那次取数的台账"。回来一条记录：时间、来源、`ledgerId`、`contentHash`、多少字节。

**没有响应体。** 台账只记指纹。

到这儿整套流程就走完了。剩下的都是变体。

### 另外两条路

**本机语料**——不用写代码：

```js
{ id: 'mydocs', name: '我的文献', kind: 'files', paths: ['D:/papers'] }
```

**内置专用实现**——`handler: 'trade_stats'` / `'policy_alerts'`。这两个不是通用取数，是把"容易算错的地方"固化成了代码：缺参在发请求前拦下、只读聚合字段而非明细、按 `nbPages` 自动拼全部页、合计绝不逐项求和（逐项舍入会差）。细节见 `lib/handlers/` 的模块注释。

## 取数时它做了什么？

### 取数有边界

| `access` | 含义 | 行为 |
|---|---|---|
| `public-api` | 公开免登录接口 | 正常取数 |
| `official-api` | 需官方 API 或授权凭据 | 正常取数（凭据在「设置 → stash › 远端接口 › 账号」里配） |
| `export-import` | 只允许人工在网页端导出后放进 `corpus/` | **拒绝**，返回 `kind:"boundary"` 并留痕 |
| `unsupported` | 明确不做（条款禁止、需绕过访问控制） | **拒绝**，同上 |

不写 `access` 表示未声明：取数放行，但 `stash_doctor` 会把每条未声明的库列成提示。

拒绝**不是静默失败**——它同样写台账。所以"我试过、它拒绝了"同"我没试过"是两件不同的事。

### 你问到外部数据时，它会递线索

插件挂在 `agent/pre-step` 上，也就是 harness 注入 `AGENTS.md` 用的同一条接缝。每步之前它能读到你这一轮说了什么：

- 你这句话点到某条已登记的库（id 或中文名）→ 递上那几条的要点：取数边界、凭据引用名、落点、能不能直接取
- 你这句话有取数意图（外部数据、接口、凭据、数据库、语料等）→ 递上全景：登记了几条、哪几条只能人工导出
- 都不是 → **一个 token 都不加**

同一句话只递一次（一个回合有多个 step）。递的是线索不是数据，真正取数仍由模型调 `stash_fetch`。

### 取数留台账

研究的底线不是"能查到"，是"三个月后还能说清这个数字是哪一次取来的"。

三条不可协商。**只落指纹不落内容**——`contentHash` / `bytes` / `count` / `fetchedAt`，不是响应体。**失败也记。** **写台账失败绝不影响取数。**

`contentHash` 刻意排除 `cached`，所以两次哈希相同 = 服务端返回逐字节一致；哈希变了 = 上游数据动过。

### 坑记在经验库

台账记「取过什么」，注册表记「允许怎么取」。经验库补第三件事，而坑通常失败之后才被认识。

各库的坑本就不一样——贸易数据是口径陷阱，文献库是检索语法，MCP 服务是鉴权流程。所以不规定经验长什么样：除 `title` 外全是可选字段，不设分类、不设枚举。

```jsonc
// ${DSH_HOME}/stash/lessons.json —— 按库 id 分组
{ "myapi": [ { "id": "…", "at": "…",
               "title": "byProduct 的 records 是兄弟编码，不是答案",
               "body": "只读聚合字段。",
               "action": "byProduct", "tags": ["口径"], "evidence": "<ledgerId>" } ] }
```

- 两条写入路径地位相同：人直接编辑这个文件（没有 `id` 的条目在读取时派生一个稳定 id，照样能列出、能删）；或让模型用 `stash_lesson_add` / `_remove`。工具回写会规范化排版。
- `evidence` 填台账的 `ledgerId`，把「这次踩的坑」同「这一次取数的留痕」接起来，于是可复现。
- 三处带出：`stash_catalog` 给条数 + 最近 3 条标题（只有单库查询才给全文，免得灌爆上下文）；`stash_doctor` 报总量并点出**有失败台账却没记经验**的库；`stash_fetch` 失败时提示可记一条，并附本次 `ledgerId`。
- 每库上限 200 条，**到顶拒绝写入而不是静默淘汰**。悄悄丢掉别人写下的教训，比报错糟糕。

⚠️ 经验库是明文文件。工具那条路会过密钥特征扫描，手写那条路不会（那是你自己的文件）。别把口令写进去。

## 钥匙放在哪、怎么不外泄？

### 值只有两条路进来

面板（设置 → 钥匙），同 `/stash import`。两条都不进 tool 参数、不进会话记录、不进模型上下文。

模型手里的 `stash_credential_add` **没有 `value` 参数，永远不会有**——它只能登记"有这么一把钥匙、放在哪"，不能放值。

界面也显示不出已存的值——凭据服务没有回值方法。

### 两个存储，一处录入

值落在哪，由这把钥匙声明的 `inject` 决定：

| 消费者 | `$DSH_HOME/.env` | 「设置 → 钥匙」面板 |
|---|---|---|
| 走 `ctx.credentials` 的（stash 的 `{credential:REF}`） | 可以 | 可以，且优先级更高 |
| 读 `process.env` 的（如 MCP 行的 `!!js` 表达式） | 可以 | **无效** |

`env:NAME` 落点的钥匙，在面板里贴一次会**两处都写**：凭据服务 + `.env`。所以面板立刻是绿的。

但读 `process.env` 的组件要**重启 DSH** 才看得到，`.env` 只在启动时读一次。

落点写错的表现是「面板一片绿、功能却是断的」。

### 面板结构：一页首页 + 两层下钻

面板名就是插件名：**stash**（`设置 → stash`）。落地页是**首页**，**数字优先**——一页就能回答"我有多少、坏了几条"：

```
                            ＋ 新建条目
资源
  13   资源总数                        ● 12 就绪   ● 1 有阻塞 →
  6            6            1
  远端接口      本机服务      本机文件
  2 个账号·1 把钥匙未配置   依赖本机在跑   7 个路径
台账
  取数台账 29 条（失败 6） · 经验库 10 条 · 覆盖 4 个库
  有 2 条库失败过却没记经验 —— 进「资源」看是哪条
▸ 迁移（导出 / 导入 / 清空）
```

- **三类是唯一一级分类**：`远端接口` / `本机服务` / `本机文件`。它按"东西怎么进来的"分，人话优先；技术细节（MCP、S3/WebDAV、SQLite、声明式 HTTP…）只在**登记时**出现，首页与卡片上不做分类展示。
- 归类**自动派生**，不需要人填：`files` 与 SQLite → 本机文件；MCP 走 stdio、以及**回环地址**（`127.0.0.1` / `localhost` / `::1`）→ 本机服务；其余 → 远端接口。回环判定的反例（本地反向代理把远端伪装成 `127.0.0.1`）由注册表字段 `bucket` 覆盖，登记表单里可改。
- `0 条`的那一类**照常显示**——空本身是信息，三格也才是稳定的一套。
- 「有阻塞」旁的数字**可点**，直达该类的阻塞筛选。

### 类层：账号在前，资源在后

点任一格进入那一类。标题是类名，面包屑从 `stash` 起，回退走「← 概览」。

```
账号                 N 个 · M 把钥匙            [全部账号 →]
  [搜索账号名 / 网址 / 引用名]
  某账号   [类别]   id                已配置 / N 把未配置
    ● REF_NAME  已配置 · 落点 query:apiKey
资源                 K 条                      [＋ 新建资源]
  [全部 K] [就绪] [有阻塞]            [搜索 id / 名称 / 摘要]
  名称   [形态]   id   [手写/代写]     就绪 / 有阻塞
    边界 · 用量 · 经验 · 卡在哪 / 失败过却没记经验
    详情 ▾ → 禁止边界 / 动作 / 路径 / 命令 / [编辑] [删除]
```

- **钥匙跟着资源走**：账号块只列**这一类资源用到的账号**（按引用名交叉认领）。没被任何资源引用的账号走「全部账号 →」进钥匙三层。今天账号全落在「远端接口」；将来本机服务需要 token 时，它会自己出现在那一类里。
- 账号块有**自己的搜索**，超过 4 个折叠。
- **改与删只对代写条目开放**：卡片详情里有「编辑」「删除」；手写条目（`sources.mjs`）没有这两个按钮，卡上写明"程序不改写它"。
- 删除只要**一次二次确认**（不像清空整库那样要输校验码），并说清后果：台账只追加不删；该库的经验仍在 `lessons.json`，但界面按已登记库聚合，所以不再显示。
- 顶部筛选是**三挡状态**（全部 / 就绪 / 有阻塞）+ 搜索框；形态写在每张卡的标签上，不再做分组。

### 新建 / 编辑资源：两级下拉 + 必填 4 项

```
＋ 新建条目
  账号      一个服务 / 网站，下面挂若干把钥匙（引用名）
  资源      能被取数的东西 → 选一个细分（下拉）
    声明式 HTTP 接口   http                     没有专用处理器的接口都走这里      → 远端接口
    内置处理器         trade_stats / policy_alerts                              → 远端接口
    本地数据库         db · SQLite              只支持 SQLite；其他库走 HTTP 门面 → 本机文件
    对象存储           objstore · S3 / WebDAV   SFTP、SMB 直连暂不支持          → 远端接口
    本地语料           files                    文件或目录，只登记路径            → 本机文件
    MCP 服务           mcp                      只登记；取数走 DSH 直连          → 本机服务 / 远端接口
```

表单分四组：**标注**（id、名称）、**取数**（随形态变）、**边界**（四个 chip，其中 ◇ 两个是硬门禁）、**钥匙**（只填引用名）。必填只 4 项，其余（请求头、必填参数、条数上限、前缀、摘要、禁止边界）折进「高级」。

- 校验**与模型侧 `stash_source_add` 是同一套代码**——面板的写端点直接调用那个工具本体，不会这边放行、那边失败。
- 报错落到具体字段上：顶部一条汇总（`⚠ …（共 N 处需要改）`），字段就地标红，并说清怎么改。
- 表单里**永远没有"值"的输入框**：只登记引用名；值只能由人在账号详情里贴。
- 边界那组下面写明：**只有 ◇ 只能人工导出 / ◇ 明确不做会被硬拒绝**（`stash_fetch` 不取数、只留痕），另外两个是声明。

### 资源写端点

| 方法 | 路径 | 做什么 |
|---|---|---|
| `POST` | `/stash/sources` | 新建 / 覆盖一条**代写**资源（`overwrite: true` 才是编辑语义） |
| `DELETE` | `/stash/sources?id=` | 删除一条代写资源；手写条目拒绝；顺带把它从账号的 `usedBy` 里摘掉 |

两条都**只对 `sources.local.json` 生效**——程序永不改写 `sources.mjs`。回报里会说明台账与经验的去向。

实现上 `createLibrariesView` 仍是**无 hook 的纯渲染**：数据与筛选状态由页面持有、通过 props 传入。所以它不是第二个设置页，切层也不会动到 hook 顺序。


## 想加东西的时候写在哪、谁来写？

五样东西，各有三条路（面板 / 手写 / 模型）。**面板能改的只有代写条目**——程序永不改写 `sources.mjs`。

| 要写什么 | 面板 | 手动 | 让模型写 |
|---|---|---|---|
| **资源**（库） | ✅ 新建 / 编辑 / 删除（`设置 → stash` → 任一格 → 「＋ 新建资源」，或卡片详情里的编辑/删除） | 编辑 `sources.mjs`（手写件，程序永不改写；面板对它只读） | `stash_source_add`（写进 `sources.local.json`） |
| **钥匙条目**（引用名、落点） | ✅ 新建 / 编辑 / 删除（类层的账号块 → 账号详情） | 编辑 `sources.local.json` 的 `accounts` | `stash_credential_add` |
| **钥匙的值** | ✅ 账号详情里粘贴（`env:` 落点同时写 `$DSH_HOME/.env`） | 写 `~/.dsh/.credentials.yaml` 或 `$DSH_HOME/.env` | **写不了**，工具没有 `value` 参数 |
| **经验** | ➖ 没有入口（刻意的） | 编辑 `lessons.json` | `stash_lesson_add` / `_remove` |
| **语料** | ➖ 面板不搬文件（只登记路径） | 文件丢进 `corpus/` | `stash_source_add`（`kind: "files"`） |

面板的新建与编辑都走 `stash_source_add` **本体**，所以登记时就会把**会导致取数失败的条目**拒掉（`request.url` 写错、SQL 不是只读单语句、引用名没声明…），报错直接落在对应字段上，不用等真去取才发现。经验没有面板入口是刻意的：经验是**判断**（"下次别再这么写"），不是事实；自动生成的多半是噪音，所以只由模型或人在想清楚之后写一条。系统能做的是**发现缺口**——哪条库失败过却没记经验，卡片上会点出来。

### 六种形态各自的字段

`kind` 决定形状，`handler` 决定怎么取数。照抄 [`sources.example.mjs`](sources.example.mjs) 里对应的那一条即可：

| 形态 | 必填字段 | 说明 |
|---|---|---|
| `remote` + `http` | `request.url` | 声明式：`query` / `headers` / `body` / `pick` / `limit` / `required` / `minGapMs` / `cacheTtlMs` / `paginate` / `captureHeaders`；`{参数名}` 代入参数、`{credential:引用名}` 注入凭据 |
| `remote` + `trade_stats` / `policy_alerts` | `request` | 内置专用实现，把已知坑写进了代码 |
| `remote` + `db` | `request.engine`（只能是 `sqlite`）、`request.path`（绝对路径）、`request.sql`（单条 SELECT/WITH） | 零依赖（Node 内置 `node:sqlite`）；只读打开 + 只放行只读单语句；`required` 声明 `:name` 占位符；`limit` 限行数 |
| `remote` + `objstore` | `request.protocol`（`s3` / `webdav`）、`request.endpoint` | `s3` 还要 `bucket`（+ 签名时的 `region` 与 `accessKeyIdRef` / `secretAccessKeyRef`）；`webdav` 可给 `usernameRef` / `passwordRef`。动作只有 `list` / `get` |
| `files` | `paths`（绝对路径数组） | 只登记路径；`stash_files` 列目录/子串检索，`read` 读内容 |
| `mcp` | `server` | 只登记，**不经 stash 取数**；建议再给 `transport`（`stdio` / `streamable-http` / `sse`）与 `tools`（如 `mcp__my-service__*`） |

服务端数据库（Postgres / MySQL / 数仓）**没有**内置 handler：本包零依赖，不引入数据库驱动。给它套一层只读 HTTP 门面，按 `remote` + `http` 登记即可。

## 如何换到另一台机器？

一个人常常同时用几台机器，而且往往不是「换」而是「并存」，所以要的是**合并**，不是覆盖。

三条命令都不经过模型：

```powershell
/stash export --out "D:\stash-export"   # 默认不带值；带值加 --with-values（明文），语料加 --corpus
/stash import "D:\stash-export"         # 值覆盖、积累并集；先看结果加 --dry-run
/stash wipe --confirm <校验码>          # 清空本机 stash 痕迹（只清数据，不卸插件）
```

三件事在「设置 → 钥匙」的**迁移**区块里也有（默认折叠），同命令调的是同一批函数。面板只送动作、目录、开关、校验码，**值永远不经过浏览器**。浏览器拿不到本地绝对路径，所以面板里的目录要手输或粘贴。

### 合并的规则

| 内容 | 规则 |
|---|---|
| 凭据的值 | **覆盖**——一个引用名只有一个值 |
| 库条目 / 钥匙账号 | 按 id **并集**；同 id 不同定义报冲突，**保留本机** |
| 经验库 | **并集**；按（来源库 + 标题）去重；同标题不同正文报冲突，**保留本机** |
| 取数台账 | **只拼接，不去重**——「在两台机器各查过一次」本身就是事实 |
| 原始语料 | 文件级并集；同名不同内容报冲突 |
| `sources.mjs` | 内容不同时只报告，请人工合并 |

冲突**一律不自动决定**，报出来由你研判。绝大多数条目落在「只有一侧有」，不会来烦你。

两件不能随行。**凭据的值**——`.credentials.yaml` 装着本机所有密钥，别整拷；走 `--with-values`，或照包里的 `credentials-guide.md` 在新机器重录一次，那份指南记着每把钥匙从哪来、该放到哪。**语料的绝对路径**——换机器要重指一次。

### 清空有两道门

顺序铁律：**先导出 → 在另一台机器导入成功 → 再回旧机器清空**。

| 门 | 判据 | 不过时 |
|---|---|---|
| 一 | 本机**有过导出记录** | 面板上按钮灰着并写明原因；host 的 `plan-wipe` 也会拒 |
| 二 | 填入的**校验码**对得上某次导出记录在案的码 | host 拒绝，面板在确认框里报错 |

host **无法验证"另一台机器真的导入成功了"**，它只认"这个码是本机某次导出产生过的"。所以校验码是**人工对账**，不是密码学证明。

清空只删 `$DSH_HOME/stash/` 里的东西，并按名删除 stash 认得的凭据值，**清单外的引用名一律不碰**。`corpus/` 默认不删。

### 导出包长什么样

要认出"这是不是一个 stash 导出包"，**只看包里的 `manifest.json`，不看目录名**。目录可以随便改名、移动、压进 zip 再解压，包还是同一个包。

```
stash-export-20260926-1340/
├── manifest.json          识别标记 + 校验清单（必需）
├── sources.mjs            手写注册表，原样拷
├── sources.local.json     代写分片
├── ledger.ndjson          取数台账
├── lessons.json           经验库
├── credentials-guide.md   办理指南（给人读，不参与校验）
├── corpus/                仅 --corpus 时有
└── values.json            仅 --with-values 时有（明文）
```

识别规则（`verifyBundle` 就按这个顺序判）：

1. 有 `manifest.json` 吗——没有就不是导出包
2. `kind === "dsh-stash-export"` 吗——不是就拒
3. `format === 1` 吗——不是就明说"本包格式为 X，本版只认 1"
4. 逐个文件核 sha256——对不上就拒，且**本机一字未动**

`manifest.json` 的字段：

| 字段 | 含义 |
|---|---|
| `format` | 格式版本。格式变了旧版本会明确拒绝，而不是误读 |
| `kind` | 固定 `dsh-stash-export` |
| `hasValues` / `includesCorpus` / `corpusFiles` | 带没带值、带没带语料 |
| `files` | 校验清单：包内每个文件的 `path` / `bytes` / `sha256` |
| `refs` | 涉及的引用名 + 各自 `inject` 落点 + 归属账号。只有引用名，没有值 |
| `verifyCode` | 8 位十六进制。由文件哈希、引用名、两个开关算出 |

`values.json` 自带 `kind: "dsh-stash-values"` 同自己的 `format`，单看一个文件也认得出。

三条不能做的事：不要编辑包内任何文件（哈希对不上，导入会被拒）；不要把 `values.json` 当普通附件传（它是明文密钥库）；不要往包里手塞语料（不进 `manifest.files`，导入时不会被合并）。

## 它不做什么？

**不做通用网页抓取。** 一次性检索交给 `web_search` / `web_fetch`；需要长期盯的页面本质是语料，走 `corpus/` + `stash_files`。再包一层是重复建设。

**不做需登录数据库的 SSO 自动化。** 不模拟登录拿会话态、不调加密接口、不用页面函数解密。那条链路会从"调用公开接口"越界到绕过访问控制与技术保护措施，而且实名制读者卡同商业许可数据库的条款普遍禁止脚本化访问，后果落在持卡人自己的账号上。正当路径：人工导出 → `corpus/` 下该库的子目录 → `stash_files` → `read`。

**不做值的存储与回读。** 凭据服务本身没有回值方法，这是框架保证，不是代码自律。

经验库也**不自动写入**——失败只提示，不替你决定该不该记。

## 它做不到什么？

**数据新鲜度。** `cacheTtlMs` 不写就是永不过期。快变数据务必自己声明。

**台账。** 只记指纹，反查不到内容。文件超 2000 条裁到最近 1000 条，旧的会丢。

**检索与体检。** `stash_files` 的检索是子串匹配，经验库的 `query` 也是，都不是语义检索。`stash_doctor` 只做本地检查、不联网，验证不了接口连通性。

**按需线索。** 判据是关键词匹配，两个方向都会失手：你说"那个 API"却没提库名，只会得到全景线索；说"数据结构"可能被当成取数意图。快照异步刷新，刚加完的库可能还没读到；读不到清单时干脆不注入。

**凭据。** 宿主凭据服务的"引用"半边按设计没有列表接口，所以钥匙页显示的是台账里的账号同注册表里声明过的引用名的并集。同一个限制决定了 `/stash wipe` 的删除范围：它只能按台账 + 库声明推出来的清单删值。既不在台账、也没有库引用、`inject` 又不是 `env:` 的名字，插件认不出来，清空后请照报告核对一遍。

**迁移。** 换机器要重指语料的绝对路径。改过 `inject` 落点名留下的旧 `.env` 键不会被自动清，插件只认当前的 `inject`。

## 开发与测试

零依赖、零构建，测试是手写的 `check()` 断言 + 计数汇总，不引任何测试框架：

```powershell
node test/host-assembly.mjs     # host 半边（注册表 / 工具 / 三条路由 / 提示注入）：223 项断言
node test/client-runtime.mjs    # client 半边（首页 + 类层 + 钥匙三层 + 资源表单/编辑/删除）：220 项断言
node test/portability.mjs       # 导出 / 导入 / 清空：87 项断言
node test/handlers-bc.mjs       # B/C 类 handler（SigV4 官方向量 / SQLite / S3 / WebDAV）：42 项断言
node scripts/preflight-upload.mjs  # 上传前自检：仓库里不该有你的库、钥匙、台账、语料、本机路径
```

`host-assembly.mjs` 同 `portability.mjs` 都跑在临时 `DSH_HOME`（`os.tmpdir()` 下）里，跑完自清理，**既不读也不写你真实的 `~/.dsh/`**。`client-runtime.mjs` 只读 `client/client.js` 源码，用最小 React 运行时驱动它，不碰磁盘。

**上传 GitHub 之前跑一次 `scripts/preflight-upload.mjs`**：它扫整个仓库，命中就非零退出——不该进仓库的数据文件（`sources.mjs` / `sources.local.json` / `ledger.ndjson` / `lessons.json` / `cache/` / `corpus/` / `stash-export-*/` / `.credentials.yaml` / `.env`）、Windows 与 macOS/Linux 的用户目录绝对路径、**邮箱地址**、疑似密钥值与令牌（`sk-` / `sbp_` / `AKIA` / `ghp_` / `AIza` / JWT）、私钥正文。CI 里也有这一步，所以误提交会在 PR 上直接红掉。

当前状态：**572 项断言全部通过**。CI 在 `.github/workflows/ci.yml`（node 22 / 24；Node 22.5–23.3 的 `node:sqlite` 需 `--experimental-sqlite`，那几条真库断言会自动跳过并说明，其余照跑）。

设计取舍见 `DESIGN-taxonomy.md`（资源分类：四条通道与 A–H 形态）、`DESIGN-vault.md`（钥匙台账）、`DESIGN-lessons.md`（经验库）、`DESIGN-portability.md`（多机迁移）。版本变化见 `CHANGELOG.md`。

## 许可

MIT。
