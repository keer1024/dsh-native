// Acceptance tests C1–C9 for the P2.5 concurrency work, driven through the
// plugin's own RustWorker client against the real worker binary.
//
// Run: node tools/concurrency_test.mjs [laneCount]
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RustWorker } from '../packages/dsh-rust-exec/index.js'

const WORKER = 'C:\\Users\\keer_\\Documents\\deepseek-harness\\default-workspace\\packages\\dsh-rust-worker\\target\\release\\dsh-rust-worker.exe'
const LANES = Number(process.argv[2] ?? 4)
const dir = mkdtempSync(join(tmpdir(), 'dsh-rust-c-'))
const worker = new RustWorker(WORKER, { lanes: LANES, maxQueueDepth: 64 })

const results = []
function record(id, ok, detail) {
  results.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function exec(command, extra = {}) {
  const started = performance.now()
  const value = await worker.call('exec', { command, ...extra }, 60_000)
  return { ...value, wallMs: Math.round(performance.now() - started) }
}

try {
  const caps = await worker.call('caps', {}, 15_000)
  console.log(`caps: lanes=${caps.lanes} metrics=${caps.metrics} features=${JSON.stringify(caps.capabilities)}`)

  // ---- C4: burst of 8 calls over 4 lanes: queue forms, everything succeeds
  const burst = await Promise.all(
    Array.from({ length: 8 }, (_, i) => exec(`Start-Sleep -Milliseconds 400; 'burst-${i}'`)),
  )
  const burstOk = burst.every((r, i) => r.stdout.trim() === `burst-${i}`)
  const stats = await worker.call('exec.stats', {}, 5_000)
  record('C4-burst-8', burstOk, `8 calls ok=${burstOk} peakQueued=${stats.peakQueued} lanes=${stats.lanes} maxWall=${Math.max(...burst.map((r) => r.wallMs))}ms`)

  // ---- C1/C7: 3 concurrent calls with different cwd must not leak into each other
  const dirA = join(dir, 'a')
  const dirB = join(dir, 'b')
  const dirC = join(dir, 'c')
  for (const path of [dirA, dirB, dirC]) {
    rmSync(path, { recursive: true, force: true })
    writeFileSync(join(dir, 'placeholder'), '', { flag: 'w' })
    // eslint-disable-next-line no-await-in-loop
  }
  const mk = await exec(`New-Item -ItemType Directory -Force '${dirA}','${dirB}','${dirC}' | Out-Null; 'ok'`)
  const c1Start = performance.now()
  const three = await Promise.all([
    exec(`Start-Sleep -Milliseconds 500; (Get-Location).Path`, { cwd: dirA }),
    exec(`Start-Sleep -Milliseconds 500; (Get-Location).Path`, { cwd: dirB }),
    exec(`Start-Sleep -Milliseconds 500; (Get-Location).Path`, { cwd: dirC }),
  ])
  const c1Wall = Math.round(performance.now() - c1Start)
  const c1Ok = three[0].stdout.includes('a') && three[1].stdout.includes('b') && three[2].stdout.includes('c')
    && !three[0].stdout.includes('\\b') && c1Wall < 1_400
  record('C1-cwd-isolation', c1Ok, `3 parallel calls wall=${c1Wall}ms (serial would be >1500) cwds=${three.map((r) => r.stdout.trim()).join(',')}`)
  record('C7-same-step-parallel', c1Wall < 1_400, `3 calls in one step took ${c1Wall}ms — parallel, not 3x500`)

  // ---- T1: warm throughput — the whole point of lanes
  const seqStart = performance.now()
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await exec(`Start-Sleep -Milliseconds 300; 'seq-${i}'`)
  }
  const seqMs = Math.round(performance.now() - seqStart)
  const conStart = performance.now()
  await Promise.all(Array.from({ length: 4 }, (_, i) => exec(`Start-Sleep -Milliseconds 300; 'con-${i}'`)))
  const conMs = Math.round(performance.now() - conStart)
  record('T1-throughput', conMs < seqMs * 0.6, `4 x 300ms: sequential=${seqMs}ms concurrent=${conMs}ms = x${(seqMs / Math.max(conMs, 1)).toFixed(2)} faster`)

  // ---- C8: a reader never observes a partially written file
  const shared = join(dir, 'shared.txt')
  writeFileSync(shared, 'a'.repeat(64))
  const writer = exec(`[IO.File]::WriteAllText('${shared}', ('b' * 5000)); 'wrote'`)
  const readerResults = await Promise.all([
    exec(`try { (Get-Content -Raw '${shared}').Length } catch { -1 }`),
    exec(`try { (Get-Content -Raw '${shared}').Length } catch { -1 }`),
  ])
  await writer
  const finalText = readFileSync(shared, 'utf8')
  const observed = readerResults.map((r) => r.stdout.trim())
  const c8Ok = finalText.length === 5000
    && finalText === 'b'.repeat(5000)
    && observed.every((value) => value === '64' || value === '5000')
  record('C8-read-during-write', c8Ok, `observed lengths=${JSON.stringify(observed)} final=${finalText.length} (whole 64 or 5000 only)`)

  // ---- C3: one stalled call times out on its own lane, other lanes unaffected
  const stalled = exec(`Start-Sleep -Seconds 20; 'late'`, { timeoutMs: 1_500 }).then(
    () => ({ timedOut: false }),
    (error) => ({ timedOut: true, message: error.message }),
  )
  await sleep(300)
  const parallel = await Promise.all([exec(`'p1'`), exec(`'p2'`), exec(`'p3'`)])
  const stalledResult = await stalled
  const c3Ok = stalledResult.timedOut && parallel.every((r) => r.stdout.trim().startsWith('p'))
  record('C3-stall-isolation', c3Ok, `stalled=${stalledResult.timedOut ? 'timed out' : 'completed'} others=${parallel.map((r) => r.stdout.trim()).join('/')}`)

  // ---- C2: concurrent writes to the same path with a version guard
  const guarded = join(dir, 'guarded.txt')
  await exec(`Set-Content -Path '${guarded}' -Value 'v0'`)
  const before = await worker.call('fs.read', { path: guarded }, 10_000)
  const both = await Promise.allSettled([
    worker.call('fs.write', { path: guarded, content: 'v1', expectedHash: before.hash }, 10_000),
    worker.call('fs.write', { path: guarded, content: 'v2', expectedHash: before.hash }, 10_000),
  ])
  const wins = both.filter((r) => r.status === 'fulfilled').length
  const conflicts = both.filter((r) => r.status === 'rejected' && /VERSION|version|conflict/i.test(r.reason?.message ?? '')).length
  const c2Ok = wins === 1 && conflicts === 1
  record('C2-same-path-conflict', c2Ok, `wins=${wins} conflicts=${conflicts} (expected 1/1)`)

  // ---- C9: abort exactly one in-flight call
  const abortCallId = 'abort-test-call'
  const aborting = worker.call('exec', { command: `Start-Sleep -Seconds 20; 'never'`, callId: abortCallId, timeoutMs: 30_000 }, 40_000)
    .then(() => ({ aborted: false }), (error) => ({ aborted: error?.message ?? String(error) }))
  await sleep(600)
  const keep = Promise.all([exec(`'k1'`), exec(`'k2'`)])
  const abortAck = await worker.call('exec.abort', { callId: abortCallId }, 10_000)
  const abortOutcome = await aborting
  const keepOutcome = await keep
  const c9Ok = abortAck.aborted === true
    && abortOutcome.aborted !== false
    && keepOutcome.every((r) => r.stdout.trim().startsWith('k'))
  record('C9-abort-one', c9Ok, `ack=${JSON.stringify(abortAck)} abortedErr=${String(abortOutcome.aborted).slice(0, 60)} others=${keepOutcome.map((r) => r.stdout.trim()).join('/')}`)

  // ---- metrics: process resources + queue visible
  const metrics = await worker.call('metrics.sample', {}, 10_000)
  const metricsOk = metrics && metrics.memory && metrics.memory.workingSetBytes > 0
    && metrics.cpu && typeof metrics.cpu.cpuMsTotal === 'number'
    && metrics.queue && typeof metrics.queue.lanes === 'number'
  record('M1-metrics', metricsOk, `rss=${(metrics?.memory?.workingSetBytes / 1048576).toFixed(1)}MB cpuMs=${metrics?.cpu?.cpuMsTotal} cpuPct=${metrics?.cpu?.cpuPctOneCore} lanes=${metrics?.queue?.lanes} inflight=${metrics?.queue?.inflight} handles=${metrics?.handles}`)
  const health = await worker.call('worker.health', {}, 5_000)
  record('M2-health', typeof health?.hostAlive === 'boolean' || health?.hostPid > 0, JSON.stringify(health).slice(0, 160))
} catch (error) {
  record('SUITE-ERROR', false, error?.stack ?? String(error))
} finally {
  worker.kill('acceptance run finished')
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // temp dir cleanup is best effort
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
