/**
 * Offline checks for the host half (lib/index.js).
 *
 * A stub interpreter stands in for the venv python (see stub-helper.mjs), so the
 * routes, the lease bookkeeping and the process lifecycle are all exercised
 * without touching a real audio device. Run with:
 *
 *     node _tests/host.test.mjs
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAILURES = []
const results = []

function check(name, condition, detail = '') {
  results.push(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) FAILURES.push(name)
}

// The host derives its tool directory (and therefore the venv path and the
// tool.log location) from the home directory, so point that at a scratch dir.
const home = mkdtempSync(join(tmpdir(), 'vb-home-'))
const toolDir = join(home, '.dsh', 'tools', 'dsh-volume-bar')
mkdirSync(join(toolDir, 'venv', 'Scripts'), { recursive: true })
// A venv that already exists: the host only checks that the interpreter file is
// there, and VENV_PYTHON below points at this placeholder.
writeFileSync(join(toolDir, 'venv', 'Scripts', 'python.exe'), 'placeholder for the stub interpreter\n')

process.env.USERPROFILE = home
process.env.HOME = home
// Windows cannot exec a .mjs or .cmd directly, so the helper is launched through
// the command interpreter running the .cmd shim. The venv path itself stays a
// real file (the scratch venv below), which is what the host probes for.
const shim = join(import.meta.dirname, 'stub-python.cmd')
process.env.DSH_VOLUME_BAR_HELPER_COMMAND = process.platform === 'win32'
  ? `"${process.env.ComSpec || 'cmd.exe'}" /c "${shim}"`
  : process.execPath
// A venv that "already exists" but whose interpreter is the stub: the scratch
// venv path below is a real file, and this override keeps venv creation instant.
process.env.DSH_VOLUME_BAR_PYTHON = process.env.DSH_VOLUME_BAR_HELPER_COMMAND
process.env.DSH_VOLUME_BAR_PROBE = `"${process.execPath}" "${join(import.meta.dirname, 'stub-probe.mjs')}"`
process.env.VB_STUB_PROBE = 'ok'
process.env.VB_STUB_HELPER_PY = join(import.meta.dirname, 'stub-python.mjs')

const module = await import('../lib/index.js')

let handler = null
const disposers = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  effect: (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  webServer: {
    register: (route) => {
      handler = route.handler
      return () => {
        handler = null
      }
    },
  },
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload ?? ''
    },
    destroy() {},
  }
}

async function call(path, { method = 'GET', body = null, host = '127.0.0.1:19387', origin = null } = {}) {
  const res = makeRes()
  const listeners = {}
  const req = {
    url: path,
    method,
    headers: { host, ...(origin ? { origin } : {}) },
    on(event, fn) {
      listeners[event] = fn
    },
    destroy() {},
  }
  const promise = handler(req, res)
  if (listeners.data && body !== null) listeners.data(JSON.stringify(body))
  if (listeners.end) listeners.end()
  await promise
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, raw: res.body }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function levels(clientId) {
  return (await call(`/volume-bar/levels${clientId ? `?clientId=${clientId}` : ''}`)).json
}

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await wait(40)
  }
  return false
}

// --- run ------------------------------------------------------------------
module.apply(ctx)
check('routes registered', typeof handler === 'function')

const initial = await call('/volume-bar/state')
check(
  'state exposes the protocol version and capture state',
  initial.status === 200 && initial.json.protocolVersion === 2 && initial.json.captureState === 'idle',
  JSON.stringify({ status: initial.status, protocolVersion: initial.json?.protocolVersion, captureState: initial.json?.captureState }),
)

const foreign = await call('/volume-bar/state', { host: 'evil.example.com' })
check('a foreign Host header is rejected (DNS rebinding)', foreign.status === 403, `status ${foreign.status}`)
const crossSite = await call('/volume-bar/levels', { origin: 'https://example.com' })
check('a cross-site Origin is rejected', crossSite.status === 403, `status ${crossSite.status}`)
const sameSite = await call('/volume-bar/levels', { origin: 'http://127.0.0.1:19387' })
check('a loopback Origin is accepted', sameSite.status === 200, `status ${sameSite.status}`)

const probed = await waitFor(async () => (await call('/volume-bar/state')).json.probe?.ok === true)
check('the dependency probe reports the stub environment as ready', probed)

const startA = await call('/volume-bar/start', { method: 'POST', body: { clientId: 'win-a', ttlMs: 60000, device: null } })
check('start acquires a lease for window A', startA.json.ok === true && startA.json.leases === 1, JSON.stringify({ leases: startA.json.leases, ok: startA.json.ok }))

const hello = await call('/volume-bar/hello', { method: 'POST', body: { protocolVersion: 2, marks: 8, clientVersion: '0.7.0' } })
check(
  'hello negotiates the protocol version and lease TTL',
  hello.json.ok === true && hello.json.protocolVersion === 2 && hello.json.leaseTtlMs > 0,
  JSON.stringify({ ok: hello.json.ok, protocolVersion: hello.json.protocolVersion, leaseTtlMs: hello.json.leaseTtlMs }),
)

const frontendLeak = await call('/volume-bar/hello', {
  method: 'POST',
  body: { protocolVersion: 2, marks: 8, href: 'http://127.0.0.1:1/secret?token=x', origin: 'http://127.0.0.1:1' },
})
check(
  'client info is de-identified (no URL or token echoed back)',
  !JSON.stringify(frontendLeak.json.state.clientInfo ?? {}).includes('secret'),
  JSON.stringify(frontendLeak.json.state.clientInfo),
)

const flowing = await waitFor(async () => {
  const payload = await levels('win-a')
  return payload.captureState === 'capturing' && typeof payload.seq === 'number'
})
const payload = await levels('win-a')
check(
  'levels carries captureState, generation, seq and ageMs',
  flowing && typeof payload.generation === 'string' && typeof payload.ageMs === 'number' && Array.isArray(payload.level?.bands),
  JSON.stringify({ captureState: payload.captureState, generation: payload.generation, seq: payload.seq, ageMs: payload.ageMs }),
)
check(
  'the actual capture device is reported, not just the default name',
  payload.device?.name === 'Stub Speakers' && payload.device?.mode === 'system-default',
  JSON.stringify(payload.device),
)
check('the analysis mode reaches the client', payload.analysisMode === 'numpy-fft', String(payload.analysisMode))
check(
  'ageMs tracks real frame arrival (a fresh frame is young)',
  typeof payload.ageMs === 'number' && payload.ageMs < 500,
  String(payload.ageMs),
)

// F10: joining and leaving windows must not disturb the others.
const startB = await call('/volume-bar/start', { method: 'POST', body: { clientId: 'win-b', ttlMs: 60000 } })
check(
  'a second window reuses the running helper',
  startB.json.already === true && startB.json.leases === 2,
  JSON.stringify({ already: startB.json.already, leases: startB.json.leases }),
)
const seqBefore = (await levels()).seq
await wait(120)
const seqAfter = (await levels()).seq
check('frames keep flowing with two windows attached', seqAfter > seqBefore, `${seqBefore} -> ${seqAfter}`)

const stopA = await call('/volume-bar/stop', { method: 'POST', body: { clientId: 'win-a' } })
check('closing window A keeps window B attached', stopA.json.leases === 1 && stopA.json.stopped === false, JSON.stringify(stopA.json))
check('the meter keeps running for the remaining window', (await call('/volume-bar/state')).json.running === true)

const acrossA = (await levels()).seq
await wait(120)
check('frames still flow after window A left', (await levels()).seq > acrossA)

const stopB = await call('/volume-bar/stop', { method: 'POST', body: { clientId: 'win-b' } })
check('closing the last window stops the meter', stopB.json.leases === 0 && stopB.json.stopped === true, JSON.stringify(stopB.json))
const released = await waitFor(async () => (await call('/volume-bar/state')).json.running === false)
check('the helper process is released after the last lease', released)

// A closed page releases only its own lease.
await call('/volume-bar/start', { method: 'POST', body: { clientId: 'win-c', ttlMs: 60000 } })
await call('/volume-bar/start', { method: 'POST', body: { clientId: 'win-d', ttlMs: 60000 } })
const bye = await call('/volume-bar/bye', { method: 'POST', body: { clientId: 'win-c' } })
check('bye releases one lease and keeps the other window alive', bye.json.leases === 1, JSON.stringify(bye.json))
check('the meter survives the first window closing', (await call('/volume-bar/state')).json.running === true)

const stopUnknown = await call('/volume-bar/stop', { method: 'POST', body: { clientId: 'nobody' } })
check('stopping an unknown client leaves the real lease intact', stopUnknown.json.leases === 1, JSON.stringify(stopUnknown.json))
await call('/volume-bar/stop', { method: 'POST', body: { clientId: 'win-d' } })

// F17: concurrent setup callers share one install task.
const [setupOne, setupTwo] = await Promise.all([
  call('/volume-bar/setup', { method: 'POST', body: {} }),
  call('/volume-bar/setup', { method: 'POST', body: {} }),
])
check(
  'setup answers 202 and reports a task id',
  setupOne.status === 202 && setupTwo.status === 202 && typeof setupOne.json.setup.taskId === 'number',
  JSON.stringify({ status: setupOne.status, taskId: setupOne.json.setup.taskId }),
)

const devices = await call('/volume-bar/devices')
check('devices route reports readiness', devices.status === 200 && devices.json.ready === true, JSON.stringify(devices.json))

const missing = await call('/volume-bar/nope')
check('unknown routes answer 404', missing.status === 404, `status ${missing.status}`)

// Disposal (plugin unloaded / DSH shutting down) must drop the route, the leases
// and the helper process.
await call('/volume-bar/start', { method: 'POST', body: { clientId: 'win-z', ttlMs: 60000 } })
const beforeDispose = await call('/volume-bar/state')
check('a window is attached before disposal', beforeDispose.json.running === true && beforeDispose.json.leases === 1, JSON.stringify({ running: beforeDispose.json.running, leases: beforeDispose.json.leases }))
for (const disposer of disposers.reverse()) disposer()
check('disposal removes the HTTP route', handler === null, `handler ${typeof handler}`)
await wait(300)

console.log(results.join('\n'))
console.log('')
rmSync(home, { recursive: true, force: true })
if (FAILURES.length) {
  console.log(`${FAILURES.length} check(s) failed:`)
  for (const name of FAILURES) console.log(`  - ${name}`)
  process.exit(1)
}
console.log('all host checks passed')
process.exit(0)
