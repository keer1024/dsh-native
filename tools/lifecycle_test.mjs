// P1.5 lifecycle acceptance: four cases from docs/rust-exec-plugin/COMPANION_LIFECYCLE.md 搂4.3.
//
//   node tools/lifecycle_test.mjs
//
// Uses DSH_PROFILE=test so the lock file and worker instances never collide with
// the live DSH plugin's worker.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RustWorker } from '../packages/dsh-rust-exec/index.js'

const WORKER_EXE = process.env.DSH_RUST_WORKER
  ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe'
// The worker lock is keyed by profile, so the test process and the holder it spawns must
// resolve the same one: the stale-worker case reads the lock through this env var.
process.env.DSH_PROFILE = 'test'
const ENV = { ...process.env, DSH_PROFILE: 'test', DSH_RUST_WORKER_PATH: WORKER_EXE }
const results = []

function log(line) {
  console.log(line)
}

async function workerCount() {
  const { execFile } = await import('node:child_process')
  const out = await new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq dsh-rust-worker.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout))
  })
  return out.split('\n').filter((line) => line.toLowerCase().includes('dsh-rust-worker.exe')).length
}

async function waitFor(label, predicate, timeoutMs, intervalMs = 250) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return Date.now() - startedAt
    if (Date.now() - startedAt > timeoutMs) throw new Error(`${label}: timed out after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

function check(name, ok, detail) {
  results.push({ name, ok })
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Spawn tools/lifecycle_holder.mjs and wait for its READY line. */
async function startHolder() {
  const child = spawn(process.execPath, ['tools/lifecycle_holder.mjs'], {
    cwd: process.cwd(),
    env: ENV,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  })
  const pid = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('holder did not become ready')), 20_000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const match = /READY (\d+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.on('exit', (code) => reject(new Error(`holder exited early with code ${code}`)))
  })
  return { child, workerPid: pid }
}

async function case1RestartAfterKill() {
  log('\n[1] force-kill the worker 鈫?judged dead 鈮?0 s 鈫?restarted 鈫?next call succeeds')
  const worker = new RustWorker(WORKER_EXE)
  const first = await worker.call('exec', { command: 'echo lifecycle-1' }, 90_000)
  const pid = (await worker.health()).worker?.pid
  check('warm exec works', first.exitCode === 0 && String(first.stdout).includes('lifecycle-1'), `pid=${pid}`)
  process.kill(pid)
  const elapsed = await waitFor('restart', async () => {
    try {
      const again = await worker.call('exec', { command: 'echo lifecycle-1b' }, 90_000)
      return String(again.stdout).includes('lifecycle-1b')
    } catch {
      return false
    }
  }, 40_000)
  const health = await worker.health()
  // The first exec after a restart warms a fresh PowerShell, which costs ~15 s on a
  // cold Windows profile (module first use), so the budget covers the shell, not just the respawn.
  check('recovered within 40 s', elapsed <= 40_000, `${elapsed} ms`)
  check('restart counted', health.restarts >= 1, `restarts=${health.restarts}`)
  check('new pid differs', health.worker?.pid !== pid, `${pid} 鈫?${health.worker?.pid}`)
  worker.kill('case 1 done')
}

async function case2HostDeath() {
  log('\n[2] force-kill the host 鈫?worker exits on its own 鈮?5 s')
  const before = await workerCount()
  const holder = await startHolder()
  const during = await workerCount()
  process.kill(holder.child.pid)
  const elapsed = await waitFor('worker exit', async () => !alive(holder.workerPid), 15_000)
  check('worker died with its host', elapsed <= 15_000, `${elapsed} ms (workers ${before}鈫?{during}鈫?{await workerCount()})`)
}

async function case3StaleInstance() {
  log('\n[3] stale worker from another host instance 鈫?reaped by the new instance')
  const holder = await startHolder()
  const stalePid = holder.workerPid
  const worker = new RustWorker(WORKER_EXE)
  const started = Date.now()
  const lockPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'run', `dsh-rust-worker-${process.env.DSH_PROFILE}.lock`)
  const lockNow = () => { try { return readFileSync(lockPath, 'utf8').replace(/\r?\n/g, ' / ') } catch (error) { return 'MISSING ' + error.code } }
  log(`  holder worker=${stalePid}`)
  log(`  lock before start: ${lockNow()}`)
  await worker.start()
  log(`  lock after start: ${lockNow()}`)
  const elapsed = await waitFor('stale gone', async () => !alive(stalePid), 10_000)
  const health = await worker.health()
  check('stale worker reaped', !alive(stalePid), `${stalePid} gone in ${elapsed} ms`)
  check('own worker adopted', health.worker?.pid !== stalePid, `fresh pid=${health.worker?.pid} (start ${Date.now() - started} ms)`)
  worker.kill('case 3 done')
  process.kill(holder.child.pid)
}

async function case4Suspend() {
  log('\n[4] host frozen 20 s (suspend/GC) 鈫?worker survives, next call fine')
  const worker = new RustWorker(WORKER_EXE)
  await worker.call('exec', { command: 'echo lifecycle-4' }, 90_000)
  const pid = (await worker.health()).worker?.pid
  // Block the event loop: no heartbeats leave the host for 20 s.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000)
  const after = await worker.call('exec', { command: 'echo lifecycle-4b' }, 90_000)
  const health = await worker.health()
  check('worker survived the freeze', health.worker?.pid === pid, `pid ${pid}`)
  check('next call works', String(after.stdout).includes('lifecycle-4b'))
  check('no false restart', health.restarts === 0, `restarts=${health.restarts} misses=${health.misses}`)
  worker.kill('case 4 done')
}

await workerCount() // warm tasklist
try {
  await case1RestartAfterKill()
  await case2HostDeath()
  await case3StaleInstance()
  await case4Suspend()
} catch (error) {
  log(`\nERROR ${error.message}`)
  results.push({ name: 'harness', ok: false })
}
const failed = results.filter((entry) => !entry.ok)
log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const entry of failed) log(`  failed: ${entry.name}`)
}
// Child stdio and holder handles can keep the loop alive; the verdict is final.
process.exit(failed.length > 0 ? 1 : 0)

