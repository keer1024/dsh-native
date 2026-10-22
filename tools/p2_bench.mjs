// P2 acceptance bench: same recall, fewer tokens.
//
// Baseline = what an agent does today in DSH: `rg -n` for the hits, then read
// every matched file in full to get context. Plugin path = one rust_search /
// rust_symbols call that already returns trimmed context.
//
//   node tools/p2_bench.mjs [fileCount]
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RustWorker } from '../packages/dsh-rust-exec/index.js'

const ROOT = process.cwd()
const CORPUS = join(ROOT, 'bench-corpus')
const RG = join(ROOT, '_bench', 'rg.exe')
const WORKER_EXE = join(ROOT, 'packages', 'dsh-rust-worker', 'target', 'release', 'dsh-rust-worker.exe')
const FILE_COUNT = Number(process.argv[2] ?? 400)
const MARKERS = 5

function generate() {
  if (existsSync(join(CORPUS, '.gen'))) return
  rmSync(CORPUS, { recursive: true, force: true })
  mkdirSync(CORPUS, { recursive: true })
  for (let i = 0; i < FILE_COUNT; i += 1) {
    const dir = join(CORPUS, 'src', `mod${i % 20}`)
    mkdirSync(dir, { recursive: true })
    const markers = Array.from({ length: MARKERS }, (_, k) => k).filter((k) => i % MARKERS === k)
    const filler = []
    for (let j = 0; j < 34; j += 1) {
      filler.push(`  // stage ${j}: dispatch pipeline step ${j} with retry budget ${(i * 7 + j) % 11}`)
      if (j % 6 === 0) filler.push(`  private readonly stage${j} = ${(i * 13 + j) % 97}`)
    }
    const text = [
      `import { audit } from '../shared/audit'`,
      ``,
      `export interface Config${i} { retries: number; timeoutMs: number }`,
      ``,
      `export class Service${i} {`,
      `  private readonly name = 'svc${i}'`,
      `  constructor(private readonly cfg: Config${i}) {}`,
      ...filler,
      `  async handle${i}(payload: string): Promise<number> {`,
      `    const trace = '${i}-' + payload`,
      `    if (!payload) throw new Error('empty payload for ${i}')`,
      `    return payload.length + trace.length`,
      `  }`,
      `}`,
      ``,
      `// markers: ${markers.map((k) => `MARKER_${k}`).join(' ') || 'none'}`,
      `export function helper${i}(value: number): number {`,
      `  return value * ${(i % 17) + 1}`,
      `}`,
      ``,
    ].join('\n')
    writeFileSync(join(dir, `svc${i}.ts`), text, 'utf8')
  }
  writeFileSync(join(CORPUS, '.gen'), String(Date.now()), 'utf8')
}

function rel(path) {
  const normalized = path.replace(/\\/g, '/')
  const at = normalized.lastIndexOf('bench-corpus/')
  return at >= 0 ? normalized.slice(at + 'bench-corpus/'.length) : normalized
}

function rgRun(query) {
  return new Promise((resolve) => {
    execFile(RG, ['-n', '--no-heading', '-F', query, CORPUS], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : stdout)
    })
  })
}

function hitsFromRg(stdout) {
  const hits = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const match = /^(.*?):(\d+):/.exec(line)
    if (match) hits.push({ path: rel(match[1]), line: Number(match[2]), text: line })
  }
  return hits
}

/** Baseline payload: every rg hit line plus the full text of each matched file. */
function baselineBytes(rgHits) {
  let bytes = 0
  for (const hit of rgHits) bytes += hit.text.length + 1
  const seen = new Set()
  for (const hit of rgHits) {
    if (seen.has(hit.path)) continue
    seen.add(hit.path)
    try {
      bytes += statSync(join(CORPUS, hit.path)).size
    } catch {
      // File vanished; skip.
    }
  }
  return { bytes, filesRead: seen.size }
}

const renderSearch = (value) => (value.hits ?? []).map((hit) =>
  `${hit.path}:${hit.line}${hit.kind ? ` [${hit.kind}]` : ''} ${hit.text}`
  + (hit.context ? `\n${hit.context.split('\n').map((row) => `  ${row}`).join('\n')}` : ''),
).join('\n') + `\n— ${value.shown}/${value.totalHits} hits · ${value.elapsedMs} ms`

const renderSymbols = (value) => (value.symbols ?? [])
  .map((sym) => `${sym.path}:${sym.line} [${sym.kind}] ${sym.sig || sym.name}`)
  .join('\n') + `\n— ${value.shown}/${value.totalMatched} symbols · ${value.elapsedMs} ms`

function overlap(a, b) {
  const setB = new Set(b)
  let shared = 0
  for (const item of a) if (setB.has(item)) shared += 1
  return shared
}

generate()
const worker = new RustWorker(WORKER_EXE)
const buildStart = performance.now()
const first = await worker.call('search.text', { query: 'export function', refresh: true, maxHits: 1 }, 180_000)
const buildMs = Math.round(performance.now() - buildStart)
console.log(`corpus: ${FILE_COUNT} files · index build + first search ${buildMs} ms (scanned ${first.filesScanned})`)

const textQueries = ['handle123', 'helper77', 'Service88', 'MARKER_0', 'MARKER_3', 'pipeline step 7', 'timeoutMs', 'audit']
const symbolQueries = ['handle123', 'Service88', 'helper77']
/** How many distinct files a real agent opens before it has enough context. */
const REALISTIC_READS = 5
const rows = []
let baseTotal = 0
let pluginTotal = 0
let truncatedTotal = 0

/**
 * Equal-recall baseline: the plugin already picked the hits that matter, so the
 * baseline is exactly what today's flow must read to learn the same thing —
 * the `rg -n` hit lines, plus the files that contain them (capped like an agent).
 */
function baselineFor(hits) {
  const files = []
  for (const hit of hits) {
    const relPath = rel(hit.path)
    if (!files.includes(relPath)) files.push(relPath)
  }
  let bytes = 0
  for (const hit of hits) bytes += (hit.text?.length ?? 0) + 1
  const readFiles = files.slice(0, REALISTIC_READS)
  for (const relPath of readFiles) {
    try {
      bytes += statSync(join(CORPUS, relPath)).size
    } catch {
      // File vanished; skip.
    }
  }
  return { bytes, files: files.length, readFiles: readFiles.length }
}

for (const query of textQueries) {
  const result = await worker.call('search.text', { query, contextLines: 1 }, 120_000)
  const hits = result.hits ?? []
  const baseline = baselineFor(hits)
  const pluginText = renderSearch(result)
  truncatedTotal += Math.max(0, (result.totalHits ?? hits.length) - hits.length)
  baseTotal += baseline.bytes
  pluginTotal += pluginText.length
  rows.push({
    kind: 'text', query, hits: hits.length, total: result.totalHits ?? hits.length,
    files: baseline.files, filesRead: baseline.readFiles, baseline: baseline.bytes,
    plugin: pluginText.length,
    reduction: Math.round(100 * (1 - pluginText.length / Math.max(baseline.bytes, 1))), ms: result.elapsedMs,
  })
}

for (const query of symbolQueries) {
  const result = await worker.call('search.symbol', { query, limit: 200 }, 120_000)
  const symbols = result.symbols ?? []
  const hits = symbols.map((sym) => ({ path: sym.path, line: sym.line, text: sym.sig || sym.name }))
  const baseline = baselineFor(hits)
  const pluginText = renderSymbols(result)
  baseTotal += baseline.bytes
  pluginTotal += pluginText.length
  rows.push({
    kind: 'symbol', query, hits: symbols.length, total: result.totalMatched ?? symbols.length,
    files: baseline.files, filesRead: baseline.readFiles, baseline: baseline.bytes,
    plugin: pluginText.length,
    reduction: Math.round(100 * (1 - pluginText.length / Math.max(baseline.bytes, 1))), ms: result.elapsedMs,
  })
}

console.log('\nkind   query                 hits/found  files/read  baseline_B  plugin_B  red%   ms')
for (const row of rows) {
  console.log(
    `${row.kind.padEnd(6)} ${row.query.padEnd(21)} ${String(row.hits).padStart(4)}/${String(row.total).padEnd(6)}`
    + ` ${String(row.files).padStart(5)}/${String(row.filesRead).padEnd(6)} ${String(row.baseline).padStart(11)}`
    + ` ${String(row.plugin).padStart(9)} ${String(row.reduction).padStart(5)} ${String(row.ms).padStart(5)}`,
  )
}
const reduction = Math.round(100 * (1 - pluginTotal / Math.max(baseTotal, 1)))
console.log(`\n等召回口径：baseline ${baseTotal} B → plugin ${pluginTotal} B  (${reduction}% fewer)`)
console.log(`未展示的额外命中（预算截断）合计 ${truncatedTotal} 条 — 这部分是 baseline 额外的读取成本，未计入上表`)
writeFileSync(join(ROOT, '_bench', 'p2_bench.json'), JSON.stringify({
  buildMs, rows, baseTotal, pluginTotal, reduction, truncatedTotal,
}, null, 2))
worker.kill('bench done')
process.exit(reduction >= 30 ? 0 : 2)
