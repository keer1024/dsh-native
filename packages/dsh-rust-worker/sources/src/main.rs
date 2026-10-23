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

mod index;
mod metrics;
mod session;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

const PROTOCOL_VERSION: u64 = 1;
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

fn mono_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn uptime_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

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

fn dsh_home() -> PathBuf {
    if let Some(dir) = std::env::var_os("DSH_HOME") {
        return PathBuf::from(dir);
    }
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".dsh")
}

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

fn release_lock() {
    if let Some(path) = LOCK_PATH.get() {
        let _ = fs::remove_file(path);
    }
}

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

fn main() {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let out: Arc<Mutex<io::Stdout>> = Arc::new(Mutex::new(io::stdout()));
    let pool = Arc::new(LanePool::new(lane_count()));
    LAST_HOST_SEEN_MS.store(mono_ms(), Ordering::SeqCst);

    // Warm the code index in the background so the first search does not pay for it.
    std::thread::spawn(index::prewarm);

    // A force-killed worker cannot reap its PowerShell grandchild (the child
    // inherits the pipes, so the parent's wait never completes). Sweep shells
    // from dead workers off the request path, before this worker's own starts.
    std::thread::spawn(sweep_stale_shells);

    // Prewarm every lane in parallel: pay the PowerShell start cost at plugin
    // load, not on the first tool call. Starting them one after another would
    // cost N x the cold start, so each lane gets its own thread.
    {
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
                let mut buf = vec![0u8; len];
                reader.read_exact(&mut buf)?;
                return Ok(Some(buf));
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            len = Some(rest.trim().parse::<usize>().map_err(|err| {
                io::Error::new(io::ErrorKind::InvalidData, format!("bad length: {err}"))
            })?);
        }
    }
}

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

fn write_ok(out: &Mutex<io::Stdout>, id: Value, result: Value) {
    write_frame(out, &json!({ "jsonrpc": "2.0", "id": id, "result": result }));
}

fn write_error(out: &Mutex<io::Stdout>, id: Value, code: i64, message: &str) {
    write_frame(
        out,
        &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    );
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

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

fn require_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing string param `{key}`"))
}

fn opt_num(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

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

fn mtime_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
}

fn fs_read(params: &Value) -> Result<Value, String> {
    let path = PathBuf::from(require_str(params, "path")?);
    let offset = opt_num(params, "offset").unwrap_or(1).max(1) as usize;
    let limit = opt_num(params, "limit").unwrap_or(0) as usize;
    let max_bytes = opt_num(params, "maxBytes").unwrap_or(DEFAULT_MAX_READ_BYTES as u64) as usize;

    let bytes = fs::read(&path).map_err(|err| format!("read {}: {err}", path.display()))?;
    let meta = fs::metadata(&path).ok();
    let total_bytes = bytes.len();
    let text = String::from_utf8_lossy(&bytes);
    let all_lines: Vec<&str> = text.split_inclusive('\n').collect();
    let total_lines = all_lines.len();
    let start = offset - 1;
    let end = if limit == 0 {
        total_lines
    } else {
        (start + limit).min(total_lines)
    };
    let mut selected = String::new();
    if start < total_lines {
        for line in &all_lines[start..end] {
            selected.push_str(line);
        }
    }
    let mut truncated_bytes = false;
    if selected.len() > max_bytes {
        selected.truncate(floor_char_boundary(&selected, max_bytes));
        truncated_bytes = true;
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "content": selected,
        "totalLines": total_lines,
        "totalBytes": total_bytes,
        "offset": offset,
        "limited": limit != 0,
        "truncatedByBytes": truncated_bytes,
        "mtimeMs": meta.as_ref().and_then(mtime_ms),
        "hash": sha256_hex(&bytes),
    }))
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut i = index.min(text.len());
    while i > 0 && !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

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
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|err| format!("mkdir {}: {err}", parent.display()))?;
        }
    }
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

fn fs_stat(params: &Value) -> Result<Value, String> {
    let path = PathBuf::from(require_str(params, "path")?);
    match fs::metadata(&path) {
        Ok(meta) => Ok(json!({
            "path": path.to_string_lossy(),
            "exists": true,
            "isDir": meta.is_dir(),
            "size": meta.len(),
            "mtimeMs": mtime_ms(&meta),
        })),
        Err(_) => Ok(json!({ "path": path.to_string_lossy(), "exists": false })),
    }
}

fn fs_list(params: &Value) -> Result<Value, String> {
    let path = PathBuf::from(require_str(params, "path")?);
    let max = opt_num(params, "limit").unwrap_or(500).min(20_000) as usize;
    let mut entries: Vec<Value> = Vec::new();
    let read_dir = fs::read_dir(&path).map_err(|err| format!("list {}: {err}", path.display()))?;
    for entry in read_dir.flatten() {
        let meta = entry.metadata().ok();
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "isDir": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
        }));
        if entries.len() >= max {
            break;
        }
    }
    Ok(json!({ "path": path.to_string_lossy(), "entries": entries }))
}

// ---------------------------------------------------------------------------
// lanes: independent shells so concurrent calls do not serialize on one REPL
// ---------------------------------------------------------------------------

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

fn lane_max_queue() -> usize {
    std::env::var("DSH_RUST_MAX_QUEUE")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(64)
        .clamp(1, 4096)
}

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

    fn busy(&self) -> bool {
        self.current.lock().map(|c| c.is_some()).unwrap_or(false)
    }

    fn touch(&self) {
        self.last_used_ms.store(mono_ms(), Ordering::SeqCst);
    }

    fn idle_ms(&self) -> u64 {
        mono_ms().saturating_sub(self.last_used_ms.load(Ordering::SeqCst))
    }

    fn warm(&self) -> bool {
        self.pid.load(Ordering::SeqCst) != 0
    }

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
    fn new(n: usize) -> Self {
        let lanes: Vec<Lane> = (0..n).map(Lane::new).collect();
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

    fn len(&self) -> usize {
        self.lanes.len()
    }

    fn lane(&self, idx: usize) -> &Lane {
        &self.lanes[idx]
    }

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

    fn release(&self, idx: usize) {
        if let Ok(mut free) = self.free.lock() {
            free.push(idx);
        }
        if let Ok(mut avail) = self.avail.lock() {
            *avail += 1;
        }
        self.cv.notify_one();
    }

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

    fn prewarm(&self) {
        for lane in &self.lanes {
            if let Ok(mut guard) = lane.shell.lock() {
                if let Err(err) = guard.ensure_alive() {
                    eprintln!("[dsh-rust-worker] lane {} prewarm failed: {err}", lane.id);
                }
            }
        }
    }

    fn stop_all(&self) {
        for lane in &self.lanes {
            if let Ok(mut guard) = lane.shell.lock() {
                guard.stop();
            }
        }
    }

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

    /// Lanes whose shell is currently alive (exposed for metrics / health).
    fn warm_lanes(&self) -> usize {
        self.lanes.iter().filter(|lane| lane.warm()).count()
    }

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

    fn queued(&self) -> u64 {
        self.queued.load(Ordering::SeqCst)
    }

    fn peak_queued(&self) -> u64 {
        self.peak_queued.load(Ordering::SeqCst)
    }

    fn rejected(&self) -> u64 {
        self.rejected.load(Ordering::SeqCst)
    }
}

/// Returns the lane to the pool even when the call panics or returns early.
struct LaneGuard<'a> {
    pool: &'a LanePool,
    idx: usize,
}

impl Drop for LaneGuard<'_> {
    fn drop(&mut self) {
        self.pool.lane(self.idx).touch();
        self.pool.release(self.idx);
    }
}

fn percentile(recent: &VecDeque<u64>) -> (u64, u64) {
    if recent.is_empty() {
        return (0, 0);
    }
    let mut sorted: Vec<u64> = recent.iter().copied().collect();
    sorted.sort_unstable();
    let at = |p: f64| sorted[((sorted.len() as f64 * p) as usize).min(sorted.len() - 1)];
    (at(0.5), at(0.95))
}

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

type PathLockMap = std::collections::HashMap<String, Arc<Mutex<()>>>;

fn path_locks() -> &'static Mutex<PathLockMap> {
    static LOCKS: OnceLock<Mutex<PathLockMap>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn normalize_path_key(path: &str) -> String {
    let mut key = path.replace('/', "\\");
    while key.len() > 3 && key.ends_with('\\') {
        key.pop();
    }
    key.to_lowercase()
}

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

struct RunOutcome {
    exit_code: i64,
    stdout: String,
    shell_ms: u64,
    reused: bool,
    shell: String,
}

struct Shell {
    child: Option<Child>,
    port: Option<u16>,
    kind: String,
}

impl Shell {
    fn new() -> Self {
        Self {
            child: None,
            port: None,
            kind: String::new(),
        }
    }

    fn describe() -> Value {
        let (path, kind) = resolve_powershell();
        json!({ "path": path.to_string_lossy(), "kind": kind, "transport": "loopback-tcp" })
    }

    /// Pid of the live shell server, or 0 when none is running.
    fn pid(&self) -> u32 {
        self.child.as_ref().map(|child| child.id()).unwrap_or(0)
    }

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

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.port = None;
    }

    fn start(&mut self) -> Result<(), String> {
        let (exe, kind) = resolve_powershell();
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

    fn run(&mut self, command: &str, cwd: Option<&str>, timeout: Duration) -> Result<RunOutcome, String> {
        let reused = self.ensure_alive()?;
        let port = self.port.ok_or("shell server has no port")?;
        let request = json!({ "command": command, "cwd": cwd });
        let payload = serde_json::to_vec(&request).map_err(|err| format!("encode request: {err}"))?;

        let result = self.roundtrip(port, &payload, timeout);
        if let Err(err) = &result {
            // A dead or wedged shell is replaced on the next call.
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

fn trim_trailing_newlines(mut text: String) -> String {
    while text.ends_with('\n') {
        text.pop();
    }
    text
}

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

/// Marker kept in the server script and used by the sweep below to clean old temp files.
const SHELL_MARKER: &str = "dsh-rust-worker-shell";

/// Base64 of the UTF-16LE bytes, the encoding `powershell -EncodedCommand` expects.
fn encoded_command(script: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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

impl Drop for Shell {
    fn drop(&mut self) {
        // Normal exit path: never leave the warm PowerShell behind.
        self.stop();
    }
}

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
    let script = format!(
        r#"$alive = @(Get-Process | Select-Object -ExpandProperty Id)
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object {{ $_.CommandLine -like '*-EncodedCommand*' -and ($alive -notcontains $_.ParentProcessId) }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}
Get-ChildItem $env:TEMP -Filter '{marker}-*.ps1' -ErrorAction SilentlyContinue | Where-Object {{ $_.Name -match '^{marker}-(\d+)' -and ($alive -notcontains [int]$Matches[1]) }} | Remove-Item -Force -ErrorAction SilentlyContinue"#,
        marker = SHELL_MARKER
    );
    let _ = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}
