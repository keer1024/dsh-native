//! Session log projection: read an append-only `.jsonl.zstd` session log, decode every
//! Zstandard frame, fold the records into a compact per-message projection, cache it on disk
//! keyed by (path, size, mtime), and serve it in cursor pages.
//!
//! Segment timings are returned so the caller can see which leg dominates:
//!   readMs  — read the compressed log from disk
//!   decodeMs — zstd frame decoding
//!   parseMs — JSON parsing of each record
//!   projectMs — record folding into the projection
//!   cacheLoadMs — reading a warm projection snapshot (cacheHit = true short-circuits the above)

use serde::de::{Deserializer, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::borrow::Cow;
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const PROJECTION_VERSION: u32 = 2;
const PREVIEW_CHARS: usize = 180;

static NULL: Value = Value::Null;

/// DSH appends one independent Zstandard frame per batch of records, so a session log is a
/// concatenation of frames, not one frame. `StreamingDecoder` reads a single frame, so walk the
/// frame boundaries from the format's block headers and decode each frame separately.
fn split_frames(buf: &[u8]) -> Result<Vec<(usize, usize)>, String> {
    let mut frames = Vec::new();
    let mut pos = 0usize;
    let len = buf.len();
    while pos + 8 <= len {
        let magic = u32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]);
        if magic & 0xFFFF_FFF0 == 0x184D_2A50 {
            // Skippable frame: 4-byte magic + 4-byte user size + payload.
            let size = u32::from_le_bytes([buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]]) as usize;
            let end = pos + 8 + size;
            if end > len {
                return Err(format!("truncated skippable frame at {pos}"));
            }
            pos = end;
            continue;
        }
        if magic != 0xFD2F_B528 {
            return Err(format!("bad zstd magic 0x{magic:08x} at {pos}"));
        }
        let start = pos;
        let mut p = pos + 4;
        if p >= len {
            return Err(format!("truncated frame header at {start}"));
        }
        let descriptor = buf[p];
        p += 1;
        let fcs_flag = (descriptor >> 6) & 3;
        let single_segment = (descriptor >> 5) & 1 == 1;
        let checksum = (descriptor >> 2) & 1 == 1;
        let dict_flag = descriptor & 3;
        if !single_segment {
            p += 1; // Window_Descriptor
        }
        p += match dict_flag {
            0 => 0,
            1 => 1,
            2 => 2,
            _ => 4,
        };
        let fcs_len: usize = if single_segment {
            match fcs_flag {
                0 => 1,
                1 => 2,
                2 => 4,
                _ => 8,
            }
        } else {
            match fcs_flag {
                0 => 0,
                1 => 2,
                2 => 4,
                _ => 8,
            }
        };
        p += fcs_len;
        loop {
            if p + 3 > len {
                return Err(format!("truncated block header at {p}"));
            }
            let header = buf[p] as u32 | ((buf[p + 1] as u32) << 8) | ((buf[p + 2] as u32) << 16);
            p += 3;
            let last = header & 1 == 1;
            let block_type = (header >> 1) & 3;
            let block_size = (header >> 3) as usize;
            p += match block_type {
                1 => 1,          // RLE
                3 => return Err(format!("reserved block type at {p}")),
                _ => block_size, // raw or compressed
            };
            if p > len {
                return Err(format!("truncated block payload at {p}"));
            }
            if last {
                break;
            }
        }
        if checksum {
            p += 4;
        }
        if p > len {
            return Err(format!("truncated frame end at {p}"));
        }
        frames.push((start, p));
        pos = p;
    }
    if frames.is_empty() {
        return Err("no zstd frames found".to_string());
    }
    Ok(frames)
}

fn decode_frame_range(compressed: &[u8], frames: &[(usize, usize)]) -> Result<String, String> {
    let mut out = String::new();
    for (start, end) in frames {
        let mut slice = &compressed[*start..*end];
        let mut decoder = ruzstd::decoding::StreamingDecoder::new(&mut slice)
            .map_err(|error| format!("zstd frame init failed at {start}: {error:?}"))?;
        decoder
            .read_to_string(&mut out)
            .map_err(|error| format!("zstd frame decode failed at {start}: {error}"))?;
    }
    Ok(out)
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn file_meta(path: &Path) -> (u64, u64) {
    match fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (meta.len(), mtime)
        }
        Err(_) => (0, 0),
    }
}

fn cache_root() -> PathBuf {
    if let Ok(dir) = std::env::var("DSH_RUST_CACHE_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(home) = std::env::var("DSH_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join("cache").join("rust-exec-sessions");
        }
    }
    std::env::temp_dir().join("dsh-rust-exec-sessions")
}

fn cache_path_for(log: &Path) -> PathBuf {
    let stem = log.file_name().and_then(|s| s.to_str()).unwrap_or("session");
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(log.to_string_lossy().as_bytes());
        let out = hasher.finalize();
        out.iter().take(8).map(|b| format!("{b:02x}")).collect::<String>()
    };
    cache_root().join(format!("{stem}-{digest}.v2.json"))
}

// ---- streaming record model: typed structs instead of serde_json::Value DOM ----

#[derive(Deserialize, Default)]
struct BlockStats<'a> {
    #[serde(default, rename = "type", borrow)]
    kind: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    text: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    reasoning: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    arguments: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    name: Option<Cow<'a, str>>,
}

/// One-pass accumulator for message content.
///
/// `serde(untagged)` was measurably slower here: an untagged enum buffers the whole content array
/// into an intermediate tree before re-deserializing it, so the text was parsed twice. Borrowing
/// (`Cow<'de, str>`) avoids copying the payload as well, which dominates for tool results.
#[derive(Default)]
struct ContentStats {
    chars: u64,
    preview: String,
    preview_len: usize,
    tools: Vec<String>,
}

impl<'de> Deserialize<'de> for ContentStats {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ContentStatsVisitor)
    }
}

struct ContentStatsVisitor;

impl<'de> Visitor<'de> for ContentStatsVisitor {
    type Value = ContentStats;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a string or an array of content blocks")
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
        let mut stats = ContentStats::default();
        stats.absorb_text(value);
        Ok(stats)
    }

    fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
        let mut stats = ContentStats::default();
        stats.absorb_text(&value);
        Ok(stats)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut stats = ContentStats::default();
        while let Some(block) = seq.next_element::<BlockStats<'de>>()? {
            let text = block
                .text
                .as_deref()
                .or(block.reasoning.as_deref())
                .or(block.arguments.as_deref());
            if let Some(text) = text {
                stats.absorb_text(text);
            }
            if block.kind.as_deref() == Some("tool-call") {
                if let Some(name) = block.name {
                    stats.tools.push(name.to_string());
                }
            }
        }
        Ok(stats)
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(ContentStats::default())
    }
}

#[derive(Deserialize, Default)]
struct RawSource {
    #[serde(default, rename = "callId")]
    call_id: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawMessage {
    #[serde(default)]
    content: Option<ContentStats>,
    #[serde(default)]
    source: Option<RawSource>,
    #[serde(default, rename = "toolCallId")]
    tool_call_id: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawData {
    #[serde(default)]
    turn: Option<u64>,
    #[serde(default)]
    step: Option<u64>,
    #[serde(default)]
    content: Option<ContentStats>,
    #[serde(default)]
    message: Option<RawMessage>,
}

#[derive(Deserialize, Default)]
struct RawRecord<'a> {
    #[serde(default, rename = "type", borrow)]
    kind: Cow<'a, str>,
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    time: u64,
    #[serde(default)]
    data: Option<RawData>,
}

impl ContentStats {
    fn absorb_preview(&mut self, text: &str) {
        if self.preview_len >= PREVIEW_CHARS || text.is_empty() {
            return;
        }
        if self.preview_len > 0 {
            self.preview.push(' ');
            self.preview_len += 1;
        }
        for ch in text.chars().take(PREVIEW_CHARS.saturating_sub(self.preview_len)) {
            self.preview.push(ch);
            self.preview_len += 1;
        }
    }

    fn absorb_text(&mut self, text: &str) {
        self.chars += text.chars().count() as u64;
        self.absorb_preview(text);
    }

    fn merge(&mut self, other: ContentStats) {
        self.chars += other.chars;
        self.absorb_preview(&other.preview);
        self.tools.extend(other.tools);
    }

    fn finish(&mut self) -> (u64, String) {
        let preview = self.preview.replace(['\n', '\r'], " ").trim().to_string();
        (self.chars, preview)
    }
}

struct Message {
    seq: u64,
    t: u64,
    turn: u64,
    step: u64,
    kind: &'static str,
    name: String,
    chars: u64,
    preview: String,
}

fn project_jsonl(text: &str) -> (Vec<Message>, Value, Value, f64) {
    let mut parse_ns: u128 = 0;
    let mut messages: Vec<Message> = Vec::new();
    let mut records = 0u64;
    let mut steps = 0u64;
    let mut tools: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
    let mut last_turn = 0u64;
    let mut last_step = 0u64;
    let mut malformed = 0u64;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parse_started = Instant::now();
        let parsed: Result<RawRecord, _> = serde_json::from_str(line);
        parse_ns += parse_started.elapsed().as_nanos();
        let record: RawRecord = match parsed {
            Ok(value) => value,
            Err(_) => {
                malformed += 1;
                continue;
            }
        };
        records += 1;
        let RawRecord { kind, seq, time, data } = record;
        let kind = kind.as_ref();
        if !matches!(
            kind,
            "user/message"
                | "assistant/message"
                | "tool/result"
                | "system/message"
                | "developer/message"
                | "assistant/reasoning"
                | "step/start"
        ) {
            continue;
        }
        let data = data.unwrap_or_default();
        let turn = data.turn.unwrap_or(last_turn);
        let step = data.step.unwrap_or(last_step);
        last_turn = turn;
        last_step = step;

        let (msg_kind, name, chars, preview): (&'static str, String, u64, String) = match kind {
            "user/message" => {
                let mut stats = data.content.unwrap_or_default();
                let (chars, preview) = stats.finish();
                ("user", String::new(), chars, preview)
            }
            "assistant/message" => {
                let mut stats = ContentStats::default();
                if let Some(message) = data.message {
                    if let Some(content) = message.content {
                        stats.merge(content);
                    }
                }
                let name = stats.tools.join(",");
                for tool in &stats.tools {
                    *tools.entry(tool.to_string()).or_insert(0) += 1;
                }
                let (chars, preview) = stats.finish();
                ("assistant", name, chars, preview)
            }
            "tool/result" => {
                let mut stats = ContentStats::default();
                let mut name = String::new();
                if let Some(message) = data.message {
                    if let Some(content) = message.content {
                        stats.merge(content);
                    }
                    name = message
                        .source
                        .and_then(|source| source.call_id)
                        .or(message.tool_call_id)
                        .unwrap_or_default();
                }
                let (chars, preview) = stats.finish();
                ("tool", name, chars, preview)
            }
            "system/message" | "developer/message" => {
                let mut stats = ContentStats::default();
                match data.message {
                    Some(message) => {
                        if let Some(content) = message.content {
                            stats.merge(content);
                        }
                    }
                    None => {
                        if let Some(content) = data.content {
                            stats.merge(content);
                        }
                    }
                }
                let (chars, preview) = stats.finish();
                ("system", String::new(), chars, preview)
            }
            "step/start" => {
                steps += 1;
                continue;
            }
            "assistant/reasoning" => {
                let mut stats = data.content.unwrap_or_default();
                let (chars, preview) = stats.finish();
                ("reasoning", String::new(), chars, preview)
            }
            _ => continue,
        };

        messages.push(Message { seq, t: time, turn, step, kind: msg_kind, name, chars, preview });
    }

    let tools_value: Map<String, Value> = tools
        .iter()
        .map(|(key, value)| (key.clone(), Value::Number((*value).into())))
        .collect();
    (
        messages,
        json!({
            "records": records,
            "steps": steps,
            "turns": last_turn,
            "toolCalls": tools.values().sum::<u64>(),
            "malformed": malformed,
        }),
        Value::Object(tools_value),
        parse_ns as f64 / 1_000_000.0,
    )
}

fn message_to_json(message: &Message) -> Value {
    json!({
        "seq": message.seq, "t": message.t, "turn": message.turn, "step": message.step,
        "kind": message.kind, "name": message.name, "chars": message.chars, "preview": message.preview,
    })
}

/// Decode an arbitrary list of frames, splitting the list across cores.
fn decode_frames(compressed: &[u8], frames: &[(usize, usize)]) -> Result<String, String> {
    let count = frames.len();
    // Measured on a 20.4 MB / 3737-frame log (2026-10-20): 1 thread decode=671 ms,
    // 4 threads=752 ms, 8 threads=844 ms. ruzstd is allocation-heavy, so fanning out
    // costs more than it saves; keep one decoding thread unless explicitly overridden.
    let workers = std::env::var("DSH_RUST_DECODE_THREADS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(1)
        .clamp(1, 8)
        .min(count.max(1));
    if count == 0 {
        return Ok(String::new());
    }
    if workers <= 1 {
        return decode_frame_range(compressed, frames);
    }
    let chunk = count.div_ceil(workers);
    let parts: Vec<Result<String, String>> = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for worker in 0..workers {
            let from = worker * chunk;
            let to = (from + chunk).min(count);
            if from >= to {
                continue;
            }
            let slice = &frames[from..to];
            handles.push(scope.spawn(move || decode_frame_range(compressed, slice)));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap_or_else(|_| Err("zstd decode thread panicked".to_string())))
            .collect()
    });
    let mut text = String::new();
    for part in parts {
        text.push_str(&part?);
    }
    Ok(text)
}

struct RangeProjection {
    messages: Vec<Message>,
    counts: Value,
    tools: Value,
    end: usize,
    frames: usize,
    total_frames: usize,
    text_bytes: usize,
    decode_ms: f64,
    parse_ms: f64,
    fold_ms: f64,
}

fn project_range(compressed: &[u8], from: usize) -> Result<RangeProjection, String> {
    let frames = split_frames(compressed)?;
    let total_frames = frames.len();
    let end = frames.last().map(|frame| frame.1).unwrap_or(0);
    let selected: Vec<(usize, usize)> = frames
        .into_iter()
        .filter(|(start, _)| *start >= from)
        .collect();
    let decode_started = Instant::now();
    let text = decode_frames(compressed, &selected)?;
    let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
    let fold_started = Instant::now();
    let text_bytes = text.len();
    let (messages, counts, tools, parse_ms) = project_jsonl(&text);
    let fold_total_ms = fold_started.elapsed().as_secs_f64() * 1000.0;
    Ok(RangeProjection {
        messages,
        counts,
        tools,
        end,
        frames: selected.len(),
        total_frames,
        text_bytes,
        decode_ms,
        parse_ms,
        fold_ms: (fold_total_ms - parse_ms).max(0.0),
    })
}

struct CacheState {
    size: u64,
    mtime: u64,
    compressed_end: u64,
    built_at: u64,
    counts: Value,
    tools: Value,
    messages: Vec<Value>,
}

/// First-page fast path: decode frames from the start of the log *only* until the requested page
/// is covered, and let a background thread build the full snapshot. A cold open of a 5.2 MB /
/// 3737-frame session costs ~555 ms end to end (~367 ms of it decoding every frame); the first
/// 50 messages live in roughly the first hundred frames, so the head path trades completeness for
/// latency and reports `partial: true` instead of pretending the projection is whole.
struct HeadProjection {
    messages: Vec<Value>,
    counts: Value,
    tools: Value,
    frames_used: usize,
    total_frames: usize,
    compressed_end: usize,
    text_bytes: usize,
    decode_ms: f64,
    parse_ms: f64,
    fold_ms: f64,
    exhausted: bool,
}

const HEAD_BATCH_FRAMES: usize = 64;

fn project_head(compressed: &[u8], need: usize) -> Result<HeadProjection, String> {
    let frames = split_frames(compressed)?;
    let total_frames = frames.len();
    let mut messages: Vec<Value> = Vec::new();
    let mut counts = Value::Null;
    let mut tools = Value::Null;
    let mut decode_ms = 0.0_f64;
    let mut parse_ms = 0.0_f64;
    let mut fold_ms = 0.0_f64;
    let mut text_bytes = 0usize;
    let mut used = 0usize;
    while used < total_frames {
        let to = (used + HEAD_BATCH_FRAMES).min(total_frames);
        let decode_started = Instant::now();
        let text = decode_frames(compressed, &frames[used..to])?;
        decode_ms += decode_started.elapsed().as_secs_f64() * 1000.0;
        text_bytes += text.len();
        let fold_started = Instant::now();
        let (delta, delta_counts, delta_tools, delta_parse_ms) = project_jsonl(&text);
        parse_ms += delta_parse_ms;
        fold_ms += (fold_started.elapsed().as_secs_f64() * 1000.0 - delta_parse_ms).max(0.0);
        for message in delta {
            messages.push(message_to_json(&message));
        }
        if counts.is_null() {
            counts = delta_counts;
            tools = delta_tools;
        } else {
            merge_counts(&mut counts, &delta_counts);
            merge_tools(&mut tools, &delta_tools);
        }
        used = to;
        if messages.len() >= need {
            break;
        }
    }
    Ok(HeadProjection {
        messages,
        counts: if counts.is_null() { json!({}) } else { counts },
        tools: if tools.is_null() { json!({}) } else { tools },
        frames_used: used,
        total_frames,
        compressed_end: frames.get(used.saturating_sub(1)).map(|frame| frame.1).unwrap_or(0),
        text_bytes,
        decode_ms,
        parse_ms,
        fold_ms,
        exhausted: used >= total_frames,
    })
}

/// Guards against piling up background snapshot builds for the same log (a client polling the
/// first page while the build is still running would otherwise start one build per request).
fn building_set() -> &'static Mutex<HashSet<String>> {
    static BUILDING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    BUILDING.get_or_init(|| Mutex::new(HashSet::new()))
}

fn try_begin_build(key: &str) -> bool {
    match building_set().lock() {
        Ok(mut set) => set.insert(key.to_string()),
        Err(_) => false,
    }
}

fn end_build(key: &str) {
    if let Ok(mut set) = building_set().lock() {
        set.remove(key);
    }
}

/// Build the full projection in the background and write the snapshot, so the next `open` is warm.
fn spawn_full_build(path: PathBuf, cache_file: PathBuf, size: u64, mtime: u64) {
    let key = cache_file.to_string_lossy().to_string();
    if !try_begin_build(&key) {
        return;
    }
    std::thread::spawn(move || {
        let ok = (|| -> Result<(), String> {
            let compressed = fs::read(&path).map_err(|error| format!("read failed: {error}"))?;
            let projection = project_range(&compressed, 0)?;
            let state = CacheState {
                size,
                mtime,
                compressed_end: projection.end as u64,
                built_at: now_ms() as u64,
                counts: projection.counts,
                tools: projection.tools,
                messages: projection.messages.iter().map(message_to_json).collect(),
            };
            if write_cache(&cache_file, &path, &state) {
                Ok(())
            } else {
                Err("cache write failed".to_string())
            }
        })();
        end_build(&key);
        let _ = ok;
    });
}

fn read_cache(file: &Path, log: &Path) -> Option<CacheState> {
    let text = fs::read_to_string(file).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    if value.get("version").and_then(|v| v.as_u64()) != Some(PROJECTION_VERSION as u64) {
        return None;
    }
    if value.get("path").and_then(|v| v.as_str()) != Some(log.to_string_lossy().as_ref()) {
        return None;
    }
    Some(CacheState {
        size: value.get("size").and_then(|v| v.as_u64())?,
        mtime: value.get("mtimeMs").and_then(|v| v.as_u64()).unwrap_or(0),
        compressed_end: value.get("compressedEnd").and_then(|v| v.as_u64())?,
        built_at: value.get("builtAtMs").and_then(|v| v.as_u64()).unwrap_or(0),
        counts: value.get("counts").cloned().unwrap_or(Value::Null),
        tools: value.get("tools").cloned().unwrap_or(Value::Null),
        messages: value.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
    })
}

fn write_cache(file: &Path, path: &Path, state: &CacheState) -> bool {
    let value = json!({
        "version": PROJECTION_VERSION,
        "path": path.to_string_lossy(),
        "size": state.size,
        "mtimeMs": state.mtime,
        "compressedEnd": state.compressed_end,
        "builtAtMs": state.built_at,
        "counts": state.counts,
        "tools": state.tools,
        "messages": state.messages,
    });
    let serialized = match serde_json::to_string(&value) {
        Ok(text) => text,
        Err(_) => return false,
    };
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = file.with_extension("json.tmp");
    if fs::write(&tmp, serialized).is_err() {
        return false;
    }
    fs::rename(&tmp, file).is_ok()
}

fn merge_counts(target: &mut Value, delta: &Value) {
    if !target.is_object() {
        *target = json!({});
    }
    for key in ["records", "steps", "toolCalls", "malformed"] {
        let sum = target.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
            + delta.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        target[key] = json!(sum);
    }
    let turns = target
        .get("turns")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .max(delta.get("turns").and_then(|v| v.as_u64()).unwrap_or(0));
    target["turns"] = json!(turns);
}

fn merge_tools(target: &mut Value, delta: &Value) {
    if !target.is_object() {
        *target = json!({});
    }
    if let Some(entries) = delta.as_object() {
        for (key, value) in entries {
            let sum = target.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
                + value.as_u64().unwrap_or(0);
            target[key.as_str()] = json!(sum);
        }
    }
}

/// Open a session log projection page. `params`: { path, limit?, cursor?, refresh? }
pub fn open(params: &Value) -> Result<Value, String> {
    let started = Instant::now();
    let path_str = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "path is required".to_string())?;
    let path = PathBuf::from(path_str);
    let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(50).clamp(1, 500) as usize;
    let cursor = params.get("cursor").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let force_refresh = params.get("refresh").and_then(|v| v.as_bool()).unwrap_or(false);

    let (size, mtime) = file_meta(&path);
    if size == 0 {
        return Err(format!("session log not found or empty: {path_str}"));
    }
    let cache_file = cache_path_for(&path);
    let mut timings = Map::new();
    let cached = if force_refresh { None } else { read_cache(&cache_file, &path) };
    let mut needs_write = true;

    let state: CacheState = match cached {
        Some(warm) if warm.size == size => {
            timings.insert("mode".into(), json!("warm"));
            timings.insert("cacheHit".into(), json!(true));
            needs_write = false;
            warm
        }
        Some(previous) if previous.size < size && previous.compressed_end > 0 && previous.compressed_end <= size => {
            // Append-only log: decode just the frames appended since the snapshot.
            let read_started = Instant::now();
            let compressed = fs::read(&path).map_err(|error| format!("read failed: {error}"))?;
            let read_ms = read_started.elapsed().as_secs_f64() * 1000.0;
            let projection = project_range(&compressed, previous.compressed_end as usize)?;
            let mut counts = previous.counts.clone();
            merge_counts(&mut counts, &projection.counts);
            let mut tools = previous.tools.clone();
            merge_tools(&mut tools, &projection.tools);
            let mut messages = previous.messages;
            let delta_messages = projection.messages.len();
            messages.extend(projection.messages.iter().map(message_to_json));
            timings.insert("mode".into(), json!("append"));
            timings.insert("cacheHit".into(), json!(false));
            timings.insert("readMs".into(), json!(read_ms));
            timings.insert("decodeMs".into(), json!(projection.decode_ms));
            timings.insert("parseMs".into(), json!(projection.parse_ms));
            timings.insert("foldMs".into(), json!(projection.fold_ms));
            timings.insert("deltaFrames".into(), json!(projection.frames));
            timings.insert("totalFrames".into(), json!(projection.total_frames));
            timings.insert("deltaMessages".into(), json!(delta_messages));
            CacheState {
                size,
                mtime,
                compressed_end: projection.end as u64,
                built_at: now_ms() as u64,
                counts,
                tools,
                messages,
            }
        }
        _ => {
            let read_started = Instant::now();
            let compressed = fs::read(&path).map_err(|error| format!("read failed: {error}"))?;
            let read_ms = read_started.elapsed().as_secs_f64() * 1000.0;
            let want_partial = params.get("partial").and_then(|v| v.as_bool()).unwrap_or(true);
            if want_partial {
                // Decode only enough frames to fill the requested page; the rest is background work.
                let head = project_head(&compressed, cursor + limit)?;
                timings.insert("mode".into(), json!("head"));
                timings.insert("readMs".into(), json!(read_ms));
                timings.insert("decodeMs".into(), json!(head.decode_ms));
                timings.insert("parseMs".into(), json!(head.parse_ms));
                timings.insert("foldMs".into(), json!(head.fold_ms));
                timings.insert("frames".into(), json!(head.frames_used));
                timings.insert("totalFrames".into(), json!(head.total_frames));
                timings.insert("decodedBytes".into(), json!(head.text_bytes));
                timings.insert("compressedBytes".into(), json!(compressed.len()));
                if head.exhausted {
                    // The whole log fit in the head budget: no background work needed.
                    let state = CacheState {
                        size,
                        mtime,
                        compressed_end: head.compressed_end as u64,
                        built_at: now_ms() as u64,
                        counts: head.counts,
                        tools: head.tools,
                        messages: head.messages,
                    };
                    timings.insert("cacheWrite".into(), json!(write_cache(&cache_file, &path, &state)));
                    timings.insert("partial".into(), json!(false));
                    state
                } else {
                    spawn_full_build(path.clone(), cache_file.clone(), size, mtime);
                    timings.insert("backgroundBuild".into(), json!(true));
                    timings.insert("partial".into(), json!(true));
                    needs_write = false;
                    CacheState {
                        size,
                        mtime,
                        compressed_end: head.compressed_end as u64,
                        built_at: now_ms() as u64,
                        counts: head.counts,
                        tools: head.tools,
                        messages: head.messages,
                    }
                }
            } else {
                let projection = project_range(&compressed, 0)?;
                timings.insert("mode".into(), json!("full"));
                timings.insert("cacheHit".into(), json!(false));
                timings.insert("readMs".into(), json!(read_ms));
                timings.insert("decodeMs".into(), json!(projection.decode_ms));
                timings.insert("parseMs".into(), json!(projection.parse_ms));
                timings.insert("foldMs".into(), json!(projection.fold_ms));
                timings.insert("frames".into(), json!(projection.total_frames));
                timings.insert("totalFrames".into(), json!(projection.total_frames));
                timings.insert("decodedBytes".into(), json!(projection.text_bytes));
                timings.insert("compressedBytes".into(), json!(compressed.len()));
                timings.insert("partial".into(), json!(false));
                CacheState {
                    size,
                    mtime,
                    compressed_end: projection.end as u64,
                    built_at: now_ms() as u64,
                    counts: projection.counts,
                    tools: projection.tools,
                    messages: projection.messages.iter().map(message_to_json).collect(),
                }
            }
        }
    };

    if needs_write {
        timings.insert("cacheWrite".into(), json!(write_cache(&cache_file, &path, &state)));
    }

    let total = state.messages.len();
    let end = (cursor + limit).min(total);
    let page: Vec<Value> = if cursor < total { state.messages[cursor..end].to_vec() } else { Vec::new() };
    let page_chars: u64 = page
        .iter()
        .map(|message| message.get("chars").and_then(|v| v.as_u64()).unwrap_or(0))
        .sum();
    // `partial` means the projection only covers the head of the log; `hasMore` tells the caller
    // whether another page exists (either buffered or still undecoded behind the head window).
    let partial = timings.get("partial").and_then(|value| value.as_bool()).unwrap_or(false);
    let has_more = partial || end < total;
    timings.insert("totalMs".into(), json!(started.elapsed().as_secs_f64() * 1000.0));
    timings.insert("cacheFile".into(), json!(cache_file.to_string_lossy()));

    Ok(json!({
        "schema": "dsh-rust-exec/session-projection@1",
        "path": path_str,
        "size": size,
        "mtimeMs": mtime,
        "counts": state.counts,
        "tools": state.tools,
        "builtAtMs": state.built_at,
        "total": total,
        "partial": partial,
        "hasMore": has_more,
        "cursor": cursor,
        "nextCursor": if has_more { json!(end) } else { Value::Null },
        "page": page,
        "pageChars": page_chars,
        "timings": timings,
    }))
}

/// Diagnostic RPC: decode every frame individually and report per-frame byte counts, so the
/// hand-written frame splitter can be cross-checked against an independent decoder (Python
/// `zstandard`) on exactly the same byte ranges.
pub fn debug_decode(params: &Value) -> Result<Value, String> {
    let path = params
        .get("path")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "path is required".to_string())?;
    let started = Instant::now();
    let compressed = fs::read(path).map_err(|error| format!("read failed: {error}"))?;
    let read_ms = started.elapsed().as_secs_f64() * 1000.0;
    let frames = split_frames(&compressed)?;
    let decode_started = Instant::now();
    let mut total_bytes = 0usize;
    let mut total_lines = 0usize;
    let mut detail: Vec<Value> = Vec::with_capacity(frames.len());
    for (start, end) in &frames {
        let text = decode_frame_range(&compressed, &[(*start, *end)])?;
        total_bytes += text.len();
        total_lines += text.lines().count();
        detail.push(json!({ "start": start, "end": end, "bytes": text.len() }));
    }
    let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
    Ok(json!({
        "schema": "dsh-rust-exec/session-debug@1",
        "path": path,
        "compressedBytes": compressed.len(),
        "frames": frames.len(),
        "totalBytes": total_bytes,
        "totalLines": total_lines,
        "readMs": read_ms,
        "decodeMs": decode_ms,
        "detail": detail,
    }))
}

/// Full message bodies for a bounded set of record sequence numbers.
///
/// The projection cache only keeps 180-character previews, so "expand this message" needs the
/// text itself. Decode frame batches until every requested seq has been seen (or the log ends),
/// and parse ONLY those lines, which keeps the cost proportional to the page being opened rather
/// than to the whole log.
pub fn bodies(params: &Value) -> Result<Value, String> {
    let path = params
        .get("path")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "path is required".to_string())?;
    let max_chars = params
        .get("maxChars")
        .and_then(|value| value.as_u64())
        .unwrap_or(40_000)
        .clamp(1_000, 400_000) as usize;
    let wanted: HashSet<u64> = params
        .get("seqs")
        .and_then(|value| value.as_array())
        .map(|array| array.iter().filter_map(|item| item.as_u64()).collect())
        .unwrap_or_default();
    if wanted.is_empty() {
        return Err("seqs is required".to_string());
    }
    let started = Instant::now();
    let read_started = Instant::now();
    let compressed = fs::read(path).map_err(|error| format!("read failed: {error}"))?;
    let read_ms = read_started.elapsed().as_secs_f64() * 1000.0;
    let frames = split_frames(&compressed)?;
    let total_frames = frames.len();
    let mut items: Vec<Value> = Vec::new();
    let mut found: HashSet<u64> = HashSet::new();
    let mut used = 0usize;
    let mut decode_ms = 0.0_f64;
    let mut parse_ms = 0.0_f64;
    while used < total_frames && found.len() < wanted.len() {
        let to = (used + HEAD_BATCH_FRAMES).min(total_frames);
        let decode_started = Instant::now();
        let text = decode_frames(&compressed, &frames[used..to])?;
        decode_ms += decode_started.elapsed().as_secs_f64() * 1000.0;
        used = to;
        let parse_started = Instant::now();
        for line in text.split('\n') {
            let trimmed = line.trim();
            if trimmed.len() < 32 || !trimmed.contains("\"seq\"") {
                continue;
            }
            let seq = match record_seq(trimmed) {
                Some(value) => value,
                None => continue,
            };
            if !wanted.contains(&seq) || found.contains(&seq) {
                continue;
            }
            if let Ok(record) = serde_json::from_str::<Value>(trimmed) {
                items.push(message_body_json(&record, seq, max_chars));
                found.insert(seq);
            }
        }
        parse_ms += parse_started.elapsed().as_secs_f64() * 1000.0;
    }
    items.sort_by_key(|item| item.get("seq").and_then(|value| value.as_u64()).unwrap_or(0));
    Ok(json!({
        "schema": "dsh-rust-exec/session-bodies@1",
        "path": path,
        "totalFrames": total_frames,
        "framesUsed": used,
        "requested": wanted.len(),
        "found": found.len(),
        "partial": found.len() < wanted.len(),
        "items": items,
        "timings": {
            "readMs": round_ms(read_ms),
            "decodeMs": round_ms(decode_ms),
            "parseMs": round_ms(parse_ms),
            "totalMs": round_ms(started.elapsed().as_secs_f64() * 1000.0),
        },
    }))
}

fn round_ms(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn push_block(blocks: &mut Vec<Value>, budget: &mut usize, total: &mut usize, block_type: &str, text: &str) {
    let chars = text.chars().count();
    if chars == 0 || *budget == 0 {
        return;
    }
    let take = chars.min(*budget);
    let slice: String = text.chars().take(take).collect();
    *total += take;
    *budget -= take;
    blocks.push(json!({
        "type": block_type,
        "text": slice,
        "chars": chars,
        "truncated": take < chars,
    }));
}

/// Cheap `"seq":<n>` scan for one already-located JSONL record (avoids a full parse to skip work).
fn record_seq(line: &str) -> Option<u64> {
    let index = line.find("\"seq\"")?;
    let rest = line[index + 5..].trim_start_matches([':', ' ']);
    let end = rest.find(|character: char| !character.is_ascii_digit()).unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    rest[..end].parse().ok()
}

/// One message body: only the block kinds a reader needs, text sliced to `max_chars` in total.
fn message_body_json(record: &Value, seq: u64, max_chars: usize) -> Value {
    let kind = record.get("type").and_then(|value| value.as_str()).unwrap_or("");
    let data = record.get("data").unwrap_or(&NULL);
    let message = data.get("message").unwrap_or(data);
    let mut name = data
        .get("name")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    if name.is_none() {
        name = message
            .get("toolCallId")
            .and_then(|value| value.as_str())
            .or_else(|| {
                message
                    .get("source")
                    .and_then(|source| source.get("callId"))
                    .and_then(|value| value.as_str())
            })
            .map(|value| value.to_string());
    }
    let mut blocks: Vec<Value> = Vec::new();
    let mut budget = max_chars;
    let mut total = 0usize;
    match message.get("content") {
        Some(Value::Array(content)) => {
            for block in content {
                if budget == 0 || blocks.len() >= 40 {
                    break;
                }
                let block_type = block.get("type").and_then(|value| value.as_str()).unwrap_or("unknown");
                if let Some(text) = block.get("text").and_then(|value| value.as_str()) {
                    push_block(&mut blocks, &mut budget, &mut total, block_type, text);
                } else if let Some(text) = block.get("arguments").and_then(|value| value.as_str()) {
                    push_block(&mut blocks, &mut budget, &mut total, "tool-call", text);
                } else if let Some(text) = block.get("reasoning").and_then(|value| value.as_str()) {
                    push_block(&mut blocks, &mut budget, &mut total, "reasoning", text);
                }
            }
        }
        Some(Value::String(text)) => push_block(&mut blocks, &mut budget, &mut total, "text", text),
        _ => {}
    }
    json!({
        "seq": seq,
        "kind": kind,
        "name": name,
        "t": record.get("time").cloned().unwrap_or(Value::Null),
        "blocks": blocks,
        "chars": total,
    })
}

/// Drop every cached projection (used by tests and by `session.cache.drop`).
pub fn drop_cache() -> Result<u64, String> {    let root = cache_root();
    let mut removed = 0u64;
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

pub fn cache_stats() -> Value {
    let root = cache_root();
    let mut files = 0u64;
    let mut bytes = 0u64;
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                files += 1;
                bytes += meta.len();
            }
        }
    }
    json!({ "dir": root.to_string_lossy(), "files": files, "bytes": bytes })
}
