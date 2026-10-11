/**
 * dsh-volume-bar — host half.
 *
 * Owns the system-output level meter: it bootstraps a private Python venv with
 * `pyaudiowpatch` (WASAPI loopback) plus NumPy, spawns `lib/audio-levels.py`,
 * keeps the newest level frame in memory, and serves the browser half over HTTP.
 *
 * Routes (registered on the DSH webserver, loopback only):
 *   GET  /volume-bar/state   -> readiness, capture state, device, setup log
 *   GET  /volume-bar/levels  -> newest frame with generation/seq/ageMs + leases
 *   GET  /volume-bar/devices -> loopback devices the helper can capture
 *   POST /volume-bar/hello   -> browser half checked in (protocol negotiation)
 *   POST /volume-bar/start   -> acquire a capture lease; starts the helper
 *   POST /volume-bar/stop    -> release one lease (or all, with ?all=1)
 *   POST /volume-bar/bye     -> page is closing; release this lease at once
 *   POST /volume-bar/setup   -> create the venv, install deps, run the probe
 *
 * Design notes (see README "协议" section):
 *  * The capture process is shared. Each browser window holds its own lease and
 *    the meter stops only when the last lease is gone, so one window closing —
 *    or one window opening — never disturbs another window's audio.
 *  * Every frame carries the helper `generation` and a monotonic `seq`, so the
 *    client can tell "same cached frame" from "new audio" and "stalled" from
 *    "healthy silence".
 *  * Leases expire on their own, so a crashed window cannot pin the meter, and
 *    a hidden window that stops polling is released after its TTL.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-volume-bar'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER = join(HERE, 'audio-levels.py')
const TOOL_DIR = join(homedir(), '.dsh', 'tools', 'dsh-volume-bar')
const VENV_DIR = join(TOOL_DIR, 'venv')
const IS_WINDOWS = process.platform === 'win32'
const VENV_PYTHON = process.env.DSH_VOLUME_BAR_VENV_PYTHON
  || (IS_WINDOWS ? join(VENV_DIR, 'Scripts', 'python.exe') : join(VENV_DIR, 'bin', 'python'))
/** Command that runs the helper itself; overridable for diagnostics and tests. */
const HELPER_COMMAND = String(process.env.DSH_VOLUME_BAR_HELPER_COMMAND ?? '').trim() || VENV_PYTHON

const PROTOCOL_VERSION = 2
/** Packages the helper needs; NumPy is required for the per-band analysis. */
const PACKAGES = ['pyaudiowpatch', 'numpy']
const SETUP_TIMEOUT_MS = 6 * 60_000
const PROBE_TIMEOUT_MS = 20_000
const PROBE_MAX_AGE_MS = 60_000
const STOP_GRACE_MS = 1500
const LEASE_TTL_MS = 90_000
const LEASE_MIN_TTL_MS = 15_000
const LEASE_MAX_TTL_MS = 240_000
/** Safety net: no lease at all for this long stops the meter. */
const IDLE_STOP_MS = 10 * 60_000
const MAX_LINE_BYTES = 16 * 1024
const MAX_LOG_LINES = 80
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const state = {
  child: null,
  captureState: 'idle',
  generation: null,
  device: null,
  devices: [],
  rate: null,
  channels: null,
  bands: 8,
  analysisMode: null,
  level: null,
  seq: null,
  frameGeneration: null,
  lastFrameAt: 0,
  error: null,
  errorCode: null,
  helperVersion: null,
  forcedDevice: null,
  disposed: false,
  /** clientId -> { at, ttlMs } */
  leases: new Map(),
  lastClientAt: 0,
  clientInfo: null,
  frameRejects: 0,
  setupTask: 0,
  setup: {
    running: false,
    promise: null,
    taskId: null,
    done: false,
    error: null,
    log: [],
    startedAt: 0,
    finishedAt: 0,
  },
  probe: { running: false, at: 0, ok: false, details: null },
}

function log(line) {
  state.setup.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
  if (state.setup.log.length > MAX_LOG_LINES) state.setup.log.shift()
}

function basePython() {
  const candidates = []
  if (process.env.DSH_VOLUME_BAR_PYTHON) candidates.push(process.env.DSH_VOLUME_BAR_PYTHON)
  candidates.push(
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', IS_WINDOWS ? 'python.exe' : 'bin/python'),
  )
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return IS_WINDOWS ? 'python' : 'python3'
}

function venvPresent() {
  return existsSync(VENV_PYTHON)
}

/**
 * Split a configured command line (`"C:\Program Files\...\python.exe" -X`) into
 * argv. Only used for explicit environment overrides, where a user or a test may
 * supply extra interpreter arguments.
 */
function splitCommand(line) {
  const parts = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = pattern.exec(line)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3])
  }
  return parts
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

function run(command, args, onLine, options = {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, shell: options.shell === true })
    } catch (error) {
      onLine(`spawn failed: ${error.message}`)
      resolvePromise({ code: 1, timedOut: false })
      return
    }
    const tracked = options.registry
    if (tracked) tracked.add(child)
    // Setup steps never read stdin; closing the pipe lets a tool that waits for
    // EOF (or an interactive prompt) finish instead of hanging until the timeout.
    try {
      child.stdin?.end()
    } catch {
      /* nothing to close */
    }
    let settled = false
    let timedOut = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (tracked) tracked.delete(child)
      resolvePromise({ code, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      onLine(`timed out after ${Math.round(options.timeoutMs ?? SETUP_TIMEOUT_MS) / 1000}s; killing`)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(1)
    }, options.timeoutMs ?? SETUP_TIMEOUT_MS)
    if (timer.unref) timer.unref()

    const feed = (stream) => {
      let rest = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        rest += chunk
        const lines = rest.split(/\r?\n/)
        rest = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onLine(line.trim())
      })
      stream.on('end', () => {
        if (rest.trim()) onLine(rest.trim())
      })
    }
    feed(child.stdout)
    feed(child.stderr)
    child.on('error', (error) => {
      onLine(`spawn failed: ${error.message}`)
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

const setupChildren = new Set()

async function setupForce(taskId) {
  state.setup.running = true
  state.setup.done = false
  state.setup.error = null
  state.setup.taskId = taskId
  state.setup.startedAt = Date.now()
  const current = () => state.setupTask === taskId
  try {
    mkdirSync(TOOL_DIR, { recursive: true })
    if (!venvPresent()) {
      const python = basePython()
      log(`creating the venv with ${python}`)
      const [baseProgram, ...basePrefix] = splitCommand(python)
      const created = await run(
        baseProgram,
        [...basePrefix, '-m', 'venv', '--system-site-packages', VENV_DIR],
        log,
        { timeoutMs: SETUP_TIMEOUT_MS },
      )
      if (!current()) return
      if (created.code !== 0 || !venvPresent()) {
        throw new Error(created.timedOut ? 'venv creation timed out' : 'venv creation failed')
      }
    } else {
      log('venv already present')
    }
    log(`installing ${PACKAGES.join(', ')} (may take a minute)`)
    const installed = await run(
      VENV_PYTHON,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '--retries', '3', '--timeout', '30', ...PACKAGES],
      log,
      { timeoutMs: SETUP_TIMEOUT_MS },
    )
    if (!current()) return
    if (installed.code !== 0) throw new Error(installed.timedOut ? 'pip install timed out' : 'pip install failed')
    const probe = await probeDependencies(true)
    if (!current()) return
    if (!probe.ok) throw new Error(probe.error || 'the dependency probe failed')
    log(`ready (python ${probe.details?.python ?? '?'}, numpy ${probe.details?.numpy ?? 'missing'})`)
    state.setup.done = true
    state.error = null
    state.errorCode = null
  } catch (error) {
    if (!current()) return
    state.setup.error = String(error?.message ?? error)
    state.error = state.setup.error
    state.errorCode = 'setup_failed'
    log(`setup failed: ${state.setup.error}`)
  } finally {
    if (current()) {
      state.setup.running = false
      state.setup.finishedAt = Date.now()
    }
  }
}

/** Start (or join) the single install task; every caller awaits the same result. */
function ensureSetup(force = false) {
  if (state.setup.running && !force) return state.setup.promise
  if (state.setup.running) {
    for (const child of setupChildren) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    setupChildren.clear()
  }
  state.setupTask += 1
  state.setup.promise = setupForce(state.setupTask)
  return state.setup.promise
}

/** Dependencies are ready when the venv exists *and* the probe says so. */
async function ensureDependencies() {
  if (venvPresent() && state.probe.ok) return true
  await ensureSetup()
  if (state.probe.ok) return true
  const probe = await probeDependencies(true)
  return probe.ok
}

const PROBE_SCRIPT = [
  'import json,sys',
  'info={"probe":"dsh-volume-bar","python":sys.version.split()[0],"executable":sys.executable}',
  'try:',
  '    import pyaudiowpatch as p',
  '    info["pyaudiowpatch"]=getattr(p,"__version__","unknown")',
  '    pa=p.PyAudio()',
  '    try:',
  '        info["devices"]=len([i for i in range(pa.get_device_count()) if pa.get_device_info_by_index(i).get("isLoopbackDevice")])',
  '        pa.get_default_wasapi_loopback()',
  '        info["defaultLoopback"]=True',
  '    finally:',
  '        pa.terminate()',
  'except Exception as exc:',
  '    info["pyaudiowpatch"]=None',
  '    info["error"]="%s: %s" % (type(exc).__name__, exc)',
  'try:',
  '    import numpy',
  '    info["numpy"]=numpy.__version__',
  'except Exception as exc:',
  '    info["numpy"]=None',
  'print(json.dumps(info))',
].join('\n')

/**
 * Run a real health check instead of only testing for python.exe: the modules
 * must import, and a loopback device must be enumerable.
 *
 * ``DSH_VOLUME_BAR_PROBE`` replaces the probe command (used for diagnostics and
 * for the offline tests, which point it at a stub interpreter).
 */
async function probeDependencies(force = false) {
  const fresh = Date.now() - state.probe.at < PROBE_MAX_AGE_MS
  if (!force && fresh && state.probe.details) return { ...state.probe, ok: state.probe.ok, error: state.probe.details.error }
  if (!venvPresent()) {
    state.probe = { running: false, at: Date.now(), ok: false, details: { error: 'venv is missing' } }
    return { ok: false, error: 'venv is missing', details: state.probe.details }
  }
  state.probe.running = true
  let output = ''
  const override = String(process.env.DSH_VOLUME_BAR_PROBE ?? '').trim()
  const collect = (line) => {
    output += `${line}\n`
  }
  const result = override
    ? await run(splitCommand(override)[0], splitCommand(override).slice(1), collect, { timeoutMs: PROBE_TIMEOUT_MS })
    : await run(VENV_PYTHON, ['-c', PROBE_SCRIPT], collect, { timeoutMs: PROBE_TIMEOUT_MS })
  state.probe.running = false
  state.probe.at = Date.now()
  let details = null
  try {
    details = JSON.parse(output.trim().split(/\r?\n/).pop() ?? '{}')
  } catch {
    details = { error: output.trim().slice(-300) || `python exited with code ${result.code}` }
  }
  const ok = result.code === 0
    && !!details
    && details.pyaudiowpatch
    && details.error === undefined
    && details.defaultLoopback === true
  state.probe.ok = ok
  state.probe.details = details
  log(
    ok
      ? `probe ok: python ${details.python}, numpy ${details.numpy ?? 'missing'}, ${details.devices} loopback device(s)`
      : `probe failed: ${details?.error ?? details?.pyaudiowpatch ?? 'unknown error'}`,
  )
  return { ok, error: ok ? null : (details?.error ?? 'the audio backend is not usable'), details }
}

// ---------------------------------------------------------------------------
// capture process
// ---------------------------------------------------------------------------

function safeNumber(value, min = -1e9, max = 1e9) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(max, Math.max(min, number))
}

function parseFrame(line) {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return null
  }
  if (!frame || typeof frame !== 'object') return null
  if (frame.type === 'hello') {
    return {
      kind: 'hello',
      version: typeof frame.version === 'string' ? frame.version : null,
      generation: typeof frame.generation === 'string' ? frame.generation : null,
      device: frame.device && typeof frame.device === 'object' ? {
        mode: String(frame.device.mode ?? 'system-default'),
        name: String(frame.device.name ?? ''),
        defaultName: String(frame.device.defaultName ?? ''),
        index: safeNumber(frame.device.index, 0, 1e6),
        isDefault: frame.device.isDefault === true,
      } : null,
      devices: Array.isArray(frame.devices) ? frame.devices.slice(0, 32).map((entry) => ({
        index: safeNumber(entry?.index, 0, 1e6),
        name: String(entry?.name ?? '').slice(0, 200),
        rate: safeNumber(entry?.rate, 0, 768000),
        channels: safeNumber(entry?.channels, 0, 64),
      })) : [],
      rate: safeNumber(frame.rate, 0, 768000),
      channels: safeNumber(frame.channels, 0, 64),
      bands: safeNumber(frame.bands, 1, 32),
      analysisMode: typeof frame.analysisMode === 'string' ? frame.analysisMode : null,
      bandEdgesHz: Array.isArray(frame.bandEdgesHz) ? frame.bandEdgesHz.slice(0, 32) : null,
    }
  }
  if (frame.type === 'level') {
    const rms = safeNumber(frame.rms, 0, 64)
    const peak = safeNumber(frame.peak, 0, 64)
    if (rms === null || peak === null) return null
    const raw = Array.isArray(frame.bands) ? frame.bands : []
    const bands = []
    for (let i = 0; i < state.bands; i++) {
      const value = safeNumber(raw[i], 0, 64)
      if (value === null) return null
      bands.push(value)
    }
    return {
      kind: 'level',
      generation: typeof frame.generation === 'string' ? frame.generation : null,
      seq: safeNumber(frame.seq, 0, 1e12),
      rms,
      peak,
      bands,
    }
  }
  if (frame.type === 'error') {
    return {
      kind: 'error',
      code: typeof frame.code === 'string' ? frame.code : 'helper_error',
      message: String(frame.message ?? 'audio helper error').slice(0, 300),
    }
  }
  return null
}

function startCapture() {
  if (state.child) return { ok: true, already: true, generation: state.generation }
  if (!venvPresent()) {
    state.error = '音频依赖还没装好'
    state.errorCode = 'dependencies_missing'
    state.captureState = 'error'
    return { ok: false, error: state.error, code: state.errorCode }
  }
  // The helper flushes after every frame, so it does not need python's -u; the
  // shorter command line also keeps custom interpreters usable.
  const args = [HELPER]
  const forced = state.forcedDevice ?? process.env.DSH_VOLUME_BAR_DEVICE_INDEX
  if (forced !== undefined && forced !== null && String(forced).trim() !== '') args.push(String(forced))

  let child
  try {
    const [python, ...prefix] = splitCommand(HELPER_COMMAND)
    child = spawn(python, [...prefix, ...args], { windowsHide: true })
  } catch (error) {
    state.error = `音频助手启动失败：${error.message}`
    state.errorCode = 'spawn_failed'
    state.captureState = 'error'
    return { ok: false, error: state.error, code: state.errorCode }
  }

  state.child = child
  state.captureState = 'starting'
  state.error = null
  state.errorCode = null
  state.level = null
  state.seq = null
  state.lastClientAt = Date.now()

  let rest = ''
  const consume = (line) => {
    if (line.length > MAX_LINE_BYTES) {
      state.frameRejects += 1
      return
    }
    const frame = parseFrame(line)
    if (!frame) {
      state.frameRejects += 1
      return
    }
    if (frame.kind === 'hello') {
      state.generation = frame.generation
      state.device = frame.device
      if (frame.devices?.length) state.devices = frame.devices
      state.rate = frame.rate
      state.channels = frame.channels
      state.bands = frame.bands ?? 8
      state.analysisMode = frame.analysisMode
      state.helperVersion = frame.version
      if (state.captureState === 'starting') state.captureState = 'capturing'
      return
    }
    if (frame.kind === 'error') {
      state.error = frame.message
      state.errorCode = frame.code
      state.captureState = 'error'
      return
    }
    // Only frames from the process we are currently tracking count: a dying
    // helper must not overwrite the state of the one that replaced it.
    if (state.child !== child) return
    state.level = { rms: frame.rms, peak: frame.peak, bands: frame.bands }
    state.seq = frame.seq
    state.frameGeneration = frame.generation ?? state.generation
    state.lastFrameAt = Date.now()
    if (state.captureState !== 'error') state.captureState = 'capturing'
  }
  const feedStream = (stream) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      rest += chunk
      const lines = rest.split(/\r?\n/)
      rest = lines.pop() ?? ''
      if (rest.length > MAX_LINE_BYTES) rest = ''
      for (const line of lines) if (line.trim()) consume(line.trim())
    })
    stream.on('end', () => {
      if (rest.trim()) consume(rest.trim())
    })
  }
  feedStream(child.stdout)

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000)
    const line = stderr.trim().split(/\r?\n/).pop()
    if (line) state.error = line
  })
  child.on('close', (code) => {
    if (state.child !== child) return
    state.child = null
    state.level = null
    state.seq = null
    state.captureState = 'idle'
    if (code !== 0 && code !== null) {
      state.error = state.error ?? `音频助手退出（代码 ${code}）`
      state.errorCode = 'helper_exited'
    }
  })
  child.on('error', (error) => {
    if (state.child !== child) return
    state.child = null
    state.captureState = 'error'
    state.error = `音频助手无法启动：${error.message}`
    state.errorCode = 'spawn_failed'
  })
  return { ok: true, generation: state.generation }
}

/** Stop the helper: ask it politely first, then insist. */
function stopCapture(reason = 'client') {
  const child = state.child
  state.child = null
  state.captureState = 'idle'
  state.level = null
  state.seq = null
  state.frameGeneration = null
  if (!child) return { ok: true, already: true }
  let exited = false
  child.once('close', () => {
    exited = true
  })
  try {
    child.stdin?.write('stop\n')
    child.stdin?.end()
  } catch {
    /* pipe already closed */
  }
  const timer = setTimeout(() => {
    if (exited) return
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }, STOP_GRACE_MS)
  if (timer.unref) timer.unref()
  log(`stopping the audio helper (${reason})`)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// leases
// ---------------------------------------------------------------------------

function pruneLeases(now = Date.now()) {
  for (const [clientId, lease] of state.leases) {
    if (now - lease.at > lease.ttlMs) {
      state.leases.delete(clientId)
      log(`lease ${clientId} expired`)
    }
  }
}

function leaseCount() {
  pruneLeases()
  return state.leases.size
}

function acquireLease(clientId, ttlMs) {
  const ttl = Math.min(LEASE_MAX_TTL_MS, Math.max(LEASE_MIN_TTL_MS, safeNumber(ttlMs, LEASE_MIN_TTL_MS, LEASE_MAX_TTL_MS) ?? LEASE_TTL_MS))
  state.leases.set(clientId, { at: Date.now(), ttlMs: ttl })
  state.lastClientAt = Date.now()
  return ttl
}

function releaseLease(clientId) {
  const existed = state.leases.delete(clientId)
  state.lastClientAt = Date.now()
  return existed
}

function releaseAllLeases() {
  state.leases.clear()
  state.lastClientAt = Date.now()
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function loopbackHost(value) {
  const host = String(value ?? '').replace(/^\[|\]$/g, '').split(':')[0].toLowerCase()
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * This route is registered on a loopback-only webserver by default, so the
 * checks below are defence in depth: reject a foreign Host (DNS rebinding) and
 * any cross-site Origin. The Electron shell sends no Origin at all.
 */
function checkRequest(req) {
  if (!loopbackHost(req.headers?.host)) return { ok: false, status: 403, reason: 'host not allowed' }
  const origin = req.headers?.origin
  if (origin === undefined || origin === '' || origin === 'null') return { ok: true }
  try {
    const url = new URL(origin)
    if (loopbackHost(url.host) || url.protocol === 'file:') return { ok: true }
  } catch {
    /* unparsable origin counts as foreign */
  }
  return { ok: false, status: 403, reason: 'origin not allowed' }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolvePromise) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 32 * 1024) req.destroy()
    })
    req.on('end', () => resolvePromise(body))
    req.on('error', () => resolvePromise(''))
  })
}

function readJsonBody(body) {
  if (!body || !body.trim()) return {}
  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function snapshot() {
  pruneLeases()
  const now = Date.now()
  const ageMs = state.lastFrameAt ? now - state.lastFrameAt : null
  const probe = state.probe.details
  return {
    protocolVersion: PROTOCOL_VERSION,
    ready: venvPresent() && state.setup.done,
    venvPresent: venvPresent(),
    dependenciesReady: venvPresent(),
    backendAvailable: state.probe.ok === true,
    deviceAvailable: (probe?.devices ?? 0) > 0 || state.devices.length > 0,
    captureReady: state.captureState === 'capturing',
    captureState: state.captureState,
    running: state.child !== null,
    generation: state.generation,
    seq: state.seq,
    ageMs,
    device: state.device,
    devices: state.devices,
    rate: state.rate,
    channels: state.channels,
    bands: state.bands,
    analysisMode: state.analysisMode,
    helperVersion: state.helperVersion,
    error: state.error,
    errorCode: state.errorCode,
    forcedDevice: state.forcedDevice,
    leases: state.leases.size,
    frameRejects: state.frameRejects,
    probe: {
      running: state.probe.running,
      ok: state.probe.ok,
      at: state.probe.at || null,
      python: probe?.python ?? null,
      numpy: probe?.numpy ?? null,
      pyaudiowpatch: probe?.pyaudiowpatch ?? null,
      devices: probe?.devices ?? null,
      error: probe?.error ?? null,
    },
    setup: {
      running: state.setup.running,
      done: state.setup.done,
      taskId: state.setup.taskId,
      error: state.setup.error,
      startedAt: state.setup.startedAt || null,
      finishedAt: state.setup.finishedAt || null,
      log: state.setup.log.slice(-12),
    },
  }
}

function levelsPayload() {
  const now = Date.now()
  pruneLeases()
  return {
    protocolVersion: PROTOCOL_VERSION,
    running: state.child !== null,
    captureState: state.captureState,
    generation: state.generation,
    frameGeneration: state.frameGeneration,
    seq: state.seq,
    ageMs: state.lastFrameAt ? now - state.lastFrameAt : null,
    level: state.level,
    device: state.device,
    devices: state.devices,
    rate: state.rate,
    channels: state.channels,
    bands: state.bands,
    analysisMode: state.analysisMode,
    error: state.error,
    errorCode: state.errorCode,
    leases: state.leases.size,
  }
}

export function apply(ctx) {
  const handler = async (req, res) => {
    const admission = checkRequest(req)
    if (!admission.ok) {
      ctx.logger?.warn?.(`volume-bar: rejected a request (${admission.reason})`)
      json(res, admission.status, { error: admission.reason })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    if (path === '/volume-bar/state') {
      json(res, 200, snapshot())
      return
    }

    if (path === '/volume-bar/levels') {
      const clientId = url.searchParams.get('clientId')
      if (clientId && CLIENT_ID_PATTERN.test(clientId) && state.leases.has(clientId)) {
        // Polling is also a heartbeat: an active, visible window keeps its lease.
        acquireLease(clientId, state.leases.get(clientId)?.ttlMs ?? LEASE_TTL_MS)
      }
      json(res, 200, levelsPayload())
      return
    }

    if (path === '/volume-bar/hello' && method === 'POST') {
      const body = readJsonBody(await readBody(req))
      state.clientInfo = {
        protocolVersion: safeNumber(body.protocolVersion, 0, 1000),
        marks: safeNumber(body.marks, 0, 100000),
        rail: typeof body.rail === 'string' ? body.rail.slice(0, 40) : null,
        analysisMode: typeof body.analysisMode === 'string' ? body.analysisMode.slice(0, 40) : null,
        clientVersion: typeof body.clientVersion === 'string' ? body.clientVersion.slice(0, 40) : null,
      }
      json(res, 200, {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        leaseTtlMs: LEASE_TTL_MS,
        state: snapshot(),
      })
      return
    }

    if (path === '/volume-bar/start' && method === 'POST') {
      const body = readJsonBody(await readBody(req))
      await ensureDependencies()
      const clientId = typeof body.clientId === 'string' && CLIENT_ID_PATTERN.test(body.clientId) ? body.clientId : null
      const ttlMs = clientId ? acquireLease(clientId, body.ttlMs) : LEASE_TTL_MS
      if (body.device === null || typeof body.device === 'number') {
        const next = body.device === null ? null : safeNumber(body.device, 0, 1e6)
        if (next !== state.forcedDevice) {
          state.forcedDevice = next
          // A pinned device only takes effect on a fresh helper.
          if (state.child) stopCapture('device changed')
        }
      }
      const started = startCapture()
      json(res, 200, {
        ...started,
        clientId,
        leaseTtlMs: ttlMs,
        leases: state.leases.size,
        state: snapshot(),
      })
      return
    }

    if (path === '/volume-bar/stop' && method === 'POST') {
      const body = readJsonBody(await readBody(req))
      const clientId = typeof body.clientId === 'string' && CLIENT_ID_PATTERN.test(body.clientId) ? body.clientId : null
      if (url.searchParams.get('all') === '1' || !clientId) releaseAllLeases()
      else releaseLease(clientId)
      // The helper only stops when nobody holds a lease any more.
      const remaining = leaseCount()
      if (remaining === 0) stopCapture(clientId ? `last lease released by ${clientId}` : 'explicit stop')
      json(res, 200, { ok: true, leases: remaining, stopped: remaining === 0, state: snapshot() })
      return
    }

    if (path === '/volume-bar/bye' && method === 'POST') {
      const body = readJsonBody(await readBody(req))
      const clientId = typeof body.clientId === 'string' && CLIENT_ID_PATTERN.test(body.clientId) ? body.clientId : null
      if (clientId) releaseLease(clientId)
      else releaseAllLeases()
      const remaining = leaseCount()
      if (remaining === 0) stopCapture('page closed')
      json(res, 200, { ok: true, leases: remaining })
      return
    }

    if (path === '/volume-bar/setup' && method === 'POST') {
      const body = readJsonBody(await readBody(req))
      void ensureSetup(body.force === true)
      json(res, 202, snapshot())
      return
    }

    if (path === '/volume-bar/devices') {
      const probe = await probeDependencies()
      json(res, 200, {
        ready: probe.ok,
        devices: state.devices,
        forced: state.forcedDevice,
        error: probe.error,
      })
      return
    }

    json(res, 404, { error: 'not found' })
  }

  ctx.effect(() =>
    ctx.webServer.register({ kind: 'prefix', path: '/volume-bar', handler }),
  )

  const watchdog = setInterval(() => {
    pruneLeases()
    if (!state.child) return
    const now = Date.now()
    if (leaseCount() === 0 && state.lastClientAt && now - state.lastClientAt > IDLE_STOP_MS) {
      ctx.logger?.info?.('volume-bar: no client for a long time, stopping the meter')
      stopCapture('idle watchdog')
    }
  }, 5000)

  // A first-run probe gives the settings page something to show without opening
  // the audio stream. It is cheap and never blocks a request.
  const probeTimer = setTimeout(() => {
    if (venvPresent() && !state.setup.running) void probeDependencies()
  }, 2000)
  if (probeTimer.unref) probeTimer.unref()

  ctx.effect(() => () => {
    state.disposed = true
    clearInterval(watchdog)
    clearTimeout(probeTimer)
    releaseAllLeases()
    stopCapture('plugin disposed')
    for (const child of setupChildren) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    setupChildren.clear()
  })
}
