// bench_fs_breakdown.mjs — decompose the small-file operations into their real costs.
//
// The protocol benchmark tells us `write` is ~50 ms and `read` ~1.6 ms, but not why.
// This script isolates the suspects one at a time, against the same warm worker:
//
//   ping            the RPC floor (no file work at all)
//   fs.stat         pure metadata path
//   fs.list         directory listing (150 entries)
//   fs.read small   a 373 B file — hash + line window on a tiny body
//   fs.read big     a 2400-line file, 40-line window — the whole-file work
//   fs.write out    write to %TEMP%, outside the index root → no index bookkeeping
//   fs.write in     write inside the index root → note_change re-parses and saves the cache
//
// usage: node tools/bench_fs_breakdown.mjs [--runs 30] [--out .tmp/bench/fs.json]
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const RUNS = Number(arg('runs', '30'))
const OUT = arg('out', 'E:\\study\\dsh-plugin\\.tmp\\bench\\fs.json')
const WORKER = 'E:\\study\\dsh-plugin\\packages\\dsh-rust-exec\\bin\\dsh-rust-worker.exe'
const CORPUS = 'C:\\Users\\keer_\\.dsh\\profiles\\desktop\\.bench-corpus'
const TEMP_DIR = join(process.env.TEMP ?? 'C:\\Windows\\Temp', 'dshbench')
const now = () => performance.now()

class Worker {
  constructor(bin, cwd) {
    this.pending = new Map()
    this.nextId = 1
    this.buf = Buffer.alloc(0)
    this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd })
    this.child.stdout.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk])
      for (;;) {
        const sep = this.buf.indexOf('\r\n\r\n')
        if (sep < 0) return
        const len = Number(/Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString('ascii'))?.[1] ?? -1)
        if (!Number.isFinite(len) || len < 0) { this.buf = this.buf.subarray(sep + 4); continue }
        if (this.buf.length < sep + 4 + len) return
        const msg = JSON.parse(this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8'))
        this.buf = this.buf.subarray(sep + 4 + len)
        const waiter = this.pending.get(msg.id)
        if (waiter) {
          this.pending.delete(msg.id)
          msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result)
        }
      }
    })
    this.child.stderr.on('data', (d) => process.stderr.write(`[worker] ${d}`))
  }
  request(method, params = {}, timeoutMs = 120_000) {
    const id = this.nextId++
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.child.stdin.write(body)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
    })
  }
  close() { try { this.child.kill() } catch {} }
}

const stat = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  const mean = xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
  return {
    n: xs.length,
    mean: +mean.toFixed(2),
    p50: +pick(0.5).toFixed(2),
    p95: +pick(0.95).toFixed(2),
    min: +Math.min(...xs).toFixed(2),
    max: +Math.max(...xs).toFixed(2),
  }
}

const big = join(CORPUS, 'src', 'core', 'big.mjs')
const small = join(CORPUS, 'src', 'core', 'config.mjs')
const inRoot = join(CORPUS, 'bench-probe.tmp.mjs')
const outRoot = join(TEMP_DIR, 'bench-probe.tmp.mjs')
mkdirSync(TEMP_DIR, { recursive: true })

const w = new Worker(WORKER, 'C:\\Users\\keer_\\.dsh\\profiles\\desktop')
await w.request('initialize')

// Build the index first: `note_change` only does work when an index exists, so measuring
// writes without a warm index would hide the very cost we are looking for.
const warm = await w.request('search.text', { query: 'RETRIES', refresh: true, maxBytes: 4000 })
const indexFiles = warm?.stats?.files ?? warm?.files ?? null

const ops = {}
const time = async (label, fn, runs) => {
  const xs = []
  for (let i = 0; i < runs; i++) {
    const t0 = now()
    await fn(i)
    xs.push(now() - t0)
  }
  ops[label] = stat(xs)
  console.log(`${label.padEnd(18)} mean ${String(ops[label].mean).padStart(7)}  p50 ${String(ops[label].p50).padStart(6)}  p95 ${String(ops[label].p95).padStart(6)}  max ${String(ops[label].max).padStart(7)}`)
  return xs
}

console.log(`worker: ${WORKER}\nruns: ${RUNS}  index files: ${indexFiles ?? '?'}\n`)
await time('ping', () => w.request('ping'), RUNS)
await time('stat', () => w.request('fs.stat', { path: small }), RUNS)
await time('list', () => w.request('fs.list', { path: join(CORPUS, 'src'), limit: 500 }), RUNS)
await time('read.small', () => w.request('fs.read', { path: small }), RUNS)
await time('read.big40', () => w.request('fs.read', { path: big, offset: 1201, limit: 40 }), RUNS)
await time('write.outsideRoot', (i) => w.request('fs.write', { path: outRoot, content: `export const n = ${i};\n` }), Math.max(5, Math.round(RUNS / 2)))
await time('write.insideRoot', (i) => w.request('fs.write', { path: inRoot, content: `export const n = ${i};\n` }), Math.max(5, Math.round(RUNS / 2)))

// Optional probes: they only report when the running binary supports them, so the same
// script produces "before" numbers on an old worker and the breakdown on a new one.
try {
  await w.request('fs.read', { path: big, offset: 1201, limit: 40, hash: 'none' })
  await time('read.big40.noHash', () => w.request('fs.read', { path: big, offset: 1201, limit: 40, hash: 'none' }), RUNS)
} catch (err) {
  console.log(`read.big40.noHash skipped: ${err.message}`)
}
try {
  await w.request('fs.list', { path: join(CORPUS, 'src'), sizes: false })
  await time('list.noSizes', () => w.request('fs.list', { path: join(CORPUS, 'src'), sizes: false }), RUNS)
} catch (err) {
  console.log(`list.noSizes skipped: ${err.message}`)
}

// Who pays for the 13 ms write? Separate "the atomic replace itself" from "the RPC plumbing"
// by doing the same two write strategies in plain Node on the same machine:
//   native.inplace   writeFileSync straight onto the target
//   native.tmpRename write a sibling temp file, then rename it over the target
{
  const target = join(TEMP_DIR, 'native-probe.mjs')
  const tmp = join(TEMP_DIR, 'native-probe.dsh-tmp.mjs')
  await time('native.inplace', (i) => { writeFileSync(target, `export const n = ${i};\n`) }, Math.max(5, Math.round(RUNS / 2)))
  await time('native.tmpRename', (i) => {
    writeFileSync(tmp, `export const n = ${i};\n`)
    renameSync(tmp, target)
  }, Math.max(5, Math.round(RUNS / 2)))
  // The worker rewrite saves a ~45 KB index cache on every write; check what writing that
  // volume costs on this disk, independent of anything dsh-native does.
  const heavy = 'x'.repeat(45_721)
  await time('native.tmpRename45k', (i) => {
    writeFileSync(tmp, heavy + i)
    renameSync(tmp, target)
  }, Math.max(5, Math.round(RUNS / 2)))
  rmSync(target, { force: true })
}

w.close()
rmSync(inRoot, { force: true })
rmSync(outRoot, { force: true })
const result = { meta: { at: new Date().toISOString(), runs: RUNS, worker: WORKER, indexFiles }, ops }
mkdirSync(join('E:\\study\\dsh-plugin', '.tmp', 'bench'), { recursive: true })
writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(`\nwrote ${OUT}`)
process.exit(0)
