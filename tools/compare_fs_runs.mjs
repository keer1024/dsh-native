// compare_fs_runs.mjs — median-of-runs A/B comparison for the fs breakdown.
// Reads .tmp/bench/fs-{new,old}-<i>.json and prints, per operation, the median p50 across
// runs (median instead of mean: one Defender hiccup should not decide the table).
import { readFileSync, existsSync } from 'node:fs'

const load = (prefix, count) => {
  const runs = []
  for (let i = 1; i <= count; i++) {
    const path = `.tmp/bench/${prefix}-${i}.json`
    if (!existsSync(path)) continue
    runs.push(JSON.parse(readFileSync(path, 'utf8')))
  }
  return runs
}

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const RUNS = Number(process.argv[2] ?? 6)
const NEWP = process.argv[3] ?? 'fs-new'
const OLDP = process.argv[4] ?? 'fs-old'
const newer = load(NEWP, RUNS)
const older = load(OLDP, RUNS)
if (!newer.length || !older.length) {
  console.error('missing runs')
  process.exit(1)
}

const ops = Object.keys(newer[0].ops)
const rows = []
for (const op of ops) {
  const pick = (runs) => runs.map((r) => r.ops[op]).filter(Boolean)
  const a = pick(older)
  const b = pick(newer)
  if (!a.length || !b.length) continue
  rows.push({
    op,
    oldP50: median(a.map((x) => x.p50)),
    newP50: median(b.map((x) => x.p50)),
    oldMean: median(a.map((x) => x.mean)),
    newMean: median(b.map((x) => x.mean)),
  })
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`${pad('operation', 20)} ${pad('old p50', 9)} ${pad('new p50', 9)} ${pad('delta', 9)} ${pad('old mean', 9)} ${pad('new mean', 9)}`)
for (const r of rows) {
  const delta = r.oldP50 > 0 ? `${(r.newP50 / r.oldP50).toFixed(2)}x` : '-'
  console.log(`${pad(r.op, 20)} ${pad(r.oldP50.toFixed(2), 9)} ${pad(r.newP50.toFixed(2), 9)} ${pad(delta, 9)} ${pad(r.oldMean.toFixed(2), 9)} ${pad(r.newMean.toFixed(2), 9)}`)
}
console.log(`\nruns: new=${newer.length} old=${older.length}, value = median across runs of the per-run p50`)

// 机器在每个时间片上的绝对速度会漂（Defender、后台编译、频率调节都能让同一段代码差 30%），
// 所以再给一张"按同一次运行里的原生 tmp+rename 归一化"的表：原生基线是这次运行的速度标尺，
// 比值才是优化本身的效应。
const REF = 'native.tmpRename'
const normalized = (runs) => runs
  .filter((run) => run.ops[REF]?.p50 > 0)
  .map((run) => ({ run, ref: run.ops[REF].p50 }))
const normRows = []
for (const op of ops) {
  const a = normalized(older).filter((x) => x.run.ops[op]?.p50 > 0).map((x) => x.run.ops[op].p50 / x.ref)
  const b = normalized(newer).filter((x) => x.run.ops[op]?.p50 > 0).map((x) => x.run.ops[op].p50 / x.ref)
  if (!a.length || !b.length) continue
  normRows.push({ op, old: median(a), new: median(b) })
}
console.log(`\nnormalized by ${REF} (same run) — ratio to a native write:`)
console.log(`${pad('operation', 20)} ${pad('old', 9)} ${pad('new', 9)} ${pad('delta', 9)}`)
for (const r of normRows) {
  console.log(`${pad(r.op, 20)} ${pad(r.old.toFixed(2), 9)} ${pad(r.new.toFixed(2), 9)} ${pad(`${(r.new / r.old).toFixed(2)}x`, 9)}`)
}
