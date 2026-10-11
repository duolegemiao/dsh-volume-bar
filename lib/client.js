/**
 * dsh-volume-bar — browser half.
 *
 * Three jobs:
 *   1. its own page in Settings (设置 → 音量条): switch, sensitivity, amplitude,
 *      response speed, reset;
 *   2. while the meter runs, every turn-rail tick is driven by one frequency
 *      band of the system output;
 *   3. the rail keeps its own states (current turn, hover preview, focus).
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
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Fallback ports to try when a relative request cannot reach the host. */
		const FALLBACK_ORIGINS = ["", "http://127.0.0.1:19387", "http://localhost:19387"];
		const POLL_MS = 45;
		/** Backoff for reconnect attempts after the host dropped the meter or went away. */
		const RETRY_MS = 500;
		const RETRY_MAX_MS = 5000;
		/** How long to wait before asking a host that reported "not running" again. */
		const RECONNECT_MS = 250;
		const BANDS = 8;
		/** Relative band gate: bands below this fraction of the loudest read as silence. */
		const GATE = 0.12;
		const STYLE_ID = "dsh-volume-bar-style";
		const BTN_ID = "dsh-volume-bar-button";
		const STORAGE_KEY = "dsh-volume-bar-settings";
		const NS = "volumeBar";

		const DEFAULTS = { enabled: false, sensitivity: 0.5, amplitude: 0.5, speed: 0.5 };

		const zh = {
			title: "音量条",
			switchTitle: "对话音量条",
			description: "抓系统输出音频，驱动对话右侧的轮次导航栏",
			starting: "正在准备音频助手…",
			running: "运行中",
			device: "输出设备",
			unreachable: "连不上宿主",
			reconnecting: "正在重连",
			sensitivity: "音量检测灵敏度",
			sensitivityHint: "越低越只对响亮的声音有反应，越高越能捕捉细微声音",
			amplitude: "动效幅度",
			amplitudeHint: "刻度伸缩的幅度，越大起伏越夸张",
			speed: "响应速度",
			speedHint: "跟手程度，越快越跳跃，越慢越柔和",
			reset: "恢复默认",
		};
		const en = {
			title: "Volume bar",
			switchTitle: "Dialogue volume bar",
			description: "Drives the conversation turn rail from the system output",
			starting: "Preparing the audio helper…",
			running: "Running",
			device: "Output device",
			unreachable: "Cannot reach the host",
			reconnecting: "Reconnecting",
			sensitivity: "Sensitivity",
			sensitivityHint: "Lower reacts only to loud audio, higher picks up quiet detail",
			amplitude: "Amplitude",
			amplitudeHint: "How far the ticks stretch",
			speed: "Response speed",
			speedHint: "Faster is snappier, slower is smoother",
			reset: "Reset to defaults",
		};

		const CSS = `
/* ---- settings page ------------------------------------------------------- */
.dsh-vb-page { display: flex; flex-direction: column; }
.dsh-vb-row {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-l4, #ececec);
}
.dsh-vb-row:last-child { border-bottom: none; }
.dsh-vb-row-text { min-width: 0; }
.dsh-vb-row-title { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary, #111); }
.dsh-vb-row-desc { font-size: 12px; line-height: 18px; margin-top: 4px; color: var(--dsw-alias-label-secondary, #666); }
.dsh-vb-control { display: flex; align-items: center; gap: 10px; flex: none; }
.dsh-vb-range {
  width: 150px; cursor: pointer; margin: 0;
  accent-color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.dsh-vb-value {
  width: 40px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, #999);
}
.dsh-vb-reset {
  font: inherit; font-size: 13px; cursor: pointer; padding: 6px 12px; border-radius: 8px;
  color: var(--dsw-alias-label-secondary, #666);
  background: transparent; border: 1px solid var(--dsw-alias-border-l4, #ddd);
  transition: color .15s, border-color .15s, background .15s;
}
.dsh-vb-reset:hover {
  color: var(--dsw-alias-label-primary, #111);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08));
}

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

/* ---- turn rail ----------------------------------------------------------- */
/* Only the two animated values are overridden; every state the rail already
   knows about (current turn, hover preview, focus ring) still applies. */
.dsh-vb-on [class*="_mark"]::before {
  transform: translateY(-50%) scaleX(var(--dsh-vb-w, .6)) !important;
  opacity: var(--dsh-vb-o, 1) !important;
  background: var(--dsw-alias-label-primary, #111) !important;
  transition: none !important;
  animation: none !important;
}
`;

		function injectStyle() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		/** Rail ticks: buttons whose class carries the hashed `_mark` suffix. */
		function findMarks() {
			const all = document.querySelectorAll('button[class*="_mark"]');
			const inside = [];
			for (const el of all) {
				const parent = el.parentElement;
				const name = parent ? String(parent.className || "") : "";
				if (/_marks?\b/.test(name)) inside.push(el);
			}
			return inside.length ? inside : Array.prototype.slice.call(all);
		}

		function findRailFrame() {
			const marks = findMarks();
			if (!marks.length) return null;
			let node = marks[0].parentElement;
			while (node && node !== document.body) {
				const name = String(node.className || "");
				if (/_frame\b/.test(name)) return node;
				node = node.parentElement;
			}
			return marks[0].parentElement;
		}

		/** Map rail tick index (top = newest turn) onto a band (bottom = bass). */
		function bandFor(index, total, bands) {
			if (total <= 1) return 0;
			const fromBottom = total - 1 - index;
			return Math.min(bands - 1, Math.floor((fromBottom * bands) / total));
		}

		function clamp01(value) {
			return value < 0 ? 0 : value > 1 ? 1 : value;
		}

		/**
		* User knobs -> meter constants.
		*   sensitivity 0..1 : noise floor from -30 dB (only loud) to -70 dB (very quiet)
		*   amplitude   0..1 : rest length 0.75 (subtle) .. 0.25 (dramatic)
		*   speed       0..1 : attack/release smoothing per frame
		*/
		function tune(settings) {
			const sensitivity = clamp01(settings.sensitivity ?? DEFAULTS.sensitivity);
			const amplitude = clamp01(settings.amplitude ?? DEFAULTS.amplitude);
			const speed = clamp01(settings.speed ?? DEFAULTS.speed);
			return {
				floor: 0.0003 * Math.pow(10, (1 - sensitivity) * 2),
				restWidth: 0.75 - amplitude * 0.5,
				restOpacity: 0.55 - amplitude * 0.5,
				attack: 0.15 + speed * 0.7,
				release: 0.03 + speed * 0.12,
				/** How fast the shared reference lets go of a past peak. */
				agcRelease: 0.995 - speed * 0.02,
			};
		}

		function readSettings() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				if (!raw) return { ...DEFAULTS };
				const parsed = JSON.parse(raw);
				return {
					enabled: parsed.enabled === true,
					sensitivity: Number(parsed.sensitivity ?? DEFAULTS.sensitivity),
					amplitude: Number(parsed.amplitude ?? DEFAULTS.amplitude),
					speed: Number(parsed.speed ?? DEFAULTS.speed),
				};
			} catch {
				return { ...DEFAULTS };
			}
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

		/** One settings row: text on the left, control on the right. */
		function Row({ title, description, children }) {
			return jsxs("div", {
				className: "dsh-vb-row",
				children: [
					jsxs("div", {
						className: "dsh-vb-row-text",
						children: [
							jsx("div", { className: "dsh-vb-row-title", children: title }),
							description ? jsx("div", { className: "dsh-vb-row-desc", children: description }) : null,
						],
					}),
					jsx("div", { className: "dsh-vb-control", children }),
				],
			});
		}

		/** A 0..1 knob rendered as a range input with a live percentage. */
		function Knob({ id, value, onInput }) {
			return [
				jsx("input", {
					key: "range",
					id,
					className: "dsh-vb-range",
					type: "range",
					min: "0",
					max: "100",
					step: "1",
					value: String(Math.round(value * 100)),
					onChange: (event) => onInput(Number(event.target.value) / 100),
				}),
				jsx("span", { key: "value", className: "dsh-vb-value", children: `${Math.round(value * 100)}%` }),
			];
		}

		/** The whole 音量条 settings page. */
		function VolumeBarPanel(props) {
			const state = props.useVolumeBar((value) => value);
			const t = props.t;
			const set = props.setVolumeBarSetting;
			let status = t("description");
			if (state.status === "starting") status = t("starting");
			else if (state.status === "on") status = t("running") + (state.device ? ` · ${t("device")}: ${state.device}` : "");
			else if (state.status === "error") status = state.message || t("unreachable");
			return jsxs("div", {
				className: "dsh-vb-page",
				children: [
					jsx(Row, {
						title: t("switchTitle"),
						description: status,
						children: jsx(primitives.Switch, {
							checked: state.enabled,
							label: t("switchTitle"),
							onChange: (next) => set({ enabled: next }),
						}),
					}, "switch"),
					jsx(Row, {
						title: t("sensitivity"),
						description: t("sensitivityHint"),
						children: Knob({ id: "dsh-vb-sensitivity", value: state.sensitivity, onInput: (v) => set({ sensitivity: v }) }),
					}, "sensitivity"),
					jsx(Row, {
						title: t("amplitude"),
						description: t("amplitudeHint"),
						children: Knob({ id: "dsh-vb-amplitude", value: state.amplitude, onInput: (v) => set({ amplitude: v }) }),
					}, "amplitude"),
					jsx(Row, {
						title: t("speed"),
						description: t("speedHint"),
						children: Knob({ id: "dsh-vb-speed", value: state.speed, onInput: (v) => set({ speed: v }) }),
					}, "speed"),
					jsx("div", {
						className: "dsh-vb-row",
						children: [
							jsx("div", { className: "dsh-vb-row-text" }),
							jsx("div", {
								className: "dsh-vb-control",
								children: jsx("button", {
									type: "button",
									className: "dsh-vb-reset",
									onClick: () => props.resetVolumeBarSettings(),
									children: t("reset"),
								}),
							}),
						],
					}, "reset"),
				],
			});
		}

		/** The settings page body: renders the child slot the section declares. */
		function VolumeBarSection({ renderSlot }) {
			return renderSlot("volume-bar.item", {});
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

			let base = null;
			let pollTimer = null;
			let rafId = null;
			let marks = [];
			let frameEl = null;
			let failures = 0;
			let reconnects = 0;
			let running = false;
			let status = "idle"; // idle | starting | on | error
			let message = "";

			let settings = readSettings();

			const agc = new Array(BANDS).fill(0);
			const target = new Array(BANDS).fill(0);
			const smooth = new Array(BANDS).fill(0);
			/** Per-tick hover boost, eased so hovering animates like the rail's own states. */
			const boost = new WeakMap();
			let lastFrameAt = 0;
			let ref = 0;

			const store = createStore({
				enabled: settings.enabled,
				status: "idle",
				message: "",
				device: null,
				bands: BANDS,
				sensitivity: settings.sensitivity,
				amplitude: settings.amplitude,
				speed: settings.speed,
			});

			function setStatus(next, text) {
				status = next;
				message = text || "";
				store.set({ status: next, message: message });
			}

			function persist() {
				try {
					window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
				} catch {
					/* storage may be unavailable */
				}
			}

			function place() {
				const frame = findRailFrame();
				if (frame && frame !== frameEl) {
					if (frameEl && running) frameEl.classList.remove("dsh-vb-on");
					frameEl = frame;
					if (running) frameEl.classList.add("dsh-vb-on");
				}
			}

			async function call(path, method) {
				const origins = base === null ? FALLBACK_ORIGINS : [base];
				let lastError = null;
				for (const origin of origins) {
					try {
						const response = await fetch(`${origin}/volume-bar${path}`, {
							method: method || "GET",
							cache: "no-store",
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						if (base === null) base = origin;
						return await response.json();
					} catch (error) {
						lastError = error;
					}
				}
				throw lastError || new Error("unreachable");
			}

			/** Same as call(), but ships a small JSON body (used by the beacon). */
			async function post(path, body) {
				const origins = base === null ? FALLBACK_ORIGINS : [base];
				let lastError = null;
				for (const origin of origins) {
					try {
						const response = await fetch(`${origin}/volume-bar${path}`, {
							method: "POST",
							cache: "no-store",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(body),
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						if (base === null) base = origin;
						return await response.json();
					} catch (error) {
						lastError = error;
					}
				}
				throw lastError || new Error("unreachable");
			}

			function resetLevels() {
				for (let i = 0; i < BANDS; i++) {
					agc[i] = 0;
					target[i] = 0;
					smooth[i] = 0;
				}
				ref = 0;
			}

			function ingest(level) {
				if (!level) return;
				const { floor, agcRelease } = tune(settings);
				const bands = Array.isArray(level.bands) ? level.bands : [];
				let maxRaw = 0;
				for (let i = 0; i < BANDS; i++) {
					const raw = Number(bands[i] ?? 0) || 0;
					agc[i] = raw;
					if (raw > maxRaw) maxRaw = raw;
				}
				// One shared reference with slow release: quiet bands then read as
				// quiet instead of being amplified up to the loud ones.
				ref = Math.max(maxRaw, ref * agcRelease, floor);
				for (let i = 0; i < BANDS; i++) {
					const ratio = agc[i] / ref;
					// soft gate: everything below GATE reads as silence
					const norm = clamp01((ratio - GATE) / (1 - GATE));
					target[i] = Math.pow(norm, 0.6);
				}
				lastFrameAt = performance.now();
			}

			function draw() {
				rafId = requestAnimationFrame(draw);
				const now = performance.now();
				if (running && lastFrameAt && now - lastFrameAt > 400) {
					// stream went quiet: let everything fall back to rest
					for (let i = 0; i < BANDS; i++) target[i] = 0;
				}
				const { restWidth, restOpacity, attack, release } = tune(settings);
				const found = findMarks();
				if (found.length !== marks.length) marks = found;
				for (let i = 0; i < BANDS; i++) {
					const to = target[i];
					smooth[i] += (to - smooth[i]) * (to > smooth[i] ? attack : release);
				}

				if (!running) return;
				const paint = (el, value, floorWidth, floorOpacity) => {
					const width = Math.max(floorWidth, restWidth + value * (1 - restWidth));
					const opacity = Math.max(floorOpacity, restOpacity + value * (1 - restOpacity));
					el.style.setProperty("--dsh-vb-w", width.toFixed(3));
					el.style.setProperty("--dsh-vb-o", opacity.toFixed(3));
				};
				const total = marks.length;
				// A conversation with no turns has no rail to drive: draw nothing.
				// (The plugin is an easter egg on the rail, not an overlay of its own.)
				if (total === 0) return;
				for (let i = 0; i < total; i++) {
					const el = marks[i];
					const isActive = /_markActive/.test(String(el.className));
					const isHovered = el.matches(":hover");
					const previous = boost.get(el) ?? 0;
					const next = previous + ((isHovered ? 1 : 0) - previous) * (isHovered ? 0.3 : 0.2);
					boost.set(el, next);
					// The rail's own states win: the current turn stays full and
					// dark, a hovered tick grows the way its preview state used to.
					const music = smooth[bandFor(i, total, BANDS)];
					const value = Math.max(music, isActive ? 1 : 0, next);
					paint(el, value, isActive ? 1 : 0, isActive ? 0.85 : 0);
				}
			}

			/** Queue the next poll. A timeout (not an interval) so failures can back off. */
			function schedulePoll(delay) {
				if (pollTimer) clearTimeout(pollTimer);
				pollTimer = setTimeout(() => {
					pollTimer = null;
					void poll();
				}, delay);
			}

			/**
			* One poll. Never gives up while the switch is on: a host that dropped the
			* meter (idle watchdog, restarted host, reloaded plugin) is asked again, and
			* transport failures retry with backoff. Chromium throttles timers in a
			* hidden window, so "the page went to the background" must not be fatal.
			*/
			async function poll() {
				if (!running) return;
				try {
					const payload = await call("/levels");
					failures = 0;
					reconnects = 0;
					if (payload && payload.level) ingest(payload.level);
					if (payload && payload.device) store.set({ device: payload.device });
					if (payload && payload.running === false) {
						schedulePoll(RECONNECT_MS);
						void reconnect();
						return;
					}
					if (status !== "on") setStatus("on");
					schedulePoll(POLL_MS);
				} catch (error) {
					failures += 1;
					// Drop the cached transport so the next attempt re-probes it.
					base = null;
					setStatus("error", `${t("reconnecting")}（${failures}）`);
					schedulePoll(Math.min(RETRY_MAX_MS, RETRY_MS * Math.pow(1.5, Math.min(failures, 8))));
				}
			}

			/** Ask the host for the meter again after it went away. */
			async function reconnect() {
				if (!running) return;
				reconnects += 1;
				base = null;
				setStatus("starting");
				try {
					const payload = await call("/start", "POST");
					if (payload && payload.ok === false) {
						setStatus("error", payload.error || "启动失败");
						schedulePoll(Math.min(RETRY_MAX_MS, RETRY_MS * reconnects));
						return;
					}
					marks = findMarks();
					if (frameEl) frameEl.classList.add("dsh-vb-on");
					setStatus("on");
					// Back off if the host keeps reporting "not running" right after a
					// start, so a stuck host cannot turn into a hammer. A single
					// successful poll resets this to the normal cadence.
					schedulePoll(Math.min(RETRY_MAX_MS, RECONNECT_MS * Math.pow(1.5, Math.min(reconnects, 8))));
				} catch (error) {
					setStatus("error", `${t("reconnecting")}（${reconnects}）`);
					schedulePoll(Math.min(RETRY_MAX_MS, RETRY_MS * Math.pow(1.5, Math.min(reconnects, 8))));
				}
			}

			async function start() {
				setStatus("starting");
				resetLevels();
				place();
				try {
					const payload = await call("/start", "POST");
					if (payload && payload.ok === false) {
						setStatus("error", payload.error || "启动失败");
						schedulePoll(RETRY_MAX_MS);
						return;
					}
				} catch (error) {
					setStatus("error", `${t("reconnecting")}（${error && error.message ? error.message : error}）`);
					schedulePoll(RETRY_MS);
					return;
				}
				running = true;
				if (frameEl) frameEl.classList.add("dsh-vb-on");
				marks = findMarks();
				setStatus("on");
				schedulePoll(POLL_MS);
				if (!rafId) rafId = requestAnimationFrame(draw);
			}

			function stop(silent) {
				running = false;
				if (frameEl) frameEl.classList.remove("dsh-vb-on");
				for (const el of marks) {
					el.style.removeProperty("--dsh-vb-w");
					el.style.removeProperty("--dsh-vb-o");
				}
				if (pollTimer) {
					clearTimeout(pollTimer);
					pollTimer = null;
				}
				if (rafId) {
					cancelAnimationFrame(rafId);
					rafId = null;
				}
				resetLevels();
				if (!silent) setStatus("idle");
				void call("/stop", "POST").catch(() => {});
			}

			/** One write path for every knob, so the store and storage stay in step. */
			function setSetting(patch) {
				const next = { ...settings, ...patch };
				settings = next;
				// A new sensitivity means a new noise floor: drop the old reference so
				// the change is audible immediately instead of after a slow release.
				if (patch.sensitivity !== undefined) ref = 0;
				persist();
				store.set({
					enabled: next.enabled,
					sensitivity: next.sensitivity,
					amplitude: next.amplitude,
					speed: next.speed,
				});
				if (patch.enabled !== undefined) {
					if (next.enabled) void start();
					else stop(false);
				}
			}

			function resetSettings() {
				setSetting({ sensitivity: DEFAULTS.sensitivity, amplitude: DEFAULTS.amplitude, speed: DEFAULTS.speed });
			}

			const onResize = () => place();
			window.addEventListener("resize", onResize);
			// Chromium throttles timers in a hidden window, so waking up is an explicit
			// event: check the host right away instead of waiting out a slow timer.
			const onWake = () => {
				if (!running) return;
				if (document.visibilityState !== "visible") return;
				if (pollTimer) clearTimeout(pollTimer);
				pollTimer = null;
				void poll();
			};
			document.addEventListener("visibilitychange", onWake);
			window.addEventListener("focus", onWake);
			// A real page close says goodbye, so the host can release the meter at once
			// instead of waiting for its idle watchdog.
			const onPageHide = () => {
				if (!running) return;
				try {
					navigator.sendBeacon(`${base ?? ""}/volume-bar/bye`);
				} catch {
					/* beacon is best effort */
				}
			};
			window.addEventListener("pagehide", onPageHide);
			const observer = new MutationObserver(() => {
				place();
				if (!running) return;
				const next = findMarks();
				if (next.length !== marks.length) {
					for (const el of marks) {
						el.style.removeProperty("--dsh-vb-w");
						el.style.removeProperty("--dsh-vb-o");
					}
					marks = next;
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			const placeTimer = setInterval(place, 2000);
			place();
			setStatus("idle");
			ctx.logger?.info?.("dsh-volume-bar: browser half ready");

			// One-shot beacon: lets the host (and anyone debugging from outside the
			// window) confirm the browser half loaded and found the rail ticks.
			void post("/hello", {
				marks: findMarks().length,
				href: location.href,
				origin: location.origin,
			}).catch(() => {});

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
				button.addEventListener("click", () => setSetting({ enabled: !settings.enabled }));
				document.body.appendChild(button);
				const sync = () => {
					button.classList.toggle("dsh-vb-on", settings.enabled);
					button.textContent = settings.enabled ? "❚❚" : "♪";
				};
				store.subscribe(sync);
				sync();
				fallbackButton = button;
			}

			try {
				ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "volume-bar",
					order: 30,
					label: () => t("title"),
					locale: NS,
					children: { "volume-bar.item": { kind: "list", scope: "root" } },
				}, VolumeBarSection)), "dsh-volume-bar: settings section");
				ctx.effect(() => ctx.slots.inject("volume-bar.item", () => ctx.slots.register({
					name: "volume-bar.item",
					id: "panel",
					order: 0,
					locale: NS,
					inject: () => ({
						hooks: { volumeBar: store },
						setVolumeBarSetting: (patch) => setSetting(patch),
						resetVolumeBarSettings: () => resetSettings(),
					}),
				}, VolumeBarPanel)), "dsh-volume-bar: settings panel");
			} catch (error) {
				installFallbackToggle(error);
			}

			if (settings.enabled) void start();

			ctx.effect(() => () => {
				observer.disconnect();
				clearInterval(placeTimer);
				window.removeEventListener("resize", onResize);
				document.removeEventListener("visibilitychange", onWake);
				window.removeEventListener("focus", onWake);
				window.removeEventListener("pagehide", onPageHide);
				stop(true);
				fallbackButton?.remove();
				document.getElementById(STYLE_ID)?.remove();
			});
		};

		return module.exports;
	},
});
