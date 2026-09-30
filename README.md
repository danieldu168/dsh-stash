# dsh-stash —— 我在 DSH 里的外部资源库

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![tests](https://img.shields.io/badge/tests-606%20assertions-brightgreen)
![ci](https://github.com/danieldu168/dsh-stash/actions/workflows/ci.yml/badge.svg)

常用有三台电脑：家里的、公司的、还有一台旧的。

常用的数据库、资料库，十几个起步。每换一台机器，就得重新交代一遍——哪个接口、要哪把钥匙、上次那个数字是从哪儿来的。交代完过两个星期，自己都记不清了。

这个插件把这些收在一处。登记一次，三台机器都知道。

---

## 它回答三个问题

您会问：DSH 已经能连 MCP，也能上网查，再包一层，是不是重复建设？

MCP 只回答"连得上"。留下三问没有归属——**能不能取、用哪把钥匙、这次取了什么**。没有人回答这三问，代价就是每次会话从零交代一遍。

stash 就是这三问的归宿：

| 三问 | 答案在哪 | 一条硬约束 |
|---|---|---|
| 能不能取？ | 库的 `access` 声明 | 两条硬门禁**直接拒绝**，不尽力而为 |
| 用哪把钥匙？ | 钥匙台账 + 宿主凭据服务 | 值不进模型、不进会话记录、不进台账 |
| 这次取了什么？ | 取数台账 | 只记指纹（`ledgerId` / `contentHash`），没有响应体 |

对模型暴露 11 个工具（取数 / 清单 / 台账 / 体检 / 登记 / 经验）。另有两条路不经过模型：`/stash` 命令同「设置 → stash」面板。

## 如何安装

```powershell
pnpm dsh plugin --profile web add "github:danieldu168/dsh-stash#v0.11.0"
```

装完重启 Profile，浏览器那半边硬刷新。验一句：问「我登记了哪些库？」——没登记过，它回"本机尚未登记外部资源"。

升级就是**带上新 tag 重装一次**，再重启。DSH 没有 update 这个动作，管理器只有列举、启停、安装、移除四类。**规格串一个字符都不变，它就认为什么都没装成**，报 `ambiguous-install`，并把 `package.json` 同 `pnpm-lock.yaml` 一起还原——所以升级必须让 tag 动一下。

从本机目录装的（依赖里是 `link:`）没有版本可升：`git pull` 完重启就是最新。卸载：

```powershell
pnpm dsh plugin --profile web remove dsh-stash
```

本包零依赖、零构建脚本，`private: true`，只发 GitHub。路径全部由 `DSH_HOME` / `os.homedir()` 派生，没有机器专属硬编码。

## 如何登记

注册表是 `${DSH_HOME}/stash/sources.mjs`。一条库 = 数组里一个对象。改完不用重启，每次调用重读。

```js
export default [
  {
    id: 'myapi', name: '我的接口', kind: 'remote', handler: 'http',
    access: 'public-api',
    actions: { search: '按关键词检索' },
    request: {
      url: 'https://api.example.com/search',
      query: { q: '{query}' },
      pick: 'data.items', limit: 50, required: ['query'],
    },
  },
]
```

三点够用了：

- `{参数名}` 代入参数。**可选参数写 `{?参数名}`**——缺参时整个键被丢掉。不这么写，`'eq.{category}'` 缺参就代入成 `eq.`，看着合法，必被上游拒。
- 要钥匙就加 `credentials: ['MY_API_KEY']`。只写引用名，不写值。
- 六种形态照抄 [`sources.example.mjs`](sources.example.mjs)。为什么是这六种，见 [`DESIGN-taxonomy.md`](DESIGN-taxonomy.md)。

不想写代码的两条路：

- **本机文档**：`{ id: 'mydocs', kind: 'files', paths: ['D:/papers'] }`。只登记路径，检索走 `stash_files`，读内容走 `read`。
- **内置处理器**：`handler: 'trade_stats'`。把容易算错的地方固化进代码——缺参在发请求前拦下、只读聚合字段而非明细、按 `nbPages` 自动拼全、**合计绝不逐项求和**（逐项舍入会差）。

改完直接说「用 myapi 查一下光伏」。模型先 `stash_catalog` 看边界同参数，再 `stash_fetch`。

## 边界写在注册表里

| `access` | 含义 | 行为 |
|---|---|---|
| `public-api` | 公开免登录接口 | 取 |
| `official-api` | 需官方 API 或授权凭据 | 取（钥匙在面板配） |
| `export-import` | 只允许人工在网页端导出后放进 `corpus/` | **拒绝**，返回 `kind:"boundary"` |
| `unsupported` | 明确不做 | **拒绝**，同上 |

不写 `access` 就是未声明：取数放行，但 `stash_doctor` 会把这条列成提示。

拒绝不是静默失败——它同样写台账。所以"我试过、它拒绝了"同"我没试过"是两件事。

## 钥匙放在哪

值只有两条路进来：「设置 → stash」面板，或 `/stash import`。两条都不进 tool 参数、不进会话记录、不进模型上下文。

模型手里的 `stash_credential_add` **没有 `value` 参数，永远不会有**；界面也显示不出已存的值——凭据服务没有回值方法。

值落在哪，由这把钥匙声明的 `inject` 决定：

| 消费者 | `$DSH_HOME/.env` | 「设置 → 钥匙」面板 |
|---|---|---|
| 走 `ctx.credentials` 的（stash 的 `{credential:REF}`） | 可以 | 可以，且优先级更高 |
| 读 `process.env` 的（如 MCP 行的 `!!js` 表达式） | 可以 | **无效，且不报错** |

`env:NAME` 落点的钥匙，在面板里贴一次会两处都写。但 `.env` 只在启动时读一次——读 `process.env` 的组件要重启 DSH 才看得到。

**落点写错的表现是「面板一片绿、功能却是断的」。**

## 工作面板

`设置 → stash`。三层：首页 → 类层 → 详情。逐条说明见 [`DESIGN-panel.md`](DESIGN-panel.md)。

```
首页                          类层（点任一格）              新建 / 编辑
数据源                        远端接口                      新建什么 [远端接口 ▾]
  12 个数据源   ● 就绪/阻塞     账号   2 个·3 把钥匙  [全部▾]   形态   [声明式 HTTP ▾]
  6 远端接口  5 本机服务        资源   6 条·6 就绪    [全部▾]   ID / 名称 / 地址 / 边界…
  1 本机文件                    整行点开 = 详情（编辑/删除）    ▸ 高级设置
台账 + 迁移（折叠）                                          新建账号 →（次要入口）
```

用词分两层：首页数的是**数据源**（三类合计），类层列的是**这一类里的资源**。同一个词只出现一次，免得问"资源到底指什么"。

三类是唯一一级分类：远端接口 / 本机服务 / 本机文件。归类自动派生，不用人填——`files` 同 SQLite 归本机文件，MCP 走 stdio、或走回环地址，归本机服务，其余归远端接口。本地反向代理把远端伪装成 `127.0.0.1` 是真实存在的反例，注册表字段 `bucket` 可以覆盖。

五个写入位置：

| 要写什么 | 面板 | 手写 | 模型 |
|---|---|---|---|
| 资源 | ✅ | `sources.mjs` | `stash_source_add` |
| 钥匙条目 | ✅ | `sources.local.json` | `stash_credential_add` |
| 钥匙的值 | ✅ | `~/.dsh/.credentials.yaml` / `.env` | **写不了** |
| 经验 | ➖ 刻意没有入口 | `lessons.json` | `stash_lesson_add` |
| 语料 | ➖ 不搬文件 | 放进 `corpus/` | `stash_source_add` |

面板的写走 `stash_source_add` 本体——URL 写错、SQL 不是只读单语句、引用名没声明，登记时就拒掉，报错落在字段上，不用等真去取才发现。它**永不改写手写件**：`sources.mjs` 对面板只读。

经验没有面板入口是刻意的。经验是判断，不是事实；自动生成的多半是噪音。系统只做一件能做的——**把缺口点出来**：哪条库失败过却没记经验。

## 如何迁移

三条命令，都不经过模型：

```powershell
/stash export --out "D:\stash-export"   # 默认不带值；--with-values 带明文，--corpus 带语料
/stash import "D:\stash-export"         # 值覆盖、条目并集；--dry-run 先看结果
/stash wipe --confirm <校验码>          # 清空本机数据，不卸插件
```

铁律一条：**先导出 → 在新机器导入成功 → 再回旧机器清空**。清空过两道门（本机有过导出记录、校验码对得上），但 host 验证不了"另一台真的导入成功了"——校验码是人工对账，不是密码学证明。

导入规则一句话：值覆盖，条目并集，台账只拼接不去重（两台各查过一次本身就是事实），同 id 不同定义报冲突并保留本机。冲突一律不自动决定。

**凭据的值不随包走。** `.credentials.yaml` 装着本机所有密钥，别整拷。逐项规则、包结构、`manifest.json` 字段见 [`DESIGN-portability.md`](DESIGN-portability.md)。

## 它不做什么

**不做通用网页抓取。** 一次性检索交给 `web_search` / `web_fetch`；需要长期盯的页面本质是语料，走 `corpus/` + `stash_files`。

**不做需登录数据库的 SSO 自动化。** 不模拟登录拿会话态、不调加密接口。那条路会从"调用公开接口"越界到绕过访问控制，而且读者卡同商业许可数据库的条款普遍禁止脚本化访问，后果落在持卡人自己的账号上。正当路径：人工导出 → `corpus/` 下该库的子目录 → `stash_files` → `read`。

**不做值的存储，也不回读。** 凭据服务本身没有回值方法，这是框架保证，不是代码自律。

经验也**不自动写入**：失败只提示，记不记由人定。

## 它做不到什么

**数据新鲜度。** `cacheTtlMs` 不写就是永不过期，快变数据务必自己声明。

**台账反查内容。** 只记指纹，反查不到内容。文件超 2000 条裁到最近 1000 条，旧的会丢。

**语义检索。** `stash_files` 的检索同经验库的 `query` 都是子串匹配。

**接口连通性。** `stash_doctor` 只做本地检查、不联网，验不了接口通不通——要验就直接取一次。

**按需线索的准头。** 判据是关键词匹配，两个方向都会失手：说"那个 API"却不提库名，只得全景；说"数据结构"可能被当成取数意图。快照异步刷新，刚加完的库可能还没读到。

**凭据的完整视图。** 凭据服务的引用半边按设计没有列表接口，面板显示的是台账同注册表声明过的引用名的并集。`/stash wipe` 的删除范围同此限。

## 框架目录

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

两份注册表合并使用，同 id 以手写文件为准。

## 开发测试

零依赖、零构建，手写的 `check()` 断言，不引测试框架。

```powershell
node test/host-assembly.mjs        # 注册表 / 工具 / 三条路由 / 提示注入 —— 223 项
node test/client-runtime.mjs       # 首页 + 类层 + 钥匙三层 + 表单 / 编辑 / 删除 —— 254 项
node test/portability.mjs          # 导出 / 导入 / 清空 —— 87 项
node test/handlers-bc.mjs          # SigV4 官方向量 / SQLite / S3 / WebDAV —— 42 项
node scripts/preflight-upload.mjs  # 上传前自检（CI 也跑这一步）
```

**606 项断言全部通过。** host 同 portability 跑在临时 `DSH_HOME`（`os.tmpdir()` 下），跑完自清理，既不读也不写你真实的 `~/.dsh/`；client 测试只读 `client/client.js` 源码。

上传 GitHub 之前跑一次 `scripts/preflight-upload.mjs`。它扫整个仓库，命中就非零退出：数据文件、Windows、macOS、Linux 的用户目录绝对路径、邮箱、疑似密钥值、令牌、私钥正文。

设计取舍见 [`DESIGN-taxonomy.md`](DESIGN-taxonomy.md)（分类）/ [`DESIGN-vault.md`](DESIGN-vault.md)（钥匙）/ [`DESIGN-lessons.md`](DESIGN-lessons.md)（经验）/ [`DESIGN-portability.md`](DESIGN-portability.md)（迁移）/ [`DESIGN-panel.md`](DESIGN-panel.md)（面板）。版本变化见 [`CHANGELOG.md`](CHANGELOG.md)。

## 许可

MIT。

---

十几条的时候，靠记性还撑得住。

上百条的时候，拿记性去对齐，不是差距，是代差。
