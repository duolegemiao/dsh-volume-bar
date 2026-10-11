/**
 * Stub for the dependency probe (see _tests/host.test.mjs).
 *
 * The host runs its probe with `python -c "<script>"`, which Node cannot do, so
 * the test points `DSH_VOLUME_BAR_PROBE` at this file. Set `VB_STUB_PROBE` to
 * `ok` (default), `broken` or `slow` to shape the report.
 */

const behavior = process.env.VB_STUB_PROBE ?? 'ok'

if (behavior === 'slow') {
  setTimeout(finish, 1200)
} else {
  finish()
}

function finish() {
  const info = { probe: 'dsh-volume-bar', python: '3.12.0-stub', executable: process.execPath }
  if (behavior === 'broken') {
    info.pyaudiowpatch = null
    info.numpy = null
    info.error = 'ImportError: no audio backend'
  } else if (behavior === 'numpy-missing') {
    info.pyaudiowpatch = '0.2.12.9'
    info.numpy = null
    info.devices = 1
    info.defaultLoopback = true
  } else {
    info.pyaudiowpatch = '0.2.12.9'
    info.numpy = '2.3.5'
    info.devices = 2
    info.defaultLoopback = true
  }
  process.stdout.write(`${JSON.stringify(info)}\n`)
  process.exit(0)
}

