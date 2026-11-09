window.__ModuleLoader__.load({
	id: "dsh-autonomy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		const inject = ["slots", "sessions"];
		const styles = {
			dock: {
				display: "flex",
				alignItems: "center",
				justifyContent: "flex-end",
				width: "100%",
				minWidth: 0,
				padding: "0 4px",
				boxSizing: "border-box"
			},
			root: {
				display: "inline-flex",
				alignItems: "center",
				height: 26,
				padding: 2,
				boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
				borderRadius: 999,
				background: "var(--dsw-alias-bg-layer-1)",
				flex: "none"
			},
			button: {
				minWidth: 48,
				height: 20,
				padding: "0 9px",
				border: 0,
				borderRadius: 999,
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
				font: "inherit",
				fontSize: 12,
				fontWeight: 500,
				lineHeight: "20px",
				cursor: "pointer",
				transition: "background-color 120ms ease, color 120ms ease, opacity 120ms ease"
			},
			active: {
				background: "var(--dsw-alias-interactive-bg-active)",
				color: "var(--dsw-alias-label-primary)",
				fontWeight: 600
			},
			pending: {
				opacity: .62,
				cursor: "wait"
			},
			error: {
				marginLeft: 6,
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: 11
			}
		};
		/** Always-visible segmented control over the host-folded autonomy projection. */
		function AutonomyToggle({ useProjection, setMode }) {
			const projection = useProjection("autonomy");
			const [submitting, setSubmitting] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const alive = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				alive.current = true;
				return () => {
					alive.current = false;
				};
			}, []);
			if (projection === void 0) return null;
			const selected = projection.mode;
			const choose = (mode) => {
				if (mode === selected || submitting !== null) return;
				setSubmitting(mode);
				setError(null);
				setMode(mode).then((failure) => {
					if (!alive.current) return;
					setSubmitting(null);
					setError(failure);
				}, (reason) => {
					if (!alive.current) return;
					setSubmitting(null);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.dock,
				"data-autonomy-toggle": "",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.root,
					role: "group",
					"aria-label": "Autonomy mode",
					"aria-busy": submitting !== null,
					children: ["chat", "agent"].map((mode) => {
						const active = selected === mode;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...styles.button,
								...active ? styles.active : {},
								...submitting !== null ? styles.pending : {}
							},
							"aria-pressed": active,
							title: mode === "chat" ? projection.chatReadsProject ? "Chat（只读）：读取当前项目的文档、图片文字和视频，保留本会话上下文；修改和运行命令需切换 Agent。" : "Chat：保留本会话上下文，所有工具已禁用。" : "Agent: restore the full DeepSeek Harness agent loop",
							disabled: submitting !== null,
							onClick: () => {
								choose(mode);
							},
							children: mode === "chat" ? (projection.chatReadsProject ? "Chat · 只读" : "Chat") : "Agent"
						}, mode);
					})
				}), error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.error,
					role: "status",
					title: error,
					children: "switch failed"
				})]
			});
		}
		/** Register the toggle on its own right-aligned row above the composer card. */
		function apply(ctx) {
			const sessions = ctx.sessions;
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "autonomy",
				order: 100,
				label: "Autonomy",
				inject: (sessionId) => ({ setMode: async (mode) => {
					const session = sessions.binding(sessionId)?.session;
					if (session === void 0) return "session unavailable";
					const result = await session.command(`/autonomy ${mode}`);
					if (!result.ok) return `${result.error.message} (${result.error.code})`;
					if (!result.value.matched) return "unknown command: /autonomy";
					return null;
				} })
			}, AutonomyToggle));
		}
		//#endregion
		exports.AutonomyToggle = AutonomyToggle;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
