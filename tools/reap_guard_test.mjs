#!/usr/bin/env node
// Restart-safety regression test for the worker lock (#reapStale / kill).
//
// The lock file records `pid\nhostInstance`, and the host used to signal that pid
// blindly. Windows reuses pids, so a stale lock could name the DSH host itself and
// a restart would kill the app. These cases pin the guards:
//   A. a live process that is NOT the worker image survives the reap;
//   B. a lock naming this host (or its parent) never signals it;
//   C. killing the worker takes its PowerShell shell server down with it.
//
// Runs against a throwaway DSH_HOME, so the real profile lock is untouched.
// Usage: node tools/reap_guard_test.mjs

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..', 'packages', 'dsh-rust-exec')
const workerPath = join(pkgDir, 'bin', 'dsh-rust-worker.exe')

const home = mkdtempSync(join(tmpdir(), 'reap-guard-'))
mkdirSync(join(home, 'run'), { recursive: true })
process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'reapguard'
const { RustWorker } = await import(pathToFileURL(join(pkgDir, 'index.js')).href)

const lockFile = join(home, 'run', 'dsh-rust-worker-reapguard.lock')
const FOREIGN = 'previous-host-instance'

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `\n       ${detail}`}`)
}
const alive = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const ps = (script) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 20_000,
}).stdout?.trim() ?? ''
// Windows recycles pids fast, and an orphaned PowerShell keeps the (dead) parent pid in its
// record, so a bare ParentProcessId match can adopt another worker's leftovers. Only count
// children that were created at or after this worker started.
const FILE_TIME_EPOCH_MS = 11644473600000
const childPids = (pid, sinceMs = 0) => ps(
  `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.ToFileTimeUtc())" }`,
)
  .split(/\r?\n/)
  .map((line) => line.trim().split('|'))
  .filter(([id, fileTime]) => id && Number(fileTime) >= (sinceMs + FILE_TIME_EPOCH_MS) * 10_000 - 20_000)
  .map(([id]) => Number(id))
  .filter((value) => Number.isFinite(value) && value > 0)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const lockPid = () => Number(readFileSync(lockFile, 'utf8').trim().split(/\r?\n/)[0])
const hasLock = () => existsSync(lockFile)
const startWorker = async () => {
  const worker = new RustWorker(workerPath)
  await worker.start()
  return worker
}
const workerPidOf = (worker) => Number(worker.info?.welcome?.workerPid ?? worker.info?.workerPid ?? 0)

const bystander = spawn('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 180'], {
  windowsHide: true,
  stdio: 'ignore',
})
let worker

try {
  await sleep(700)

  // ---- A: a stale lock naming an unrelated live process must not kill it.
  writeFileSync(lockFile, `${bystander.pid}\n${FOREIGN}`)
  const startedAt = Date.now()
  worker = await startWorker()
  const workerPid = workerPidOf(worker)
  check(alive(bystander.pid), 'A: unrelated pid named by a stale lock survives the reap')
  check(
    !hasLock() || lockPid() === workerPid,
    'A: the stale lock is dropped or re-claimed by the new worker',
    `lock says ${hasLock() ? readFileSync(lockFile, 'utf8').trim().replace(/\r?\n/g, ' / ') : '(gone)'}, worker is ${workerPid}`,
  )

  // ---- C: worker.kill() removes the PowerShell grandchildren too.
  try {
    await worker.call('exec', { command: 'echo reap-guard' }, 60_000, undefined, 'default')
  } catch (error) {
    // Pre-warm can fail on a locked-down %TEMP%; case C only needs the child tree.
    console.log(`  note exec failed before the kill check: ${error.message}`)
  }
  const shells = childPids(workerPid, startedAt)
  check(shells.length > 0, 'C: worker has live PowerShell children after exec', `children of ${workerPid}: ${shells.length}`)

  worker.kill('reap guard test: case C')
  await sleep(2_000)
  check(!alive(workerPid), 'C: worker process is gone after kill()')
  const survivingShells = shells.filter(alive)
  check(
    survivingShells.length === 0,
    'C: no PowerShell child outlives the worker',
    `still alive: ${survivingShells.join(', ')}`,
  )

  // ---- B: a lock naming this host (or its parent) must never be signalled.
  writeFileSync(lockFile, `${process.pid}\n${FOREIGN}`)
  worker = await startWorker()
  check(alive(process.pid), 'B: a lock naming this host pid is ignored')

  worker.kill('reap guard test: case B2')
  await sleep(800)
  writeFileSync(lockFile, `${process.ppid}\n${FOREIGN}`)
  worker = await startWorker()
  check(alive(process.ppid), 'B: a lock naming the parent pid is ignored')
} catch (error) {
  check(false, 'test harness reached the end', error?.stack ?? String(error))
} finally {
  try {
    worker?.kill('reap guard test: cleanup')
  } catch {
    // Ignore: the process may already be gone.
  }
  try {
    process.kill(bystander.pid)
  } catch {
    // Ignore.
  }
  await sleep(500)
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // The temp home keeps a lock file at worst.
  }
}

const failed = results.filter((entry) => !entry.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
