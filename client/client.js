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

		const S = {
			wrap: { padding: "4px 2px", maxWidth: "860px", lineHeight: 1.6, fontSize: "13px" },
			title: { fontWeight: 600, marginBottom: "6px" },
			stats: {
				display: "flex", gap: "14px", flexWrap: "wrap", alignItems: "baseline",
				padding: "8px 10px", margin: "6px 0 14px",
				border: "1px solid rgba(128,128,128,0.3)", borderRadius: "8px",
			},
			statNum: { fontWeight: 700, fontSize: "15px" },
			group: { marginTop: "14px" },
			groupHead: { fontWeight: 600, opacity: 0.85, marginBottom: "6px" },
			row: {
				border: "1px solid rgba(128,128,128,0.35)", borderRadius: "8px",
				padding: "9px 12px", marginBottom: "8px",
			},
			field: {
				border: "1px solid rgba(128,128,128,0.22)", borderRadius: "6px",
				padding: "6px 9px", margin: "6px 0",
			},
			head: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			label: { fontWeight: 600 },
			fieldLabel: { fontWeight: 600 },
			ref: { fontFamily: "ui-monospace, Consolas, monospace", opacity: 0.8, fontSize: "12px" },
			badge: (ok) => ({
				fontSize: "11px", padding: "1px 7px", borderRadius: "999px",
				border: "1px solid " + (ok === true ? "rgba(46,160,67,0.6)" : ok === false ? "rgba(200,80,80,0.6)" : "rgba(128,128,128,0.5)"),
				color: ok === true ? "rgb(46,160,67)" : ok === false ? "rgb(200,80,80)" : "inherit",
				opacity: ok === null ? 0.7 : 1,
			}),
			meta: { opacity: 0.65, fontSize: "12px", marginTop: "3px" },
			warn: { color: "rgb(200,150,60)", fontSize: "12px", marginTop: "3px" },
			form: { display: "flex", gap: "8px", marginTop: "8px", alignItems: "center", flexWrap: "wrap" },
			input: {
				flex: "1 1 200px", minWidth: "140px", padding: "5px 8px", borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.45)", background: "transparent", color: "inherit", font: "inherit",
			},
			area: {
				width: "100%", minHeight: "64px", padding: "5px 8px", borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.45)", background: "transparent", color: "inherit", font: "inherit",
			},
			check: { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", opacity: 0.9 },
			btn: (disabled) => ({
				padding: "5px 12px", borderRadius: "6px", border: "1px solid rgba(128,128,128,0.45)",
				background: "transparent", color: "inherit", font: "inherit",
				cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
			}),
			hint: { opacity: 0.65, fontSize: "12px" },
			notice: (bad) => ({ marginTop: "10px", fontSize: "12px", color: bad ? "rgb(200,80,80)" : "rgb(46,160,67)" }),
		};

		const statusText = (row) => {
			if (row.configured === true) return "已配置" + (row.writable === false ? "（只读源不可覆盖）" : "");
			if (row.configured === false) return "未配置";
			return "状态未知";
		};

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

		/** 由 apply 传入、闭包持有 ctx 的接口。组件因此不依赖槽位的 inject-props 契约。 */
		const createSection = (api) => {
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

				React.useEffect(() => { load(); }, [load]);

				/* ── 值：只走凭据服务，永不进台账文件、永不回显 ───────────────── */

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
							setNotice({ bad: false, text: field.ref + " 已保存到凭据库（值不会回显）。" });
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
						if (result && result.ok) setNotice({ bad: false, text: ref + " 已从凭据库移除（台账条目保留）。" });
						else setNotice({ bad: true, text: (result && result.error && result.error.message) || "移除被拒绝。" });
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
						setForm(null);
						setNotice({
							bad: false,
							text: editing
								? "已更新「" + body.label + "」的信息。"
								: "已登记「" + body.label + "」" + (body.fields.length > 1 ? "（" + body.fields.length + " 个字段）" : "")
									+ "。未配置的字段可以直接在下面粘贴值。",
						});
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

				/* ── 渲染 ─────────────────────────────────────────────────────── */

				if (state.loading && state.accounts.length === 0) {
					return h("div", { style: S.wrap },
						h("div", null, "正在读取凭据状态…"),
						h("div", { style: S.hint },
							"端点：" + (state.endpoint || resolveEndpoint(ENDPOINT_PATH)),
							h("br"),
							"若停在这里超过 15 秒，说明该请求没有得到响应（已被超时中止）。"));
				}
				if (state.error) {
					return h("div", { style: S.wrap },
						h("div", { style: S.notice(true) }, "读不到凭据状态：" + state.error),
						h("div", { style: S.hint },
							"端点：" + (state.endpoint || resolveEndpoint(ENDPOINT_PATH)) + "（由 dsh-stash 的 host 半边提供）",
							h("br"),
							"HTTP 404 且响应体为空 → 路由未注册；HTTP 401 → 认证问题；被中止 → 请求未得到响应。"),
						h("button", { style: S.btn(false), onClick: load }, "重试"));
				}

				const stats = state.stats || { accounts: state.accounts.length, fields: 0, configured: 0, missing: 0, byCategory: [] };
				const children = [];

				// 统计条 —— 一眼可读
				children.push(h("div", { key: "stats", style: S.stats },
					h("span", { key: "a" }, "账号 ", h("span", { style: S.statNum }, String(stats.accounts))),
					h("span", { key: "f" }, "字段 ", h("span", { style: S.statNum }, String(stats.fields))),
					h("span", { key: "c" }, "✅ 已配置 ", h("span", { style: S.statNum }, String(stats.configured))),
					h("span", { key: "m" }, "❌ 未配置 ", h("span", { style: S.statNum }, String(stats.missing))),
					stats.unknown > 0 ? h("span", { key: "u", style: S.hint }, "❔ 未知 " + stats.unknown) : null));

				children.push(h("div", { key: "hint", style: S.hint },
					"一条 = 一个网站 / API / MCP 服务；字段 = 凭据引用名。",
					"值只能在这里录入，经宿主凭据服务单向写入 —— 界面读不回，也不进入对话或模型上下文。",
					state.localFile ? h("span", null, h("br"), "台账文件：" + state.localFile + "（新建/编辑写这里；手写 " + (state.sourcesFile || "sources.mjs") + " 的条目界面只读）") : null));

				// 新建按钮
				children.push(h("div", { key: "newbtn", style: { margin: "12px 0 2px" } },
					h("button", {
						style: S.btn(false),
						onClick: () => setForm((prev) => (prev && prev.mode === "new" ? null : { mode: "new", data: emptyForm() })),
					}, form && form.mode === "new" ? "− 收起新建" : "＋ 新建钥匙条目")));

				/* 表单：新建与编辑共用同一张字段表 */
				const renderForm = (label) => {
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
								h("button", { style: S.btn(false), onClick: () => removeFieldRow(index) }, "删掉这个字段")),
							h("input", {
								style: S.input,
								placeholder: "字段备注（可选，非机密），如：每 90 天过期 / 半角感叹号版本",
								value: field.notes || "",
								onChange: (event) => patchField(index, { notes: event.target.value }),
							})));
					});
					rowChildren.push(h("div", { key: "fadd", style: S.form },
						h("button", { style: S.btn(false), onClick: addFieldRow }, "＋ 加一个字段")));
					rowChildren.push(h("div", { key: "submit", style: S.form },
						h("button", {
							style: S.btn(busy === "__new__" || busy === data.id),
							disabled: busy === "__new__" || busy === data.id,
							onClick: () => submitForm(false),
						}, form.mode === "edit" ? "保存修改" : "创建"),
						h("button", { style: S.btn(false), onClick: () => setForm(null) }, "取消")));
					return h("div", { key: "form", style: S.row },
						h("div", { style: S.groupHead }, label),
						...rowChildren);
				};

				if (form && form.mode === "new") children.push(renderForm("新建钥匙条目（只登记元数据；值在下面录）"));

				if (!state.credentialsAvailable) {
					children.push(h("div", { key: "nocred", style: S.notice(true) }, "本部署未挂载凭据服务，无法保存。"));
				}

				if (state.accounts.length === 0) {
					children.push(h("div", { key: "empty", style: S.hint }, "台账还是空的。可以用上面的表单登记，或让模型用 stash_credential_add 建条目。"));
				}

				// 二次确认（移除值 / 删除条目 / 删字段）
				if (confirm) {
					children.push(h("div", { key: "confirm", style: S.row },
						h("div", null, confirm.kind === "unset"
							? "确定移除 " + confirm.ref + " 在凭据库里的值？此操作不可撤销，值一旦删掉无法恢复。"
							: confirm.kind === "delete-account"
								? "确定删除条目「" + confirm.label + "」？"+ (confirm.configured ? "它下面有 " + confirm.configured + " 个字段已在凭据库里有值——删条目不会删值，值会变成没人认领的孤儿。" : "")
								: confirm.kind === "delete-field"
									? "确定从条目里删掉字段 " + confirm.ref + "？值仍会留在凭据库里（变成孤儿）。"
									: confirm.text),
						h("div", { style: S.form },
							h("button", { style: S.btn(Boolean(busy)), disabled: Boolean(busy), onClick: runConfirm },
								confirm.kind === "unset" ? "确认移除" : "确认删除"),
							h("button", { style: S.btn(false), onClick: () => setConfirm(null) }, "取消"))));
				}

				// 按类别分组（顺序取自 stats.byCategory，与 host 侧一致）
				for (const group of stats.byCategory || []) {
					const rows = state.accounts.filter((account) => account.category === group.category);
					const groupChildren = [h("div", { key: "h-" + group.category, style: S.groupHead },
						group.categoryLabel + " (" + group.accounts + " 个账号 · " + group.fields + " 个字段)",
						"  ·  " + group.configured + "/" + group.fields + " 已配置")];

					for (const account of rows) {
						const accountStats = account.stats || { fields: account.fields.length, configured: 0 };
						const allConfigured = accountStats.configured === accountStats.fields && accountStats.fields > 0;
						// 默认折叠；有未配置字段的默认展开（下一步就是贴值）
						const expanded = open[account.id] === undefined ? !allConfigured : open[account.id] === true;
						const readonly = account.origin === "handwritten";
						const cardChildren = [];

						cardChildren.push(h("div", { key: "head", style: S.head },
							h("span", { style: S.badge(allConfigured) }, allConfigured ? "✅" : "❌"),
							h("span", { style: S.label }, account.label),
							h("span", { style: S.ref }, account.id),
							h("span", { style: S.badge(allConfigured) }, accountStats.configured + "/" + accountStats.fields + " 已配置"),
							readonly ? h("span", { style: S.badge(null) }, "手写 · 界面只读") : null,
							h("button", {
								style: S.btn(false),
								onClick: () => setOpen((prev) => ({ ...prev, [account.id]: !expanded })),
							}, expanded ? "收起 ▴" : "展开 ▾")));

						cardChildren.push(h("div", { key: "meta", style: S.meta },
							[
								account.url || null,
								(account.usedBy && account.usedBy.length) ? "被 " + account.usedBy.join(", ") + " 引用" : "未被任何库引用",
								account.notes || null,
							].filter(Boolean).join(" · ")));

						if (account.inVault === false) {
							cardChildren.push(h("div", { key: "notvault", style: S.warn },
								"⚠️ 未登记详情：这个引用名只被库声明，台账里还没有它。点「补登记」补上中文名与类别。"));
							cardChildren.push(h("div", { key: "enroll", style: S.form },
								h("button", {
									style: S.btn(false),
									// 只被库声明的引用名走「新建」（POST），不是编辑：
									// 台账里还没有这条，PATCH 会 404。
									onClick: () => setForm({ mode: "new", data: {
										...emptyForm(),
										label: account.label,
										category: account.category,
										url: account.url || "",
										usedBy: (account.usedBy || []).slice(),
										fields: account.fields.map((field) => ({ ref: field.ref, label: "", secret: true, inject: "", multiline: false, notes: "" })),
									} }),
								}, "补登记")));
						}

						if (expanded) {
							for (const field of account.fields) {
								const showInput = valueOpen[field.ref] === undefined ? field.configured !== true : valueOpen[field.ref] === true;
								const fieldChildren = [h("div", { key: "h", style: S.head },
									h("span", { style: S.badge(field.configured) }, field.configured === true ? "✅" : field.configured === false ? "❌" : "❔"),
									h("span", { style: S.fieldLabel }, field.label),
									h("span", { style: S.ref }, field.ref),
									field.secret === false ? h("span", { style: S.badge(null) }, "非机密") : null,
									field.inject ? h("span", { style: S.meta }, "→ " + field.inject) : null,
									field.multiline ? h("span", { style: S.badge(null) }, "多行值") : null,
									h("span", { style: S.badge(field.configured) }, statusText(field)))];

								if (field.notes) fieldChildren.push(h("div", { key: "n", style: S.meta }, field.notes));

								if (showInput) {
									const valueProps = {
										style: field.multiline ? S.area : S.input,
										placeholder: field.configured === true ? "已配置 · 粘贴新值以覆盖（留空不会清掉旧值）…" : "粘贴值…",
										value: drafts[field.ref] || "",
										onChange: (event) => setDrafts((prev) => ({ ...prev, [field.ref]: event.target.value })),
										onKeyDown: (event) => { if (event.key === "Enter" && !field.multiline) saveValue(field); },
									};
									fieldChildren.push(h("div", { key: "v", style: S.form },
										field.multiline
											? h("textarea", { ...valueProps, rows: 3 })
											: h("input", { ...valueProps, type: "password", autoComplete: "off" }),
										h("button", {
											style: S.btn(Boolean(busy) || field.writable === false),
											disabled: Boolean(busy) || field.writable === false,
											onClick: () => saveValue(field),
										}, busy === field.ref ? "保存中…" : "保存"),
										field.configured === true
											? h("button", { style: S.btn(false), onClick: () => setValueOpen((prev) => ({ ...prev, [field.ref]: false })) }, "取消")
											: null));
								} else {
									fieldChildren.push(h("div", { key: "v", style: S.form },
										h("button", {
											style: S.btn(Boolean(busy) || field.writable === false),
											disabled: Boolean(busy) || field.writable === false,
											onClick: () => setValueOpen((prev) => ({ ...prev, [field.ref]: true })),
										}, "更换值"),
										field.configured === true
											? h("button", {
												style: S.btn(Boolean(busy) || field.writable === false),
												disabled: Boolean(busy) || field.writable === false,
												onClick: () => setConfirm({ kind: "unset", ref: field.ref }),
											}, "移除值")
											: null));
								}
								cardChildren.push(h("div", { key: "f-" + field.ref, style: S.field }, ...fieldChildren));
							}

							cardChildren.push(h("div", { key: "acts", style: S.form },
								h("button", {
									style: S.btn(readonly),
									disabled: readonly,
									onClick: () => setForm({ mode: "edit", data: formFromAccount(account) }),
								}, "编辑信息"),
								h("button", {
									style: S.btn(readonly),
									disabled: readonly,
									onClick: () => setConfirm({ kind: "delete-account", id: account.id, label: account.label, configured: accountStats.configured }),
								}, "删除条目"),
								readonly ? h("span", { style: S.hint }, "写在 " + (state.sourcesFile || "sources.mjs") + "，程序不改写它") : null));

							if (form && form.mode === "edit" && form.data.id === account.id) {
								cardChildren.push(renderForm("编辑「" + account.label + "」的信息"));
							}
						}

						groupChildren.push(h("div", { key: "a-" + account.id, style: S.row }, ...cardChildren));
					}

					children.push(h("div", { key: "g-" + group.category, style: S.group }, ...groupChildren));
				}

				if (state.problems && state.problems.length > 0) {
					children.push(h("div", { key: "problems", style: S.warn },
						"⚠️ 台账 / 注册表有 " + state.problems.length + " 处问题：" + state.problems.join("；")));
				}

				if (notice) children.push(h("div", { key: "notice", style: S.notice(notice.bad) }, notice.text));

				children.push(h("div", { key: "refresh", style: { marginTop: "12px" } },
					h("button", { style: S.btn(state.loading), disabled: state.loading, onClick: load },
						state.loading ? "刷新中…" : "刷新状态")));

				return h("div", { style: S.wrap }, h("div", { style: S.title }, "钥匙"), ...children);
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

			const api = {
				setRef: async (ref, value) => {
					const credentials = resolveCredentials(ctx, captured);
					return credentials ? credentials.set(ref, value) : NO_CREDENTIALS;
				},
				unsetRef: async (ref) => {
					const credentials = resolveCredentials(ctx, captured);
					return credentials ? credentials.unset(ref) : NO_CREDENTIALS;
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
