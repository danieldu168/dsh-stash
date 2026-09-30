# dsh-stash —— DSH 里的外部资源库

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![tests](https://img.shields.io/badge/tests-606%20assertions-brightgreen)
![ci](https://github.com/danieldu168/dsh-stash/actions/workflows/ci.yml/badge.svg)

把外部数据源登记一次，模型就知道**能不能取、用哪把钥匙、这次取了什么**。拷走 `${DSH_HOME}/stash/` 一个目录，换机器就完了。

## 它管三件事

| | 管什么 | 关键约束 |
|---|---|---|
| **门禁** | 这条库允许怎么取 | `access` 四值；两条硬门禁**直接拒绝并留痕** |
| **钥匙** | 要哪把、配没配 | 值只走宿主凭据服务；模型看不到，台账也不落 |
| **台账** | 这次取到了什么 | 只记指纹（`ledgerId` / `contentHash`），**没有响应体** |

不用它的代价是每次会话从零交代一遍。MCP 回答"连得上"，这三件事它不回答——这就是留出来的位置。

对模型暴露 11 个工具（取数 / 清单 / 台账 / 体检 / 登记 / 经验）；另有两条不经模型的入口：`/stash` 命令与「设置 → stash」面板。

## 装

```powershell
pnpm dsh plugin --profile web add "github:danieldu168/dsh-stash#v0.11.0"
```

| 事项 | 做法 |
|---|---|
| 生效 | 装完**重启 Profile**；浏览器那半边硬刷新 |
| 升级 | **带上新 tag 重装一次**再重启。DSH 没有 update 动作 |
| 为什么必须带 tag | 规格串不变，管理器判成 `ambiguous-install` 并回滚 `package.json` |
| 本机目录装的（`link:`） | 没有版本可升：`git pull` + 重启 |
| 卸载 | `pnpm dsh plugin --profile web remove dsh-stash` |
| 确认装上 | 问「我登记了哪些库？」没登记过会回"本机尚未登记外部资源" |

零依赖、零构建脚本，`private: true`（只发 GitHub）。所有路径由 `DSH_HOME` / `os.homedir()` 派生，没有机器专属硬编码。

## 登记第一条

注册表是 `${DSH_HOME}/stash/sources.mjs`，**一条库 = 数组里一个对象**。改完不用重启（每次调用重读）。

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

- `{参数名}` 代入参数；**可选参数写 `{?参数名}`**——缺参时整个键被丢弃，避免拼出 `eq.` 这种看着合法、必被上游拒的查询。
- 要钥匙就加 `credentials: ['MY_API_KEY']`，**只写引用名，不写值**。
- 六种形态照抄 [`sources.example.mjs`](sources.example.mjs)；分类与穷尽性见 [`DESIGN-taxonomy.md`](DESIGN-taxonomy.md)。

不需要写代码的两种：

| 形态 | 一条就够 |
|---|---|
| 本机文档 | `{ id: 'mydocs', kind: 'files', paths: ['D:/papers'] }` |
| 内置处理器 | `handler: 'trade_stats'`——把容易算错的地方固化进代码：缺参在发请求前拦下、只读聚合字段而非明细、按 `nbPages` 自动拼全、合计不逐项求和 |

取一次：直接说「用 myapi 查一下光伏」。模型先 `stash_catalog` 看边界与参数，再 `stash_fetch`。

## 取数边界

| `access` | 含义 | 行为 |
|---|---|---|
| `public-api` | 公开免登录接口 | 取 |
| `official-api` | 需官方 API 或授权凭据 | 取（钥匙在面板配） |
| `export-import` | 只允许人工在网页端导出后放进 `corpus/` | **拒绝**，返回 `kind:"boundary"` 并留痕 |
| `unsupported` | 明确不做 | **拒绝**，同上 |

不写 = 未声明：取数放行，但 `stash_doctor` 会把这条列成提示。拒绝**不是静默失败**——它同样写台账，所以"我试过、它拒绝了"和"我没试过"是两件不同的事。

## 钥匙放哪

值只有两条路进来：**「设置 → stash」面板**，或 `/stash import`。两条都不进 tool 参数、不进会话记录、不进模型上下文。模型手里的 `stash_credential_add` **没有 `value` 参数，永远不会有**；界面也显示不出已存的值。

| 消费者 | `$DSH_HOME/.env` | 「设置 → 钥匙」面板 |
|---|---|---|
| 走 `ctx.credentials` 的（stash 的 `{credential:REF}`） | 可以 | 可以，**优先级更高** |
| 读 `process.env` 的（如 MCP 行的 `!!js` 表达式） | 可以 | **完全无效，且不报错** |

`env:NAME` 落点的钥匙，在面板里贴一次会**两处都写**。但 `.env` 只在启动时读一次——读 `process.env` 的组件要**重启 DSH** 才看得到。

**落点写错的表现是「面板一片绿、功能却是断的」。**

## 面板

`设置 → stash`。结构三张图，逐条说明见 [`DESIGN-panel.md`](DESIGN-panel.md)。

```
首页                          类层（点任一格）              新建 / 编辑
数据源                        远端接口                      新建什么 [远端接口 ▾]
  12 个数据源   ● 就绪/阻塞     账号   2 个·3 把钥匙  [全部▾]   形态   [声明式 HTTP ▾]
  6 远端接口  5 本机服务        资源   6 条·6 就绪    [全部▾]   ID / 名称 / 地址 / 边界…
  1 本机文件                    整行点开 = 详情（编辑/删除）    ▸ 高级设置
台账 + 迁移（折叠）                                          新建账号 →（次要入口）
```

| 面板能做 | 面板不做 |
|---|---|
| 新建 / 编辑 / 删除**代写**资源 | 改写手写 `sources.mjs`（对它只读） |
| 录入钥匙的值（唯一入口） | 显示已存的值（凭据服务没有回值方法） |
| 导出 / 导入 / 清空 | 替你搬语料文件（只登记路径） |

### 五个写入位置

| 要写什么 | 面板 | 手写 | 模型 |
|---|---|---|---|
| 资源 | ✅ | `sources.mjs` | `stash_source_add` |
| 钥匙条目 | ✅ | `sources.local.json` | `stash_credential_add` |
| 钥匙的值 | ✅ | `~/.dsh/.credentials.yaml` / `.env` | **写不了** |
| 经验 | ➖ 刻意没有入口 | `lessons.json` | `stash_lesson_add` |
| 语料 | ➖ 不搬文件 | 放进 `corpus/` | `stash_source_add` |

面板的写走 `stash_source_add` **本体**，所以会导致取数失败的条目当场被拒（`request.url` 写错、SQL 不是只读单语句、引用名没声明），报错落到字段上。经验没有面板入口是刻意的：经验是**判断**，自动生成的多半是噪音；系统只负责**发现缺口**——失败过却没记经验的库会在卡片上点出来。

写端点两条，**只对 `sources.local.json` 生效**：

| 方法 | 路径 | 做什么 |
|---|---|---|
| `POST` | `/stash/sources` | 新建 / 覆盖一条代写资源（`overwrite: true` 才是编辑语义） |
| `DELETE` | `/stash/sources?id=` | 删除一条代写资源；手写条目拒绝；顺带从账号的 `usedBy` 里摘掉 |

## 换机器

三条命令，都不经过模型：

```powershell
/stash export --out "D:\stash-export"   # 默认不带值；--with-values 带明文，--corpus 带语料
/stash import "D:\stash-export"         # 值覆盖、条目并集；--dry-run 先看结果
/stash wipe --confirm <校验码>          # 清空本机 stash 痕迹（只清数据，不卸插件）
```

铁律：**先导出 → 在新机器导入成功 → 再回旧机器清空**。清空过两道门（本机有过导出记录、校验码对得上），但 host **验证不了"另一台真的导入成功了"**——校验码是人工对账，不是密码学证明。

导入规则一句话：**值覆盖，条目并集，台账只拼接（不去重），同 id 不同定义报冲突并保留本机**；冲突一律不自动决定。**凭据的值不随包走**：`.credentials.yaml` 装着本机所有密钥，别整拷。

逐项规则、包结构、识别规则、`manifest.json` 字段见 [`DESIGN-portability.md`](DESIGN-portability.md)。

## 它不做什么

| 不做 | 为什么 / 正当路径 |
|---|---|
| 通用网页抓取 | 一次性检索用 `web_search` / `web_fetch`；长期盯的页面是语料，走 `corpus/` + `stash_files` |
| 需登录数据库的 SSO 自动化 | 会从"调公开接口"越界到绕过访问控制，条款普遍禁止，后果落在持卡人账号上。正当路径：人工导出 → `corpus/` → `stash_files` → `read` |
| 值的存储与回读 | 凭据服务本身没有回值方法，是框架保证 |
| 自动写经验 | 失败只提示，记不记由人判断 |

## 它做不到什么

| 做不到 | 具体表现 |
|---|---|
| 数据新鲜度 | `cacheTtlMs` 不写就是永不过期；快变数据务必自己声明 |
| 台账反查 | 只记指纹；文件超 2000 条裁到最近 1000 条，旧的会丢 |
| 语义检索 | `stash_files` 的检索与经验库 `query` 都是子串匹配 |
| 接口连通性 | `stash_doctor` 只做本地检查、不联网 |
| 按需线索的准头 | 判据是关键词匹配，两个方向都会失手（说"那个 API"不提库名只得到全景；说"数据结构"可能被当成取数意图）；快照异步刷新，刚加完的库可能还没读到，读不到清单时干脆不注入 |
| 凭据的完整视图 | 凭据服务的引用半边没有列表接口，面板显示的是台账 + 注册表声明的并集；`wipe` 的删除范围同此限 |

关于"按需线索"：插件挂在 `agent/pre-step` 接缝上——你这句话点到已登记的库就递那几条的要点，有取数意图就递全景，都不是则**一个 token 都不加**；同一句只递一次。

## 目录长什么样

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

两份注册表**合并使用，同 id 以手写文件为准**。

## 开发与测试

零依赖、零构建，手写的 `check()` 断言，不引测试框架：

| 命令 | 覆盖 | 断言 |
|---|---|---|
| `node test/host-assembly.mjs` | 注册表 / 工具 / 三条路由 / 提示注入 | 223 |
| `node test/client-runtime.mjs` | 首页 + 类层 + 钥匙三层 + 表单 / 编辑 / 删除 | 254 |
| `node test/portability.mjs` | 导出 / 导入 / 清空 | 87 |
| `node test/handlers-bc.mjs` | SigV4 官方向量 / SQLite / S3 / WebDAV | 42 |
| `node scripts/preflight-upload.mjs` | 上传前自检（CI 也跑这一步） | — |

**606 项断言全部通过。** host 与 portability 跑在临时 `DSH_HOME`（`os.tmpdir()` 下），跑完自清理，**既不读也不写你真实的 `~/.dsh/`**；client 测试只读 `client/client.js` 源码。

上传 GitHub 之前跑一次 `scripts/preflight-upload.mjs`：扫整个仓库，命中就非零退出——数据文件（`sources*` / `ledger.ndjson` / `lessons.json` / `corpus/` / `.credentials*` / `.env`）、Windows 与 macOS/Linux 的用户目录绝对路径、邮箱、疑似密钥值与令牌、私钥正文。

设计取舍见 [`DESIGN-taxonomy.md`](DESIGN-taxonomy.md)（分类）/ [`DESIGN-vault.md`](DESIGN-vault.md)（钥匙）/ [`DESIGN-lessons.md`](DESIGN-lessons.md)（经验）/ [`DESIGN-portability.md`](DESIGN-portability.md)（迁移）/ [`DESIGN-panel.md`](DESIGN-panel.md)（面板）。版本变化见 [`CHANGELOG.md`](CHANGELOG.md)。

## 许可

MIT。
