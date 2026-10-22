// Verify the session.body RPC: fetch full bodies for a few seqs and report latency.
import { RustWorker } from '../packages/dsh-rust-exec/index.js'

const workerPath = process.argv[2] ?? 'C:/Users/keer_/Documents/deepseek-harness/default-workspace/packages/dsh-rust-exec/bin/dsh-rust-worker.exe'
const log = process.argv[3] ?? 'C:/Users/keer_/Documents/deepseek-harness/default-workspace/_bench/frozen-session.jsonl.zstd'

const worker = new RustWorker(workerPath)
try {
  await worker.start()
  const open = await worker.call('session.open', { path: log, limit: 6, refresh: true }, 120000, undefined, 'probe')
  const seqs = (open.page ?? []).map((row) => row.seq)
  console.log('open:', 'mode=' + open.timings.mode, 'total=' + open.timings.totalMs, 'ms', 'rows=' + seqs.length, 'seqs=' + seqs.join(','))

  const first = await worker.call('session.body', { path: log, seqs: seqs.slice(0, 3) }, 120000, undefined, 'probe')
  console.log('body:', first.timings, 'found=' + first.found + '/' + first.requested, 'partial=' + first.partial)
  for (const item of first.items) {
    const types = (item.blocks ?? []).map((block) => block.type + ':' + block.chars).join(' ')
    console.log('  #' + item.seq, item.kind, item.name ?? '-', 'chars=' + item.chars, '|', types)
    const head = (item.blocks ?? []).map((block) => (block.text ?? '').slice(0, 70).replace(/\s+/g, ' ')).join(' / ')
    console.log('     ', head.slice(0, 150))
  }

  // Warm repeat: same call should reuse nothing but stay in the same frame window.
  const again = await worker.call('session.body', { path: log, seqs: seqs.slice(0, 3) }, 120000, undefined, 'probe')
  console.log('body repeat totalMs:', again.timings.totalMs)

  // A far-away seq forces more frame batches; check partial semantics stay sane.
  const late = await worker.call('session.body', { path: log, seqs: [seqs[0], 100000] }, 120000, undefined, 'probe')
  console.log('bogus seq: found=' + late.found + '/' + late.requested, 'partial=' + late.partial, 'framesUsed=' + late.framesUsed + '/' + late.totalFrames)
} finally {
  await worker.dispose?.()
  process.exit(0)
}
