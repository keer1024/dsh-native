/**
 * Host bundle: exposes the prebuilt `dsh-rust-worker` sidecar as DSH tools.
 *
 * The sidecar speaks LSP-style framed JSON-RPC 2.0 over stdin/stdout
 * (`Content-Length: <N>\r\n\r\n` + N bytes of JSON) and keeps one warm
 * PowerShell behind a loopback socket. This plugin owns a pool of 1..maxWorkers
 * worker children, spawns them on demand (the first one eagerly at apply time),
 * matches responses by request id, and kills the pool when the plugin is disposed.
 */
/**
 * 模块职责（宿主侧 ESM bundle，dsh-native 插件）
 *
 * 把预编译的 `dsh-rust-worker` 子进程包装成 DSH 工具：WorkerPool 负责 worker
 * 进程生命周期、lane 池、每会话队列、空闲回收与 RSS/CPU 软限制；工具注册层做
 * 渐进披露（常驻 rust_exec / rust_read / rust_search / rust_health / native_help，
 * 其余按需激活）；MetricsStore 以 1 s 采样维护环形历史与 readiness 状态机；
 * installRoutes 把 /metrics /cache /health /events /sessions /session
 * /session/body 挂到可选的 webServer；apply() 负责延迟启动、warmIndex 与清理。
 *
 * 关键不变量：
 * - 失败以返回值或错误对象呈现，apply() 自身不抛异常：宿主缺少某个 seam 时降级并记日志。
 * - 超时全部取自显式常量（DEFAULT_TIMEOUT_MS 60 s、HANDSHAKE_TIMEOUT_MS 5 s、
 *   START/SEARCH/SESSION 为 15/60/120 s），exec 额外叠加 SHELL_TIMEOUT_GRACE_MS。
 * - 字节上限固定：stderr 仅留 MAX_STDERR_BYTES，渲染层用 truncated/shown/total 报截断。
 * - 工具名必须与 RESIDENT_TOOL_NAMES / DORMANT_TOOL_NAMES 完全一致；native_help
 *   只激活后者中的名字，重复注册由 disposers 去重。
 * - readiness 单向推进 pending → starting → ready|failed，面板与 /health 读同一对象。
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
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
/** stderr 只保留尾部 2 KB：它是诊断线索，不会回传给模型。 */
const MAX_STDERR_BYTES = 2_000
/** A tool call slower than this is logged even when it succeeds. */
const SLOW_CALL_MS = 5_000
const SEARCH_TIMEOUT_MS = 60_000
// A cold projection of a multi-megabyte log pays zstd decode + JSON parse once; the cache makes
// later opens cheap, so this only bounds the worst-case first open.
const SESSION_TIMEOUT_MS = 120_000
/** 协议版本守卫：宿主与 worker 各持一份，握手时比对，不匹配就让 worker 退出而不是错跑。 */
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
// Delay between plugin mount and the first worker spawn. Long enough that DSH's
// own startup and first paint are done, short enough that the first tool call
// almost never waits (a call starts the worker immediately anyway).
const DEFAULT_START_DELAY_MS = 1_200
const METRICS_FAST_POINTS = 300
const METRICS_SLOW_BUCKETS = 60
const METRICS_SLOW_BUCKET_MS = 60_000
/** 所有 HTTP 路由共享的前缀；面板与 /health 都按它拼路径。 */
const METRICS_ROUTE_PREFIX = '/api/dsh-rust-exec'

/** 硬依赖：没有 tools 服务就不挂工具；webServer 等其余 seam 都是可选的。 */
export const inject = ['tools']

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** 配置模式：只做校验与归一化，不改写 Loader 行；非法值汇总成 issues，不抛异常。 */
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
      // 校验与归一化分离：这里只报告问题，默认值填充统一交给 normalizeConfig。
      if (issues.length > 0) return { issues }
      return { value: normalizeConfig(raw) }
    },
  },
}

/** 逻辑 CPU 数；读不到时按 4 核估算，供 lanes 默认值使用。 */
function coreCount() {
  const cores = cpus()?.length ?? 4
  return Math.max(1, cores)
}

/**
 * 把校验过的原始配置补成完整配置对象：每个键独立回退默认值，未知键直接丢弃。
 * lanes 未指定时取核数的一半（至少 1、至多 DEFAULT_LANES），避免小机器起太多 shell。
 */
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
    // Progressive disclosure: publish four resident tools plus native_help and let
    // the model activate the rest on demand (10 resident schemas cost 1,812 tokens
    // on every request; the resident four cost ~500). Set false to publish all ten.
    progressiveDisclosure: raw.progressiveDisclosure !== false,
    // Text compression for reads: strip comments and fold indentation, keeping the
    // line count and therefore every line number. Opt-in — default off so a read
    // always returns the bytes on disk unless the caller asks for the cheap view.
    compactReads: raw.compactReads === true,
    // Startup is asynchronous by default: the plugin mounts without waiting for a
    // worker, then starts it ~1.2 s later so DSH's own boot is never behind a cold
    // index build or four PowerShell starts. Set deferStart:false to start inline.
    deferStart: raw.deferStart !== false,
    startDelayMs: typeof raw.startDelayMs === 'number' && raw.startDelayMs >= 0 && raw.startDelayMs <= 30_000
      ? raw.startDelayMs
      : DEFAULT_START_DELAY_MS,
    // The worker skips index prewarm when this is false; the host triggers the
    // build once the plugin reports ready, so nothing competes with DSH startup.
    prewarmIndex: raw.prewarmIndex !== false,
  }
}

// ---------------------------------------------------------------------------
// Worker client: one framed-JSON-RPC child process, lazy, self-healing
// ---------------------------------------------------------------------------

/** 单实例锁路径：每个 profile 一份，内容为 worker pid + 宿主实例 token。 */
/** Where the worker records `pid\nhostInstance`; mirrors `claim_lock` in main.rs. */
function workerLockPath() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
  return join(home, 'run', `dsh-rust-worker-${process.env.DSH_PROFILE ?? 'default'}.lock`)
}

/** 宿主实例 token：整个池共用一个，避免新 worker 把同池兄弟判成陈旧锁持有者而杀掉。 */
/**
 * Identity of *this* DSH host process. It must be shared by every worker in the
 * pool: the single-instance lock file is one per profile, so a per-worker token
 * would make each new worker read a sibling's token, treat it as stale and kill
 * it (observed: exit code 1 right after the pool grew to two workers).
 */
const HOST_INSTANCE = randomUUID()

const WINDOWS = process.platform === 'win32'

/** Package version, read once for the diagnostics log (`unknown` if it is unavailable). */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

// ---------------------------------------------------------------------------
// Diagnostics: one JSONL log per host process
// ---------------------------------------------------------------------------

/**
 * Plugin state outside the workspace. DSH's sandbox labels executables that live
 * inside a workspace as Low integrity, and the Windows loader starts such an
 * image at Low IL — where every write to a user-owned file fails with
 * `拒绝访问`. A copy made here carries no label, so it runs at the host's own
 * integrity instead (see `relocateWorker`).
 */
function pluginStateDir(...parts) {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, 'dsh-native', ...parts)
}

/** Rotate at 2 MB so a long-lived host cannot fill the disk with diagnostics. */
const LOG_MAX_BYTES = 2_000_000
/** Counters plus the last few failures, exposed through `/health`. */
const RECENT_ERRORS = []
const RECENT_ERROR_LIMIT = 20
/** Executable path → integrity verdict, so a respawn does not re-run `icacls`. */
const INTEGRITY_CACHE = new Map()
let logPathCache = null

/** 每个宿主进程一个 JSONL 诊断日志路径；首次调用后缓存，避免每行都重拼路径。 */
function workerLogPath() {
  logPathCache ??= pluginStateDir('logs', `rust-exec-${process.pid}.log`)
  return logPathCache
}

/**
 * Append one JSONL record. Diagnostics must never fail a tool call: a read-only
 * home, a full disk or a locked file just drops the record.
 */
function logEvent(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, pid: process.pid, ...fields })
  try {
    const path = workerLogPath()
    mkdirSync(dirname(path), { recursive: true })
    // 超过 2 MB 就轮转成 .log.1：只保留一代，覆盖旧文件失败也不影响本次写入。
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) {
      const previous = `${path}.1`
      try {
        rmSync(previous, { force: true })
      } catch {
        // A previous generation we cannot drop is not worth failing over.
      }
      renameSync(path, previous)
    }
    appendFileSync(path, `${line}\n`, 'utf8')
  } catch {
    // Best effort only.
  }
  if (process.env.DSH_RUST_DEBUG) console.error(`[dsh-native] ${line}`)
}

/** Remember a failure so `rust_health` can show it without opening a file. */
function noteError(record) {
  RECENT_ERRORS.push({ ts: new Date().toISOString(), ...record })
  if (RECENT_ERRORS.length > RECENT_ERROR_LIMIT) RECENT_ERRORS.shift()
}

/** Errors that mean "the worker is not allowed to touch this path". */
const ACCESS_DENIED = /拒绝访问|access is denied|access denied|os error 5\b|EPERM|EACCES/i

/** Image name a lock file's pid must still be running before we signal it. */
function workerImageName(workerPath) {
  return basename(workerPath).toLowerCase()
}

/** 探测 pid 是否仍运行 worker 映像（yes/no/unknown）；unknown 一律不当作"已死"。 */
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
      // A relocated worker runs from `dsh-rust-worker-<size>-<mtime>.exe`, which a
      // lock file written before the relocation cannot name; compare the stem.
      const stem = image.replace(/-\d+-\d+(\.exe)$/, '$1')
      return stem === expectedImage ? 'yes' : 'no'
    }
    if (attempt < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
  }
  return 'unknown'
}

/** 读可执行文件的 Windows 完整性标签：low 表示被沙箱标记过，需要迁出工作区再启动。 */
/**
 * Integrity label of an executable *file*, as Windows will honour it at launch.
 *
 * Windows starts an image at the integrity level stamped on the file — `icacls`
 * prints it as `Mandatory Label\Low Mandatory Level:(I)(NW)` — not at the level
 * of the parent that spawned it. DSH's sandbox stamps that label on executables
 * it finds inside a workspace, so the bundled worker becomes a Low-IL process:
 * it runs commands and reads the whole disk, but a write to any file the user
 * owns is denied with `拒绝访问 (os error 5)` while the host's own native tools
 * write the same path fine. A plain copy drops the label, so `relocateWorker`
 * starts the copy instead of the labelled original.
 */
function imageIntegrity(path) {
  if (!WINDOWS) return 'unsupported'
  const cached = INTEGRITY_CACHE.get(path)
  if (cached) return cached
  const probe = spawnSync('icacls', [path], { windowsHide: true, encoding: 'utf8', timeout: 8_000 })
  const verdict = probe.error || typeof probe.stdout !== 'string'
    ? 'unknown'
    : /Low Mandatory Level/i.test(probe.stdout) ? 'low' : 'normal'
  // The label is a property of the built image; a plugin reload is what changes it.
  if (verdict !== 'unknown') INTEGRITY_CACHE.set(path, verdict)
  return verdict
}

/** 把 worker 复制到插件状态目录（文件名带 size-mtime 指纹），绕开工作区内的 Low-IL 标签。 */
/**
 * Copy the worker out of the workspace so it stops inheriting a Low-IL label,
 * and return the path to the copy. One 2 MB copy per build: the name carries
 * size + mtime, so a new build lands beside the old one instead of racing a
 * worker that is still running from it.
 */
function relocateWorker(source) {
  let fingerprint = 'unlabeled'
  let sourceBytes = 0
  try {
    const info = statSync(source)
    fingerprint = `${info.size}-${Math.round(info.mtimeMs)}`
    sourceBytes = info.size
  } catch {
    // A copy under a stable name still runs; only the staleness check is lost.
  }
  const extension = WINDOWS ? '.exe' : ''
  const target = join(pluginStateDir('bin'), `${basename(source, extension)}-${fingerprint}${extension}`)
  // Re-copy a truncated leftover: spawning half an image fails with a bare
  // "worker failed to start", which is much harder to read than a re-copy.
  let complete = false
  try {
    complete = statSync(target).size === sourceBytes && sourceBytes > 0
  } catch {
    complete = false
  }
  if (!complete) {
    mkdirSync(dirname(target), { recursive: true })
    // Copy under a temporary name first, so a spawn never sees a partial file.
    // The pid keeps two workers spawning at once from writing the same temp path.
    const partial = `${target}.partial-${process.pid}`
    copyFileSync(source, partial)
    renameSync(partial, target)
    pruneWorkerCopies(dirname(target), target)
  }
  return target
}

/** 只保留当前副本与次新的一份，其余视为旧构建删除；清理失败不算错误。 */
/** Keep the live copy plus one older generation; the rest are stale builds. */
function pruneWorkerCopies(dir, keep) {
  try {
    const stale = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(WINDOWS ? '.exe' : ''))
      .filter((name) => join(dir, name) !== keep)
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime)
    for (const { name } of stale.slice(1)) {
      try {
        rmSync(join(dir, name), { force: true })
      } catch {
        // Housekeeping only.
      }
    }
  } catch {
    // Pruning never fails a spawn.
  }
}

/** 结束整个进程树（Windows 用 taskkill /T /F），否则 PowerShell 孙进程会占住管道不放。 */
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

/** 仅当锁文件内容仍等于我们判定为陈旧的那份时才删除，避免误删别的实例刚写的锁。 */
/** Drop the lock, but only if it still holds the exact record we judged stale. */
function dropStaleLock(expectedText) {
  try {
    if (readFileSync(workerLockPath(), 'utf8') === expectedText) unlinkSync(workerLockPath())
  } catch {
    // Raced with a fresh claim: the next hello rewrites it anyway.
  }
}

/** The record this host writes for one of its workers; `claim_lock` in main.rs uses the same shape. */
/** 锁文件内容格式 `workerPid\nhostInstance`，与 worker 侧 claim_lock 保持同构。 */
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
/** 宿主侧写锁，返回写入文本（失败返回 null）；低完整性 worker 自己写不了这个目录。 */
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

/** 释放本宿主为某 pid 写的锁；内容不匹配说明锁已易主，直接跳过。 */
/** Remove this host's record for `pid` (a different record belongs to someone else). */
function releaseWorkerLock(pid) {
  if (!pid) return
  dropStaleLock(lockText(pid))
}

/**
 * 一个 worker 子进程的客户端：spawn、hello/initialize 握手、心跳、超时、重启与锁文件都在这里。
 * 对外只有 start / call / health / kill；JSON-RPC 分帧、按 id 配对、写串行化均为内部实现。
 * 进程自愈也由本类负责，WorkerPool 只做调度决策。
 */
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
  /** Path actually spawned: the relocated copy when the source carried a Low-IL label. */
  #launchPath = null
  /** `low` / `normal` / `unknown` — integrity Windows starts the source image at. */
  #integrity = null

  /** `workerPath` 是打包/开发路径；`lanes` 与 `maxQueueDepth` 会作为环境变量传给子进程。 */
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

  /** 幂等启动：并发首次调用共享同一次 spawn；退避等待期内不会每次调用都重试。 */
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

  /** 发送一个请求：超过 SLOW_CALL_MS 的成功调用也记一行日志，超时则顺手杀掉 worker。 */
  /** Send one JSON-RPC request, starting the worker on demand. */
  async call(method, params, timeoutMs, signal) {
    await this.start()
    const startedAt = performance.now()
    try {
      const result = await this.#request(method, params, timeoutMs, signal)
      const elapsedMs = performance.now() - startedAt
      // A call this slow is worth a line in the log even when it succeeded: it is
      // how a cold index build or a wedged lane shows up after the fact.
      if (elapsedMs > SLOW_CALL_MS) {
        logEvent('tool.slow', { method, elapsedMs: Math.round(elapsedMs), path: params?.path ?? null })
      }
      return result
    } catch (error) {
      this.#logFailure(method, params, error, performance.now() - startedAt)
      // A local timeout leaves the worker in an unknown state; drop it so the
      // next call gets a fresh child instead of a wedged one.
      if (error?.code === 'WORKER_TIMEOUT') this.kill('rust worker killed after a request timeout')
      throw error
    }
  }

  /** 把访问被拒的裸 `os error 5` 补成可执行的诊断（worker 路径、完整性、日志位置）。 */
  /**
   * Record why a call failed, and turn a bare `os error 5` into something the
   * reader can act on: which worker, at what integrity, and where the log is.
   */
  #logFailure(method, params, error, elapsedMs) {
    const message = error?.message ?? String(error)
    const record = {
      method,
      path: typeof params?.path === 'string' ? params.path : null,
      code: error?.code ?? null,
      elapsedMs: Math.round(elapsedMs),
      workerPid: this.#child?.pid ?? null,
      integrity: this.#integrity,
      message: message.slice(0, 600),
    }
    logEvent('tool.error', record)
    noteError(record)
    if (!ACCESS_DENIED.test(message)) return
    const workerPath = this.#launchPath ?? this.workerPath
    const relocated = this.#launchPath && this.#launchPath !== this.workerPath
    error.message = `${message}\n\n[dsh-native] write denied for ${record.path ?? 'this path'}. `
      + `Worker image: ${workerPath} (source label: ${this.#integrity ?? 'unknown'}`
      + `${relocated ? ', running a relocated copy' : ''}). `
      + `Causes, in order: a deny ACE or read-only attribute on the path; a locked file; `
      + `the worker itself starting at Low integrity. Log: ${workerLogPath()}`
  }

  /** 本地计数 + worker 自述合成一份快照；worker 不在或自述超时也必须返回本地部分。 */
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
      // Which image actually runs, and whether it had to be relocated to escape
      // DSH's Low-integrity workspace label. `rust_health` answers "why can't the
      // worker write this file?" without anyone reading the log first.
      workerPath: this.#launchPath ?? this.workerPath,
      sourceWorkerPath: this.workerPath,
      relocated: Boolean(this.#launchPath && this.#launchPath !== this.workerPath),
      integrity: this.#integrity,
      logPath: workerLogPath(),
      recentErrors: RECENT_ERRORS.slice(-5),
    }
    if (!this.#child) return local
    try {
      return { ...local, worker: await this.#request('worker.health', {}, 5_000) }
    } catch (error) {
      return { ...local, healthError: error.message }
    }
  }

  /** 停止子进程并拒绝所有挂起请求；先杀进程树再拆管道，否则孙进程会一直持有管道。 */
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

  /** 清理上一宿主遗留的 worker：先核对锁里的 pid 仍是 worker 映像，再发信号。 */
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

  /** 决定实际启动路径：仅 low 完整性时复制迁出，迁出失败就退回原路径继续跑。 */
  /**
   * Which image to run. A worker started from inside a DSH workspace is a
   * Low-integrity process (see `imageIntegrity`), and such a worker cannot write
   * anything the user owns — `rust_write` / `rust_edit` fail with `拒绝访问`
   * while the host's own tools write the same path fine. Relocating to a copy
   * outside the workspace costs one 2 MB copy per build and restores writes.
   */
  #resolveLaunchPath() {
    this.#integrity = imageIntegrity(this.workerPath)
    if (this.#integrity !== 'low') return (this.#launchPath = this.workerPath)
    try {
      const launched = relocateWorker(this.workerPath)
      logEvent('worker.relocated', { source: this.workerPath, launchPath: launched })
      return (this.#launchPath = launched)
    } catch (error) {
      logEvent('worker.relocate-failed', { source: this.workerPath, error: error?.message })
      return (this.#launchPath = this.workerPath)
    }
  }

  /** 完整启动流程：清残留锁 → 选启动路径 → spawn → hello/initialize 握手 → 起心跳。 */
  async #spawn() {
    const startedAt = performance.now()
    this.#reapStale()
    const launchPath = this.#resolveLaunchPath()
    logEvent('worker.spawn', {
      source: this.workerPath,
      launchPath,
      integrity: this.#integrity,
      relocated: launchPath !== this.workerPath,
      cwd: WORKER_CWD,
      lanes: this.options.lanes,
      version: PLUGIN_VERSION,
    })
    const child = spawn(launchPath, [], {
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
        // 0 = no index prewarm and no lane prewarm at spawn; the host asks for the
        // index build once DSH is up, and lanes start on their first call.
        DSH_RUST_PREWARM: this.options.prewarmIndex === false ? '0' : '1',
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
    // pid 可能只出现在 hello 或 initialize 之一；拿不到就不写锁，免得下次启动误杀。
    const workerPid = Number(welcome?.workerPid ?? info?.worker?.pid ?? 0)
    this.#lockPid = workerPid > 0 ? workerPid : null
    if (this.#lockPid) claimWorkerLock(this.#lockPid)
    this.#failCount = 0
    this.#restartAt = 0
    this.#startHeartbeat()
    logEvent('worker.ready', {
      workerPid: workerPid > 0 ? workerPid : null,
      launchPath,
      integrity: this.#integrity,
      protocol: welcome?.protocol ?? HELLO_VERSION,
      startupMs: Math.round(performance.now() - startedAt),
    })
    return this.info
  }

  /** 非主动退出：拒绝挂起请求、清空 slot、记日志、释放锁，最后按退避安排重启。 */
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
    logEvent('worker.exit', {
      message,
      pid: dyingPid ?? null,
      restarts: this.#restarts,
      stderr: detail.slice(-500),
    })
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

  /** 按 `Content-Length` 分帧解包 stdout：先攒进 #buffer，凑满一帧才解析并派发。 */
  #onStdout(chunk) {
    const now = performance.now()
    if (this.#lastInboundAt > 0) {
      // 只留最近 512 个入站间隔：够算 p50/p99，又不会随进程寿命无界增长。
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
      // 帧体还没收齐就返回，等下一次 data 事件继续拼；绝不按半帧解析。
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

  /** 按 id 配对响应：成功走 resolve，JSON-RPC error 转成带 workerCode 的 Error 后 reject。 */
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

  /** 2 s 心跳（setTimeout 链，非 setInterval）：顺带判定静默并投递 ping 帧。 */
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

  /** 停心跳并复位探测标志，保证下次启动的心跳链可以重新开始。 */
  #stopHeartbeat() {
    if (this.#beatTimer !== null) {
      clearTimeout(this.#beatTimer)
      this.#beatTimer = null
    }
    this.#probing = false
  }

  /** 怀疑流程：投两个间隔 1 s 的探针，再等 2.2 s 复核；有请求在飞时不判死。 */
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
      // 探针与最后一次入站都超过静默阈值：计一次丢失，杀掉后按退避重排重启。
      this.#misses += 1
      this.kill('rust worker stopped answering heartbeats')
      this.#scheduleRestart()
    }, 2 * PROBE_GAP_MS + 200).unref?.()
  }

  /** 失败计数 +1，按退避阶梯 0/0.5/2/5/30 s 安排下次启动；超出阶梯后固定 30 s。 */
  #scheduleRestart() {
    this.#failCount += 1
    const delay = RESTART_BACKOFF_MS[Math.min(this.#failCount, RESTART_BACKOFF_MS.length - 1)]
    this.#restartAt = Date.now() + delay
    logEvent('worker.restart-scheduled', { failCount: this.#failCount, delayMs: delay })
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

  /** 发请求并等同 id 的响应；超时或 abort 会摘除自己的 pending 条目，不留悬空。 */
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
      // 超时只负责 reject 并摘除条目；是否杀掉 worker 由 call() 按错误码决定。
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

/** 把纯文本包成 DSH 工具输出要求的 content 数组。 */
/** @param {unknown} value */
function textOf(value) {
  return [{ type: 'text', text: String(value) }]
}

/** Trim one trailing newline so the footer does not float on a blank line. */
function trimTail(text) {
  return typeof text === 'string' ? text.replace(/\r?\n$/, '') : ''
}

/**
 * Model-facing paths are workspace-relative. A full Windows path costs ~26 extra
 * tokens per occurrence, and a search result repeats the path on every hit, so
 * this is the single largest token win on the render side.
 */
function relPath(value) {
  const text = typeof value === 'string' ? value : ''
  if (!text) return ''
  const root = WORKER_CWD.endsWith(sep) ? WORKER_CWD.slice(0, -1) : WORKER_CWD
  // The worker reports forward slashes on every platform; compare both spellings.
  const normalized = sep === '\\' ? text.split('/').join('\\') : text.split('\\').join('/')
  return normalized.startsWith(root + sep) ? normalized.slice(root.length + 1) : normalized
}

/**
 * 16 hex chars identify a content version as well as 64 do, for a quarter of the
 * tokens. `rust_write` accepts a prefix as expectedHash, so the footer can stay short.
 */
const HASH_PREFIX = 16
function shortHash(hash) {
  return typeof hash === 'string' && hash.length > HASH_PREFIX ? hash.slice(0, HASH_PREFIX) : (hash ?? '')
}

/** 渲染 exec 结果：正文 + 一行 [exit …] 页脚；页脚必须写明排队耗时与 stdout 截断情况。 */
function renderExec(value) {
  const { exitCode, stdout, ms, wallMs, queueMs, aborted, truncated, totalBytes, shownBytes } = value
  const body = trimTail(stdout)
  if (aborted) {
    const stamp = `[aborted · ${typeof wallMs === 'number' ? `${wallMs} ms wall` : 'call cancelled'}]`
    return body ? `${body}\n${stamp}` : stamp
  }
  const timing = typeof wallMs === 'number' ? `${wallMs} ms` : `${ms} ms`
  const queueLabel = typeof queueMs === 'number' && queueMs > 0 ? ` · queued ${queueMs} ms` : ''
  // A capped stdout must say so, and say how much is missing, or the model will
  // reason over a silently truncated body.
  const cut = truncated
    ? ` · stdout cut at ${shownBytes ?? '?'} B of ${totalBytes ?? '?'} B: narrow the command or add | Select-Object -First N`
    : ''
  const stamp = `[exit ${exitCode} · ${timing}${queueLabel}${cut}]`
  return body ? `${body}\n${stamp}` : stamp
}

// ---------------------------------------------------------------------------
// Read observation cache: re-reading an unchanged range costs tokens for
// nothing, so the second identical read returns a notice instead of the body.
// Modelled on dsh-ops' read-observation key; `refresh: true` always reprints.
// ---------------------------------------------------------------------------
// 上限 256 条、TTL 5 分钟：键是"会话|路径|offset|limit"，命中还要求 sha 完全一致。
const READ_CACHE_LIMIT = 256
const READ_CACHE_TTL_MS = 5 * 60_000
const readCache = new Map()
/** Hit/miss counters for the observation cache, surfaced by `/metrics.cache.read`. */
const readCacheStats = { hits: 0, misses: 0 }

/** 观察缓存的键：会话 id + 路径 + offset/limit；同一文件的不同页互不影响。 */
function readCacheKey(exec, params) {
  return `${exec?.agent?.id ?? 'default'}|${params.path}|${params.offset ?? 1}|${params.limit ?? ''}`
}

/** Age of an identical earlier read in ms, or 0 when the body must be printed. */
function recallRead(key, hash) {
  const hit = readCache.get(key)
  if (!hit) {
    readCacheStats.misses += 1
    return 0
  }
  if (hit.hash !== hash) {
    readCacheStats.misses += 1
    return 0
  }
  const age = Date.now() - hit.at
  if (age > READ_CACHE_TTL_MS) {
    readCache.delete(key)
    readCacheStats.misses += 1
    return 0
  }
  readCacheStats.hits += 1
  return age
}

/** Footprint of the observation cache: entry count, an upper-bound byte estimate
 *  (key strings dominate; the stored hash is fixed width), and hit/miss totals. */
function readCacheSnapshot() {
  let bytes = 0
  for (const [key] of readCache) bytes += key.length * 2 + 80
  return {
    entries: readCache.size,
    limit: READ_CACHE_LIMIT,
    ttlMs: READ_CACHE_TTL_MS,
    bytes,
    hits: readCacheStats.hits,
    misses: readCacheStats.misses,
  }
}

/** 写入或刷新缓存条目，再按插入顺序淘汰最旧条目，把容量压在 READ_CACHE_LIMIT 内。 */
function rememberRead(key, hash) {
  // 先删再插：Map 保持插入顺序，这样"最近用过"的条目总在队尾，淘汰从队首开始。
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

/**
 * Lossless-by-line-number compaction for reads: comment-only lines become empty
 * lines (the line numbers they held stay valid) and a uniform leading indent is
 * removed. Deliberately conservative — no code is rewritten, no blank line is
 * dropped, and string literals are never touched because only whole-line comments
 * whose trimmed form starts with a comment marker are removed. Measured on this
 * repo: `main.rs` 13,384 -> 11,788 tok, `index.js` 24,493 -> 20,718 tok.
 */
function compressRead(text) {
  if (!text) return { text, removed: 0, dedented: 0 }
  const lines = text.split('\n')
  let indent = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (!line.trim()) continue
    const lead = line.length - line.trimStart().length
    if (lead < indent) indent = lead
  }
  const strip = Number.isFinite(indent) ? indent : 0
  let removed = 0
  let dedented = 0
  const out = lines.map((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
      || trimmed.startsWith('#') || trimmed === '*/') {
      removed += 1
      return ''
    }
    if (strip > 0 && line.length >= strip) {
      dedented += 1
      return line.slice(strip)
    }
    return line
  })
  return { text: out.join('\n'), removed, dedented }
}

/** 按 compactReads 配置压缩读取结果；未产生任何变化时原样返回，不伪造 compacted 标记。 */
function compactReadValue(value) {
  if (typeof value.content !== 'string' || !value.content) return value
  const result = compressRead(value.content)
  if (!result.text || result.text === value.content) return value
  return { ...value, content: result.text, compacted: true, compactedLines: result.removed }
}

/** 渲染 read：正文 + 页脚（路径、行范围、字节数、sha、完整性、下一个 offset）。 */
function renderRead(value) {  if (typeof value.unchangedForMs === 'number' && value.unchangedForMs > 0) {
    return `[unchanged ${Math.round(value.unchangedForMs / 1000)}s ago · ${relPath(value.path)} · `
      + `${value.totalLines} lines · sha ${shortHash(value.hash)} · refresh:true to reprint]`
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
    ? ` · next offset=${next}`
    : value.truncatedByBytes
      ? ' · cut by bytes: raise limit or lower offset'
      : ''
  const stamp = completeness({ ...value, shownLines: lineCount }, 'shownLines', 'totalLines')
  // "complete" is the default state: saying it costs ~4 tokens on every read and
  // carries no information. Only the exceptional case is printed.
  const flags = `${stamp === 'complete' ? '' : ` · ${stamp}`}${value.compacted ? ' · compacted' : ''}`
  const footer = `[${relPath(value.path)} · ${scope} · ${value.totalBytes} B · sha ${shortHash(value.hash)}${flags}${hint}]`
  return content ? `${trimTail(content)}\n${footer}` : footer
}

/** 渲染 write：写入字节数、路径与新的 sha 前缀。 */
function renderWrite(value) {
  return `wrote ${value.bytes} B → ${relPath(value.path)} · sha ${shortHash(value.hash)}`
}

/** 渲染 edit：替换次数与新的 sha 前缀。 */
function renderEdit(value) {
  return `edited ${relPath(value.path)}: ${value.replacements} replacement(s) · sha ${shortHash(value.hash)}`
}

/** 渲染 stat：三态固定格式——不存在 / 目录 / 文件（大小与 mtime）。 */
function renderStat(value) {
  if (!value.exists) return `${relPath(value.path)}: missing`
  if (value.isDir) return `${relPath(value.path)}: directory · mtime ${new Date(value.mtimeMs).toISOString()}`
  return `${relPath(value.path)}: file · ${value.size} B · mtime ${new Date(value.mtimeMs).toISOString()}`
}

/** 渲染批量 stat：一次调用探多个路径，一行一个，格式与单个 stat 一致。 */
function renderStatMany(value) {
  const entries = Array.isArray(value.entries) ? value.entries : []
  if (entries.length === 0) return '(no paths)'
  return entries.map(renderStat).join('\n')
}

/** 渲染目录列表：目录名带尾斜杠，文件附带字节数；空目录明确写 (empty)。 */
function renderList(value) {
  const entries = Array.isArray(value.entries) ? value.entries : []
  if (entries.length === 0) return `${relPath(value.path)}: (empty)`
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
    lines.push(`${relPath(hit.path)}:${hit.line}${kind} ${hit.text}`)
    if (typeof hit.context === 'string' && hit.context.length > 0) {
      for (const row of hit.context.split('\n')) if (row) lines.push(`  ${row}`)
    }
  }
  const stats = `${value.shown ?? 0}/${value.totalHits ?? 0} hits · ${value.filesMatched ?? 0} files · `
    + `${value.elapsedMs ?? 0} ms${value.cached ? ' · cached' : ''}`
  const stamp = completeness(value, 'shown', 'totalHits')
  lines.push(`— ${stats}${stamp === 'complete' ? '' : ` · ${stamp}`}`)
  return lines.join('\n')
}

/** 渲染符号列表：每行"路径:行号 [kind] 签名"，页脚给匹配数与耗时。 */
function renderSymbols(value) {
  const symbols = Array.isArray(value.symbols) ? value.symbols : []
  const lines = symbols.map((sym) => `${relPath(sym.path)}:${sym.line} [${sym.kind}] ${sym.sig || sym.name}`)
  const stats = `${value.shown ?? 0}/${value.totalMatched ?? 0} symbols · ${value.elapsedMs ?? 0} ms`
  const stamp = completeness(value, 'shown', 'totalMatched')
  lines.push(`— ${stats}${stamp === 'complete' ? '' : ` · ${stamp}`}`)
  return lines.join('\n')
}

/** 渲染会话投影的一页：计数 + 分段耗时 + 游标范围，再逐条列出消息预览。 */
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

/** 统一的"调用在开始前被取消"错误，code 固定 WORKER_ABORTED 供上层识别。 */
function abortError() {
  const error = new Error('rust worker call aborted before it started')
  error.code = 'WORKER_ABORTED'
  return error
}

/** 队列已满的拒绝错误：带 retryAfterMs，提示调用方约 250 ms 后重试。 */
function busyError(detail) {
  const error = new Error(`rust worker pool saturated: ${detail}; retry in ~${QUEUE_RETRY_MS} ms`)
  error.code = 'WORKER_BUSY'
  error.retryAfterMs = QUEUE_RETRY_MS
  return error
}

/** 进程池：按会话分配 worker、限流、空闲回收，并对 RSS/CPU 施加只作用于索引的软限制。 */
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

  /** 构造即开始 5 s 周期巡检（#tick）；定时器 unref，不拖住宿主退出。 */
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

  // 只读视图：size / running / queueDepth / softLimits 供 /metrics 与 rust_health 读取。
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

  /** 只拉起一个 worker，让首次工具调用不必等冷启动。 */
  /** Spawn the first worker eagerly so the first tool call does not pay boot. */
  start() {
    return this.#entry().worker.start()
  }

  /** 杀掉池中全部 worker 并清空会话亲和；dispose 与热配置失败都会走到这里。 */
  kill(reason = 'rust worker pool stopped') {
    for (const entry of this.#entries) entry.worker.kill(reason)
    this.#entries = []
    this.#sessionEntry.clear()
  }

  /** 先停巡检定时器再 kill，保证拆卸过程中不会又拉起新 worker。 */
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
      // 能立刻拿到空闲 lane 就直启，否则进该会话的队列；队列上限与公平性在下面处理。
      if (this.#canStart(sessionId)) this.#start(job)
      else this.#enqueue(job)
    })
  }

  /** Metrics sampling bypasses the scheduler: it must never queue behind user calls. */
  sample() {
    const entry = this.#entries[0] ?? this.#spawnEntry()
    return entry.worker.call('metrics.sample', {}, 4_000)
  }

  /** 主 worker 的健康 + 池快照；池为空时返回 running:false 的等价结构，调用方不必判空。 */
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
    // 先按 RSS 丢索引（可重建），两次之间冷却 60 s，避免在阈值附近反复重建。
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
      // 迟滞 20%：降到软限的 80% 以下才恢复，避免在阈值上下抖动导致反复 pause/resume。
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

  /** 直启条件：本会话未到并发上限，且池里（或可新开）的 worker 还有空闲 lane。 */
  #canStart(sessionId) {
    const inflight = this.#sessionInflight.get(sessionId) ?? 0
    return inflight < this.options.maxInFlightPerSession && this.#pick(sessionId) !== null
  }

  /** 真正发起调用：先占会话与 worker 的 inflight 名额，结束后在 finally 里归还并再排空队列。 */
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

  /** 入队；超过 maxQueueDepth 直接以 WORKER_BUSY 拒绝，abort 时把任务从队列里摘掉。 */
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
    // 单次排空最多轮转 guardLimit 步：防止"永远拿不到 lane"时在这里死循环。
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

  /** 取主 worker；池空时按需新建，保证第一个工具的首次调用不会因池空失败。 */
  #entry() {
    return this.#entries[0] ?? this.#spawnEntry()
  }

  /** 新建 entry 及其背后的 RustWorker（lanes 取自 lanesPerWorker），并计入 spawned 统计。 */
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

  /** 选 worker：优先本会话亲和的那个，其次当前最闲的；仍不够才扩池，否则返回 null。 */
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

  /** 5 s 巡检：按 maxWorkers 收缩，再退休"已标记 / 超期空闲"的 worker（有 inflight 的跳过）。 */
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

  /** 把 entry 移出池并杀掉进程，同时清掉指向它的会话亲和，避免之后又被选中。 */
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

  /** 扁平化的每 worker 信息，/metrics 与 rust_health 的 workers 字段直接使用。 */
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

/** 渲染 rust_health：worker/host 基础信息，再叠加池、软限制、路由与错误。 */
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

/** Always published: the four workhorse tools plus the discovery entry point. */
const RESIDENT_TOOL_NAMES = ['rust_exec', 'rust_read', 'rust_search', 'rust_health', 'native_help']
/** Published only after `native_help` activates them (see §progressive disclosure). */
const DORMANT_TOOL_NAMES = ['rust_write', 'rust_edit', 'rust_stat', 'rust_ls', 'rust_symbols', 'rust_session_open']
/** One-line usage per dormant tool, printed only when it is activated. */
const DORMANT_TOOL_HINTS = {
  rust_write: 'path, content, expectedHash (sha prefix from rust_read, or "absent" to require a new file)',
  rust_edit: 'path, oldString, newString, replaceAll',
  rust_stat: 'path → exists/isDir/size/mtime',
  rust_ls: 'path, limit → entry names, dirs, sizes',
  rust_symbols: 'path or query, kind, limit → signatures only, no bodies',
  rust_session_open: 'path to a session.v4.jsonl.zstd log, cursor, limit',
}

/**
 * 构造全部工具定义（4 个常驻 + native_help + 6 个按需）。每个 execute 都按
 * pool.call(method, params, timeout, exec.signal, exec.agent.id) 转发；只有 abort
 * 被转成返回值，worker 报错照常抛给 harness，由它记入工具结果。
 */
function createToolDefinitions(pool, config, store, runtime = {}) {
  /** Deadline for an fs request: the configured default. */
  const fsTimeout = () => config.defaultTimeoutMs

  return [
    {
      // 常驻工具：在持久热 shell 里跑 PowerShell；超时与取消由宿主侧兜底。
      name: 'rust_exec',
      description:
        'Run a PowerShell command in a persistent warm shell (fast; prefer this over pwsh). Returns '
        + 'stdout and exitCode. cwd persists across calls; raise timeoutMs for long commands. exitCode '
        + 'can be stale when the command ran no native executable — trust stdout for those.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'PowerShell command line.' },
          cwd: { type: 'string', description: 'Directory to enter (persists).' },
          timeoutMs: { type: 'number', description: 'Kill after this many ms.' },
          queueTimeoutMs: { type: 'number', description: 'Max wait for a lane (default 30000).' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderExec(value)),
      },
      // 宿主侧超时多留 SHELL_TIMEOUT_GRACE_MS：让 worker 自己的超时先触发，
      // 宿主只在 worker 真的不回应时判死，避免误杀正常的长命令。
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
      // 常驻工具：带观察缓存与可选压缩的 UTF-8 读取，页脚 sha 作为写版本守卫。
      name: 'rust_read',
      description:
        'Read a UTF-8 file through the Rust worker and return its content plus the sha256 prefix used '
        + 'as expectedHash by rust_write. offset is a 1-based first line, limit caps returned lines, and '
        + 'the footer carries the next offset. An identical re-read of an unchanged file returns '
        + '[unchanged] instead of the body; pass refresh: true to force it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to read.' },
          offset: { type: 'number', description: '1-based first line (default 1).' },
          limit: { type: 'number', description: 'Max lines.' },
          refresh: { type: 'boolean', description: 'Reprint even if unchanged.' },
          compact: { type: 'boolean', description: 'Strip comment-only lines (kept as blank lines, so line numbers stay valid) and remove the common indent; ~-12% tokens.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(renderRead(value)),
      },
      async execute(args, exec) {
        const params = { path: args.path, hash: 'prefix' }
        if (args.offset !== undefined) params.offset = args.offset
        if (args.limit !== undefined) params.limit = args.limit
        const raw = await pool.call('fs.read', params, fsTimeout(), exec?.signal, exec?.agent?.id ?? 'default')
        const value = (args.compact === true || (args.compact !== false && config.compactReads))
          ? compactReadValue(raw)
          : raw
        // refresh:true 无条件重印但仍刷新缓存；否则命中且 sha 相同就只回 [unchanged] 提示。
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
      // 按需工具：写文件；expectedHash 提供乐观并发（"absent" 要求文件尚不存在）。
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
      // 版本守卫在 worker 侧：expectedHash 不匹配时不落盘，直接以错误返回。
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
      // 按需工具：字面量替换；oldString 有歧义时失败，replaceAll 才允许全替换。
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
      // 按需工具：路径存在性 / 类型 / 大小 / mtime；不存在时返回 exists:false 而非报错。
      name: 'rust_stat',
      description:
        'Stat a path through the Rust worker: existence, file-vs-directory, size, and mtime. A '
        + 'missing path reports exists:false instead of failing, so it also answers "does this exist?" '
        + 'Pass paths[] to probe up to 256 paths in one round-trip.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to stat.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Batch form: up to 256 paths, one RPC.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(Array.isArray(value.entries) ? renderStatMany(value) : renderStat(value)),
      },
      async execute(args, exec) {
        const params = Array.isArray(args.paths) ? { paths: args.paths } : { path: args.path }
        return pool.call('fs.stat', params, fsTimeout(), exec?.signal, exec?.agent?.id ?? 'default')
      },
      isConcurrencySafe() {
        return true
      },
    },
    {
      // 按需工具：单目录列举，目录名带尾斜杠，limit 限制条目数。
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
      // 常驻工具：查持久代码索引，定义行优先，输出受 maxBytes 预算约束。
      name: 'rust_search',
      description:
        'Search the persistent code index: definition lines rank first, output is budgeted by maxBytes, '
        + 'and the footer states what was truncated. Prefer this over grep for "where is X". glob '
        + 'filters paths ("*.ts"), symbolsOnly keeps definition lines, regex treats query as a pattern.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal text (a regex when regex=true).' },
          glob: { type: 'string', description: 'Path filter, e.g. "*.ts" or "src/**/*.rs".' },
          regex: { type: 'boolean', description: 'Query is a regular expression.' },
          symbolsOnly: { type: 'boolean', description: 'Definition lines only.' },
          contextLines: { type: 'number', description: 'Context lines around a hit (0–2, default 1).' },
          maxHits: { type: 'number', description: 'Default 24.' },
          maxBytes: { type: 'number', description: 'Output byte budget (default 6000).' },
          refresh: { type: 'boolean', description: 'Re-scan before searching.' },
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
      // 按需工具：只列签名不列正文，用于"看结构"而不是"读全文"。
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
      // 按需工具：只读投影会话日志，用 cursor + limit 分页，永不写回日志。
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
      // 常驻工具：worker/池/路由/度量状态；就绪前也返回结构化状态而不是报错。
      name: 'rust_health',
      description:
        'Worker health: pid, uptime, restarts, heartbeat gaps, last exit code, active tools. Use when a '
        + 'rust_* call wedges, times out, or restarts.',
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
        // Readiness first: a deferred start means the worker may not exist yet, and
        // health must still answer (the monitor shows "starting…" instead of an error).
        if (runtime.readiness && runtime.readiness.phase !== 'ready') {
          return {
            schema: 'dsh-rust-exec/health@1',
            running: false,
            phase: runtime.readiness.phase,
            readiness: runtime.readiness,
            routes: runtime.routes ?? null,
            tools: runtime.activeTools ? runtime.activeTools() : null,
            metrics: null,
          }
        }
        const health = await pool.health()
        const metrics = store?.snapshot()
        return {
          ...health,
          phase: runtime.readiness?.phase ?? 'ready',
          readiness: runtime.readiness ?? null,
          routes: runtime.routes ?? null,
          tools: runtime.activeTools ? runtime.activeTools() : null,
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
    {
      // 常驻工具：渐进披露的入口，按需激活休眠工具并返回一行用法提示。
      name: 'native_help',
      description:
        'Enable more rust_* tools for this session: write, edit, stat, ls, symbols, session_open. '
        + 'Pass tools:["write"] to activate one; omit tools to list them.',
      parameters: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            description: 'Names to activate, or ["all"].',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textOf(value.text),
      },
      async execute(args) {
        const requested = Array.isArray(args?.tools) ? args.tools.map((t) => String(t).trim()) : []
        const activated = runtime.activate?.(requested) ?? []
        const lines = [
          `active: ${(runtime.activeTools?.() ?? []).join(', ')}`,
          `activatable: ${DORMANT_TOOL_NAMES.join(', ')}`,
        ]
        if (activated.length > 0) lines.unshift(`activated: ${activated.join(', ')}`)
        for (const name of activated) {
          const hint = DORMANT_TOOL_HINTS[name]
          if (hint) lines.push(`${name} — ${hint}`)
        }
        return { text: lines.join('\n'), activated }
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

/** 探测宿主能力（注册工具 / webServer / logger / events / AbortSignal）；缺哪项就降级。 */
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

/** 把 worker 的嵌套采样压成扁平点（内存/CPU/IO/队列/索引），缺字段按 0 处理。 */
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

/** 把一次采样折进 lifetime 极值桶：每个字段维护 min/max/last，非数值直接跳过。 */
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

/** 度量仓库：1 s 采样进 fast 环（300 点 ≈ 5 分钟），每 60 s 折一个 slow 桶（60 桶 ≈ 1 小时）。 */
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
    // Started/ready state owned by apply(); the monitor renders placeholders until
    // it flips to 'ready' instead of showing a panel full of dashes.
    this.readiness = null
    // Returns false while startup is deferred so the tick cannot spawn the worker.
    this.gate = null
    // Per-worker rings, keyed by worker id: the monitor draws one set of charts per
    // worker, and a flat ring cannot attribute a sample to a worker when N > 1.
    this.workerHistory = new Map()
  }

  /** 启动采样定时器（幂等）；unref 保证空闲宿主不会被它拖住。 */
  start() {
    if (this.#timer) return
    this.#bucketStart = Date.now()
    this.#timer = setInterval(() => { void this.#tick() }, this.settings.metricsIntervalMs)
    this.#timer.unref?.()
  }

  /** 停采样并清空定时器句柄，重复调用安全。 */
  stop() {
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  /** 热改采样周期：有定时器就先停再按新周期重启，立即生效。 */
  setIntervalMs(intervalMs) {
    this.settings.metricsIntervalMs = intervalMs
    if (this.#timer) {
      this.stop()
      this.start()
    }
  }

  /** 一次采样：gate 关闭时只探一次启动，不 spawn；采样后立即施加软限制再入环。 */
  async #tick() {
    // Async startup: sampling a worker that has not been started yet would spawn it
    // on the metrics timer, which is exactly what deferred start avoids. A worker that
    // some other path already started (a tool call runs `pool.call`, and that awaits
    // `start()`) is adopted instead of ignored, so readiness cannot stay `pending`
    // while a live worker serves calls.
    if (this.gate && !this.gate()) {
      this.onDemand?.()
      return
    }
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

  /** 把一条采样写进各级结构：极值桶、fast 环、单 worker 环与 slow 桶。 */
  #push(raw) {
    const now = Date.now()
    const point = { t: now, ...pickSample(raw), pool: this.pool.info() }
    this.samples += 1
    noteExtremes(this.extremes, point)
    // `point` is already the picked projection — keep no `raw` key: an explicit
    // `raw: undefined` survives into the in-memory snapshot and makes the health
    // tool fail DSH's lossless-JSON check even though JSON.stringify drops it.
    this.last = { ...point }
    this.fast.push(point)
    while (this.fast.length > METRICS_FAST_POINTS) this.fast.shift()
    const detail = point.pool?.workersDetail ?? []
    if (detail.length === 1) {
      const key = String(detail[0].id ?? 0)
      const ring = this.workerHistory.get(key) ?? []
      ring.push(point)
      while (ring.length > METRICS_FAST_POINTS) ring.shift()
      this.workerHistory.set(key, ring)
    }
    this.#bucket.push(point)
    if (now - this.#bucketStart >= METRICS_SLOW_BUCKET_MS) {
      this.slow.push(this.#foldBucket())
      while (this.slow.length > METRICS_SLOW_BUCKETS) this.slow.shift()
      this.#bucket = []
      this.#bucketStart = now
    }
  }

  /** 把当前桶内的点折成一条 slow 记录（均值 / 峰值），桶满 60 s 时调用。 */
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

  /** /metrics 的完整响应：配置、历史、极值、池状态、每 worker 明细与缓存计数。 */
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
      workers: this.#workersPayload(),
      cache: this.#cachePayload(),
      readiness: this.readiness ?? null,
      config: {
        lanes: this.pool.lanesPerWorker,
        maxQueueDepth: this.pool.options.maxQueueDepth,
        defaultTimeoutMs: this.settings.defaultTimeoutMs,
      },
    }
  }

  /**
   * One entry per live worker, so the monitor can draw N cards without inventing
   * data: `workersDetail` already carries per-worker identity, and the flat `last`
   * sample is only attributable to a worker when exactly one is running.
   */
  #workersPayload() {
    const detail = this.pool.info().workersDetail ?? []
    const last = this.last ?? null
    const single = detail.length === 1
    const queueDepth = last?.pool?.queueDepth ?? null
    return detail.map((worker) => ({
      ...worker,
      queued: worker.id === 0 ? queueDepth : null,
      cpuPctOneCore: single ? last?.cpuPctOneCore ?? null : null,
      workingSetBytes: single ? last?.workingSetBytes ?? null : null,
      privateBytes: single ? last?.privateBytes ?? null : null,
      uptimeMs: null,
      restarts: null,
      // Chart series for this worker; empty when the host never had exactly one
      // running worker, in which case the monitor falls back to the global ring.
      history: this.workerHistory.get(String(worker.id)) ?? [],
    }))
  }

  /** Observation-cache counters plus the last sampled index size. The exact
   *  index detail (buildMs, root, reused/parsed) comes from `/cache`, which asks
   *  the worker directly instead of waiting for the next metrics tick. */
  #cachePayload() {
    const last = this.last ?? null
    return {
      read: readCacheSnapshot(),
      index: {
        files: last?.indexFiles ?? null,
        symbols: last?.indexSymbols ?? null,
        buildMs: null,
        roots: null,
        ttlMs: null,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP routes: JSON only, registered on the optional webServer service
// ---------------------------------------------------------------------------

/** 读并解析 JSON 请求体；超过 limit（默认 64 KB）直接拒绝并销毁连接。 */
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
/** 会话日志文件名与 id 的形状约束：id 只允许字母数字与 ._-，从根上杜绝路径穿越。 */
const SESSION_LOG_RE = /^session\.v\d+\.jsonl\.zstd$/
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** 会话日志根目录：优先 DSH_HOME，其次 DSH_PROFILE_DIR 上两级，最后回落 ~/.dsh。 */
function sessionsRoot() {
  // The host process does not always inherit DSH_HOME (tool children do), so fall
  // back to the documented profile layout and finally to `~/.dsh`.
  const env = process.env
  if (env.DSH_HOME) return join(env.DSH_HOME, 'sessions')
  if (env.DSH_PROFILE_DIR) return join(resolve(env.DSH_PROFILE_DIR, '..', '..'), 'sessions')
  return join(homedir(), '.dsh', 'sessions')
}

/** 宽松解析并夹到 [min, max]；解析不出来时用 fallback，保证路由参数永远合法。 */
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

/**
 * 挂载只返回 JSON 的 HTTP 路由。webServer 是可选服务，启动早期可能还不存在，所以
 * 挂载按退避重试（0/100/250/500/1000/2000 ms，之后每 15 s 一次，永不放弃），
 * 每次结果都记进 routeState 供 rust_health 读取。返回卸载函数供 ctx.effect 调用。
 */
function installRoutes(ctx, { store, pool, settings, log, state }) {
  const routeState = state.routes
  // 统一响应：JSON + no-store，避免面板轮询命中缓存拿到旧采样。
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
      // Cache view: observation-cache counters from the already-sampled store plus
      // a live `index.status` from the worker. Deliberately not on the metrics
      // tick — this route is polled by the monitor dialog only while it is open.
      path: `${METRICS_ROUTE_PREFIX}/cache`,
      handler: async (_req, res) => {
        try {
          const snapshot = store.snapshot()
          let index = null
          try {
            index = await pool.call('index.status', {}, 5_000, undefined, 'http')
          } catch (error) {
            index = null
          }
          send(res, 200, {
            schema: 'dsh-rust-exec/cache@1',
            read: snapshot.cache?.read ?? null,
            index: index
              ? {
                files: index.files ?? null,
                symbols: index.symbols ?? null,
                buildMs: index.buildMs ?? null,
                reusedFiles: index.reusedFiles ?? null,
                parsedFiles: index.parsedFiles ?? null,
                ageMs: index.ageMs ?? null,
                ttlMs: index.ttlMs ?? null,
                root: index.root ?? null,
                cachePath: index.cachePath ?? null,
                paused: index.paused ?? null,
                roots: index.root ? 1 : null,
              }
              : snapshot.cache?.index ?? null,
          })
        } catch (error) {
          send(res, 500, { error: error?.message ?? String(error) })
        }
      },
    },
    {
      path: `${METRICS_ROUTE_PREFIX}/health`,
      handler: async (_req, res) => {
        const readiness = state.readiness ?? null
        // Probing /health counts as a demand signal: a page refresh right after DSH
        // opens should not have to wait out the start delay.
        if (readiness && readiness.phase === 'pending') state.ensureStarted?.()
        if (readiness && readiness.phase !== 'ready') {
          send(res, 200, {
            schema: 'dsh-rust-exec/pool-health@1',
            running: false,
            worker: null,
            phase: readiness.phase,
            readiness,
            routes: routeState,
          })
          return
        }
        try {
          send(res, 200, {
            ...(await pool.health()),
            phase: readiness?.phase ?? 'ready',
            readiness,
            routes: routeState,
          })
        } catch (error) {
          send(res, 500, { error: error?.message ?? String(error), readiness })
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
            // 单次最多 40 条消息体，maxChars 上限 400 000：防止一次请求拉回整段日志。
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

/**
 * 插件入口：归一化配置 → 建池与度量 → 注册工具 → 挂路由 → 通过 ctx.effect 归还清理。
 * 默认异步启动（deferStart）：先让 DSH 完成首屏，再延迟 1.2 s 拉起 worker；
 * 任何服务缺失都只降级并记日志，不向宿主抛异常。
 */
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
  logEvent('plugin.mounted', {
    version: PLUGIN_VERSION,
    workerSource: settings.workerPath,
    cwd: WORKER_CWD,
    lanes: settings.lanes,
    deferStart: settings.deferStart,
    logPath: workerLogPath(),
  })
  // Async startup: DSH paints first, the worker follows. Nothing below blocks the
  // plugin mount, and the metrics tick stays quiet until the worker answers so the
  // sampler cannot spawn it ahead of the schedule.
  // 状态机：pending → starting → ready|failed，只前进不回退；面板与 /health 读同一对象。
  runtime.readiness = {
    phase: 'pending',
    since: Date.now(),
    startedAt: null,
    readyAt: null,
    readyMs: null,
    deferred: settings.deferStart,
    startDelayMs: settings.startDelayMs,
    prewarmIndex: settings.prewarmIndex,
    workerPid: null,
    indexPrewarm: 'idle',
    error: null,
  }
  let warmPromise = null
  /** Build the index once, after the worker is up, instead of at spawn time. */
  /** 只建一次索引：后续调用复用同一 promise；600 s 是冷索引的上限，失败不算插件失败。 */
  const warmIndex = () => {
    if (!settings.prewarmIndex) return Promise.resolve(null)
    if (warmPromise) return warmPromise
    runtime.readiness.indexPrewarm = 'running'
    warmPromise = pool.call('index.status', { refresh: true }, 600_000, undefined, 'http')
      .then((status) => {
        runtime.readiness.indexPrewarm = 'done'
        runtime.readiness.index = {
          files: status?.files ?? null,
          symbols: status?.symbols ?? null,
          buildMs: status?.buildMs ?? null,
        }
        log.info('index.warmed', runtime.readiness.index)
        return status
      })
      .catch((error) => {
        runtime.readiness.indexPrewarm = 'failed'
        log.warn('index.warm-failed', { error: error?.message })
        return null
      })
    return warmPromise
  }
  // 启动入口同样幂等：定时器、/health 探测与首次工具调用可能同时触发。
  runtime.ensureStarted = () => {
    if (runtime.startPromise) return runtime.startPromise
    runtime.readiness.phase = 'starting'
    runtime.readiness.startedAt = Date.now()
    // The pid only exists once the child process is up, which is after `start()` resolves
    // in some hosts and after its first handshake in others; probe twice, cheaply.
    const adoptPid = () => {
      const pid = pool.info()?.workersDetail?.[0]?.pid ?? null
      if (pid) runtime.readiness.workerPid = pid
      return pid
    }
    runtime.startPromise = pool.start()
      .then(() => {
        adoptPid()
        runtime.readiness.phase = 'ready'
        runtime.readiness.readyAt = Date.now()
        runtime.readiness.readyMs = runtime.readiness.readyAt - runtime.readiness.since
        if (!runtime.readiness.workerPid) {
          const pidTimer = setTimeout(adoptPid, 800)
          pidTimer.unref?.()
        }
        log.info('pool.ready', { ms: runtime.readiness.readyMs, pid: runtime.readiness.workerPid })
        void warmIndex()
        return pool.info()
      })
      .catch((error) => {
        runtime.readiness.phase = 'failed'
        runtime.readiness.error = error?.message ?? String(error)
        log.warn('pool.prewarm-failed', { error: runtime.readiness.error })
        return null
      })
    return runtime.startPromise
  }
  store.gate = () => runtime.readiness.phase === 'ready'
  // When a tool call starts the worker before the deferred timer fires, this closes the loop:
  // the next metrics tick asks for the real start state and flips readiness to `ready`.
  store.onDemand = () => { void runtime.ensureStarted() }
  // `/metrics` renders the same readiness object the panel polls through `/health`, so the
  // two views can never disagree about whether the worker is up.
  store.readiness = runtime.readiness
  // 延迟启动：定时器 unref，并登记到 ctx.effect，插件先卸载时不会留下孤儿定时器。
  if (settings.deferStart) {
    const startTimer = setTimeout(() => { void runtime.ensureStarted() }, settings.startDelayMs)
    startTimer.unref?.()
    ctx.effect(() => () => { clearTimeout(startTimer) }, 'rust-exec start timer')
  } else {
    void runtime.ensureStarted()
  }

  ctx.effect(() => {
    if (!host.capabilities.toolsRegister) {
      log.error('tools.unavailable', { reason: 'ctx.tools.register is missing; no tools registered' })
      return () => {}
    }
    // 每次 effect 重建定义数组；旧 disposer 由本 effect 返回的清理函数统一撤销。
    const all = createToolDefinitions(pool, settings, store, runtime)
    const byName = new Map(all.map((definition) => [definition.name, definition]))
    const disposers = new Map()
    const registerTool = (name) => {
      if (disposers.has(name)) return
      const definition = byName.get(name)
      if (!definition) return
      try {
        disposers.set(name, ctx.tools.register(definition))
      } catch (error) {
        log.warn('tools.register-failed', { name, error: error?.message })
      }
    }
    // Progressive disclosure: four workhorse tools plus native_help cost ~500 tokens
    // per request; publishing all ten costs 1,812. The dormant six are registered on
    // the first native_help call that names them and stay for the session.
    const resident = settings.progressiveDisclosure ? RESIDENT_TOOL_NAMES : all.map((item) => item.name)
    for (const name of resident) registerTool(name)
    // 激活名容错：接受 "write" 与 "rust_write" 两种写法；未知名字静默忽略。
    runtime.activate = (requested) => {
      const wanted = requested.includes('all') ? DORMANT_TOOL_NAMES : requested
        .map((raw) => (String(raw).startsWith('rust_') ? String(raw) : `rust_${raw}`))
      const activated = []
      for (const name of wanted) {
        if (!DORMANT_TOOL_NAMES.includes(name) || disposers.has(name)) continue
        registerTool(name)
        if (disposers.has(name)) activated.push(name)
      }
      if (activated.length > 0) log.info('tools.activated', { tools: activated })
      return activated
    }
    runtime.activeTools = () => [...disposers.keys()]
    log.info('tools.registered', { count: disposers.size, progressiveDisclosure: settings.progressiveDisclosure })
    return () => {
      for (const dispose of [...disposers.values()].reverse()) dispose()
      disposers.clear()
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

  // 最后注册、最先清理：先停采样再杀池，避免拆卸过程中又产生一次采样。
  ctx.effect(() => () => {
    store.stop()
    pool.dispose()
  }, 'rust-exec worker pool')
}
