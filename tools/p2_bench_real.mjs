// P2 acceptance bench: same recall, how many characters does each flow burn?
//   B1 naive-today : rg hits + read the whole target file (up to 2000 lines)
//   B2 smart-today : rg hits + read only +-30 lines around the definition
//   N  new flow    : rust_search (ranked, budgeted 6000 B) [+ rust_symbols outline]
// Recall is asserted: the ground-truth definition line must appear in every payload.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WORK = 'C:\\Users\\keer_\\Documents\\deepseek-harness\\default-workspace'
const rg = path.join(WORK, '_bench', 'rg.exe')

function connectWorker(cwd, env) {
  const child = spawn(path.join(WORK, (process.env.DSH_RUST_WORKER ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe')), [], {
    cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  })
  let buffer = Buffer.alloc(0)
  const pending = new Map()
  let nextId = 1
  child.stdout.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const m = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))
      if (!m) { buffer = buffer.subarray(headerEnd + 4); continue }
      const start = headerEnd + 4
      const end = start + Number(m[1])
      if (buffer.length < end) return
      const msg = JSON.parse(buffer.subarray(start, end).toString('utf8'))
      buffer = buffer.subarray(end)
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
    }
  })
  const call = (method, params = {}) => {
    const id = nextId++
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'), payload]))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  return { call, child }
}

const CORPUS = process.argv[2]
const QUERIES = process.argv[3]
  ? JSON.parse(process.argv[3])
  : [
      'defineTool',
      'workspaceFiles',
      'tokenMeter',
      'toolResultPruner',
      'resolveExecutable',
      'clientModules',
      'spillStore',
      'estimateMessage',
    ]

function runRg(args, cwd) {
  const r = spawnSync(rg, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return r.stdout || ''
}

const worker = connectWorker(WORK, { DSH_RUST_INDEX_ROOT: CORPUS })
await worker.call('index.status', {})
const st = await worker.call('index.status', {})
console.log(`corpus: ${CORPUS}\nindex: ${st.files} files / ${st.symbols} symbols, build ${st.buildMs} ms`)

const rows = []
for (const query of QUERIES) {
  const grepOut = runRg(['-n', '--no-heading', '-F', '-m', '8', '--max-columns', '400', query, '.'], CORPUS)
  const lines = grepOut.split('\n').filter(Boolean)
  if (lines.length === 0) { console.log(`skip (no rg hit): ${query}`); continue }
  const first = lines[0]
  const m = /^(.*?):(\d+):(.*)$/.exec(first)
  const file = m[1].replace(/\\/g, '/').replace(/^\.\//, '')
  const lineNo = Number(m[2])
  const text = m[3]
  const budget = 7 * 1024 * 1024
  const full = readFileSync(path.join(CORPUS, file), { encoding: 'utf8', flag: 'r' }).slice(0, budget)
  const fileLines = full.split('\n')
  const readWhole = fileLines.slice(0, 2000).join('\n')
  const from = Math.max(1, lineNo - 30)
  const to = Math.min(fileLines.length, lineNo + 30)
  const readWindow = `[offset ${from}, limit ${to - from + 1}]\n` + fileLines.slice(from - 1, to).join('\n')

  const grepChars = grepOut.length
  const b1 = grepChars + readWhole.length
  const b2 = grepChars + readWindow.length

  const t0 = Date.now()
  const res = await worker.call('search.text', { query, maxHits: 8, maxBytes: 6000, contextLines: 1 }, 60_000)
  const ms = Date.now() - t0
  const hits = res.hits || []
  const nText = hits.map((h) => `${h.path}:${h.line}${h.kind ? ` [${h.kind}]` : ''} ${h.text}`).join('\n')
    + `\n…${res.shown}/${res.totalHits} hits · ${res.filesMatched}/${res.filesScanned} files · ${res.elapsedMs} ms`
  const sym = await worker.call('search.symbol', { path: file, limit: 40, maxBytes: 4000 }, 60_000)
  const symbols = (sym.symbols || []).map((s) => `${s.path}:${s.line} [${s.kind}] ${s.sig || s.name}`).join('\n')
  const nPlus = nText.length + symbols.length

  const recallNew = nText.includes(text.trim().slice(0, 40)) || nText.includes(`${file}:${lineNo}`)
  rows.push({ query, file, lineNo, ms, grepChars, b1, b2, n: nText.length, nPlus, recallNew, wholeLines: fileLines.length })
}

const sum = (k) => rows.reduce((a, r) => a + r[k], 0)
const avg = (k) => Math.round(sum(k) / Math.max(rows.length, 1))
console.log(`\n${'query'.padEnd(34)} ${'file'.padEnd(40)} B1(chars)  B2(chars)  N(chars)  N+sym  recall  ms`)
for (const r of rows) {
  console.log(`${r.query.slice(0, 33).padEnd(34)} ${r.file.slice(-39).padEnd(40)} ${String(r.b1).padStart(9)} ${String(r.b2).padStart(10)} ${String(r.n).padStart(8)} ${String(r.nPlus).padStart(6)} ${r.recallNew ? 'yes' : 'NO '} ${String(r.ms).padStart(5)}`)
}
const pct = (a, b) => (100 * (1 - a / b)).toFixed(1) + '%'
console.log(`\nmeans: B1=${avg('b1')}  B2=${avg('b2')}  N=${avg('n')}  N+symbols=${avg('nPlus')}`)
console.log(`token reduction vs B1 naive-today : ${pct(avg('n'), avg('b1'))}  (with outline ${pct(avg('nPlus'), avg('b1'))})`)
console.log(`token reduction vs B2 smart-today : ${pct(avg('n'), avg('b2'))}  (with outline ${pct(avg('nPlus'), avg('b2'))})`)
console.log(`recall (definition line present in new payload): ${rows.filter((r) => r.recallNew).length}/${rows.length}`)
console.log(`mean search latency: ${Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length)} ms`)
await worker.child.stdin.end()

