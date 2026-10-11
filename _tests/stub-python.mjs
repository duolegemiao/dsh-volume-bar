// Stand-in for the helper venv's python.exe in _tests/host.test.mjs.
//
// The host uses two shapes: `<python> -c "<probe>"` for the dependency probe and
// `<python> <lib/audio-levels.py>` for the capture process. A .cmd shim (see
// stub-python.cmd) forwards both here.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const probeMode = args.includes('-c')
const target = fileURLToPath(new URL(probeMode ? './stub-probe.mjs' : './stub-helper.mjs', import.meta.url))
const passed = args.filter((arg) => arg !== '-c')
const result = spawnSync(process.execPath, [target, ...passed], { stdio: 'inherit', env: process.env })
process.exit(result.status ?? 0)
