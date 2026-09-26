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
		const STYLESHEET = [
			".dshs-root{color:" + C.text + ";}",
			".dshs-card{background:" + C.layer2 + ";border:1px solid " + C.border + ";border-radius:10px;",
			"margin-bottom:10px;overflow:hidden;transition:border-color .15s ease;}",
			".dshs-card:hover{border-color:" + C.borderStrong + ";}",
			".dshs-field{border-top:1px solid " + C.border + ";padding:11px 0 3px;}",
			".dshs-root button{font:inherit;border-radius:7px;border:1px solid " + C.borderStrong + ";",
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
			".dshs-root input,.dshs-root textarea,.dshs-root select{font:inherit;color:" + C.text + ";",
			"background:" + C.layer1 + ";border:1px solid " + C.borderStrong + ";border-radius:7px;padding:6px 9px;",
			"transition:border-color .12s ease;}",
			".dshs-root input:hover,.dshs-root textarea:hover,.dshs-root select:hover{border-color:" + C.text2 + ";}",
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
			title: { fontSize: "19px", fontWeight: 600, letterSpacing: "-0.01em" },
			spacer: { marginLeft: "auto" },
			crumbRow: { display: "flex", alignItems: "center", gap: "3px", flexWrap: "wrap", marginBottom: "9px" },
			crumbSep: { color: C.text2, fontSize: "12px" },
			stats: { paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid " + C.border },
			// 概览页的总数给足字号：这一页本来就是"一眼看总量"。
			bigNum: { fontSize: "28px", fontWeight: 600, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" },
			bigRow: { display: "flex", alignItems: "baseline", gap: "9px", flexWrap: "wrap" },
			bigLabel: { fontSize: "13px", color: C.text2 },
			bar: {
				height: "4px", borderRadius: "999px", background: C.layer1,
				border: "1px solid " + C.border, overflow: "hidden",
			},
			barFill: (w) => ({ height: "100%", width: w, background: C.brand }),
			section: { borderTop: "1px solid " + C.border, paddingTop: "11px", marginTop: "11px" },
			sectionHead: { fontSize: "12px", color: C.text2, marginBottom: "5px" },
			rowLabel: { fontSize: "13px", fontWeight: 600 },
			rowNote: { fontSize: "12px", color: C.text2, marginTop: "2px" },
			group: { marginTop: "22px" },
			groupHead: {
				display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap",
				paddingBottom: "7px", marginBottom: "9px", borderBottom: "1px solid " + C.border,
				fontSize: "12px", color: C.text2,
			},
			groupName: { fontSize: "13px", fontWeight: 600, color: C.text },
			filters: { display: "flex", gap: "7px", flexWrap: "wrap", marginBottom: "14px" },
			card: { padding: "11px 13px 12px" },
			row: { border: "1px solid " + C.borderStrong, borderRadius: "10px", padding: "9px 12px", marginBottom: "8px" },
			field: {},
			label: { fontWeight: 600, fontSize: "13px" },
			fieldLabel: { fontWeight: 600 },
			ref: { fontFamily: "ui-monospace, Consolas, monospace", color: C.text2, fontSize: "12px" },
			pill: (ok) => ({
				fontSize: "11px", padding: "1px 8px", borderRadius: "999px", lineHeight: 1.7,
				border: "1px solid " + (ok ? C.border : C.borderStrong), color: ok ? C.ok : C.text2,
			}),
			tag: {
				fontSize: "11px", padding: "1px 7px", borderRadius: "999px", lineHeight: 1.7,
				border: "1px solid " + C.border, color: C.text2,
			},
			meta: { color: C.text2, fontSize: "12px", marginTop: "3px" },
			warn: { color: C.warn, fontSize: "12px", marginTop: "4px" },
			banner: {
				border: "1px solid " + C.warn, color: C.warn, borderRadius: "9px",
				padding: "8px 11px", fontSize: "12px", lineHeight: 1.65, marginBottom: "10px",
			},
			form: { display: "flex", gap: "8px", marginTop: "8px", alignItems: "center", flexWrap: "wrap" },
			// input/textarea/select 的边框、背景、focus 态都在样式表里，这里只留布局。
			input: { flex: "1 1 200px", minWidth: "140px" },
			area: { width: "100%", minHeight: "64px" },
			check: { display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: C.text2 },
			btn: (disabled) => (disabled ? { opacity: 0.45 } : {}),
			hint: { color: C.text2, fontSize: "12px", lineHeight: 1.65 },
			notice: (bad) => ({ marginTop: "10px", fontSize: "12px", color: bad ? C.bad : C.ok }),
			confirm: { borderColor: C.bad },
			foldHead: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
			foldCaret: { fontSize: "13px", fontWeight: 600, color: C.text },
			// 结果卡：report 是宿主渲染好的纯文本，必须原样保留换行。
			report: {
				whiteSpace: "pre-wrap", fontFamily: "ui-monospace, Consolas, monospace",
				fontSize: "12px", lineHeight: 1.7, color: C.text, marginTop: "9px",
				background: C.layer1, border: "1px solid " + C.border, borderRadius: "9px", padding: "10px 12px",
			},
			code: {
				fontFamily: "ui-monospace, Consolas, monospace", fontSize: "20px", fontWeight: 600,
				letterSpacing: "0.14em", color: C.brand, fontVariantNumeric: "tabular-nums",
			},
			foldGuide: { color: C.text2, fontSize: "12px", lineHeight: 1.65, marginTop: "8px" },
			steps: { fontSize: "12px", color: C.warn, lineHeight: 1.65, marginBottom: "9px" },
		};

		const statusText = (row) => {
			if (row.configured === true) return "已配置" + (row.writable === false ? "（只读源不可覆盖）" : "");
			if (row.configured === false) return "未配置";
			return "状态未知";
		};

		/** 只读 = 住在手写的 sources.mjs 里，程序不改写它。 */
		const isReadonly = (account) => account.origin === "handwritten";

		const emptyForm = () => ({
			id: "", label: "", category: "site", url: "", notes: "", usedBy: [],
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

		/** 由 apply 传入、闭包持有 ctx 的接口。组件因此不依赖槽位的 inject-props 契约。 */
		const createSection = (api) => {
			// 幂等：只注入一次。组件每次渲染都会调，命中 getElementById 就返回。
			injectStyles();
			function StashCredentials() {
				const [state, setState] = React.useState({
					loading: true, accounts: [], stats: null, problems: [], categories: [], libraries: [],
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
						crumbBtn("k", "钥匙", gotoOverview),
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

				/* ══ L1 概览：一张可点的统计索引 ═════════════════════════════════ */

				if (view === "overview") {
					const byCategory = stats.byCategory || [];
					const vaulted = state.accounts.filter((account) => account.inVault !== false).length;
					const pct = stats.fields > 0 ? Math.round((stats.configured / stats.fields) * 100) : 0;

					const openRow = (key, label, note, onClick) => h("button", {
						key, className: "dshs-rowbtn", style: S.btn(false), onClick,
					},
						h("span", { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
							h("span", { style: S.rowLabel }, label),
							h("span", { style: { ...S.spacer, color: C.text2, fontSize: "12px" } }, note),
							h("span", { className: "dshs-arrow", style: { marginLeft: "10px" } }, "→")));

					const overviewChildren = [];

					overviewChildren.push(h("div", { key: "big", style: S.stats },
						h("div", { style: S.bigRow },
							h("span", { style: S.bigNum }, String(stats.fields || 0)),
							h("span", { style: S.bigLabel }, "把引用名"),
							h("button", {
								key: "all", className: "dshs-ghost", style: { marginLeft: "auto" },
								onClick: () => gotoList("all", null),
							}, "查看全部 →")),
						h("div", { key: "bar", style: { ...S.bar, marginTop: "10px" } },
							h("div", { style: S.barFill(pct + "%") })),
						h("div", { key: "mix", style: { ...S.meta, marginTop: "6px" } },
							stats.configured + " 已配置 · " + stats.missing + " 未配置 · " + pct + "%"
							+ (stats.unknown > 0 ? " · " + stats.unknown + " 状态未知" : ""))));

					overviewChildren.push(h("div", { key: "where", style: S.section },
						h("div", { style: S.sectionHead }, "其中"),
						...byCategory.map((group) => openRow(
							"c-" + group.category,
							group.categoryLabel,
							group.fields + " 把（" + group.accounts + " 个账号）",
							() => gotoList("all", group.category),
						)),
						byCategory.length === 0 ? h("div", { style: S.hint }, "台账还是空的。") : null));

					// 「注意」只在真有未配置时出现；为 0 时整块消失，不写"✓ 全部就绪"。
					if (stats.missing > 0) {
						overviewChildren.push(h("div", { key: "watch", style: S.section },
							h("div", { style: S.sectionHead }, "注意"),
							openRow("m", "未完成配置", stats.missing + " 把", () => gotoList("missing", null))));
					}

					overviewChildren.push(h("div", { key: "foot", style: { ...S.meta, marginTop: "11px" } },
						stats.accounts + " 个账号 · 被 " + state.libraries.length + " 条库引用 · 详情已登记 "
						+ vaulted + "/" + stats.accounts));

					if (state.accounts.length === 0) {
						overviewChildren.push(h("div", { key: "empty", style: S.hint },
							"台账还是空的。点右上角「＋ 新建条目」登记，或让模型用 stash_credential_add 建条目。"));
					}

					if (state.problems && state.problems.length > 0) {
						overviewChildren.push(h("div", { key: "problems", style: S.warn },
							"⚠️ 台账 / 注册表有 " + state.problems.length + " 处问题：" + state.problems.join("；")));
					}

					overviewChildren.push(renderMigration());

					if (!state.credentialsAvailable) {
						overviewChildren.push(h("div", { key: "nocred", style: S.notice(true) }, "本部署未挂载凭据服务，无法保存。"));
					}
					if (notice) overviewChildren.push(h("div", { key: "notice", style: S.notice(notice.bad) }, notice.text));

					return h("div", { className: "dshs-root", style: S.wrap },
						h("div", { style: S.titleRow },
							h("span", { style: S.title }, "钥匙"),
							h("button", {
								key: "new", className: "dshs-ghost", style: { ...S.spacer, ...S.btn(false) },
								onClick: () => { setForm({ mode: "new", data: emptyForm() }); setView("list"); setLevel1({ filter: "all", category: null }); },
							}, "＋ 新建条目")),
						...overviewChildren,
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
							style: { color: field.configured === true ? C.ok : C.text2, fontSize: "12px" },
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
					if (state.libraries.length > 0) {
						rowChildren.push(h("div", { key: "usedby", style: S.form },
							h("span", { style: S.hint }, "被哪些库使用："),
							...state.libraries.map((lib) => h("label", { key: lib.id, style: S.check },
								h("input", {
									type: "checkbox",
									checked: data.usedBy.includes(lib.id),
									onChange: () => toggleUsedBy(lib.id),
								}), lib.name || lib.id))));
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
			const Section = createSection(api);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "stash",
				order: 30,
				label: () => "钥匙",
			}, Section));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
