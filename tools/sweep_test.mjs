// Startup sweep check: a force-killed worker leaks its warm PowerShell shells (the shell is a
// grandchild, so a plain `taskkill /F` on the worker leaves it behind), and the next worker must
// sweep them by "-EncodedCommand" + dead parent.
//
// usage: node tools/sweep_test.mjs [path-to-exe]
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const exe = process.argv[2]
  ?? process.env.DSH_RUST_WORKER
  ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const QUERY = '$alive=@(Get-Process|Select-Object -ExpandProperty Id);'
  + 'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'"'
  + '|Where-Object{$_.CommandLine -like \'*-EncodedCommand*\' -and ($alive -notcontains $_.ParentProcessId)}'
  + '|ForEach-Object{$_.ProcessId}'
const ps = (script) => spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
  encoding: 'utf8',
}).stdout.trim()
const orphanShells = () => ps(QUERY).split(/\r?\n/).map((line) => Number(line.trim())).filter((pid) => pid > 0)
const alive = (pid) => ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Measure-Object).Count`) === '1'

/** Minimal Content-Length framed JSON-RPC client, enough to reach `hello`/`initialize`. */
function startWorker() {
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const state = { child, buf: Buffer.alloc(0), pending: new Map(), nextId: 1, pid: 0 }
  child.stdout.on('data', (data) => {
    state.buf = Buffer.concat([state.buf, data])
    for (;;) {
      const sep = state.buf.indexOf('\r\n\r\n')
      if (sep < 0) break
      const match = /content-length:\s*(\d+)/i.exec(state.buf.subarray(0, sep).toString('ascii'))
      if (!match) break
      const from = sep + 4
      const to = from + Number(match[1])
      if (state.buf.length < to) break
      const message = JSON.parse(state.buf.subarray(from, to).toString('utf8'))
      state.buf = state.buf.subarray(to)
      const waiter = state.pending.get(message.id)
      if (!waiter) continue
      state.pending.delete(message.id)
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
    }
  })
  state.request = (method, params) => new Promise((resolve, reject) => {
    const id = state.nextId++
    state.pending.set(id, { resolve, reject })
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    child.stdin.write(body)
    setTimeout(() => { if (state.pending.delete(id)) reject(new Error(`${method} timed out`)) }, 30_000)
  })
  return state
}

const boot = async (worker) => {
  const hello = await worker.request('hello', {
    protocol: 1, hostPid: process.pid, hostInstance: randomUUID(), cwd: process.cwd(),
  })
  worker.pid = Number(hello.workerPid ?? 0)
  await worker.request('initialize', {})
  return worker
}

const results = []
const check = (ok, label, detail = '') => {
  results.push(ok)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `\n       ${detail}`}`)
}

const before = orphanShells()
console.log(`orphans before: ${before.length ? before.join(', ') : '(none)'}`)

const first = await boot(startWorker())
await sleep(1_500)
const children = Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${first.pid}" | Measure-Object).Count`))
check(children > 0, 'the worker warmed PowerShell children', `children=${children}`)

// Kill only the worker (no /T): the shells stay behind with a dead parent.
spawnSync('taskkill', ['/PID', String(first.pid), '/F'], { encoding: 'utf8' })
await sleep(800)
const leaked = orphanShells().filter((pid) => !before.includes(pid))
check(leaked.length > 0, 'a force-killed worker leaks its shells', `leaked: ${leaked.join(', ')}`)

const second = await boot(startWorker())
await sleep(3_000)
const survivors = leaked.filter(alive)
check(survivors.length === 0, 'the next worker sweeps the leaked shells', `surviving: ${survivors.join(', ')}`)

spawnSync('taskkill', ['/PID', String(second.pid), '/T', '/F'], { encoding: 'utf8' })
second.child.stdin.end()

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
