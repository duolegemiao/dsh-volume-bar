/**
 * dsh-volume-bar — host half.
 *
 * Owns the system-output level meter: it bootstraps a private Python venv with
 * `pyaudiowpatch` (WASAPI loopback), spawns `lib/audio-levels.py`, keeps the
 * newest level frame in memory, and serves the browser half over HTTP.
 *
 * Routes (registered on the DSH webserver, loopback only):
 *   GET  /volume-bar/state   -> readiness, running state, device, setup log
 *   GET  /volume-bar/levels  -> newest level frame (also feeds the idle watchdog)
 *   POST /volume-bar/start   -> start the meter
 *   POST /volume-bar/stop    -> stop the meter
 *   POST /volume-bar/setup   -> create the venv + install pyaudiowpatch
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
const VENV_PYTHON = IS_WINDOWS
  ? join(VENV_DIR, 'Scripts', 'python.exe')
  : join(VENV_DIR, 'bin', 'python')
const IDLE_STOP_MS = 60_000

const state = {
  child: null,
  running: false,
  device: null,
  rate: null,
  bands: 8,
  level: null,
  error: null,
  lastFrameAt: 0,
  lastPollAt: 0,
  clientSeenAt: 0,
  clientInfo: null,
  setup: { running: false, done: false, log: [] },
}

function log(line) {
  state.setup.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
  if (state.setup.log.length > 60) state.setup.log.shift()
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

function venvReady() {
  return existsSync(VENV_PYTHON)
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function run(command, args, onLine) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true })
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
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

async function setup() {
  if (state.setup.running) return
  state.setup.running = true
  state.setup.done = false
  try {
    mkdirSync(TOOL_DIR, { recursive: true })
    if (!venvReady()) {
      const python = basePython()
      log(`creating venv with ${python}`)
      const code = await run(python, ['-m', 'venv', '--system-site-packages', VENV_DIR], log)
      if (code !== 0 || !venvReady()) {
        log('venv creation failed')
        state.error = 'venv creation failed'
        return
      }
    } else {
      log('venv already present')
    }
    log('installing pyaudiowpatch (may take a minute)')
    const code = await run(
      VENV_PYTHON,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', 'pyaudiowpatch'],
      log,
    )
    if (code !== 0) {
      log('pip install failed')
      state.error = 'pip install failed'
      return
    }
    log('ready')
    state.setup.done = true
    state.error = null
  } catch (error) {
    log(`setup error: ${error?.message ?? error}`)
    state.error = String(error?.message ?? error)
  } finally {
    state.setup.running = false
  }
}

function start() {
  if (state.child) return { ok: true, already: true }
  if (!venvReady()) {
    state.error = 'audio helper is not installed yet; run setup first'
    return { ok: false, error: state.error }
  }
  state.error = null
  const child = spawn(VENV_PYTHON, ['-u', HELPER], { windowsHide: true })
  state.child = child
  state.running = true
  state.lastPollAt = Date.now()

  let rest = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    rest += chunk
    const lines = rest.split(/\r?\n/)
    rest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (frame.type === 'hello') {
        state.device = frame.device
        state.rate = frame.rate
        state.bands = frame.bands ?? 8
      } else if (frame.type === 'level') {
        state.level = { rms: frame.rms, peak: frame.peak, bands: frame.bands }
        state.lastFrameAt = Date.now()
      } else if (frame.type === 'error') {
        state.error = frame.message
      }
    }
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000)
    state.error = stderr.trim().split(/\r?\n/).pop() ?? stderr
  })
  child.on('close', (code) => {
    if (state.child === child) {
      state.child = null
      state.running = false
      state.level = null
      if (code !== 0 && code !== null) state.error = `audio helper exited with code ${code}`
    }
  })
  child.on('error', (error) => {
    state.error = `audio helper failed to start: ${error.message}`
    state.child = null
    state.running = false
  })
  return { ok: true }
}

function stop() {
  const child = state.child
  if (!child) {
    state.running = false
    return { ok: true, already: true }
  }
  state.child = null
  state.running = false
  state.level = null
  try {
    child.stdin?.end()
    child.kill()
  } catch {
    /* already gone */
  }
  return { ok: true }
}

function snapshot() {
  return {
    ready: venvReady(),
    running: state.running,
    device: state.device,
    rate: state.rate,
    bands: state.bands,
    error: state.error,
    clientSeenAt: state.clientSeenAt || null,
    clientAgeMs: state.clientSeenAt ? Date.now() - state.clientSeenAt : null,
    clientInfo: state.clientInfo,
    setup: {
      running: state.setup.running,
      done: state.setup.done,
      log: state.setup.log.slice(-12),
    },
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 65536) req.destroy()
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(''))
  })
}

export function apply(ctx) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      res.end()
      return
    }

    if (path === '/volume-bar/state') {
      json(res, 200, snapshot())
      return
    }
    if (path === '/volume-bar/levels') {
      state.lastPollAt = Date.now()
      json(res, 200, {
        running: state.running,
        device: state.device,
        level: state.level,
        ageMs: state.lastFrameAt ? Date.now() - state.lastFrameAt : null,
        error: state.error,
      })
      return
    }
    if (path === '/volume-bar/hello' && method === 'POST') {
      const body = await readBody(req)
      state.clientSeenAt = Date.now()
      try {
        state.clientInfo = JSON.parse(body || '{}')
      } catch {
        state.clientInfo = { raw: body.slice(0, 200) }
      }
      json(res, 200, { ok: true })
      return
    }
    if (path === '/volume-bar/start' && method === 'POST') {
      await readBody(req)
      if (!venvReady()) await setup()
      json(res, 200, { ...start(), state: snapshot() })
      return
    }
    if (path === '/volume-bar/stop' && method === 'POST') {
      await readBody(req)
      json(res, 200, { ...stop(), state: snapshot() })
      return
    }
    if (path === '/volume-bar/setup' && method === 'POST') {
      await readBody(req)
      void setup()
      json(res, 202, snapshot())
      return
    }
    json(res, 404, { error: 'not found' })
  }

  ctx.effect(() =>
    ctx.webServer.register({ kind: 'prefix', path: '/volume-bar', handler }),
  )

  const watchdog = setInterval(() => {
    if (!state.child) return
    if (state.lastPollAt && Date.now() - state.lastPollAt > IDLE_STOP_MS) {
      ctx.logger?.info?.('volume-bar: no client polling, stopping the meter')
      stop()
    }
  }, 5000)

  ctx.effect(() => () => {
    clearInterval(watchdog)
    stop()
  })
}
