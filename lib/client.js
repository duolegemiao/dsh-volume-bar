/**
 * dsh-volume-bar — browser half.
 *
 * Three jobs:
 *   1. its own page in Settings (设置 → 音量条): switch, three knobs, presets, a
 *      live preview that needs no audio backend, and a readable status line;
 *   2. while the meter runs, the ticks of the turn rail follow the system
 *      output, one frequency band per tick;
 *   3. the rail keeps its own states (current turn, hover preview, keyboard
 *      focus), which always win over the decoration.
 *
 * Every asynchronous path runs under a generation guard: enabling, disabling and
 * unloading all bump it, so a late response can never turn the meter back on
 * after the user asked it to stop (review F02). Retries are driven by the user's
 * *intent* rather than by whether the capture is currently up (F01), the tick
 * cache is validated by node identity (F03), backoff only resets on genuinely
 * new frames (F04/F05), and smoothing uses real frame time so a 144 Hz screen
 * behaves like a 60 Hz one (F12).
 *
 * The bundle is hand-written in the client module format (no build step): it
 * registers a factory and exports a plain Cordis plugin.
 */

window.__ModuleLoader__.load({
	id: "dsh-volume-bar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { jsx, jsxs } = require("react/jsx-runtime");
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const CLIENT_VERSION = "0.7.2";
		const PROTOCOL_VERSION = 2;

		/** Fallback origins to try when a relative request cannot reach the host. */
		const FALLBACK_ORIGINS = ["", "http://127.0.0.1:19387", "http://localhost:19387"];
		/** Poll cadence while frames are healthy. */
		const POLL_MS = 45;
		/** Request timeouts: a poll is short, starting the helper may take a while. */
		const POLL_TIMEOUT_MS = 2500;
		const START_TIMEOUT_MS = 9000;
		const SETUP_TIMEOUT_MS = 15000;
		/** Transport backoff (host unreachable). */
		const RETRY_MS = 500;
		const RETRY_MAX_MS = 12000;
		/** Capture backoff (helper died, no device, dependencies missing). */
		const RECOVER_MIN_MS = 400;
		const RECOVER_MAX_MS = 12000;
		/** No *new* frame for this long: report a stall and recover (F05). */
		const STALE_MS = 2500;
		/** No valid frame at all for this long: the envelope falls back to rest. */
		const VISUAL_FALLBACK_MS = 400;
		/** RMS below this counts as "quiet but healthy". */
		const SILENCE_RMS = 0.004;
		/** Lease requested from the host (the host clamps it). */
		const LEASE_TTL_MS = 90000;
		/** How often the rail may be re-scanned even without a DOM mutation. */
		const TICK_SCAN_MS = 250;
		const BANDS = 8;
		/** Relative band gate: bands below this fraction of the loudest read as silence. */
		const GATE = 0.12;
		const STYLE_ID = "dsh-volume-bar-style";
		const BTN_ID = "dsh-volume-bar-button";
		const STORAGE_KEY = "dsh-volume-bar-settings";
		const SCHEMA_VERSION = 2;
		const NS = "volumeBar";
		const PREVIEW_MS = 90;
		const RAIL_ATTR = "data-dsh-vb-rail";

		const DEFAULTS = {
			enabled: false,
			sensitivity: 0.5,
			amplitude: 0.5,
			speed: 0.5,
			attackMs: 90,
			releaseMs: 220,
			preset: "normal",
			deviceIndex: null,
		};

		/** Presets change display behaviour only — never "audio quality". */
		const PRESETS = {
			normal: { label: "presetNormal", sensitivity: 0.5, amplitude: 0.5, speed: 0.5, attackMs: 90, releaseMs: 220, calm: 1 },
			focus: { label: "presetFocus", sensitivity: 0.5, amplitude: 0.3, speed: 0.34, attackMs: 160, releaseMs: 420, calm: 0.45 },
			rhythm: { label: "presetRhythm", sensitivity: 0.6, amplitude: 0.8, speed: 0.72, attackMs: 45, releaseMs: 130, calm: 0.85 },
		};

		const zh = {
			title: "音量条",
			switchTitle: "对话音量条",
			description: "抓系统输出音频，驱动对话右侧的轮次导航栏",
			starting: "正在准备音频助手…",
			installing: "正在安装音频依赖…",
			waiting: "等待音频数据…",
			running: "运行中",
			silent: "运行中（当前安静）",
			stalled: "采集已停滞，正在恢复…",
			noRail: "当前会话没有轮次导航栏",
			device: "输出设备",
			deviceFollow: "跟随系统默认",
			devicePinned: "固定设备",
			unreachable: "连不上宿主",
			reconnecting: "正在重连",
			setupFailed: "音频依赖安装失败",
			levelOnly: "依赖降级：只显示总电平",
			repair: "重新安装依赖",
			sensitivity: "音量检测灵敏度",
			sensitivityHint: "越低越只对响亮的声音有反应，越高越能捕捉细微声音",
			amplitude: "动效幅度",
			amplitudeHint: "刻度伸缩的幅度，越大起伏越夸张",
			speed: "响应速度",
			speedHint: "跟手程度，越快越跳跃，越慢越柔和",
			preset: "动效预设",
			presetHint: "「专注」更收敛，「节奏」更跳跃；预设会一起调整三个滑块",
			presetNormal: "常规",
			presetFocus: "专注",
			presetRhythm: "节奏",
			preview: "试听预览",
			previewHint: "不采集音频也能看动效；拖动滑块时实时变化",
			previewOn: "播放",
			previewOff: "停止",
			devices: "采集设备",
			reset: "恢复默认",
			diagnostics: "诊断信息",
			analysisMode: "分析模式",
			protocol: "协议版本",
			railMarks: "可见刻度",
			reducedMotion: "系统已开启「减少动画」，动效幅度已自动降低",
		};
		const en = {
			title: "Volume bar",
			switchTitle: "Dialogue volume bar",
			description: "Drives the conversation turn rail from the system output",
			starting: "Preparing the audio helper…",
			installing: "Installing the audio dependencies…",
			waiting: "Waiting for audio data…",
			running: "Running",
			silent: "Running (quiet right now)",
			stalled: "Capture stalled, recovering…",
			noRail: "This conversation has no turn rail",
			device: "Output device",
			deviceFollow: "Follows the system default",
			devicePinned: "Pinned device",
			unreachable: "Cannot reach the host",
			reconnecting: "Reconnecting",
			setupFailed: "Installing the audio dependencies failed",
			levelOnly: "Degraded: total level only",
			repair: "Reinstall dependencies",
			sensitivity: "Sensitivity",
			sensitivityHint: "Lower reacts only to loud audio, higher picks up quiet detail",
			amplitude: "Amplitude",
			amplitudeHint: "How far the ticks stretch",
			speed: "Response speed",
			speedHint: "Faster is snappier, slower is smoother",
			preset: "Preset",
			presetHint: "Focus is calmer, Rhythm is bouncier; a preset moves all three knobs",
			presetNormal: "Normal",
			presetFocus: "Focus",
			presetRhythm: "Rhythm",
			preview: "Preview",
			previewHint: "See the effect without capturing audio; it follows the knobs live",
			previewOn: "Play",
			previewOff: "Stop",
			devices: "Capture device",
			reset: "Reset to defaults",
			diagnostics: "Diagnostics",
			analysisMode: "Analysis mode",
			protocol: "Protocol version",
			railMarks: "Visible ticks",
			reducedMotion: "The system asks for reduced motion, so the amplitude is lowered",
		};

		const CSS = `
/* ---- settings page ------------------------------------------------------- */
.dsh-vb-page { display: flex; flex-direction: column; }
.dsh-vb-row {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-l4, #ececec);
}
.dsh-vb-row:last-child { border-bottom: none; }
.dsh-vb-row-last { border-bottom: none; }
.dsh-vb-row-text { min-width: 0; }
.dsh-vb-row-title { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary, #111); }
.dsh-vb-row-desc { font-size: 12px; line-height: 18px; margin-top: 4px; color: var(--dsw-alias-label-secondary, #666); }
.dsh-vb-row-desc.dsh-vb-warn { color: var(--dsw-alias-state-warning-primary, #b7791f); }
.dsh-vb-control { display: flex; align-items: center; gap: 10px; flex: none; }
.dsh-vb-range {
  width: 150px; cursor: pointer; margin: 0;
  accent-color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.dsh-vb-range:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 2px; }
.dsh-vb-value {
  width: 40px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, #999);
}
.dsh-vb-seg { display: flex; gap: 6px; }
.dsh-vb-seg-button, .dsh-vb-reset {
  font: inherit; font-size: 13px; cursor: pointer; padding: 6px 12px; border-radius: 8px;
  color: var(--dsw-alias-label-secondary, #666);
  background: transparent; border: 1px solid var(--dsw-alias-border-l4, #ddd);
  transition: color .15s, border-color .15s, background .15s;
}
.dsh-vb-seg-button[aria-pressed="true"] {
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
  border-color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.dsh-vb-seg-button:hover, .dsh-vb-reset:hover {
  color: var(--dsw-alias-label-primary, #111);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08));
}
.dsh-vb-seg-button:focus-visible, .dsh-vb-reset:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 2px;
}
.dsh-vb-preview {
  display: flex; align-items: flex-end; gap: 4px; height: 40px; width: 150px;
  padding: 0 2px; flex: none;
}
.dsh-vb-preview span {
  flex: 1 1 0; height: 100%; border-radius: 2px;
  background: var(--dsw-alias-label-primary, #111);
  transform-origin: 50% 100%; transform: scaleY(.25);
}
/* Diagnostics collapses into a row-shaped summary so it lines up with the rows
   above it: title on the left, chevron on the right. */
.dsh-vb-details { border-bottom: 1px solid var(--dsw-alias-border-l4, #ececec); }
.dsh-vb-details summary {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 16px 0; cursor: pointer; list-style: none;
}
.dsh-vb-details summary::-webkit-details-marker { display: none; }
.dsh-vb-details summary:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 2px; }
.dsh-vb-chevron {
  flex: none; font-size: 16px; line-height: 1; color: var(--dsw-alias-label-tertiary, #999);
  transform: rotate(90deg); transition: transform .15s;
}
.dsh-vb-details[open] .dsh-vb-chevron { transform: rotate(-90deg); }
.dsh-vb-diagnostics {
  font-family: Consolas, "SFMono-Regular", monospace; font-size: 12px; line-height: 18px;
  padding: 0 0 12px; color: var(--dsw-alias-label-secondary, #666); white-space: pre-wrap;
}
.dsh-vb-select {
  font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 8px; max-width: 220px;
  color: var(--dsw-alias-label-primary, #111);
  background: var(--dsw-alias-bg-base, #fff);
  border: 1px solid var(--dsw-alias-border-l4, #ddd);
}
.dsh-vb-select:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 2px; }

/* ---- fallback toggle ----------------------------------------------------- */
/* Only used when this DSH build has no settings.section to register into, so
   the plugin cannot become unreachable on a different version. */
#${BTN_ID} {
  position: fixed; right: 10px; top: 50%; z-index: 40;
  width: 28px; height: 28px; border-radius: 50%;
  display: grid; place-items: center; padding: 0; cursor: pointer;
  font-size: 13px; line-height: 1;
  border: 1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.35));
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-tertiary, #888);
  transition: color .15s, border-color .15s;
}
#${BTN_ID}.dsh-vb-on {
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
  border-color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
#${BTN_ID}:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 2px; }

/* ---- turn rail ----------------------------------------------------------- */
/* Only the two animated values are touched, and only while the meter is on.
   The rail's own states (active tick, hover preview, :focus-visible) keep their
   rules: they win because the decoration can never raise a tick above full. */
.dsh-vb-on [class*="_mark"]::before {
  transform: translateY(-50%) scaleX(var(--dsh-vb-w, .6));
  opacity: var(--dsh-vb-o, 1);
  transition: none;
}
/* No colour override: the tick keeps the rail's own palette, so the active tick
   stays legible in every theme. */
`;

		function injectStyle() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		function clamp01(value) {
			return value < 0 ? 0 : value > 1 ? 1 : value;
		}

		function number(value, fallback, min, max) {
			// `null` and `""` coerce to 0, which would silently turn a damaged
			// setting into a real zero: treat them as missing, like NaN (review F15).
			if (value === null || value === undefined || value === "") return fallback;
			const parsed = typeof value === "number" ? value : Number(value);
			if (!Number.isFinite(parsed)) return fallback;
			return parsed < min ? min : parsed > max ? max : parsed;
		}

		/** Read + validate the stored settings; unknown fields are dropped (F15). */
		function readSettings() {
			const clean = { ...DEFAULTS };
			let raw = null;
			try {
				raw = window.localStorage.getItem(STORAGE_KEY);
			} catch {
				return clean;
			}
			if (!raw) return clean;
			let parsed = null;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return clean;
			}
			if (!parsed || typeof parsed !== "object") return clean;
			clean.enabled = parsed.enabled === true;
			clean.sensitivity = number(parsed.sensitivity, DEFAULTS.sensitivity, 0, 1);
			clean.amplitude = number(parsed.amplitude, DEFAULTS.amplitude, 0, 1);
			clean.speed = number(parsed.speed, DEFAULTS.speed, 0, 1);
			clean.attackMs = number(parsed.attackMs, DEFAULTS.attackMs, 10, 2000);
			clean.releaseMs = number(parsed.releaseMs, DEFAULTS.releaseMs, 20, 4000);
			clean.preset = typeof parsed.preset === "string" && PRESETS[parsed.preset] ? parsed.preset : DEFAULTS.preset;
			// `Number(null)` is 0, which would silently turn "follow the system
			// default" into "pinned to device 0" (review: device-index regression).
			const deviceField = parsed.deviceIndex;
			const device = deviceField === null || deviceField === undefined || deviceField === "" ? NaN : Number(deviceField);
			clean.deviceIndex = Number.isInteger(device) && device >= 0 ? device : null;
			return clean;
		}

		/** Minimal snapshot store: the settings page subscribes to this. */
		function createStore(initial) {
			let state = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				set: (patch) => {
					state = { ...state, ...patch };
					for (const listener of Array.from(listeners)) listener();
				},
			};
		}

		/**
		 * User knobs -> meter constants. Time constants are in milliseconds; the
		 * per-frame smoothing derives its factor from the real frame delta, so the
		 * display refresh rate no longer changes how fast a tick moves (review F12).
		 */
		function tune(settings) {
			const sensitivity = clamp01(number(settings.sensitivity, DEFAULTS.sensitivity, 0, 1));
			const amplitude = clamp01(number(settings.amplitude, DEFAULTS.amplitude, 0, 1));
			const speed = clamp01(number(settings.speed, DEFAULTS.speed, 0, 1));
			return {
				floor: 0.0003 * Math.pow(10, (1 - sensitivity) * 2),
				restWidth: 0.75 - amplitude * 0.5,
				restOpacity: 0.55 - amplitude * 0.5,
				attackMs: number(settings.attackMs, DEFAULTS.attackMs, 10, 2000),
				releaseMs: number(settings.releaseMs, DEFAULTS.releaseMs, 20, 4000),
				/** How fast the shared reference lets go of a past peak (per second). */
				agcReleasePerSecond: 0.35 + (1 - speed) * 3.2,
			};
		}

		/**
		 * The rail tick at DOM `tick` (0 = top) reads the band that sits at the same
		 * relative height counted from the bottom of the whole conversation, so few
		 * ticks cover the full range and many ticks interpolate between bands (F16).
		 */
		/**
		 * The tick at DOM position `tick` (0 = top of the rail) reads the band at the
		 * same relative height counted from the bottom, so a short rail still covers
		 * the whole range and a long one interpolates between bands (review F16).
		 * (The rail is virtualized; `total` is the conversation's turn count.)
		 */
		function bandValueFor(ticks, tick, total, report) {
			if (ticks <= 0 || total <= 0) return 0;
			const fromBottom = ticks <= 1 ? 0 : clamp01(1 - tick / (ticks - 1));
			const exact = fromBottom * (BANDS - 1);
			const low = Math.max(0, Math.min(BANDS - 1, Math.floor(exact)));
			const high = Math.min(BANDS - 1, low + 1);
			const mix = exact - low;
			// How much of the raw band energy reaches the tick; the pointer attention
			// is applied separately in draw(), so the two never overwrite each other.
			return report.values[low] * (1 - mix) + report.values[high] * mix;
		}

		function useStore(store) {
			const subscribe = (notify) => store.subscribe(notify);
			const getSnapshot = () => store.getSnapshot();
			return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		/** One settings row: text on the left, control on the right. */
		function Row({ title, description, descriptionId, warning, children }) {
			return jsxs("div", {
				className: "dsh-vb-row",
				children: [
					jsxs("div", {
						className: "dsh-vb-row-text",
						children: [
							jsx("div", { className: "dsh-vb-row-title", children: title }),
							description
								? jsx("div", {
									id: descriptionId,
									className: warning ? "dsh-vb-row-desc dsh-vb-warn" : "dsh-vb-row-desc",
									children: description,
								})
								: null,
						],
					}),
					jsx("div", { className: "dsh-vb-control", children }),
				],
			});
		}

		/** A 0..1 knob rendered as a range input with a programmatic name. */
		function Knob({ id, value, label, describedBy, onInput }) {
			const percent = Math.round(value * 100);
			return jsxs("div", {
				className: "dsh-vb-control",
				children: [
					jsx("input", {
						id,
						className: "dsh-vb-range",
						type: "range",
						min: "0",
						max: "100",
						step: "1",
						value: String(percent),
						"aria-label": label,
						"aria-describedby": describedBy,
						"aria-valuetext": `${percent}%`,
						onChange: (event) => onInput(Number(event.target.value) / 100),
					}),
					jsx("span", { className: "dsh-vb-value", "aria-hidden": "true", children: `${percent}%` }),
				],
			});
		}

		/** The live preview: synthetic bands, no audio backend involved. */
		function Preview({ settings, running, reducedMotion, onToggle, t }) {
			const hostRef = React.useRef(null);
			const config = tune(settings);
			const scale = reducedMotion ? 0.55 : 1;

			React.useEffect(() => {
				const host = hostRef.current;
				if (!running) {
					if (host) for (const bar of host.children) {
						bar.style.transform = "scaleY(.25)";
						bar.style.opacity = "1";
					}
					return undefined;
				}
				let phase = 0;
				const timer = setInterval(() => {
					const element = hostRef.current;
					if (!element) return;
					phase += 0.16;
					const energy = 0.45 + 0.4 * Math.sin(phase * 0.7) + 0.15 * Math.sin(phase * 2.3);
					const bars = element.children;
					for (let i = 0; i < bars.length; i++) {
						const wobble = Math.sin(phase * (1.3 + i * 0.31) + i) * 0.5 + 0.5;
						const value = clamp01(energy * (0.35 + 0.65 * wobble) * (1 - i * 0.05)) * scale;
						const width = Math.max(config.restWidth, config.restWidth + value * (1 - config.restWidth));
						bars[i].style.transform = `scaleY(${width.toFixed(3)})`;
						bars[i].style.opacity = String(Math.max(config.restOpacity, value * 0.35 + 0.65));
					}
				}, PREVIEW_MS);
				return () => clearInterval(timer);
			}, [running, scale, config.restWidth, config.restOpacity, settings.attackMs, settings.releaseMs]);

			return jsxs("div", {
				className: "dsh-vb-control",
				children: [
					jsx("div", {
						className: "dsh-vb-preview",
						ref: hostRef,
						"aria-hidden": "true",
						children: Array.from({ length: BANDS }, (_, index) => jsx("span", {}, `bar-${index}`)),
					}),
					jsx("button", {
						type: "button",
						className: "dsh-vb-reset",
						"aria-pressed": running ? "true" : "false",
						onClick: onToggle,
						children: running ? t("previewOff") : t("previewOn"),
					}),
				],
			});
		}

		/** Preset row: 「常规 / 专注 / 节奏」segmented control. */
		function PresetRow({ state, t, onApply }) {
			return jsx(Row, {
				title: t("preset"),
				description: t("presetHint"),
				descriptionId: "dsh-vb-preset-hint",
				children: jsx("div", {
					className: "dsh-vb-seg",
					role: "group",
					"aria-label": t("preset"),
					children: Object.keys(PRESETS).map((key) => jsx("button", {
						type: "button",
						className: "dsh-vb-seg-button",
						"aria-pressed": state.preset === key ? "true" : "false",
						onClick: () => onApply(key),
						children: t(PRESETS[key].label),
					}, key)),
				}),
			});
		}

		/** The settings → 音量条 page. Registered directly as the section body. */
		function VolumeBarPanel(props) {
			const state = props.useVolumeBar();
			// The shell hands section components its bound translator; `translate` is
			// our own fallback for builds that only inject the actions.
			const t = typeof props.t === "function" ? props.t : props.translate;
			const [preview, setPreview] = React.useState(false);
			const set = props.setVolumeBarSetting;

			let status = t("description");
			let warning = false;
			if (state.status === "installing") status = t("installing");
			else if (state.status === "starting" || state.status === "connecting") status = t("starting");
			else if (state.status === "waiting") status = t("waiting");
			else if (state.status === "on") {
				const device = state.device ? `${t("device")}: ${state.device}` : "";
				status = `${state.silent ? t("silent") : t("running")}${device ? ` · ${device}` : ""}`;
			} else if (state.status === "stalled") {
				status = t("stalled");
				warning = true;
			} else if (state.status === "norail") status = t("noRail");
			else if (state.status === "setup_failed") {
				status = `${t("setupFailed")}${state.message ? `：${state.message}` : ""}`;
				warning = true;
			} else if (state.status === "error") {
				status = state.message || t("unreachable");
				warning = true;
			}
			if (state.analysisMode === "level-only") {
				status = `${status} · ${t("levelOnly")}`;
				warning = true;
			}
			if (state.reducedMotion) status = `${status} · ${t("reducedMotion")}`;

			return jsxs("div", {
				className: "dsh-vb-page",
				children: [
					jsx(Row, {
						title: t("switchTitle"),
						description: status,
						descriptionId: "dsh-vb-status",
						warning,
						children: jsx(primitives.Switch, {
							checked: state.enabled,
							label: t("switchTitle"),
							onChange: (next) => set({ enabled: next }),
						}),
					}, "switch"),
					jsx(Row, {
						title: t("sensitivity"),
						description: t("sensitivityHint"),
						descriptionId: "dsh-vb-sensitivity-hint",
						children: Knob({
							id: "dsh-vb-sensitivity",
							value: state.sensitivity,
							label: t("sensitivity"),
							describedBy: "dsh-vb-sensitivity-hint",
							onInput: (value) => set({ sensitivity: value }),
						}),
					}, "sensitivity"),
					jsx(Row, {
						title: t("amplitude"),
						description: t("amplitudeHint"),
						descriptionId: "dsh-vb-amplitude-hint",
						children: Knob({
							id: "dsh-vb-amplitude",
							value: state.amplitude,
							label: t("amplitude"),
							describedBy: "dsh-vb-amplitude-hint",
							onInput: (value) => set({ amplitude: value }),
						}),
					}, "amplitude"),
					jsx(Row, {
						title: t("speed"),
						description: t("speedHint"),
						descriptionId: "dsh-vb-speed-hint",
						children: Knob({
							id: "dsh-vb-speed",
							value: state.speed,
							label: t("speed"),
							describedBy: "dsh-vb-speed-hint",
							onInput: (value) => set({ speed: value }),
						}),
					}, "speed"),
					jsx(PresetRow, {
						state,
						t,
						onApply: (key) => props.applyVolumeBarPreset(key),
					}, "preset"),
					jsx(Row, {
						title: t("preview"),
						description: t("previewHint"),
						descriptionId: "dsh-vb-preview-hint",
						children: Preview({
							settings: state,
							running: preview,
							reducedMotion: state.reducedMotion,
							onToggle: () => setPreview(!preview),
							t,
						}),
					}, "preview"),
					jsx(Row, {
						title: t("devices"),
						description: state.deviceIndex === null || state.deviceIndex === undefined ? t("deviceFollow") : t("devicePinned"),
						descriptionId: "dsh-vb-device-hint",
						children: jsx("select", {
							className: "dsh-vb-select",
							"aria-label": t("devices"),
							value: state.deviceIndex === null || state.deviceIndex === undefined ? "auto" : String(state.deviceIndex),
							disabled: !state.devices || !state.devices.length,
							onChange: (event) => props.setVolumeBarDevice(event.target.value === "auto" ? null : Number(event.target.value)),
							children: [
								jsx("option", { value: "auto", children: t("deviceFollow") }, "auto"),
								(state.devices || []).map((device) => jsx("option", {
									value: String(device.index),
									children: `${device.name}${device.channels ? ` · ${device.channels}ch` : ""}`,
								}, String(device.index))),
							],
						}),
					}, "devices"),
					jsxs("details", {
						className: "dsh-vb-details",
						children: [
							jsx("summary", {
								children: [
									jsx("span", { className: "dsh-vb-row-title", children: t("diagnostics") }),
									jsx("span", { className: "dsh-vb-chevron", "aria-hidden": "true", children: "›" }),
								],
							}),
							jsx("div", {
								className: "dsh-vb-diagnostics",
								children: [
									`${t("protocol")}: ${state.protocolVersion ?? "?"} / ${PROTOCOL_VERSION}`,
									`${t("analysisMode")}: ${state.analysisMode ?? "?"}`,
									`${t("railMarks")}: ${state.marks} / ${state.marksTotal}`,
									`captureState: ${state.captureState ?? "?"}`,
									`seq: ${state.seq ?? "?"} · ageMs: ${state.ageMs ?? "?"}`,
									`client: ${CLIENT_VERSION}`,
								].join("\n"),
							}),
						],
					}, "diagnostics"),
					jsx("div", {
						className: "dsh-vb-row dsh-vb-row-last",
						children: [
							jsx("div", { className: "dsh-vb-row-text" }),
							jsx("div", {
								className: "dsh-vb-control",
								children: [
									state.status === "setup_failed" || state.status === "error"
										? jsx("button", {
											type: "button",
											className: "dsh-vb-reset",
											onClick: () => props.repairVolumeBar(),
											children: t("repair"),
										}, "repair")
										: null,
									jsx("button", {
										type: "button",
										className: "dsh-vb-reset",
										onClick: () => props.resetVolumeBarSettings(),
										children: t("reset"),
									}, "reset"),
								],
							}),
						],
					}, "reset"),
				],
			});
		}

		exports.inject = ["slots", "locale"];

		exports.apply = function apply(ctx) {
			injectStyle();

			// Dictionaries are registered up front so status text — including the
			// reconnect messages — is localised even if the settings page cannot mount.
			let t = (key) => zh[key] ?? key;
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-volume-bar: dictionaries");
				t = ctx.locale.bind(NS);
			} catch (error) {
				ctx.logger?.warn?.("dsh-volume-bar: locale unavailable", error);
			}

			// ---- mutable plugin state -------------------------------------
			let settings = readSettings();
			let disposed = false;
			/** Bumped by every enable/disable/unload; stale async work is dropped. */
			let generation = 0;
			let enabled = settings.enabled;
			let base = null;
			let leaseTtlMs = LEASE_TTL_MS;
			let pollTimer = null;
			let recoverTimer = null;
			let rafId = null;
			/** The user wants the meter; the visuals are attached. */
			let running = false;
			let pollInFlight = false;
			let startPromise = null;
			let lastFrameAt = 0;
			let lastAcceptedAt = 0;
			let lastSeq = null;
			let lastFrameGeneration = null;
			let transportFailures = 0;
			let recoveries = 0;
			let lastStatus = null;
			let stalled = false;
			let hidden = document.visibilityState === "hidden";

			const clientId = `vb-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
			const marks = [];
			const boost = new WeakMap();
			const painted = new WeakMap();
			let railHost = null;
			let railFrame = null;
			let marksTotal = 0;
			let maxIndex = -1;
			let railAdapted = false;
			let railDirty = true;
			let lastScanAt = 0;

			const agc = new Array(BANDS).fill(0);
			const target = new Array(BANDS).fill(0);
			const smooth = new Array(BANDS).fill(0);
			let ref = 0;
			/** Pointer attention / scroll damping (1 = full strength). */
			let attention = 1;
			let attentionTarget = 1;
			let scrollQuietUntil = 0;
			let lastDrawAt = 0;

			const reducedMotion = typeof window.matchMedia === "function"
				&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;

			const store = createStore({
				enabled,
				status: "idle",
				message: "",
				silent: false,
				device: null,
				deviceIndex: settings.deviceIndex,
				devices: [],
				bands: BANDS,
				analysisMode: null,
				protocolVersion: null,
				captureState: null,
				seq: null,
				ageMs: null,
				marks: 0,
				marksTotal: 0,
				reducedMotion,
				preset: settings.preset,
				sensitivity: settings.sensitivity,
				amplitude: settings.amplitude,
				speed: settings.speed,
			});

			function persist() {
				try {
					window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, schemaVersion: SCHEMA_VERSION }));
				} catch {
					/* storage may be unavailable; the session still works */
				}
			}

			// ---- rail adapter ---------------------------------------------

			/**
			 * Locate the conversation turn rail. The container is the rail's own
			 * slot; identity (not just the tick count) decides whether the cache is
			 * still valid, because a new conversation can reuse the same count while
			 * replacing every node (review F03).
			 */
			function findRail() {
				let host = document.querySelector(`[${RAIL_ATTR}]`);
				if (host && !host.isConnected) host = null;
				if (!host) {
					for (const container of document.querySelectorAll('div[class*="_marks"]')) {
						if (!container.closest('nav[aria-label]')) continue;
						const slot = container.closest('div[class*="_slot"]') ?? container;
						slot.setAttribute(RAIL_ATTR, "1");
						host = slot;
						break;
					}
				}
				if (!host) {
					const anyMark = document.querySelector('button[class*="_mark"]');
					const slot = anyMark?.closest('div[class*="_slot"]');
					if (slot) {
						slot.setAttribute(RAIL_ATTR, "1");
						host = slot;
					}
				}
				if (!host) return { host: null, frame: null, marks: [], total: 0, maxIndex: -1 };

				const container = host.matches?.('div[class*="_marks"]') ? host : host.querySelector('div[class*="_marks"]');
				const buttons = container ? container.querySelectorAll('button[class*="_mark"]') : host.querySelectorAll('button[class*="_mark"]');
				const list = Array.from(buttons);
				let total = list.length;
				let highest = -1;
				for (const button of list) {
					const index = Number(button.dataset?.index);
					if (Number.isFinite(index)) {
						if (index > highest) highest = index;
						if (index + 1 > total) total = index + 1;
					}
				}
				return { host, frame: host, marks: list, total, maxIndex: highest };
			}

			/** True while the cached ticks still describe the current DOM. */
			function cacheIsCurrent(found) {
				if (!found.host || found.host !== railHost) return false;
				if (found.marks.length !== marks.length) return false;
				for (let i = 0; i < marks.length; i++) {
					if (found.marks[i] !== marks[i] || !marks[i].isConnected) return false;
				}
				return true;
			}

			function clearPaint(list) {
				for (const element of list) {
					element.style.removeProperty("--dsh-vb-w");
					element.style.removeProperty("--dsh-vb-o");
					painted.delete(element);
				}
			}

			/** Re-bind the decoration to whatever the rail looks like right now. */
			function place(force = false) {
				if (disposed) return;
				const now = performance.now();
				if (!force && !railDirty && now - lastScanAt < TICK_SCAN_MS) return;
				lastScanAt = now;
				railDirty = false;

				const found = findRail();
				if (cacheIsCurrent(found)) {
					marksTotal = found.total;
					maxIndex = found.maxIndex;
					railAdapted = true;
					if (railFrame && running) railFrame.classList.add("dsh-vb-on");
					updateRailStatus();
					return;
				}
				if (railFrame && railFrame !== found.frame) railFrame.classList.remove("dsh-vb-on");
				clearPaint(marks);
				marks.length = 0;
				for (const element of found.marks) {
					marks.push(element);
				}
				railHost = found.host;
				railFrame = found.frame;
				marksTotal = found.total;
				maxIndex = found.maxIndex;
				railAdapted = Boolean(found.host);
				if (railFrame && running) railFrame.classList.add("dsh-vb-on");
				store.set({ marks: marks.length, marksTotal });
				updateRailStatus();
			}

			function updateRailStatus() {
				if (!enabled) return;
				if (!running) return;
				const snapshot = store.getSnapshot();
				if (!railAdapted && marks.length === 0) {
					if (snapshot.status === "on") setStatus("norail");
					return;
				}
				if (snapshot.status === "norail") setStatus("on");
			}

			// ---- transport -------------------------------------------------

			function makeSignal(timeoutMs) {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeoutMs);
				return { signal: controller.signal, done: () => clearTimeout(timer) };
			}

			/** One bounded request; `base` caches the origin that answered first. */
			async function request(path, { method = "GET", body = null, timeoutMs = POLL_TIMEOUT_MS } = {}) {
				const origins = base === null ? FALLBACK_ORIGINS : [base];
				let lastError = null;
				for (const origin of origins) {
					const guard = makeSignal(timeoutMs);
					try {
						const response = await fetch(`${origin}/volume-bar${path}`, {
							method,
							cache: "no-store",
							signal: guard.signal,
							...(body === null
								? {}
								: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const payload = await response.json();
						if (base === null) base = origin;
						return payload;
					} catch (error) {
						lastError = error;
					} finally {
						guard.done();
					}
				}
				throw lastError || new Error("unreachable");
			}

			// ---- envelope ---------------------------------------------------

			function resetLevels() {
				for (let i = 0; i < BANDS; i++) {
					agc[i] = 0;
					target[i] = 0;
					smooth[i] = 0;
				}
				ref = 0;
			}

			/** Turn one *new* frame into per-band targets. */
			function ingest(bands, elapsedMs) {
				const { floor, agcReleasePerSecond } = tune(settings);
				const raw = Array.isArray(bands) ? bands : [];
				let maxRaw = 0;
				for (let i = 0; i < BANDS; i++) {
					const value = Number(raw[i] ?? 0);
					agc[i] = Number.isFinite(value) && value > 0 ? value : 0;
					if (agc[i] > maxRaw) maxRaw = agc[i];
				}
				// One shared reference with a slow release: quiet bands then read as
				// quiet instead of being lifted to the loudest one. The release runs
				// on real time, so the polling cadence cannot change the decay.
				const decay = Math.exp((-agcReleasePerSecond * elapsedMs) / 1000);
				ref = Math.max(maxRaw, ref * decay, floor);
				for (let i = 0; i < BANDS; i++) {
					const ratio = agc[i] / ref;
					const norm = clamp01((ratio - GATE) / (1 - GATE));
					target[i] = Math.pow(norm, 0.6);
				}
			}

			/** The NumPy-less fallback only has a total level. */
			function ingestLevelOnly(rms) {
				const value = Math.pow(clamp01(Number(rms) || 0), 0.6);
				for (let i = 0; i < BANDS; i++) target[i] = value;
			}

			/** True only when the host sent a frame we have not seen (F05). */
			function takeFrame(payload) {
				if (typeof payload?.seq !== "number") return false;
				const frameGeneration = payload.frameGeneration ?? payload.generation ?? null;
				if (payload.seq === lastSeq && frameGeneration === lastFrameGeneration) return false;
				lastSeq = payload.seq;
				lastFrameGeneration = frameGeneration;
				return true;
			}

			// ---- drawing ----------------------------------------------------

			function draw(now) {
				rafId = requestAnimationFrame(draw);
				const previous = lastDrawAt || now;
				const elapsedMs = Math.min(64, Math.max(0, now - previous));
				lastDrawAt = now;
				if (!running) return;

				// Interaction wins: while the pointer runs the rail, the preview decides
				// the shape and the music steps back (review I01, conservative form).
				const hovered = Boolean(railFrame && railFrame.matches(":hover"));
				const quiet = now < scrollQuietUntil ? 0.55 : 1;
				attentionTarget = (hovered ? PRESETS[settings.preset]?.calm ?? 1 : 1) * quiet;
				attention += (attentionTarget - attention) * Math.min(1, elapsedMs / 220);

				if (lastAcceptedAt && now - lastAcceptedAt > VISUAL_FALLBACK_MS) {
					for (let i = 0; i < BANDS; i++) target[i] = 0;
				}

				const { restWidth, restOpacity, attackMs, releaseMs } = tune(settings);
				const attackAlpha = 1 - Math.exp(-elapsedMs / attackMs);
				const releaseAlpha = 1 - Math.exp(-elapsedMs / releaseMs);
				for (let i = 0; i < BANDS; i++) {
					const to = target[i];
					smooth[i] += (to - smooth[i]) * (to > smooth[i] ? attackAlpha : releaseAlpha);
				}

				if (railDirty || now - lastScanAt > TICK_SCAN_MS) place();
				const count = marks.length;
				if (count === 0) return;

				const report = { values: smooth };

				for (let i = 0; i < count; i++) {
					const element = marks[i];
					const className = String(element.className || "");
					// The rail's own states win: the active tick stays full width, and
					// keyboard focus stays visible even in silence.
					const isActive = /_markActive/.test(className) || element.getAttribute("aria-current") === "true";
					const isPinned = isActive || /_markPreview|_markUnloaded/.test(className);
					const isHovered = element.matches(":hover");
					const previousBoost = boost.get(element) ?? 0;
					const nextBoost = previousBoost + ((isHovered ? 1 : 0) - previousBoost) * Math.min(0.5, elapsedMs / 120);
					boost.set(element, nextBoost);

					let value = bandValueFor(count, i, marksTotal, report);
					if (isPinned) value = Math.max(value, isActive ? 1 : 0.5);
					value = Math.max(value, nextBoost);
					// Pointer attention only ever scales the decoration down, never up,
					// so the rail's own states stay the strongest signal.
					value *= attention;

					const floorWidth = isActive ? 1 : isPinned ? 0.45 : 0;
					const floorOpacity = isActive ? 0.85 : isPinned ? 0.45 : 0;
					const width = Math.max(floorWidth, restWidth + value * (1 - restWidth));
					const opacity = Math.max(floorOpacity, restOpacity + value * (1 - restOpacity));
					const last = painted.get(element);
					if (last && Math.abs(last.width - width) < 0.004 && Math.abs(last.opacity - opacity) < 0.01) continue;
					painted.set(element, { width, opacity });
					element.style.setProperty("--dsh-vb-w", width.toFixed(3));
					element.style.setProperty("--dsh-vb-o", opacity.toFixed(3));
				}
			}

			// ---- status -----------------------------------------------------

			function setStatus(status, message = "") {
				if (lastStatus === status && store.getSnapshot().message === message) return;
				lastStatus = status;
				store.set({ status, message });
			}

			function syncHostState(payload) {
				if (!payload || typeof payload !== "object") return;
				// A pinned device that no longer exists makes the helper fall back to
				// the system default. Drop the stale pin so the setting matches what
				// the host is actually capturing instead of retrying a dead index.
				if (payload.device && settings.deviceIndex !== null && payload.device.mode === "pinned-fallback") {
					settings = { ...settings, deviceIndex: null };
					persist();
				}
				store.set({
					device: payload.device?.name ?? null,
					deviceIndex: settings.deviceIndex,
					analysisMode: payload.analysisMode ?? null,
					protocolVersion: payload.protocolVersion ?? null,
					captureState: payload.captureState ?? null,
					seq: payload.seq ?? null,
					ageMs: payload.ageMs ?? null,
					...(Array.isArray(payload.devices) && payload.devices.length ? { devices: payload.devices } : {}),
				});
			}

			// ---- scheduling --------------------------------------------------

			function clearTimers() {
				if (pollTimer) {
					clearTimeout(pollTimer);
					pollTimer = null;
				}
				if (recoverTimer) {
					clearTimeout(recoverTimer);
					recoverTimer = null;
				}
			}

			/** Backoff for "the helper is not producing frames" restarts. */
			function scheduleRecover() {
				if (disposed || !enabled || recoverTimer) return;
				recoveries += 1;
				const delay = Math.min(RECOVER_MAX_MS, RECOVER_MIN_MS * Math.pow(1.7, Math.min(recoveries, 8)));
				recoverTimer = setTimeout(() => {
					recoverTimer = null;
					if (disposed || !enabled) return;
					void ensureStarted(++generation);
				}, delay);
			}

			/**
			 * Ensure the host is capturing and this window holds a lease. This is the
			 * single recovery entry point: the first attempt, every retry and every
			 * wake-up come through here, so a failed first start cannot end the loop
			 * (review F01) and concurrent callers share one request (F17-style).
			 */
			function ensureStarted(attempt) {
				if (disposed || !enabled) return Promise.resolve();
				if (startPromise) return startPromise;
				if (pollTimer) {
					clearTimeout(pollTimer);
					pollTimer = null;
				}
				const promise = (async () => {
					try {
						const payload = await request("/start", {
							method: "POST",
							timeoutMs: SETUP_TIMEOUT_MS,
							body: { clientId, protocolVersion: PROTOCOL_VERSION, ttlMs: leaseTtlMs, device: settings.deviceIndex ?? null },
						});
						if (disposed || !enabled) return;
						syncHostState(payload.state);
						if (payload.leaseTtlMs) leaseTtlMs = payload.leaseTtlMs;
						if (payload.ok === false) {
							const code = payload.code ?? payload.state?.errorCode ?? null;
							if (code === "dependencies_missing") {
								setStatus("installing");
								// Ask the host to (re)install once, then return through the
								// same recovery path instead of hammering /start.
								void request("/setup", { method: "POST", timeoutMs: SETUP_TIMEOUT_MS, body: {} }).catch(() => {});
								recoveries = 0;
								scheduleRecover();
								return;
							}
							const setup = payload.state?.setup;
							if (setup?.error) {
								setStatus("setup_failed", setup.error);
							} else {
								setStatus(setup?.running ? "installing" : "error", payload.error ?? "");
							}
							scheduleRecover();
							return;
						}
						transportFailures = 0;
						if (!running) {
							running = true;
							resetLevels();
							if (!rafId) {
								lastDrawAt = 0;
								rafId = requestAnimationFrame(draw);
							}
						}
						railDirty = true;
						place();
						if (store.getSnapshot().status !== "on") setStatus("waiting");
						schedulePoll(POLL_MS);
					} catch (error) {
						if (disposed || !enabled) return;
						base = null;
						transportFailures += 1;
						if (running) {
							setStatus("error", `${t("reconnecting")}（${transportFailures}）`);
							schedulePoll(Math.min(RETRY_MAX_MS, RETRY_MS * Math.pow(1.6, Math.min(transportFailures, 8))));
						} else {
							setStatus("error", t("unreachable"));
							scheduleRecover();
						}
					} finally {
						startPromise = null;
					}
				})();
				startPromise = promise;
				return promise;
			}

			function schedulePoll(delay) {
				if (disposed || !enabled) return;
				if (pollTimer) clearTimeout(pollTimer);
				pollTimer = setTimeout(() => {
					pollTimer = null;
					void poll(++generation);
				}, delay);
			}

			/**
			 * One poll of `/levels`. Only genuinely new frames advance the envelope
			 * and reset the backoff (review F04/F05): a host that keeps replaying the
			 * same cached frame is treated as stalled, not as healthy.
			 */
			async function poll(attempt) {
				if (disposed || !enabled || !running || pollInFlight) return;
				pollInFlight = true;
				const now = performance.now();
				try {
					const payload = await request(`/levels?clientId=${encodeURIComponent(clientId)}`);
					if (disposed || !enabled || attempt !== generation) return;
					transportFailures = 0;
					syncHostState(payload);

					if (payload.running === false) {
						// The host lost the meter: come back through the recovery path,
						// which owns the next scheduled attempt.
						void ensureStarted(++generation);
						return;
					}

					if (payload.level) {
						if (takeFrame(payload)) {
							const elapsedMs = lastAcceptedAt ? now - lastAcceptedAt : POLL_MS;
							lastAcceptedAt = now;
							lastFrameAt = now;
							if (payload.analysisMode === "level-only") ingestLevelOnly(payload.level.rms);
							else ingest(payload.level.bands, elapsedMs);
							recoveries = 0;
							stalled = false;
							const silent = (Number(payload.level.rms) || 0) < SILENCE_RMS;
							if (store.getSnapshot().silent !== silent) store.set({ silent });
						}
						if (!stalled && store.getSnapshot().status !== "on" && store.getSnapshot().status !== "norail") setStatus("on");
					} else if (!stalled && store.getSnapshot().status !== "waiting") {
						setStatus("waiting");
					}

					// The host reports the age of its newest frame on its own monotonic
					// clock. A live host replaying one stale frame is a stalled capture,
					// not healthy silence (review F05), so restart through the same
					// recovery loop — and keep saying so until a *new* frame arrives,
					// instead of flapping back to "running" on every poll.
					const frameAge = Number(payload.ageMs);
					const stalledNow = (Number.isFinite(frameAge) && frameAge > STALE_MS)
						|| (lastFrameAt > 0 && now - lastFrameAt > STALE_MS && lastAcceptedAt !== lastFrameAt);
					if (stalledNow && payload.running !== false) {
						if (!stalled) {
							stalled = true;
							setStatus("stalled");
							void ensureStarted(++generation);
							return;
						}
					} else {
						stalled = false;
					}
					schedulePoll(POLL_MS);
				} catch (error) {
					if (disposed || !enabled) return;
					base = null;
					transportFailures += 1;
					if (running) setStatus("error", `${t("reconnecting")}（${transportFailures}）`);
					else setStatus("error", t("unreachable"));
					schedulePoll(Math.min(RETRY_MAX_MS, RETRY_MS * Math.pow(1.6, Math.min(transportFailures, 8))));
				} finally {
					pollInFlight = false;
				}
			}

			// ---- intent ------------------------------------------------------

			/** Turn the decoration off without touching the host. */
			function detachVisuals() {
				running = false;
				if (railFrame) railFrame.classList.remove("dsh-vb-on");
				clearPaint(marks);
				if (rafId) {
					cancelAnimationFrame(rafId);
					rafId = null;
				}
				resetLevels();
			}

			function releaseLease(beacon) {
				if (beacon) {
					try {
						navigator.sendBeacon(
							`${base ?? ""}/volume-bar/bye`,
							new Blob([JSON.stringify({ clientId })], { type: "application/json" }),
						);
					} catch {
						/* best effort */
					}
					return;
				}
				void request("/stop", { method: "POST", timeoutMs: 2000, body: { clientId } }).catch(() => {});
			}

			/**
			 * Apply a user intent. Every async path re-checks `enabled` and its
			 * generation afterwards, so a late `/start` response can never re-enable
			 * a meter the user just switched off (review F02).
			 */
			function setEnabled(next) {
				if (next === enabled) return;
				enabled = next;
				generation += 1;
				settings = { ...settings, enabled: next };
				persist();
				store.set({ enabled: next });
				if (next) {
					recoveries = 0;
					transportFailures = 0;
					lastStatus = null;
					setStatus("starting");
					railDirty = true;
					place(true);
					void ensureStarted(generation);
				} else {
					clearTimers();
					detachVisuals();
					releaseLease(false);
					setStatus("idle");
				}
			}

			/** One write path for every knob, so the store and storage stay in step. */
			function setSetting(patch) {
				const previous = settings;
				settings = { ...settings, ...patch };
				if (patch.sensitivity !== undefined) ref = 0;
				if (patch.preset !== undefined && PRESETS[patch.preset]) attention = 1;
				persist();
				store.set({
					enabled: settings.enabled,
					preset: settings.preset,
					sensitivity: settings.sensitivity,
					amplitude: settings.amplitude,
					speed: settings.speed,
					deviceIndex: settings.deviceIndex,
				});
				if (patch.enabled !== undefined && patch.enabled !== previous.enabled) setEnabled(patch.enabled);
			}

			function applyPreset(key) {
				const preset = PRESETS[key];
				if (!preset) return;
				setSetting({
					preset: key,
					sensitivity: preset.sensitivity,
					amplitude: preset.amplitude,
					speed: preset.speed,
					attackMs: preset.attackMs,
					releaseMs: preset.releaseMs,
				});
			}

			function resetSettings() {
				setSetting({
					preset: DEFAULTS.preset,
					sensitivity: DEFAULTS.sensitivity,
					amplitude: DEFAULTS.amplitude,
					speed: DEFAULTS.speed,
					attackMs: DEFAULTS.attackMs,
					releaseMs: DEFAULTS.releaseMs,
					deviceIndex: null,
				});
			}

			function setDevice(index) {
				settings = { ...settings, deviceIndex: index };
				persist();
				store.set({ deviceIndex: index });
				if (!enabled) return;
				// A pinned device only takes effect on a fresh helper.
				generation += 1;
				clearTimers();
				running = false;
				void ensureStarted(generation);
			}

			function repair() {
				setStatus("installing");
				void request("/setup", { method: "POST", timeoutMs: SETUP_TIMEOUT_MS, body: { force: true } })
					.then(() => {
						if (disposed || !enabled) return;
						recoveries = 0;
						void ensureStarted(++generation);
					})
					.catch(() => {
						if (disposed || !enabled) return;
						setStatus("error", t("unreachable"));
					});
			}

			// ---- wiring -------------------------------------------------------

			const onResize = () => {
				railDirty = true;
				place(true);
			};
			window.addEventListener("resize", onResize);

			// Chromium throttles timers in a hidden window, so visibility is explicit:
			// hidden stops the drawing and the polling (the lease then expires on its
			// own), visible re-asks the host and redraws.
			const onVisibility = () => {
				hidden = document.visibilityState === "hidden";
				if (disposed || !enabled) return;
				generation += 1;
				clearTimers();
				if (hidden) {
					detachVisuals();
					return;
				}
				railDirty = true;
				void ensureStarted(generation);
			};
			document.addEventListener("visibilitychange", onVisibility);

			const onFocus = () => {
				if (disposed || !enabled || hidden) return;
				if (pollTimer || recoverTimer || startPromise) return;
				void ensureStarted(++generation);
			};
			window.addEventListener("focus", onFocus);

			// A real page close says goodbye, so the host drops this lease at once.
			// A page entering the back/forward cache is *not* a close: it must keep
			// its lease, because it may come back within the TTL (review 4.7).
			const onPageHide = (event) => {
				if (!enabled) return;
				if (event?.persisted) {
					hidden = true;
					detachVisuals();
					return;
				}
				releaseLease(true);
			};
			window.addEventListener("pagehide", onPageHide);

			const onPageShow = (event) => {
				if (!event?.persisted) return;
				hidden = document.visibilityState === "hidden";
				if (disposed || !enabled || hidden) return;
				railDirty = true;
				void ensureStarted(++generation);
			};
			window.addEventListener("pageshow", onPageShow);

			// The rail is virtualized and re-created between conversations: watch the
			// DOM, but coalesce bursts into one re-bind per task.
			let mutationPending = false;
			const observer = new MutationObserver(() => {
				railDirty = true;
				if (mutationPending) return;
				mutationPending = true;
				queueMicrotask(() => {
					mutationPending = false;
					if (disposed) return;
					place(true);
				});
			});
			observer.observe(document.body, { childList: true, subtree: true });

			// Moving along the rail is navigation: ease the music back while it lasts.
			const onScroll = () => {
				scrollQuietUntil = performance.now() + 320;
			};
			window.addEventListener("scroll", onScroll, { capture: true, passive: true });

			// Slow safety net for hosts that fire no mutation we can observe.
			const placeTimer = setInterval(() => {
				if (disposed) return;
				place();
			}, 2000);

			place(true);
			setStatus("idle");
			ctx.logger?.info?.("dsh-volume-bar: browser half ready");

			// One-shot beacon: lets the host (and anyone debugging from outside the
			// window) confirm the browser half loaded and found the rail ticks. Only
			// de-identified facts are reported (review 7.5).
			void request("/hello", {
				method: "POST",
				timeoutMs: 2000,
				body: {
					protocolVersion: PROTOCOL_VERSION,
					clientVersion: CLIENT_VERSION,
					marks: marks.length,
					rail: railAdapted ? "adapted" : "missing",
				},
			})
				.then((payload) => {
					if (payload?.leaseTtlMs) leaseTtlMs = payload.leaseTtlMs;
					if (payload?.state) syncHostState(payload.state);
				})
				.catch(() => {});

			// Settings → 音量条 (its own section in the settings sidebar). On a DSH
			// build without that slot the plugin would be unreachable, so it falls
			// back to a single floating toggle instead of going dead.
			let fallbackButton = null;
			function installFallbackToggle(reason) {
				ctx.logger?.warn?.("dsh-volume-bar: settings page unavailable, using the floating toggle", reason);
				if (document.getElementById(BTN_ID)) return;
				const button = document.createElement("button");
				button.id = BTN_ID;
				button.type = "button";
				button.title = "对话音量条（这个 DSH 版本没有设置页可挂，改用这个按钮）";
				button.setAttribute("aria-label", button.title);
				button.addEventListener("click", () => setEnabled(!enabled));
				document.body.appendChild(button);
				const sync = () => {
					button.classList.toggle("dsh-vb-on", enabled);
					button.textContent = enabled ? "❚❚" : "♪";
				};
				store.subscribe(sync);
				sync();
				fallbackButton = button;
			}

			try {
				// One registration, exactly the shape the built-in settings sections use:
				// the shell injects the actions/hooks plus the bound `t`, and the component
				// renders the whole page itself (no nested slot indirection).
				ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "volume-bar",
					order: 30,
					label: () => t("title"),
					locale: NS,
					inject: () => ({
						useVolumeBar: () => useStore(store),
						translate: (key) => t(key),
						setVolumeBarSetting: (patch) => setSetting(patch),
						applyVolumeBarPreset: (key) => applyPreset(key),
						resetVolumeBarSettings: () => resetSettings(),
						setVolumeBarDevice: (index) => setDevice(index),
						repairVolumeBar: () => repair(),
					}),
				}, VolumeBarPanel)), "dsh-volume-bar: settings section");
			} catch (error) {
				installFallbackToggle(error);
			}

			if (enabled) {
				setStatus("starting");
				void ensureStarted(generation);
			}

			ctx.effect(() => () => {
				disposed = true;
				generation += 1;
				observer.disconnect();
				clearInterval(placeTimer);
				clearTimers();
				window.removeEventListener("resize", onResize);
				document.removeEventListener("visibilitychange", onVisibility);
				window.removeEventListener("focus", onFocus);
				window.removeEventListener("pagehide", onPageHide);
				window.removeEventListener("pageshow", onPageShow);
				window.removeEventListener("scroll", onScroll, { capture: true });
				detachVisuals();
				if (enabled) releaseLease(true);
				fallbackButton?.remove();
				document.getElementById(STYLE_ID)?.remove();
				for (const element of document.querySelectorAll(`[${RAIL_ATTR}]`)) element.removeAttribute(RAIL_ATTR);
			});
		};

		return module.exports;
	},
});
