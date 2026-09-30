// ─────────────────────────────────────────────────────────────────────────────
// dsh-stash 注册表示例 —— 复制它作为你自己的起点：
//
//   mkdir -p "$DSH_HOME/stash" && cp sources.example.mjs "$DSH_HOME/stash/sources.mjs"
//
// （$DSH_HOME 默认是 ~/.dsh；插件首次启动若发现没有 sources.mjs，会自种一份空表。）
//
// 编辑后无需重启：每次工具调用都会重新读这个文件。
//
// 字段：
//   id          唯一标识（小写字母/数字/-/_；stash_fetch 用它）
//   name        展示名
//   kind        'remote' 远程接口 | 'files' 本地语料
//   handler     kind=remote 必填：trade_stats | policy_alerts | http
//                 - trade_stats / policy_alerts 是内置专用实现（含已知坑的固化）
//                 - http 是声明式通用取数，配合 request 用，无需写代码
//   request     handler=http 时必填，见下方第 3 条
//   paths       kind=files 时必填，本地文件或目录的绝对路径数组
//   credentials 需要的凭据"引用名"数组（不是值！）
//   access      使用边界：public-api | official-api | export-import | unsupported
//                 - public-api    公开免登录接口，程序可以直连取数
//                 - official-api  需要官方机构 API 或授权凭据（凭据在「设置 → 钥匙」里配）
//                 - export-import 只能人工在网页端导出后放进 corpus/，程序不得代为取数
//                 - unsupported   明确不做（条款禁止、需绕过访问控制等）
//                 写后两者时，stash_fetch 会拒绝并只留一条台账 —— 那是承诺，不是建议
//   actions     动作说明，会出现在 stash_catalog 里
//   notes       注意事项，会一起回给模型
//   boundary    明确的禁止边界，会一起回给模型
//
// ⛔ 绝不要把口令 / token / key 写进这个文件：它会被备份、被 git、被读进模型上下文。
//    只写引用名（全大写字母/数字/下划线，如 MY_API_KEY），值放 $DSH_HOME/.credentials.yaml，
//    由 credentials 服务按引用名解析。插件每次调用都重新解析，改值无需重启。
//    在「设置 → 钥匙」页里录入值；值不经过模型。
// ─────────────────────────────────────────────────────────────────────────────

import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

// ─────────────────────────────────────────────────────────────────────────────
// 钥匙台账（0.6.0 起不在本文件里了）
//
//   库注册表：某个库【需要】哪些钥匙      → export default [ ... ] 里各库的 credentials 数组
//   钥匙台账：我【有】哪些账号、各是什么  → 同目录 sources.local.json 的 accounts
//
// 为什么迁走：本文件是手写的，程序永不改写它；写在手写文件里的台账，界面只能看不能改。
// 台账搬到代写分片后，「设置 → 钥匙」页才能真的编辑它（改名、改类别、加字段、删字段）。
//
// 形状（sources.local.json）——一条账号 = 一个网站/API/MCP 服务，字段 = 凭据引用名：
//   {
//     "sources": [],
//     "accounts": [
//       { "id": "example_site", "label": "示例：某网站", "category": "site",
//         "url": "https://example.com/login", "usedBy": ["example"],
//         "fields": [
//           { "ref": "EXAMPLE_SITE_ACCOUNT", "label": "账号" },
//           { "ref": "EXAMPLE_SITE_PASSWORD", "label": "密码" },
//           { "ref": "EXAMPLE_API_KEY", "label": "API Key", "secret": true,
//             "inject": "env:EXAMPLE_API_KEY", "notes": "每 90 天轮换" }
//         ] }
//     ]
//   }
//
// 字段可选键：label 显示名 | secret 是否机密（默认 true）| multiline 多行值
//             （PEM 私钥 / service account JSON）| inject 注入点 | notes 字段备注
// 类别：site 网站账号 | api API 密钥 | database 数据库 | token 令牌
//       | mcp MCP / 智能体服务 | other 其他
//
// ⛔ 只登记"有哪些钥匙"，绝不写值 —— 值在「设置 → 钥匙」里录入，
//    走浏览器 → 宿主凭据服务的单向通道，界面读不回、模型也看不到。
// ⛔ 也不要写账号名/手机号/邮箱：如果它在你场景里算机密，它就该是另一个引用名。
//
// 旧的 `export const credentials = [...]` 仍然可读（向后兼容），但不再推荐。
// ─────────────────────────────────────────────────────────────────────────────

export default [
  // ── 1. 内置 handler：免登录、有已知坑的库 ────────────────────────────────
  {
    id: 'trade_stats',
    name: '贸易统计（公开接口）',
    kind: 'remote',
    handler: 'trade_stats',
    summary: '各国年度进出口贸易额与数量的时序数据，免登录直连，按 HS 编码取数。',
    coverage: '254 个国别码 · HS 2/4/6/10 位 · VAL 金额(千美元)/QTY 数量(吨) · USD/EUR · 进口 I / 出口 E',
    // 自动取数的端点免登录，所以这里不声明任何凭据。
    // 若你自己还要手动登录其它端点，就在这行声明你自己的引用名（值在「设置 → 钥匙」里录入），例如：
    //   credentials: ['MY_ACCOUNT', 'MY_PASSWORD'],
    credentials: [],
    access: 'public-api',
    actions: {
      countries: '列出/搜索国别码与各国可用年份区间（254 条，带磁盘缓存）',
      product: '单个 HS 编码在某报告国的合计，附同期返回的兄弟编码对照',
      partner: '单个 HS 编码在某报告国的逐伙伴国明细，按金额降序并给出份额',
    },
    notes: [
      '【坑 1】product 必填，缺它 HTTP 400。插件已在发请求前拦截。',
      '【坑 2】byProduct 的 records 是"兄弟编码"不是答案，必须读 aggregateRecords。插件已固化。',
      '【坑 3】byPartner 需要按 nbPages 翻页。插件已自动拼页。',
      '【坑 4】逐伙伴值各自舍入，伙伴之和会与合计不符。合计只取 aggregateRecords，绝不用求和。',
      '取数前先看 countries 的 lastPeriod：各国报送进度不同，最新年份常为空，需退回上一年。',
      '引用数据时必须一并报出来源（结果里的 provenance）。',
    ],
    boundary: '只使用免登录的公开数据端点。需登录的关税/原产地/标准端点不在本库范围内。',
  },

  // ── 2. 内置 handler：免登录的公开 JSON 接口 ───────────────────────────────
  {
    id: 'policy_alerts',
    name: '政策通报预警（TBT/SPS）',
    kind: 'remote',
    handler: 'policy_alerts',
    summary: 'WTO 成员的技术性贸易壁垒(TBT)与动植物卫生检疫(SPS)通报，用于合规预警与市场准入跟踪。',
    coverage: '按通报分发日期区间检索 · area=SPS|TBT · 含国别/关键词/HS 码/评议截止日',
    credentials: [],
    access: 'public-api',
    actions: {
      search: '按日期区间检索通报；area / member / keyword 在已抓取窗口内做客户端过滤',
    },
    notes: [
      '分页参数是 page（1 起）；currentPage / startRow / area / notifyingMember / searchText 会被服务器忽略。',
      '因此 area / member / keyword 是客户端过滤，只作用于已抓取窗口；结果里的 filterScopeNote 会报出窗口大小与全库总量。',
    ],
  },

  // ── 3. 声明式通用取数：自有 REST 接口，只改注册表、不写代码 ───────────────
  //     值里用 {参数名} 代入调用参数、用 {credential:引用名} 注入凭据。
  //     凭据值只出现在真实请求里，回报的 URL / headers / body 一律脱敏为 ***引用名***。
  {
    id: 'example_api',
    name: '示例：某个自有 REST 接口',
    kind: 'remote',
    handler: 'http',
    summary: '演示声明式取数：把下面整条删掉，换成你自己的接口即可。',
    credentials: ['MY_API_KEY'],
    access: 'official-api',
    actions: {
      search: '按关键词检索；参数 query / limit',
    },
    request: {
      url: 'https://api.example.com/v1/search',
      method: 'GET',
      query: { q: '{query}', limit: '{limit}' },
      headers: { 'X-Api-Key': '{credential:MY_API_KEY}' },
      pick: 'data.items',
      limit: 50,
      required: ['query'],
      minGapMs: 1000,
      // 需要翻页时再加，例如：
      // paginate: { param: 'page', start: 1, pages: 3 },
      // 或按响应里的总页数字段自动翻：
      // paginate: { param: 'page', start: 1, totalPath: 'meta.totalPages', maxPages: 5 },
    },
    notes: [
      'pick 是点路径，指向响应里你要的那一段；省略则返回整个响应体。',
      'required 里声明的参数缺失时会在发请求前报错，不靠服务端 400 才发现。',
      '没有 required 的占位符（如上面的 {limit}）是**可选**的：调用时没传，该参数会整个从请求里省略，由服务端用它自己的默认值。',
    ],
    boundary: '示例条目，请替换或删除。',
  },

  // ── 4. 本地语料：导出件、文档、数据集 ────────────────────────────────────
  //     插件不会读进内容；stash_files 只登记路径与大小，检索时做子串匹配。
  {
    id: 'corpus',
    name: '本地语料',
    kind: 'files',
    paths: [join(DSH_HOME, 'stash', 'corpus')],
    summary: '放进这个目录的导出件/文档由 stash_files 统一登记与检索，再用 read 读具体文件。',
    actions: {},
    notes: [
      '工作流：别处导出 → 放进上面的路径 → stash_files 列出/检索 → read 读具体文件分析。',
      '集中管理比散落在各个技能目录下更好找。',
    ],
  },

  // ── 5. MCP 服务：只登记，不经 stash 取数（kind: 'mcp'）──────────────────
  //     取数由 DSH 直连完成（mcp__<server>__<tool>）。登记它是为了四件事：
  //     这条服务允许怎么用、要哪把钥匙、踩过什么坑、本机到底有哪些外部资源。
  //     ⚠️ MCP 调用不进取数台账（它没经过 stash），溯源要看会话日志。
  {
    id: 'my_mcp_service',
    name: '某个 MCP 服务',
    kind: 'mcp',
    server: 'my-service',           // DSH profile 里那条 MCP 行的 serverName
    transport: 'stdio',             // stdio | streamable-http | sse
    tools: 'mcp__my-service__*',    // 该服务暴露的工具前缀，给模型指路
    access: 'official-api',
    credentials: ['MY_SERVICE_KEY'], // 只写引用名；落点见钥匙台账的 inject
    summary: '把某个 MCP 服务登记进资源清单，供模型与面板知道它的存在、边界与钥匙。',
    notes: [
      '它的取数不走 stash_fetch（会被拒绝并指路 mcp__<server>__<tool>），所以**不进台账**。',
      '⚠️ 若这个 MCP 行读 process.env，凭据值必须写 $DSH_HOME/.env —— 粘在「设置 → 钥匙」面板对该消费者无效。',
      'transport=stdio 时它实际走子进程管道；另两种走网络。排查故障时先看是哪一种。',
    ],
    boundary: '只登记，不代为取数；调用权限由 DSH 的 MCP 行控制。',
  },

  //    可选：bucket 覆盖面板上的「归入」（remote / local-service / local-files）。
  //    默认按形状自动判定：files 与 SQLite→本机文件，MCP stdio 与回环地址→本机服务，其余→远端接口。
  //    只有自动判定会错时才写它（例如本地反向代理把远端服务伪装成 127.0.0.1）。

  // ── 6. 本地数据库：一条源 = 一条只读查询（handler: 'db'）────────────────
  //     零依赖实现，只支持 SQLite（Node 内置 node:sqlite）。
  //     服务端数据库请用 handler:'http' 指向它的只读门面。
  {
    id: 'my_sqlite',
    name: '本地 SQLite（只读）',
    kind: 'remote',
    handler: 'db',
    access: 'official-api',
    request: {
      engine: 'sqlite',
      path: join(DSH_HOME, 'stash', 'example.db'),   // 必须是绝对路径
      sql: 'SELECT id, name FROM people WHERE dept = :dept LIMIT 20',
      required: ['dept'],
      limit: 200,
    },
    actions: { query: '执行上面那条只读查询；参数用 :name 占位', tables: '列出库里的表与视图' },
    summary: '用一条固定的只读查询访问本地 SQLite 文件的一部分数据。',
    notes: [
      '只读打开 + 只放行单条 SELECT/WITH：写语句与多语句在登记和取数两处都会被拒。',
      '一条源 = 一条查询。要取别的数据就再登一条，别把整库暴露成"任意 SQL"。',
    ],
    boundary: '只读；不写、不建表、不改 schema。',
  },

  // ── 7. 对象存储 / 文件传输（handler: 'objstore'）────────────────────────
  //     protocol: 's3'（SigV4 签名，或公开桶匿名）| 'webdav'（PROPFIND + GET）
  {
    id: 'my_bucket',
    name: '对象存储（示例桶）',
    kind: 'remote',
    handler: 'objstore',
    access: 'official-api',
    credentials: ['EXAMPLE_S3_KEY_ID', 'EXAMPLE_S3_SECRET'],
    request: {
      protocol: 's3',
      endpoint: 'https://s3.example.com',   // 自建 MinIO 就写它的地址
      bucket: 'example-bucket',
      prefix: 'reports/',                   // list 的默认前缀
      region: 'us-east-1',
      accessKeyIdRef: 'EXAMPLE_S3_KEY_ID',  // 引用名，不是值
      secretAccessKeyRef: 'EXAMPLE_S3_SECRET',
      limit: 50,
    },
    actions: { list: '按前缀列出对象', get: '取一个对象（key 必填）' },
    summary: '从 S3 兼容的对象存储里列目录、取文件；文本类才回正文，二进制只回元信息。',
    notes: [
      '私有桶用 SigV4 签名（实现已对 AWS 官方测试向量核对）；公开桶不声明凭据即匿名读取。',
      '不确定的先用 list 看有什么，再 get 取单个对象——别一次取大文件。',
    ],
    boundary: '只读示例；不带删除与写入动作。',
  },
]
