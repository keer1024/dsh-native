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
//!
//! 中文说明（职责与不变量）：
//! 职责：把会话日志（JSONL，每批记录各自压成一个独立 zstd frame）投影成轻量的消息列表，
//! 快照落盘复用，为 session.open / session.body / session.cache.stats / session.cache.drop
//! 四个入口服务；投影只保留预览所需字段，正文字段由 bodies 按需重新解码。
//!
//! 不变量：
//!   1. 缓存键：日志路径的 SHA-256 前 8 字节（hex）+ 文件名，即
//!      cache_root()/{stem}-{digest}.v2.json；快照内另记 version/path/size/mtimeMs。
//!   2. 失效条件：PROJECTION_VERSION 不符、快照 path 与请求路径不符、日志 size 变小
//!      （被截断或替换）→ 整份快照作废并重建；size 变大且 compressedEnd 落在文件内
//!      → 只解码追加的帧；refresh=true 时跳过读快照。mtime 仅作记录，不参与判定。
//!   3. 容量与淘汰：只有磁盘目录的文件数/字节数统计（cache_stats），没有内存 LRU、
//!      没有容量上限与自动淘汰，清理只能由 drop_cache 显式删除整个缓存目录。
//!   4. 命中/未命中不做累计计数，仅体现在返回的 timings.mode 与 timings.cacheHit。
//!   5. 错误一律以 Result<_, String> 返回，由 main.rs 包成 JSON-RPC error 响应。

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

// 投影格式版本：改动投影字段或快照结构时必须自增，旧快照会因版本不符被丢弃并重建。
const PROJECTION_VERSION: u32 = 2;
// 每条消息保留的预览字符上限；正文不落快照，展开全文走 bodies。
const PREVIEW_CHARS: usize = 180;

static NULL: Value = Value::Null;

// 中文：解析 zstd 帧边界。DSH 每批记录追加一个独立帧，因此一个会话日志是多个帧的拼接；
// 这里按帧头/块头手工走位得到每个帧的 [start, end) 区间，遇到可跳过帧则整段跳过，
// 遇到截断或非法魔数返回带字节偏移的错误字符串，便于定位坏日志。
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

// 中文：把给定帧逐一解码并顺序拼接成完整文本。每帧单独建解码器（ruzstd 一次只读一帧），
// 任一帧初始化或解码失败立即返回错误，不返回半截结果。参数 compressed 为整份日志，
// frames 为 split_frames 给出的帧区间。
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

// 中文：当前 Unix 毫秒时间戳；时钟早于纪元等异常情况退化为 0，仅用于快照的 builtAtMs。
fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

// 中文：读取日志的 (size, mtimeMs)，提供快照失效判定所用的元数据。
// 路径不存在或元数据取不到时返回 (0, 0)，open 见到 size == 0 即按“日志不存在或为空”报错。
// mtime 用毫秒精度，只写入快照备查：判定只看 size 与 compressedEnd，不看 mtime。
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

// 中文：缓存根目录。优先级为 DSH_RUST_CACHE_DIR → $DSH_HOME/cache/rust-exec-sessions
// → 系统临时目录/dsh-rust-exec-sessions；环境变量为空串时视为未设置并继续回退。
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

// 中文：由日志路径推导快照文件 = cache_root()/{原文件名}-{摘要}.v2.json。
// 摘要取路径字符串 SHA-256 的前 8 字节（16 位十六进制），防止不同目录下的同名日志
// 互相覆盖；保留原 stem 是为了人工排查时能看出对应哪个日志。
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

// 中文：单个内容块的借用视图，只映射投影需要的 type/text/reasoning/arguments/name。
// borrow 使文本直接从行内 JSON 借用，避免为工具结果这类大字段整段复制字符串。
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

// 中文：消息内容的一次性累加器。chars 为字符总数，preview 为截断到 PREVIEW_CHARS 的预览，
// preview_len 记录预览已用长度，tools 收集本消息里出现的工具名。
// 下面的自定义 Deserialize 在解析过程中边读边累加，不构建中间 DOM。
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

// 中文：content 字段可能是裸字符串，也可能是内容块数组，统一交给 visitor 分派，
// 调用方因此不需要先判断类型再解析。
impl<'de> Deserialize<'de> for ContentStats {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ContentStatsVisitor)
    }
}

// 中文：content 字段的访问者；visit_str/visit_string 处理单个字符串，visit_seq 处理块数组，
// visit_unit 处理 null（返回空统计，不报错）。
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
            // 同一块内按 text → reasoning → arguments 的优先级只取第一个非空字段，
            // 避免把同一段内容重复计入字符数。
            let text = block
                .text
                .as_deref()
                .or(block.reasoning.as_deref())
                .or(block.arguments.as_deref());
            if let Some(text) = text {
                stats.absorb_text(text);
            }
            // 工具名在此只做收集；project_jsonl 用它拼 assistant 消息的 name 并累加全局计数。
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

// 中文：工具结果记录的 source 子对象，只关心 callId（工具调用 id）。
#[derive(Deserialize, Default)]
struct RawSource {
    #[serde(default, rename = "callId")]
    call_id: Option<String>,
}

// 中文：记录内嵌的 message 子对象：content 交给 ContentStats 边解析边累加，
// source.callId 与 toolCallId 是同一信息在不同日志版本中的两种写法。
#[derive(Deserialize, Default)]
struct RawMessage {
    #[serde(default)]
    content: Option<ContentStats>,
    #[serde(default)]
    source: Option<RawSource>,
    #[serde(default, rename = "toolCallId")]
    tool_call_id: Option<String>,
}

// 中文：记录内嵌的 data 子对象：turn/step 用于归属分组，content 与 message 是两个
// 可能的内容载体（不同记录类型落在不同位置）。
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

// 中文：单行 JSONL 记录。kind 借出行内字符串；其余字段缺失时取默认值，所以只有整行
// 语法错误才算 malformed，字段残缺的记录仍可投影。
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

// 中文：内容统计的累加与收口：absorb_* 逐段累加，merge 合并另一份统计，
// finish 输出 (字符数, 清洗后的预览)。
impl ContentStats {
    // 中文：把 text 追加进预览，总长不超过 PREVIEW_CHARS；多段文本间补一个空格，
    // 预览已满或 text 为空时直接返回。
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

    // 中文：累加字符数并顺带把文本喂给预览截断逻辑。
    fn absorb_text(&mut self, text: &str) {
        self.chars += text.chars().count() as u64;
        self.absorb_preview(text);
    }

    // 中文：合并另一份统计：字符数相加、预览按剩余额度续接、工具名追加。
    fn merge(&mut self, other: ContentStats) {
        self.chars += other.chars;
        self.absorb_preview(&other.preview);
        self.tools.extend(other.tools);
    }

    // 中文：收口，把预览里的换行替换成空格并去掉首尾空白，返回 (字符数, 预览)。
    fn finish(&mut self) -> (u64, String) {
        let preview = self.preview.replace(['\n', '\r'], " ").trim().to_string();
        (self.chars, preview)
    }
}

// 中文：投影后的单条消息，只保留列表与分页需要的字段：序号、时间、所属 turn/step、
// 消息类型、工具名（仅 assistant/tool 有值）、字符数与预览。
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

// 中文：把一段已解码的 JSONL 文本折叠成投影。
// 容错：空行与整行解析失败的记录只跳过（后者计入 malformed），未知 type 静默忽略，
// turn/step 缺省时沿用上一条的值，避免从中间帧开始解码时归属错乱。
// 参数 text 为一至多个帧解出的记录文本；返回 (消息列表, 计数对象, 工具计数, 解析耗时 ms)。
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
        // 只投影会出现在时间线上的记录类型；其余记录（会话元数据等）不占列表位。
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
        // turn/step 允许缺省：追加批次从中间帧解码时沿用上一条的归属。
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
                // assistant 消息的 name 用逗号拼出本条的工具名，同时累加全局工具计数。
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
            // step/start 只累加步数，不产生消息条目。
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

    // 工具名计数转成 JSON 对象；BTreeMap 保证键有序，快照间的输出可直接对比。
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

// 中文：把一条投影消息序列化成 JSON，字段名与对外 page 里的消息项保持一致。
fn message_to_json(message: &Message) -> Value {
    json!({
        "seq": message.seq, "t": message.t, "turn": message.turn, "step": message.step,
        "kind": message.kind, "name": message.name, "chars": message.chars, "preview": message.preview,
    })
}

// 中文：按帧区间解码，可用 DSH_RUST_DECODE_THREADS 把帧列表切成多段并行解码。
// 默认单线程：下方实测显示 ruzstd 分配开销大，多线程反而更慢；workers 限制在 1..=8
// 且不超过帧数。
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

// 中文：一次从给定字节偏移起的投影结果。messages/counts/tools 是投影数据；
// end 为已覆盖到的压缩字节偏移（下次可从此处续解码），frames 为本次解码帧数，
// total_frames 为整份日志帧数，text_bytes 为解码出的文本字节数，三个 *ms 为分段耗时。
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

// 中文：解码并投影 from 之后的所有帧。from 是压缩流字节偏移而非帧序号，所以先切帧
// 再按 start >= from 过滤；返回的 end 会写回快照作为下次追加的起点。
// 耗时拆成 decode/parse/fold 三段返回，方便宿主定位瓶颈；fold 为扣除解析后的折叠时间。
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

// 中文：快照的内存形态，与 cache_path_for 生成的 JSON 文件一一对应。
// size/mtime 是构建快照时日志的元数据（size 用于失效判定），compressed_end 是快照
// 覆盖到的压缩字节偏移（追加模式从这里续解码），built_at 为构建时刻的毫秒时间戳。
struct CacheState {
    size: u64,
    mtime: u64,
    compressed_end: u64,
    built_at: u64,
    counts: Value,
    tools: Value,
    messages: Vec<Value>,
}

// 中文：首屏快速路径的投影结果。只解码到够填满请求页为止，因此 messages 可能不完整；
// frames_used/compressed_end 记录已解码的范围，exhausted 表示整份日志都已被覆盖。
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

// 首屏路径每批解码的帧数：批量越大解析次数越少，但会多解当前页用不到的数据。
const HEAD_BATCH_FRAMES: usize = 64;

// 中文：从日志头部逐批解码，直到消息数 >= need 或帧耗尽。
// 每批解码后把计数与工具计数合并进累计值，compressed_end 取本批最后一帧的结束偏移；
// 返回的 exhausted 为 true 时调用方无需再启动后台全量构建。
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

// 中文：全局“正在构建”的键集合（键为快照文件路径），防止同一日志并发堆积多个后台构建。
/// Guards against piling up background snapshot builds for the same log (a client polling the
/// first page while the build is still running would otherwise start one build per request).
fn building_set() -> &'static Mutex<HashSet<String>> {
    static BUILDING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    BUILDING.get_or_init(|| Mutex::new(HashSet::new()))
}

// 中文：登记一个构建；已存在同名键时返回 false，调用方据此放弃本次构建。
// 锁只在 HashSet 插入的一瞬间持有，不覆盖真正的构建过程。
fn try_begin_build(key: &str) -> bool {
    match building_set().lock() {
        Ok(mut set) => set.insert(key.to_string()),
        Err(_) => false,
    }
}

// 中文：构建结束（无论成功或失败）后移除登记；漏掉这一步会让该日志此后无法再触发构建。
fn end_build(key: &str) {
    if let Ok(mut set) = building_set().lock() {
        set.remove(key);
    }
}

// 中文：后台线程构建全量快照并落盘，使下一次 open 走 warm 路径。
// 构建失败只释放登记、不向调用方报错（首屏结果此时已经返回）；size/mtime 用 open 读到的值，
// 保证快照里记录的就是本次判定所依据的元数据。
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

// 中文：读取并校验磁盘快照，任一项不符即返回 None，调用方据此视为未命中并重建。
// 校验顺序：文件可读 → JSON 可解析 → version 等于 PROJECTION_VERSION → path 与请求路径一致。
// size/compressedEnd 缺失直接判为无效；counts/tools 缺失记为 Null，messages 缺失按空列表。
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

// 中文：序列化并原子落盘：先写同目录 .json.tmp，再 rename 覆盖正式文件，
// 避免并发读到只写了一半的快照；目录不存在时先递归创建。返回 false 表示写失败，
// 调用方仅把结果记入 timings.cacheWrite，不影响本次返回的投影内容。
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

// 中文：把追加批次的计数并入累计计数：records/steps/toolCalls/malformed 逐项相加，
// turns 取两者最大值（turn 号单调递增，追加片段可能不含 turn 字段）。
// 目标不是对象时先重置为空对象，避免把键写到非对象值上。
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

// 中文：合并工具名计数：同名累加，delta 中不存在的名字保持原值；目标非对象时先重置。
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

// 中文：打开会话投影的一页（session.open）。参数 path 必填；limit 默认 50 并夹在 1..=500；
// cursor 是消息下标；refresh 为 true 时跳过快照；partial 默认 true，表示允许只解码首屏。
// 返回：计数值、total/partial/hasMore/nextCursor、本页 page 与 timings 分段耗时。
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
    // refresh=true 或快照校验失败时 cached 为 None，进入下面的全量/首屏重建分支。
    let cached = if force_refresh { None } else { read_cache(&cache_file, &path) };
    let mut needs_write = true;

    let state: CacheState = match cached {
        // 命中：日志大小与快照记录的一致，直接复用快照，不做任何解码。
        Some(warm) if warm.size == size => {
            timings.insert("mode".into(), json!("warm"));
            timings.insert("cacheHit".into(), json!(true));
            needs_write = false;
            warm
        }
        // 追加：日志只在尾部变长，且上次覆盖到的偏移仍在文件内（否则视为被替换），
        // 因此只解码 compressed_end 之后的帧，并把增量合并到旧快照上。
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
        // 未命中：重建。partial=true 时只解码首屏并交给后台线程补齐全量快照。
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
                // 首屏预算已覆盖整份日志：可直接当完整快照写盘，不需要后台重建。
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
                    // 只覆盖到头部：启动后台全量构建，本次结果标记 partial=true。
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

    // warm 命中不重写快照；首屏未耗尽时已交给后台构建写盘，也不在此写。
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

// 中文：诊断用 RPC（session.debug.decode）：逐帧单独解码并报告每帧字节数，
// 便于把本文件手工切出的帧区间与独立解码器（Python zstandard）在同一字节范围上对照。
// 参数 path 必填；返回压缩大小、帧数、解码总字节/行数、read 与 decode 耗时及逐帧明细。
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

// 中文：按 seq 集合取消息正文（session.body）。投影只保留 180 字预览，展开正文需重新解码；
// 逐批解码直到目标 seq 全部出现或日志到头，且只解析命中的行，成本与请求条数成正比。
// 参数 path/seqs 必填，maxChars 默认 40000 并夹在 1000..=400000；返回 items 与 partial 标记。
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
            // 廉价预过滤：过短或不含 "seq" 的行不可能命中，直接跳过，省掉整行解析。
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
    // 按 seq 升序输出，与请求里 seqs 的排列顺序无关，调用方可直接拼接展示。
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

// 中文：耗时保留 1 位小数，避免 timings 里出现长浮点尾巴。
fn round_ms(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

// 中文：按剩余预算截取一个内容块并压入 blocks。chars 为原文字符数，take 为实际收入长度，
// truncated 标记是否被截断；空文本或预算耗尽时直接返回。预算以字符计，不以字节计。
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

// 中文：从已定位到 "seq" 的行里直接扫出数字，避免为筛选而完整解析整条记录；
// 找不到或后面不跟数字时返回 None。
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

// 中文：拼一条消息正文：只取阅读需要的块类型（text/arguments/reasoning 依次回退），
// 总字符数受 max_chars 约束；工具名先取 data.name，取不到再用 message 里的调用 id。
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
            // 单条消息内的双保险：预算用完或块数达到 40 就停止，防止超长消息撑爆响应。
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

// 中文：删除缓存目录下的全部快照文件（session.cache.drop），返回成功删除的文件数；
// 只删目录第一层的文件、不递归，目录不存在时按 0 处理。属全量清理，不能按会话保留。
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

// 中文：统计缓存目录的文件数与总字节数（session.cache.stats），供宿主 /cache 与监控展示；
// 只读元数据，单个条目取不到时跳过，返回 dir/files/bytes 三个字段。
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
