/**
 * dsh-stash —— 浏览器半边（手写 bundle，无构建步骤）。
 *
 * 文件精确以 loader 调用开头，与官方产物格式一致。
 * 只 require 基线模块表里的 "react"，不依赖 UI 组件库，因此不需要打包器。
 *
 * 职责：在「设置」里加一页「钥匙」，把台账按「账号 + 字段」两层渲染，并录入值。
 *   · 一条账号 = 一个网站 / API / MCP 服务（同一个网站只占一条目录）
 *   · 一个字段 = 一个凭据引用名 = 宿主凭据库里的一条值
 *   · 已配置的字段默认收起；「更换值」才展开输入框；「移除值」必须二次确认
 *   · 「编辑信息」与「新建」复用同一张字段表（元数据回填；值永远不回显）
 *
 * 三层视图（全部是客户端内部状态——插槽不提供路由）：
 *   L1 概览  = 一张可点的统计索引（点哪条进哪条，把"3 把未配置"变成入口）
 *   L2 清单  = 按分类分箱的账号卡（摘要 + 缺什么），筛选器作用于**字段**
 *   L3 详情  = 一个账号的字段表与编辑表单（值的操作都在这层）
 * 口径：一律用「把」数引用名，账号数括注在括号里 —— 分类各行相加 = 总数。
 *
 * **密钥从浏览器直连 host 凭据服务**（ctx.remote.credentials.set），
 * 不经过 agent、不进会话记录、不进模型上下文。
 * 界面显示不出已存的密钥——因为 credentialsController 根本没有任何返回值的方法。
 *
 * 回归测试：test/client-runtime.mjs（真跑组件 + 抓 unhandled rejection）
 */
window.__ModuleLoader__.load({
	id: "dsh-stash",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const ENDPOINT_PATH = "/stash/credentials";
		// 迁移（导出 / 导入 / 清空）走另一条端点：值只由宿主从凭据服务读写，浏览器只送动作与开关。
		const PORTABILITY_PATH = "/stash/portability";
	/** 资源写端点：POST 新建 / 覆盖，DELETE 删除（都只对代写条目生效）。 */
	const SOURCES_PATH = "/stash/sources";

	/**
	 * 「资源」的七个细分。**这是唯一出现技术名的地方**——登记时选，界面别处不展示。
	 * bucket 那一列只是"会归到哪一类"的提示，真正的归类由 host 派生（可覆盖）。
	 */
		const RESOURCE_FORMS = [
		{
			form: "http", label: "声明式 HTTP 接口", tech: "http", kind: "remote", handler: "http",
			hint: "最常见的一种：一个 http(s) 地址，参数写进 URL / 请求头 / 查询串。",
		},
		{
			form: "builtin", label: "内置处理器", tech: "handler id", kind: "remote", handler: null,
			hint: "插件自带的专用实现（不是通用 HTTP）：用哪个由 handler id 决定，取数参数固定。",
		},
		{
			form: "db", label: "本地数据库", tech: "db · SQLite", kind: "remote", handler: "db",
			hint: "本地 SQLite 文件 + 一条只读查询。其他数据库请套一层只读 HTTP 门面。",
		},
		{
			form: "objstore", label: "对象存储 / 文件传输", tech: "objstore", kind: "remote", handler: "objstore",
			hint: "S3 兼容的桶（含 MinIO）或 WebDAV 目录：列对象、取单个文件。",
		},
		{
			form: "files", label: "文档与数据文件", tech: "files", kind: "files", handler: null,
			hint: "你磁盘上的文件或目录（PDF / CSV / Markdown / 写作规范…）：只登记路径，取用时先检索再按需读；面板不会替你搬文件。",
		},
		{
			form: "mcp", label: "MCP 服务", tech: "mcp", kind: "mcp", handler: null,
			hint: "DSH 里已配好的 MCP 服务：只登记，取数由 DSH 直连，不进取数台账。承载选 stdio 归本机服务、选 http/sse 归远端接口。",
		},
	];

	/**
	 * 新建页第一行是**对象**：资源（能被取数的东西）与账号（钥匙的容器）。
	 * 三类是**资源的归属**，不是并列的第三类对象——它由形态派生，显示在「归入」那一行。
	 * 把三类与账号混成一个下拉，就是拿两个轴当一类。
	 */
	const CREATE_OBJECTS = [
		{ id: "resource", label: "资源", hint: "能被取数的东西：接口 / 数据库 / 对象存储 / 语料 / MCP" },
		{ id: "account", label: "账号", hint: "一个服务 / 网站，下面挂若干把钥匙（引用名）" },
	];
	/** 「自动判定」会归到哪一类：写成中文给非专业读者看；MCP 由承载决定，两个都写上。 */
	const bucketLabelOf = (form) => {
		if (form === "mcp") return "本机服务（承载 stdio）/ 远端接口（承载 http、sse）";
		return BUCKET_FALLBACK[derivedBucket(form)] || "";
	};
	/** 形态会归到哪一类（与 host 的 bucketOf 同一套规则，只用于表单里即时提示）。 */
	const derivedBucket = (form) => {
		if (form === "files" || form === "db") return "local-files";
		if (form === "mcp") return null; // 由承载决定：stdio→本机服务，http/sse→远端接口
		return "remote";
	};
	const resourceFormMeta = (form) => RESOURCE_FORMS.find((item) => item.form === form) ?? RESOURCE_FORMS[0];

	/**
	 * 首页那三类 = 资源的一级分类，也是新建页的第一行。选完类，形态只列这一类能有的。
	 * 三层关系是**类 → 形态 → 字段**，不再是"对象/类别"两个轴叠在一起。
	 */
	const CLASS_FORMS = {
		remote: { label: "远端接口", hint: "网络上的东西：接口、内置处理器、对象存储、MCP(http)", forms: ["http", "builtin", "objstore", "mcp"] },
		"local-service": { label: "本机服务", hint: "本机在跑的服务（回环地址）或 MCP(stdio)", forms: ["http", "mcp"] },
		"local-files": { label: "本机文件", hint: "你磁盘上的文档与数据文件（PDF / CSV / Markdown…），或本地 SQLite 数据库", forms: ["files", "db"] },
	};
	/** 同一个形态在不同类里的说法不同：http 在「本机服务」里就是本机端口。 */
	const formLabelIn = (form, classId) => {
		const meta = resourceFormMeta(form);
		if (form === "http" && classId === "local-service") return { label: "本机端口", tech: "http（回环地址）", hint: "本机在跑的服务，如 http://127.0.0.1:6900/api" };
		return meta;
	};
	const formsOfClass = (classId) => {
		const spec = CLASS_FORMS[classId];
		const list = spec ? spec.forms : RESOURCE_FORMS.map((item) => item.form);
		return list.map((form) => ({ form, ...formLabelIn(form, classId) }));
	};


	/** 空表单。字段刻意只留必填 + 高级，别一上来摊十几个输入框。 */
	const emptyResource = (form) => ({
		form, mode: "new", advanced: false, classScope: null,
		id: "", name: "", access: "public-api", credentials: "", summary: "", boundary: "", coverage: "", notesText: "", bucketOverride: "",
		// 取数（随形态变）
		url: "", method: "GET", headers: "", required: "", handlerId: "", query: "", body: "", pick: "",
		dbPath: "", sql: "", limit: "",
		protocol: "s3", endpoint: "", bucket: "", region: "", prefix: "",
		paths: "",
		server: "", transport: "stdio", tools: "",
		errors: [], summaryError: null, hint: null, busy: false,
	});

	/**
	 * 表单 → 注册表条目。只组装**引用的名字**，永远不碰值——
	 * 值只能由人在账号详情里贴，走浏览器 → 宿主凭据服务的单向通道。
	 */
	const buildResourceEntry = (rc) => {
		const meta = resourceFormMeta(rc.form);
		const entry = {
			id: String(rc.id ?? "").trim(),
			name: String(rc.name ?? "").trim() || String(rc.id ?? "").trim(),
			kind: meta.kind,
		};
		if (meta.form === "builtin") entry.handler = String(rc.handlerId || "").trim();
		else if (meta.handler) entry.handler = meta.handler;
		const refs = String(rc.credentials ?? "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
		if (rc.form === "http") {
			const request = { url: String(rc.url ?? "").trim(), method: String(rc.method ?? "GET").trim() || "GET" };
			const headers = {};
			for (const line of String(rc.headers ?? "").split("\n")) {
				const at = line.indexOf(":");
				if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
			}
			if (Object.keys(headers).length > 0) request.headers = headers;
			const query = {};
			for (const line of String(rc.query ?? "").split("\n")) {
				const at = line.indexOf("=");
				if (at > 0) query[line.slice(0, at).trim()] = line.slice(at + 1).trim();
			}
			if (Object.keys(query).length > 0) request.query = query;
			if (String(rc.body ?? "").trim()) {
				const raw = String(rc.body).trim();
				try { request.body = JSON.parse(raw); } catch { request.body = raw; }
			}
			if (String(rc.pick ?? "").trim()) request.pick = String(rc.pick).trim();
			const required = String(rc.required ?? "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
			if (required.length > 0) request.required = required;
			const limit = Number(rc.limit);
			if (Number.isFinite(limit) && limit > 0) request.limit = limit;
			entry.request = request;
		} else if (rc.form === "db") {
			const request = { engine: "sqlite", path: String(rc.dbPath ?? "").trim(), sql: String(rc.sql ?? "").trim() };
			const required = String(rc.required ?? "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
			if (required.length > 0) request.required = required;
			const limit = Number(rc.limit);
			if (Number.isFinite(limit) && limit > 0) request.limit = limit;
			entry.request = request;
		} else if (rc.form === "objstore") {
			const request = { protocol: rc.protocol, endpoint: String(rc.endpoint ?? "").trim() };
			for (const [key, value] of [["bucket", rc.bucket], ["region", rc.region], ["prefix", rc.prefix]]) {
				const text = String(value ?? "").trim();
				if (text) request[key] = text;
			}
			const limit = Number(rc.limit);
			if (Number.isFinite(limit) && limit > 0) request.limit = limit;
			if (rc.protocol === "s3" && refs.length >= 2) {
				request.accessKeyIdRef = refs[0];
				request.secretAccessKeyRef = refs[1];
			}
			entry.request = request;
		} else if (rc.form === "files") {
			entry.paths = String(rc.paths ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
		} else if (rc.form === "mcp") {
			entry.server = String(rc.server ?? "").trim();
			entry.transport = rc.transport;
			if (String(rc.tools ?? "").trim()) entry.tools = String(rc.tools).trim();
		}
		if (refs.length > 0) entry.credentials = refs;
		if (rc.form !== "files" && rc.form !== "db" && rc.access) entry.access = rc.access;
		if (String(rc.bucketOverride ?? "")) entry.bucket = rc.bucketOverride;
		if (String(rc.summary ?? "").trim()) entry.summary = String(rc.summary).trim();
		if (String(rc.boundary ?? "").trim()) entry.boundary = String(rc.boundary).trim();
		if (String(rc.coverage ?? "").trim()) entry.coverage = String(rc.coverage).trim();
		const notes = String(rc.notesText ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
		if (notes.length > 0) entry.notes = notes;
		if (rc.mode === "edit") entry.overwrite = true;
		return entry;
	};

	/** host 的报错落到具体字段上：按关键词认领，认不出的进顶部汇总。 */
	const RESOURCE_FIELD_HINTS = [
		[/bucket/i, "bucketOverride"],
		[/\bid\b|id 只能|已被占用/i, "id"],
		[/url|地址/i, "url"],
		[/sql|只读语句|SELECT/i, "sql"],
		[/路径|path/i, "dbPath"],
		[/endpoint|protocol|region/i, "endpoint"],
		[/server|transport|tools/i, "server"],
		[/凭据|credentials|引用名|accessKeyIdRef|secretAccessKeyRef/i, "credentials"],
		[/access|边界/i, "access"],
		[/paths/i, "paths"],
	];
	const mapResourceErrors = (data) => {
		const messages = [];
		if (data && data.error) messages.push(String(data.error));
		if (data && Array.isArray(data.problems)) {
			for (const item of data.problems) messages.push(typeof item === "string" ? item : (item && item.message) || String(item));
		}
		if (messages.length === 0) messages.push("登记失败（没有更多说明）");
		return messages.map((message) => {
			const hit = RESOURCE_FIELD_HINTS.find(([re]) => re.test(message));
			return { field: hit ? hit[1] : null, message };
		});
	};

	/** 类层「归入」下拉的三个值 + 自动。 */
	const BUCKET_CHOICES = [
		{ id: "", label: "自动判定" },
		{ id: "remote", label: "远端接口" },
		{ id: "local-service", label: "本机服务" },
		{ id: "local-files", label: "本机文件" },
	];

		/*
		 * URL 构造照抄官方客户端产物（dshmarket 的 api()）——
		 * 但这里必须叫 resolveEndpoint，不能叫 api：
		 * createSection 的入参已经叫 api（host 调用回调），同名会遮蔽它，
		 * 于是 async load() 里抛 TypeError，effect 不 await，只剩 unhandled rejection，
		 * 界面永远停在加载态（0.3.1 的真实故障）。
		 * 本函数保证不抛：任何异常都退回根绝对路径。
		 */
		function resolveEndpoint(path) {
			const relative = String(path).replace(/^\/+/, "");
			try {
				if (typeof document === "undefined" || !document.baseURI) return `/${relative}`;
				return new URL(relative, document.baseURI).pathname;
			} catch {
				return `/${relative}`;
			}
		}

		/*
		 * 主题令牌（Theme.listTokens 返回 14 个，全部 requiresLightAndDark）。
		 * 之前全用「同一个灰度值套不同透明度」硬编码，亮/暗主题里必然有一边发虚；
		 * 一律走令牌，主题切换自动正确。
		 *
		 * ⚠️ 每个令牌都带**系统色兜底**（Canvas / CanvasText / GrayText / AccentColor…）。
		 * 起因是一次实机截图：`--dsw-alias-brand-primary` 没解析出来，于是主按钮的
		 * `background` 变成透明，而 `color` 还是写死的 `#fff` —— **白底白字，标签整个看不见**。
		 * 兜底之后，令牌解析不出来最多回退到系统色，不会再出现"按钮在、字没有"。
		 */
		const C = {
			text: "var(--dsw-alias-label-primary, CanvasText)",
			text2: "var(--dsw-alias-label-secondary, GrayText)",
			border: "var(--dsw-alias-border-l1, GrayText)",
			borderStrong: "var(--dsw-alias-border-l2, GrayText)",
			layer1: "var(--dsw-alias-bg-layer-1, Canvas)",
			layer2: "var(--dsw-alias-bg-layer-2, Canvas)",
			brand: "var(--dsw-alias-brand-primary, AccentColor)",
			ok: "var(--dsw-alias-state-success-primary, Green)",
			warn: "var(--dsw-alias-state-warn-primary, Orange)",
			bad: "var(--dsw-alias-state-error-primary, Red)",
			idle: "var(--dsw-alias-state-idle-primary, GrayText)",
		};

		/*
		 * 内联 style 写不了 :hover / :focus-visible / transition——这正是旧界面"没有反馈"的原因。
		 * 所以交互态统一放进这张**作用域样式表**（全部限定在 .dshs-root 之下，不污染宿主）。
		 * 只注入一次，幂等；注入失败只是少一层打磨，不影响功能。
		 */
		const STYLE_ID = "dsh-stash-keys-style";
		/**
		 * 字号体系：**只在这里定义**。
		 *   标签 14（主导）→ 值 13 → 占位/说明 11 → 元信息 12
		 * 表单里出现新字号就是不在这套体系里，测试会挡。
		 */
		const TYPE = {
			label: "14px", value: "13px", note: "11px", meta: "12px",
			title: "19px", group: "13px",
			// 展示级数字：首页"一眼看总量"用的，越大越要少用。
			hero: "52px", cell: "34px", big: "28px", lead: "20px",
		};

		const STYLESHEET = [
			".dshs-root{color:" + C.text + ";font-size:13px;}",
			".dshs-card{background:" + C.layer2 + ";border:1px solid " + C.border + ";border-radius:10px;",
			"margin-bottom:10px;overflow:hidden;transition:border-color .15s ease;}",
			".dshs-card:hover{border-color:" + C.borderStrong + ";}",
			".dshs-field{border-top:1px solid " + C.border + ";padding:11px 0 3px;}",
			".dshs-root button{font-family:inherit !important;font-size:" + TYPE.value + " !important;border-radius:7px;border:1px solid " + C.borderStrong + ";",
			"background:transparent;color:" + C.text + ";cursor:pointer;padding:5px 11px;",
			"transition:background .12s ease,border-color .12s ease,color .12s ease;}",
			".dshs-root button:hover:not(:disabled){background:" + C.layer1 + ";border-color:" + C.text2 + ";}",
			".dshs-root button:focus-visible{outline:2px solid " + C.brand + ";outline-offset:1px;}",
			".dshs-root button:disabled{cursor:default;opacity:.45;}",
			// 主按钮**不靠填充色保证可见性**：底色与文字都用已在实机验证可见的令牌
			// （layer1 / text），品牌色只当边框与加粗的强调。
			// 写成"品牌底 + 写死的白字"等于把可见性押在品牌令牌上——那个令牌一旦解析不出来，
			// 背景变透明而文字还是白的，就成了白底白字，实机上正是这样翻的车。
			".dshs-root .dshs-primary{background:" + C.layer1 + ";border-color:" + C.brand + ";color:" + C.text + ";font-weight:600;}",
			".dshs-root .dshs-primary:hover:not(:disabled){background:" + C.layer2 + ";border-color:" + C.brand + ";}",
			".dshs-root .dshs-danger{color:" + C.bad + ";border-color:" + C.bad + ";}",
			".dshs-root .dshs-ghost{border-color:transparent;color:" + C.text2 + ";padding:4px 8px;}",
			".dshs-root .dshs-ghost:hover:not(:disabled){color:" + C.text + ";background:" + C.layer1 + ";}",
			".dshs-root input,.dshs-root textarea,.dshs-root select{font-family:inherit !important;font-size:13px !important;color:" + C.text + ";",
			"background:" + C.layer1 + ";border:1px solid " + C.borderStrong + ";border-radius:7px;padding:6px 9px;",
			"transition:border-color .12s ease;}",
			".dshs-root input:hover,.dshs-root textarea:hover,.dshs-root select:hover{border-color:" + C.text2 + ";}",
			".dshs-root input::placeholder,.dshs-root textarea::placeholder{font-size:11px !important;color:" + C.text2 + ";opacity:.7;}",
			".dshs-root input:focus,.dshs-root textarea:focus,.dshs-root select:focus{outline:none;border-color:" + C.brand + ";}",
			".dshs-root ::placeholder{color:" + C.text2 + ";opacity:.7;}",
			".dshs-root .dshs-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;display:inline-block;}",
			// 概览页的可点行：整行是一颗按钮，所以必须把按钮的默认外观摘干净，
			// 只留 hover 时的一点底色——否则每一行都长得像一颗"操作按钮"。
			".dshs-root .dshs-rowbtn{width:100%;text-align:left;border-color:transparent;background:transparent;",
			"padding:9px 10px;border-radius:8px;display:block;}",
			".dshs-root .dshs-rowbtn:hover:not(:disabled){background:" + C.layer1 + ";border-color:" + C.border + ";}",
			".dshs-root .dshs-rowbtn:hover .dshs-arrow{opacity:1;transform:translateX(2px);}",
			".dshs-root .dshs-arrow{color:" + C.text2 + ";opacity:.55;transition:opacity .12s ease,transform .12s ease;}",
			".dshs-root .dshs-crumb{border-color:transparent;background:transparent;color:" + C.text2 + ";padding:2px 5px;font-size:12px;}",
			".dshs-root .dshs-crumb:hover:not(:disabled){color:" + C.text + ";background:transparent;border-color:transparent;text-decoration:underline;}",
			".dshs-root .dshs-crumblast{color:" + C.text + ";cursor:default;}",
			// 段头：名称 + 右侧动作，下面一条浅线收口。整页只用这一种分隔，避免满屏横线。
			".dshs-root .dshs-sec{display:flex;align-items:baseline;gap:8px;",
			"padding-bottom:7px;margin-bottom:4px;border-bottom:1px solid " + C.border + ";}",
			".dshs-root .dshs-secname{font-size:12px;font-weight:600;letter-spacing:.04em;color:" + C.text2 + ";}",
			// 首页三格：等宽、竖线分开，数字是主体。
			".dshs-root .dshs-buckets{display:flex;flex-wrap:wrap;margin-top:20px;border-top:1px solid " + C.border + ";padding-top:16px;}",
			// min-width 是窄面板的兜底：面板被压到 500px 以下时三格会自动换行，而不是挤成一团。
			".dshs-root .dshs-cell{flex:1;min-width:150px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;",
			"background:transparent;border:0;padding:2px 18px 2px 0;text-align:left;cursor:pointer;color:inherit;}",
			".dshs-root .dshs-cell + .dshs-cell{border-left:1px solid " + C.border + ";padding-left:20px;}",
			".dshs-root .dshs-cell:hover .dshs-cellnum{color:" + C.brand + ";}",
			".dshs-root .dshs-rowbtn{border-radius:8px;}",
		].join("");

		function injectStyles() {
			try {
				if (typeof document === "undefined" || !document.head || typeof document.createElement !== "function") return;
				if (document.getElementById && document.getElementById(STYLE_ID)) return;
				const tag = document.createElement("style");
				tag.id = STYLE_ID;
				tag.textContent = STYLESHEET;
				document.head.appendChild(tag);
			} catch {
				// 少一层视觉打磨而已，绝不因此挡住功能。
			}
		}


		const S = {
			// 宽度交给设置面板的内容列决定，不再写死 860px（那会让行过长、阅读疲劳）。
			wrap: { padding: "2px 0 8px", maxWidth: "100%" },
			head: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			titleRow: {
				display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
				paddingBottom: "10px", marginBottom: "12px", borderBottom: "1px solid " + C.border,
			},
			title: { fontSize: TYPE.title, fontWeight: 600, letterSpacing: "-0.01em" },
			spacer: { marginLeft: "auto" },
			crumbRow: { display: "flex", alignItems: "center", gap: "3px", flexWrap: "wrap", marginBottom: "9px" },
			crumbSep: { color: C.text2, fontSize: TYPE.meta },
			stats: { paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid " + C.border },
			// 段落容器：整页几段用同一个节奏，段间留白而不是加线。
			sec: { marginTop: "24px" },
			// 表单：标签列 + 控件列。控件一律占满控件列，「右边缘对齐」是这张表单不显乱的关键。
			fieldRow: { display: "flex", alignItems: "flex-start", gap: "14px", marginTop: "14px" },
			fieldControl: { flex: "1 1 auto", minWidth: 0 },
			fullInput: { width: "100%", fontSize: TYPE.value, color: C.text },
			fullSelect: { width: "100%", fontSize: TYPE.value, color: C.text },
			rowLabel: { fontSize: TYPE.label, color: C.text2, flex: "0 0 104px", width: "104px", paddingTop: "6px", whiteSpace: "nowrap", textAlign: "right" },
			// 高级：一条有边框的控件行，而不是一句会被当成正文的长句。
			advBox: { marginTop: "16px", border: "1px solid " + C.border, borderRadius: "9px", overflow: "hidden" },
			advHead: {
				display: "flex", alignItems: "baseline", gap: "8px", width: "100%", textAlign: "left",
				padding: "9px 12px", borderRadius: 0, border: 0, background: C.layer1,
			},
			advName: { fontSize: TYPE.value, fontWeight: 600, color: C.text },
			advNote: { fontSize: TYPE.note, color: C.text2 },
			advBody: { padding: "2px 12px 12px" },
			heroRow: { display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap", margin: "14px 0 0" },
			heroNum: { fontSize: TYPE.hero, fontWeight: 600, lineHeight: .95, fontVariantNumeric: "tabular-nums" },
			heroLabel: { fontSize: TYPE.meta, color: C.text2 },
			dotRow: { display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" },
			count: { color: C.text2, fontSize: TYPE.meta, fontVariantNumeric: "tabular-nums" },
			bucketGrid: { display: "flex", marginTop: "20px", borderTop: "1px solid " + C.border, paddingTop: "16px" },
			cellNum: { fontSize: TYPE.cell, fontWeight: 600, lineHeight: 1.05, fontVariantNumeric: "tabular-nums",
				display: "flex", alignItems: "center", gap: "9px" },
			cellLabel: { fontSize: TYPE.meta, color: C.text2 },
			cellNote: { fontSize: TYPE.meta, color: C.text2 },
			// 新建菜单：窄面板里不做绝对定位的浮层（会被裁），直接排成一块。
			menu: {
				marginTop: "10px", border: "1px solid " + C.border2, borderRadius: "10px",
				background: C.layer2, overflow: "hidden", maxWidth: "560px",
			},
			menuItem: {
				display: "flex", alignItems: "baseline", gap: "9px", flexWrap: "wrap",
				width: "100%", textAlign: "left", padding: "9px 13px", borderRadius: 0,
				borderBottom: "1px solid " + C.border,
			},
			menuName: { fontWeight: 600, fontSize: TYPE.value },
			menuHint: { color: C.text2, fontSize: TYPE.meta },
			menuGroup: { padding: "7px 13px", color: C.text2, fontSize: TYPE.note, letterSpacing: "0.06em", background: C.layer1 },
			// 概览页的总数给足字号：这一页本来就是"一眼看总量"。
			bigNum: { fontSize: TYPE.big, fontWeight: 600, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" },
			bigRow: { display: "flex", alignItems: "baseline", gap: "9px", flexWrap: "wrap" },
			bigLabel: { fontSize: TYPE.value, color: C.text2 },
			bar: {
				height: "4px", borderRadius: "999px", background: C.layer1,
				border: "1px solid " + C.border, overflow: "hidden",
			},
			barFill: (w) => ({ height: "100%", width: w, background: C.brand }),
			section: { borderTop: "1px solid " + C.border, paddingTop: "11px", marginTop: "11px" },
			sectionHead: { fontSize: TYPE.meta, color: C.text2, marginBottom: "5px" },
			rowNote: { fontSize: TYPE.meta, color: C.text2, marginTop: "2px" },
			group: { marginTop: "22px" },
			groupHead: {
				display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap",
				paddingBottom: "7px", marginBottom: "9px", borderBottom: "1px solid " + C.border,
				fontSize: TYPE.meta, color: C.text2,
			},
			groupName: { fontSize: TYPE.value, fontWeight: 600, color: C.text },
			filters: { display: "flex", gap: "7px", flexWrap: "wrap", marginBottom: "14px" },
			card: { padding: "11px 13px 12px" },
			row: { border: "1px solid " + C.borderStrong, borderRadius: "10px", padding: "9px 12px", marginBottom: "8px" },
			field: {},
			label: { fontWeight: 600, fontSize: TYPE.value },
			fieldLabel: { fontWeight: 600 },
			ref: { fontFamily: "ui-monospace, Consolas, monospace", color: C.text2, fontSize: TYPE.meta },
			pill: (ok) => ({
				fontSize: TYPE.note, padding: "1px 8px", borderRadius: "999px", lineHeight: 1.7,
				border: "1px solid " + (ok ? C.border : C.borderStrong), color: ok ? C.ok : C.text2,
			}),
			tag: {
				fontSize: TYPE.note, padding: "1px 7px", borderRadius: "999px", lineHeight: 1.7,
				border: "1px solid " + C.border, color: C.text2,
			},
			meta: { color: C.text2, fontSize: TYPE.meta, marginTop: "4px" },
			warn: { color: C.warn, fontSize: TYPE.meta, marginTop: "4px" },
			banner: {
				border: "1px solid " + C.warn, color: C.warn, borderRadius: "9px",
				padding: "8px 11px", fontSize: TYPE.meta, lineHeight: 1.65, marginBottom: "10px",
			},
			form: { display: "flex", gap: "8px", marginTop: "8px", alignItems: "center", flexWrap: "wrap" },
			// input/textarea/select 的边框、背景、focus 态都在样式表里，这里只留布局。
			input: { flex: "1 1 200px", minWidth: "140px", fontSize: TYPE.value, color: C.text },
			area: { width: "100%", minHeight: "64px", fontSize: TYPE.value, color: C.text },
			check: { display: "inline-flex", alignItems: "center", gap: "5px", fontSize: TYPE.meta, color: C.text2 },
			btn: (disabled) => ({ fontSize: TYPE.value, ...(disabled ? { opacity: 0.45 } : {}) }),
			hint: { color: C.text2, fontSize: TYPE.note, lineHeight: 1.6 },
			notice: (bad) => ({ marginTop: "10px", fontSize: TYPE.meta, color: bad ? C.bad : C.ok }),
			confirm: { borderColor: C.bad },
			foldHead: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
			foldCaret: { fontSize: TYPE.value, fontWeight: 600, color: C.text },
			// 结果卡：report 是宿主渲染好的纯文本，必须原样保留换行。
			report: {
				whiteSpace: "pre-wrap", fontFamily: "ui-monospace, Consolas, monospace",
				fontSize: TYPE.meta, lineHeight: 1.7, color: C.text, marginTop: "9px",
				background: C.layer1, border: "1px solid " + C.border, borderRadius: "9px", padding: "10px 12px",
			},
			code: {
				fontFamily: "ui-monospace, Consolas, monospace", fontSize: TYPE.lead, fontWeight: 600,
				letterSpacing: "0.14em", color: C.brand, fontVariantNumeric: "tabular-nums",
			},
			foldGuide: { color: C.text2, fontSize: TYPE.meta, lineHeight: 1.65, marginTop: "8px" },
			steps: { fontSize: TYPE.meta, color: C.warn, lineHeight: 1.65, marginBottom: "9px" },
		};

		const statusText = (row) => {
			if (row.configured === true) return "已配置" + (row.writable === false ? "（只读源不可覆盖）" : "");
			if (row.configured === false) return "未配置";
			return "状态未知";
		};

		/** 只读 = 住在手写的 sources.mjs 里，程序不改写它。 */
		const isReadonly = (account) => account.origin === "handwritten";

		const emptyForm = () => ({
			id: "", label: "", category: "site", url: "", notes: "", usedBy: [], showUsedBy: false,
			fields: [{ ref: "", label: "", secret: true, inject: "", multiline: false, notes: "" }],
		});

		const formFromAccount = (account) => ({
			id: account.id,
			label: account.label,
			category: account.category,
			url: account.url || "",
			notes: account.notes || "",
			usedBy: (account.usedBy || []).slice(),
			fields: account.fields.map((field) => ({
				ref: field.ref,
				label: field.label === field.ref ? "" : field.label,
				secret: field.secret !== false,
				inject: field.inject || "",
				multiline: field.multiline === true,
				notes: field.notes || "",
			})),
		});

		/** 表单 → 提交体（只含元数据；绝不含值）。 */
		const payloadOfForm = (form) => ({
			id: form.id.trim() || undefined,
			label: form.label.trim(),
			category: form.category,
			url: form.url.trim() || undefined,
			notes: form.notes.trim() || undefined,
			usedBy: form.usedBy,
			fields: form.fields
				.filter((field) => field.ref.trim())
				.map((field) => ({
					ref: field.ref.trim().toUpperCase(),
					label: field.label.trim() || undefined,
					secret: field.secret !== false,
					inject: field.inject.trim() || undefined,
					multiline: field.multiline === true,
					notes: field.notes.trim() || undefined,
				})),
		});

		/**
		 * 取凭据命名空间；拿不到返回 null，由界面给出可读提示。
		 *
		 * 三级策略，因为"什么时候能拿到"并不确定：
		 *   1. apply 时用 ctx.inject 捕获到的（最可靠——host 侧 webServer 就是靠它才拿到）
		 *   2. ctx.get("remote") / ctx.remote
		 *   3. ctx.get("remote.credentials")
		 * host 侧那次教训：ctx.get 在服务未就绪时返回 undefined 并静默失败，
		 * 所以主路径必须是 ctx.inject，惰性获取只作兜底。
		 */
		function resolveCredentials(ctx, captured) {
			try {
				if (captured && captured.credentials) return captured.credentials;
				if (captured && typeof captured.set === "function") return captured;
				const get = typeof ctx.get === "function" ? (name) => ctx.get(name) : () => undefined;
				const remote = get("remote") || ctx.remote;
				if (remote && remote.credentials) return remote.credentials;
				return get("remote.credentials") || null;
			} catch {
				return null;
			}
		}

		const NO_CREDENTIALS = { ok: false, error: { message: "本部署的客户端没有凭据服务（remote.credentials 不可用），无法保存。" } };

		/**
		 * 复制到剪贴板。**必须处理返回的 Promise**：
		 * 非安全上下文（http 明文）下 writeText 会 reject，不接住就是一条 unhandled rejection，
		 * 而本文件的回归测试专门抓这个形状。失败只是"没复制上"，用户还能自己选中。
		 */
		function copyText(text) {
			try {
				if (typeof navigator === "undefined" || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;
				const done = navigator.clipboard.writeText(text);
				if (done && typeof done.catch === "function") done.catch(() => {});
			} catch {
				// 剪贴板不可用而已。
			}
		}

		/**
		 * 面板上的三类（人话）：远端接口 / 本机服务 / 本机文件。
		 * id 与中文名以 host 的 libraryStats.byBucket 为准；host 还没重载时按同一规则在前端补算。
		 */
		const BUCKET_FALLBACK = {
			remote: "远端接口",
			"local-service": "本机服务",
			"local-files": "本机文件",
		};
		const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
		const bucketOfLocal = (lib) => {
			if (lib.bucket && BUCKET_FALLBACK[lib.bucket]) return lib.bucket;
			if (lib.kind === "files" || (lib.kind === "remote" && lib.handler === "db")) return "local-files";
			if (lib.kind === "mcp") return lib.transport === "stdio" ? "local-service" : "remote";
			if (lib.kind === "remote" && lib.handler === "http" && LOOPBACK.test(String(lib.url ?? lib.requestUrl ?? ""))) return "local-service";
			return "remote";
		};

		/**
		 * 统计：优先用 host 组装好的 libraryStats（口径与 stash_catalog 共用一处）；
		 * host 还没重载（旧 payload）时按同一规则在前端补算，保证首页与清单不会一片空白。
		 */
		const deriveLibraryStats = (list, stats) => {
			if (stats && Array.isArray(stats.byBucket) && Array.isArray(stats.byForm)) return stats;
			const libs = Array.isArray(list) ? list : [];
			const byBucket = [];
			const byForm = [];
			for (const lib of libs) {
				const bucket = bucketOfLocal(lib);
				const form = lib.form || lib.kind || "unknown";
				const formLabel = lib.formLabel || lib.kindLabel || form;
				const bump = (arr, key, label, extra) => {
					const found = arr.find((item) => (item.bucket ?? item.form) === key);
					if (found) {
						found.count += 1;
						if (lib.ready !== false) found.ready += 1; else found.blocked += 1;
						return;
					}
					arr.push({ ...extra, label, count: 1, ready: lib.ready !== false ? 1 : 0, blocked: lib.ready !== false ? 0 : 1, missingRefs: 0, refs: 0, lessonGaps: 0 });
				};
				bump(byBucket, bucket, BUCKET_FALLBACK[bucket] ?? bucket, { bucket });
				bump(byForm, form, formLabel, { form, bucket });
			}
			return {
				total: libs.length,
				ready: libs.filter((lib) => lib.ready !== false).length,
				blocked: libs.filter((lib) => lib.ready === false).length,
				byBucket,
				byForm,
				refs: 0,
				missingRefs: 0,
				undeclaredAccess: 0,
				lessons: 0,
				lessonGaps: libs.filter((lib) => lib.lessonGap).length,
			};
		};

		/** 三类齐全（含 0 条的那类），首页三格才是稳定的一套。 */
		const withAllBuckets = (stats) => {
			const found = new Map((stats.byBucket || []).map((group) => [group.bucket, group]));
			return Object.keys(BUCKET_FALLBACK).map((bucket) => found.get(bucket) ?? {
				bucket, label: BUCKET_FALLBACK[bucket], count: 0, ready: 0, blocked: 0, missingRefs: 0, refs: 0, lessonGaps: 0,
			});
		};

		/** 这一类里用到的账号（钥匙跟着它服务的资源走）。 */
		const accountsForBucket = (accounts, libs) => {
			const refs = new Set();
			for (const lib of libs) for (const cred of lib.credentials ?? []) refs.add(cred.ref);
			return (accounts || []).filter((account) => (account.fields ?? []).some((field) => refs.has(field.ref)));
		};

		/** 由 apply 传入、闭包持有 ctx 的接口。组件因此不依赖槽位的 inject-props 契约。 */
		const createSection = (api, LibrariesView) => {
			// 幂等：只注入一次。组件每次渲染都会调，命中 getElementById 就返回。
			injectStyles();
			function StashCredentials() {
				const [state, setState] = React.useState({
					loading: true, accounts: [], stats: null, problems: [], categories: [], libraries: [],
					libraryStats: null,
					records: null,
					sourcesFile: null, localFile: null, error: null, credentialsAvailable: true, endpoint: null,
				});
				const [open, setOpen] = React.useState({});
				const [drafts, setDrafts] = React.useState({});
				const [valueOpen, setValueOpen] = React.useState({});
				const [confirm, setConfirm] = React.useState(null);
				const [form, setForm] = React.useState(null);
				const [busy, setBusy] = React.useState(null);
				const [notice, setNotice] = React.useState(null);

				/* 三层视图：导航状态、账号详情态；插槽不提供路由，所以全在客户端。 */
				const [view, setView] = React.useState("overview");
				const [level1, setLevel1] = React.useState(null);
				const [accountId, setAccountId] = React.useState(null);
				const [fieldEdit, setFieldEdit] = React.useState({});

				/* 「类层」的筛选状态。放在页面这一层（而不是视图里），是为了让视图保持无 hook 的纯渲染。 */
				const [libBucket, setLibBucket] = React.useState("remote");
				const [libFilter, setLibFilter] = React.useState("all");
				const [libQuery, setLibQuery] = React.useState("");
				const [libOpen, setLibOpen] = React.useState({});
				/* 账号块的折叠与筛选（账号多了也找得到）；搜索与资源共用一个输入框。 */
				const [acctOpen, setAcctOpen] = React.useState(false);
				const [acctFilter, setAcctFilter] = React.useState("all");
				/* 新建菜单：null | "root"（账号/资源）| "resource"（七个细分）。 */
				/* 新建页的「新建什么」：account | remote | local-service | local-files。 */
				const [createType, setCreateType] = React.useState("remote");
				/* 资源表单（新建 / 编辑同一套）；delConfirm 是删除的二次确认。 */
				const [rc, setRc] = React.useState(null);
				const [delConfirm, setDelConfirm] = React.useState(null);
				const [acctNotice, setAcctNotice] = React.useState(null);

				/* 迁移区块：默认折叠；状态全部来自 GET /stash/portability。 */
				const [port, setPort] = React.useState({
					open: false, loading: false, hasExportRecord: false, defaultExportDir: '',
					exportHome: '', recent: [], dir: '', withValues: false, includeCorpus: false,
					includeCorpusWipe: false, importDir: '', dryRun: false,
					verify: null, plan: null, wipeResult: null, wipeConfirm: '', busy: null,
				});

				const load = React.useCallback(async () => {
					setState((prev) => ({ ...prev, loading: true, error: null }));
					// URL 解析与 fetch 都必须包在 try 内：抛在 try 之外会让 loading 永远为 true。
					let url = resolveEndpoint(ENDPOINT_PATH);
					try {
						setState((prev) => ({ ...prev, endpoint: url }));
						const response = await fetch(url, {
							headers: { Accept: "application/json" },
							cache: "no-store",
							signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
								? AbortSignal.timeout(15000)
								: undefined,
						});
						const text = await response.text();
						if (!response.ok) {
							throw new Error(`HTTP ${response.status} @ ${url}${text ? " — " + text.slice(0, 200) : "（响应体为空）"}`);
						}
						let payload;
						try {
							payload = JSON.parse(text);
						} catch {
							throw new Error(`响应不是 JSON @ ${url} — ${text ? text.slice(0, 200) : "（空响应体）"}`);
						}
						if (!payload.ok) throw new Error(`${payload.error || "读取失败"} @ ${url}`);
						setState({
							loading: false,
							accounts: payload.accounts || [],
							stats: payload.stats || null,
							problems: payload.problems || [],
							categories: payload.categories || [],
							libraries: payload.libraries || [],
							libraryStats: payload.libraryStats || null,
							records: payload.records || null,
							sourcesFile: payload.sourcesFile || null,
							localFile: payload.localFile || null,
							error: null,
							credentialsAvailable: payload.credentialsAvailable !== false,
							endpoint: url,
						});
					} catch (error) {
						setState((prev) => ({
							loading: false, accounts: [], stats: null, problems: [], categories: prev.categories || [],
							libraries: prev.libraries || [], sourcesFile: prev.sourcesFile || null, localFile: prev.localFile || null,
							error: (error && error.message) ? error.message : String(error),
							credentialsAvailable: true, endpoint: url ?? prev.endpoint ?? null,
						}));
					}
				}, []);

				/** 迁移状态：默认导出目录、有没有导出记录、最近几次导出（**不回校验码**）。 */
				const loadPort = React.useCallback(async () => {
					const url = resolveEndpoint(PORTABILITY_PATH);
					try {
						const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
						const text = await response.text();
						const payload = JSON.parse(text);
						if (!response.ok || !payload || !payload.ok) return;
						setPort((prev) => ({
							...prev,
							hasExportRecord: payload.hasExportRecord === true,
							defaultExportDir: payload.defaultExportDir || '',
							exportHome: payload.exportHome || '',
							recent: Array.isArray(payload.recent) ? payload.recent : [],
							dir: prev.dir || payload.defaultExportDir || '',
						}));
					} catch {
						// 迁移端点不可用不该挡住钥匙页——它只是一块附加能力。
					}
				}, []);

				React.useEffect(() => { load(); loadPort(); }, [load, loadPort]);

				/**
				 * 迁移端点调用。**请求体里永远没有值**，只有动作、目录、开关、校验码。
				 * 失败一律落到 notice：ok=false 且带 error / hint 时把 hint 一起说出来，
				 * 否则用户只看到一句"失败"却不知道下一步做什么。
				 */
				const portPost = async (action, body) => {
					const url = resolveEndpoint(PORTABILITY_PATH) + "?action=" + encodeURIComponent(action);
					try {
						const response = await fetch(url, {
							method: "POST",
							headers: { "Content-Type": "application/json", Accept: "application/json" },
							body: JSON.stringify(body || {}),
						});
						const text = await response.text();
						let payload = null;
						try { payload = JSON.parse(text); } catch { /* 下面按状态码报错 */ }
						if (!payload) throw new Error("HTTP " + response.status + "（响应不是 JSON）");
						return payload;
					} catch (error) {
						return { ok: false, error: error && error.message ? error.message : String(error) };
					}
				};

				const runExport = async () => {
					setPort((prev) => ({ ...prev, busy: "export", verify: null }));
					setNotice(null);
					const payload = await portPost("export", {
						dir: port.dir.trim() || undefined,
						withValues: port.withValues === true,
						includeCorpus: port.includeCorpus === true,
					});
					if (payload && payload.ok) {
						setPort((prev) => ({ ...prev, busy: null, verify: payload, hasExportRecord: true, plan: null, wipeResult: null }));
						setNotice(null);
						loadPort();
					} else {
						setPort((prev) => ({ ...prev, busy: null }));
						setNotice({ bad: true, text: "导出失败：" + ((payload && payload.error) || "未知错误") + (payload && payload.hint ? " —— " + payload.hint : "") });
					}
				};

				const runImport = async () => {
					if (!port.importDir.trim()) { setNotice({ bad: true, text: "导入需要填包目录（浏览器拿不到本地路径）。" }); return; }
					setPort((prev) => ({ ...prev, busy: "import" }));
					setNotice(null);
					const payload = await portPost("import", { dir: port.importDir.trim(), dryRun: port.dryRun === true });
					if (payload && payload.ok) {
						setPort((prev) => ({ ...prev, busy: null, verify: payload }));
						// 导入会动台账，重新读一遍钥匙状态。
						load();
					} else {
						setPort((prev) => ({ ...prev, busy: null }));
						setNotice({ bad: true, text: "导入失败：" + ((payload && payload.error) || "未知错误") + (payload && payload.hint ? " —— " + payload.hint : "") });
					}
				};

				const runPlanWipe = async () => {
					setPort((prev) => ({ ...prev, busy: "plan", wipeResult: null }));
					setNotice(null);
					const payload = await portPost("plan-wipe", { includeCorpus: port.includeCorpusWipe === true });
					if (payload && payload.ok) setPort((prev) => ({ ...prev, busy: null, plan: payload }));
					else {
						setPort((prev) => ({ ...prev, busy: null }));
						setNotice({ bad: true, text: "清空计划失败：" + ((payload && payload.error) || "未知错误") + (payload && payload.hint ? " —— " + payload.hint : "") });
					}
				};

				const runWipe = async () => {
					if (!port.wipeConfirm.trim()) { setNotice({ bad: true, text: "请输入另一台机器导入成功时回显的校验码。" }); return; }
					setPort((prev) => ({ ...prev, busy: "wipe" }));
					setNotice(null);
					const payload = await portPost("wipe", { includeCorpus: port.includeCorpusWipe === true, confirm: port.wipeConfirm.trim() });
					if (payload && payload.ok) {
						// 刻意不重读迁移状态：读数会让"没有导出记录"立刻把这一步的结果盖掉。
						setPort((prev) => ({ ...prev, busy: null, verify: payload, plan: null }));
						load();
					} else {
						setPort((prev) => ({ ...prev, busy: null }));
						setNotice({ bad: true, text: "清空失败：" + ((payload && payload.error) || "未知错误") + (payload && payload.hint ? " —— " + payload.hint : "") });
					}
				};

				/* ── 值：只走凭据服务，永不进台账文件、永不回显 ───────────────── */

				/**
				 * 把镜像结果转成一句人话。
				 *
				 * 「写进 .env」只在重启后对读 `process.env` 的组件生效——不说清，
				 * 用户会以为保存没成功（面板那时仍显示未配置）。
				 */
				const mirrorHint = (mirror) => {
					if (!mirror) return "";
					if (mirror.ok && Array.isArray(mirror.written) && mirror.written.length > 0) {
						return " 已同步到 $DSH_HOME/.env 的 " + mirror.written.join("、")
							+ "：重启 DSH 后对读 process.env 的组件生效。";
					}
					if (mirror.ok && Array.isArray(mirror.removed) && mirror.removed.length > 0) {
						return " 已清掉会遮蔽它的旧 .env 键：" + mirror.removed.join("、") + "。";
					}
					if (mirror.ok === false && mirror.error) return " 但没能同步到 .env：" + mirror.error + "。";
					return "";
				};

				/** ⚠️ 刻意不 trim：口令首尾空格有意义，PEM/JSON 多行值也不能被裁。 */
				const saveValue = async (field) => {
					const value = drafts[field.ref] === undefined ? "" : drafts[field.ref];
					if (value === "") { setNotice({ bad: true, text: "请输入 " + field.ref + " 的值（空串不会覆盖已存的值）。" }); return; }
					setBusy(field.ref);
					setNotice(null);
					try {
						const result = await api.setRef(field.ref, value);
						if (result && result.ok) {
							setDrafts((prev) => { const next = { ...prev }; delete next[field.ref]; return next; });
							setValueOpen((prev) => ({ ...prev, [field.ref]: false }));
							setNotice({ bad: false, text: field.ref + " 已保存到凭据库（值不会回显）。" + mirrorHint(result.mirror) });
						} else {
							setNotice({ bad: true, text: (result && result.error && result.error.message) || "保存被拒绝。" });
						}
					} catch (error) {
						setNotice({ bad: true, text: error && error.message ? error.message : String(error) });
					} finally {
						setBusy(null);
						load();
					}
				};

				const unsetValue = async (ref) => {
					setBusy(ref);
					setNotice(null);
					try {
						const result = await api.unsetRef(ref);
						if (result && result.ok) {
							const removed = result.mirror && Array.isArray(result.mirror.removed) ? result.mirror.removed : [];
							setNotice({
								bad: false,
								text: ref + " 已从凭据库移除（台账条目保留）。"
									+ (removed.length > 0 ? " 并从 .env 清掉了 " + removed.join("、") + "。" : ""),
							});
						} else setNotice({ bad: true, text: (result && result.error && result.error.message) || "移除被拒绝。" });
					} catch (error) {
						setNotice({ bad: true, text: error && error.message ? error.message : String(error) });
					} finally {
						setBusy(null);
						load();
					}
				};

				/* ── 台账元数据：POST 建 / PATCH 改 / DELETE 删 ─────────────────── */

				const sendMeta = async (method, body) => {
					const response = await fetch(resolveEndpoint(ENDPOINT_PATH), {
						method,
						headers: { "Content-Type": "application/json", Accept: "application/json" },
						body: JSON.stringify(body),
					});
					const text = await response.text();
					let payload = null;
					try { payload = JSON.parse(text); } catch { /* 下面按状态码报错 */ }
					return { response, payload };
				};

				const deleteRemote = async (query) => {
					const response = await fetch(resolveEndpoint(ENDPOINT_PATH) + query, {
						method: "DELETE",
						headers: { Accept: "application/json" },
					});
					const text = await response.text();
					let payload = null;
					try { payload = JSON.parse(text); } catch { /* 下面按状态码报错 */ }
					return { response, payload };
				};

				const submitForm = async (dropConfigured) => {
					if (!form) return;
					const body = payloadOfForm(form.data);
					if (!body.label) { setNotice({ bad: true, text: "中文名必填。" }); return; }
					if (body.fields.length === 0) { setNotice({ bad: true, text: "至少要有一个字段（引用名）。" }); return; }
					const editing = form.mode === "edit";
					if (editing) body.id = form.data.id.trim();
					if (dropConfigured) body.dropConfigured = true;

					setBusy(editing ? form.data.id : "__new__");
					setNotice(null);
					try {
						const { response, payload } = await sendMeta(editing ? "PATCH" : "POST", body);
						if (!response.ok || !payload || !payload.ok) {
							// 删掉已配置字段会被 host 拦下：把确认交给用户，而不是让模型代劳
							if (payload && Array.isArray(payload.configuredRefs) && payload.configuredRefs.length > 0 && !dropConfigured) {
								setConfirm({
									kind: "drop-fields",
									refs: payload.configuredRefs,
									text: "这次修改会删掉已配置的字段：" + payload.configuredRefs.join(", ")
										+ "。删字段不会删值（值会变成没人认领的孤儿）。",
								});
								return;
							}
							throw new Error((payload && payload.error) || ("HTTP " + response.status));
						}
						// 保存成功回上一层：详情态回账号详情，新建态回清单（那条新账号就在那儿）。
						setForm(null);
						setNotice({
							bad: false,
							text: editing
								? "已更新「" + body.label + "」的信息。"
								: "已登记「" + body.label + "」" + (body.fields.length > 1 ? "（" + body.fields.length + " 个字段）" : "")
									+ "。未配置的字段可以直接在下面粘贴值。",
						});
						if (!editing) {
							if (body.id) setAccountId(body.id);
							setLevel1({ filter: "all", category: null });
							setView("list");
						}
						load();
					} catch (error) {
						setNotice({ bad: true, text: error && error.message ? error.message : String(error) });
					} finally {
						setBusy(null);
					}
				};

				const runConfirm = async () => {
					if (!confirm) return;
					const current = confirm;
					setBusy(current.ref || current.id || "__meta__");
					setNotice(null);
					try {
						if (current.kind === "unset") {
							await unsetValue(current.ref);
						} else if (current.kind === "delete-account") {
							const { response, payload } = await deleteRemote("?id=" + encodeURIComponent(current.id) + "&force=1");
							if (!response.ok || !payload || !payload.ok) throw new Error((payload && payload.error) || ("HTTP " + response.status));
							setNotice({ bad: false, text: "已删除条目「" + current.label + "」（凭据库里的值仍在，需要的话请先「移除值」）。" });
							// 条目没了，详情态就没有落脚点——退回清单。
							setAccountId(null);
							setView("list");
							load();
						} else if (current.kind === "delete-field") {
							const { response, payload } = await deleteRemote("?ref=" + encodeURIComponent(current.ref) + "&force=1");
							if (!response.ok || !payload || !payload.ok) throw new Error((payload && payload.error) || ("HTTP " + response.status));
							setNotice({ bad: false, text: "已从条目里删除字段 " + current.ref + "（值仍在凭据库）。" });
							load();
						} else if (current.kind === "drop-fields") {
							setConfirm(null);
							await submitForm(true);
						}
						setConfirm(null);
					} catch (error) {
						setNotice({ bad: true, text: error && error.message ? error.message : String(error) });
						setConfirm(null);
					} finally {
						setBusy(null);
					}
				};

				/* ── 表单编辑小工具 ───────────────────────────────────────────── */

				const patchForm = (changes) => setForm((prev) => (prev ? { ...prev, data: { ...prev.data, ...changes } } : prev));
				const patchField = (index, changes) => setForm((prev) => {
					if (!prev) return prev;
					const fields = prev.data.fields.map((field, i) => (i === index ? { ...field, ...changes } : field));
					return { ...prev, data: { ...prev.data, fields } };
				});
				const addFieldRow = () => setForm((prev) => (prev
					? { ...prev, data: { ...prev.data, fields: [...prev.data.fields, { ref: "", label: "", secret: true, inject: "", multiline: false, notes: "" }] } }
					: prev));
				const removeFieldRow = (index) => setForm((prev) => {
					if (!prev) return prev;
					const fields = prev.data.fields.filter((_field, i) => i !== index);
					return { ...prev, data: { ...prev.data, fields: fields.length > 0 ? fields : emptyForm().fields } };
				});
				const toggleUsedBy = (id) => setForm((prev) => {
					if (!prev) return prev;
					const has = prev.data.usedBy.includes(id);
					return { ...prev, data: { ...prev.data, usedBy: has ? prev.data.usedBy.filter((x) => x !== id) : [...prev.data.usedBy, id] } };
				});

				/* ── 资源写路径：新建 / 编辑 / 删除 ─────────────────────────────
				   浏览器只提交**引用的名字与元数据**；值从不经过这里。
				   host 那边这两条路由直接调用 stash_source_add 本体，
				   所以这里的校验报错与模型侧完全同一套。 */

				const postResource = async (rcState) => {
					const entry = buildResourceEntry(rcState);
					const url = resolveEndpoint(SOURCES_PATH);
					setRc((prev) => (prev ? { ...prev, busy: true, errors: [], summaryError: null, hint: null } : prev));
					try {
						const response = await fetch(url, {
							method: "POST",
							headers: { "Content-Type": "application/json", Accept: "application/json" },
							cache: "no-store",
							body: JSON.stringify(entry),
						});
						const data = await response.json().catch(() => null);
						if (!response.ok || !data || data.ok !== true) {
							setRc((prev) => (prev ? {
								...prev, busy: false,
								errors: mapResourceErrors(data),
								summaryError: (data && data.error) || "登记被拒绝",
								hint: (data && data.hint) || null,
							} : prev));
							return false;
						}
						await load();
						setRc(null);
						setView("libraries");
						setNotice({ text: `已写入 sources.local.json：${entry.id}（无需重启，注册表每次调用重读）`, bad: false });
						return true;
					} catch (error) {
						setRc((prev) => (prev ? {
							...prev, busy: false,
							errors: [{ field: null, message: (error && error.message) || String(error) }],
							summaryError: "请求没发出去",
							hint: "检查 host 半边是否已重启（新端点要重启才注册）。",
						} : prev));
						return false;
					}
				};

				const removeResource = async (id) => {
					// resolveEndpoint 只回 pathname（它被设计成丢掉 query），所以查询串在这里拼。
					const url = resolveEndpoint(SOURCES_PATH) + "?id=" + encodeURIComponent(id);
					try {
						const response = await fetch(url, { method: "DELETE", headers: { Accept: "application/json" }, cache: "no-store" });
						const data = await response.json().catch(() => null);
						setDelConfirm(null);
						if (!response.ok || !data || data.ok !== true) {
							setNotice({ text: (data && data.error) || `删除失败（HTTP ${response.status}）`, bad: true });
							return false;
						}
						await load();
						setNotice({
							text: `已删除 ${id}`
								+ (data.accountsUpdated > 0 ? `；顺带从 ${data.accountsUpdated} 个账号的关联里摘掉了它` : "")
								+ "。取数台账不删，经验仍在 lessons.json（界面按已登记库聚合，所以不再显示）。",
							bad: false,
						});
						return true;
					} catch (error) {
						setDelConfirm(null);
						setNotice({ text: (error && error.message) || String(error), bad: true });
						return false;
					}
				};

				/** 打开编辑表单：用 payload 里已有的字段回填（request 由 host 一并给出）。 */
				const openResourceEditor = (lib) => {
					const request = (lib && lib.request) || {};
					const next = emptyResource(lib.form);
					next.mode = "edit";
					next.id = lib.id;
					next.name = lib.name;
					next.access = lib.access ?? "";
					next.summary = lib.summary ?? "";
					next.boundary = lib.boundary ?? "";
					next.bucketOverride = lib.bucketOverridden ? lib.bucket : "";
					next.credentials = (lib.credentials ?? []).map((field) => field.ref).join(", ");
					if (lib.form === "http") {
						next.url = request.url ?? "";
						next.method = request.method ?? "GET";
						next.headers = Object.entries(request.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
						next.required = (request.required ?? []).join(", ");
						next.limit = request.limit ? String(request.limit) : "";
					} else if (lib.form === "db") {
						next.dbPath = request.path ?? "";
						next.sql = request.sql ?? "";
						next.required = (request.required ?? []).join(", ");
						next.limit = request.limit ? String(request.limit) : "";
					} else if (lib.form === "objstore") {
						next.protocol = request.protocol ?? "s3";
						next.endpoint = request.endpoint ?? "";
						next.bucket = request.bucket ?? "";
						next.region = request.region ?? "";
						next.prefix = request.prefix ?? "";
						next.limit = request.limit ? String(request.limit) : "";
						next.advanced = true;
					} else if (lib.form === "files") {
						next.paths = (lib.paths ?? []).map((item) => item.path).join("\n");
					} else if (lib.form === "mcp") {
						next.server = lib.server ?? "";
						next.transport = lib.transport ?? "stdio";
						next.tools = lib.tools ?? "";
					}
					
					setNotice(null);
					setRc(next);
					setView("resource");
				};

				/** 打开空白资源表单（从新建菜单选了一个细分）。 */
				const openResourceCreator = (form, classId = null) => {
					const next = emptyResource(form);
					next.classScope = classId;
					// 从某一类进来时，归入就**预先写死这一类**（仍可改）：
					// 选了「本机文件」却归到「远端接口」，多半是误操作。
					if (classId) next.bucketOverride = classId;
					if (form === "files" || form === "mcp" || form === "db") next.advanced = true;
					
					setNotice(null);
					setRc(next);
					setView("resource");
				};


				/** 打开新建页：**一个页面**，里面用下拉决定新建什么（不再有中间菜单）。 */
				const openCreate = () => {
					
					setNotice(null);
					setForm(null);
					setRc({ ...emptyResource("http"), classScope: "remote", bucketOverride: "remote" });
					setCreateType("remote");
					setView("create");
				};

				/** 新建页里换「新建什么」：账号表单与资源表单就地切换，页面不跳走。 */
				const switchCreateType = (next) => {
					if (next === "account") {
						setRc(null);
						setForm((prev) => (prev && prev.mode === "new" ? prev : { mode: "new", data: emptyForm() }));
						setCreateType("account");
						return;
					}
					setForm(null);
					const first = formsOfClass(next)[0].form;
					setRc({
						...emptyResource(first), classScope: next, bucketOverride: next,
						advanced: first === "files" || first === "mcp" || first === "db",
					});
					setCreateType(next);
				};


				/** 删除的二次确认：不动台账与经验，但要说清它们会怎样。 */
				const renderDeleteConfirm = () => {
					if (!delConfirm) return null;
					return h("div", { key: "del", className: "dshs-card", style: { ...S.card, borderColor: C.warn } },
						h("div", { style: { fontWeight: 600 } }, "确认删除 " + delConfirm.id + "？"),
						h("div", { style: S.meta }, "删除的是这条登记（取数描述、摘要、备注、边界一并去掉）。"),
						h("div", { style: S.meta },
							"取数台账不会删（只追加不删）；"
							+ (delConfirm.lessonCount > 0
								? `该库有 ${delConfirm.lessonCount} 条经验，删后界面上不再显示（数据仍在 lessons.json，可用 stash_lesson_list 查）。`
								: "该库没有经验记录。")),
						h("div", { style: { display: "flex", gap: "8px", marginTop: "9px" } },
							h("button", { key: "no", className: "dshs-ghost", style: S.btn(false), onClick: () => setDelConfirm(null) }, "取消"),
							h("button", {
								key: "yes", className: "dshs-danger", style: S.btn(false),
								onClick: () => { void removeResource(delConfirm.id); },
							}, "确认删除")));
				};

				/* ── 视图导航 ─────────────────────────────────────────────────── */

				const gotoOverview = () => { setView("overview"); setForm(null); setNotice(null); };

				const gotoList = (filter, category) => {
					setLevel1({ filter: filter || "all", category: category || null });
					setView("list");
					setForm(null);
					setNotice(null);
				};
				const gotoAccount = (account) => {
					setAccountId(account.id);
					setFieldEdit({});
					setValueOpen({});
					setView("account");
					setForm(null);
					setNotice(null);
				};

				/* ── 渲染 ─────────────────────────────────────────────────────── */

				if (state.loading && state.accounts.length === 0) {
					return h("div", { className: "dshs-root", style: S.wrap },
						h("div", null, "正在读取凭据状态…"),
						h("div", { style: S.hint },
							"端点：" + (state.endpoint || resolveEndpoint(ENDPOINT_PATH)),
							h("br"),
							"若停在这里超过 15 秒，说明该请求没有得到响应（已被超时中止）。"));
				}
				if (state.error) {
					return h("div", { className: "dshs-root", style: S.wrap },
						h("div", { style: S.notice(true) }, "读不到凭据状态：" + state.error),
						h("div", { style: S.hint },
							"端点：" + (state.endpoint || resolveEndpoint(ENDPOINT_PATH)) + "（由 dsh-stash 的 host 半边提供）",
							h("br"),
							"HTTP 404 且响应体为空 → 路由未注册；HTTP 401 → 认证问题；被中止 → 请求未得到响应。"),
						h("button", { style: S.btn(false), onClick: load }, "重试"));
				}

				const stats = state.stats || { accounts: state.accounts.length, fields: 0, configured: 0, missing: 0, byCategory: [] };
				const crumbBtn = (key, label, onClick) => h("button", {
					key, className: "dshs-crumb", style: S.btn(false), onClick,
				}, label);
				const renderCrumbs = (tailLabel, tailOnClick) => {
					const items = [
						crumbBtn("k", "stash", gotoOverview),
						// 只有 L3 才多一段「分类」：L2 本身就是清单，再套一层分类是多余的一跳。
						view === "account" && account_category()
							? crumbBtn("c", categoryLabelOf(account_category()), () => gotoList((level1 && level1.filter) || "all", account_category()))
							: null,
						tailLabel ? crumbBtn("t", tailLabel, tailOnClick) : null,
					].filter(Boolean);
					const nodes = [];
					items.forEach((item, index) => {
						if (index > 0) nodes.push(h("span", { key: "s" + index, style: S.crumbSep }, "›"));
						nodes.push(item);
					});
					return h("div", { key: "crumbs", style: S.crumbRow }, ...nodes);
				};
				const categoryLabelOf = (id) => {
					const found = (stats.byCategory || []).find((group) => group.category === id)
						|| (state.categories || []).find((group) => group.id === id);
					return found ? (found.categoryLabel || found.label || id) : id;
				};
				/** 面包屑要用到当前账号的分类，而 account 是后面才算的——函数声明提升，绕开 TDZ。 */
				function account_category() {
					const current = (state.accounts || []).find((item) => item.id === accountId);
					return current ? current.category : null;
				}

				/* ══ 类层：同一个面板内的一层，从首页三类里点进来 ═══════════════ */

				if (view === "libraries") {
					const bucketId = libBucket || "remote";
					const inBucket = (state.libraries || []).filter((lib) => bucketOfLocal(lib) === bucketId);
					return h("div", { className: "dshs-root", style: S.wrap },
						renderCrumbs(BUCKET_FALLBACK[bucketId] ?? bucketId),
						h(LibrariesView, {
							bucket: bucketId,
							bucketLabel: BUCKET_FALLBACK[bucketId] ?? bucketId,
							libraries: inBucket,
							libraryStats: state.libraryStats,
							accounts: accountsForBucket(state.accounts, inBucket),
							problems: state.problems,
							sourcesFile: state.sourcesFile,
							localFile: state.localFile,
							filter: libFilter, setFilter: setLibFilter,
							query: libQuery, setQuery: setLibQuery,
							open: libOpen, setOpen: setLibOpen,
							acctOpen, setAcctOpen, acctFilter, setAcctFilter,
							notice,
							deleteConfirm: delConfirm, onCancelDelete: () => setDelConfirm(null),
							onConfirmDelete: () => { if (delConfirm) void removeResource(delConfirm.id); },
							onEditResource: openResourceEditor,
							onDeleteResource: (lib) => setDelConfirm({
								id: lib.id, name: lib.name,
								lessonCount: (lib.lessons && lib.lessons.count) || 0,
								handwritten: lib.origin === "handwritten",
							}),
							onBack: gotoOverview, onReload: load,
							onOpenAccount: (id) => { setAccountId(id); setForm(null); setNotice(null); setView("account"); },
							onOpenLedger: () => { setLevel1({ filter: "all", category: null }); setView("list"); },
						}));
				}

				/* ══ 资源表单：新建 / 编辑同一套；字段随形态变，必填只 4 项 ══════ */

				/** 资源表单的**主体**（不含面包屑与标题）：新建页与编辑页共用同一份。 */
				const renderResourceFormBody = () => {
					const current = rc || emptyResource("http");
					const meta = resourceFormMeta(current.form);
					const patch = (key, value) => setRc((prev) => (prev ? { ...prev, [key]: value } : prev));
					const errorOf = (key) => (current.errors || []).find((item) => item.field === key);
					const cap = (key) => (errorOf(key) ? { ...S.input, borderColor: C.warn } : S.input);
					const field = (key, label, placeholder, opts = {}) => h("div", { key, style: S.fieldRow },
						h("span", { style: S.rowLabel }, label),
						h("div", { style: S.fieldControl },
							opts.area
								? h("textarea", {
									style: { ...cap(key), ...S.area, width: "100%" },
									value: current[key], placeholder,
									onChange: (event) => patch(key, event.target.value),
								})
								: h("input", {
									style: { ...cap(key), ...S.fullInput }, value: current[key], placeholder,
									onChange: (event) => patch(key, event.target.value),
								}),
							errorOf(key) ? h("div", { style: S.warn }, errorOf(key).message) : null));

					/** 方框下的注释：空标签列占位，让说明与方框同一起点（不要从面板最左边起）。 */
					const hintRow = (key, text, style) => h("div", { key, style: S.fieldRow },
						h("span", { key: "sp", style: S.rowLabel }, ""),
						h("div", { style: S.fieldControl }, h("div", { style: { ...S.hint, ...(style || {}) } }, text)));

					const rows = [];
					rows.push(field("id", "ID", "小写字母/数字/-/_，如 my_service"));
					rows.push(field("name", "名称", "人看的名字，如 SEC EDGAR · 申报清单"));

					if (current.form === "http") {
						rows.push(field("url", "接口地址", "https://example.com/api/{param}"));
						rows.push(field("method", "方法", "GET"));
						if (current.advanced) {
							rows.push(field("headers", "请求头", "每行一条，如 User-Agent: dsh-stash/1.0", { area: true }));
							rows.push(field("required", "必填参数", "逗号分隔，如 cik"));
							rows.push(field("limit", "条数上限", "如 100"));
							rows.push(field("query", "查询参数", "每行一条 key=value，如 lang=zh", { area: true }));
							rows.push(field("pick", "取哪一段", "从响应里取哪一段，如 data.items"));
							rows.push(field("body", "请求体", "POST / PUT 时用；JSON 会按对象发送", { area: true }));
						}
					} else if (current.form === "db") {
						rows.push(field("dbPath", "SQLite 路径", "绝对路径，如 D:/data/app.db"));
						rows.push(field("sql", "只读 SQL", "SELECT ... WHERE dept = :dept LIMIT 20", { area: true }));
						rows.push(field("required", "必填参数", "逗号分隔，如 dept"));
						rows.push(field("limit", "行数上限", "如 200"));
					} else if (current.form === "objstore") {
						rows.push(h("div", { key: "protocol", style: S.fieldRow },
							h("span", { style: S.rowLabel }, "协议"),
							h("select", {
								className: "dshs-select",
								style: S.fullSelect,
								value: current.protocol,
								onChange: (event) => patch("protocol", event && event.target ? event.target.value : "s3"),
							},
								h("option", { key: "s3", value: "s3" }, "S3 兼容（含 MinIO）"),
								h("option", { key: "webdav", value: "webdav" }, "WebDAV 目录"))));
						rows.push(field("endpoint", "端点", current.protocol === "webdav" ? "https://dav.example.com/dir/" : "https://s3.example.com"));
						rows.push(field("bucket", "bucket", "webdav 不用填"));
						if (current.advanced) {
							rows.push(field("region", "region", "S3 签名必填，如 us-east-1"));
							rows.push(field("prefix", "默认前缀", "如 reports/"));
							rows.push(field("limit", "条数上限", "如 50"));
						}
					} else if (current.form === "files") {
						rows.push(field("paths", "路径", "每行一条；如 D:/corpus/a.csv", { area: true }));
						rows.push(hintRow("corpus", "面板不会替你搬文件：先把文件放进 corpus 目录，再回来填路径。", S.warn));
					} else if (current.form === "mcp") {
						rows.push(field("server", "服务名", "DSH profile 里那条 MCP 行的 serverName，如 my-service"));
						rows.push(h("div", { key: "tr", style: S.fieldRow },
							h("span", { style: S.rowLabel }, "承载"),
							...[["stdio", "stdio（子进程）"], ["streamable-http", "streamable-http"], ["sse", "sse"]].map(([id, label]) => h("button", {
								key: id, className: current.transport === id ? "dshs-primary" : "dshs-ghost", style: S.btn(false),
								onClick: () => patch("transport", id),
							}, label))));
						rows.push(field("tools", "工具前缀", "如 mcp__my-service__*"));
					}

					// 使用边界：**一个下拉**（四个值里两个是硬门禁）。四个 chip 会折成两行，
					// 加上后面那段说明，一屏里全是字——下拉把选择收起来，说明压成一行。
					// 本机文件那一类（文档与数据文件 / 本地数据库）不上网取数、也不需要凭据，
					// 问「使用边界」「钥匙」是错问——这两组只在真会去网络上取数的形态里出现。
					const asksAccess = current.form !== "files" && current.form !== "db";
					if (asksAccess) rows.push(h("div", { key: "access", style: S.fieldRow },
						h("span", { style: S.rowLabel }, "使用边界"),
						h("select", {
							className: "dshs-select",
							style: S.fullSelect,
							value: current.access,
							onChange: (event) => patch("access", event && event.target ? event.target.value : current.access),
						},
							h("option", { key: "public-api", value: "public-api" }, "公开免登录（可直连取数）"),
							h("option", { key: "official-api", value: "official-api" }, "官方 API / 需授权"),
							h("option", { key: "export-import", value: "export-import" }, "◇ 只能人工导出（硬门禁）"),
							h("option", { key: "unsupported", value: "unsupported" }, "◇ 明确不做（硬门禁）"))));
					if (asksAccess) rows.push(hintRow("accounthint", "带 ◇ 的两个是硬门禁：选了它们，取数工具直接拒绝取数、只留痕；另外两个是声明。"));

					if (asksAccess) rows.push(field("credentials", "钥匙引用名", "如 MY_API_KEY；不填就是不需要钥匙（多个用逗号分隔）"));
					if (asksAccess) rows.push(hintRow("keyhint", "这里只登记**引用名**；值在账号详情里贴，永不经过模型、不进会话记录。"
						+ (current.form === "objstore" ? "对象存储要按顺序填两个：access key id、secret access key。" : "")));

					const advancedRows = [];
					if (current.advanced) {
						advancedRows.push(field("summary", "摘要", "一句话说明这是什么"));
						advancedRows.push(field("boundary", "禁止边界", "写清不允许怎么用", { area: true }));
						advancedRows.push(field("coverage", "覆盖范围", "这份数据覆盖什么，如 2020–2025 · 月度"));
						advancedRows.push(field("notesText", "注意事项", "每行一条；取数前该知道的事", { area: true }));
					}

					const advancedToggle = ["http", "objstore"].includes(current.form)
						? h("div", { key: "advbox", style: S.advBox },
							h("button", {
								key: "adv", className: "dshs-ghost", style: S.advHead,
								onClick: () => patch("advanced", !current.advanced),
							},
								h("span", { key: "n", style: S.advName }, (current.advanced ? "▾ " : "▸ ") + "高级设置"),
								h("span", { key: "note", style: { ...S.advNote, marginLeft: "auto" } },
									current.advanced ? "收起" : "请求头 / 查询参数 / 取哪一段 / 请求体 / 条数上限 / 覆盖范围 / 注意事项")),
							current.advanced ? h("div", { key: "advbody", style: S.advBody }, ...advancedRows) : null)
						: null;


					return [
						// 形态：新建时是一个**下拉**（只列这一类能有的），编辑时只读——
						// 换形态等于换一条库，该删了重建。选中后下面那行小字说明它的能力边界。
						h("div", { key: "formtype", style: S.fieldRow },
							h("span", { style: S.rowLabel }, "形态"),
							h("div", { style: S.fieldControl },
							current.mode === "edit"
								? h("span", { style: S.tag }, meta.label + " · " + meta.tech)
								: h("select", {
									className: "dshs-select",
									style: S.fullSelect,
									value: current.form,
									onChange: (event) => {
										const next = event && event.target ? event.target.value : current.form;
										// 换形态时保留**类范围与归入**：从「本机文件」进来的，不该因为换个形态就跑到别的类。
										setRc((prev) => (prev ? {
											...emptyResource(next),
											mode: prev.mode, id: prev.id,
											classScope: prev.classScope, bucketOverride: prev.bucketOverride,
											advanced: next === "files" || next === "mcp" || next === "db" ? true : prev.advanced,
										} : prev));
									},
								},
									...formsOfClass(current.classScope).map((item) => h("option", { key: item.form, value: item.form },
										item.label + "（" + item.tech + "）"))),
							h("div", { key: "formhint", style: S.hint }, meta.hint))),

						current.summaryError
							? h("div", { key: "err", style: { ...S.warn, border: "1px solid " + C.warn, borderRadius: "9px", padding: "9px 11px", marginTop: "10px" } },
								"⚠ " + current.summaryError + "（共 " + (current.errors || []).length + " 处需要改）"
								+ (current.hint ? "。" + current.hint : ""))
							: null,

						h("div", { key: "rows", style: { marginTop: "12px" } }, ...rows),
						advancedToggle,

						h("div", { key: "foot", style: { marginTop: "16px", paddingTop: "12px", borderTop: "1px solid " + C.border } },
							h("div", { key: "foothint", style: S.hint },
								"创建后写入 sources.local.json，无需重启（注册表每次调用重读）。校验与模型侧 stash_source_add 完全同一套。"),
							h("div", { key: "footbtns", style: { display: "flex", gap: "9px", alignItems: "center", marginTop: "10px" } },
								h("button", {
									key: "save", className: "dshs-primary",
									style: S.btn(Boolean(current.busy)),
									disabled: Boolean(current.busy),
									onClick: () => { void postResource(current); },
								}, current.busy ? "提交中…" : (current.mode === "edit" ? "保存修改" : "创建")),
								h("button", {
									key: "cancel2", className: "dshs-ghost", style: S.btn(false),
									onClick: () => { setRc(null);  setView("libraries"); },
								}, "取消"))),
					];
				};

				/* ══ 资源编辑页（表单主体与新建页共用）════════════════════ */

				if (view === "resource") {
					const current = rc || emptyResource("http");
					return h("div", { className: "dshs-root", style: S.wrap },
						renderCrumbs("编辑 " + current.id),
						h("div", { style: S.titleRow },
							h("span", { style: S.title }, "编辑资源"),
							h("button", {
								key: "cancel", className: "dshs-ghost", style: { ...S.spacer, ...S.btn(false) },
								onClick: () => { setRc(null);  setView("libraries"); },
							}, "取消")),
						...renderResourceFormBody(),
						renderRefresh());
				}

				/* ══ 新建页：**一个页面 + 下拉**（新建什么 → 形态 → 字段）══════ */

				if (view === "create") {
					const typeRow = h("div", { key: "type", style: S.fieldRow },
						h("span", { style: S.rowLabel }, "新建什么"),
						h("select", {
							className: "dshs-select",
							style: { flex: "0 1 280px", width: "auto" },
							value: createType,
							onChange: (event) => switchCreateType(event && event.target ? event.target.value : "remote"),
						},
							...Object.keys(CLASS_FORMS).map((id) => h("option", { key: id, value: id }, CLASS_FORMS[id].label))));
					return h("div", { className: "dshs-root", style: S.wrap },
						renderCrumbs("新建条目"),
						h("div", { style: S.titleRow },
							h("span", { style: S.title }, "新建条目"),
							h("button", {
								key: "cancel", className: "dshs-ghost", style: { ...S.spacer, ...S.btn(false) },
								onClick: () => { setRc(null); setForm(null); setNotice(null); gotoOverview(); },
							}, "取消")),
						typeRow,
						h("div", { key: "typehint", style: S.fieldRow },
							h("span", { key: "sp", style: S.rowLabel }, ""),
							h("div", { style: S.fieldControl }, h("div", { style: S.hint }, (CLASS_FORMS[createType] || CLASS_FORMS.remote).hint))),
						createType === "account"
							? (form ? renderForm("账号（只登记元数据；值在账号详情里录）") : null)
							: h("div", { key: "resbody" }, ...renderResourceFormBody()),
						h("div", { key: "acctlink", style: { ...S.hint, marginTop: "12px" } },
							"要新建的不是资源，而是账号（一个服务 / 网站，挂若干把钥匙）？",
							h("button", {
								key: "to-account", className: "dshs-ghost",
								style: { ...S.btn(false), marginLeft: "6px" },
								onClick: () => switchCreateType("account"),
							}, "新建账号 →")),
						renderRefresh());
				}


				/* ══ 首页（总览）：数字优先——资源总数 + 三类各多少 + 台账 + 迁移 ══ */

				if (view === "overview") {
					const byCategory = stats.byCategory || [];
					const libList = state.libraries || [];
					const ls = deriveLibraryStats(libList, state.libraryStats);
					const buckets = withAllBuckets(ls);
					const pct = stats.fields > 0 ? Math.round((stats.configured / stats.fields) * 100) : 0;
					const openBucket = (bucket, filter) => {
						setLibBucket(bucket);
						setLibFilter(filter || "all");
						setLibQuery("");
						setLibOpen({});
						setView("libraries");
					};
					const inBucketOf = (bucket) => libList.filter((lib) => bucketOfLocal(lib) === bucket);

					/** 三格里那行小字：一眼能看出这一类眼下是什么情况。 */
					const bucketNote = (group) => {
						if (group.bucket === "remote") {
							const accounts = accountsForBucket(state.accounts, inBucketOf("remote"));
							const refs = accounts.flatMap((account) => account.fields ?? []);
							const missing = refs.filter((field) => field.configured === false).length;
							return accounts.length > 0
								? accounts.length + " 个账号" + (missing > 0 ? " · " + missing + " 把钥匙未配置" : " · 钥匙齐")
								: "还没有账号";
						}
						if (group.bucket === "local-service") {
							return group.count > 0 ? "依赖本机在跑" : "还没有本机服务";
						}
						const files = inBucketOf("local-files").reduce((sum, lib) => sum + (lib.paths?.length ?? 0), 0);
						return group.count > 0 ? files + " 个路径" : "还没有本地文件";
					};

					const children = [];

					children.push(h("div", { key: "res", style: S.sec },
						h("div", { key: "head", className: "dshs-sec" },
							h("span", { className: "dshs-secname" }, "资源"),
							h("button", {
								key: "all", className: "dshs-ghost", style: { ...S.spacer, ...S.btn(false) },
								onClick: () => openBucket("remote", "all"),
							}, "全部资源 →")),
						h("div", { key: "hero", style: S.heroRow },
							h("span", { style: S.heroNum }, String(ls.total || 0)),
							h("span", { style: S.heroLabel }, "资源总数"),
							h("span", { key: "state", style: { ...S.spacer, ...S.dotRow } },
								h("span", { className: "dshs-dot", style: { background: C.ok } }),
								h("span", { style: S.count }, (ls.ready || 0) + " 就绪"),
								(ls.blocked || 0) > 0
									? h("span", { key: "d", className: "dshs-dot", style: { background: C.warn } })
									: null,
								(ls.blocked || 0) > 0
									? h("button", {
										key: "blk", className: "dshs-ghost",
										style: { ...S.count, ...S.btn(false) },
										onClick: () => openBucket("remote", "blocked"),
									}, ls.blocked + " 有阻塞 →")
									: null)),
						h("div", { key: "grid", style: S.bucketGrid },
							...buckets.map((group) => h("button", {
								key: group.bucket, className: "dshs-cell", style: S.btn(false),
								onClick: () => openBucket(group.bucket, "all"),
							},
								h("span", { style: S.cellNum }, String(group.count),
									h("span", { className: "dshs-dot", style: { background: group.blocked > 0 ? C.warn : C.ok } })),
								h("span", { style: S.cellLabel }, group.label),
								h("span", { style: S.cellNote }, bucketNote(group)))))));

					// 台账：事实与经验各一行；有"失败却没记经验"的库就在这里点出来。
					const records = state.records || null;
					const ledgerRec = records && records.ledger ? records.ledger : null;
					const lessonsRec = records && records.lessons ? records.lessons : null;
					if (ledgerRec || lessonsRec) {
						children.push(h("div", { key: "records", style: S.sec },
							h("div", { className: "dshs-sec" }, h("span", { className: "dshs-secname" }, "台账")),
							ledgerRec
								? h("div", { key: "l", style: { ...S.meta, marginTop: "10px" } },
									"取数台账 " + ledgerRec.records + " 条"
									+ (ledgerRec.failed > 0 ? "（失败 " + ledgerRec.failed + "）" : "")
									+ (ledgerRec.lastAt ? " · 最近 " + String(ledgerRec.lastAt).replace("T", " ").slice(0, 16) : ""))
								: null,
							lessonsRec
								? h("div", { key: "e", style: S.meta },
									"经验库 " + lessonsRec.total + " 条 · 覆盖 " + lessonsRec.sources + " 个库")
								: null,
							(ls.lessonGaps || 0) > 0
								? h("div", { key: "gap", style: S.warn },
									"有 " + ls.lessonGaps + " 条库失败过却没记经验 —— 进「资源」看是哪条，让会话记一条。")
								: null));
					}

					children.push(h("div", { key: "mig", style: S.sec }, renderMigration()));

					if (!state.credentialsAvailable) {
						children.push(h("div", { key: "nocred", style: S.notice(true) }, "本部署未挂载凭据服务，无法保存。"));
					}
					if (state.problems && state.problems.length > 0) {
						children.push(h("div", { key: "problems", style: S.warn },
							"⚠️ 注册表有 " + state.problems.length + " 处问题：" + state.problems.join("；")));
					}
					if (notice) children.push(h("div", { key: "notice", style: S.notice(notice.bad) }, notice.text));

					return h("div", { className: "dshs-root", style: S.wrap },
						h("div", { style: S.titleRow },
							h("span", { style: S.title }, "stash"),
							h("button", {
								key: "new", className: "dshs-ghost",
								style: { ...S.spacer, ...S.btn(false) },
								onClick: openCreate,
							}, "＋ 新建条目")),
						...children,
						renderConfirm(),
						renderRefresh());
				}


				/* ══ L2 清单：按分类分箱的账号卡 ═════════════════════════════════ */

				if (view === "list") {
					const filter = (level1 && level1.filter) || "all";
					const categoryFilter = level1 ? level1.category : null;
					const filterList = [["all", "全部"], ["missing", "未配置"], ["configured", "已配置"], ["unvaulted", "未登记"]];
					const matchField = (field) => filter === "all" ? true
						: filter === "missing" ? field.configured === false
							: filter === "configured" ? field.configured === true
								: true;

					const listChildren = [];

					if (!state.credentialsAvailable) {
						listChildren.push(h("div", { key: "nocred", style: S.notice(true) }, "本部署未挂载凭据服务，无法保存。"));
					}

					if (form && form.mode === "new") {
						listChildren.push(renderForm("新建条目（只登记元数据；值在账号详情里录）"));
					}

					listChildren.push(h("div", { key: "filters", style: S.filters },
						...filterList.map(([id, label]) => {
							const count = id === "all" ? stats.fields
								: id === "missing" ? stats.missing
									: id === "configured" ? stats.configured
										: state.accounts.filter((account) => account.inVault === false).length;
							return h("button", {
								key: id,
								style: S.btn(false),
								onClick: () => setLevel1({ filter: id, category: null }),
							}, (filter === id ? "● " : "") + label + " " + count);
						})));

					if (state.accounts.length === 0) {
						listChildren.push(h("div", { key: "empty", style: S.hint },
							"台账还是空的。用上面的表单登记，或让模型用 stash_credential_add 建条目。"));
					}

					for (const group of stats.byCategory || []) {
						if (categoryFilter && group.category !== categoryFilter) continue;
						// 分箱标题的文本格式保持原样（测试按 '网站账号 (2 个账号 · 4 个字段)' 断言）。
						const headText = group.categoryLabel + " (" + group.accounts + " 个账号 · " + group.fields + " 个字段)";
						const groupChildren = [h("div", { key: "h-" + group.category, style: S.groupHead },
							h("span", { style: S.groupName }, headText),
							h("span", null, "  ·  " + group.configured + "/" + group.fields + " 已配置"))];

						for (const account of state.accounts.filter((item) => item.category === group.category)) {
							const fields = account.fields || [];
							const accountStats = account.stats || {
								fields: fields.length,
								configured: fields.filter((field) => field.configured === true).length,
							};
							const allConfigured = accountStats.fields > 0 && accountStats.configured === accountStats.fields;
							const readonly = isReadonly(account);
							const hits = fields.filter(matchField);
							// 一个字段都不命中的账号卡整张不显示。
							if (hits.length === 0 || (filter === "unvaulted" && account.inVault !== false)) continue;
							// 筛选非「全部」时命中的卡自动展开（用户点筛选就是为了看命中的行）。
							const expanded = filter !== "all"
								? true
								: (open[account.id] === undefined ? !allConfigured : open[account.id] === true);
							// ⚠️ 展开只决定"要不要显示字段行"，**不解除筛选**：
							// 用 fields 覆盖 hits 会让「未配置」视图里冒出已配置的字段行。
							const shown = expanded ? hits : [];

							const cardChildren = [];
							cardChildren.push(h("div", { key: "head", style: S.head },
								h("span", { className: "dshs-dot", style: { background: allConfigured ? C.ok : C.bad } }),
								h("span", { style: S.label }, account.label),
								h("span", { style: S.ref }, account.id),
								h("span", { style: S.pill(allConfigured) }, accountStats.configured + "/" + accountStats.fields + " 已配置"),
								readonly ? h("span", { style: S.tag }, "手写 · 界面只读") : null,
								h("button", {
									className: "dshs-ghost",
									style: { ...S.spacer, ...S.btn(false) },
									onClick: () => setOpen((prev) => ({ ...prev, [account.id]: !expanded })),
								}, expanded ? "收起 ▴" : "展开 ▾")));

							cardChildren.push(h("div", { key: "meta", style: S.meta },
								[
									account.url || null,
									(account.usedBy && account.usedBy.length)
										? "被 " + account.usedBy.join(", ") + " 引用"
										: "未被任何库引用",
									account.notes || null,
								].filter(Boolean).join(" · ")));

							if (account.inVault === false) {
								cardChildren.push(h("div", { key: "notvault", style: S.warn },
									"⚠️ 未登记详情：这个引用名只被库声明，台账里还没有它。点「补登记」补上中文名与类别。"));
							}

							for (const field of shown) {
								cardChildren.push(renderListField(account, field));
							}
							if (expanded && shown.length === 0) {
								cardChildren.push(h("div", { key: "nomatch", style: S.hint }, "这个账号下没有命中当前筛选的字段。"));
							}

							cardChildren.push(h("div", { key: "acts", style: S.form },
								h("button", {
									key: "open", className: "dshs-ghost",
									style: { ...S.spacer, ...S.btn(false) },
									onClick: () => gotoAccount(account),
								}, "打开 →"),
								readonly ? h("span", { style: S.hint }, "写在 " + (state.sourcesFile || "sources.mjs") + "，程序不改写它") : null));

							groupChildren.push(h("div", { key: "a-" + account.id, className: "dshs-card", style: S.card }, ...cardChildren));
						}

						// 该分类下一条都没命中：不渲染空分箱，免得清单被空标题铺满。
						if (groupChildren.length === 1) continue;
						listChildren.push(h("div", { key: "g-" + group.category, style: S.group }, ...groupChildren));
					}

					if (state.problems && state.problems.length > 0) {
						listChildren.push(h("div", { key: "problems", style: S.warn },
							"⚠️ 台账 / 注册表有 " + state.problems.length + " 处问题：" + state.problems.join("；")));
					}
					if (notice) listChildren.push(h("div", { key: "notice", style: S.notice(notice.bad) }, notice.text));

					return h("div", { className: "dshs-root", style: S.wrap },
						renderCrumbs(null, null),
						h("div", { style: S.titleRow },
							h("button", { key: "back", className: "dshs-ghost", style: S.btn(false), onClick: gotoOverview }, "← 概览"),
							h("span", { style: S.title }, "清单"),
							h("button", {
								key: "new", className: "dshs-ghost", style: { ...S.spacer, ...S.btn(false) },
								onClick: () => setForm((prev) => (prev && prev.mode === "new" ? null : { mode: "new", data: emptyForm() })),
							}, form && form.mode === "new" ? "− 收起新建" : "＋ 新建条目")),
						...listChildren,
						renderConfirm(),
						renderRefresh());
				}

				/* ══ L3 账号详情 / 编辑 ═════════════════════════════════════════ */

				const account = (state.accounts || []).find((item) => item.id === accountId) || null;
				if (!account) {
					return h("div", { className: "dshs-root", style: S.wrap },
						renderCrumbs(null, null),
						h("div", { style: S.notice(true) }, "这个账号已经不在台账里了。"),
						h("button", { className: "dshs-ghost", style: S.btn(false), onClick: () => gotoList("all", null) }, "回清单"));
				}

				const readonly = isReadonly(account);
				const detailChildren = [];

				if (account.inVault === false) {
					detailChildren.push(h("div", { key: "notvault", style: S.banner },
						"⚠️ 只被库声明，台账里还没登记。补登记之后才会出现在分类分箱里，也能改中文名与类别。",
						h("div", { key: "act", style: S.form },
							h("button", {
								style: S.btn(false),
								// 只被库声明的引用名走「新建」（POST），不是编辑：台账里还没有这条，PATCH 会 404。
								onClick: () => setForm({ mode: "new", data: {
									...emptyForm(),
									label: account.label,
									category: account.category,
									url: account.url || "",
									usedBy: (account.usedBy || []).slice(),
									fields: account.fields.map((field) => ({ ref: field.ref, label: "", secret: true, inject: "", multiline: false, notes: "" })),
								} }),
							}, "补登记"))));
				}

				detailChildren.push(h("div", { key: "head", style: S.titleRow },
					h("span", { style: S.title }, account.label),
					h("button", {
						key: "edit", className: "dshs-ghost", style: { ...S.spacer, ...S.btn(readonly) }, disabled: readonly,
						onClick: () => setForm({ mode: "edit", data: formFromAccount(account) }),
					}, "编辑信息"),
					h("button", {
						key: "del", className: "dshs-danger", style: S.btn(readonly), disabled: readonly,
						onClick: () => setConfirm({ kind: "delete-account", id: account.id, label: account.label, configured: account.stats ? account.stats.configured : 0 }),
					}, "删除条目")));

				detailChildren.push(h("div", { key: "meta", style: S.meta },
					[
						categoryLabelOf(account.category),
						account.id,
						account.url || null,
						"来源：" + (readonly ? "手写" : "代写"),
					].filter(Boolean).join(" · ")));
				detailChildren.push(h("div", { key: "meta2", style: S.meta },
					[
						(account.usedBy && account.usedBy.length) ? "被 " + account.usedBy.join(", ") + " 引用" : "未被任何库引用",
						account.declaredBy && account.declaredBy.length ? "由 " + account.declaredBy.join(", ") + " 声明" : null,
						account.notes ? "备注：" + account.notes : null,
					].filter(Boolean).join(" · ")));
				if (readonly) {
					detailChildren.push(h("div", { key: "ro", style: S.hint },
						"写在 " + (state.sourcesFile || "sources.mjs") + "，程序不改写它。")); 
				}

				if (form && form.mode === "edit") {
					detailChildren.push(renderForm("编辑条目"));
				} else {
					const fields = account.fields || [];
					detailChildren.push(h("div", { key: "fields", style: S.row },
						h("div", { style: S.groupHead }, h("span", { style: S.groupName }, "字段（" + fields.length + "）")),
						...fields.map((field) => renderDetailField(account, field))));
				}

				if (notice) detailChildren.push(h("div", { key: "notice", style: S.notice(notice.bad) }, notice.text));

				return h("div", { className: "dshs-root", style: S.wrap },
					renderCrumbs(account.label, null),
					...detailChildren,
					renderConfirm(),
					renderRefresh());

				/* ══ 片段：迁移区块 / 表单 / 字段行 / 刷新 ═══════════════════ */

				/** 二次确认（移除值 / 删除条目 / 删字段 / 删掉已配置字段）。 */
				function renderConfirm() {
					if (!confirm) return null;
					const dangerLabel = confirm.kind === "unset" ? "确认移除" : confirm.kind === "drop-fields" ? "确认删除" : "确认删除";
					const text = confirm.kind === "unset"
						? "确定移除 " + confirm.ref + " 在凭据库里的值？此操作不可撤销，值一旦删掉无法恢复。"
						: confirm.kind === "delete-account"
							? "确定删除条目「" + confirm.label + "」？" + (confirm.configured ? "它下面有 " + confirm.configured + " 个字段已在凭据库里有值——删条目不会删值，值会变成没人认领的孤儿。" : "")
							: confirm.kind === "delete-field"
								? "确定从条目里删掉字段 " + confirm.ref + "？值仍会留在凭据库里（变成孤儿）。"
								: confirm.text;
					return h("div", { key: "confirm", className: "dshs-card", style: { ...S.row, ...S.confirm } },
						h("div", null, text),
						h("div", { style: S.form },
							h("button", { className: "dshs-danger", style: S.btn(Boolean(busy)), disabled: Boolean(busy), onClick: runConfirm },
								dangerLabel),
							h("button", { className: "dshs-ghost", style: S.btn(false), onClick: () => setConfirm(null) }, "取消")));
				}

				function renderRefresh() {
					return h("div", { key: "refresh", style: { marginTop: "12px" } },
						h("button", { className: "dshs-ghost", style: S.btn(state.loading), disabled: state.loading, onClick: load },
							state.loading ? "刷新中…" : "刷新状态"));
				}

				/**
				 * 迁移区块：导出 → 在另一台机器导入成功 → 再回来清空。
				 * 顺序反了就没有退路，所以没有导出记录时清空块整块换成一句引导，按钮根本不出现。
				 */
				function renderMigration() {
					const recent = port.recent && port.recent.length > 0 ? port.recent[0] : null;
					const exportChildren = [
						h("div", { key: "h", style: S.head },
							h("span", { style: S.groupName }, "① 导出（这台机器 → 一个包）"),
							recent ? h("span", { style: S.tag }, "上次：" + recent.at + (recent.hasValues ? " · 带了值" : "") + (recent.includesCorpus ? " · 含语料" : "")) : null),
						h("div", { key: "dir", style: S.form },
							h("span", { style: S.hint }, "目标目录"),
							h("input", {
								style: S.input, placeholder: "留空用默认目录",
								value: port.dir, onChange: (event) => setPort((prev) => ({ ...prev, dir: event.target.value })),
							}),
							h("button", {
								className: "dshs-ghost", style: S.btn(false),
								onClick: () => { setPort((prev) => ({ ...prev, dir: prev.defaultExportDir })); copyText(port.defaultExportDir); },
							}, "默认目录"),
							h("button", {
								className: "dshs-ghost", style: S.btn(false),
								onClick: () => copyText(port.dir || port.defaultExportDir),
							}, "复制")),
						h("div", { key: "sw", style: S.form },
							h("label", { style: S.check },
								h("input", {
									type: "checkbox", checked: port.withValues === true,
									onChange: (event) => setPort((prev) => ({ ...prev, withValues: event.target.checked })),
								}), "带上值（明文，等同完整密钥库。只在私有介质上流转。）")),
						h("div", { key: "sw2", style: S.form },
							h("label", { style: S.check },
								h("input", {
									type: "checkbox", checked: port.includeCorpus === true,
									onChange: (event) => setPort((prev) => ({ ...prev, includeCorpus: event.target.checked })),
								}), "含原始语料")),
						h("div", { key: "go", style: S.form },
							h("button", {
								className: "dshs-primary", style: S.btn(port.busy === "export"), disabled: port.busy === "export",
								onClick: runExport,
							}, port.busy === "export" ? "导出中…" : "导 出"))];

					if (port.verify && port.verify.action === "export") {
						exportChildren.push(h("div", { key: "ok", style: S.section },
							h("div", { style: S.meta },
								"导出完成：" + (port.verify.dir || "") + " · " + ((port.verify.files || []).length) + " 个文件"
								+ (port.verify.valueCount !== undefined ? " · " + port.verify.valueCount + " 个值" : "")),
							h("div", { key: "vc", style: S.form },
								h("span", { style: S.hint }, "校验码"),
								h("span", { style: S.code }, String(port.verify.verifyCode || "—"))),
							h("div", { style: S.hint }, "记下它，另一台机器导入成功后会回显同一个码，清空时要输入。"),
							port.verify.report ? h("div", { style: S.report }, String(port.verify.report)) : null,
							h("div", { key: "close", style: S.form },
								h("button", { className: "dshs-ghost", style: S.btn(false), onClick: () => setPort((prev) => ({ ...prev, verify: null })) }, "关闭"))));
					}

					const importChildren = [
						h("div", { key: "h", style: S.head }, h("span", { style: S.groupName }, "② 导入（一个包 → 这台机器）")),
						h("div", { key: "dir", style: S.form },
							h("span", { style: S.hint }, "包目录"),
							h("input", {
								style: S.input, placeholder: "粘贴导出包的目录路径",
								value: port.importDir, onChange: (event) => setPort((prev) => ({ ...prev, importDir: event.target.value })),
							}),
							h("button", { className: "dshs-ghost", style: S.btn(false), onClick: () => copyText(port.importDir) }, "复制")),
						h("div", { key: "dry", style: S.form },
							h("label", { style: S.check },
								h("input", {
									type: "checkbox", checked: port.dryRun === true,
									onChange: (event) => setPort((prev) => ({ ...prev, dryRun: event.target.checked })),
								}), "先预演")),
						h("div", { key: "go", style: S.form },
							h("button", {
								className: "dshs-primary", style: S.btn(port.busy === "import"), disabled: port.busy === "import",
								onClick: runImport,
							}, port.busy === "import" ? "导入中…" : "导 入"))];

					if (port.verify && port.verify.action === "import") {
						importChildren.push(h("div", { key: "ok", style: S.section },
							h("div", { style: S.meta }, "对账校验码：" + (port.verify.verifyCode || "—")
								+ (port.verify.dryRun ? "（预演，未改动任何文件）" : "")),
							port.verify.report ? h("div", { style: S.report }, String(port.verify.report)) : null,
							h("div", { key: "close", style: S.form },
								h("button", { className: "dshs-ghost", style: S.btn(false), onClick: () => setPort((prev) => ({ ...prev, verify: null })) }, "关闭"))));
					}

					const wipeChildren = [
						h("div", { key: "h", style: S.head }, h("span", { style: S.groupName }, "③ 清空（这台机器 → 不留痕迹）")),
					];
					if (!port.hasExportRecord) {
						// 按钮**照常渲染但禁用**，旁边写明为什么。
						// 早先是整块换成一行文字、按钮根本不出现——那样页面是干净了，
						// 但人会以为"这功能没做"。控件看得见、灰着、有理由，才说得过去。
						wipeChildren.push(h("div", { key: "warn", style: S.steps },
							"⚠ 不可撤销。清空前必须先在另一台机器导入成功。"));
						wipeChildren.push(h("div", { key: "go", style: S.form },
							h("button", {
								style: S.btn(true), disabled: true,
								title: "本机还没有导出记录",
							}, "查看将删除什么"),
							h("span", { key: "why", style: S.hint },
								"本机还没有导出记录——先做一次导出，并在另一台机器导入成功，清空才会开放。")));
					} else {
						wipeChildren.push(h("div", { key: "warn", style: S.steps },
							"⚠ 不可撤销。清空前必须先在另一台机器导入成功。"));
						wipeChildren.push(h("div", { key: "corpus", style: S.form },
							h("label", { style: S.check },
								h("input", {
									type: "checkbox", checked: port.includeCorpusWipe === true,
									onChange: (event) => setPort((prev) => ({ ...prev, includeCorpusWipe: event.target.checked })),
								}), "连原始语料一起删")));
						wipeChildren.push(h("div", { key: "go", style: S.form },
							h("button", {
								style: S.btn(port.busy === "plan"), disabled: port.busy === "plan",
								onClick: runPlanWipe,
							}, port.busy === "plan" ? "读取清单…" : "查看将删除什么")));

						if (port.plan && port.plan.action === "plan-wipe") {
							wipeChildren.push(h("div", { key: "plan", style: S.section },
								port.plan.report ? h("div", { style: S.report }, String(port.plan.report)) : null,
								h("div", { key: "confirm", style: S.form },
									h("input", {
										type: "password", autoComplete: "off",
										style: S.input,
										placeholder: "输入校验码（在另一台机器导入成功时回显的那个）",
										value: port.wipeConfirm,
										onChange: (event) => setPort((prev) => ({ ...prev, wipeConfirm: event.target.value })),
									}),
									h("button", {
										className: "dshs-danger", style: S.btn(port.busy === "wipe"), disabled: port.busy === "wipe",
										onClick: runWipe,
									}, port.busy === "wipe" ? "执行中…" : "确认清空"),
									h("button", { className: "dshs-ghost", style: S.btn(false), onClick: () => setPort((prev) => ({ ...prev, plan: null, wipeConfirm: "" })) }, "取消"))));
						}
					}
					if (port.verify && port.verify.action === "wipe") {
						wipeChildren.push(h("div", { key: "ok", style: S.section },
							port.verify.report ? h("div", { style: S.report }, String(port.verify.report)) : null,
							h("div", { key: "close", style: S.form },
								h("button", { className: "dshs-ghost", style: S.btn(false), onClick: () => setPort((prev) => ({ ...prev, verify: null })) }, "关闭"))));
					}

					return h("div", { key: "migration", style: { ...S.row, marginTop: "18px" } },
						h("div", { key: "mh", style: S.foldHead },
							h("button", {
								className: "dshs-ghost", style: S.btn(false),
								onClick: () => setPort((prev) => ({ ...prev, open: !prev.open })),
							}, (port.open ? "▾" : "▸") + "  迁移"),
							h("span", { style: S.hint }, "导出 · 导入 · 清空")),
						port.open ? h("div", { key: "mb" },
							h("div", { key: "intro", style: S.hint },
								"工作流：导出 → 在另一台机器导入成功 → 再回来清空。顺序反了就没有退路。"),
							h("div", { key: "e", className: "dshs-card", style: { ...S.card, marginTop: "10px" } }, ...exportChildren),
							h("div", { key: "i", className: "dshs-card", style: S.card }, ...importChildren),
							h("div", { key: "w", className: "dshs-card", style: S.card }, ...wipeChildren)) : null);
				}

				/**
				 * L2 卡片里的字段行：摘要 + 缺什么；输入框就地展开。
				 *
				 * 展开时**列出该账号的所有字段行**（筛选时只列命中的），这样卡片既是摘要
				 * 也能当"缺什么"的清单用；已配置的行只给「贴值」（换/删值留在 L3，
				 * 免得卡片上出现两套同义的按钮）。
				 */
				function renderListField(account, field) {
					const readonly = isReadonly(account);
					const showInput = valueOpen[field.ref] === undefined ? field.configured !== true : valueOpen[field.ref] === true;
					const rowChildren = [h("div", { key: "h", style: S.head },
						h("span", {
							className: "dshs-dot",
							style: { background: field.configured === true ? C.ok : field.configured === false ? C.bad : C.idle },
						}),
						h("span", { style: S.fieldLabel }, field.label && field.label !== field.ref ? field.label : field.ref),
						h("span", { style: S.ref }, field.ref),
						h("span", {
							style: { color: field.configured === true ? C.ok : C.text2, fontSize: TYPE.meta },
						}, statusText(field)),
						field.inject ? h("span", { style: S.meta }, "落点 " + field.inject) : null)];

					if (readonly) {
						rowChildren.push(h("div", { key: "ro", style: S.form },
							h("span", { style: S.hint }, "手写条目，值请在「打开」里换。")));
					} else if (showInput) {
						rowChildren.push(renderValueInput(field, { cancel: field.configured === true, label: "贴值" }));
					} else {
						rowChildren.push(h("div", { key: "v", style: S.form },
							h("button", {
								style: S.btn(Boolean(busy)), disabled: Boolean(busy),
								onClick: () => setValueOpen((prev) => ({ ...prev, [field.ref]: true })),
							}, "贴值")));
					}
					return h("div", { key: "f-" + field.ref, className: "dshs-field", style: S.field }, ...rowChildren);
				}

				/** L3 的字段行：已配置的默认收着，点「更换值」才出输入框；移除值二次确认。 */
				function renderDetailField(account, field) {
					const readonly = isReadonly(account);
					const dirty = fieldEdit[field.ref] === true;
					const showInput = dirty || field.configured !== true;
					const rowChildren = [h("div", { key: "h", style: S.head },
						h("span", {
							className: "dshs-dot",
							style: { background: field.configured === true ? C.ok : field.configured === false ? C.bad : C.idle },
						}),
						h("span", { style: S.fieldLabel }, statusText(field)),
						h("span", { style: S.ref }, field.ref),
						field.label && field.label !== field.ref ? h("span", { style: S.meta }, field.label) : null,
						field.secret === false ? h("span", { style: S.tag }, "非机密") : null,
						field.multiline ? h("span", { style: S.tag }, "多行值") : null)];

					if (field.inject) rowChildren.push(h("div", { key: "i", style: S.meta }, "落点 " + field.inject));
					if (field.notes) rowChildren.push(h("div", { key: "n", style: S.meta }, field.notes));

					if (showInput) {
						rowChildren.push(renderValueInput(field, { cancel: dirty, label: field.configured === true ? "更换值" : "贴值" }));
					} else {
						rowChildren.push(h("div", { key: "v", style: S.form },
							h("button", {
								style: S.btn(Boolean(busy) || field.writable === false || readonly),
								disabled: Boolean(busy) || field.writable === false || readonly,
								onClick: () => setFieldEdit((prev) => ({ ...prev, [field.ref]: true })),
							}, "更换值"),
							field.configured === true
								? h("button", {
									className: "dshs-danger",
									style: S.btn(Boolean(busy) || field.writable === false || readonly),
									disabled: Boolean(busy) || field.writable === false || readonly,
									onClick: () => setConfirm({ kind: "unset", ref: field.ref }),
								}, "移除值")
								: null));
					}
					return h("div", { key: "f-" + field.ref, className: "dshs-field", style: S.field }, ...rowChildren);
				}

				/** 值输入框（L2 / L3 共用）。值永远不回显，清空后也不回填。 */
				function renderValueInput(field, options) {
					const valueProps = {
						style: field.multiline ? S.area : S.input,
						placeholder: field.configured === true ? "已配置 · 粘贴新值以覆盖（留空不会清掉旧值）…" : "粘贴值…",
						value: drafts[field.ref] || "",
						onChange: (event) => setDrafts((prev) => ({ ...prev, [field.ref]: event.target.value })),
						onKeyDown: (event) => { if (event.key === "Enter" && !field.multiline) saveValue(field); },
					};
					return h("div", { key: "v", style: S.form },
						field.multiline
							? h("textarea", { ...valueProps, rows: 3 })
							: h("input", { ...valueProps, type: "password", autoComplete: "off" }),
						h("button", {
							className: "dshs-primary",
							style: S.btn(Boolean(busy) || field.writable === false),
							disabled: Boolean(busy) || field.writable === false,
							onClick: () => saveValue(field),
						}, busy === field.ref ? "保存中…" : "保存"),
						options && options.cancel
							? h("button", {
								className: "dshs-ghost", style: S.btn(false),
								onClick: () => {
									setValueOpen((prev) => ({ ...prev, [field.ref]: false }));
									setFieldEdit((prev) => ({ ...prev, [field.ref]: false }));
								},
							}, "取消")
							: null);
				}

				/* ── 表单：新建与编辑共用同一张字段表 ─────────────────────────── */

				function renderForm(label) {
					const data = form.data;
					const rowChildren = [];
					rowChildren.push(h("div", { key: "base", style: S.head },
						data.id || form.mode === "edit"
							? h("span", { style: S.ref }, "id: " + (data.id || "（自动）"))
							: h("input", {
								style: S.input, placeholder: "账号 id（可选，如 bid_portal）",
								value: data.id,
								onChange: (event) => patchForm({ id: event.target.value }),
							}),
						h("input", {
							style: S.input, placeholder: "中文名，如 某招标网站",
							value: data.label,
							onChange: (event) => patchForm({ label: event.target.value }),
						})));
					rowChildren.push(h("div", { key: "cat", style: S.form },
						h("select", {
							style: S.input, value: data.category,
							onChange: (event) => patchForm({ category: event.target.value }),
						}, ...((state.categories && state.categories.length > 0)
							? state.categories
							: [{ id: "site", label: "网站账号" }, { id: "api", label: "API 密钥" }, { id: "database", label: "数据库" }, { id: "token", label: "令牌" }, { id: "mcp", label: "MCP / 智能体服务" }, { id: "other", label: "其他" }])
							.map((c) => h("option", { key: c.id, value: c.id }, c.label))),
						h("input", {
							style: S.input, placeholder: "网址 / 端点（可选）",
							value: data.url,
							onChange: (event) => patchForm({ url: event.target.value }),
						})));
					// 「被哪些库使用」收进「高级」：它是**可选**的补充，不是必填项，
					// 一屏十来个复选框会让人以为必须逐条勾。库里写了 credentials 的，
					// 系统自己就认得出来（declaredBy），这里只补"库里没写、但确实用它"的情况。
					if (state.libraries.length > 0) {
						rowChildren.push(h("button", {
							key: "adv-usedby",
							className: "dshs-ghost",
							style: S.btn(false),
							onClick: () => patchForm({ showUsedBy: !data.showUsedBy }),
						}, (data.showUsedBy ? "▾ " : "▸ ") + "高级：这条账号还给哪些库用（可选）"));
						if (data.showUsedBy) {
							rowChildren.push(h("div", { key: "usedby", style: S.form },
								h("span", { style: S.hint },
									"只补「库里没声明、但确实用它」的情况——例如钥匙写进 $DSH_HOME/.env 后由某个 MCP 行读取。库里写了 credentials 的不用勾。"),
								...state.libraries.map((lib) => h("label", { key: lib.id, style: S.check },
									h("input", {
										type: "checkbox",
										checked: data.usedBy.includes(lib.id),
										onChange: () => toggleUsedBy(lib.id),
									}), lib.name || lib.id))));
						}
					}
					rowChildren.push(h("textarea", {
						key: "notes", style: S.area, rows: 2,
						placeholder: "非机密提示（可选），如：用读者卡手机号登录。绝不要写口令。",
						value: data.notes,
						onChange: (event) => patchForm({ notes: event.target.value }),
					}));
					rowChildren.push(h("div", { key: "fhint", style: S.hint },
						"字段表：每个字段 = 一个引用名 = 凭据库里的一条值；inject 是值该注入到哪里（env:FOO_API_KEY / header:Authorization）。"));
					data.fields.forEach((field, index) => {
						rowChildren.push(h("div", { key: "f" + index, style: S.field },
							h("div", { style: S.form },
								h("input", {
									style: S.input, placeholder: "引用名（全大写），如 BID_PORTAL_PASSWORD",
									value: field.ref,
									onChange: (event) => patchField(index, { ref: event.target.value }),
								}),
								h("input", {
									style: S.input, placeholder: "显示名，如 密码",
									value: field.label,
									onChange: (event) => patchField(index, { label: event.target.value }),
								})),
							h("div", { style: S.form },
								h("label", { style: S.check },
									h("input", {
										type: "checkbox", checked: field.secret !== false,
										onChange: (event) => patchField(index, { secret: event.target.checked }),
									}), "机密"),
								h("label", { style: S.check },
									h("input", {
										type: "checkbox", checked: field.multiline === true,
										onChange: (event) => patchField(index, { multiline: event.target.checked }),
									}), "多行值"),
								h("input", {
									style: S.input, placeholder: "注入点（可选），如 env:FOO_API_KEY / header:Authorization",
									value: field.inject,
									onChange: (event) => patchField(index, { inject: event.target.value }),
								}),
								h("button", { className: "dshs-danger", style: S.btn(false), onClick: () => removeFieldRow(index) }, "删掉这个字段")),
							h("input", {
								style: S.input,
								placeholder: "字段备注（可选，非机密），如：每 90 天过期 / 半角感叹号版本",
								value: field.notes || "",
								onChange: (event) => patchField(index, { notes: event.target.value }),
							})));
					});
					rowChildren.push(h("div", { key: "fadd", style: S.form },
						h("button", { className: "dshs-ghost", style: S.btn(false), onClick: addFieldRow }, "＋ 加一个字段")));
					rowChildren.push(h("div", { key: "submit", style: S.form },
						h("button", {
							className: "dshs-primary",
							style: S.btn(busy === "__new__" || busy === data.id),
							disabled: busy === "__new__" || busy === data.id,
							onClick: () => submitForm(false),
						}, form.mode === "edit" ? "保存修改" : "创建"),
						h("button", { className: "dshs-ghost", style: S.btn(false), onClick: () => setForm(null) }, "取消")));
					return h("div", { key: "form", style: S.row },
						h("div", { style: S.groupHead }, h("span", { style: S.groupName }, label)),
						...rowChildren);
				}
			}
			return StashCredentials;
		};

		/**
		 * 「文库」视图：把注册表里的库列出来给人看——**同一个 stash 面板内的一层**，
		 * 不是并列的第二个设置页。从概览的「已登记的库 N 条」那一行点进来，回退走「← 概览」。
		 *
		 * 为什么要有它：注册表原来只对**模型**可见（stash_catalog / /stash 命令），
		 * 「我登记了哪些库」这个人问的问题在面板上没有答案。
		 *
		 * 本视图**不持有任何 hook、也不自己发请求**：数据与筛选状态都由外层页面持有、
		 * 通过 props 传入，因此它是纯渲染——切层不会有 hook 顺序问题，测试也能直接断言。
		 * 只读：登记与取数仍走 Model Tool、/stash 命令与两个 json 文件。
		 * libraries 若是旧的 {id,name} 形状（host 半边还没重载），降级成只显示 id 与名称，不报错。
		 */
		const createLibrariesView = () => {

			const fmtTime = (iso) => {
				if (typeof iso !== "string" || !iso) return "";
				try { return new Date(iso).toLocaleString(); } catch { return iso; }
			};
			/** 行上的时间够用就好：2026-09-28T11:17 → 9/28 11:17（省下十来个字符，行才不折）。 */
			const fmtShort = (iso) => {
				if (typeof iso !== 'string' || !iso) return '';
				const d = new Date(iso);
				if (Number.isNaN(d.getTime())) return iso;
				const p2 = (n) => String(n).padStart(2, '0');
				return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
			};
			const fmtBytes = (n) => {
				if (typeof n !== "number" || !Number.isFinite(n)) return "";
				if (n < 1024) return n + " B";
				if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
				return (n / 1024 / 1024).toFixed(1) + " MB";
			};
			const dotColor = (configured) => (configured === true ? C.ok : configured === false ? C.warn : C.idle);

			/** 旧形状 / 缺字段一律补默认值：面板不因为 host 版本旧就白屏。 */
			const normalize = (lib) => ({
				id: String(lib?.id ?? ""),
				name: typeof lib?.name === "string" && lib.name ? lib.name : String(lib?.id ?? ""),
				kind: lib?.kind ?? null,
				kindLabel: lib?.kindLabel ?? "库",
				handlerLabel: lib?.handlerLabel ?? null,
				// 分类学字段（DESIGN-taxonomy.md）：host 给就用它的，没给就按 kind 退化。
				form: lib?.form ?? lib?.kind ?? "unknown",
				formLabel: lib?.formLabel ?? lib?.handlerLabel ?? lib?.kindLabel ?? "库",
				channel: lib?.channel ?? (lib?.kind === "files" ? "files" : "net"),
				channelLabel: lib?.channelLabel ?? (lib?.kind === "files" ? "文件系统" : "网络套接字"),
				accessMode: lib?.accessMode ?? (lib?.kind === "mcp" ? "external" : lib?.kind === "files" ? "files" : "fetch"),
				server: lib?.server ?? null,
				transport: lib?.transport ?? null,
				tools: typeof lib?.tools === "string" ? lib.tools : "",
				originLabel: lib?.originLabel ?? null,
				origin: lib?.origin ?? "local",
				request: lib?.request ?? null,
				bucketOverridden: lib?.bucketOverridden === true,
				accessLabel: lib?.accessLabel ?? "未声明",
				ready: lib?.ready !== false,
				blockers: Array.isArray(lib?.blockers) ? lib.blockers : [],
				summary: typeof lib?.summary === "string" ? lib.summary : "",
				coverage: typeof lib?.coverage === "string" ? lib.coverage : "",
				boundary: typeof lib?.boundary === "string" ? lib.boundary : "",
				actions: Array.isArray(lib?.actions) ? lib.actions : [],
				notesCount: Number.isFinite(lib?.notesCount) ? lib.notesCount : 0,
				credentials: Array.isArray(lib?.credentials) ? lib.credentials : [],
				paths: Array.isArray(lib?.paths) ? lib.paths : [],
				lessons: Number.isFinite(lib?.lessons?.count) ? lib.lessons : { count: 0 },
				usage: lib?.usage ?? null,
				lessonGap: lib?.lessonGap === true,
				degraded: lib?.kind === undefined || lib?.kind === null,
			});

			function StashLibraries(props) {
				const {
					bucket, bucketLabel, libraries, accounts, problems, sourcesFile, localFile,
					filter, setFilter, query, setQuery, open, setOpen, onBack, onReload, onOpenAccount, onOpenLedger,
					acctOpen, setAcctOpen, acctFilter, setAcctFilter,
					notice,
					deleteConfirm, onCancelDelete, onConfirmDelete, onEditResource, onDeleteResource,
				} = props;
				// 形状与原来自带 state 的版本保持一致，下面整段渲染代码因此一行都不用改。
				const state = {
					libraries: libraries || [],
					stats: null,
					problems: problems || [],
					sourcesFile: sourcesFile || null,
					localFile: localFile || null,
				};

				const libs = (state.libraries || []).map(normalize);
				// 这一层的数字只算这一类自己的（host 的 libraryStats 是全局的，这里不用它）。
				const stats = deriveLibraryStats(libs, null);

				const needle = query.trim().toLowerCase();
				const visible = libs.filter((lib) => {
					if (filter === "ready" && !lib.ready) return false;
					if (filter === "blocked" && lib.ready) return false;
					if (!needle) return true;
					return [lib.id, lib.name, lib.summary, lib.coverage, lib.accessLabel, lib.formLabel, lib.server ?? "", lib.tools]
						.join(" ").toLowerCase().includes(needle);
				});

				// 筛选：这一层已经只装一类东西了，所以按**状态**收窄就够（形态写在卡片上）。
				const chips = [
					{ id: "all", label: "全部", count: stats.total },
					{ id: "ready", label: "就绪", count: stats.ready },
					{ id: "blocked", label: "有阻塞", count: stats.blocked },
				];

				// 删除的二次确认。它不像清空整库那样不可逆，所以只要一次确认、不用输 id。
				const renderDeleteConfirmCard = () => {
					const target = deleteConfirm;
					if (!target) return null;
					return h("div", { key: "delconfirm", className: "dshs-card", style: { ...S.card, borderColor: C.warn } },
						h("div", { style: { fontWeight: 600 } }, "确认删除 " + target.id + "？"),
						h("div", { style: S.meta }, "删除的是这条登记（取数描述、摘要、备注、边界一并去掉）。"),
						h("div", { style: S.meta },
							"取数台账不会删（只追加不删）；"
							+ (target.lessonCount > 0
								? "该库有 " + target.lessonCount + " 条经验，删后界面上不再显示（数据仍在 lessons.json，可用 stash_lesson_list 查）。"
								: "该库没有经验记录。")),
						h("div", { style: { display: "flex", gap: "8px", marginTop: "9px" } },
							h("button", { key: "no", className: "dshs-ghost", style: S.btn(false), onClick: onCancelDelete }, "取消"),
							h("button", { key: "yes", className: "dshs-danger", style: S.btn(false), onClick: onConfirmDelete }, "确认删除")));
				};

				/**
				 * 资源卡：**一行一条**。
				 *
				 * 列表要能被扫，所以行上只留"一眼要看的东西"——名称、id、形态、边界标签、来源，
				 * 右侧是"最近怎么样"（用量 / 卡在哪 / 经验缺口），末尾一个「详情 ▾」。
				 * 描述性内容（摘要、覆盖、禁止边界原文、钥匙落点、命令）全在展开里：
				 * 卡片一度有六行，扫不动列表——那是把详情摊在了列表上。
				 */
				const renderCard = (lib) => {
					const expanded = open[lib.id] === true;
					const toggle = () => setOpen((prev) => ({ ...prev, [lib.id]: !prev[lib.id] }));
					const row = [];

					row.push(h("span", { key: "dot", className: "dshs-dot", style: { background: lib.ready ? C.ok : C.warn } }));
					row.push(h("span", {
						key: "st",
						style: { color: lib.ready ? C.ok : C.warn, fontSize: TYPE.meta, flex: "0 0 auto" },
					}, lib.ready ? "就绪" : "有阻塞"));
					row.push(h("span", {
						key: "n",
						style: { fontSize: TYPE.value, fontWeight: 600, flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
					}, lib.name));
					row.push(h("span", { key: "id", style: { ...S.ref, flex: "0 0 auto" } }, lib.id));
					row.push(h("span", { key: "f", style: { ...S.tag, flex: "0 0 auto" } }, lib.formLabel));
					if (lib.accessLabel) row.push(h("span", { key: "a", style: { ...S.tag, flex: "0 0 auto" } }, lib.accessLabel));
					row.push(h("span", { key: "o", style: { ...S.tag, flex: "0 0 auto" } }, lib.origin === "handwritten" ? "手写" : "代写"));
					if (lib.accessMode === "external") row.push(h("span", { key: "x", style: { ...S.tag, flex: "0 0 auto" } }, "引用型"));

					// 右侧那一串是"更新信息"：坏在哪 / 用了几次 / 最近什么时候 / 有没有经验。
					// 阻塞时**仍然给用量**——"最近取过没、失败几次"正是要一眼看到的东西。
					const tail = [];
					if (!lib.ready) {
						tail.push(lib.blockers[0] + (lib.blockers.length > 1 ? "（共 " + lib.blockers.length + " 项）" : ""));
					}
					if (lib.usage && lib.usage.calls > 0) {
						tail.push("用过 " + lib.usage.calls + " 次"
							+ (lib.usage.failures > 0 ? "（失败 " + lib.usage.failures + "）" : "")
							+ (lib.usage.lastAt ? " · " + fmtShort(lib.usage.lastAt) : ""));
					} else if (lib.ready) {
						tail.push("还没取过数");
					}
					if (lib.lessons.count > 0) tail.push("经验 " + lib.lessons.count + " 条");
					if (lib.lessonGap) tail.push("⚠ 失败过未记经验");
					// 一行装不下就**截断成「…」**（鼠标停上去有完整文本），而不是折到第二行——
					// 折行会把列表的节奏打乱，扫读时反而更慢。
					row.push(h("span", {
						key: "t",
						title: tail.join(" · "),
						style: {
							...S.count, marginLeft: "auto", textAlign: "right",
							flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
						},
					}, tail.join(" · ")));
					row.push(h("span", {
						key: "caret", style: { color: C.text2, fontSize: TYPE.meta, flex: "0 0 auto" },
					}, expanded ? "▴" : "▾"));

					const children = [h("div", {
						key: "row", className: "dshs-rowbtn",
						title: "点这一行看详情",
						style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "nowrap", overflow: "hidden", cursor: "pointer" },
						onClick: toggle,
					}, ...row)];

					if (expanded) {
						const detail = [];
						if (lib.summary) detail.push(h("div", { key: "sum", style: { lineHeight: 1.7 } }, lib.summary));
						if (lib.coverage) detail.push(h("div", { key: "cov", style: S.meta }, "覆盖：" + lib.coverage));
						if (lib.accessMode === "external") {
							detail.push(h("div", { key: "ext", style: S.meta },
								"🔗 引用型：不经 stash 取数 · 服务名 " + (lib.server || "<server>") + " · 用 mcp__" + (lib.server || "<server>") + "__<tool> 直连"
								+ (lib.transport ? " · 承载 " + lib.transport : "")
								+ (lib.tools ? " · " + lib.tools : "")
								+ "（调用不进取数台账）"));
						}
						if (lib.boundary) detail.push(h("div", { key: "bd", style: S.meta }, "禁止边界：" + lib.boundary));
						if (lib.actions.length > 0) {
							detail.push(h("div", { key: "ac", style: S.meta }, "动作：" + lib.actions.map((item) => item.name).join(" / ")));
						}
						for (const field of lib.credentials) {
							detail.push(h("div", {
								key: "c:" + field.ref,
								style: { display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap", marginTop: "3px" },
							},
								h("span", { className: "dshs-dot", style: { background: dotColor(field.configured) } }),
								h("span", { style: S.ref }, field.ref),
								h("span", { style: S.meta }, field.configured === true ? "已配置"
									: field.configured === false ? "未配置" : "状态未知"),
								field.inject ? h("span", { style: S.meta }, "落点 " + field.inject) : null));
						}
						if (!lib.ready) detail.push(h("div", { key: "block", style: S.warn }, "卡在哪：" + lib.blockers.join("；")));
						detail.push(...lib.paths.map((item) => h("div", {
							key: "p:" + item.path,
							style: S.meta,
						}, (item.exists ? "📄 " : "⛔ ") + item.path
							+ (item.exists ? (typeof item.bytes === "number" ? "  " + fmtBytes(item.bytes) : "") : "  （不存在）"))));
						if (lib.notesCount > 0) {
							detail.push(h("div", { key: "nt", style: S.meta },
								"注意事项 " + lib.notesCount + " 条 · 用 stash_catalog id=\"" + lib.id + "\" 看全文"));
						}
						detail.push(h("div", { key: "raw", style: S.meta },
							lib.accessMode === "external"
								? "取数：不经 stash（用 mcp__" + (lib.server || "<server>") + "__<tool>）· 登记：sources.mjs / stash_source_add"
								: lib.accessMode === "files"
									? "用法：stash_files 检索 + read · 登记：sources.mjs / stash_source_add"
									: "取数：stash_fetch source=\"" + lib.id + "\" · 体检：stash_doctor"));
						// 改与删：只对**代写**条目开放。手写文件由你维护，程序永不改写它。
						const editable = lib.origin !== "handwritten";
						detail.push(h("div", { key: "actions", style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginTop: "9px" } },
							editable && onEditResource
								? h("button", { key: "edit", className: "dshs-ghost", style: S.btn(false), onClick: () => onEditResource(lib) }, "编辑")
								: null,
							editable && onDeleteResource
								? h("button", { key: "del", className: "dshs-danger", style: S.btn(false), onClick: () => onDeleteResource(lib) }, "删除")
								: null,
							h("span", { key: "note", style: S.meta },
								editable
									? "写在 sources.local.json（代写，可改可删）"
									: "写在 sources.mjs（手写），程序不改写它")));
						if (lib.lessonGap) {
							detail.push(h("div", { key: "gap", style: S.warn },
								"失败过却没记经验 —— 让会话记一条（stash_lesson_add source=\"" + lib.id + "\"）。"));
						}
						children.push(h("div", { key: "detail", style: S.section }, ...detail));
					}

					return h("div", { key: "lib:" + lib.id, className: "dshs-card", style: S.card }, ...children);
				};


				// 清单按大类分组（物理通道），让"这条库走哪条通道"一眼可见；
				// 筛选器与搜索只在形态/状态上收窄，分类分组始终保留。
				const body = [];

				// 账号块：**钥匙跟着它服务的资源走**。所以哪一类里有资源用到钥匙，账号就在那一类里出现。
				// 今天全部落在「远端接口」；将来本机服务/本机文件需要 token、口令时，它们也会各自出现。
				if ((accounts || []).length > 0) {
					// 搜索**一个框管两边**（账号 + 资源）：面板里两个搜索栏，既浪费又让人分不清哪个管哪块。
					const needleAcct = String(query || "").trim().toLowerCase();
					const allAccounts = accounts || [];
					const missingOf = (account) => (account.fields ?? []).filter((field) => field.configured === false).length;
					// 状态筛选用与资源块**同一个套路**（一个下拉），这样两个二级块才同构。
					const shown = allAccounts.filter((account) => {
						if (acctFilter === "ready" && missingOf(account) > 0) return false;
						if (acctFilter === "missing" && missingOf(account) === 0) return false;
						if (!needleAcct) return true;
						return [account.label, account.id, account.url, ...(account.fields ?? []).map((field) => field.ref)]
							.join(" ").toLowerCase().includes(needleAcct);
					});
					const filtered = Boolean(needleAcct) || acctFilter !== "all";
					const collapsed = !acctOpen && shown.length > 4;
					const visibleAccounts = collapsed ? shown.slice(0, 4) : shown;
					body.push(h("div", { key: "acct-head", style: S.groupHead },
						h("span", { style: S.groupName }, "账号"),
						h("span", { style: S.spacer }, filtered
							? "命中 " + shown.length + " / " + allAccounts.length
							: allAccounts.length + " 个 · " + allAccounts.reduce((sum, account) => sum + (account.fields?.length ?? 0), 0) + " 把钥匙"
								+ (() => {
									const miss = allAccounts.flatMap((account) => account.fields ?? []).filter((field) => field.configured === false).length;
									return miss > 0 ? " · " + miss + " 把未配置" : " · 已配置";
								})()),
						h("select", {
							key: "acct-filter",
							className: "dshs-select",
							style: { flex: "0 0 auto", width: "auto" },
							value: acctFilter,
							onChange: (event) => setAcctFilter && setAcctFilter(event && event.target ? event.target.value : "all"),
						},
							h("option", { key: "all", value: "all" }, "全部"),
							h("option", { key: "ready", value: "ready" }, "已配置"),
							h("option", { key: "missing", value: "missing" }, "有未配置"))));
					if (shown.length === 0) {
						body.push(h("div", { key: "acct-none", style: S.hint }, "没有匹配的账号。"));
					}
					body.push(...visibleAccounts.map((account) => {
						const fields = account.fields ?? [];
						const missing = fields.filter((field) => field.configured === false).length;
						// 账号也**一行一条**：字段级细节（每个引用名、落点）进账号详情——
						// 那里本来就是贴值的地方，列表上只需要"N 把钥匙、几把没配"。
						return h("div", {
							key: "acct:" + account.id, className: "dshs-card", style: { ...S.card, padding: "8px 12px" },
							title: "点这一行看账号详情（贴值 / 换值 / 删值）",
							onClick: onOpenAccount ? () => onOpenAccount(account.id) : undefined,
						},
							h("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "nowrap", overflow: "hidden", cursor: onOpenAccount ? "pointer" : "default" } },
								h("span", { className: "dshs-dot", style: { background: missing === 0 ? C.ok : C.warn, flex: "0 0 auto" } }),
								h("span", {
									style: { fontSize: TYPE.value, fontWeight: 600, flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								}, account.label),
								h("span", { style: { ...S.tag, flex: "0 0 auto" } }, account.categoryLabel ?? account.category),
								h("span", { style: { ...S.ref, flex: "0 0 auto" } }, account.id),
								h("span", {
									key: "tail",
									style: {
										...S.count, marginLeft: "auto", textAlign: "right",
										flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
									},
								}, fields.length + " 把钥匙" + (missing > 0 ? " · " + missing + " 把未配置" : " · 已配置")),
								h("span", { key: "caret", style: { color: C.text2, fontSize: TYPE.meta, flex: "0 0 auto" } }, "›")));
					}));
					if (collapsed) {
						body.push(h("button", {
							key: "more-acct", className: "dshs-ghost", style: { ...S.btn(false), marginTop: "4px" },
							onClick: () => setAcctOpen && setAcctOpen(true),
						}, "▸ 还有 " + (shown.length - 4) + " 个账号（点开）"));
					} else if (!collapsed && shown.length > 4 && setAcctOpen) {
						body.push(h("button", {
							key: "less-acct", className: "dshs-ghost", style: { ...S.btn(false), marginTop: "4px" },
							onClick: () => setAcctOpen(false),
						}, "▴ 收起"));
					}
				}

				if (deleteConfirm) body.push(renderDeleteConfirmCard());
				if (notice) body.push(h("div", { key: "notice", style: S.notice(notice.bad) }, notice.text));

				if (libs.length === 0) {
					body.push(h("div", { key: "empty", style: S.hint },
						"这一类里还没有资源。回首页点「＋ 新建条目 → 资源」登记，或直接写 " + (state.sourcesFile || "sources.mjs") + "。"));
				} else if (visible.length === 0) {
					body.push(h("div", { key: "nomatch", style: S.hint }, "没有命中当前筛选的资源。"));
				} else {
					body.push(h("div", { key: "res-head", style: S.groupHead },
						h("span", { style: S.groupName }, "资源"),
						// 资源块的数字**就写在这里、只出现一次**——与账号块同构：
						// `名称  自身的数字  动作`。筛选与搜索生效时改报命中数（那是新信息）。
						h("span", { style: S.spacer }, (needle || filter !== "all")
							? "命中 " + visible.length + " / " + libs.length
							: libs.length + " 条"
								+ " · " + stats.ready + " 就绪"
								+ (stats.blocked > 0 ? " · " + stats.blocked + " 有阻塞" : "")),
						// 筛选收成一个下拉：一排 chip 既冗余（数字已在上面），又白占一行。
						h("select", {
							key: "filter",
							className: "dshs-select",
							style: { flex: "0 0 auto", width: "auto" },
							value: filter,
							onChange: (event) => setFilter(event && event.target ? event.target.value : "all"),
						},
							...chips.map((chip) => h("option", { key: chip.id, value: chip.id }, chip.label)))));
					body.push(...visible.map(renderCard));
				}

				return h("div", { className: "dshs-root", style: S.wrap },
					h("div", { style: S.titleRow },
						h("span", { style: S.title }, bucketLabel || "资源"),
						h("button", { key: "back", className: "dshs-ghost", style: { ...S.spacer, ...S.btn(false) }, onClick: onBack }, "← 概览"),
						h("button", { key: "reload", className: "dshs-ghost", style: S.btn(false), onClick: onReload }, "刷新")),
					// 类层不再放大数字：数字归到两个块各自的标题行（账号一行、资源一行），
					// 否则同一组数字会在这一层出现两次——上一版就是这么被指出来的。
					// 一个搜索框管两边：账号与资源。
					h("div", { style: S.filters },
						h("input", {
							key: "q",
							style: { ...S.input, flex: "1 1 100%" },
							placeholder: "搜索账号 / 资源：账号名、网址、引用名、id、名称、摘要",
							value: query,
							onChange: (event) => setQuery(event && event.target ? event.target.value : ""),
						})),
					state.problems.length > 0
						? h("div", { key: "problems", style: S.warn }, "⚠️ 注册表有 " + state.problems.length + " 处问题：" + state.problems.join("；"))
						: null,
					...body,
					h("div", { key: "foot", style: { ...S.meta, marginTop: "14px" } },
						"本层只读。登记改 " + (state.sourcesFile || "sources.mjs")
						+ (state.localFile ? " / " + state.localFile : "") + "；等效命令 /stash。"));
			}

			return StashLibraries;
		};

		// ⚠️ 这里是 Cordis 的「所需服务键」，**不是包名**。
		// 只声明 slots —— 它在客户端服务目录里确实存在，且是本页注册所必需。
		// 凭据的 remote 命名空间改为点击时惰性获取：声明一个不存在的服务会让 fiber 永远等下去。
		const inject = ["slots"];

		function apply(ctx) {
			// 用 ctx.inject 捕获 remote 命名空间：客户端在 apply 时 ctx.get('remote')
			// 可能还拿不到（host 侧的 webServer 就是栽在这里）。拿不到时下面的惰性策略仍生效。
			let captured = null;
			try {
				if (typeof ctx.inject === "function") {
					ctx.inject(["remote"], (hostCtx) => { captured = hostCtx.remote ?? captured; });
					ctx.inject(["remote.credentials"], (hostCtx) => {
						captured = hostCtx.remote?.credentials ?? hostCtx["remote.credentials"] ?? captured;
					});
				}
			} catch {
				// 忽略：仍有 resolveCredentials 里的惰性兜底
			}

			/**
			 * 值写完 / 移除之后的镜像通知。**只送引用名，不送值。**
			 * 失败不该影响"值已经存好了"这件事，所以一律吞掉错误。
			 */
			const notifyMirror = async (action, ref) => {
				if (typeof fetch !== "function") return null;
				try {
					const response = await fetch(resolveEndpoint(ENDPOINT_PATH) + "?mirror=" + action, {
						method: "POST",
						headers: { "Content-Type": "application/json", Accept: "application/json" },
						body: JSON.stringify({ ref }),
					});
					const text = await response.text();
					try { return JSON.parse(text); } catch { return null; }
				} catch {
					return null;
				}
			};

			const api = {
				setRef: async (ref, value) => {
					const credentials = resolveCredentials(ctx, captured);
					const result = credentials ? await credentials.set(ref, value) : NO_CREDENTIALS;
					// 值已落到凭据服务；再通知宿主把落点对齐（env:NAME 的字段同步进 .env）。
					// 通知体里**只有引用名，没有值**——值由宿主从凭据服务自己读。
					if (result && result.ok) return { ...result, mirror: await notifyMirror("sync", ref) };
					return result;
				},
				unsetRef: async (ref) => {
					const credentials = resolveCredentials(ctx, captured);
					const result = credentials ? await credentials.unset(ref) : NO_CREDENTIALS;
					return { ...(result || {}), mirror: await notifyMirror("clear", ref) };
				},
			};
			const LibrariesView = createLibrariesView();
			const Section = createSection(api, LibrariesView);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "stash",
				order: 30,
				label: () => "stash",
			}, Section));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
