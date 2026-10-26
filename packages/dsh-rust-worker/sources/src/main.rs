//! dsh-rust-worker — persistent business-execution worker for DSH.
//!
//! Transport: LSP-style framing on stdin/stdout (`Content-Length: N\r\n\r\n<N bytes>`),
//! payload is JSON-RPC 2.0. One request per frame; responses may be out of order.
//!
//! Why a long-lived process: DSH's Windows shell tool pays a full `powershell.exe`
//! cold start (measured 3.3–4.9 s on this host) for every call. This worker keeps one
//! PowerShell REPL alive behind a loopback socket and forwards each command to it, so
//! the per-call cost collapses to the command itself instead of process creation.
//!
//! Why a loopback socket and not stdin: PowerShell 5.1 with a redirected stdin does not
//! execute or stream commands until EOF (measured: five invocation variants, zero bytes
//! of output, process stays alive). A TCP command server keeps a real runspace alive and
//! gives deterministic framing, exit codes, and no terminal echo/ANSI to strip.
//!
//! Methods: initialize, caps, ping, fs.read, fs.write, fs.edit, fs.stat, fs.list, exec,
//! exec.abort, exec.stats, metrics.sample, search.text, search.symbol, index.status,
//! worker.health, shutdown.
//!
//! Concurrency: `exec` runs on a pool of independent shells ("lanes"), one per call,
//! so several tool calls can be in flight at once without serializing on one REPL.
//! The pool size comes from `DSH_RUST_LANES` (default: up to 4) and a gate bounds the
//! queue depth so a burst cannot exhaust memory.

// 模块职责（中文说明）：本文件是 dsh-rust-worker 的主程序，一个常驻的“业务执行 worker”。
// 它在 stdin/stdout 上用 LSP 风格的 `Content-Length: N` 帧承载 JSON-RPC 2.0，把请求分发到
// fs.*、exec*、search.*、index.*、session.*、metrics.sample 等方法；exec 由一组独立的
// PowerShell lane 承载，fs.write/fs.edit 带写前版本守卫。
//
// 必须保持的不变量：
// 1. 帧读取按头部声明的字节数精确读取；fs.read 单次返回内容受 DEFAULT_MAX_READ_BYTES 限制。
// 2. 每次 exec 调用独占一条 lane（同一条 lane 同一时刻只跑一条命令），不共享可变 shell 状态。
// 3. exec 的 stdout 返回量受 DEFAULT_EXEC_MAX_BYTES 限制，超出部分截断并如实报告字节数。
// 4. lane 懒启动：首次真正用到时才 spawn PowerShell；`DSH_RUST_PREWARM=0` 时连启动预热也跳过。
// 5. 失败一律以 JSON-RPC 错误码返回（-32700 解析、-32001 协议、-32000 业务），不 panic。

mod index;
mod metrics;
mod session;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

// 协议版本：hello 时与主机侧比对，不一致时写错误帧并以退出码 2 结束进程。
const PROTOCOL_VERSION: u64 = 1;
// fs.read 单次返回内容的字节上限（1 MiB）：只截断返回内容，整文件读取与哈希不受影响。
const DEFAULT_MAX_READ_BYTES: usize = 1 << 20; // 1 MiB
/// Cap on `exec` stdout. A bare `cat` of a large file otherwise floods the model's
/// context in one call; the payload says how much was cut so the model can narrow.
const DEFAULT_EXEC_MAX_BYTES: usize = 24_000;
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 300_000;
const SHELL_BOOT_TIMEOUT: Duration = Duration::from_secs(45);

static NONCE: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------------------
// lifecycle: handshake, beacon, host watchdog, single-instance lock
// ---------------------------------------------------------------------------

/// Free-standing beacon period. Matches the host side so both directions are
/// symmetric; a beacon is only sent while no request is in flight (a busy
/// worker already proves liveness by answering).
const BEACON_MS: u64 = 2_000;
/// How long the worker tolerates host silence before declaring the host dead.
/// Deliberately much wider than the beacon: a frozen host (GC pause, debugger,
/// laptop suspend) must never kill a healthy worker. The authoritative detector
/// is the pid watch below, which notices a *dead* host within one second; the
/// silence threshold only catches "alive but wedged".
const HOST_SILENCE_MS: u64 = 45_000;
/// A monotonic jump this large means the machine slept/resumed. Re-arm instead
/// of judging the gap as silence.
const MONO_JUMP_MS: u64 = HOST_SILENCE_MS * 4;

static INFLIGHT: AtomicU64 = AtomicU64::new(0);
static HOST_PID: AtomicU64 = AtomicU64::new(0);
static LAST_HOST_SEEN_MS: AtomicU64 = AtomicU64::new(0);
static START: OnceLock<Instant> = OnceLock::new();
static LIFECYCLE_STARTED: AtomicBool = AtomicBool::new(false);
static LOCK_PATH: OnceLock<PathBuf> = OnceLock::new();

// 用途：进程内单调时钟毫秒数。所有超时/空闲判断都用它，不受系统时间被调整的影响。
fn mono_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

// 用途：worker 已运行的毫秒数，仅用于心跳和 health 上报。
fn uptime_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

// 用途：当前在途请求数。心跳只在为 0 时发送；watchdog 判 host 静默时也要求它为 0。
fn inflight() -> u64 {
    INFLIGHT.load(Ordering::Relaxed)
}

#[allow(non_snake_case)]
mod win {
    extern "system" {
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32)
        -> *mut core::ffi::c_void;
        fn WaitForSingleObject(hHandle: *mut core::ffi::c_void, dwMilliseconds: u32) -> u32;
        fn CloseHandle(hObject: *mut core::ffi::c_void) -> i32;
    }
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_TIMEOUT: u32 = 258;
    const PROCESS_TERMINATE: u32 = 0x0001;

    extern "system" {
        fn TerminateProcess(hProcess: *mut core::ffi::c_void, uExitCode: u32) -> i32;
    }

    // 用途：按 pid 强杀进程（TerminateProcess）。返回是否杀成功；pid 为 0 直接返回 false。
    // 约束：只用于取消 exec；进程被杀后该 lane 的 shell 视为失效，下次调用会重建。
    /// Force-terminate a pid. Used by `exec.abort`: the lane's PowerShell is
    /// blocked inside the command, so the only reliable cancel is process death.
    pub fn terminate_process(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if handle.is_null() {
                return false;
            }
            let ok = TerminateProcess(handle, 1) != 0;
            CloseHandle(handle);
            ok
        }
    }

    // 用途：判断 pid 是否仍存活。打开句柄失败视为已死（pid 为 0 视为存活，避免误杀未初始化状态）。
    // 依据：WaitForSingleObject 超时（WAIT_TIMEOUT）说明进程尚未 signal，即仍在运行。
    /// True when `pid` exists and is still running (signalled wait => dead).
    pub fn process_alive(pid: u32) -> bool {
        if pid == 0 {
            return true;
        }
        unsafe {
            let handle = OpenProcess(SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return false;
            }
            let status = WaitForSingleObject(handle, 0);
            CloseHandle(handle);
            status == WAIT_TIMEOUT
        }
    }
}

// 用途：解析 DSH 主目录：DSH_HOME 优先，否则用 %USERPROFILE%\.dsh。
// 返回：用于存放 run/ 下的锁文件等诊断数据；两个环境变量都缺失时返回空路径。
fn dsh_home() -> PathBuf {
    if let Some(dir) = std::env::var_os("DSH_HOME") {
        return PathBuf::from(dir);
    }
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".dsh")
}

// 用途：写单实例锁文件 <dsh_home>/run/dsh-rust-worker-<profile>.lock，内容为 pid 与实例名。
// 参数：instance 来自 hello 的 hostInstance；返回锁文件路径，供退出时清理。
// 约束：这不是硬互斥——崩溃的前任实例不能阻塞启动，真正的存活判定在 host 侧完成。
fn claim_lock(instance: &str) -> Option<PathBuf> {
    let profile = std::env::var("DSH_PROFILE").unwrap_or_else(|_| "default".to_string());
    let path = dsh_home().join("run").join(format!("dsh-rust-worker-{profile}.lock"));
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // Overwriting is intentional: a crashed predecessor must not block startup,
    // and the host already reaps stale instances during handshake. The file is
    // diagnostic (pid + instance) rather than a hard mutex.
    let _ = fs::write(&path, format!("{}\n{instance}\n", std::process::id()));
    Some(path)
}

// 用途：删除本进程的锁文件；shutdown、host 消失、正常 EOF 退出时都会调用。
fn release_lock() {
    if let Some(path) = LOCK_PATH.get() {
        let _ = fs::remove_file(path);
    }
}

// 用途：处理 hello 握手：校验协议版本、记录 hostPid/hostInstance、抢占锁文件并启动心跳线程。
// 返回：worker 协议版本、pid、版本号、能力列表与锁文件路径。
// 约束：协议版本不一致时直接写错误帧并 exit(2)，因为后续帧的语义无法保证。
fn hello(params: &Value, out: &Arc<Mutex<io::Stdout>>) -> Result<Value, String> {
    let protocol = params.get("protocol").and_then(|v| v.as_u64()).unwrap_or(0);
    if protocol != PROTOCOL_VERSION {
        write_frame(
            out,
            &json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": {
                    "code": -32001,
                    "message": format!("protocol mismatch: worker={PROTOCOL_VERSION} host={protocol}"),
                },
            }),
        );
        std::process::exit(2);
    }
    let host_pid = params.get("hostPid").and_then(|v| v.as_u64()).unwrap_or(0);
    let instance = params
        .get("hostInstance")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    HOST_PID.store(host_pid, Ordering::SeqCst);
    LAST_HOST_SEEN_MS.store(mono_ms(), Ordering::SeqCst);
    if let Some(path) = claim_lock(&instance) {
        let _ = LOCK_PATH.set(path);
    }
    start_lifecycle(Arc::clone(out));
    Ok(json!({
        "protocol": PROTOCOL_VERSION,
        "workerPid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
        "caps": [
            "fs.read", "fs.write", "fs.edit", "fs.stat", "fs.list", "exec",
            "search.text", "search.symbol", "index.status", "worker.health",
        ],
        "hostPid": host_pid,
        "lockFile": LOCK_PATH.get().map(|p| p.to_string_lossy().to_string()),
        "indexGen": 0,
    }))
}

// 用途：启动两个后台线程——周期性 worker.hb 心跳，以及每秒一次的 host 存活/watchdog 检查。
// 约束：只允许启动一次（LIFECYCLE_STARTED 用 swap 做比较并设置），重复调用直接返回。
/// Start the beacon and the host watchdog exactly once (first `hello` wins).
///
/// Both run on their own threads so a long `exec` (up to 120 s) or an index
/// build can never delay a heartbeat and self-trigger a false death.
fn start_lifecycle(out: Arc<Mutex<io::Stdout>>) {
    if LIFECYCLE_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let beat_out = Arc::clone(&out);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(BEACON_MS));
        if inflight() != 0 {
            continue;
        }
        write_frame(
            &beat_out,
            &json!({
                "jsonrpc": "2.0",
                "method": "worker.hb",
                "params": { "pid": std::process::id(), "uptimeMs": uptime_ms(), "inflight": 0 },
            }),
        );
    });
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(1_000));
        let host = HOST_PID.load(Ordering::Relaxed);
        if host == 0 {
            continue;
        }
        if !win::process_alive(host as u32) {
            eprintln!("[dsh-rust-worker] host pid {host} is gone; exiting (3)");
            release_lock();
            std::process::exit(3);
        }
        let now = mono_ms();
        let last = LAST_HOST_SEEN_MS.load(Ordering::Relaxed);
        if now > last.saturating_add(MONO_JUMP_MS) {
            // Machine slept or the host was suspended: re-arm, never judge.
            LAST_HOST_SEEN_MS.store(now, Ordering::Relaxed);
            continue;
        }
        if now > last.saturating_add(HOST_SILENCE_MS) && inflight() == 0 {
            eprintln!("[dsh-rust-worker] host silent for {} ms; exiting (3)", now - last);
            release_lock();
            std::process::exit(3);
        }
    });
}

// 用途：汇总 worker.health 的返回体：pid、运行时长、host 存活与静默时长、inflight、shell 描述。
fn health() -> Value {
    let host = HOST_PID.load(Ordering::Relaxed) as u32;
    json!({
        "pid": std::process::id(),
        "uptimeMs": uptime_ms(),
        "hostPid": host,
        "hostAlive": win::process_alive(host),
        "lastHostSeenMsAgo": mono_ms().saturating_sub(LAST_HOST_SEEN_MS.load(Ordering::Relaxed)),
        "inflight": inflight(),
        "shell": Shell::describe(),
        "lockFile": LOCK_PATH.get().map(|p| p.to_string_lossy().to_string()),
    })
}

// 用途：发给 PowerShell 的常驻服务端脚本：先打印 `PORT=<n>`，之后每个连接处理一行 JSON 请求。
// 约束：单个 runspace 顺序处理，$global: 状态与当前目录在多次 exec 之间保留；
// 响应以 ConvertTo-Json -Compress 写成单行，Rust 侧读到连接关闭即视为响应结束。
/// PowerShell command server. Opens a loopback listener on an ephemeral port, prints
/// `PORT=<n>`, then serves one JSON request per connection on the same runspace so
/// `$global:` state and the current location persist between calls.
const SHELL_SERVER: &str = r#"
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
[Console]::Out.WriteLine("PORT=$port")
[Console]::Out.Flush()
while ($true) {
  $client = $listener.AcceptTcpClient()
  $stream = $client.GetStream()
  $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
  $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
  $writer.AutoFlush = $true
  try {
    $line = $reader.ReadLine()
    if ([string]::IsNullOrEmpty($line)) { continue }
    $req = $line | ConvertFrom-Json
    if ($req.cwd) { Set-Location -LiteralPath $req.cwd }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $out = & { Invoke-Expression $req.command } 2>&1 | Out-String
    $ok = $?
    $ec = $LASTEXITCODE
    if ($null -eq $ec) { if ($ok) { $ec = 0 } else { $ec = 1 } }
    $sw.Stop()
    $resp = @{ ok = $true; stdout = $out; exitCode = [int]$ec; ms = [long]$sw.ElapsedMilliseconds } | ConvertTo-Json -Compress -Depth 4
    $writer.WriteLine($resp)
  } catch {
    $err = @{ ok = $false; error = "$($_.Exception.Message)"; stdout = ''; exitCode = 1; ms = 0 } | ConvertTo-Json -Compress -Depth 4
    try { $writer.WriteLine($err) } catch {}
  } finally {
    try { $writer.Flush() } catch {}
    try { $client.Close() } catch {}
  }
}
"#;

// 用途：进程入口。先建 lane 池与 stdout 锁，按开关做索引预热/并行 lane 预热/空闲回收/stale shell 清理，
// 然后进入帧循环：读帧 → 解析 → 每个请求一个线程执行 dispatch → 写回响应。
// 约束：主线程串行读帧，响应由工作线程并发写回，因此所有写 stdout 的路径都必须经过 write_frame 的锁。
fn main() {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let out: Arc<Mutex<io::Stdout>> = Arc::new(Mutex::new(io::stdout()));
    let pool = Arc::new(LanePool::new(lane_count()));
    LAST_HOST_SEEN_MS.store(mono_ms(), Ordering::SeqCst);

    // Startup work is deferrable: `DSH_RUST_PREWARM=0` makes the worker answer
    // requests immediately and leaves the index build and every lane start to the
    // first real call (lanes start lazily through `ensure_alive`). The host sets
    // this when it wants DSH to open without waiting for a cold index.
    let prewarm_enabled = std::env::var("DSH_RUST_PREWARM")
        .map(|raw| raw.trim() != "0")
        .unwrap_or(true);

    // Warm the code index in the background so the first search does not pay for it.
    if prewarm_enabled {
        std::thread::spawn(index::prewarm);
    }

    // A force-killed worker cannot reap its PowerShell grandchild (the child
    // inherits the pipes, so the parent's wait never completes). Sweep shells
    // from dead workers off the request path, before this worker's own starts.
    std::thread::spawn(sweep_stale_shells);

    // Prewarm every lane in parallel: pay the PowerShell start cost at plugin
    // load, not on the first tool call. Starting them one after another would
    // cost N x the cold start, so each lane gets its own thread.
    if prewarm_enabled {
        let pool2 = Arc::clone(&pool);
        std::thread::spawn(move || {
            let mut handles = Vec::with_capacity(pool2.len());
            for idx in 0..pool2.len() {
                let pool3 = Arc::clone(&pool2);
                handles.push(std::thread::spawn(move || pool3.prewarm_one(idx)));
            }
            for handle in handles {
                let _ = handle.join();
            }
        });
    }

    // Reclaim idle shells: a lane that sat unused past the idle window is
    // stopped (one warm lane always stays) so an idle companion does not pin
    // N x ~50 MB of PowerShell. `DSH_RUST_IDLE_LANE_MS` overrides the window.
    {
        let pool3 = Arc::clone(&pool);
        let idle_ms = std::env::var("DSH_RUST_IDLE_LANE_MS")
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .unwrap_or(300_000)
            .max(5_000);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(15_000));
            let killed = pool3.reap_idle(idle_ms);
            if killed > 0 {
                eprintln!(
                    "[dsh-rust-worker] reclaimed {killed} idle shell(s); {} warm lane(s) left",
                    pool3.warm_lanes()
                );
            }
        });
    }

    loop {
        let frame = match read_frame(&mut reader) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break, // clean EOF: parent closed the pipe
            Err(err) => {
                eprintln!("[dsh-rust-worker] frame error: {err}");
                break;
            }
        };
        let req: Value = match serde_json::from_slice(&frame) {
            Ok(v) => v,
            Err(err) => {
                write_error(&out, Value::Null, -32700, &format!("parse error: {err}"));
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        let params = req.get("params").cloned().unwrap_or(Value::Null);

        // Any inbound frame — request, response or notification — proves the
        // host is alive. This is the "heartbeat may ride on real traffic" rule.
        LAST_HOST_SEEN_MS.store(mono_ms(), Ordering::SeqCst);

        if method == "shutdown" {
            write_ok(&out, id, json!({ "ok": true }));
            release_lock();
            pool.stop_all();
            break;
        }

        INFLIGHT.fetch_add(1, Ordering::SeqCst);
        let out2 = Arc::clone(&out);
        let pool2 = Arc::clone(&pool);
        std::thread::spawn(move || {
            let result = dispatch(&method, &params, &pool2, &out2);
            INFLIGHT.fetch_sub(1, Ordering::SeqCst);
            match result {
                Ok(value) => write_ok(&out2, id, value),
                Err(err) => write_error(&out2, id, -32000, &err),
            }
        });
    }
    release_lock();
}

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

// 用途：从 reader 读出一个 LSP 风格帧：扫头部取 Content-Length，读到空行后精确读该长度字节。
// 返回：Ok(None) 表示对端正常关闭（EOF）；长度头非法时返回 InvalidData 错误。
// 约束：调用方传入持有 stdin 锁的 BufReader，帧之间不会被多读。
fn read_frame<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len: Option<usize> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            if let Some(len) = len {
                // 按头部声明的长度一次性分配并精确读取正文；缓冲大小完全由对端头部决定。
                let mut buf = vec![0u8; len];
                reader.read_exact(&mut buf)?;
                return Ok(Some(buf));
            }
            continue;
        }
        // 只识别 Content-Length；其余头部（Content-Type 等）一律忽略。
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            len = Some(rest.trim().parse::<usize>().map_err(|err| {
                io::Error::new(io::ErrorKind::InvalidData, format!("bad length: {err}"))
            })?);
        }
    }
}

// 用途：把 Value 序列化为一个帧写到 stdout：先写 `Content-Length: N\r\n\r\n`，再写正文。
// 约束：stdout 由外部 Mutex 串行化，避免并发响应互相穿插；锁中毒时取回内部值继续写。
fn write_frame(out: &Mutex<io::Stdout>, payload: &Value) {
    let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
    let mut guard = match out.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let _ = write!(guard, "Content-Length: {}\r\n\r\n", body.len());
    let _ = guard.write_all(&body);
    let _ = guard.flush();
}

// 用途：写出一条 JSON-RPC 成功响应（id + result）。
fn write_ok(out: &Mutex<io::Stdout>, id: Value, result: Value) {
    write_frame(out, &json!({ "jsonrpc": "2.0", "id": id, "result": result }));
}

// 用途：写出 JSON-RPC 错误响应。code 由调用方指定：-32700 解析失败、-32000 业务失败。
fn write_error(out: &Mutex<io::Stdout>, id: Value, code: i64, message: &str) {
    write_frame(
        out,
        &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    );
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

// 用途：方法名到具体实现的唯一路由表。返回 Ok(result) 或 Err(消息)，错误由调用方转成 JSON-RPC error。
// 约束：fs.write/fs.edit 先按路径加互斥锁再执行，成功后才通知索引失效（index::note_change）；
// 未知方法返回 Err，既不会 panic，也不会静默成功。
fn dispatch(
    method: &str,
    params: &Value,
    pool: &Arc<LanePool>,
    out: &Arc<Mutex<io::Stdout>>,
) -> Result<Value, String> {
    match method {
        "hello" => hello(params, out),
        "worker.health" => Ok(health()),
        "caps" => Ok(caps()),
        "initialize" => Ok(json!({
            "protocol": PROTOCOL_VERSION,
            "worker": "dsh-rust-worker",
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "cwd": std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
            "shell": Shell::describe(),
            "lanes": pool.len(),
            "metrics": metrics::available(),
            "features": [
                "fs.read", "fs.write", "fs.edit", "fs.stat", "fs.list",
                "exec", "exec.abort", "exec.stats", "metrics.sample",
                "search.text", "search.symbol", "index.status",
                "index.pause", "index.resume", "index.drop",
                "session.open", "session.body", "session.cache.stats", "session.cache.drop", "session.debug.decode",
                "caps", "worker.health",
            ],
        })),
        "ping" => Ok(json!({ "pong": true })),
        "fs.read" => fs_read(params),
        // 同一路径的写入/编辑串行化；成功落地后才让索引把该文件标记为待更新。
        "fs.write" => {
            let result = with_path_lock(params, || fs_write(params));
            if result.is_ok() {
                if let Some(path) = params.get("path").and_then(|v| v.as_str()) {
                    index::note_change(path);
                }
            }
            result
        }
        "fs.edit" => {
            let result = with_path_lock(params, || fs_edit(params));
            if result.is_ok() {
                if let Some(path) = params.get("path").and_then(|v| v.as_str()) {
                    index::note_change(path);
                }
            }
            result
        }
        "fs.stat" => fs_stat(params),
        "fs.list" => fs_list(params),
        "exec" => exec(params, pool),
        "exec.abort" => exec_abort(params, pool),
        "exec.stats" => Ok(pool.stats()),
        "metrics.sample" => Ok(metrics::sample(pool)),
        "search.text" => index::search_text(params),
        "search.symbol" => index::search_symbol(params),
        "index.status" => index::status(params),
        "session.open" => session::open(params),
        "session.body" => session::bodies(params),
        "session.cache.stats" => Ok(session::cache_stats()),
        "session.cache.drop" => session::drop_cache().map(|removed| json!({ "removed": removed })),
        "session.debug.decode" => session::debug_decode(params),
        "index.pause" => {
            index::pause();
            Ok(json!({ "paused": true }))
        }
        "index.resume" => {
            index::resume();
            Ok(json!({ "paused": false }))
        }
        "index.drop" => Ok(index::drop_index()),
        other => Err(format!("unknown method: {other}")),
    }
}

// 用途：取必填字符串参数；缺失或类型不对时返回带参数名的错误消息。
fn require_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing string param `{key}`"))
}

// 用途：取可选无符号整数参数；缺失或类型不对时返回 None，由调用方落到默认值。
fn opt_num(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

// 用途：计算字节的 SHA-256 并转成小写十六进制串，用于 fs.* 返回的 hash 和写前版本守卫。
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

// 用途：读文件摘要，按 (路径, 字节数, mtime) 命中缓存时不再重算 sha256。
// 为什么需要它：读页脚、写前版本守卫、连续读同一个文件都在问同一个哈希，而整文件哈希
// 在大文件上是纯开销（2400 行的 84 KB 文件每次读 40 行也要全量算一遍）。
// 约束：缓存键不含内容，所以只有 size 与 mtime 都没变才认为内容没变——这正是缓存失效的
// 安全边界：写一次必然改 mtime，旧条目不会再被命中。
static HASH_CACHE: OnceLock<Mutex<HashMap<(String, u64, u64), String>>> = OnceLock::new();
const HASH_CACHE_LIMIT: usize = 256;

fn file_sha256(path: &Path, meta: Option<&fs::Metadata>, bytes: &[u8]) -> String {
    let key = meta.and_then(|m| mtime_ms(m).map(|stamp| (path.to_string_lossy().to_string(), m.len(), stamp)));
    let cache = HASH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(key) = key.as_ref() {
        if let Ok(guard) = cache.lock() {
            if let Some(hit) = guard.get(key) {
                return hit.clone();
            }
        }
    }
    let digest = sha256_hex(bytes);
    if let Some(key) = key {
        if let Ok(mut guard) = cache.lock() {
            if guard.len() >= HASH_CACHE_LIMIT {
                guard.clear();
            }
            guard.insert(key, digest.clone());
        }
    }
    digest
}

// 用途：数行数，语义与 `split_inclusive('\n')` 的结果长度一致：末尾没有换行时最后一段也算一行。
// 为什么需要它：为了切 40 行而把整个文件拆成 Vec<&str> 会为每一行分配一个指针（2400 行 =
// 一次 38 KB 的临时分配），而行号窗口只需要两次换行扫描。
fn count_lines(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    let newlines = memchr::memchr_iter(b'\n', bytes).count();
    if bytes.ends_with(b"\n") {
        newlines
    } else {
        newlines + 1
    }
}

// 用途：返回第 `line` 行（0 起）的起始字节偏移；越界时落到文件末尾。
// 约束：行边界必然落在 '\n' 之后，而 '\n' 是单字节，因此切点一定在 UTF-8 字符边界上。
fn line_offset(bytes: &[u8], line: usize) -> usize {
    if line == 0 {
        return 0;
    }
    let mut seen = 0;
    for pos in memchr::memchr_iter(b'\n', bytes) {
        seen += 1;
        if seen == line {
            return pos + 1;
        }
    }
    bytes.len()
}

// 用途：把文件 mtime 转成 Unix 毫秒时间戳；系统不支持或时间早于 epoch 时返回 None。
fn mtime_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
}

// 用途：读文件并按行窗口返回。offset 是 1 起的起始行，limit=0 表示读到文件末尾；
// 返回内容超过 maxBytes（默认 DEFAULT_MAX_READ_BYTES）时按字节截断并置 truncatedByBytes。
// hash 参数控制摘要：默认 "full" 回 64 位整串（版本守卫用），"prefix" 回 16 位前缀（省 token），
// "none" 直接不算——只想要正文时不必为整个文件付哈希成本。
// 返回：content、总行数/总字节数、limited/truncatedByBytes 标志、mtimeMs 与 hash。
// 约束：截断点必须落在 UTF-8 字符边界上，所以用 floor_char_boundary 而不是 String::truncate。
fn fs_read(params: &Value) -> Result<Value, String> {
    let path = PathBuf::from(require_str(params, "path")?);
    let offset = opt_num(params, "offset").unwrap_or(1).max(1) as usize;
    let limit = opt_num(params, "limit").unwrap_or(0) as usize;
    let max_bytes = opt_num(params, "maxBytes").unwrap_or(DEFAULT_MAX_READ_BYTES as u64) as usize;
    let hash_mode = params.get("hash").and_then(|v| v.as_str()).unwrap_or("full");

    let bytes = fs::read(&path).map_err(|err| format!("read {}: {err}", path.display()))?;
    let meta = fs::metadata(&path).ok();
    let total_bytes = bytes.len();
    let total_lines = count_lines(&bytes);
    // offset 是 1 起的行号，内部切片索引要减一；start 之后统一用 [start..end) 取行。
    let start = offset - 1;
    let end = if limit == 0 {
        total_lines
    } else {
        (start + limit).min(total_lines)
    };
    // 只把窗口内的字节转成字符串：整文件拆行会把每一行都变成一个指针，2400 行的文件光这一项
    // 就是 38 KB 的临时分配，而两次换行扫描就能定位同一段窗口。
    let mut selected = if start < total_lines {
        let from = line_offset(&bytes, start);
        let to = line_offset(&bytes, end);
        String::from_utf8_lossy(&bytes[from..to]).into_owned()
    } else {
        String::new()
    };
    let mut truncated_bytes = false;
    // 按字节上限截断，切点回退到字符边界，避免把多字节 UTF-8 字符切成半个导致 panic。
    if selected.len() > max_bytes {
        selected.truncate(floor_char_boundary(&selected, max_bytes));
        truncated_bytes = true;
    }
    let mut out = json!({
        "path": path.to_string_lossy(),
        "content": selected,
        "totalLines": total_lines,
        "totalBytes": total_bytes,
        "offset": offset,
        "limited": limit != 0,
        "truncatedByBytes": truncated_bytes,
        "mtimeMs": meta.as_ref().and_then(mtime_ms),
    });
    match hash_mode {
        "none" => {}
        "prefix" => {
            let digest = file_sha256(&path, meta.as_ref(), &bytes);
            out["hash"] = json!(&digest[..digest.len().min(16)]);
        }
        _ => out["hash"] = json!(file_sha256(&path, meta.as_ref(), &bytes)),
    }
    Ok(out)
}

// 用途：返回不超过 index、且落在 UTF-8 字符边界上的最大下标。
// 为什么需要它：String::truncate 落在非字符边界上会直接 panic，而按字节上限截断时，
// 边界常常正好切在中文/emoji 的中间字节，必须先向前回退到合法边界再截。
fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut i = index.min(text.len());
    while i > 0 && !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

// 用途：整文件写入。带 expectedHash 时先做版本守卫（64 位全串、8–63 位前缀或 "absent"），
// 通过后写同目录临时文件再 rename 覆盖目标，最后返回新 hash 与 mtimeMs。
// 约束：先写临时文件再原子替换，读者不会看到写了一半的内容；父目录不存在时自动创建。
fn fs_write(params: &Value) -> Result<Value, String> {
    let path = PathBuf::from(require_str(params, "path")?);
    let content = require_str(params, "content")?;
    let expected = params
        .get("expectedHash")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if let Some(expected) = expected {
        let expected = expected.trim().to_ascii_lowercase();
        let current = fs::read(&path).ok().map(|b| sha256_hex(&b));
        let current = current.unwrap_or_else(|| "absent".to_string());
        // 版本守卫按前缀比较：读取侧只回 16 位 hash 前缀（省 token），因此 8–63 位都按前缀匹配，
        // 64 位才做全串相等；前缀匹配等价于“内容未变”，任何一个字节变化都会让 sha256 对不上。
        // The read footer shows a 16-hex prefix to save ~26 tokens per file, so a
        // prefix is accepted as the guard. A prefix still pins the exact content:
        // any byte change lands in the hash and stops matching it.
        let matches = if expected == "absent" {
            current == "absent"
        } else if expected.len() < 64 && expected.len() >= 8 {
            current.starts_with(&expected)
        } else {
            current == expected
        };
        if !matches {
            return Err(format!(
                "version guard failed for {}: expected {expected}, actual {current}",
                path.display()
            ));
        }
    }
    if let Some(parent) = path.parent() {
        // 目录通常已经存在；create_dir_all 内部先做一次 stat，这里先判一次能省掉重复探测。
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            fs::create_dir_all(parent).map_err(|err| format!("mkdir {}: {err}", parent.display()))?;
        }
    }
    // 同目录临时文件 + rename：同盘 rename 是原子的，目标文件不会出现半写状态。
    let tmp = path.with_extension(format!("dsh-tmp-{}", std::process::id()));
    fs::write(&tmp, content.as_bytes()).map_err(|err| format!("write {}: {err}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("rename into {}: {err}", path.display())
    })?;
    let hash = sha256_hex(content.as_bytes());
    let meta = fs::metadata(&path).ok();
    Ok(json!({
        "path": path.to_string_lossy(),
        "bytes": content.len(),
        "hash": hash,
        "mtimeMs": meta.as_ref().and_then(mtime_ms),
    }))
}

// 用途：按字符串做局部替换。oldString 必须非空且能匹配到；返回替换次数、新字节数与新 hash。
// 约束：默认要求唯一匹配，出现多次且未传 replaceAll 时报错，避免误改多处。
fn fs_edit(params: &Value) -> Result<Value, String> {
    let path = PathBuf::from(require_str(params, "path")?);
    let old = require_str(params, "oldString")?;
    let new = require_str(params, "newString")?;
    let replace_all = params
        .get("replaceAll")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if old.is_empty() {
        return Err("oldString must not be empty".to_string());
    }
    if old == new {
        return Err("oldString and newString are identical".to_string());
    }
    let bytes = fs::read(&path).map_err(|err| format!("read {}: {err}", path.display()))?;
    let text =
        String::from_utf8(bytes).map_err(|err| format!("{} is not UTF-8: {err}", path.display()))?;
    // 先数出现次数再决定策略：0 次报未找到，多次且未开 replaceAll 则要求更长的锚点。
    let occurrences = text.matches(&old).count();
    if occurrences == 0 {
        return Err(format!("oldString not found in {}", path.display()));
    }
    if occurrences > 1 && !replace_all {
        return Err(format!(
            "oldString appears {occurrences} times in {}; pass replaceAll or a longer anchor",
            path.display()
        ));
    }
    let updated = if replace_all {
        text.replace(&old, &new)
    } else {
        text.replacen(&old, &new, 1)
    };
    fs::write(&path, updated.as_bytes())
        .map_err(|err| format!("write {}: {err}", path.display()))?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "replacements": if replace_all { occurrences } else { 1 },
        "bytes": updated.len(),
        "hash": sha256_hex(updated.as_bytes()),
    }))
}

// 用途：查询路径元信息（存在性、是否目录、大小、mtime）；不存在时返回 exists=false 而非错误。
// 传 paths 数组时一次返回多条（"entries"），把 N 次一次性探测压成 1 次 RPC。
fn fs_stat(params: &Value) -> Result<Value, String> {
    if let Some(paths) = params.get("paths").and_then(|v| v.as_array()) {
        if paths.len() > 256 {
            return Err("fs.stat accepts at most 256 paths per call".to_string());
        }
        let entries: Vec<Value> = paths
            .iter()
            .filter_map(|item| item.as_str())
            .map(stat_one)
            .collect();
        return Ok(json!({ "entries": entries }));
    }
    Ok(stat_one(&require_str(params, "path")?))
}

// 用途：单个路径的元信息；路径不存在时只回 exists=false。
fn stat_one(path: &str) -> Value {
    let target = PathBuf::from(path);
    match fs::metadata(&target) {
        Ok(meta) => json!({
            "path": path,
            "exists": true,
            "isDir": meta.is_dir(),
            "size": meta.len(),
            "mtimeMs": mtime_ms(&meta),
        }),
        Err(_) => json!({ "path": path, "exists": false }),
    }
}

// 用途：列目录项（名称、是否目录、大小）。limit 默认 500、上限 20000，达到上限即停止遍历。
// sizes=false 时跳过逐条 metadata：只要名字时那是 N 次多余的系统调用。
// 约束：单层、非递归；读目录失败直接作为错误返回，单个条目的元信息缺失按默认值兜底。
fn fs_list(params: &Value) -> Result<Value, String> {
    let path = PathBuf::from(require_str(params, "path")?);
    let max = opt_num(params, "limit").unwrap_or(500).min(20_000) as usize;
    let with_sizes = params.get("sizes").and_then(|v| v.as_bool()).unwrap_or(true);
    let mut entries: Vec<Value> = Vec::new();
    let read_dir = fs::read_dir(&path).map_err(|err| format!("list {}: {err}", path.display()))?;
    for entry in read_dir.flatten() {
        // sizes=true 时只取一次 metadata（既给 isDir 也给 size）；false 时退到 readdir 自带的
        // file_type，避免为一个用不到的字节数多做一次系统调用。
        let meta = if with_sizes { entry.metadata().ok() } else { None };
        let is_dir = match meta.as_ref() {
            Some(meta) => meta.is_dir(),
            None => entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false),
        };
        let mut item = json!({
            "name": entry.file_name().to_string_lossy(),
            "isDir": is_dir,
        });
        if let Some(meta) = meta.as_ref() {
            item["size"] = json!(meta.len());
        }
        entries.push(item);
        if entries.len() >= max {
            break;
        }
    }
    Ok(json!({ "path": path.to_string_lossy(), "entries": entries }))
}

// ---------------------------------------------------------------------------
// lanes: independent shells so concurrent calls do not serialize on one REPL
// ---------------------------------------------------------------------------

// 用途：决定 lane 数量：DSH_RUST_LANES 可显式指定（夹到 1–16），否则取 CPU 并行度并夹到 1–4。
fn lane_count() -> usize {
    if let Ok(raw) = std::env::var("DSH_RUST_LANES") {
        if let Ok(n) = raw.trim().parse::<usize>() {
            return n.clamp(1, 16);
        }
    }
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 4)
}

// 用途：排队深度上限，DSH_RUST_MAX_QUEUE 可覆盖（默认 64，夹到 1–4096）；超过就拒绝新请求。
fn lane_max_queue() -> usize {
    std::env::var("DSH_RUST_MAX_QUEUE")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(64)
        .clamp(1, 4096)
}

// 一条执行 lane：独占一个 PowerShell shell，串行执行命令，并记录耗时统计与空闲时间。
// 约束：shell 的 Mutex 会在整条命令执行期间被持有，所以 pid/current 等状态另用原子量或独立锁暴露，
// 否则 exec.abort 只能等命令结束才能拿到锁，取消就失去了意义。
struct Lane {
    id: usize,
    shell: Mutex<Shell>,
    /// Pid of this lane's live shell, readable without the shell lock so an
    /// abort can terminate the process while `run` still holds the mutex.
    pid: AtomicU32,
    completed: AtomicU64,
    failed: AtomicU64,
    ms_total: AtomicU64,
    /// Last time this lane finished a command; drives idle-shell reclaim.
    last_used_ms: AtomicU64,
    current: Mutex<Option<String>>,
    recent: Mutex<VecDeque<u64>>,
}

impl Lane {
    // 用途：创建一条空闲 lane；shell 此时不启动（懒启动），pid 为 0 表示尚未预热。
    fn new(id: usize) -> Self {
        Self {
            id,
            shell: Mutex::new(Shell::new()),
            pid: AtomicU32::new(0),
            completed: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            ms_total: AtomicU64::new(0),
            last_used_ms: AtomicU64::new(mono_ms()),
            current: Mutex::new(None),
            recent: Mutex::new(VecDeque::new()),
        }
    }

    // 用途：当前是否有调用占用这条 lane（看 current 是否被设置）。
    fn busy(&self) -> bool {
        self.current.lock().map(|c| c.is_some()).unwrap_or(false)
    }

    // 用途：刷新最近使用时间，空闲回收据此判断这条 lane 还能不能留。
    fn touch(&self) {
        self.last_used_ms.store(mono_ms(), Ordering::SeqCst);
    }

    // 用途：距上次使用过了多少毫秒。
    fn idle_ms(&self) -> u64 {
        mono_ms().saturating_sub(self.last_used_ms.load(Ordering::SeqCst))
    }

    // 用途：该 lane 是否已有存活的 shell 进程（pid 非 0）。
    fn warm(&self) -> bool {
        self.pid.load(Ordering::SeqCst) != 0
    }

    // 用途：记录一次调用的耗时与成败，并保留最近 64 个样本供 p50/p95 统计。
    fn record(&self, ms: u64, ok: bool) {
        self.ms_total.fetch_add(ms, Ordering::SeqCst);
        if ok {
            self.completed.fetch_add(1, Ordering::SeqCst);
        } else {
            self.failed.fetch_add(1, Ordering::SeqCst);
        }
        if let Ok(mut recent) = self.recent.lock() {
            recent.push_back(ms);
            while recent.len() > 64 {
                recent.pop_front();
            }
        }
    }
}

// lane 池：固定数量的 lane + 计数信号量（avail 与 Condvar）+ 空闲下标栈（free）。
// 约束：acquire 同时受两重约束——等待超时与排队上限；release 必须与 acquire 成对调用，
// 否则 avail 会漂移，最终要么永久拒绝、要么放行过多线程。
struct LanePool {
    lanes: Vec<Lane>,
    avail: Mutex<usize>,
    cv: Condvar,
    free: Mutex<Vec<usize>>,
    queued: AtomicU64,
    peak_queued: AtomicU64,
    rejected: AtomicU64,
    max_queue: usize,
}

impl LanePool {
    // 用途：按 n 建好 lane 与空闲栈；avail 初值为 n，表示全部可用。
    fn new(n: usize) -> Self {
        let lanes: Vec<Lane> = (0..n).map(Lane::new).collect();
        // 倒序入栈：acquire 用 pop() 从尾部取，这样 0 号 lane 总是最先被使用。
        let free: Vec<usize> = (0..n).rev().collect();
        Self {
            lanes,
            avail: Mutex::new(n),
            cv: Condvar::new(),
            free: Mutex::new(free),
            queued: AtomicU64::new(0),
            peak_queued: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            max_queue: lane_max_queue(),
        }
    }

    // 用途：lane 总数（创建后固定不变）。
    fn len(&self) -> usize {
        self.lanes.len()
    }

    // 用途：按下标取 lane 的引用（下标来自 acquire，调用期间不会越界）。
    fn lane(&self, idx: usize) -> &Lane {
        &self.lanes[idx]
    }

    // 用途：取一条空闲 lane 并返回其下标。先查排队深度，再等信号量（带超时），最后从空闲栈取下标。
    // 约束：所有失败路径都必须把 queued 计数减回去，否则排队统计会越跑越高。
    /// Wait for a free lane. Bounded twice: by `timeout` and by the queue-depth cap
    /// (a burst larger than the cap is rejected instead of piling up threads).
    fn acquire(&self, timeout: Duration) -> Result<usize, String> {
        let started = Instant::now();
        let depth = self.queued.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak_queued.fetch_max(depth, Ordering::SeqCst);
        if depth as usize > self.max_queue {
            self.queued.fetch_sub(1, Ordering::SeqCst);
            self.rejected.fetch_add(1, Ordering::SeqCst);
            return Err(format!(
                "worker saturated: {} calls queued (maxQueue {})",
                depth, self.max_queue
            ));
        }
        let mut avail = self.avail.lock().map_err(|_| "lane gate poisoned".to_string())?;
        while *avail == 0 {
            let remaining = match timeout.checked_sub(started.elapsed()) {
                Some(rest) if !rest.is_zero() => rest,
                _ => Duration::ZERO,
            };
            if remaining.is_zero() {
                break;
            }
            let (guard, _) = self
                .cv
                .wait_timeout(avail, remaining)
                .map_err(|_| "lane gate poisoned".to_string())?;
            avail = guard;
        }
        if *avail == 0 {
            self.queued.fetch_sub(1, Ordering::SeqCst);
            self.rejected.fetch_add(1, Ordering::SeqCst);
            return Err(format!(
                "worker saturated: no free lane within {} ms ({} lanes, {} queued)",
                timeout.as_millis(),
                self.len(),
                self.queued.load(Ordering::SeqCst) + 1
            ));
        }
        *avail -= 1;
        self.queued.fetch_sub(1, Ordering::SeqCst);
        let idx = self
            .free
            .lock()
            .map_err(|_| "lane free list poisoned".to_string())?
            .pop()
            .unwrap_or(0);
        Ok(idx)
    }

    // 用途：归还 lane：下标入空闲栈、可用数加一，并唤醒一个等待者。
    fn release(&self, idx: usize) {
        if let Ok(mut free) = self.free.lock() {
            free.push(idx);
        }
        if let Ok(mut avail) = self.avail.lock() {
            *avail += 1;
        }
        self.cv.notify_one();
    }

    // 用途：启动单条 lane 的 shell 并记录 pid；失败只打日志，不影响其它 lane。
    fn prewarm_one(&self, idx: usize) {
        let lane = &self.lanes[idx];
        if let Ok(mut guard) = lane.shell.lock() {
            if let Err(err) = guard.ensure_alive() {
                eprintln!("[dsh-rust-worker] lane {} prewarm failed: {err}", lane.id);
                return;
            }
            lane.pid.store(guard.pid(), Ordering::SeqCst);
        }
    }

    // 用途：串行预热所有 lane。主路径用的是 prewarm_one 的并行版，这里是顺序版本。
    fn prewarm(&self) {
        for lane in &self.lanes {
            if let Ok(mut guard) = lane.shell.lock() {
                if let Err(err) = guard.ensure_alive() {
                    eprintln!("[dsh-rust-worker] lane {} prewarm failed: {err}", lane.id);
                }
            }
        }
    }

    // 用途：关闭所有 lane 的 shell；shutdown 后干净退出时调用。
    fn stop_all(&self) {
        for lane in &self.lanes {
            if let Ok(mut guard) = lane.shell.lock() {
                guard.stop();
            }
        }
    }

    // 用途：回收空闲超过 idle_ms 的 shell，至少保留一条热的；返回回收条数。
    // 约束：正在忙的 lane 不算空闲；回收后把 pid 置 0，下次调用会重新懒启动。
    /// Kill shells that sat idle past `idle_ms`, always keeping one warm lane so
    /// the next call does not pay a cold start. Returns how many were reclaimed.
    fn reap_idle(&self, idle_ms: u64) -> u64 {
        let mut warm = self.lanes.iter().filter(|lane| lane.warm()).count();
        let mut killed = 0u64;
        for lane in &self.lanes {
            if warm <= 1 {
                break;
            }
            if lane.busy() || !lane.warm() || lane.idle_ms() < idle_ms {
                continue;
            }
            if let Ok(mut shell) = lane.shell.lock() {
                shell.stop();
                lane.pid.store(0, Ordering::SeqCst);
                lane.last_used_ms.store(mono_ms(), Ordering::SeqCst);
                warm -= 1;
                killed += 1;
            }
        }
        killed
    }

    // 用途：统计当前有多少条 lane 的 shell 是活的（供 metrics / health 使用）。
    /// Lanes whose shell is currently alive (exposed for metrics / health).
    fn warm_lanes(&self) -> usize {
        self.lanes.iter().filter(|lane| lane.warm()).count()
    }

    // 用途：按 callId 找正在执行该调用的 lane 下标；exec.abort 靠它定位要杀的进程。
    fn find_by_call(&self, call: &str) -> Option<usize> {
        for lane in &self.lanes {
            if let Ok(current) = lane.current.lock() {
                if current.as_deref() == Some(call) {
                    return Some(lane.id);
                }
            }
        }
        None
    }

    // 用途：生成 exec.stats 返回体：全局排队/峰值/拒绝计数，加上每条 lane 的忙闲、次数与 p50/p95。
    fn stats(&self) -> Value {
        let detail: Vec<Value> = self
            .lanes
            .iter()
            .map(|lane| {
                let recent = lane.recent.lock().map(|r| r.clone()).unwrap_or_default();
                let (p50, p95) = percentile(&recent);
                json!({
                    "id": lane.id,
                    "busy": lane.busy(),
                    "current": lane.current.lock().ok().and_then(|c| c.clone()),
                    "completed": lane.completed.load(Ordering::SeqCst),
                    "failed": lane.failed.load(Ordering::SeqCst),
                    "msTotal": lane.ms_total.load(Ordering::SeqCst),
                    "p50": p50,
                    "p95": p95,
                })
            })
            .collect();
        json!({
            "schema": "dsh-rust-exec/exec-stats@1",
            "lanes": self.len(),
            "queued": self.queued.load(Ordering::SeqCst),
            "peakQueued": self.peak_queued.load(Ordering::SeqCst),
            "rejected": self.rejected.load(Ordering::SeqCst),
            "maxQueue": self.max_queue,
            "inflight": INFLIGHT.load(Ordering::SeqCst),
            "detail": detail,
        })
    }

    // 用途：当前排队等待 lane 的调用数。
    fn queued(&self) -> u64 {
        self.queued.load(Ordering::SeqCst)
    }

    // 用途：历史峰值排队数。
    fn peak_queued(&self) -> u64 {
        self.peak_queued.load(Ordering::SeqCst)
    }

    // 用途：因排队超限或等不到空闲 lane 而被拒绝的调用数。
    fn rejected(&self) -> u64 {
        self.rejected.load(Ordering::SeqCst)
    }
}

// RAII 归还凭证：无论正常返回、提前 return 还是 panic，Drop 都会 touch 后把 lane 还回池子。
/// Returns the lane to the pool even when the call panics or returns early.
struct LaneGuard<'a> {
    pool: &'a LanePool,
    idx: usize,
}

impl Drop for LaneGuard<'_> {
    // 先刷新使用时间再归还，避免刚用完就被空闲回收挑中。
    fn drop(&mut self) {
        self.pool.lane(self.idx).touch();
        self.pool.release(self.idx);
    }
}

// 用途：对最近样本算 p50/p95：先排序，再按比例取下标并夹到末尾；空样本返回 (0, 0)。
fn percentile(recent: &VecDeque<u64>) -> (u64, u64) {
    if recent.is_empty() {
        return (0, 0);
    }
    let mut sorted: Vec<u64> = recent.iter().copied().collect();
    sorted.sort_unstable();
    let at = |p: f64| sorted[((sorted.len() as f64 * p) as usize).min(sorted.len() - 1)];
    (at(0.5), at(0.95))
}

// 用途：返回静态能力清单：协议版本、lane/队列配置、传输类型、稳定方法名与能力开关。
// 约束：stableMethods 必须与 dispatch 的分支保持一致，主机侧据此判断某个方法是否可用。
fn caps() -> Value {
    json!({
        "protocol": PROTOCOL_VERSION,
        "worker": "dsh-rust-worker",
        "version": env!("CARGO_PKG_VERSION"),
        "lanes": lane_count(),
        "maxQueue": lane_max_queue(),
        "metrics": metrics::available(),
        "transport": "jsonrpc2-lsp-frames",
        "stableMethods": [
            "initialize", "caps", "ping", "worker.health",
            "fs.read", "fs.write", "fs.edit", "fs.stat", "fs.list",
            "exec", "exec.abort", "exec.stats", "metrics.sample",
            "search.text", "search.symbol", "index.status",
            "index.pause", "index.resume", "index.drop",
            "session.open", "session.body", "session.cache.stats", "session.cache.drop", "session.debug.decode",
        ],
        "capabilities": {
            "concurrentExec": true,
            "laneLease": true,
            "abort": true,
            "resourceMetrics": metrics::available(),
            "index": true,
            "indexSoftPause": true,
            "idleLaneReclaim": true,
            "sessionProjection": true,
        },
    })
}

// ---------------------------------------------------------------------------
// path-keyed mutex: concurrent fs.write/fs.edit to the same file must not interleave
// ---------------------------------------------------------------------------

// 路径到互斥量的映射：只保护同一路径上的写操作，不同路径之间互不阻塞。
type PathLockMap = std::collections::HashMap<String, Arc<Mutex<()>>>;

// 用途：全局锁表的懒初始化入口（OnceLock），进程内唯一。
fn path_locks() -> &'static Mutex<PathLockMap> {
    static LOCKS: OnceLock<Mutex<PathLockMap>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

// 用途：把路径归一成锁键：分隔符统一为反斜杠、去掉末尾多余的 `\`、再转小写。
// 为什么：Windows 路径不区分大小写，`E:\A\x.txt` 与 `e:/a/x.txt` 必须映射到同一把锁。
// 返回：仅用作 HashMap 的键，不参与真实文件访问。
fn normalize_path_key(path: &str) -> String {
    let mut key = path.replace('/', "\\");
    while key.len() > 3 && key.ends_with('\\') {
        key.pop();
    }
    key.to_lowercase()
}

// 用途：按归一化路径取互斥量并持锁执行 run；params 里没有 path 时直接执行，不加锁。
// 约束：锁表超过 4096 项时整体清空，防止长时间运行后无限增长（清空只会短暂放宽互斥）。
fn with_path_lock<T>(params: &Value, run: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let key = match params.get("path").and_then(|v| v.as_str()) {
        Some(path) => normalize_path_key(path),
        None => return run(),
    };
    let mutex = {
        let mut map = path_locks()
            .lock()
            .map_err(|_| "path lock map poisoned".to_string())?;
        if map.len() > 4096 {
            map.clear();
        }
        map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    };
    let _guard = mutex.lock().map_err(|_| "path lock poisoned".to_string())?;
    run()
}

// ---------------------------------------------------------------------------
// persistent exec
// ---------------------------------------------------------------------------

// 用途：执行一条 PowerShell 命令：取 lane → 置 current/pid → shell.run → 记录统计 → 按字节上限截断 stdout。
// 返回：exitCode、stdout、truncated/shownBytes/totalBytes、耗时（ms/shellMs/queueMs）与 lane 信息。
// 约束：命令在 lane 的 shell 互斥锁内执行，同一 lane 不会并发；排队等待时间单独上报，
// 便于区分“命令慢”和“没抢到 lane”。
fn exec(params: &Value, pool: &Arc<LanePool>) -> Result<Value, String> {
    let command = require_str(params, "command")?;
    let cwd = params
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let timeout = Duration::from_millis(opt_num(params, "timeoutMs").unwrap_or(DEFAULT_EXEC_TIMEOUT_MS));
    let queue_timeout = Duration::from_millis(opt_num(params, "queueTimeoutMs").unwrap_or(30_000));
    let call_id = params
        .get("callId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let queued_at = Instant::now();
    let lane_idx = pool.acquire(queue_timeout)?;
    let _guard = LaneGuard {
        pool: pool.as_ref(),
        idx: lane_idx,
    };
    let queue_ms = queued_at.elapsed().as_millis() as u64;
    let lane = pool.lane(lane_idx);
    if let Ok(mut current) = lane.current.lock() {
        *current = call_id;
    }

    let started = Instant::now();
    let outcome = {
        let mut shell = lane
            .shell
            .lock()
            .map_err(|_| "shell lock poisoned".to_string())?;
        // Publish the pid before running: an abort from another request must be
        // able to terminate this process without waiting for this lock.
        if let Ok(alive) = shell.ensure_alive() {
            let _ = alive;
        }
        lane.pid.store(shell.pid(), Ordering::SeqCst);
        shell.run(&command, cwd.as_deref(), timeout)
    };
    lane.pid.store(0, Ordering::SeqCst);
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if let Ok(mut current) = lane.current.lock() {
        *current = None;
    }

    match outcome {
        Ok(outcome) => {
            lane.record(elapsed_ms, true);
            // 输出按字节上限截断，切点回退到字符边界；同时如实返回总字节数，便于模型判断是否要缩小输出。
            let max_bytes = opt_num(params, "maxBytes").unwrap_or(DEFAULT_EXEC_MAX_BYTES as u64) as usize;
            let total_bytes = outcome.stdout.len();
            let (stdout, truncated) = if total_bytes > max_bytes {
                let cut = floor_char_boundary(&outcome.stdout, max_bytes);
                (outcome.stdout[..cut].to_string(), true)
            } else {
                (outcome.stdout, false)
            };
            Ok(json!({
                "exitCode": outcome.exit_code,
                "stdout": stdout,
                "truncated": truncated,
                "shownBytes": if truncated { max_bytes } else { total_bytes },
                "totalBytes": total_bytes,
                "ms": elapsed_ms,
                "shellMs": outcome.shell_ms,
                "reused": outcome.reused,
                "shell": outcome.shell,
                "lane": lane_idx,
                "lanes": pool.len(),
                "queueMs": queue_ms,
            }))
        }
        Err(err) => {
            lane.record(elapsed_ms, false);
            Err(err)
        }
    }
}

// 用途：按 callId 取消正在执行的调用——直接 TerminateProcess 该 lane 的 shell 进程。
// 返回：{aborted, lane, pid} 或 {aborted:false, reason}；找不到对应调用不算错误。
/// Cancel the call currently running on a lane by terminating that lane's
/// shell process. Deliberately lock-free with respect to the shell mutex: the
/// in-flight `run` holds that mutex for the whole command, so waiting on it
/// would make abort block for as long as the command does.
fn exec_abort(params: &Value, pool: &Arc<LanePool>) -> Result<Value, String> {
    let call = require_str(params, "callId")?;
    match pool.find_by_call(&call) {
        Some(idx) => {
            let lane = pool.lane(idx);
            let pid = lane.pid.load(Ordering::SeqCst);
            if pid == 0 {
                return Ok(json!({ "aborted": false, "lane": idx, "reason": "lane has no live shell" }));
            }
            let killed = win::terminate_process(pid);
            Ok(json!({ "aborted": killed, "lane": idx, "pid": pid }))
        }
        None => Ok(json!({ "aborted": false, "reason": "no running call with that callId" })),
    }
}

// 一次命令执行的结果：退出码、规范化后的 stdout、shell 内耗时、是否复用 shell、shell 类型。
struct RunOutcome {
    exit_code: i64,
    stdout: String,
    shell_ms: u64,
    reused: bool,
    shell: String,
}

// 一个 PowerShell 命令服务端进程的句柄：子进程、监听端口、shell 类型。
// 约束：child 与 port 同时有效才算可用；ensure_alive 负责懒启动，失效时由它重建。
struct Shell {
    child: Option<Child>,
    port: Option<u16>,
    kind: String,
}

impl Shell {
    // 用途：空句柄：不启动进程，等 ensure_alive 首次调用时才 spawn。
    fn new() -> Self {
        Self {
            child: None,
            port: None,
            kind: String::new(),
        }
    }

    // 用途：返回当前解析到的 PowerShell 路径、类型与传输方式，用于 initialize/health 展示。
    fn describe() -> Value {
        let (path, kind) = resolve_powershell();
        json!({ "path": path.to_string_lossy(), "kind": kind, "transport": "loopback-tcp" })
    }

    // 用途：返回 shell 子进程的 pid；没有子进程时返回 0（exec.abort 据此判断能否强杀）。
    /// Pid of the live shell server, or 0 when none is running.
    fn pid(&self) -> u32 {
        self.child.as_ref().map(|child| child.id()).unwrap_or(0)
    }

    // 用途：确保 shell 可用：子进程仍在且端口有效就复用，否则先 stop 再 start。
    // 返回：Ok(true) 表示复用了已有进程，Ok(false) 表示刚启动了一个新进程。
    // 约束：这是 lane 懒启动的唯一入口，首次 exec 的冷启动成本就发生在这里。
    fn ensure_alive(&mut self) -> Result<bool, String> {
        let alive = match self.child.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        };
        if alive && self.port.is_some() {
            return Ok(true);
        }
        self.stop();
        self.start()?;
        Ok(false)
    }

    // 用途：杀掉并回收子进程、清空端口，使下一次调用走重建路径。
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.port = None;
    }

    // 用途：spawn PowerShell 服务端，把 stderr 转到日志，等它打印 `PORT=<n>` 后记录端口。
    // 约束：等待端口有 SHELL_BOOT_TIMEOUT 上限，超时就杀掉子进程并返回错误（不留下僵尸 shell）。
    fn start(&mut self) -> Result<(), String> {
        let (exe, kind) = resolve_powershell();
        // 用 -EncodedCommand 传脚本而不是写临时 .ps1：低完整性（沙箱）下 worker 在 workspace 之外没有写权限。
        // Run the server from an encoded command instead of a %TEMP% script file. A worker that
        // runs at low integrity (the DSH sandbox launches image files kept in the workspace that
        // way) is denied every write outside the workspace, so creating a temp .ps1 failed with
        // "access denied (os error 5)" and took every lane prewarm down with it. Feeding the
        // script through stdin is not an option either: `-Command -` executes stdin line by line.
        let mut child = Command::new(&exe)
            .args([
                "-NoProfile",
                "-NoLogo",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
            ])
            .arg(encoded_command(SHELL_SERVER))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("spawn {}: {err}", exe.display()))?;
        let stdout = child.stdout.take().ok_or("no stdout on shell server")?;
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    eprintln!("[shell] {line}");
                }
            });
        }

        // The server prints PORT=<n> once the listener is ready.
        let (tx, rx) = std::sync::mpsc::channel::<u16>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if let Some(port) = trimmed.strip_prefix("PORT=") {
                            if let Ok(port) = port.trim().parse::<u16>() {
                                let _ = tx.send(port);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        // 等端口上报：超时说明 shell 没起来（启动失败或脚本报错），按失败处理并清理子进程。
        match rx.recv_timeout(SHELL_BOOT_TIMEOUT) {
            Ok(port) => {
                self.child = Some(child);
                self.port = Some(port);
                self.kind = kind;
                Ok(())
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(format!("shell server did not report a port ({err})"))
            }
        }
    }

    // 用途：在已就绪的 shell 上执行一条命令：确保存活 → 组 JSON 请求 → roundtrip → 解析响应。
    // 返回：RunOutcome；命令侧报错（ok=false）转成 Err，连接类错误顺带标记 shell 需要重建。
    // 约束：stdout 在这里统一把 CRLF 归一成 LF 并裁掉尾部换行，避免模型拿到多余空行。
    fn run(&mut self, command: &str, cwd: Option<&str>, timeout: Duration) -> Result<RunOutcome, String> {
        let reused = self.ensure_alive()?;
        let port = self.port.ok_or("shell server has no port")?;
        let request = json!({ "command": command, "cwd": cwd });
        let payload = serde_json::to_vec(&request).map_err(|err| format!("encode request: {err}"))?;

        let result = self.roundtrip(port, &payload, timeout);
        if let Err(err) = &result {
            // A dead or wedged shell is replaced on the next call.
            // 连接失败、读超时、提前 EOF 都说明这个 shell 已不可用：销毁它，下次调用重建。
            if err.contains("connect") || err.contains("timed out") || err.contains("unexpected eof") {
                self.stop();
            }
        }
        let response = result?;
        let exit_code = response.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(0);
        let stdout = response
            .get("stdout")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let shell_ms = response.get("ms").and_then(|v| v.as_u64()).unwrap_or(0);
        if response.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            let message = response
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("shell command failed");
            return Err(format!("{message}"));
        }
        Ok(RunOutcome {
            exit_code,
            stdout: trim_trailing_newlines(stdout.replace("\r\n", "\n")),
            shell_ms,
            reused,
            shell: self.kind.clone(),
        })
    }

    // 用途：与 shell 服务端做一次请求/响应：连本机端口、写一行 JSON、读到对端关闭为止。
    // 返回：解析后的响应 Value；超时（WouldBlock/TimedOut）转成明确的 exec 超时错误。
    // 约束：读写都设置 timeout，避免卡死的命令把整条 lane 永久占住。
    fn roundtrip(&self, port: u16, payload: &[u8], timeout: Duration) -> Result<Value, String> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .map_err(|err| format!("connect to shell server on {port}: {err}"))?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|err| format!("set read timeout: {err}"))?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|err| format!("set write timeout: {err}"))?;
        let mut body = payload.to_vec();
        body.push(b'\n');
        stream
            .write_all(&body)
            .map_err(|err| format!("write to shell server: {err}"))?;
        stream.flush().ok();
        let mut raw = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => raw.extend_from_slice(&buf[..n]),
                Err(err) => {
                    if err.kind() == io::ErrorKind::WouldBlock || err.kind() == io::ErrorKind::TimedOut {
                        return Err(format!("exec timed out after {} ms", timeout.as_millis()));
                    }
                    return Err(format!("read from shell server: {err}"));
                }
            }
        }
        if raw.is_empty() {
            return Err("unexpected eof from shell server".to_string());
        }
        serde_json::from_slice(&raw).map_err(|err| {
            format!(
                "decode shell response: {err} (first 200 bytes: {})",
                String::from_utf8_lossy(&raw[..raw.len().min(200)])
            )
        })
    }
}

// 用途：去掉结尾的换行。shell 侧用 Out-String 收集输出，末尾必然带换行，返回给模型前裁掉。
fn trim_trailing_newlines(mut text: String) -> String {
    while text.ends_with('\n') {
        text.pop();
    }
    text
}

// 用途：决定用哪个 PowerShell：DSH_RUST_SHELL 显式指定优先，其次 pwsh 7、7-preview、
// Windows PowerShell 5.1，都不存在时退回 PATH 上的 powershell.exe。
// 返回：(可执行文件路径, 类型标签)；类型标签只用于展示与统计，不影响执行行为。
fn resolve_powershell() -> (PathBuf, String) {
    if let Ok(explicit) = std::env::var("DSH_RUST_SHELL") {
        if !explicit.is_empty() {
            let path = PathBuf::from(&explicit);
            if path.exists() {
                return (path, "env".to_string());
            }
        }
    }
    for candidate in [
        r"C:\Program Files\PowerShell\7\pwsh.exe",
        r"C:\Program Files\PowerShell\7-preview\pwsh.exe",
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
    ] {
        let path = PathBuf::from(candidate);
        if path.exists() {
            return (path, "powershell".to_string());
        }
    }
    (PathBuf::from("powershell.exe"), "powershell".to_string())
}

// 服务端脚本里保留的标识串，sweep_stale_shells 也用它匹配残留的临时脚本文件名。
/// Marker kept in the server script and used by the sweep below to clean old temp files.
const SHELL_MARKER: &str = "dsh-rust-worker-shell";

// 用途：把脚本编码成 -EncodedCommand 需要的 Base64，输入是 UTF-16LE 字节。
// 说明：不引入额外依赖，这里手写三字节一组的分组编码，末尾按需补 '='。
/// Base64 of the UTF-16LE bytes, the encoding `powershell -EncodedCommand` expects.
fn encoded_command(script: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    // -EncodedCommand 只接受 UTF-16LE，所以先按 UTF-16 编码再取每个单元的小端字节。
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

// 兜底：Shell 被丢弃时也要杀掉子进程，不能把常驻 PowerShell 留在系统里。
impl Drop for Shell {
    fn drop(&mut self) {
        // Normal exit path: never leave the warm PowerShell behind.
        self.stop();
    }
}

// 用途：清理被强杀 worker 遗留的 shell 进程与临时脚本，避免它们越积越多。
// 约束：只处理“命令行带 -EncodedCommand 且父进程已不存在”的进程，活着的 worker 的 shell 不会被误杀。
/// Kill PowerShell servers and temp scripts left over from force-killed workers.
///
/// A force-killed worker leaks its warm shell (the shell is a grandchild, and
/// Windows does not kill the tree). The shells are started with
/// `-EncodedCommand`, so the orphan is recognised by that flag plus its dead
/// parent — which also makes this safe: a live worker's own shell has a living
/// parent and is never touched, no matter when the sweep runs.
fn sweep_stale_shells() {
    if !cfg!(windows) {
        return;
    }
    // 用 format! 把 SHELL_MARKER 填进脚本模板；模板里的 PowerShell 花括号已双写成 {{ }}，展开后合法。
    let script = format!(
        r#"$alive = @(Get-Process | Select-Object -ExpandProperty Id)
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object {{ $_.CommandLine -like '*-EncodedCommand*' -and ($alive -notcontains $_.ParentProcessId) }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}
Get-ChildItem $env:TEMP -Filter '{marker}-*.ps1' -ErrorAction SilentlyContinue | Where-Object {{ $_.Name -match '^{marker}-(\d+)' -and ($alive -notcontains [int]$Matches[1]) }} | Remove-Item -Force -ErrorAction SilentlyContinue"#,
        marker = SHELL_MARKER
    );
    // 一次性后台清理，不关心结果：无权限或没有 PowerShell 时保持静默，失败不影响 worker 启动。
    let _ = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}
