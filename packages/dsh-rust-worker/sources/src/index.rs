//! Persistent, token-aware code index for the DSH Rust worker.
//!
//! Deliberate limits (documented in docs/rust-exec-plugin/RESULTS.md):
//! - Symbols come from regexes, not a parser. tree-sitter is a C library and this
//!   toolchain has no C compiler (windows-gnu target, no MinGW), so a heuristic
//!   index is the honest option. It may miss definitions; it never invents them.
//! - The index keeps file metadata and symbols, never full text: a 200 MB corpus
//!   must not become 200 MB of RSS. Searches re-read candidate files through the
//!   OS page cache, which the index walk just warmed.
//! - Staleness is handled three ways: `refresh: true`, a TTL, and incremental
//!   updates right after this worker writes or edits a file.
//!
//! 模块职责：为本机代码库维护一份常驻内存的轻量索引，记录每个文本文件的元数据
//! （相对路径、大小、mtime、行数）和按正则提取的符号，供 `search_text` /
//! `search_symbol` 在本进程内直接检索，避免每次查询都整树扫描。
//!
//! 核心不变量：
//! - 索引只保存元数据和符号，从不保存文件全文，因此内存占用与文件数线性相关，
//!   而与仓库体积无关；检索时按需重读候选文件，依赖 walk 预先预热的 page cache。
//! - 只有 `size` 与 `mtime_ms` 同时变化才重新解析文件内容，否则直接复用缓存条目。
//! - 磁盘缓存按 root 的规范化路径哈希绑定；换 root 不会误用旧缓存，缓存结构一旦
//!   变化必须递增 `CACHE_VERSION`。
//! - 全进程只有一个 root 和一份索引，统一由 `STATE` 的 Mutex 串行化访问。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

// 常量：单文件大小上限、摘要截断长度、上下文行数上限与索引默认 TTL。
// 超过 `MAX_FILE_BYTES` 的文件在 walk 阶段就被跳过，既不进索引也不参与检索。
const MAX_FILE_BYTES: u64 = 1_500_000;
/// 单条命中摘要最多保留的字符数，避免超长行撑爆返回体。
const MAX_SNIPPET_CHARS: usize = 240;
/// `search_text` 每条命中最多附带的上下文行数（命中行上下各按其值取）。
const MAX_CONTEXT_LINES: usize = 2;
/// 索引快照的默认存活时间；超过后下一次检索会触发增量 refresh。
const DEFAULT_TTL_MS: u64 = 30_000;
/// Bumped whenever the on-disk shape of a cached entry changes.
const CACHE_VERSION: u32 = 1;
/// Below this many files a cold build is already cheap; threads would only add noise.
const PARALLEL_MIN_FILES: usize = 32;
const MAX_PARSE_THREADS: usize = 8;

/// Text files we index and search. Anything else (binaries, images, locks) is skipped.
const TEXT_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "c", "h", "cc",
    "cpp", "hpp", "cs", "rb", "php", "swift", "scala", "sh", "bash", "ps1", "psm1", "sql", "vue",
    "svelte", "lua", "dart", "ex", "exs", "erl", "hs", "ml", "zig", "toml", "yaml", "yml", "md",
];

/// Directories that never contribute useful definitions and can be huge.
const SKIP_DIRS: &[&str] = &[
    ".git", ".svn", ".hg", "node_modules", "target", "dist", "build", "out", ".next", ".nuxt",
    "__pycache__", ".venv", "venv", ".dsh", "_bench", "_tools", "_ref", ".cache", "coverage", ".turbo",
    ".pytest_cache", ".mypy_cache", "obj", "bin",
];

const SYMBOL_KINDS: &[&str] = &[
    "fn", "class", "interface", "type", "const", "struct", "enum", "trait", "impl", "def", "mod",
];

/// 单个符号：定义所在行号、种类编号（对应 `SYMBOL_KINDS` 下标）、名称与截断后的签名。
#[derive(Clone)]
struct Sym {
    line: u32,
    kind: u8,
    name: String,
    sig: String,
}

/// 一个已索引文件的元数据：相对 root 的路径、大小、mtime、行数与符号列表；
/// 同时也是磁盘缓存的最小单元，可直接序列化为 JSON。
#[derive(Clone)]
struct Entry {
    path: String,
    size: u64,
    mtime_ms: u64,
    lines: u32,
    syms: Vec<Sym>,
}

/// 一次构建得到的只读快照：文件列表、符号总数、构建耗时，以及复用/解析计数。
struct Index {
    root: PathBuf,
    files: Vec<Entry>,
    symbols: usize,
    built_at_ms: u64,
    build_ms: u64,
    /// Files whose cached metadata matched the walk (no content read).
    reused: usize,
    /// Files actually read and parsed in this build.
    parsed: usize,
}

/// 进程级索引状态：当前绑定的 root 与最新快照；两者都由外层 Mutex 保护。
struct State {
    root: Option<PathBuf>,
    index: Option<Index>,
}

/// 全局唯一状态槽：首次访问时惰性初始化，之后不再替换。
static STATE: OnceLock<Mutex<State>> = OnceLock::new();

/// 取全局状态的锁引用；`get_or_init` 保证内部状态只初始化一次。
fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| {
        Mutex::new(State {
            root: None,
            index: None,
        })
    })
}

/// 当前 Unix 时间戳（毫秒）；系统时钟早于 epoch 等异常情况退化为 0。
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// on-disk index cache
// ---------------------------------------------------------------------------
//
// A cold build re-reads every indexed file; on Windows that first read is the
// expensive part (AV filter drivers, cold page cache), not the regex work — the
// measured 1,274-file workspace took ~83 s. The cache stores metadata + symbols
// per file and reuses an entry whenever the walk still reports the same size and
// mtime, so a worker restart costs one walk (~0.3 s) instead of a full re-read.
//
// Cache location: `DSH_RUST_INDEX_CACHE_DIR`, else `%LOCALAPPDATA%\dsh-native\index`,
// else the temp dir. One file per root, keyed by a hash of the canonical root path.

// 中文摘要：冷构建要逐个读取文件，Windows 上首次读取（杀软过滤驱动、冷 page cache）
// 才是主要成本；缓存为每个 root 保存“元数据 + 符号”，walk 后 size/mtime 未变即复用，
// 使 worker 重启从全量重读降为一次 walk。
// 缓存路径优先级：`DSH_RUST_INDEX_CACHE_DIR` > `%LOCALAPPDATA%\dsh-native\index` > 临时目录。
/// 返回缓存目录：优先环境变量覆盖，其次 LOCALAPPDATA，最后退回系统临时目录。
fn cache_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("DSH_RUST_INDEX_CACHE_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        if !local.trim().is_empty() {
            return PathBuf::from(local).join("dsh-native").join("index");
        }
    }
    std::env::temp_dir().join("dsh-native-index")
}

/// 计算 root 的规范化字符串键：统一分隔符并转小写，与 Windows 大小写不敏感语义一致。
/// Paths are compared case-insensitively on Windows, so the key is folded too.
fn root_key(root: &Path) -> String {
    root.to_string_lossy().replace('\\', "/").to_ascii_lowercase()
}

/// 由 root 键的 SHA-256 生成缓存文件名：哈希前 8 字节转十六进制，再拼上缓存版本号；
/// root 一变文件名随之改变，天然隔离不同仓库的缓存。
fn cache_path(root: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(root_key(root).as_bytes());
    let digest = hasher.finalize();
    let mut name = String::with_capacity(16);
    // 只取摘要前 8 字节：足够区分不同 root，又能让文件名保持简短。
    for byte in digest.iter().take(8) {
        name.push_str(&format!("{byte:02x}"));
    }
    cache_dir().join(format!("{name}-v{CACHE_VERSION}.json"))
}

/// 把缓存条目序列化为 JSON；符号压成 `[line, kind, name, sig]` 四元组以节省空间。
fn entry_to_json(entry: &Entry) -> Value {
    json!({
        "path": &entry.path,
        "size": entry.size,
        "mtimeMs": entry.mtime_ms,
        "lines": entry.lines,
        "syms": entry.syms.iter().map(|s| json!([s.line, s.kind, &s.name, &s.sig])).collect::<Vec<_>>(),
    })
}

/// 从缓存 JSON 还原条目；关键字段缺失或类型不符时返回 None，让该文件重新解析。
fn entry_from_json(value: &Value) -> Option<Entry> {
    let path = value.get("path")?.as_str()?.to_string();
    let size = value.get("size")?.as_u64()?;
    let mtime_ms = value.get("mtimeMs")?.as_u64()?;
    let lines = value.get("lines").and_then(Value::as_u64).unwrap_or(1) as u32;
    let mut syms: Vec<Sym> = Vec::new();
    if let Some(items) = value.get("syms").and_then(Value::as_array) {
        for item in items {
            let Some(parts) = item.as_array() else { continue };
            if parts.len() < 4 {
                continue;
            }
            syms.push(Sym {
                line: parts[0].as_u64().unwrap_or(0) as u32,
                kind: parts[1].as_u64().unwrap_or(0) as u8,
                name: parts[2].as_str().unwrap_or("").to_string(),
                sig: parts[3].as_str().unwrap_or("").to_string(),
            });
        }
    }
    Some(Entry { path, size, mtime_ms, lines, syms })
}

/// 读取并校验磁盘缓存：版本号或 root 键不匹配、文件缺失/损坏时统一返回空表，
/// 调用方据此退化为全量解析，绝不复用可能过期的数据。
fn load_cache(root: &Path) -> HashMap<String, Entry> {
    let mut out: HashMap<String, Entry> = HashMap::new();
    let Ok(bytes) = fs::read(cache_path(root)) else { return out };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { return out };
    if value.get("version").and_then(Value::as_u64) != Some(CACHE_VERSION as u64) {
        return out;
    }
    let cached_root = value.get("root").and_then(Value::as_str).unwrap_or("");
    if !cached_root.eq_ignore_ascii_case(&root_key(root)) {
        return out;
    }
    let Some(files) = value.get("files").and_then(Value::as_array) else { return out };
    for file in files {
        if let Some(entry) = entry_from_json(file) {
            out.insert(entry.path.clone(), entry);
        }
    }
    out
}

/// 把本轮回填后的完整文件列表写回磁盘；列表为空时直接跳过，避免生成空缓存。
fn save_cache(root: &Path, files: &[Entry]) {
    if files.is_empty() {
        return;
    }
    let dir = cache_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let body = json!({
        "version": CACHE_VERSION,
        "root": root_key(root),
        "savedAtMs": now_ms(),
        "files": files.iter().map(entry_to_json).collect::<Vec<Value>>(),
    });
    let Ok(bytes) = serde_json::to_vec(&body) else { return };
    let path = cache_path(root);
    let tmp = path.with_extension("tmp");
    // 先写同目录的 .tmp 再 rename：同一卷上的 rename 近似原子，进程崩溃最多留下
    // 一个 .tmp，读者永远不会看到写了一半的 JSON。
    // Write-then-rename so a crashed save never leaves a half-parsed cache.
    if fs::write(&tmp, &bytes).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

/// 缓存落盘的去抖间隔（毫秒）：写完只标脏，由唯一的后台线程合并提交。
/// 为什么需要它：一次写入原本会同步重写整份缓存（本机 153 文件 = 45 KB，大仓库是几 MB），
/// 连续写十个文件就是十次全量序列化 + 十次落盘，而缓存只是"下次启动别重解析"的提示。
const CACHE_FLUSH_DEBOUNCE_MS: u64 = 500;

/// 是否有尚未落盘的索引变更。
static CACHE_DIRTY: AtomicBool = AtomicBool::new(false);

/// 标记缓存为脏，并按需拉起唯一的后台落盘线程；最多每 `CACHE_FLUSH_DEBOUNCE_MS` 落一次盘。
/// 返回 false 表示后台线程起不来，调用方应退回同步落盘——"省一次磁盘写"不能变成"永远不写缓存"。
/// 约束：落盘失败不影响正确性——缓存缺失时下次启动退化为全量解析，绝不返回旧数据。
fn mark_cache_dirty() -> bool {
    CACHE_DIRTY.store(true, Ordering::SeqCst);
    static STARTED: OnceLock<bool> = OnceLock::new();
    *STARTED.get_or_init(|| {
        std::thread::Builder::new()
            .name("index-cache-flush".to_string())
            .spawn(|| loop {
                std::thread::sleep(Duration::from_millis(CACHE_FLUSH_DEBOUNCE_MS));
                if !CACHE_DIRTY.swap(false, Ordering::SeqCst) {
                    continue;
                }
                let Ok(guard) = state().lock() else { continue };
                if let Some(index) = guard.index.as_ref() {
                    save_cache(&index.root, &index.files);
                }
            })
            .is_ok()
    })
}

/// 解析索引根目录：优先 `DSH_RUST_INDEX_ROOT`，否则取进程当前工作目录。
fn resolve_root() -> PathBuf {
    if let Ok(explicit) = std::env::var("DSH_RUST_INDEX_ROOT") {
        if !explicit.trim().is_empty() {
            return PathBuf::from(explicit);
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

// ---------------------------------------------------------------------------
// symbol extraction (heuristic)
// ---------------------------------------------------------------------------

/// 一条符号规则：捕捉组 1 为符号名，`kind` 是 `SYMBOL_KINDS` 的下标。
struct SymbolRule {
    kind: u8,
    re: &'static str,
}

/// 规则表按语言分组、按优先级排列，同一行只采纳第一条命中的规则。
/// Patterns are anchored to the start of a trimmed line and capture the name in
/// group 1. Order matters: earlier rules win for a given line.
const RULES: &[SymbolRule] = &[
    // Rust
    SymbolRule { kind: 0, re: r#"^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+"C"\s+)?fn\s+([A-Za-z_]\w*)"# },
    SymbolRule { kind: 5, re: r#"^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)"# },
    SymbolRule { kind: 6, re: r#"^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)"# },
    SymbolRule { kind: 7, re: r#"^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)"# },
    SymbolRule { kind: 8, re: r#"^impl(?:<[^>]*>)?\s+(?:[\w:<>,\s]+\s+for\s+)?([A-Za-z_]\w*)"# },
    SymbolRule { kind: 10, re: r#"^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)"# },
    // JS / TS
    SymbolRule { kind: 0, re: r#"^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)"# },
    SymbolRule { kind: 1, re: r#"^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)"# },
    SymbolRule { kind: 2, re: r#"^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)"# },
    SymbolRule { kind: 3, re: r#"^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]"# },
    SymbolRule { kind: 4, re: r#"^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)"# },
    // Python
    SymbolRule { kind: 9, re: r#"^(?:async\s+)?def\s+(\w+)"# },
    SymbolRule { kind: 1, re: r#"^class\s+(\w+)"# },
];

/// 预编译后的规则集合：`RegexSet` 负责一次扫描快速判定，逐条正则只在命中后执行。
/// All symbol rules compiled twice: a `RegexSet` answers "does any rule match?"
/// in one pass over the line (that is the hot path), and the per-rule regexes are
/// only run on lines the set already accepted.
struct Rules {
    set: regex::RegexSet,
    each: Vec<(u8, regex::Regex)>,
}

/// 惰性构造全局规则集合；规则是常量，编译失败属于编码错误，因此直接 expect 崩溃。
fn rule_set() -> &'static Rules {
    static SET: OnceLock<Rules> = OnceLock::new();
    SET.get_or_init(|| {
        let patterns: Vec<&str> = RULES.iter().map(|rule| rule.re).collect();
        let set = regex::RegexSet::new(&patterns).expect("symbol rules must compile");
        let each = RULES
            .iter()
            .filter_map(|rule| regex::Regex::new(rule.re).ok().map(|re| (rule.kind, re)))
            .collect();
        Rules { set, each }
    })
}

/// 判断扩展名是否属于可索引的文本类型；无扩展名的文件一律视为非文本。
fn is_text_ext(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let lower = ext.to_ascii_lowercase();
            TEXT_EXTS.contains(&lower.as_str())
        }
        None => false,
    }
}

/// 按字符（而非字节）截断文本并补省略号，避免切断 UTF-8 多字节字符。
fn cap(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max).collect();
    out.push_str("...");
    out
}

/// 粗略判断二进制：只看前 8 KiB 是否含 NUL 字节，足以过滤绝大多数二进制文件。
fn looks_binary(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(8192)];
    probe.contains(&0)
}

/// 逐行提取符号：先用 `RegexSet` 筛掉无关行，再按规则顺序取第一条命中，每行最多
/// 产出一个符号；注释行与超长行会被跳过。
fn extract_symbols(text: &str) -> Vec<Sym> {
    let set = rule_set();
    let mut out: Vec<Sym> = Vec::new();
    for (idx, raw) in text.lines().enumerate() {
        let line_no = (idx + 1) as u32;
        let trimmed = raw.trim_start();
        // 跳过空行、`//` 注释与 `#` 注释，但保留 `#!` 开头的 shebang 行。
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') && !trimmed.starts_with("#!") {
            continue;
        }
        // 超长行多为压缩产物或数据行，匹配符号的意义不大。
        if trimmed.len() > 400 {
            continue;
        }
        // `RegexSet` 只回答“有没有规则命中”，真正的捕获在下面逐条进行。
        if !set.set.is_match(trimmed) {
            continue;
        }
        for (kind, re) in &set.each {
            if let Some(caps) = re.captures(trimmed) {
                if let Some(name) = caps.get(1) {
                    out.push(Sym {
                        line: line_no,
                        kind: *kind,
                        name: name.as_str().to_string(),
                        sig: cap(trimmed, 160),
                    });
                }
                // 同一行只记录第一个命中的规则，避免一个定义被重复计入。
                break;
            }
        }
    }
    out
}

/// 统计行数：按 `\n` 计数，末行无换行符时补 1；空文件也返回 1。
fn count_lines(bytes: &[u8]) -> u32 {
    let mut n = 0u32;
    for b in bytes {
        if *b == b'\n' {
            n += 1;
        }
    }
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        n += 1;
    }
    n.max(1)
}

/// 读取文件 mtime 并转成毫秒时间戳；不可用时返回 0，会迫使该文件下次重新解析。
fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 读取并解析单个文件生成缓存条目；超限、二进制或读取失败时返回 None。
fn read_entry(root: &Path, path: &Path, meta_size: u64, meta_mtime: u64) -> Option<Entry> {
    // 超过 `MAX_FILE_BYTES` 的文件直接放弃，避免巨型文件拖垮一次构建。
    if meta_size > MAX_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if looks_binary(&bytes) {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    let rel = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    Some(Entry {
        path: rel,
        size: meta_size,
        mtime_ms: meta_mtime,
        lines: count_lines(&bytes),
        syms: extract_symbols(&text),
    })
}

/// 迭代遍历 root，返回 `(绝对路径, 大小, mtime_ms)`；只挑选文本文件，
/// 跳过 `SKIP_DIRS` 里的目录和超限文件，此阶段不读取文件内容。
fn walk(root: &Path) -> Vec<(PathBuf, u64, u64)> {
    let mut out: Vec<(PathBuf, u64, u64)> = Vec::new();
    // 用显式栈代替递归，避免深目录树导致栈溢出。
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for item in rd.flatten() {
            let path = item.path();
            let Ok(meta) = item.metadata() else { continue };
            if meta.is_dir() {
                let name = item.file_name().to_string_lossy().to_ascii_lowercase();
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !meta.is_file() || !is_text_ext(&path) || meta.len() > MAX_FILE_BYTES {
                continue;
            }
            out.push((path, meta.len(), mtime_ms(&meta)));
        }
    }
    out
}

/// 只解析缓存无法回答的文件；文件数达到 `PARALLEL_MIN_FILES` 时按线程切块并行，
/// 结果顺序无关紧要，`build` 之后会统一按路径排序。
/// Parse the files that the cache could not answer for, in parallel when there
/// are enough of them. Pure CPU + `fs::read`, so threads scale cleanly; the
/// join order of the results does not matter because `build` sorts afterwards.
fn parse_files(root: &Path, todo: Vec<(PathBuf, u64, u64)>) -> Vec<Entry> {
    // 线程数取可用并行度并夹在 1..=MAX_PARSE_THREADS；单线程或文件太少时直接串行。
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .clamp(1, MAX_PARSE_THREADS);
    if workers == 1 || todo.len() < PARALLEL_MIN_FILES {
        return todo
            .into_iter()
            .filter_map(|(path, size, mtime)| read_entry(root, &path, size, mtime))
            .collect();
    }
    // 向上取整切块，保证最后一个线程也能分到文件；每块独立 move 进线程。
    let chunk = todo.len().div_ceil(workers);
    let mut handles = Vec::with_capacity(workers);
    let mut rest = todo;
    while !rest.is_empty() {
        let take = rest.len().min(chunk);
        let batch: Vec<(PathBuf, u64, u64)> = rest.drain(..take).collect();
        let root = root.to_path_buf();
        handles.push(std::thread::spawn(move || -> Vec<Entry> {
            batch
                .into_iter()
                .filter_map(|(path, size, mtime)| read_entry(&root, &path, size, mtime))
                .collect()
        }));
    }
    let mut out: Vec<Entry> = Vec::new();
    for handle in handles {
        if let Ok(entries) = handle.join() {
            out.extend(entries);
        }
    }
    out
}

/// 从磁盘构建一份新索引：先 walk 拿元数据，再与缓存逐条比对，size 与 mtime 都
/// 未变的条目直接复用，其余交给 `parse_files`，最后把完整列表写回缓存。
fn build(root: &Path) -> Index {
    let started = Instant::now();
    let walked = walk(root);
    let mut cached = load_cache(root);
    let mut files: Vec<Entry> = Vec::with_capacity(walked.len());
    let mut todo: Vec<(PathBuf, u64, u64)> = Vec::new();
    for (path, size, mtime) in walked {
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        // 缓存命中要求大小与 mtime 同时相等；任一项变化就重读，宁可多解析
        // 也不能返回已过期的符号。
        match cached.remove(&rel) {
            Some(entry) if entry.size == size && entry.mtime_ms == mtime => files.push(entry),
            _ => todo.push((path, size, mtime)),
        }
    }
    let reused = files.len();
    let parsed_entries = parse_files(root, todo);
    let parsed = parsed_entries.len();
    files.extend(parsed_entries);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let symbols = files.iter().map(|f| f.syms.len()).sum();
    save_cache(root, &files);
    Index {
        root: root.to_path_buf(),
        files,
        symbols,
        built_at_ms: now_ms(),
        build_ms: started.elapsed().as_millis() as u64,
        reused,
        parsed,
    }
}

impl Index {
    /// 重新 walk 并只重读 size/mtime 变化的文件，其余条目沿用当前快照。
    /// Walk again but re-read only files whose size or mtime moved.
    fn refresh(self) -> Index {
        let started = Instant::now();
        let root = self.root.clone();
        let mut existing: HashMap<String, Entry> = self
            .files
            .into_iter()
            .map(|entry| (entry.path.clone(), entry))
            .collect();
        let mut files: Vec<Entry> = Vec::new();
        let mut todo: Vec<(PathBuf, u64, u64)> = Vec::new();
        for (path, size, mtime) in walk(&root) {
            let rel = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            match existing.remove(&rel) {
                Some(entry) if entry.size == size && entry.mtime_ms == mtime => files.push(entry),
                _ => todo.push((path, size, mtime)),
            }
        }
        let reused = files.len();
        let parsed_entries = parse_files(&root, todo);
        let parsed = parsed_entries.len();
        files.extend(parsed_entries);
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let symbols = files.iter().map(|f| f.syms.len()).sum();
        save_cache(&root, &files);
        Index {
            root,
            files,
            symbols,
            built_at_ms: now_ms(),
            build_ms: started.elapsed().as_millis() as u64,
            reused,
            parsed,
        }
    }
}

/// 本 worker 写入或编辑某个文件后立刻做单文件增量更新，避免下次检索读到旧符号。
/// Re-index one file after this worker wrote or edited it.
pub fn note_change(path: &str) {
    let mut guard = match state().lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let Some(index) = guard.index.as_mut() else { return };
    let root = index.root.clone();
    let abs = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    let rel = abs
        .strip_prefix(&root)
        .unwrap_or(&abs)
        .to_string_lossy()
        .replace('\\', "/");
    // 先移除旧条目，再按当前磁盘状态重新解析后插回，保持列表按路径有序。
    index.files.retain(|entry| entry.path != rel);
    if let Ok(meta) = fs::metadata(&abs) {
        if meta.is_file() {
            if let Some(entry) = read_entry(&root, &abs, meta.len(), mtime_ms(&meta)) {
                index.files.push(entry);
                index.files.sort_by(|a, b| a.path.cmp(&b.path));
            }
        }
    }
    index.symbols = index.files.iter().map(|f| f.syms.len()).sum();
    // 内存里的条目已经是最新的；磁盘缓存合并到后台线程，别让一次写文件等一次全量落盘。
    if !mark_cache_dirty() {
        save_cache(&root, &index.files);
    }
}

// ---------------------------------------------------------------------------
// soft-limit controls (host-driven, see CONCURRENCY_AND_METRICS.md §2.3)
// ---------------------------------------------------------------------------

/// 软限流开关：host 测到 CPU 超过 `cpuSoftLimitPct` 时置位，暂停后台重建。
/// Set when the host measured CPU above `cpuSoftLimitPct`. Background refresh
/// stops; an explicit `refresh: true` search still rebuilds, and an already
/// built snapshot keeps serving. `exec` / `fs` are never throttled.
static PAUSED: AtomicBool = AtomicBool::new(false);

/// 置位暂停标记：后台刷新停止，但显式 `refresh: true` 与已构建快照不受影响。
pub fn pause() {
    PAUSED.store(true, Ordering::SeqCst);
}

/// 清除暂停标记，恢复后台刷新能力。
pub fn resume() {
    PAUSED.store(false, Ordering::SeqCst);
}

/// 查询当前是否处于软限流暂停状态。
pub fn is_paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

/// 丢弃内存索引并返回释放掉的文件/符号数量；下次检索会惰性重建，因此总是安全的。
/// Drop the in-memory index: its file/symbol vectors dominate worker RSS, and
/// the next search rebuilds lazily, so this is always safe to call.
pub fn drop_index() -> Value {
    let (files, symbols) = match state().lock() {
        Ok(mut guard) => match guard.index.take() {
            Some(index) => (index.files.len(), index.symbols),
            None => (0, 0),
        },
        Err(_) => (0, 0),
    };
    json!({
        "droppedFiles": files,
        "droppedSymbols": symbols,
        "paused": is_paused(),
    })
}

/// Make sure an index exists; rebuild/refresh according to `refresh` and the TTL.
/// 确保索引可用：首次调用构建，之后按 `refresh` 与 TTL 决定是否增量刷新；
/// 处于暂停状态且未显式要求刷新时，直接沿用旧快照。
fn ensure_index(refresh: bool) -> Result<(), String> {
    let mut guard = state().lock().map_err(|_| "index state poisoned")?;
    if guard.root.is_none() {
        guard.root = Some(resolve_root());
    }
    let root = guard.root.clone().unwrap_or_else(|| PathBuf::from("."));
    // 过期判定：没有索引，或距上次构建超过 `DEFAULT_TTL_MS`，都视为 stale。
    let stale = match &guard.index {
        None => true,
        Some(index) => now_ms().saturating_sub(index.built_at_ms) > DEFAULT_TTL_MS,
    };
    if guard.index.is_none() {
        guard.index = Some(build(&root));
        return Ok(());
    }
    if PAUSED.load(Ordering::SeqCst) && !refresh {
        // 中文补充：暂停期间不重新 walk，把 CPU 让给前台工具。
        // Soft CPU limit: serve the existing snapshot instead of re-walking.
        return Ok(());
    }
    if refresh || stale {
        let current = guard.index.take().expect("index checked above");
        guard.index = Some(current.refresh());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// query helpers
// ---------------------------------------------------------------------------

/// 极简 glob 匹配：仅支持 `*` 与 `?`，相对路径或 basename 任一命中即算匹配。
/// Minimal glob: `*` and `?` against the relative path and the basename.
fn glob_match(pattern: &str, path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    let matches = |subject: &str| -> bool {
        let (mut p, mut s) = (0usize, 0usize);
        let pat: Vec<char> = pattern.chars().collect();
        let text: Vec<char> = subject.chars().collect();
        // 双指针 + 记录最近一个 `*` 的位置，回溯时从标记处继续，避免指数级匹配。
        let (mut star, mut mark) = (usize::MAX, 0usize);
        while s < text.len() {
            if p < pat.len() && (pat[p] == '?' || pat[p] == text[s]) {
                p += 1;
                s += 1;
            } else if p < pat.len() && pat[p] == '*' {
                star = p;
                mark = s;
                p += 1;
            } else if star != usize::MAX {
                p = star + 1;
                mark += 1;
                s = mark;
            } else {
                return false;
            }
        }
        while p < pat.len() && pat[p] == '*' {
            p += 1;
        }
        p == pat.len()
    };
    matches(path) || matches(base)
}

/// 计算每行的起始字节偏移；末尾换行之后若已到文件尾，就不再追加空行。
fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (idx, byte) in text.bytes().enumerate() {
        if byte == b'\n' && idx + 1 < text.len() {
            starts.push(idx + 1);
        }
    }
    starts
}

/// 由字节偏移定位 1-based 行号；偏移恰好落在行首时取该行。
/// Line number (1-based) containing `offset`, given ascending line starts.
fn line_of(starts: &[usize], offset: usize) -> usize {
    match starts.binary_search(&offset) {
        Ok(idx) => idx + 1,
        Err(idx) => idx,
    }
}

/// 截取第 `line_no` 行（1-based）的文本且不含行尾换行符；越界返回空串。
fn line_slice<'a>(text: &'a str, starts: &[usize], line_no: usize) -> &'a str {
    let idx = line_no.saturating_sub(1);
    let start = *starts.get(idx).unwrap_or(&text.len());
    let end = starts
        .get(idx + 1)
        .map(|next| next.saturating_sub(1))
        .unwrap_or(text.len());
    text.get(start..end.min(text.len())).unwrap_or("")
}

/// 把符号种类编号翻译成名字；越界编号统一回落为 "symbol"。
fn sym_kind_name(kind: u8) -> &'static str {
    SYMBOL_KINDS.get(kind as usize).copied().unwrap_or("symbol")
}

/// 读取布尔参数，缺失或类型不符时视为 false。
fn truthy(params: &Value, key: &str) -> bool {
    params.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// 读取无符号整数参数，缺失或类型不符时返回 None。
fn num(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

/// 读取字符串参数，缺失或类型不符时返回 None。
fn text_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// methods
// ---------------------------------------------------------------------------

/// 预热：由启动线程提前构建索引，让首次检索不必等待冷构建。
/// Build the index ahead of the first query (called from a startup thread).
pub fn prewarm() {
    let _ = ensure_index(false);
}

/// 非阻塞地取状态快照，供 health/metrics 使用；只报告当前持有的索引，不等待构建。
/// Non-blocking snapshot for health/metrics payloads: reports whatever the
/// index currently holds instead of waiting for a build or refresh.
pub fn status_value() -> Value {
    let Ok(guard) = state().lock() else {
        return json!({ "ready": false, "error": "index state poisoned" });
    };
    let Some(index) = guard.index.as_ref() else {
        return json!({ "ready": false, "stale": true, "paused": is_paused() });
    };
    json!({
        "ready": true,
        "files": index.files.len(),
        "symbols": index.symbols,
        "buildMs": index.build_ms,
        "ageMs": now_ms().saturating_sub(index.built_at_ms),
        "ttlMs": DEFAULT_TTL_MS,
        "paused": is_paused(),
        "reusedFiles": index.reused,
        "parsedFiles": index.parsed,
        "cachePath": cache_path(&index.root).to_string_lossy(),
    })
}

/// 查询索引状态：按 `refresh` 参数确保索引最新，返回文件数、符号数、TTL 与缓存路径。
pub fn status(params: &Value) -> Result<Value, String> {
    ensure_index(truthy(params, "refresh"))?;
    let guard = state().lock().map_err(|_| "index state poisoned")?;
    let Some(index) = guard.index.as_ref() else {
        return Ok(json!({ "ready": false, "paused": is_paused() }));
    };
    Ok(json!({
        "ready": true,
        "root": index.root.to_string_lossy(),
        "files": index.files.len(),
        "symbols": index.symbols,
        "buildMs": index.build_ms,
        "ageMs": now_ms().saturating_sub(index.built_at_ms),
        "ttlMs": DEFAULT_TTL_MS,
        "paused": is_paused(),
        "reusedFiles": index.reused,
        "parsedFiles": index.parsed,
        "cachePath": cache_path(&index.root).to_string_lossy(),
    }))
}

/// 文本检索：对索引内文件逐字节或按正则查找，按 rank 排序，并做条数与总字节双重截断。
pub fn search_text(params: &Value) -> Result<Value, String> {
    let query = text_param(params, "query").ok_or("query is required")?;
    if query.trim().is_empty() {
        return Err("query must not be empty".to_string());
    }
    let refresh = truthy(params, "refresh");
    let is_regex = truthy(params, "regex");
    let symbols_only = truthy(params, "symbolsOnly");
    let context_lines = (num(params, "contextLines").unwrap_or(1) as usize).min(MAX_CONTEXT_LINES);
    let max_hits = (num(params, "maxHits").unwrap_or(24) as usize).clamp(1, 120);
    let max_bytes = (num(params, "maxBytes").unwrap_or(6000) as usize).clamp(400, 60_000);
    let glob = text_param(params, "glob");

    ensure_index(refresh)?;
    let started = Instant::now();
    let compiled = if is_regex {
        Some(regex::Regex::new(&query).map_err(|err| format!("bad regex: {err}"))?)
    } else {
        None
    };

    let (root, files) = {
        let guard = state().lock().map_err(|_| "index state poisoned")?;
        let index = guard.index.as_ref().ok_or("index unavailable")?;
        (index.root.clone(), index.files.clone())
    };

    let mut hits: Vec<(i64, String, usize, u8, String, String)> = Vec::new();
    let mut files_scanned = 0usize;
    let mut files_matched = 0usize;
    let query_lower = query.to_ascii_lowercase();

    for entry in &files {
        if let Some(pattern) = glob.as_ref() {
            if !glob_match(pattern, &entry.path) {
                continue;
            }
        }
        files_scanned += 1;
        let Ok(bytes) = fs::read(root.join(&entry.path)) else { continue };
        if looks_binary(&bytes) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let mut starts_cache: Option<Vec<usize>> = None;
        let mut hit_lines: Vec<(usize, bool)> = Vec::new();
        match &compiled {
            Some(re) => {
                for found in re.find_iter(&text) {
                    let starts = starts_cache.get_or_insert_with(|| line_starts(&text));
                    hit_lines.push((line_of(starts, found.start()), false));
                }
            }
            None => {
                for found in memchr::memmem::find_iter(bytes.as_slice(), query.as_bytes()) {
                    let starts = starts_cache.get_or_insert_with(|| line_starts(&text));
                    hit_lines.push((line_of(starts, found), false));
                }
            }
        }
        if hit_lines.is_empty() {
            continue;
        }
        files_matched += 1;
        let starts = starts_cache.unwrap_or_else(|| line_starts(&text));
        let basename_lower = entry.path.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
        let path_lower = entry.path.to_ascii_lowercase();
        let mut seen_per_file = 0usize;
        for (line_no, _) in hit_lines {
            if symbols_only {
                let is_sym = entry.syms.iter().any(|sym| sym.line as usize == line_no);
                if !is_sym {
                    continue;
                }
            }
            // 每个文件最多返回 4 条命中，避免单个热点文件挤占整个结果集。
            if seen_per_file >= 4 {
                break;
            }
            seen_per_file += 1;
            // rank 加权：basename 命中 +5，路径命中 +2，命中行本身是符号定义再 +4。
            let mut rank = 0i64;
            if basename_lower.contains(&query_lower) {
                rank += 5;
            }
            if path_lower.contains(&query_lower) {
                rank += 2;
            }
            let kind = entry
                .syms
                .iter()
                .find(|sym| sym.line as usize == line_no)
                .map(|sym| sym.kind);
            if kind.is_some() {
                rank += 4;
            }
            let line_text = cap(line_slice(&text, &starts, line_no), MAX_SNIPPET_CHARS);
            let before_from = line_no.saturating_sub(context_lines).max(1);
            let after_to = line_no + context_lines;
            let mut context: Vec<String> = Vec::new();
            for ctx_line in before_from..line_no {
                context.push(format!("{}| {}", ctx_line, cap(line_slice(&text, &starts, ctx_line), MAX_SNIPPET_CHARS)));
            }
            for ctx_line in line_no + 1..=after_to.min(starts.len()) {
                context.push(format!("{}| {}", ctx_line, cap(line_slice(&text, &starts, ctx_line), MAX_SNIPPET_CHARS)));
            }
            let kind_name = match kind {
                Some(kind) => sym_kind_name(kind).to_string(),
                None => String::new(),
            };
            hits.push((rank, entry.path.clone(), line_no, kind.unwrap_or(255), kind_name, format!("{line_text}\u{1}{}", context.join("\n"))));
        }
    }

    hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.cmp(&b.2)));

    let total = hits.len();
    let mut out_hits: Vec<Value> = Vec::new();
    let mut used = 0usize;
    for (rank, path, line_no, _kind, kind_name, payload) in hits {
        let (snippet, context) = payload.split_once('\u{1}').unwrap_or((payload.as_str(), ""));
        let entry_len = path.len() + snippet.len() + context.len() + 40;
        if !out_hits.is_empty() && used + entry_len > max_bytes {
            continue;
        }
        used += entry_len;
        out_hits.push(json!({
            "path": path,
            "line": line_no,
            "kind": kind_name,
            "text": snippet,
            "context": context,
            "rank": rank,
        }));
        if out_hits.len() >= max_hits {
            break;
        }
    }

    Ok(json!({
        "query": query,
        "root": root.to_string_lossy(),
        "hits": out_hits,
        "shown": out_hits.len(),
        "totalHits": total,
        "filesScanned": files_scanned,
        "filesMatched": files_matched,
        "truncated": out_hits.len() < total,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}

/// 符号检索：只查索引内的符号表而不读文件；按名称精确/前缀/包含评分后排序截断。
pub fn search_symbol(params: &Value) -> Result<Value, String> {
    ensure_index(truthy(params, "refresh"))?;
    let query = text_param(params, "query").map(|q| q.to_ascii_lowercase());
    let path_filter = text_param(params, "path");
    let kind_filter = text_param(params, "kind").map(|k| k.to_ascii_lowercase());
    let limit = (num(params, "limit").unwrap_or(40) as usize).clamp(1, 200);
    let max_bytes = (num(params, "maxBytes").unwrap_or(6000) as usize).clamp(400, 60_000);
    let started = Instant::now();

    let (root, files) = {
        let guard = state().lock().map_err(|_| "index state poisoned")?;
        let index = guard.index.as_ref().ok_or("index unavailable")?;
        (index.root.clone(), index.files.clone())
    };

    let mut out: Vec<(i64, Value)> = Vec::new();
    let mut total_matched = 0usize;
    let mut files_seen = 0usize;
    for entry in &files {
        if let Some(path) = path_filter.as_ref() {
            if !entry.path.ends_with(path.as_str()) && !entry.path.contains(path.as_str()) {
                continue;
            }
        }
        if entry.syms.is_empty() {
            continue;
        }
        files_seen += 1;
        for sym in &entry.syms {
            if let Some(query) = query.as_ref() {
                let name = sym.name.to_ascii_lowercase();
                // rank 加权：名称完全相等 +8，前缀匹配 +5，包含匹配 +2；文件名也命中再 +2。
                let mut rank = 0i64;
                if name == *query {
                    rank += 8;
                } else if name.starts_with(query.as_str()) {
                    rank += 5;
                } else if name.contains(query.as_str()) {
                    rank += 2;
                } else {
                    continue;
                }
                if entry.path.rsplit('/').next().unwrap_or("").to_ascii_lowercase().contains(query.as_str()) {
                    rank += 2;
                }
                total_matched += 1;
                out.push((rank, json!({
                    "path": entry.path,
                    "line": sym.line,
                    "kind": sym_kind_name(sym.kind),
                    "name": sym.name,
                    "sig": sym.sig,
                })));
            } else {
                if let Some(kind) = kind_filter.as_ref() {
                    if sym_kind_name(sym.kind) != kind.as_str() {
                        continue;
                    }
                }
                total_matched += 1;
                out.push((0, json!({
                    "path": entry.path,
                    "line": sym.line,
                    "kind": sym_kind_name(sym.kind),
                    "name": sym.name,
                    "sig": sym.sig,
                })));
            }
        }
    }

    out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| {
        a.1["path"].as_str().unwrap_or("").cmp(b.1["path"].as_str().unwrap_or(""))
    }).then_with(|| {
        a.1["line"].as_u64().unwrap_or(0).cmp(&b.1["line"].as_u64().unwrap_or(0))
    }));

    let mut symbols: Vec<Value> = Vec::new();
    let mut used = 0usize;
    for (_rank, value) in out {
        let size = value["path"].as_str().map(|s| s.len()).unwrap_or(0)
            + value["sig"].as_str().map(|s| s.len()).unwrap_or(0)
            + 40;
        if !symbols.is_empty() && used + size > max_bytes {
            continue;
        }
        used += size;
        symbols.push(value);
        if symbols.len() >= limit {
            break;
        }
    }

    Ok(json!({
        "root": root.to_string_lossy(),
        "symbols": symbols,
        "shown": symbols.len(),
        "totalMatched": total_matched,
        "filesConsidered": files_seen,
        "truncated": symbols.len() < total_matched,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}