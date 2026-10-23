// schema_tokens.mjs — how much context the tool catalogue costs per request.
//
// Reads the newest DSH session log, finds the request header (the record that carries
// the tool definitions), and sums the serialized size of each tool definition. That is
// the fixed per-request "context tax" of a tool: every model call pays for it again.
//
// usage: node tools/schema_tokens.mjs [--log <path>] [--cwd dsh-plugin]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const SESSIONS = path.join(process.env.USERPROFILE, '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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
  const match = arg('cwd')
  const logs = findLogs(SESSIONS)
    .filter((p) => !match || p.toLowerCase().includes(match.toLowerCase()))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  if (!logs.length) {
    console.error(`no session log found under ${SESSIONS}`)
    process.exit(1)
  }
  logPath = logs[0].p
}

const buf = readFileSync(logPath)
const frames = []
let start = -1
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
    if (start >= 0) frames.push(buf.subarray(start, i))
    start = i
  }
}
if (start >= 0) frames.push(buf.subarray(start))

let tools = null
for (const frame of frames) {
  let text
  try {
    text = zstdDecompressSync(frame).toString('utf8')
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const candidate = rec?.data?.header?.tools ?? rec?.data?.tools ?? rec?.tools
    if (Array.isArray(candidate) && candidate.length && (!tools || candidate.length > tools.length)) {
      tools = candidate
    }
  }
}

if (!tools) {
  console.error('no request record carrying tool definitions found')
  process.exit(1)
}

const rows = tools.map((t) => ({
  name: t.name ?? t.function?.name ?? '?',
  chars: JSON.stringify(t).length,
}))
rows.sort((a, b) => b.chars - a.chars)

const isRust = (n) => n.startsWith('rust_') || n === 'native_help'
const native = rows.filter((r) => !isRust(r.name))
const rust = rows.filter((r) => isRust(r.name))
const sum = (xs) => xs.reduce((a, b) => a + b.chars, 0)
const tok = (chars) => Math.round(chars / 3.6)

console.log(`log: ${logPath}`)
console.log(`tools: ${rows.length} (native ${native.length} + dsh-native ${rust.length})`)
console.log(`chars: native ${sum(native)} ≈ ${tok(sum(native))} tok | dsh-native ${sum(rust)} ≈ ${tok(sum(rust))} tok`)
console.log(`total: ${sum(rows)} chars ≈ ${tok(sum(rows))} tok per request`)
console.log('\ndsh-native tools:')
for (const r of rust.sort((a, b) => b.chars - a.chars)) console.log(`  ${r.name.padEnd(18)} ${String(r.chars).padStart(6)} chars ≈ ${String(tok(r.chars)).padStart(5)} tok`)
console.log('\nnative tools (top 12 by size):')
for (const r of native) console.log(`  ${r.name.padEnd(18)} ${String(r.chars).padStart(6)} chars ≈ ${String(tok(r.chars)).padStart(5)} tok`)
