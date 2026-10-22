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

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const MAX_FILE_BYTES: u64 = 1_500_000;
const MAX_SNIPPET_CHARS: usize = 240;
const MAX_CONTEXT_LINES: usize = 2;
const DEFAULT_TTL_MS: u64 = 10_000;

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

#[derive(Clone)]
struct Sym {
    line: u32,
    kind: u8,
    name: String,
    sig: String,
}

#[derive(Clone)]
struct Entry {
    path: String,
    size: u64,
    mtime_ms: u64,
    lines: u32,
    syms: Vec<Sym>,
}

struct Index {
    root: PathBuf,
    files: Vec<Entry>,
    symbols: usize,
    built_at_ms: u64,
    build_ms: u64,
}

struct State {
    root: Option<PathBuf>,
    index: Option<Index>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| {
        Mutex::new(State {
            root: None,
            index: None,
        })
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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

struct SymbolRule {
    kind: u8,
    re: &'static str,
}

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

/// All symbol rules compiled twice: a `RegexSet` answers "does any rule match?"
/// in one pass over the line (that is the hot path), and the per-rule regexes are
/// only run on lines the set already accepted.
struct Rules {
    set: regex::RegexSet,
    each: Vec<(u8, regex::Regex)>,
}

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

fn is_text_ext(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let lower = ext.to_ascii_lowercase();
            TEXT_EXTS.contains(&lower.as_str())
        }
        None => false,
    }
}

fn cap(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max).collect();
    out.push_str("...");
    out
}

fn looks_binary(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(8192)];
    probe.contains(&0)
}

fn extract_symbols(text: &str) -> Vec<Sym> {
    let set = rule_set();
    let mut out: Vec<Sym> = Vec::new();
    for (idx, raw) in text.lines().enumerate() {
        let line_no = (idx + 1) as u32;
        let trimmed = raw.trim_start();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') && !trimmed.starts_with("#!") {
            continue;
        }
        if trimmed.len() > 400 {
            continue;
        }
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
                break;
            }
        }
    }
    out
}

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

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_entry(root: &Path, path: &Path, meta_size: u64, meta_mtime: u64) -> Option<Entry> {
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

fn walk(root: &Path) -> Vec<(PathBuf, u64, u64)> {
    let mut out: Vec<(PathBuf, u64, u64)> = Vec::new();
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

fn build(root: &Path) -> Index {
    let started = Instant::now();
    let mut files: Vec<Entry> = Vec::new();
    for (path, size, mtime) in walk(root) {
        if let Some(entry) = read_entry(root, &path, size, mtime) {
            files.push(entry);
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let symbols = files.iter().map(|f| f.syms.len()).sum();
    Index {
        root: root.to_path_buf(),
        files,
        symbols,
        built_at_ms: now_ms(),
        build_ms: started.elapsed().as_millis() as u64,
    }
}

impl Index {
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
        for (path, size, mtime) in walk(&root) {
            let rel = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            match existing.remove(&rel) {
                Some(entry) if entry.size == size && entry.mtime_ms == mtime => files.push(entry),
                _ => {
                    if let Some(entry) = read_entry(&root, &path, size, mtime) {
                        files.push(entry);
                    }
                }
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let symbols = files.iter().map(|f| f.syms.len()).sum();
        Index {
            root,
            files,
            symbols,
            built_at_ms: now_ms(),
            build_ms: started.elapsed().as_millis() as u64,
        }
    }
}

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
}

// ---------------------------------------------------------------------------
// soft-limit controls (host-driven, see CONCURRENCY_AND_METRICS.md §2.3)
// ---------------------------------------------------------------------------

/// Set when the host measured CPU above `cpuSoftLimitPct`. Background refresh
/// stops; an explicit `refresh: true` search still rebuilds, and an already
/// built snapshot keeps serving. `exec` / `fs` are never throttled.
static PAUSED: AtomicBool = AtomicBool::new(false);

pub fn pause() {
    PAUSED.store(true, Ordering::SeqCst);
}

pub fn resume() {
    PAUSED.store(false, Ordering::SeqCst);
}

pub fn is_paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

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
fn ensure_index(refresh: bool) -> Result<(), String> {
    let mut guard = state().lock().map_err(|_| "index state poisoned")?;
    if guard.root.is_none() {
        guard.root = Some(resolve_root());
    }
    let root = guard.root.clone().unwrap_or_else(|| PathBuf::from("."));
    let stale = match &guard.index {
        None => true,
        Some(index) => now_ms().saturating_sub(index.built_at_ms) > DEFAULT_TTL_MS,
    };
    if guard.index.is_none() {
        guard.index = Some(build(&root));
        return Ok(());
    }
    if PAUSED.load(Ordering::SeqCst) && !refresh {
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

/// Minimal glob: `*` and `?` against the relative path and the basename.
fn glob_match(pattern: &str, path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    let matches = |subject: &str| -> bool {
        let (mut p, mut s) = (0usize, 0usize);
        let pat: Vec<char> = pattern.chars().collect();
        let text: Vec<char> = subject.chars().collect();
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

fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (idx, byte) in text.bytes().enumerate() {
        if byte == b'\n' && idx + 1 < text.len() {
            starts.push(idx + 1);
        }
    }
    starts
}

/// Line number (1-based) containing `offset`, given ascending line starts.
fn line_of(starts: &[usize], offset: usize) -> usize {
    match starts.binary_search(&offset) {
        Ok(idx) => idx + 1,
        Err(idx) => idx,
    }
}

fn line_slice<'a>(text: &'a str, starts: &[usize], line_no: usize) -> &'a str {
    let idx = line_no.saturating_sub(1);
    let start = *starts.get(idx).unwrap_or(&text.len());
    let end = starts
        .get(idx + 1)
        .map(|next| next.saturating_sub(1))
        .unwrap_or(text.len());
    text.get(start..end.min(text.len())).unwrap_or("")
}

fn sym_kind_name(kind: u8) -> &'static str {
    SYMBOL_KINDS.get(kind as usize).copied().unwrap_or("symbol")
}

fn truthy(params: &Value, key: &str) -> bool {
    params.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn num(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

fn text_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// methods
// ---------------------------------------------------------------------------

/// Build the index ahead of the first query (called from a startup thread).
pub fn prewarm() {
    let _ = ensure_index(false);
}

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
    })
}

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
    }))
}

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
            if seen_per_file >= 4 {
                break;
            }
            seen_per_file += 1;
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