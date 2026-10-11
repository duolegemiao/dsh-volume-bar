/**
 * Test double for the helper venv python used by _tests/host.test.mjs.
 *
 * The host launches it as `<python> <lib/audio-levels.py>` for the capture
 * process and as `<python> -m venv|-m pip ...` for setup steps; the first shape
 * streams frames, the second is acknowledged and exits at once. This keeps the
 * host routes testable without an audio device or a real install.
 */

const args = process.argv.slice(2)
const helperMode = args.some((arg) => arg.endsWith('audio-levels.py')) || process.env.VB_STUB_FORCE_HELPER === '1'
if (!helperMode) {
  process.stdout.write('stub setup step acknowledged\n')
  process.exit(0)
}

const generation = 'stub-gen-1'
const hello = {
  type: 'hello',
  version: '0.7.0',
  generation,
  device: { mode: 'system-default', name: 'Stub Speakers', defaultName: 'Stub Speakers', index: 3, isDefault: true },
  devices: [{ index: 3, name: 'Stub Speakers', rate: 48000, channels: 2 }],
  rate: 48000,
  channels: 2,
  bands: 8,
  bandEdgesHz: [[40, 82], [82, 166]],
  analysisMode: 'numpy-fft',
  windowSamples: 2048,
  hopSamples: 1024,
}
process.stdout.write(`${JSON.stringify(hello)}\n`)

// A deliberately broken frame and an oversized line exercise the host's frame
// validation without crashing it.
process.stdout.write('{"type":"level","rms":null,"peak":0.5,"bands":[]}\n')
process.stdout.write(`${'x'.repeat(20 * 1024)}\n`)

let seq = 0
let stopped = false
const publish = () => {
  if (stopped) return
  seq += 1
  process.stdout.write(
    `${JSON.stringify({ type: 'level', generation, seq, rms: 0.25, peak: 0.5, bands: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] })}\n`,
  )
}
const timer = setInterval(publish, 20)

const shutdown = () => {
  if (stopped) return
  stopped = true
  clearInterval(timer)
  // Proves the helper honours the graceful stop protocol.
  process.stderr.write('stub helper stopped\n')
  process.exit(0)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (String(chunk).includes('stop')) shutdown()
})
process.stdin.on('end', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
