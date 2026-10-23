// tool_latency.mjs — per-tool wall time from the DSH session log (the same append-only
// session.v4.jsonl.zstd the dsh-native projection reads).
//
// Every persisted `tool/call` carries a timestamp; the matching `tool/result` carries the
// completion timestamp. The delta is the true end-to-end cost the harness paid, with no
// model latency in the middle and no self-reporting from the tool.
//
// usage:
//   node tools/tool_latency.mjs                        # newest session log under %USERPROFILE%\.dsh\sessions
//   node tools/tool_latency.mjs --log <path>           # explicit log
//   node tools/tool_latency.mjs --cwd dsh-plugin       # newest log whose dir matches this text
//   node tools/tool_latency.mjs --since 1792738000000 --until 1792740000000
//   node tools/tool_latency.mjs --json out.json
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const has = (name) => process.argv.includes(`--${name}`)
const SESSIONS = path.join(process.env.USERPROFILE, '.dsh', 'sessions')

function findLogs(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findLogs(full))
    else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) out.push(full)
  }
  return out
}

let logPath = arg('log')
if (!logPath) {
  const cwdMatch = arg('cwd')
  const logs = findLogs(SESSIONS)
    .filter((p) => !cwdMatch || p.toLowerCase().includes(cwdMatch.toLowerCase()))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  if (!logs.length) {
    console.error(`no session log found under ${SESSIONS}`)
    process.exit(1)
  }
  logPath = logs[0].p
}

// The log is a concatenation of independent zstd frames, one per append; each frame is a
// standalone compress of one JSON line. Split on the frame magic and decode each.
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeFrames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  let text = ''
  let bad = 0
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
    } catch {
      bad++
    }
  }
  return { text, frames: starts.length, bad }
}

const since = Number(arg('since', '0'))
const until = Number(arg('until', String(Date.now() + 1e9)))
const { text, frames, bad } = decodeFrames(readFileSync(logPath))
const calls = new Map()
const records = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    continue
  }
  const t = rec.time
  if (!(t >= since && t <= until)) continue
  if (rec.type === 'tool/call') {
    const callId = rec.data?.callId
    if (!callId) continue
    calls.set(callId, {
      tool: rec.data.name,
      t,
      // rendered size of the arguments, useful for "how much did the model have to type"
      argsBytes: Buffer.byteLength(rec.data.arguments ?? '', 'utf8'),
      turn: rec.data.turn,
      step: rec.data.step,
    })
  } else if (rec.type === 'tool/result') {
    const callId = rec.data?.toolCallId ?? rec.data?.message?.toolCallId
    if (!callId) continue
    const call = calls.get(callId)
    if (!call) continue
    let bytes = 0
    for (const part of rec.data?.message?.content ?? []) {
      if (part?.type === 'text') bytes += Buffer.byteLength(part.text ?? '', 'utf8')
    }
    records.push({ ...call, ms: t - call.t, bytes, resultTime: t })
    calls.delete(callId)
  }
}

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]
  return {
    n: s.length,
    total: s.reduce((a, b) => a + b, 0),
    mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length),
    p50: q(0.5),
    p95: q(0.95),
    min: s[0] ?? 0,
    max: s[s.length - 1] ?? 0,
  }
}

const byTool = new Map()
for (const r of records) {
  if (!byTool.has(r.tool)) byTool.set(r.tool, [])
  byTool.get(r.tool).push(r)
}

const rows = [...byTool.entries()]
  .map(([tool, rs]) => ({
    tool,
    ...stat(rs.map((r) => r.ms)),
    bytes: Math.round(rs.reduce((a, r) => a + r.bytes, 0) / rs.length),
    totalBytes: rs.reduce((a, r) => a + r.bytes, 0),
    argsBytes: Math.round(rs.reduce((a, r) => a + r.argsBytes, 0) / rs.length),
  }))
  .sort((a, b) => b.total - a.total)

const pad = (s, n) => String(s).padEnd(n)
const num = (s, n) => String(s).padStart(n)
console.log(`session log: ${logPath}`)
console.log(`frames decoded: ${frames}${bad ? ` (${bad} bad)` : ''} · window: ${new Date(since).toISOString()} → ${new Date(until).toISOString()}`)
console.log(`paired calls: ${records.length} / ${records.length + calls.size} (unfinished: ${calls.size})`)
console.log('')
console.log(pad('tool', 22), num('n', 4), num('total', 8), num('mean', 7), num('p50', 7), num('p95', 7), num('min', 6), num('max', 7), num('avgB', 8))
for (const r of rows) {
  console.log(
    pad(r.tool, 22), num(r.n, 4), num(Math.round(r.total), 8), num(r.mean.toFixed(0), 7),
    num(r.p50.toFixed(0), 7), num(r.p95.toFixed(0), 7), num(r.min, 6), num(r.max, 7), num(r.bytes, 8),
  )
}
const all = stat(records.map((r) => r.ms))
console.log('')
console.log(`all tools: n=${all.n} total=${Math.round(all.total)}ms mean=${all.mean.toFixed(0)}ms p50=${all.p50.toFixed(0)}ms p95=${all.p95.toFixed(0)}ms`)
const out = arg('json')
if (out) {
  writeFileSync(out, JSON.stringify({ logPath, frames, bad, since, until, rows, all, records }, null, 2))
  console.log(`wrote ${out}`)
}
