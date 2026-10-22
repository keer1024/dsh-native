/**
 * Host bundle: exposes the prebuilt `dsh-rust-worker` sidecar as DSH tools.
 *
 * The sidecar speaks LSP-style framed JSON-RPC 2.0 over stdin/stdout
 * (`Content-Length: <N>\r\n\r\n` + N bytes of JSON) and keeps one warm
 * PowerShell behind a loopback socket. This plugin owns a pool of 1..maxWorkers
 * worker children, spawns them on demand (the first one eagerly at apply time),
 * matches responses by request id, and kills the pool when the plugin is disposed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { cpus, homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
/** Shipping layout: the worker binary travels inside this package (`files: bin/...`). */
const BUNDLED_WORKER_PATH = join(PLUGIN_DIR, 'bin', process.platform === 'win32' ? 'dsh-rust-worker.exe' : 'dsh-rust-worker')
/** Development fallback: the cargo output directory of the sibling worker package. */
const DEV_WORKER_PATH = join(PLUGIN_DIR, '..', 'dsh-rust-worker', 'target', 'release',
  process.platform === 'win32' ? 'dsh-rust-worker.exe' : 'dsh-rust-worker')
const DEFAULT_WORKER_PATH = existsSync(BUNDLED_WORKER_PATH) ? BUNDLED_WORKER_PATH : DEV_WORKER_PATH
/** Working directory for spawned workers; the host's cwd is the workspace in a normal session. */
const WORKER_CWD = process.env.DSH_RUST_WORKER_CWD || process.cwd()
const DEFAULT_TIMEOUT_MS = 60_000
const START_TIMEOUT_MS = 15_000
/** Extra time the plugin waits beyond a command's own timeout before killing the worker. */
const SHELL_TIMEOUT_GRACE_MS = 5_000
const MAX_STDERR_BYTES = 2_000
const SEARCH_TIMEOUT_MS = 60_000
// A cold projection of a multi-megabyte log pays zstd decode + JSON parse once; the cache makes
// later opens cheap, so this only bounds the worst-case first open.
const SESSION_TIMEOUT_MS = 120_000
/** Must match `PROTOCOL_VERSION` in the worker's main.rs. */
const HELLO_VERSION = 1
const HANDSHAKE_TIMEOUT_MS = 5_000
/** Symmetric beacon period; the worker sends `worker.hb` on the same cadence. */
const HEARTBEAT_MS = 2_000
/** Silence after which the worker is *suspected* dead (probes follow, not a kill). */
const WORKER_SILENCE_MS = 10_000
const PROBE_GAP_MS = 1_000
/** A gap this large means the host was suspended; re-arm instead of judging. */
const SUSPEND_GAP_MS = 60_000
/** Delays between restart attempts; the last value repeats. */
const RESTART_BACKOFF_MS = [0, 500, 2_000, 5_000, 30_000]

// Lanes: independent shells inside the worker, so concurrent calls do not queue
// behind one REPL. The worker clamps this to its own hard limit.
const DEFAULT_LANES = 4
const MAX_LANES = 16
const DEFAULT_MAX_QUEUE_DEPTH = 64

// Pool: several worker processes, so one wedged worker cannot take every session
// down with it. The default stays at ONE process because lanes already give
// ×3.97 single-process concurrency while each extra process pays its own ~3 s
// shell cold start; multi-process is an isolation knob, not a throughput knob.
const MAX_WORKERS = 8
const DEFAULT_MAX_WORKERS = 1
const DEFAULT_MAX_SHELLS = 8
const MAX_SHELLS = 64
const MAX_INFLIGHT_PER_SESSION_LIMIT = 64
const DEFAULT_IDLE_REAP_MS = 300_000
const MIN_IDLE_REAP_MS = 10_000
/** How long a drained queue stays rejected before the caller may retry. */
const QUEUE_RETRY_MS = 250
const POOL_TICK_MS = 5_000
/** Cooldown between two RSS-driven index drops. */
const SOFT_LIMIT_DROP_COOLDOWN_MS = 60_000

// Metrics: 1 s sampling, ~5 min of fast points, 1 min buckets for the long view.
const DEFAULT_METRICS_INTERVAL_MS = 1_000
const METRICS_FAST_POINTS = 300
const METRICS_SLOW_BUCKETS = 60
const METRICS_SLOW_BUCKET_MS = 60_000
const METRICS_ROUTE_PREFIX = '/api/dsh-rust-exec'

export const inject = ['tools']

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Standard Schema: Cordis validates a Loader row's `config` through
 * `Config['~standard'].validate` and passes the returned `value` to `apply`.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-rust-exec',
    validate(value) {
      const raw = value ?? {}
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      const issues = []
      if (raw.workerPath !== undefined
        && (typeof raw.workerPath !== 'string' || raw.workerPath.trim() === '')) {
        issues.push({ message: 'workerPath must be a non-empty string', path: ['workerPath'] })
      }
      if (raw.defaultTimeoutMs !== undefined
        && !(typeof raw.defaultTimeoutMs === 'number'
          && Number.isFinite(raw.defaultTimeoutMs)
          && raw.defaultTimeoutMs > 0)) {
        issues.push({ message: 'defaultTimeoutMs must be a positive number', path: ['defaultTimeoutMs'] })
      }
      if (raw.lanes !== undefined
        && !(Number.isInteger(raw.lanes) && raw.lanes >= 1 && raw.lanes <= MAX_LANES)) {
        issues.push({ message: `lanes must be an integer from 1 to ${MAX_LANES}`, path: ['lanes'] })
      }
      if (raw.maxQueueDepth !== undefined
        && !(Number.isInteger(raw.maxQueueDepth) && raw.maxQueueDepth >= 1 && raw.maxQueueDepth <= 4096)) {
        issues.push({ message: 'maxQueueDepth must be an integer from 1 to 4096', path: ['maxQueueDepth'] })
      }
      if (raw.metricsIntervalMs !== undefined
        && !(typeof raw.metricsIntervalMs === 'number' && raw.metricsIntervalMs >= 250)) {
        issues.push({ message: 'metricsIntervalMs must be a number of at least 250', path: ['metricsIntervalMs'] })
      }
      if (raw.maxWorkers !== undefined
        && !(Number.isInteger(raw.maxWorkers) && raw.maxWorkers >= 1 && raw.maxWorkers <= MAX_WORKERS)) {
        issues.push({ message: `maxWorkers must be an integer from 1 to ${MAX_WORKERS}`, path: ['maxWorkers'] })
      }
      if (raw.maxShells !== undefined
        && !(Number.isInteger(raw.maxShells) && raw.maxShells >= 1 && raw.maxShells <= MAX_SHELLS)) {
        issues.push({ message: `maxShells must be an integer from 1 to ${MAX_SHELLS}`, path: ['maxShells'] })
      }
      if (raw.maxInFlightPerSession !== undefined
        && !(Number.isInteger(raw.maxInFlightPerSession)
          && raw.maxInFlightPerSession >= 1
          && raw.maxInFlightPerSession <= MAX_INFLIGHT_PER_SESSION_LIMIT)) {
        issues.push({
          message: `maxInFlightPerSession must be an integer from 1 to ${MAX_INFLIGHT_PER_SESSION_LIMIT}`,
          path: ['maxInFlightPerSession'],
        })
      }
      if (raw.idleReapMs !== undefined
        && !(typeof raw.idleReapMs === 'number' && raw.idleReapMs >= MIN_IDLE_REAP_MS)) {
        issues.push({ message: `idleReapMs must be a number of at least ${MIN_IDLE_REAP_MS}`, path: ['idleReapMs'] })
      }
      if (raw.rssSoftLimitMb !== undefined
        && !(Number.isInteger(raw.rssSoftLimitMb) && raw.rssSoftLimitMb >= 64 && raw.rssSoftLimitMb <= 65536)) {
        issues.push({ message: 'rssSoftLimitMb must be an integer from 64 to 65536', path: ['rssSoftLimitMb'] })
      }
      if (raw.cpuSoftLimitPct !== undefined
        && !(typeof raw.cpuSoftLimitPct === 'number' && raw.cpuSoftLimitPct >= 10 && raw.cpuSoftLimitPct <= 100)) {
        issues.push({ message: 'cpuSoftLimitPct must be a number from 10 to 100', path: ['cpuSoftLimitPct'] })
      }
      if (issues.length > 0) return { issues }
      return { value: normalizeConfig(raw) }
    },
  },
}

function coreCount() {
  const cores = cpus()?.length ?? 4
  return Math.max(1, cores)
}

function normalizeConfig(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const lanes = Number.isInteger(raw.lanes) && raw.lanes >= 1 && raw.lanes <= MAX_LANES
    ? raw.lanes
    : Math.max(1, Math.min(DEFAULT_LANES, Math.floor(coreCount() / 2)))
  const maxWorkers = Number.isInteger(raw.maxWorkers) && raw.maxWorkers >= 1 && raw.maxWorkers <= MAX_WORKERS
    ? raw.maxWorkers
    : DEFAULT_MAX_WORKERS
  return {
    workerPath: typeof raw.workerPath === 'string' && raw.workerPath.trim() !== ''
      ? raw.workerPath
      : DEFAULT_WORKER_PATH,
    defaultTimeoutMs: typeof raw.defaultTimeoutMs === 'number' && raw.defaultTimeoutMs > 0
      ? raw.defaultTimeoutMs
      : DEFAULT_TIMEOUT_MS,
    lanes,
    maxQueueDepth: Number.isInteger(raw.maxQueueDepth) && raw.maxQueueDepth >= 1
      ? raw.maxQueueDepth
      : DEFAULT_MAX_QUEUE_DEPTH,
    metricsIntervalMs: typeof raw.metricsIntervalMs === 'number' && raw.metricsIntervalMs >= 250
      ? raw.metricsIntervalMs
      : DEFAULT_METRICS_INTERVAL_MS,
    maxWorkers,
    maxShells: Number.isInteger(raw.maxShells) && raw.maxShells >= 1 && raw.maxShells <= MAX_SHELLS
      ? raw.maxShells
      : DEFAULT_MAX_SHELLS,
    // Fairness default: a session may run as many calls as one worker has lanes,
    // so same-step fan-out is not throttled below the lane count.
    maxInFlightPerSession: Number.isInteger(raw.maxInFlightPerSession)
      && raw.maxInFlightPerSession >= 1
      && raw.maxInFlightPerSession <= MAX_INFLIGHT_PER_SESSION_LIMIT
      ? raw.maxInFlightPerSession
      : lanes,
    idleReapMs: typeof raw.idleReapMs === 'number' && raw.idleReapMs >= MIN_IDLE_REAP_MS
      ? raw.idleReapMs
      : DEFAULT_IDLE_REAP_MS,
    rssSoftLimitMb: Number.isInteger(raw.rssSoftLimitMb) && raw.rssSoftLimitMb >= 64
      ? raw.rssSoftLimitMb
      : 512,
    cpuSoftLimitPct: typeof raw.cpuSoftLimitPct === 'number' && raw.cpuSoftLimitPct >= 10
      ? raw.cpuSoftLimitPct
      : 70,
  }
}

// ---------------------------------------------------------------------------
// Worker client: one framed-JSON-RPC child process, lazy, self-healing
// ---------------------------------------------------------------------------

/** Where the worker records `pid\nhostInstance`; mirrors `claim_lock` in main.rs. */
function workerLockPath() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
  return join(home, 'run', `dsh-rust-worker-${process.env.DSH_PROFILE ?? 'default'}.lock`)
}

/**
 * Identity of *this* DSH host process. It must be shared by every worker in the
 * pool: the single-instance lock file is one per profile, so a per-worker token
 * would make each new worker read a sibling's token, treat it as stale and kill
 * it (observed: exit code 1 right after the pool grew to two workers).
 */
const HOST_INSTANCE = randomUUID()

const WINDOWS = process.platform === 'win32'

/** Image name a lock file's pid must still be running before we signal it. */
function workerImageName(workerPath) {
  return basename(workerPath).toLowerCase()
}

/**
 * Whether `pid` currently runs the worker image: `'yes'`, `'no'` (a different
 * process, or nothing at all) or `'unknown'` (the probe itself failed).
 *
 * A pid read back from a stale lock file is not identity: Windows reuses pids,
 * so the same number can be the DSH host itself, a browser, or anything else the
 * user started since. The probe runs while the machine may be busy starting a
 * PowerShell, so a failed `tasklist` must not be read as "not the worker" — that
 * would silently drop the lock and leak the worker. It gets two retries instead.
 */
function probeWorkerImage(pid, expectedImage) {
  if (!WINDOWS) return 'no'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const probe = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8_000,
    })
    if (!probe.error && probe.status === 0 && typeof probe.stdout === 'string') {
      // CSV row: "dsh-rust-worker.exe","23304","Console","1","12,345 K"
      const row = probe.stdout.trim().split(/\r?\n/)[0] ?? ''
      const image = row.match(/^"([^"]+)"/)?.[1]?.toLowerCase()
      if (!image) return 'no'
      return image === expectedImage ? 'yes' : 'no'
    }
    if (attempt < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
  }
  return 'unknown'
}

/**
 * Kill `pid` and everything it started. The worker owns a PowerShell shell
 * server; a bare `child.kill()` leaves those grandchildren holding the pipes.
 */
function killProcessTree(pid) {
  if (WINDOWS) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10_000,
      })
    } catch {
      // taskkill can race the child's own exit; the worker pid watch covers that case.
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/** Drop the lock, but only if it still holds the exact record we judged stale. */
function dropStaleLock(expectedText) {
  try {
    if (readFileSync(workerLockPath(), 'utf8') === expectedText) unlinkSync(workerLockPath())
  } catch {
    // Raced with a fresh claim: the next hello rewrites it anyway.
  }
}

/** The record this host writes for one of its workers; `claim_lock` in main.rs uses the same shape. */
function lockText(pid) {
  return `${pid}\n${HOST_INSTANCE}`
}

/**
 * Write the profile lock from the host side. The worker tries too, but a worker
 * launched at low integrity (DSH's sandbox marks images kept in the workspace)
 * is denied every write outside the workspace, so `~/.dsh/run` writes fail there
 * with `拒绝访问`. The host is the reliable writer; on a later boot #reapStale
 * uses this record to clear a worker the previous host left behind.
 */
function claimWorkerLock(pid) {
  const text = lockText(pid)
  try {
    mkdirSync(dirname(workerLockPath()), { recursive: true })
    writeFileSync(workerLockPath(), text, 'utf8')
    return text
  } catch {
    return null
  }
}

/** Remove this host's record for `pid` (a different record belongs to someone else). */
function releaseWorkerLock(pid) {
  if (!pid) return
  dropStaleLock(lockText(pid))
}

export class RustWorker {
  #child = null
  #pending = new Map()
  #buffer = Buffer.alloc(0)
  #stderr = ''
  #nextId = 1
  #starting = null
  #writeChain = Promise.resolve()
  #lastInboundAt = 0
  #beatTimer = null
  #probing = false
  #restarts = 0
  #failCount = 0
  #restartAt = 0
  #misses = 0
  #lastExitCode = null
  /** pid this host recorded in the profile lock for the current child. */
  #lockPid = null
  /** Gaps between inbound frames; the heartbeat should keep these near 2 s. */
  #activityGaps = []
  /** `hello` + `initialize` results, kept for diagnostics; null while stopped. */
  info = null

  constructor(workerPath, options = {}) {
    this.workerPath = workerPath
    this.options = {
      lanes: options.lanes ?? DEFAULT_LANES,
      maxQueueDepth: options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
    }
  }

  /** Whether a live child exists; the metrics snapshot reports this. */
  get running() {
    return this.#child !== null
  }

  /** Start the child if needed. Concurrent first calls share one spawn. */
  start() {
    if (this.#child) return Promise.resolve(this.info)
    const wait = this.#restartAt - Date.now()
    if (wait > 0) {
      // Hard failure after the backoff ladder is exhausted: say so instead of
      // silently retrying on every tool call.
      if (this.#failCount > RESTART_BACKOFF_MS.length) {
        return Promise.reject(new Error(
          `rust worker failed to start ${this.#failCount} times in a row; `
          + `next retry in ${Math.ceil(wait / 1000)} s`,
        ))
      }
      return new Promise((resolve) => setTimeout(resolve, wait)).then(() => this.start())
    }
    this.#starting ??= this.#spawn().finally(() => { this.#starting = null })
    return this.#starting
  }

  /** Send one JSON-RPC request, starting the worker on demand. */
  async call(method, params, timeoutMs, signal) {
    await this.start()
    try {
      return await this.#request(method, params, timeoutMs, signal)
    } catch (error) {
      // A local timeout leaves the worker in an unknown state; drop it so the
      // next call gets a fresh child instead of a wedged one.
      if (error?.code === 'WORKER_TIMEOUT') this.kill('rust worker killed after a request timeout')
      throw error
    }
  }

  /** Lifecycle snapshot: local counters merged with the worker's own view. */
  async health() {
    const local = {
      hostPid: process.pid,
      hostInstance: HOST_INSTANCE,
      running: this.#child !== null,
      inflight: this.#pending.size,
      restarts: this.#restarts,
      misses: this.#misses,
      failCount: this.#failCount,
      lastExitCode: this.#lastExitCode,
      inboundGapP50: percentile(this.#activityGaps, 50),
      inboundGapP99: percentile(this.#activityGaps, 99),
    }
    if (!this.#child) return local
    try {
      return { ...local, worker: await this.#request('worker.health', {}, 5_000) }
    } catch (error) {
      return { ...local, healthError: error.message }
    }
  }

  /** Stop the child and reject everything still waiting on it. */
  kill(reason = 'rust worker stopped') {
    this.#stopHeartbeat()
    const child = this.#child
    const lockPid = this.#lockPid
    this.#lockPid = null
    this.#child = null
    this.info = null
    this.#buffer = Buffer.alloc(0)
    for (const { timer, reject } of this.#pending.values()) {
      clearTimeout(timer)
      reject(new Error(reason))
    }
    this.#pending.clear()
    if (!child) return
    // Kill the tree *before* tearing the pipes down: closing stdin makes the worker exit on
    // EOF, and once the parent is gone `taskkill /T` can no longer reach the PowerShell shell
    // server it started (the grandchildren then keep the pipes alive forever).
    if (!child.killed) {
      const alive = child.exitCode === null && child.signalCode === null
      if (alive && WINDOWS && child.pid) {
        killProcessTree(child.pid)
      } else {
        try {
          child.kill()
        } catch {
          // Nothing left to kill.
        }
      }
    }
    child.removeAllListeners()
    try {
      child.stdout?.removeAllListeners()
      child.stderr?.removeAllListeners()
      child.stdin?.removeAllListeners()
      child.stdin?.destroy()
    } catch {
      // The pipes may already be torn down by a close event.
    }
    releaseWorkerLock(lockPid)
  }

  /**
   * Kill a worker left behind by a *previous* DSH instance. The worker's own
   * pid watch already handles a dead host within a second, but a still-alive
   * host that restarted (GUI reload) would otherwise be served by an orphan.
   *
   * The lock only records `pid` + the instance token, never the image name, so
   * the pid is verified against the worker image before any signal is sent. A
   * reused pid that happens to be the DSH host would otherwise turn a restart
   * into "the app starts and immediately dies".
   */
  #reapStale() {
    let text
    try {
      text = readFileSync(workerLockPath(), 'utf8')
    } catch {
      return
    }
    const [pidLine, instance] = text.trim().split(/\r?\n/)
    const pid = Number(pidLine)
    if (!Number.isFinite(pid) || pid <= 0) return
    if (!instance || instance === HOST_INSTANCE) return
    // A lock that names this host (or its parent) is garbage from an earlier
    // write, not a worker: never make it a reason to kill ourselves.
    if (pid === process.pid || pid === process.ppid) {
      dropStaleLock(text)
      return
    }
    const identity = probeWorkerImage(pid, workerImageName(this.workerPath))
    if (identity === 'unknown') return
    if (identity === 'no') {
      dropStaleLock(text)
      return
    }
    killProcessTree(pid)
    dropStaleLock(text)
  }

  async #spawn() {
    this.#reapStale()
    const child = spawn(this.workerPath, [], {
      cwd: WORKER_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        // Worker-side knobs are environment variables on purpose: a future DSH
        // release can change plugin APIs without changing how the binary is
        // configured, and an operator can tune a build with no JS layer at all.
        DSH_RUST_LANES: String(this.options.lanes),
        DSH_RUST_MAX_QUEUE: String(this.options.maxQueueDepth),
        DSH_RUST_PROFILE: process.env.DSH_PROFILE ?? 'default',
      },
    })
    this.#child = child
    this.#buffer = Buffer.alloc(0)
    this.#stderr = ''
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
    })
    child.on('error', (error) => this.#fail(`rust worker failed to start: ${error.message}`))
    child.on('close', (code, signal) => this.#fail(
      signal ? `rust worker exited with signal ${signal}` : `rust worker exited with code ${code}`,
    ))
    // 'close' waits for every inherited pipe to be released, and a force-killed
    // worker leaves its PowerShell grandchild holding them — so 'exit' is what
    // actually tells us the process is gone. Without it the next request writes
    // to a dead stdin and stalls until its timeout.
    child.on('exit', (code, signal) => this.#fail(
      signal ? `rust worker was killed by signal ${signal}` : `rust worker exited with code ${code}`,
    ))
    // stdin write failures surface through 'close'; keep them from escaping.
    child.stdin.on('error', () => {})
    // Handshake before anything else: it installs this instance's identity, starts
    // the worker-side host watchdog, and makes a protocol mismatch fail loudly
    // (the worker answers with an error and exits with code 2).
    const welcome = await this.#request('hello', {
      protocol: HELLO_VERSION,
      hostPid: process.pid,
      hostInstance: HOST_INSTANCE,
      cwd: WORKER_CWD,
    }, HANDSHAKE_TIMEOUT_MS)
    const info = await this.#request('initialize', {}, START_TIMEOUT_MS)
    this.info = { ...info, welcome }
    const workerPid = Number(welcome?.workerPid ?? info?.worker?.pid ?? 0)
    this.#lockPid = workerPid > 0 ? workerPid : null
    if (this.#lockPid) claimWorkerLock(this.#lockPid)
    this.#failCount = 0
    this.#restartAt = 0
    this.#startHeartbeat()
    return this.info
  }

  /** Unexpected process death: reject pending calls and clear the slot. */
  #fail(message) {
    const child = this.#child
    if (!child) return
    const dyingPid = child.pid
    const lockPid = this.#lockPid
    this.#lockPid = null
    this.#child = null
    this.info = null
    this.#buffer = Buffer.alloc(0)
    child.removeAllListeners()
    try {
      child.stdout?.removeAllListeners()
      child.stderr?.removeAllListeners()
      child.stdin?.removeAllListeners()
      child.stdin?.destroy()
    } catch {
      // Already gone.
    }
    if (!child.killed) {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    const detail = this.#stderr.trim()
    if (process.env.DSH_RUST_DEBUG) {
      console.error(`[rust-worker] died: ${message}\n  pid: ${dyingPid} restarts: ${this.#restarts}\n  stderr: ${detail.slice(-2000) || '(empty)'}`)
    }
    const error = new Error(detail ? `${message}\n${detail}` : message)
    for (const { timer, reject } of this.#pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this.#pending.clear()
    this.#stopHeartbeat()
    releaseWorkerLock(lockPid)
    this.#restarts += 1
    this.#scheduleRestart()
  }

  #onStdout(chunk) {
    const now = performance.now()
    if (this.#lastInboundAt > 0) {
      this.#activityGaps.push(now - this.#lastInboundAt)
      if (this.#activityGaps.length > 512) this.#activityGaps.shift()
    }
    this.#lastInboundAt = now
    this.#buffer = this.#buffer.length > 0 ? Buffer.concat([this.#buffer, chunk]) : chunk
    for (;;) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const match = /content-length:\s*(\d+)/i.exec(this.#buffer.subarray(0, headerEnd).toString('ascii'))
      if (!match) {
        // Not a frame we can parse; drop the malformed header and continue.
        this.#buffer = this.#buffer.subarray(headerEnd + 4)
        continue
      }
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + Number(match[1])
      if (this.#buffer.length < bodyEnd) return
      const body = this.#buffer.subarray(bodyStart, bodyEnd).toString('utf8')
      this.#buffer = this.#buffer.subarray(bodyEnd)
      let message
      try {
        message = JSON.parse(body)
      } catch (error) {
        this.#fail(`rust worker sent an unparsable frame: ${error.message}`)
        return
      }
      this.#settle(message)
    }
  }

  #settle(message) {
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.cleanup?.()
    if (message.error) {
      const error = new Error(message.error.message ?? JSON.stringify(message.error))
      error.workerCode = message.error.code
      pending.reject(error)
    } else {
      pending.resolve(message.result)
    }
  }

  // -------------------------------------------------------------------------
  // heartbeat: a 2 s setTimeout chain, never setInterval — a frozen host must
  // not fire a burst of catch-up ticks and declare the worker dead
  // -------------------------------------------------------------------------

  #startHeartbeat() {
    this.#stopHeartbeat()
    const tick = () => {
      this.#beatTimer = null
      if (!this.#child) return
      const now = performance.now()
      const gap = now - this.#lastInboundAt
      if (gap > SUSPEND_GAP_MS) {
        // Machine slept or the process was frozen: re-arm, never judge.
        this.#lastInboundAt = now
      } else if (gap > WORKER_SILENCE_MS) {
        this.#onSuspect()
      }
      this.#notify('ping', {
        seq: this.#nextId,
        inflight: this.#pending.size,
        monoTs: Math.round(now),
      })
      this.#nextId += 1
      this.#beatTimer = setTimeout(tick, HEARTBEAT_MS)
      this.#beatTimer.unref?.()
    }
    this.#beatTimer = setTimeout(tick, HEARTBEAT_MS)
    this.#beatTimer.unref?.()
  }

  #stopHeartbeat() {
    if (this.#beatTimer !== null) {
      clearTimeout(this.#beatTimer)
      this.#beatTimer = null
    }
    this.#probing = false
  }

  /**
   * Suspected death: two probes 1 s apart, then one last check. A request in
   * flight exempts the worker — its own timeout is the authority then, because a
   * long `exec` legitimately produces no traffic for minutes.
   */
  #onSuspect() {
    if (this.#probing || this.#pending.size > 0) return
    this.#probing = true
    const probe = (delay) => setTimeout(() => {
      if (!this.#child) {
        this.#probing = false
        return
      }
      this.#notify('ping', { seq: this.#nextId, probe: true })
      this.#nextId += 1
    }, delay)
    probe(0)
    probe(PROBE_GAP_MS)
    setTimeout(() => {
      this.#probing = false
      if (!this.#child || this.#pending.size > 0) return
      if (performance.now() - this.#lastInboundAt <= WORKER_SILENCE_MS) return
      this.#misses += 1
      this.kill('rust worker stopped answering heartbeats')
      this.#scheduleRestart()
    }, 2 * PROBE_GAP_MS + 200).unref?.()
  }

  #scheduleRestart() {
    this.#failCount += 1
    const delay = RESTART_BACKOFF_MS[Math.min(this.#failCount, RESTART_BACKOFF_MS.length - 1)]
    this.#restartAt = Date.now() + delay
  }

  /** Fire-and-forget frame: no id, no pending entry, chained with real requests. */
  #notify(method, params) {
    const child = this.#child
    if (!child) return
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }), 'utf8')
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'),
      payload,
    ])
    this.#writeChain = this.#writeChain
      .then(() => new Promise((done) => { child.stdin.write(frame, done) }))
      .catch(() => {})
  }

  #request(method, params, timeoutMs, signal) {
    const child = this.#child
    if (!child) return Promise.reject(new Error('rust worker is not running'))
    if (signal?.aborted) {
      const error = new Error(`rust worker request ${method} aborted before it was sent`)
      error.code = 'WORKER_ABORTED'
      return Promise.reject(error)
    }
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        const error = new Error(`rust worker request ${method} timed out after ${timeoutMs} ms`)
        error.code = 'WORKER_TIMEOUT'
        reject(error)
      }, timeoutMs)
      let onAbort = null
      const cleanup = () => {
        if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      }
      if (signal) {
        onAbort = () => {
          if (!this.#pending.delete(id)) return
          clearTimeout(timer)
          cleanup()
          const error = new Error(`rust worker request ${method} aborted`)
          error.code = 'WORKER_ABORTED'
          reject(error)
          // Kill the lane that is running this call. The worker answers a no-op
          // when the call already finished, and pre-P2.5 workers just ignore an
          // unknown method, so this stays compatible in both directions.
          if (params && typeof params.callId === 'string') {
            this.#notify('exec.abort', { callId: params.callId })
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.#pending.set(id, { resolve, reject, timer, cleanup })
      const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')
      const frame = Buffer.concat([
        Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'),
        payload,
      ])
      // Writes are chained so two concurrent tool calls never interleave frames.
      this.#writeChain = this.#writeChain
        .then(() => new Promise((done) => { child.stdin.write(frame, done) }))
        .catch(() => {})
    })
  }
}

// ---------------------------------------------------------------------------
// Render helpers: compact text the model actually reads
// ---------------------------------------------------------------------------

/** @param {unknown} value */
function textOf(value) {
  return [{ type: 'text', text: String(value) }]
}

/** Trim one trailing newline so the footer does not float on a blank line. */
function trimTail(text) {
  return typeof text === 'string' ? text.replace(/\r?\n$/, '') : ''
}

function renderExec(value) {
  const { exitCode, stdout, ms, wallMs, reused, lane, queueMs, aborted } = value
  const body = trimTail(stdout)
  if (aborted) {
    const stamp = `[aborted · ${typeof wallMs === 'number' ? `${wallMs} ms wall` : 'call cancelled'}]`
    return body ? `${body}\n${stamp}` : stamp
  }
  const timing = typeof wallMs === 'number' ? `${wallMs} ms wall · ${ms} ms shell` : `${ms} ms`
  const laneLabel = typeof lane === 'number' ? ` · lane ${lane}` : ''
  const queueLabel = typeof queueMs === 'number' && queueMs > 0 ? ` · queued ${queueMs} ms` : ''
  const stamp = `[exit ${exitCode} · ${timing} · ${reused ? 'warm' : 'cold'} shell${laneLabel}${queueLabel}]`
  return body ? `${body}\n${stamp}` : stamp
}

// ---------------------------------------------------------------------------
// Read observation cache: re-reading an unchanged range costs tokens for
// nothing, so the second identical read returns a notice instead of the body.
// Modelled on dsh-ops' read-observation key; `refresh: true` always reprints.
// ---------------------------------------------------------------------------
const READ_CACHE_LIMIT = 256
const READ_CACHE_TTL_MS = 5 * 60_000
const readCache = new Map()

function readCacheKey(exec, params) {
  return `${exec?.agent?.id ?? 'default'}|${params.path}|${params.offset ?? 1}|${params.limit ?? ''}`
}

/** Age of an identical earlier read in ms, or 0 when the body must be printed. */
function recallRead(key, hash) {
  const hit = readCache.get(key)
  if (!hit) return 0
  if (hit.hash !== hash) return 0
  const age = Date.now() - hit.at
  if (age > READ_CACHE_TTL_MS) {
    readCache.delete(key)
    return 0
  }
  return age
}

function rememberRead(key, hash) {
  readCache.delete(key)
  readCache.set(key, { hash, at: Date.now() })
  while (readCache.size > READ_CACHE_LIMIT) readCache.delete(readCache.keys().next().value)
}

/**
 * One standard completeness stamp for every truncated result, so the model can
 * tell "this is everything" from "there is more" without parsing prose. Follows
 * the contract dsh-ops uses (`complete` / `truncatedBy` / omitted count).
 */
function completeness(value, shownKey, totalKey) {
  const truncated = value.truncated === true || value.limited === true || value.truncatedByBytes === true
  if (!truncated) return 'complete'
  const shown = typeof value[shownKey] === 'number' ? value[shownKey] : null
  const total = typeof value[totalKey] === 'number' ? value[totalKey] : null
  const omitted = shown !== null && total !== null && total > shown ? total - shown : null
  const why = value.truncatedByBytes === true ? 'bytes' : 'lines'
  return `truncated by ${why}${omitted !== null ? ` · omitted ${omitted}` : ''} · complete=false`
}

function renderRead(value) {
  if (typeof value.unchangedForMs === 'number' && value.unchangedForMs > 0) {
    return `[unchanged · ${value.path} · ${value.totalLines} lines · ${value.totalBytes} bytes · `
      + `sha256 ${value.hash} · identical to the read ${Math.round(value.unchangedForMs / 1000)} s ago `
      + '· pass refresh: true to print it again]'
  }
  const content = typeof value.content === 'string' ? value.content : ''
  const lineCount = content === ''
    ? 0
    : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
  const scope = value.limited || value.truncatedByBytes
    ? `lines ${value.offset}-${value.offset + Math.max(lineCount - 1, 0)} of ${value.totalLines}`
    : `${value.totalLines} lines`
  // A line-capped page can be continued exactly; a byte-capped one may stop mid-line, so it
  // only earns the "raise limit" advice rather than a wrong next offset.
  const next = value.limited && !value.truncatedByBytes ? value.offset + lineCount : 0
  const hint = next > 0 && next <= value.totalLines
    ? ` · next: offset=${next}${value.limit ? ` limit=${value.limit}` : ''}`
    : value.truncatedByBytes
      ? ' · cut by bytes: raise limit or lower offset'
      : ''
  const stamp = completeness({ ...value, shownLines: lineCount }, 'shownLines', 'totalLines')
  const footer = `[${value.path} · ${scope} · ${value.totalBytes} bytes · sha256 ${value.hash}`
    + `${stamp === 'complete' ? ' · complete' : ` · ${stamp}`}${hint}]`
  return content ? `${trimTail(content)}\n${footer}` : footer
}

function renderWrite(value) {
  return `wrote ${value.bytes} bytes to ${value.path}\nsha256 ${value.hash}`
}

function renderEdit(value) {
  return `edited ${value.path}: ${value.replacements} replacement(s)\nsha256 ${value.hash}`
}

function renderStat(value) {
  if (!value.exists) return `${value.path}: missing`
  if (value.isDir) return `${value.path}: directory · mtime ${new Date(value.mtimeMs).toISOString()}`
  return `${value.path}: file · ${value.size} bytes · mtime ${new Date(value.mtimeMs).toISOString()}`
}

function renderList(value) {
  const entries = Array.isArray(value.entries) ? value.entries : []
  if (entries.length === 0) return `${value.path}: (empty)`
  const lines = entries.map((entry) => (entry.isDir ? `${entry.name}/` : `${entry.name}  ${entry.size} B`))
  return lines.join('\n')
}

/**
 * One line per hit plus indented context: the model pays for every character, so
 * the footer carries the ranking/truncation facts instead of verbose JSON.
 */
function renderSearch(value) {
  const hits = Array.isArray(value.hits) ? value.hits : []
  const lines = []
  for (const hit of hits) {
    const kind = hit.kind ? ` [${hit.kind}]` : ''
    lines.push(`${hit.path}:${hit.line}${kind} ${hit.text}`)
    if (typeof hit.context === 'string' && hit.context.length > 0) {
      for (const row of hit.context.split('\n')) if (row) lines.push(`  ${row}`)
    }
  }
  const stats = `${value.shown ?? 0}/${value.totalHits ?? 0} hits · `
    + `${value.filesMatched ?? 0}/${value.filesScanned ?? 0} files · ${value.elapsedMs ?? 0} ms`
  const stamp = completeness(value, 'shown', 'totalHits')
  lines.push(`— ${stats} · ${stamp}${value.truncated ? ' · narrow with glob/query, or raise maxHits/maxBytes' : ''}`)
  return lines.join('\n')
}

function renderSymbols(value) {
  const symbols = Array.isArray(value.symbols) ? value.symbols : []
  const lines = symbols.map((sym) => `${sym.path}:${sym.line} [${sym.kind}] ${sym.sig || sym.name}`)
  const stats = `${value.shown ?? 0}/${value.totalMatched ?? 0} symbols · ${value.elapsedMs ?? 0} ms`
  const stamp = completeness(value, 'shown', 'totalMatched')
  lines.push(`— ${stats} · ${stamp}${value.truncated ? ' · raise limit, or filter by kind/path' : ''}`)
  return lines.join('\n')
}

function renderSession(value) {
  const timings = value.timings ?? {}
  const counts = value.counts ?? {}
  const fmt = (ms) => (typeof ms === 'number' ? `${ms.toFixed(1)} ms` : '-')
  const parts = [`read ${fmt(timings.readMs)}`, `decode ${fmt(timings.decodeMs)}`,
    `json ${fmt(timings.parseMs)}`, `fold ${fmt(timings.foldMs)}`]
  if (timings.deltaFrames) parts.push(`delta ${timings.deltaFrames}/${timings.totalFrames} frames`)
  const head = `session ${String(value.path ?? '').split(/[\\/]/).pop()} · ${value.total ?? 0} messages · `
    + `${counts.records ?? 0} records · ${counts.turns ?? 0} turns · ${counts.toolCalls ?? 0} tool calls · `
    + `${(Number(value.size ?? 0) / 1048576).toFixed(2)} MB log`
  const timing = `— ${timings.mode ?? '?'}${timings.cacheHit ? ' (cache)' : ''}`
    + `${value.partial ? ' · head only, full build running in background' : ''} · total ${fmt(timings.totalMs)} `
    + `(${parts.join(' · ')})`
  const page = Array.isArray(value.page) ? value.page : []
  const nextLabel = value.hasMore === false ? 'end' : (value.nextCursor ?? 'end')
  const lines = [head, timing, `page [${value.cursor ?? 0}..${(value.cursor ?? 0) + page.length}) of ${value.partial ? '≥' : ''}${value.total ?? 0} · `
    + `${value.pageChars ?? 0} chars · next=${nextLabel}`]
  for (const message of page) {
    const kind = String(message.kind ?? '?')
    const turn = `${message.turn ?? 0}/${message.step ?? 0}`
    const name = message.name ? ` ${message.name}` : ''
    lines.push(`#${message.seq ?? '?'} ${kind}${name} t${turn} ${message.chars ?? 0}ch ${String(message.preview ?? '').slice(0, 110)}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Worker pool: fairness, idle reclaim, soft limits, multi-process isolation
// ---------------------------------------------------------------------------

function abortError() {
  const error = new Error('rust worker call aborted before it started')
  error.code = 'WORKER_ABORTED'
  return error
}

function busyError(detail) {
  const error = new Error(`rust worker pool saturated: ${detail}; retry in ~${QUEUE_RETRY_MS} ms`)
  error.code = 'WORKER_BUSY'
  error.retryAfterMs = QUEUE_RETRY_MS
  return error
}

/**
 * Owns 1..maxWorkers `RustWorker` processes and decides which one runs a call.
 *
 * Division of labour with the worker (see docs/rust-exec-plugin/
 * CONCURRENCY_AND_METRICS.md): the host is the scheduler — it caps in-flight
 * calls per session, drains per-session queues round-robin so a big session
 * cannot starve a small one, retires idle workers, and applies the RSS/CPU soft
 * limits by dropping or pausing the worker-side index. The worker owns lane
 * leasing, path locks and the version guard. exec/fs calls are never throttled
 * by the soft limits: only index builds are.
 */
export class WorkerPool {
  #entries = []
  #nextEntryId = 1
  #sessionEntry = new Map()
  #sessionInflight = new Map()
  // Per-session counters that survive between calls, so the monitor can show which
  // conversation is actually driving the worker right now.
  #sessionStats = new Map()
  #queues = new Map()
  #rotation = []
  #queueDepth = 0
  #timer = null
  #soft = { paused: false, lastDropAt: 0, lastAction: null, lastActionAt: 0, rssLimitHit: 0, cpuLimitHit: 0 }
  stats = { calls: 0, queued: 0, rejected: 0, retired: 0, spawned: 0 }

  constructor(workerPath, options = {}, log = () => {}) {
    this.workerPath = workerPath
    this.log = log
    this.options = {
      lanes: options.lanes ?? DEFAULT_LANES,
      maxQueueDepth: options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
      maxWorkers: options.maxWorkers ?? DEFAULT_MAX_WORKERS,
      maxShells: options.maxShells ?? DEFAULT_MAX_SHELLS,
      maxInFlightPerSession: options.maxInFlightPerSession ?? (options.lanes ?? DEFAULT_LANES),
      idleReapMs: options.idleReapMs ?? DEFAULT_IDLE_REAP_MS,
      rssSoftLimitMb: options.rssSoftLimitMb ?? 512,
      cpuSoftLimitPct: options.cpuSoftLimitPct ?? 70,
    }
    this.#timer = setInterval(() => this.#tick(), POOL_TICK_MS)
    this.#timer.unref?.()
  }

  get size() {
    return this.#entries.length
  }

  get running() {
    return this.#entries.some((entry) => entry.worker.running)
  }

  get queueDepth() {
    return this.#queueDepth
  }

  get softLimits() {
    return { ...this.#soft }
  }

  /** Shells allowed per worker: the lane count when one process owns them all. */
  get lanesPerWorker() {
    const workers = Math.max(1, this.options.maxWorkers)
    if (workers <= 1) return this.options.lanes
    const shared = Math.floor(this.options.maxShells / workers)
    return Math.max(1, Math.min(MAX_LANES, shared || 1))
  }

  /** Spawn the first worker eagerly so the first tool call does not pay boot. */
  start() {
    return this.#entry().worker.start()
  }

  kill(reason = 'rust worker pool stopped') {
    for (const entry of this.#entries) entry.worker.kill(reason)
    this.#entries = []
    this.#sessionEntry.clear()
  }

  dispose() {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    this.kill()
  }

  /**
   * Route one RPC to a worker. `sessionId` only affects scheduling/affinity; the
   * wire protocol is unchanged.
   */
  call(method, params, timeoutMs, signal, sessionId = 'default') {
    this.stats.calls += 1
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const job = { method, params, timeoutMs, signal, sessionId, resolve, reject, enqueuedAt: 0 }
      if (this.#canStart(sessionId)) this.#start(job)
      else this.#enqueue(job)
    })
  }

  /** Metrics sampling bypasses the scheduler: it must never queue behind user calls. */
  sample() {
    const entry = this.#entries[0] ?? this.#spawnEntry()
    return entry.worker.call('metrics.sample', {}, 4_000)
  }

  async health() {
    const primary = this.#entries[0]?.worker
    if (!primary) {
      return { schema: 'dsh-rust-exec/pool-health@1', running: false, worker: null, pool: this.info() }
    }
    const value = await primary.health()
    return { ...value, pool: this.info(), workers: this.#workerInfo() }
  }

  /** Structured pool snapshot for /metrics and the settings panel. */
  info() {
    return {
      schema: 'dsh-rust-exec/pool@1',
      workers: this.#entries.length,
      maxWorkers: this.options.maxWorkers,
      maxShells: this.options.maxShells,
      lanesPerWorker: this.lanesPerWorker,
      maxInFlightPerSession: this.options.maxInFlightPerSession,
      idleReapMs: this.options.idleReapMs,
      rssSoftLimitMb: this.options.rssSoftLimitMb,
      cpuSoftLimitPct: this.options.cpuSoftLimitPct,
      queueDepth: this.#queueDepth,
      sessions: [...this.#sessionInflight.entries()].map(([sessionId, inflight]) => {
        const stats = this.#sessionStats.get(sessionId) ?? null
        return {
          sessionId,
          inflight,
          calls: stats?.calls ?? 0,
          lastCallMs: stats?.lastCallMs ?? 0,
          lastTool: stats?.lastTool ?? '',
          lastSeenAt: stats?.lastSeenAt ?? 0,
        }
      }),
      stats: { ...this.stats },
      softLimits: { ...this.#soft },
      workersDetail: this.#workerInfo(),
    }
  }

  /**
   * Apply the RSS/CPU soft limits to one metrics sample. Order matters: shed the
   * index first (it is rebuildable), pause background index builds second, and
   * never touch exec/fs — a throttled exec would be worse than a slow index.
   */
  async applySoftLimits(sample) {
    if (!sample) return
    // The worker publishes nested memory/cpu groups (schema
    // dsh-rust-exec/worker-metrics@1); flat keys are accepted as a fallback so an
    // older or newer worker cannot silently disable the limits.
    const rssMb = Number(sample.memory?.workingSetBytes ?? sample.workingSetBytes ?? 0) / (1024 * 1024)
    const cpuPct = Number(sample.cpu?.cpuPctOneCore ?? sample.cpuPctOneCore ?? 0)
    const now = Date.now()
    if (rssMb > this.options.rssSoftLimitMb && now - this.#soft.lastDropAt >= SOFT_LIMIT_DROP_COOLDOWN_MS) {
      this.#soft.lastDropAt = now
      this.#soft.rssLimitHit += 1
      const entries = [...this.#entries]
      for (const entry of entries) {
        try {
          await entry.worker.call('index.drop', {}, 5_000)
        } catch {
          // A worker that just restarted has no index to drop; nothing to do.
        }
      }
      this.#soft.lastAction = `index.drop: rss ${Math.round(rssMb)} MB > ${this.options.rssSoftLimitMb} MB`
      this.#soft.lastActionAt = now
      this.log('info', `softlimit.rss index.drop rss=${Math.round(rssMb)}MB`)
    }
    if (cpuPct > this.options.cpuSoftLimitPct && !this.#soft.paused) {
      this.#soft.paused = true
      this.#soft.cpuLimitHit += 1
      await Promise.all([...this.#entries].map((entry) => entry.worker.call('index.pause', {}, 5_000).catch(() => {})))
      this.#soft.lastAction = `index.pause: cpu ${Math.round(cpuPct)}% > ${this.options.cpuSoftLimitPct}%`
      this.#soft.lastActionAt = now
      this.log('info', `softlimit.cpu index.pause cpu=${Math.round(cpuPct)}%`)
    } else if (this.#soft.paused && cpuPct < this.options.cpuSoftLimitPct * 0.8) {
      this.#soft.paused = false
      await Promise.all([...this.#entries].map((entry) => entry.worker.call('index.resume', {}, 5_000).catch(() => {})))
      this.#soft.lastAction = 'index.resume: cpu back under 80% of the soft limit'
      this.#soft.lastActionAt = now
      this.log('info', `softlimit.cpu index.resume cpu=${Math.round(cpuPct)}%`)
    }
  }

  /** Hot-apply scheduler settings. Lane changes retire idle workers lazily. */
  configure(patch = {}) {
    const applied = {}
    const lanesBefore = this.lanesPerWorker
    const take = (key, validate) => {
      if (patch[key] === undefined) return
      const value = patch[key]
      validate(value)
      this.options[key] = value
      applied[key] = value
    }
    take('maxWorkers', (value) => {
      if (!Number.isInteger(value) || value < 1 || value > MAX_WORKERS) {
        throw new Error(`maxWorkers must be an integer from 1 to ${MAX_WORKERS}`)
      }
    })
    take('maxShells', (value) => {
      if (!Number.isInteger(value) || value < 1 || value > MAX_SHELLS) {
        throw new Error(`maxShells must be an integer from 1 to ${MAX_SHELLS}`)
      }
    })
    take('maxInFlightPerSession', (value) => {
      if (!Number.isInteger(value) || value < 1 || value > MAX_INFLIGHT_PER_SESSION_LIMIT) {
        throw new Error(`maxInFlightPerSession must be an integer from 1 to ${MAX_INFLIGHT_PER_SESSION_LIMIT}`)
      }
    })
    take('idleReapMs', (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_IDLE_REAP_MS) {
        throw new Error(`idleReapMs must be a number of at least ${MIN_IDLE_REAP_MS}`)
      }
    })
    take('rssSoftLimitMb', (value) => {
      if (!Number.isInteger(value) || value < 64 || value > 65536) {
        throw new Error('rssSoftLimitMb must be an integer from 64 to 65536')
      }
    })
    take('cpuSoftLimitPct', (value) => {
      if (typeof value !== 'number' || value < 10 || value > 100) {
        throw new Error('cpuSoftLimitPct must be a number from 10 to 100')
      }
    })
    // Lane count is derived from maxWorkers/maxShells, so only a *changed* lane
    // count forces a restart of warm workers. A maxWorkers change that keeps
    // lanesPerWorker identical must NOT drain the pool to zero: just trim it.
    const lanesChanged = applied.maxWorkers !== undefined || applied.maxShells !== undefined
    applied.lanesPerWorker = this.lanesPerWorker
    if (lanesChanged && applied.lanesPerWorker !== lanesBefore) {
      for (const entry of [...this.#entries]) {
        if (entry.inflight > 0) {
          entry.retiring = true
          continue
        }
        this.#retire(entry, 'lanes-changed')
      }
      applied.restart = 'idle workers retired; the next call spawns with the new lane count'
    }
    this.#enforcePoolSize()
    this.#drain()
    return applied
  }

  // -- scheduling ----------------------------------------------------------

  #canStart(sessionId) {
    const inflight = this.#sessionInflight.get(sessionId) ?? 0
    return inflight < this.options.maxInFlightPerSession && this.#pick(sessionId) !== null
  }

  #start(job) {
    const entry = this.#pick(job.sessionId)
    if (!entry) {
      this.#enqueue(job)
      return
    }
    this.#sessionInflight.set(job.sessionId, (this.#sessionInflight.get(job.sessionId) ?? 0) + 1)
    const startedAt = Date.now()
    const stats = this.#sessionStats.get(job.sessionId) ?? { calls: 0, lastCallMs: 0, lastTool: '', lastSeenAt: 0 }
    stats.calls += 1
    stats.lastTool = job.method
    stats.lastSeenAt = startedAt
    this.#sessionStats.set(job.sessionId, stats)
    entry.inflight += 1
    entry.lastUsedAt = Date.now()
    entry.worker
      .call(job.method, job.params, job.timeoutMs, job.signal)
      .then(job.resolve, job.reject)
      .finally(() => {
        stats.lastCallMs = Math.round(Date.now() - startedAt)
        stats.lastSeenAt = Date.now()
        entry.inflight -= 1
        entry.lastUsedAt = Date.now()
        const left = (this.#sessionInflight.get(job.sessionId) ?? 1) - 1
        if (left <= 0) this.#sessionInflight.delete(job.sessionId)
        else this.#sessionInflight.set(job.sessionId, left)
        this.#drain()
      })
  }

  #enqueue(job) {
    if (this.#queueDepth >= this.options.maxQueueDepth) {
      this.stats.rejected += 1
      job.reject(busyError(`queue depth ${this.#queueDepth}/${this.options.maxQueueDepth}`))
      return
    }
    job.enqueuedAt = Date.now()
    let queue = this.#queues.get(job.sessionId)
    if (!queue) {
      queue = []
      this.#queues.set(job.sessionId, queue)
      this.#rotation.push(job.sessionId)
    }
    queue.push(job)
    this.#queueDepth += 1
    this.stats.queued += 1
    if (job.signal) {
      job.signal.addEventListener('abort', () => {
        const index = queue.indexOf(job)
        if (index >= 0) {
          queue.splice(index, 1)
          this.#queueDepth -= 1
        }
        job.reject(abortError())
      }, { once: true })
    }
  }

  /**
   * Drain queued jobs round-robin: one slot per session per pass.
   *
   * Fairness rule that matters (acceptance C7): when a session cannot start
   * because the pool has no free lane, it must stay at the FRONT of the rotation
   * — pushing it to the back lets a session that already ran keep winning every
   * freed slot and starves the small one. A session blocked only by its own
   * in-flight cap is rotated (its own completion re-drains it).
   */
  #drain() {
    let guard = 0
    const guardLimit = Math.max(4, this.#rotation.length * 8)
    while (this.#queueDepth > 0 && this.#rotation.length > 0 && guard < guardLimit) {
      guard += 1
      const sessionId = this.#rotation.shift()
      const queue = this.#queues.get(sessionId)
      if (!queue || queue.length === 0) {
        this.#queues.delete(sessionId)
        continue
      }
      const inflight = this.#sessionInflight.get(sessionId) ?? 0
      if (inflight >= this.options.maxInFlightPerSession) {
        this.#rotation.push(sessionId)
        continue
      }
      if (this.#pick(sessionId) === null) {
        // No free lane anywhere: keep this session first for the next slot.
        this.#rotation.unshift(sessionId)
        break
      }
      let started = 0
      while (
        queue.length > 0
        && inflight + started < this.options.maxInFlightPerSession
        && this.#pick(sessionId) !== null
      ) {
        const job = queue.shift()
        this.#queueDepth -= 1
        if (queue.length === 0) this.#queues.delete(sessionId)
        this.#start(job)
        started += 1
      }
      if (queue.length > 0) this.#rotation.push(sessionId)
    }
  }

  // -- workers -------------------------------------------------------------

  #entry() {
    return this.#entries[0] ?? this.#spawnEntry()
  }

  #spawnEntry() {
    const entry = {
      id: this.#nextEntryId++,
      worker: null,
      inflight: 0,
      lastUsedAt: Date.now(),
      retiring: false,
    }
    entry.worker = new RustWorker(this.workerPath, {
      lanes: this.lanesPerWorker,
      maxQueueDepth: this.options.maxQueueDepth,
    })
    this.#entries.push(entry)
    this.stats.spawned += 1
    this.log('info', `pool.spawn id=${entry.id} lanes=${this.lanesPerWorker} workers=${this.#entries.length}`)
    return entry
  }

  #pick(sessionId) {
    const cap = this.lanesPerWorker
    const live = this.#entries.filter((entry) => !entry.retiring)
    const preferredId = this.#sessionEntry.get(sessionId)
    if (preferredId !== undefined) {
      const preferred = live.find((entry) => entry.id === preferredId)
      if (preferred && preferred.inflight < cap) return preferred
    }
    const free = live.filter((entry) => entry.inflight < cap).sort((a, b) => a.inflight - b.inflight)
    if (free.length > 0) {
      this.#sessionEntry.set(sessionId, free[0].id)
      return free[0]
    }
    if (live.length < this.options.maxWorkers) {
      const entry = this.#spawnEntry()
      this.#sessionEntry.set(sessionId, entry.id)
      return entry
    }
    return null
  }

  #tick() {
    this.#enforcePoolSize()
    // Retire workers that were marked while busy, then idle ones past the window.
    for (const entry of [...this.#entries]) {
      if (entry.inflight > 0) continue
      if (entry.retiring) {
        this.#retire(entry, 'marked')
        continue
      }
      if (this.#entries.length > 1 && Date.now() - entry.lastUsedAt >= this.options.idleReapMs) {
        this.#retire(entry, 'idle')
      }
    }
  }

  /** Keep the pool at or below `maxWorkers`; busy workers are marked, not killed. */
  #enforcePoolSize() {
    let excess = this.#entries.length - this.options.maxWorkers
    if (excess <= 0) return
    for (const entry of [...this.#entries].reverse()) {
      if (excess <= 0) break
      if (entry.inflight > 0) {
        entry.retiring = true
        continue
      }
      this.#retire(entry, 'pool-resized')
      excess -= 1
    }
  }

  #retire(entry, reason) {
    const index = this.#entries.indexOf(entry)
    if (index >= 0) this.#entries.splice(index, 1)
    for (const [sessionId, entryId] of this.#sessionEntry) {
      if (entryId === entry.id) this.#sessionEntry.delete(sessionId)
    }
    entry.retiring = true
    entry.worker.kill(`rust worker retired: ${reason}`)
    this.stats.retired += 1
    this.log('info', `pool.retire id=${entry.id} reason=${reason} workers=${this.#entries.length}`)
  }

  #workerInfo() {
    return this.#entries.map((entry) => ({
      id: entry.id,
      pid: entry.worker.info?.pid ?? null,
      running: entry.worker.running,
      inflight: entry.inflight,
      lanes: entry.worker.options?.lanes ?? null,
      lastUsedAt: entry.lastUsedAt,
      retiring: entry.retiring,
    }))
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over a small sample (null when empty). */
function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[index])
}

function renderHealth(value) {
  const worker = value.worker ?? {}
  const lines = [
    `worker: ${value.running ? 'running' : 'stopped'}`
    + `${worker.pid ? ` pid ${worker.pid}` : ''}`
    + `${worker.uptimeMs !== undefined ? ` · up ${(worker.uptimeMs / 1000).toFixed(1)} s` : ''}`,
  ]
  lines.push(
    `host: pid ${value.hostPid} · inflight ${value.inflight} · restarts ${value.restarts}`
    + ` · heartbeat misses ${value.misses} · last exit ${value.lastExitCode ?? '-'}`,
  )
  lines.push(
    `inbound gap p50 ${value.inboundGapP50 ?? '-'} ms · p99 ${value.inboundGapP99 ?? '-'} ms`
    + ` · worker last saw host ${worker.lastHostSeenMsAgo ?? '-'} ms ago`
    + ` · host alive ${worker.hostAlive ?? '-'}`,
  )
  if (worker.shell) lines.push(`shell: ${JSON.stringify(worker.shell)}`)
  if (value.healthError) lines.push(`health error: ${value.healthError}`)
  const pool = value.pool
  if (pool) {
    lines.push(
      `pool: ${pool.workers}/${pool.maxWorkers} workers · lanes/worker ${pool.lanesPerWorker}`
      + ` · queue ${pool.queueDepth} · sessions ${pool.sessions?.length ?? 0}`,
    )
    const soft = pool.softLimits ?? {}
    lines.push(
      `soft limits: rss ${pool.rssSoftLimitMb} MB · cpu ${pool.cpuSoftLimitPct}%`
      + ` · paused ${soft.paused ?? false}`
      + `${soft.lastAction ? ` · last ${soft.lastAction}` : ''}`,
    )
  }
  const routes = value.routes
  if (routes) {
    lines.push(
      `http routes: ${routes.mounted?.length ?? 0} mounted`
      + ` · attempts ${routes.attempts ?? 0}`
      + `${routes.exhausted ? ' · EXHAUSTED (webServer never appeared)' : ''}`
      + `${routes.errors?.length ? ` · ${routes.errors.length} error(s)` : ''}`,
    )
    if (routes.mounted?.length) lines.push(`  mounted: ${routes.mounted.join(', ')}`)
    if (routes.errors?.length) lines.push(`  errors: ${routes.errors.map((e) => `${e.path}: ${e.error}`).join(' · ')}`)
  }
  return lines.join('\n')
}

function createToolDefinitions(pool, config, store, runtime = {}) {
  /** Deadline for an fs request: the configured default. */
  const fsTimeout = () => config.defaultTimeoutMs

  return [
    {
      name: 'rust_exec',
      description:
        'Run a PowerShell command in the persistent Rust worker shell. The worker keeps a pool of '
        + 'warm PowerShell lanes behind a loopback socket, so warm commands take single-digit to tens '
        + 'of milliseconds instead of the ~3 s a fresh powershell.exe costs; prefer this over pwsh for '
        + 'ordinary commands. Returns exitCode, stdout, and both wall and shell elapsed ms. Each call '
        + 'leases one lane exclusively, so several calls (from this session or another one) run in '
        + 'parallel up to the lane count; when all lanes are busy the call waits and reports queueMs. '
        + 'The shell keeps its working directory: pass cwd to change it for this and later calls. When '
        + 'the turn is aborted the lane is killed, and the next call on it restarts that shell only. '
        + 'exitCode mirrors PowerShell\'s $LASTEXITCODE, so it can stay stale when a command runs no '
        + 'native executable — trust stdout for those.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'PowerShell command line to run in the warm shell.' },
          cwd: { type: 'string', description: 'Directory to enter first; it persists for later calls.' },
          timeoutMs: { type: 'number', description: 'Kill this lane\'s shell and report a timeout after this many milliseconds.' },
          queueTimeoutMs: { type: 'number', description: 'Maximum time to wait for a free lane before failing (default 30000).' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderExec(value)),
      },
      async execute(args, exec) {
        const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0
          ? args.timeoutMs
          : undefined
        const params = { command: args.command }
        if (args.cwd !== undefined) params.cwd = args.cwd
        if (timeoutMs !== undefined) params.timeoutMs = timeoutMs
        if (typeof args.queueTimeoutMs === 'number' && args.queueTimeoutMs > 0) {
          params.queueTimeoutMs = args.queueTimeoutMs
        }
        // The worker keys the lane on callId so an abort can find and kill exactly
        // this call's shell without touching other sessions' lanes.
        if (typeof exec?.callId === 'string') params.callId = exec.callId
        const startedAt = performance.now()
        try {
          const result = await pool.call(
            'exec',
            params,
            (timeoutMs ?? config.defaultTimeoutMs) + SHELL_TIMEOUT_GRACE_MS,
            exec?.signal,
            exec?.agent?.id ?? 'default',
          )
          // The worker reports shell time; the model should see true round-trip
          // cost, IPC, queue wait, and cold start included.
          return { ...result, wallMs: Math.round(performance.now() - startedAt) }
        } catch (error) {
          if (error?.code === 'WORKER_ABORTED') {
            return { exitCode: null, stdout: '', aborted: true, wallMs: Math.round(performance.now() - startedAt) }
          }
          throw error
        }
      },
      // Calls are isolated by lane, so the harness may start them in parallel.
      isConcurrencySafe() {
        return true
      },
    },
    {
      name: 'rust_read',
      description:
        'Read a UTF-8 file through the Rust worker and return its content plus the sha256 hash used '
        + 'by rust_write as expectedHash. offset is a 1-based first line; limit caps returned lines. '
        + 'A truncated page ends with the next offset to ask for. Repeating an identical read of an '
        + 'unchanged file returns "[unchanged]" instead of the body; pass refresh: true to force it. '
        + 'Prefer over read for large files or when you need that hash; the footer shows the line '
        + 'range, byte size, and hash.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read.' },
          offset: { type: 'number', description: '1-based first line to return (default 1).' },
          limit: { type: 'number', description: 'Maximum number of lines to return.' },
          refresh: { type: 'boolean', description: 'Print the body even if an identical read just returned it.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderRead(value)),
      },
      async execute(args, exec) {
        const params = { path: args.path }
        if (args.offset !== undefined) params.offset = args.offset
        if (args.limit !== undefined) params.limit = args.limit
        const value = await pool.call('fs.read', params, fsTimeout(), exec?.signal, exec?.agent?.id ?? 'default')
        const key = readCacheKey(exec, params)
        if (args.refresh === true) {
          rememberRead(key, value.hash)
          return value
        }
        const age = recallRead(key, value.hash)
        if (age > 0) return { ...value, content: '', unchangedForMs: age }
        rememberRead(key, value.hash)
        return value
      },
      isConcurrencySafe() {
        return true
      },
    },
    {
      name: 'rust_write',
      description:
        'Write a UTF-8 file through the Rust worker with an optional version guard. Pass the sha256 '
        + 'hash from rust_read as expectedHash, or the literal "absent" to require that the file does '
        + 'not exist yet. A mismatch fails without touching the file; omit expectedHash to write '
        + 'unconditionally.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write.' },
          content: { type: 'string', description: 'Full new file content.' },
          expectedHash: { type: 'string', description: 'sha256 hex of the current content, or "absent".' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderWrite(value)),
      },
      async execute(args, exec) {
        const params = { path: args.path, content: args.content }
        if (args.expectedHash !== undefined) params.expectedHash = args.expectedHash
        return pool.call('fs.write', params, fsTimeout(), exec?.signal, exec?.agent?.id ?? 'default')
      },
      // Different paths are independent, and the worker serializes writes to the
      // same canonical path with a version check, so parallel calls are safe.
      isConcurrencySafe() {
        return true
      },
    },
    {
      name: 'rust_edit',
      description:
        'Replace a literal string in a file through the Rust worker. An ambiguous oldString fails '
        + 'unless replaceAll is set (or you use a longer anchor), and a missing match fails too; the '
        + 'result reports the replacement count and the new sha256.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          oldString: { type: 'string', description: 'Exact text to replace.' },
          newString: { type: 'string', description: 'Replacement text.' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of failing on ambiguity.' },
        },
        required: ['path', 'oldString', 'newString'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderEdit(value)),
      },
      async execute(args, exec) {
        const params = { path: args.path, oldString: args.oldString, newString: args.newString }
        if (args.replaceAll !== undefined) params.replaceAll = args.replaceAll
        return pool.call('fs.edit', params, fsTimeout(), exec?.signal, exec?.agent?.id ?? 'default')
      },
      // Same isolation as rust_write: the worker holds a per-path lock.
      isConcurrencySafe() {
        return true
      },
    },
    {
      name: 'rust_stat',
      description:
        'Stat a path through the Rust worker: existence, file-vs-directory, size, and mtime. A '
        + 'missing path reports exists:false instead of failing, so it also answers "does this exist?"',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to stat.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderStat(value)),
      },
      async execute(args, exec) {
        return pool.call('fs.stat', { path: args.path }, fsTimeout(), exec?.signal, exec?.agent?.id ?? 'default')
      },
      isConcurrencySafe() {
        return true
      },
    },
    {
      name: 'rust_ls',
      description:
        'List one directory through the Rust worker (name, directory flag, size); directories end '
        + 'with "/". Use this for a directory listing and glob for pattern search; limit caps entries.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list.' },
          limit: { type: 'number', description: 'Maximum number of entries to return.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderList(value)),
      },
      async execute(args, exec) {
        const params = { path: args.path }
        if (args.limit !== undefined) params.limit = args.limit
        return pool.call('fs.list', params, fsTimeout(), exec?.signal, exec?.agent?.id ?? 'default')
      },
      isConcurrencySafe() {
        return true
      },
    },
    {
      name: 'rust_search',
      description:
        'Search the persistent Rust code index and return ranked, budgeted snippets. Prefer this over '
        + 'grep for code navigation: it ranks definition lines first (kind tag [fn]/[class]/…), caps '
        + 'what it returns to maxBytes, and states how much it truncated, so one call usually answers '
        + '"where is X" without reading whole files. glob filters paths (e.g. "*.ts"); '
        + 'symbolsOnly=true keeps only definition lines. The index is built once per worker and '
        + 'refreshed after this worker writes a file; refresh=true forces a re-scan.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal text to find (or a regex when regex=true).' },
          glob: { type: 'string', description: 'Path filter such as "*.ts" or "src/**/*.rs" (* and ? only).' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
          symbolsOnly: { type: 'boolean', description: 'Return only lines that define a symbol.' },
          contextLines: { type: 'number', description: 'Context lines before/after each hit (0–2, default 1).' },
          maxHits: { type: 'number', description: 'Maximum hits to return (default 24).' },
          maxBytes: { type: 'number', description: 'Byte budget for the rendered payload (default 6000).' },
          refresh: { type: 'boolean', description: 'Re-scan the tree before searching.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderSearch(value)),
      },
      async execute(args, exec) {
        const params = { query: args.query }
        for (const key of ['glob', 'regex', 'symbolsOnly', 'contextLines', 'maxHits', 'maxBytes', 'refresh']) {
          if (args[key] !== undefined) params[key] = args[key]
        }
        return pool.call('search.text', params, SEARCH_TIMEOUT_MS, exec?.signal, exec?.agent?.id ?? 'default')
      },
      isConcurrencySafe() {
        return true
      },
    },
    {
      name: 'rust_symbols',
      description:
        'List symbols (functions, classes, interfaces, types, consts, structs, enums, traits, impls) '
        + 'from the persistent index, one signature per line with no bodies. Pass path to get a file '
        + 'outline, or query to find definitions by name across the tree; kind filters by symbol kind. '
        + 'Use this instead of reading a whole file just to learn its structure — an outline is roughly '
        + 'one tenth of the tokens.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name or prefix (case-insensitive).' },
          path: { type: 'string', description: 'Restrict to files whose path contains this text.' },
          kind: { type: 'string', description: 'fn, class, interface, type, const, struct, enum, trait, impl, def, mod.' },
          limit: { type: 'number', description: 'Maximum symbols to return (default 40).' },
          maxBytes: { type: 'number', description: 'Byte budget for the rendered payload (default 6000).' },
          refresh: { type: 'boolean', description: 'Re-scan the tree before listing.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderSymbols(value)),
      },
      async execute(args, exec) {
        const params = {}
        for (const key of ['query', 'path', 'kind', 'limit', 'maxBytes', 'refresh']) {
          if (args[key] !== undefined) params[key] = args[key]
        }
        return pool.call('search.symbol', params, SEARCH_TIMEOUT_MS, exec?.signal, exec?.agent?.id ?? 'default')
      },
      isConcurrencySafe() {
        return true
      },
    },
    {
      name: 'rust_session_open',
      description:
        'Open a DSH session log (session.v4.jsonl.zstd) through the Rust projection service and return '
        + 'one page of its messages plus per-segment timings (read / zstd decode / JSON parse / fold). '
        + 'The projection is cached: a reopen of an unchanged log is a snapshot load, and because DSH '
        + 'logs are append-only, a log that grew only decodes and folds the newly appended frames. Use '
        + 'cursor with limit to page through a long session without sending the whole log. This reads '
        + 'the log, it never writes to it — the log stays DSH\'s source of truth.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to a session .jsonl.zstd log.' },
          limit: { type: 'number', description: 'Messages per page (1–500, default 50).' },
          cursor: { type: 'number', description: 'Message offset to start the page at (default 0).' },
          refresh: { type: 'boolean', description: 'Ignore the cache and rebuild the projection.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderSession(value)),
      },
      async execute(args, exec) {
        const params = { path: args.path }
        for (const key of ['limit', 'cursor', 'refresh']) {
          if (args[key] !== undefined) params[key] = args[key]
        }
        return pool.call('session.open', params, SESSION_TIMEOUT_MS, exec?.signal, exec?.agent?.id ?? 'default')
      },
      isConcurrencySafe() {
        return true
      },
    },
    {
      name: 'rust_health',
      description:
        'Report the Rust worker sidecar\'s lifecycle: pid, uptime, restart count, inbound-frame gap '
        + 'p50/p99 (the heartbeat keeps it near 2 s), heartbeat misses, last exit code, and whether the '
        + 'worker still sees this host alive. Use it to diagnose a wedged or restarting worker instead of '
        + 'guessing from a slow command.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderHealth(value)),
      },
      async execute() {
        const health = await pool.health()
        const metrics = store?.snapshot()
        return {
          ...health,
          routes: runtime.routes ?? null,
          metrics: metrics
            ? {
                samples: metrics.samples,
                errors: metrics.errors,
                last: metrics.last,
                fastPoints: metrics.history.fast.length,
                slowBuckets: metrics.history.slow.length,
              }
            : null,
        }
      },
      isConcurrencySafe() {
        return true
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Host adapter: every DSH-specific seam lives here, so a future harness release
// that renames or reshapes one of them needs exactly one edit. Everything is
// probed at apply() time and degrades instead of throwing.
// ---------------------------------------------------------------------------

function detectHost(ctx) {
  const capabilities = {
    toolsRegister: typeof ctx?.tools?.register === 'function',
    webServer: false,
    logger: false,
    events: typeof ctx?.on === 'function',
    abortSignal: typeof AbortSignal !== 'undefined',
  }
  let webServer = null
  try {
    webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') ?? null : ctx?.webServer ?? null
    capabilities.webServer = typeof webServer?.register === 'function'
  } catch {
    webServer = null
  }
  capabilities.logger = typeof ctx?.logger === 'function' || typeof ctx?.logger?.info === 'function'
  return { webServer, capabilities }
}

/**
 * Structured, greppable event log. Deliberately dependency-free: DSH's logger
 * service has changed shape between releases, console always works, and a
 * `[dsh-rust-exec]` prefix keeps these lines scrapeable from process output.
 */
function makeLog(ctx) {
  const sink = []
  const emit = (level, event, fields) => {
    const record = { event, at: Date.now(), ...fields }
    sink.push(record)
    if (sink.length > 200) sink.shift()
    const line = `[dsh-rust-exec] ${level} ${event} ${JSON.stringify(fields ?? {})}`
    try {
      const logger = ctx?.logger
      if (typeof logger === 'function') logger(level === 'error' ? 'error' : 'info')(line)
      else if (typeof logger?.[level] === 'function') logger[level](line)
      else if (level === 'error') console.error(line)
      else console.log(line)
    } catch {
      // Logging must never break a tool call.
    }
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    recent: () => sink.slice(),
  }
}

// ---------------------------------------------------------------------------
// Metrics store: a fixed-size ring the HTTP route and the future panel read
// ---------------------------------------------------------------------------

function pickSample(sample) {
  const memory = sample?.memory ?? {}
  const cpu = sample?.cpu ?? {}
  const io = sample?.io ?? {}
  const queue = sample?.queue ?? {}
  const index = sample?.index ?? {}
  return {
    workingSetBytes: memory.workingSetBytes ?? 0,
    privateBytes: memory.privateBytes ?? 0,
    cpuMsTotal: cpu.cpuMsTotal ?? 0,
    cpuPctOneCore: Math.round((cpu.cpuPctOneCore ?? 0) * 10) / 10,
    handles: sample?.handles ?? 0,
    readBytes: io.readBytes ?? 0,
    writeBytes: io.writeBytes ?? 0,
    lanes: queue.lanes ?? 0,
    queued: queue.queued ?? 0,
    peakQueued: queue.peakQueued ?? 0,
    rejected: queue.rejected ?? 0,
    inflight: queue.inflight ?? 0,
    indexFiles: index.files ?? 0,
    indexSymbols: index.symbols ?? 0,
    indexAgeMs: index.ageMs ?? null,
  }
}

// Fields whose process-lifetime min/max the monitor reports. Everything here is a
// plain number on a fast sample, so the fold is one pass per tick.
const EXTREME_FIELDS = [
  'cpuPctOneCore', 'workingSetBytes', 'privateBytes', 'handles',
  'queued', 'inflight', 'indexFiles', 'indexSymbols',
]

function noteExtremes(bucket, point) {
  bucket.samples += 1
  for (const key of EXTREME_FIELDS) {
    const value = Number(point[key])
    if (!Number.isFinite(value)) continue
    const slot = bucket.fields[key] ?? { min: value, max: value, last: value }
    if (value < slot.min) slot.min = value
    if (value > slot.max) slot.max = value
    slot.last = value
    bucket.fields[key] = slot
  }
}

class MetricsStore {
  #timer = null
  #bucketStart = 0
  #bucket = []

  constructor(pool, settings, log) {
    this.pool = pool
    this.settings = settings
    this.log = log
    this.fast = []
    this.slow = []
    this.last = null
    this.samples = 0
    this.errors = 0
    this.lastError = null
    // Host-process lifetime extremes: cleared by a DSH restart, survives a page
    // refresh (the ring itself only covers ~2 minutes).
    this.extremes = { since: Date.now(), samples: 0, fields: {} }
  }

  start() {
    if (this.#timer) return
    this.#bucketStart = Date.now()
    this.#timer = setInterval(() => { void this.#tick() }, this.settings.metricsIntervalMs)
    this.#timer.unref?.()
  }

  stop() {
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  setIntervalMs(intervalMs) {
    this.settings.metricsIntervalMs = intervalMs
    if (this.#timer) {
      this.stop()
      this.start()
    }
  }

  async #tick() {
    try {
      const raw = await this.pool.sample()
      // Soft limits only shed/pause the index; exec and fs calls are never throttled.
      await this.pool.applySoftLimits(raw)
      this.#push(raw)
    } catch (error) {
      this.errors += 1
      this.lastError = error?.message ?? String(error)
    }
  }

  #push(raw) {
    const now = Date.now()
    const point = { t: now, ...pickSample(raw), pool: this.pool.info() }
    this.samples += 1
    noteExtremes(this.extremes, point)
    this.last = { ...point, raw: undefined }
    this.fast.push(point)
    while (this.fast.length > METRICS_FAST_POINTS) this.fast.shift()
    this.#bucket.push(point)
    if (now - this.#bucketStart >= METRICS_SLOW_BUCKET_MS) {
      this.slow.push(this.#foldBucket())
      while (this.slow.length > METRICS_SLOW_BUCKETS) this.slow.shift()
      this.#bucket = []
      this.#bucketStart = now
    }
  }

  #foldBucket() {
    const points = this.#bucket
    const at = (key) => points.map((p) => p[key])
    const avg = (values) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0)
    const max = (values) => (values.length ? Math.max(...values) : 0)
    return {
      t: this.#bucketStart,
      samples: points.length,
      workingSetAvg: avg(at('workingSetBytes')),
      workingSetMax: max(at('workingSetBytes')),
      cpuAvgPct: avg(at('cpuPctOneCore')),
      cpuMaxPct: max(at('cpuPctOneCore')),
      queuePeak: max(at('peakQueued')),
      inflightPeak: max(at('inflight')),
      rejected: max(at('rejected')),
      lanes: max(at('lanes')),
      indexFiles: max(at('indexFiles')),
    }
  }

  snapshot() {
    return {
      schema: 'dsh-rust-exec/metrics@1',
      now: Date.now(),
      intervalMs: this.settings.metricsIntervalMs,
      samples: this.samples,
      errors: this.errors,
      lastError: this.lastError,
      history: {
        fast: this.fast,
        slow: this.slow,
        fastCapacity: METRICS_FAST_POINTS,
        slowBucketMs: METRICS_SLOW_BUCKET_MS,
        slowCapacity: METRICS_SLOW_BUCKETS,
      },
      last: this.last,
      extremes: this.extremes,
      running: this.pool.running,
      pool: this.pool.info(),
      config: {
        lanes: this.pool.lanesPerWorker,
        maxQueueDepth: this.pool.options.maxQueueDepth,
        defaultTimeoutMs: this.settings.defaultTimeoutMs,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP routes: JSON only, registered on the optional webServer service
// ---------------------------------------------------------------------------

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Only these pool keys are accepted by POST /config; everything else is ignored. */
const POOL_CONFIG_KEYS = [
  'maxWorkers',
  'maxShells',
  'maxInFlightPerSession',
  'idleReapMs',
  'rssSoftLimitMb',
  'cpuSoftLimitPct',
]

/** Pick the runtime-tunable pool keys out of a JSON body; `pool.configure` validates them. */
function pickPoolConfig(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body must be a JSON object')
  }
  const patch = {}
  for (const key of POOL_CONFIG_KEYS) {
    if (body[key] !== undefined && body[key] !== null) patch[key] = body[key]
  }
  return patch
}

// ---------------------------------------------------------------------------
// Session projections (read-only): DSH keeps owning the truth source, we only
// project a log into a paged view model. The route accepts a session *id*, never
// a raw path, and every resolved path is re-checked against the sessions root.
// ---------------------------------------------------------------------------

/** `<DSH_HOME>/sessions/<workspace-slug>/<session-id>/session.v<N>.jsonl.zstd` */
const SESSION_LOG_RE = /^session\.v\d+\.jsonl\.zstd$/
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

function sessionsRoot() {
  // The host process does not always inherit DSH_HOME (tool children do), so fall
  // back to the documented profile layout and finally to `~/.dsh`.
  const env = process.env
  if (env.DSH_HOME) return join(env.DSH_HOME, 'sessions')
  if (env.DSH_PROFILE_DIR) return join(resolve(env.DSH_PROFILE_DIR, '..', '..'), 'sessions')
  return join(homedir(), '.dsh', 'sessions')
}

function clampInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/** Newest-first list of readable session logs, capped at `limit` entries. */
async function listSessionLogs(limit = 50) {
  const root = sessionsRoot()
  if (!root) return []
  const out = []
  let workspaces = []
  try {
    workspaces = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(root, workspace.name)
    let sessions = []
    try {
      sessions = await readdir(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = join(workspaceDir, session.name)
      let files = []
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      const file = files.filter((name) => SESSION_LOG_RE.test(name)).sort().pop()
      if (!file) continue
      try {
        const info = await stat(join(dir, file))
        out.push({ id: session.name, workspace: workspace.name, file, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // Vanished between readdir and stat: skip.
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, Math.max(1, limit))
}

/** Map a session id to its absolute log path, refusing anything outside the root. */
async function resolveSessionLog(id) {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new Error('invalid session id')
  const root = sessionsRoot()
  if (!root) throw new Error('DSH_HOME is not set; cannot locate session logs')
  const rootAbs = resolve(root) + sep
  const hit = (await listSessionLogs(500)).find((entry) => entry.id === id)
  if (!hit) throw new Error('unknown session id')
  const file = resolve(join(root, hit.workspace, hit.id, hit.file))
  if (!file.startsWith(rootAbs)) throw new Error('session path escapes the sessions root')
  return file
}

function installRoutes(ctx, { store, pool, settings, log, state }) {
  const routeState = state.routes
  const send = (res, status, body) => {
    const text = JSON.stringify(body)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(text)
  }
  log.info('sessions.root', { root: sessionsRoot() })
  const routes = [
    {
      path: `${METRICS_ROUTE_PREFIX}/metrics`,
      handler: (_req, res) => send(res, 200, store.snapshot()),
    },
    {
      path: `${METRICS_ROUTE_PREFIX}/health`,
      handler: async (_req, res) => {
        try {
          send(res, 200, { ...(await pool.health()), routes: routeState })
        } catch (error) {
          send(res, 500, { error: error?.message ?? String(error) })
        }
      },
    },
    {
      path: `${METRICS_ROUTE_PREFIX}/events`,
      handler: (_req, res) => send(res, 200, { schema: 'dsh-rust-exec/events@1', events: log.recent() }),
    },
    {
      path: `${METRICS_ROUTE_PREFIX}/sessions`,
      handler: async (_req, res) => {
        try {
          send(res, 200, { schema: 'dsh-rust-exec/sessions@1', sessions: await listSessionLogs() })
        } catch (error) {
          send(res, 500, { error: error?.message ?? String(error) })
        }
      },
    },
    {
      path: `${METRICS_ROUTE_PREFIX}/session`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const file = await resolveSessionLog(url.searchParams.get('id'))
          const params = {
            path: file,
            limit: clampInt(url.searchParams.get('limit'), 50, 1, 500),
            cursor: clampInt(url.searchParams.get('cursor'), 0, 0, 1_000_000),
          }
          send(res, 200, await pool.call('session.open', params, SESSION_TIMEOUT_MS, undefined, 'http'))
        } catch (error) {
          send(res, 400, { error: error?.message ?? String(error) })
        }
      },
    },
    {
      path: `${METRICS_ROUTE_PREFIX}/session/body`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const file = await resolveSessionLog(url.searchParams.get('id'))
          const seqs = (url.searchParams.get('seqs') ?? '')
            .split(',')
            .map((item) => Number.parseInt(item, 10))
            .filter((value) => Number.isFinite(value) && value >= 0)
            .slice(0, 40)
          if (seqs.length === 0) {
            send(res, 400, { error: 'seqs is required' })
            return
          }
          const params = {
            path: file,
            seqs,
            maxChars: clampInt(url.searchParams.get('maxChars'), 40_000, 1_000, 400_000),
          }
          send(res, 200, await pool.call('session.body', params, SESSION_TIMEOUT_MS, undefined, 'http'))
        } catch (error) {
          send(res, 400, { error: error?.message ?? String(error) })
        }
      },
    },
    {
      path: `${METRICS_ROUTE_PREFIX}/config`,
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === undefined) {
          send(res, 200, { config: { ...settings }, pool: pool.info() })
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: 'only GET and POST are supported' })
          return
        }
        try {
          const patch = pickPoolConfig(await readJsonBody(req))
          const applied = pool.configure(patch)
          // Keep the effective settings in sync so a later GET reports what is live.
          for (const key of POOL_CONFIG_KEYS) {
            if (applied[key] !== undefined) settings[key] = applied[key]
          }
          log.info('config.update', applied)
          send(res, 200, { applied, pool: pool.info() })
        } catch (error) {
          send(res, 400, { error: error?.message ?? String(error) })
        }
      },
    },
  ]
  const disposers = []
  let disposed = false
  // DSH boots services in dependency order, and this plugin may be applied before
  // the HTTP server service exists. One failed probe must not cost the panel its
  // data route forever, so re-probe on a short backoff and record every outcome.
  const RETRY_DELAYS_MS = [0, 100, 250, 500, 1000, 2000, 2000, 2000, 2000]
  // After the fast window, never give up: a slow host may still activate webServer
  // (or re-create it). Probing ctx.get is free, so keep a slow tail forever.
  const SLOW_RETRY_MS = 15_000
  function unmountAll() {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Ignore: disposing during shutdown.
      }
    }
    disposers.length = 0
    routeState.mounted = []
  }
  function mount(attempt) {
    if (disposed) return
    routeState.attempts = attempt + 1
    const probe = detectHost(ctx)
    routeState.webServer = probe.capabilities.webServer
    const webServer = probe.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      const fastPhase = attempt + 1 < RETRY_DELAYS_MS.length
      const delay = fastPhase ? RETRY_DELAYS_MS[attempt + 1] : SLOW_RETRY_MS
      if (!fastPhase && !routeState.exhausted) {
        routeState.exhausted = true
        log.error('routes.exhausted', {
          attempts: routeState.attempts,
          reason: 'webServer service unavailable (ctx.get("webServer") returned nothing)',
          retryInMs: delay,
        })
      }
      const timer = setTimeout(() => mount(attempt + 1), delay)
      if (typeof timer?.unref === 'function') timer.unref()
      if (fastPhase) log.info('route.retry', { attempt: attempt + 1, nextInMs: delay })
      return
    }
    if (routeState.exhausted) {
      routeState.exhausted = false
      log.info('routes.recovered', { attempts: routeState.attempts })
    }
    for (const route of routes) {
      try {
        disposers.push(webServer.register({ kind: 'exact', path: route.path, handler: route.handler }))
        routeState.mounted.push(route.path)
        log.info('route.registered', { path: route.path })
      } catch (error) {
        // A duplicate path means another fiber already claimed it; a missing
        // register means a future harness changed the seam. Neither may break tools.
        routeState.errors.push({ path: route.path, error: error?.message ?? String(error) })
        log.warn('route.register-failed', { path: route.path, error: error?.message })
      }
    }
    routeState.mountedAt = Date.now()
    log.info('routes.mounted', { count: routeState.mounted.length, attempts: routeState.attempts })
  }
  mount(0)
  return () => {
    disposed = true
    unmountAll()
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const host = detectHost(ctx)
  const log = makeLog(ctx)
  // WorkerPool logs `(level, message)`; bridge it onto the plugin's event logger.
  const poolLog = (level, message) => {
    const sink = level === 'error' ? log.error : level === 'warn' ? log.warn : log.info
    sink.call(log, message)
  }
  const pool = new WorkerPool(settings.workerPath, settings, poolLog)
  const store = new MetricsStore(pool, settings, log)
  // Observable seam state: what the harness let us mount, and how many probes it took.
  // `rust_health` reports it, so a 404 in the panel is diagnosable from inside a chat.
  const runtime = {
    routes: {
      attempts: 0,
      mounted: [],
      errors: [],
      mountedAt: null,
      exhausted: false,
      webServer: host.capabilities.webServer,
    },
  }
  const hostInfo = {
    dshVersion: process.env.DSH_VERSION ?? null,
    profile: process.env.DSH_PROFILE ?? null,
    capabilities: host.capabilities,
    injected: inject,
  }
  log.info('plugin.applied', hostInfo)
  // Detached prewarm: spawn the first worker now so the first tool call skips boot.
  pool.start().catch((error) => log.warn('pool.prewarm-failed', { error: error?.message }))

  ctx.effect(() => {
    if (!host.capabilities.toolsRegister) {
      log.error('tools.unavailable', { reason: 'ctx.tools.register is missing; no tools registered' })
      return () => {}
    }
    const disposers = createToolDefinitions(pool, settings, store, runtime)
      .map((definition) => ctx.tools.register(definition))
    log.info('tools.registered', { count: disposers.length })
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'rust-exec tools')

  ctx.effect(() => {
    const disposeRoutes = installRoutes(ctx, { store, pool, settings, log, state: runtime })
    store.start()
    return () => {
      store.stop()
      disposeRoutes()
    }
  }, 'rust-exec metrics and routes')

  ctx.effect(() => () => {
    store.stop()
    pool.dispose()
  }, 'rust-exec worker pool')
}
