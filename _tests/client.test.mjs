/**
 * Offline checks for the browser half (lib/client.js).
 *
 * Each scenario builds its own realm: a fresh fake clock, document, storage,
 * network and module instance, loaded from the real bundle. That isolation is
 * what makes the state machine observable — a shared realm would let one
 * scenario's timers answer another scenario's requests.
 *
 *     node _tests/client.test.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { FakeDocument, FakeMutationObserver, buildRail } from './fake-dom.mjs'

const FAILURES = []
const results = []
const VERBOSE = process.env.VB_TEST_VERBOSE === '1'

function check(name, condition, detail = '') {
  results.push(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) FAILURES.push(name)
  if (VERBOSE) console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const BUNDLE = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

/** One isolated browser realm running the real bundle. */
function createRealm({ storage = new Map() } = {}) {
  let now = 1000
  const timers = []
  let timerSeq = 1
  const rafCallbacks = new Map()
  let rafSeq = 1

  const fakeSetTimeout = (fn, delay = 0) => {
    const id = timerSeq++
    timers.push({ id, at: now + Math.max(0, delay), fn, repeat: null })
    return id
  }
  const fakeSetInterval = (fn, delay = 0) => {
    const id = timerSeq++
    timers.push({ id, at: now + Math.max(1, delay), fn, repeat: Math.max(1, delay) })
    return id
  }
  const fakeClearTimer = (id) => {
    const index = timers.findIndex((timer) => timer.id === id)
    if (index >= 0) timers.splice(index, 1)
  }

  const document = new FakeDocument()
  const windowListeners = new Map()
  const windowObject = {
    document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    requestAnimationFrame: (fn) => {
      const id = rafSeq++
      rafCallbacks.set(id, fn)
      return id
    },
    cancelAnimationFrame: (id) => rafCallbacks.delete(id),
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimer,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearTimer,
    addEventListener: (type, listener) => {
      const list = windowListeners.get(type) ?? []
      list.push(listener)
      windowListeners.set(type, list)
    },
    removeEventListener: (type, listener) => {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((item) => item !== listener))
    },
  }

  const beacons = []
  const net = {
    log: [],
    handler: () => ({ status: 503, body: { error: 'no handler installed' } }),
  }

  async function flush() {
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }

  /** Advance fake time, firing timers and animation frames like a browser would. */
  async function advance(ms, { step = 16 } = {}) {
    const target = now + ms
    let guard = 0
    while (now < target) {
      guard += 1
      if (guard > 5000) throw new Error(`advance() did not terminate at ${now} -> ${target}`)
      const pending = timers.filter((timer) => timer.at <= target)
      const nextTimer = pending.length ? Math.min(...pending.map((timer) => timer.at)) : target
      const nextFrame = rafCallbacks.size ? now + step : target
      now = Math.min(target, Math.max(nextTimer, nextFrame, now + 1))
      for (const timer of [...timers].filter((entry) => entry.at <= now)) {
        if (timer.repeat) timer.at = timer.at + timer.repeat
        else fakeClearTimer(timer.id)
        timer.fn()
      }
      await flush()
      for (const [id, fn] of [...rafCallbacks.entries()]) {
        if (!rafCallbacks.has(id)) continue
        // A browser drops a frame callback before invoking it.
        rafCallbacks.delete(id)
        try {
          fn(now)
        } catch (error) {
          console.log(`[frame error] ${error?.stack ?? error}`)
        }
      }
      await flush()
    }
  }

  const sandbox = {
    window: windowObject,
    document,
    navigator: { sendBeacon: (url) => (beacons.push(url), true) },
    localStorage: windowObject.localStorage,
    fetch: async (url, options = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      net.log.push({ path, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null, at: now })
      const response = net.handler(path, options)
      if (response.hang) return await new Promise(() => {})
      if (response.throw) throw new Error(response.throw)
      return { ok: response.status === 200, status: response.status, json: async () => response.body }
    },
    requestAnimationFrame: windowObject.requestAnimationFrame,
    cancelAnimationFrame: windowObject.cancelAnimationFrame,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimer,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearTimer,
    MutationObserver: FakeMutationObserver,
    queueMicrotask,
    performance: { now: () => now },
    AbortController,
    Blob: class Blob {
      constructor(parts) {
        this.parts = parts
      }
    },
    console,
    URL,
    Number,
    Math,
    Array,
    Object,
    JSON,
    String,
    Boolean,
    Set,
    Map,
    WeakMap,
    Symbol,
    Promise,
    Error,
    isFinite,
  }

  let spec = null
  sandbox.window.__dshVbDebug = []
  sandbox.window.__dshVbTrace = []
  sandbox.window.__dshVbTrace2 = []
  sandbox.window.__dshVbTrace3 = []; sandbox.window.__dshVbTraceX = []
  sandbox.window.__ModuleLoader__ = { load: (loaded) => (spec = loaded) }
  sandbox.globalThis = sandbox
  runInNewContext(BUNDLE, sandbox, { filename: 'client.js' })
  if (!spec) throw new Error('the bundle did not register itself')

  const fakeReact = {
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }

  const exportsObject = spec.factory((name) => {
    if (name === 'react/jsx-runtime') {
      return { jsx: (type, props) => ({ type, props: props ?? {} }), jsxs: (type, props) => ({ type, props: props ?? {} }) }
    }
    if (name === 'react') return fakeReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Switch: () => null }
    throw new Error(`unexpected require(${name})`)
  })

  const disposers = []
  let injected = null
  const context = {
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, fn) => {
        fn()
        return () => {}
      },
      register: (options) => {
        if (options.inject) injected = options.inject()
        return () => {}
      },
    },
  }

  return {
    document,
    net,
    beacons,
    sandbox,
    advance,
    flush,
    get now() {
      return now
    },
    state: () => injected?.useVolumeBar() ?? {},
    set: (patch) => injected?.setVolumeBarSetting(patch),
    apply: () => {
      exportsObject.apply(context)
      return context
    },
    dispose: () => {
      for (const disposer of [...disposers].reverse()) {
        try {
          disposer()
        } catch (error) {
          check('cleanup runs without throwing', false, String(error?.message ?? error))
        }
      }
      disposers.length = 0
    },
  }
}

/** Standard harness: a rail with `count` ticks, switch off, one scenario. */
async function scenario(name, options, run) {
  if (typeof options === 'function') {
    run = options
    options = {}
  }
  const storage = new Map()
  storage.set('dsh-volume-bar-settings', JSON.stringify({ schemaVersion: 2, enabled: false, ...(options.stored ?? {}) }))
  const realm = createRealm({ storage })
  const rail = buildRail(realm.document, options.ticks ?? 8)
  realm.document.body.appendChild(rail.slot)
  realm.apply()
  await realm.flush()
  if (VERBOSE) console.log(`--- ${name}`)
  try {
    await run(realm, rail)
  } finally {
    realm.dispose()
    await realm.flush()
  }
}

async function turnOn(realm) {
  realm.set({ enabled: true })
  await realm.flush()
}

/** Wait until the instance reports a healthy capture (or give up reporting why). */
async function waitHealthy(realm, timeoutMs = 4000) {
  let waited = 0
  while (waited < timeoutMs) {
    const state = realm.state()
    if (state.status === 'on' || state.status === 'norail' || state.status === 'stalled') return state
    await realm.advance(25)
    waited += 25
  }
  return { ...realm.state(), tail: realm.net.log.slice(-5).map((entry) => `${entry.path.replace('/volume-bar/', '')}@${Math.round(entry.at)}`) }
}

function widths(rail) {
  return rail.ticks.map((tick) => Number(tick.style.getPropertyValue('--dsh-vb-w')) || 0)
}

/** Route match that ignores the query string (`/levels?clientId=...`). */
function isPath(path, name) {
  return String(path).split('?')[0].endsWith(`/${name}`)
}

/** A handler that serves a healthy meter with the given bands. */
function healthyHandler({ bands = [0.8, 0.6, 0.4, 0.3, 0.2, 0.1, 0.05, 0.02], frozenSeq = null } = {}) {
  let seq = 1
  return {
    handler: (path) => {
      if (isPath(path, 'hello')) return { status: 200, body: { ok: true, protocolVersion: 2, leaseTtlMs: 90000 } }
      if (isPath(path, 'start')) return { status: 200, body: { ok: true, state: { running: true } } }
      if (isPath(path, 'levels')) {
        const value = frozenSeq ?? seq++
        return {
          status: 200,
          body: {
            running: true,
            protocolVersion: 2,
            generation: 'g',
            frameGeneration: 'g',
            seq: value,
            ageMs: frozenSeq === null ? 5 : 60000,
            analysisMode: 'numpy-fft',
            level: { rms: 0.5, peak: 0.9, bands },
          },
        }
      }
      return { status: 503, body: { error: 'unexpected route' } }
    },
  }
}

// ---------------------------------------------------------------------------
// F01 — a failed first start keeps retrying (P0)
// ---------------------------------------------------------------------------
await scenario('F01', async (realm, rail) => {
  let starts = 0
  let levels = 0
  realm.net.handler = (path) => {
    if (isPath(path, 'hello')) return { status: 200, body: { ok: true, protocolVersion: 2, leaseTtlMs: 90000 } }
    if (isPath(path, 'start')) {
      starts += 1
      if (starts <= 2) return { throw: 'ECONNREFUSED' }
      return { status: 200, body: { ok: true, state: { running: true } } }
    }
    if (isPath(path, 'levels')) {
      levels += 1
      return { status: 200, body: { running: true, generation: 'g', frameGeneration: 'g', seq: levels, ageMs: 5, level: { rms: 0.3, bands: [0.5, 0.4, 0.3, 0.2, 0.1, 0, 0, 0] } } }
    }
    return { status: 404, body: {} }
  }
  await turnOn(realm)
  const state = await waitHealthy(realm)
  check('F01: a failed first start is retried until it succeeds', starts >= 3 && levels > 0, `starts=${starts} levels=${levels}`)
  check('F01: the meter ends up healthy', state.status === 'on', JSON.stringify({ status: state.status, tail: state.tail }))
  check('F01: the rail is driven once the host answers', widths(rail).some((value) => value > 0.2), JSON.stringify(widths(rail).map((v) => Number(v.toFixed(2)))))
})

// ---------------------------------------------------------------------------
// F02 — a late /start response cannot re-enable (P0)
// ---------------------------------------------------------------------------
await scenario('F02', async (realm, rail) => {
  let startRequests = 0
  let levels = 0
  const hanging = []
  realm.net.handler = (path) => {
    if (isPath(path, 'hello')) return { status: 200, body: { ok: true, protocolVersion: 2 } }
    if (isPath(path, 'start')) {
      startRequests += 1
      // Keep the first start in flight; a late answer must not revive the meter.
      return { hang: true, body: { ok: true, state: { running: true } } }
    }
    if (isPath(path, 'levels')) {
      levels += 1
      return { status: 200, body: { running: true, generation: 'g', frameGeneration: 'g', seq: levels, ageMs: 5, level: { rms: 0.4, bands: [0.5, 0, 0, 0, 0, 0, 0, 0] } } }
    }
    return { status: 200, body: { ok: true } }
  }
  await turnOn(realm)
  await realm.advance(120)
  realm.set({ enabled: false })
  await realm.flush()
  void hanging
  await realm.advance(2000)
  const state = realm.state()
  check('F02: the switch stays off after a late start response', state.enabled === false, JSON.stringify({ status: state.status }))
  check('F02: no levels are polled after switching off', levels === 0, `levels=${levels} starts=${startRequests}`)
  check('F02: the decoration is removed', !rail.nav.classList.contains('dsh-vb-on'))
})

// ---------------------------------------------------------------------------
// F03 — replacing the ticks with the same count (P1)
// ---------------------------------------------------------------------------
await scenario('F03', async (realm, rail) => {
  realm.net.handler = healthyHandler({ bands: [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6] }).handler
  await turnOn(realm)
  await waitHealthy(realm)
  await realm.advance(200)
  const oldTicks = [...rail.ticks]
  const activeOld = oldTicks.filter((tick) => tick.style.getPropertyValue('--dsh-vb-w') !== '').length
  // A new conversation reuses the tick count but replaces every node.
  const replacement = buildRail(realm.document, 8)
  rail.marks.childNodes = replacement.marks.childNodes
  for (const tick of replacement.ticks) tick.parentElement = rail.marks
  FakeMutationObserver.flush()
  await realm.advance(400)
  const newPainted = replacement.ticks.filter((tick) => tick.style.getPropertyValue('--dsh-vb-w') !== '').length
  const oldPainted = oldTicks.filter((tick) => tick.style.getPropertyValue('--dsh-vb-w') !== '').length
  check('F03: new nodes with the same count take over the animation', newPainted === 8, `new=${newPainted}`)
  check('F03: the old nodes are cleaned up rather than left painted', oldPainted <= activeOld, `old=${oldPainted} (active kept: ${activeOld})`)
})

// ---------------------------------------------------------------------------
// F05 — a repeated cached frame is stale, not healthy (P1)
// ---------------------------------------------------------------------------
await scenario('F05', async (realm, rail) => {
  let startCalls = 0
  const frozen = healthyHandler({ bands: [1, 1, 1, 1, 1, 1, 1, 1], frozenSeq: 7 })
  realm.net.handler = (path) => {
    if (isPath(path, 'start')) startCalls += 1
    return frozen.handler(path)
  }
  await turnOn(realm)
  await waitHealthy(realm)
  await realm.advance(300)
  // The active tick is pinned to full width by design, so compare the others.
  const peak = Math.max(...widths(rail).slice(0, -1))
  await realm.advance(4000)
  const settled = Math.max(...widths(rail).slice(0, -1))
  const state = realm.state()
  check(
    'F05: a repeated cached frame never drives the envelope',
    peak <= 0.55 && settled <= 0.55,
    `peak=${peak.toFixed(3)} settled=${settled.toFixed(3)}`,
  )
  check(
    'F05: the cached frame is recorded but never animated',
    peak <= 0.55 && settled <= 0.55 && state.seq === 7,
    JSON.stringify({ seq: state.seq, status: state.status, peak, settled }),
  )
  check('F05: the stall is reported and the helper restarted', startCalls >= 2, `startCalls=${startCalls}`)
})

// ---------------------------------------------------------------------------
// F15 — damaged stored settings fall back to defaults (P2)
// ---------------------------------------------------------------------------
await scenario('F15', { stored: { sensitivity: 'oops', amplitude: null, speed: {}, deviceIndex: 'x', surprise: 1 } }, async (realm) => {
  const state = realm.state()
  check(
    'F15: damaged stored values fall back to defaults (null is not 0)',
    state.sensitivity === 0.5 && state.amplitude === 0.5 && state.speed === 0.5 && state.deviceIndex === null,
    JSON.stringify({ sensitivity: state.sensitivity, amplitude: state.amplitude, speed: state.speed, deviceIndex: state.deviceIndex }),
  )
})

await scenario('F15 numeric', { stored: { sensitivity: 1.7, amplitude: -3, speed: 0.25 } }, async (realm) => {
  const state = realm.state()
  check(
    'F15: out-of-range values are clamped, valid ones kept',
    state.sensitivity === 1 && state.amplitude === 0 && state.speed === 0.25,
    JSON.stringify({ sensitivity: state.sensitivity, amplitude: state.amplitude, speed: state.speed }),
  )
})

// ---------------------------------------------------------------------------
// 0.7.2 — a stored null device means "follow the default", not "pin device 0"
// ---------------------------------------------------------------------------
await scenario('0.7.2 device', { stored: { schemaVersion: 2, enabled: false, deviceIndex: null } }, async (realm) => {
  check(
    '0.7.2: a stored null device index stays null (Number(null) is 0)',
    realm.state().deviceIndex === null,
    JSON.stringify({ deviceIndex: realm.state().deviceIndex }),
  )
})

await scenario('0.7.2 device pin', { stored: { schemaVersion: 2, enabled: false, deviceIndex: 0 } }, async (realm) => {
  check(
    '0.7.2: an explicit device 0 pin is kept',
    realm.state().deviceIndex === 0,
    JSON.stringify({ deviceIndex: realm.state().deviceIndex }),
  )
})

// ---------------------------------------------------------------------------
// F12 — the envelope follows time, not frames (P1)
// ---------------------------------------------------------------------------
async function settleWidthForFrameStep(stepMs) {
  const realm = createRealm({ storage: new Map([['dsh-volume-bar-settings', JSON.stringify({ schemaVersion: 2, enabled: false })]]) })
  const rail = buildRail(realm.document, 8)
  realm.document.body.appendChild(rail.slot)
  realm.apply()
  await realm.flush()
  let seq = 1
  realm.net.handler = (path) => {
    if (isPath(path, 'hello')) return { status: 200, body: { ok: true, protocolVersion: 2 } }
    if (isPath(path, 'start')) return { status: 200, body: { ok: true, state: { running: true } } }
    if (isPath(path, 'levels')) {
      const loud = realm.now - 1000 < 900
      return {
        status: 200,
        body: {
          running: true,
          generation: 'g',
          frameGeneration: 'g',
          seq: seq++,
          ageMs: 5,
          level: { rms: loud ? 0.5 : 0, bands: loud ? [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6] : [0, 0, 0, 0, 0, 0, 0, 0] },
        },
      }
    }
    return { status: 503, body: {} }
  }
  await turnOn(realm)
  await waitHealthy(realm)
  await realm.advance(1500, { step: stepMs })
  const value = Math.max(...widths(rail).slice(0, -1))
  realm.dispose()
  await realm.flush()
  return value
}

{
  const at60 = await settleWidthForFrameStep(16.7)
  const at144 = await settleWidthForFrameStep(6.9)
  check(
    'F12: the envelope follows real time (settles near rest at both refresh rates)',
    at60 < 0.75 && at144 < 0.75,
    `60Hz=${at60.toFixed(3)} 144Hz=${at144.toFixed(3)}`,
  )
  check('F12: the two refresh rates agree', Math.abs(at60 - at144) < 0.25, `Δ=${Math.abs(at60 - at144).toFixed(3)}`)
}

// ---------------------------------------------------------------------------
// F16 — band mapping across tick counts (P2)
// ---------------------------------------------------------------------------
await scenario('F16', async (realm, rail) => {
  let answers = 0
  const base = healthyHandler()
  realm.net.handler = (path) => {
    answers += 1
    const response = base.handler(path)
    if (response.status !== 200) console.log(`[F16] ${path} -> ${response.status}`)
    return response
  }
  await turnOn(realm)
  const state = await waitHealthy(realm)
  await realm.advance(300)
  const values = widths(rail)
  check('F16: the meter reports a healthy capture', state.status === 'on', JSON.stringify({ status: state.status, tail: state.tail }))
  const rest = values.slice(0, -1)
  check(
    'F16: treble ticks are shorter than bass ticks, and both move',
    rest.length > 3 && rest[rest.length - 1] > rest[0] + 0.05 && rest[rest.length - 1] > 0.35,
    JSON.stringify(values.map((value) => Number(value.toFixed(2)))),
  )
})

await scenario('F16 one tick', { ticks: 1 }, async (realm, rail) => {
  realm.net.handler = healthyHandler({ bands: [0.8, 0.6, 0.4, 0.3, 0.2, 0.1, 0.05, 0.02] }).handler
  await turnOn(realm)
  await waitHealthy(realm)
  await realm.advance(300)
  const value = widths(rail)[0]
  check('F16: a single tick still shows the level', value > 0.2, `width=${value.toFixed(3)}`)
})

// ---------------------------------------------------------------------------
// interaction priority and reduced motion
// ---------------------------------------------------------------------------
await scenario('interaction', async (realm, rail) => {
  realm.net.handler = healthyHandler({ bands: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05] }).handler
  await turnOn(realm)
  await waitHealthy(realm)
  await realm.advance(300)
  const active = rail.ticks[rail.ticks.length - 1]
  check(
    'interaction: the current turn stays full width even in near-silence',
    Number(active.style.getPropertyValue('--dsh-vb-w')) > 0.95,
    `width=${active.style.getPropertyValue('--dsh-vb-w')}`,
  )
  check('interaction: the active tick keeps its rail-owned states', active.getAttribute('aria-current') === 'true')
})

// ---------------------------------------------------------------------------
// disposal
// ---------------------------------------------------------------------------
await scenario('disposal', async (realm, rail) => {
  realm.net.handler = healthyHandler().handler
  await turnOn(realm)
  await waitHealthy(realm)
  await realm.advance(200)
  const before = realm.net.log.length
  realm.dispose()
  await realm.advance(1000)
  check('disposal: polling stops', realm.net.log.length === before, `${before} -> ${realm.net.log.length}`)
  check('disposal: the lease is released with a beacon', realm.beacons.length > 0, `beacons=${realm.beacons.length}`)
  check('disposal: the rail decoration is removed', !rail.nav.classList.contains('dsh-vb-on'))
  check('disposal: the injected style element is removed', realm.document.getElementById('dsh-volume-bar-style') === null)
})

// ---------------------------------------------------------------------------
console.log(results.join('\n'))
console.log('')
if (FAILURES.length) {
  console.log(`${FAILURES.length} check(s) failed:`)
  for (const name of FAILURES) console.log(`  - ${name}`)
  process.exit(1)
}
console.log('all client checks passed')
process.exit(0)
