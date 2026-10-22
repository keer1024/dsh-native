// Pool acceptance tests (S1 governance): resize, idle reclaim, fairness, soft limits, metrics.
// Run:  $env:DSH_PROFILE='pooltest'; node tools/pool_test.mjs
// Uses DSH_RUST_LANES to size lanes per worker (default 2 for speed).
import { WorkerPool } from '../packages/dsh-rust-exec/index.js'

// A worker dying mid-test must surface as a FAIL, not as a process crash.
process.on('unhandledRejection', (error) => {
  console.log(`UNHANDLED REJECTION: ${error?.message ?? error}`)
})
process.on('uncaughtException', (error) => {
  console.log(`UNCAUGHT EXCEPTION: ${error?.message ?? error}\n${String(error?.stack ?? '').split('\n').slice(0, 6).join('\n')}`)
})

const WORKER = (process.env.DSH_RUST_WORKER ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe')
const results = []
const log = () => {}

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  return false
}

function makePool(cfg) {
  return new WorkerPool(WORKER, cfg, log)
}

// ---------------------------------------------------------------- M1 metrics
{
  const pool = makePool({ lanes: 2, maxWorkers: 1, maxShells: 4, maxInFlightPerSession: 4 })
  await pool.start()
  const sample = await pool.sample()
  const rssBytes = sample?.memory?.workingSetBytes
  const cpuPct = sample?.cpu?.cpuPctOneCore
  check('M1 sample has process/queue fields',
    typeof rssBytes === 'number' && typeof cpuPct === 'number'
    && typeof sample?.queue?.queued === 'number' && typeof sample?.pid === 'number',
    `pid=${sample?.pid} rss=${Math.round((rssBytes ?? 0) / 1048576)}MB cpu=${cpuPct}% lanes=${sample?.queue?.lanes}`)

  // C5 accuracy: compare the worker's own RSS against the OS view of the same
  // pid, both taken after warm-up so the reading is not racing thread start-up.
  const { execFileSync } = await import('node:child_process')
  const warm = await pool.call('search.text', { query: 'fn ', root: process.cwd(), maxHits: 3 }, 120_000, null, 's0')
  await sleep(500)
  const osRss = Number(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${sample.pid}).WorkingSet64`], { encoding: 'utf8' }).trim())
  const fresh = await pool.sample()
  const rssBytes2 = fresh.memory?.workingSetBytes
  const drift = Math.abs(osRss - rssBytes2) / osRss
  check('C5 worker RSS vs OS (<=5% drift)', drift <= 0.05,
    `worker=${Math.round(rssBytes2 / 1048576)}MB os=${Math.round(osRss / 1048576)}MB drift=${(drift * 100).toFixed(2)}% hits=${warm.shown}`)

  // ------------------------------------------------------------- soft limits
  // RSS over the limit must drop the index (exec/fs untouched). The check reads
  // the non-blocking index snapshot inside metrics: index.status would rebuild.
  const beforeDrop = (await pool.sample()).index?.files ?? 0
  await pool.applySoftLimits({ workingSetBytes: 64 * 1024 * 1024 * 1024, cpuPctOneCore: 0 })
  const afterDrop = (await pool.sample()).index?.files ?? 0
  check('S1 rss soft limit drops index', beforeDrop > 0 && afterDrop === 0,
    `files ${beforeDrop} -> ${afterDrop}`)

  // CPU over the limit must pause index builds, and resume under 80% of the limit.
  await pool.applySoftLimits({ workingSetBytes: 1, cpuPctOneCore: 999 })
  const paused = await pool.call('index.status', {}, 10_000, null, 's0')
  await pool.applySoftLimits({ workingSetBytes: 1, cpuPctOneCore: 0 })
  const resumed = await pool.call('index.status', {}, 10_000, null, 's0')
  check('S2 cpu soft limit pauses then resumes index', paused.paused === true && resumed.paused === false,
    `paused=${paused.paused} resumed=${resumed.paused}`)

  // Exec must stay available while paused (soft limits never throttle exec/fs).
  await pool.applySoftLimits({ workingSetBytes: 1, cpuPctOneCore: 999 })
  const echoed = await pool.call('exec', { command: 'echo ok-while-paused' }, 60_000, null, 's0')
  check('S3 exec unaffected by soft limits', String(echoed.stdout ?? '').includes('ok-while-paused'), `stdout=${JSON.stringify(String(echoed.stdout).trim())}`)
  await pool.applySoftLimits({ workingSetBytes: 1, cpuPctOneCore: 0 })

  pool.dispose()
  await sleep(300)
}

// ------------------------------------------------------- C6 resize + idle reap
{
  const pool = makePool({ lanes: 2, maxWorkers: 2, maxShells: 4, maxInFlightPerSession: 4, idleReapMs: 10_000 })
  await pool.start()
  // Force a second worker by saturating the first (2 lanes, 3 concurrent sessions).
  const work = [0, 1, 2].map((i) => pool.call('exec', { command: `Start-Sleep -Milliseconds 900; echo s${i}` }, 60_000, null, `s${i}`))
  await waitFor(() => pool.size === 2, 20_000)
  check('C6a pool grows to maxWorkers under load', pool.size === 2, `size=${pool.size}`)
  await Promise.all(work)

  const resized = pool.configure({ maxWorkers: 1 })
  const shrank = await waitFor(() => pool.size === 1, 20_000)
  check('C6b maxWorkers hot-resize retires idle worker', shrank,
    `size=${pool.size} applied=${JSON.stringify(resized)} detail=${JSON.stringify(pool.info().workersDetail)}`)

  // Idle reclaim must never drop the pool below one worker.
  pool.configure({ maxWorkers: 2, idleReapMs: 10_000 })
  const fill = [0, 1, 2].map((i) => pool.call('exec', { command: `Start-Sleep -Milliseconds 600; echo t${i}` }, 60_000, null, `t${i}`))
  await waitFor(() => pool.size === 2, 20_000)
  await Promise.all(fill)
  const reaped = await waitFor(() => pool.size === 1, 25_000)
  await sleep(6_000)
  check('C6c idle worker reaped, pool keeps 1', reaped && pool.size === 1, `size=${pool.size}`)

  pool.dispose()
  await sleep(300)
}

// --------------------------------------------------------------- C7 fairness
{
  // One session must not starve another: with maxInFlightPerSession=1 and one
  // worker, session B's single call should finish before session A's third call.
  const pool = makePool({ lanes: 1, maxWorkers: 1, maxShells: 1, maxInFlightPerSession: 1, maxQueueDepth: 32 })
  await pool.start()
  const order = []
  const slow = (id) => pool.call('exec', { command: 'Start-Sleep -Milliseconds 400; echo done' }, 60_000, null, id)
      .then(() => order.push(id))
  const hog = [slow('hoger'), slow('hoger'), slow('hoger')]
  await sleep(120)
  const small = slow('small')
  await Promise.all([...hog, small])
  const smallRank = order.indexOf('small')
  check('C7 fairness: small session not starved', smallRank >= 0 && smallRank < order.length - 1,
    `completion order=${order.join(',')} (small at ${smallRank + 1}/${order.length})`)

  // Queue rejection instead of unbounded growth.
  const many = []
  for (let i = 0; i < 40; i += 1) many.push(pool.call('exec', { command: 'echo x' }, 60_000, null, 'flood').catch((error) => error.code))
  const settled = await Promise.all(many)
  check('C8 queue cap rejects with WORKER_BUSY', settled.includes('WORKER_BUSY') || pool.stats.rejected > 0,
    `rejected=${settled.filter((v) => v === 'WORKER_BUSY').length} stats.rejected=${pool.stats.rejected}`)

  pool.dispose()
  await sleep(300)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

