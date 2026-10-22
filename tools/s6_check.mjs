// S6 check: cold + warm session.open on a frozen log, with the worker's own phase timings.
// usage: node tools/s6_check.mjs <frozen.jsonl.zstd>
import { RustWorker } from '../packages/dsh-rust-exec/index.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const EXE = resolve(process.env.DSH_RUST_WORKER_EXE ?? (process.env.DSH_RUST_WORKER ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe'));
if (!existsSync(EXE)) { console.error('worker binary missing:', EXE); process.exit(1); }
const LOG = process.argv[2];
if (!LOG) { console.error('usage: node tools/s6_check.mjs <log>'); process.exit(1); }
process.env.DSH_PROFILE = 's6check';

const worker = new RustWorker(EXE, {});
const fmt = (t) => `mode=${t.mode} cacheHit=${t.cacheHit} total=${t.totalMs.toFixed(1)} read=${t.readMs.toFixed(1)} decode=${t.decodeMs.toFixed(1)} parse=${(t.parseMs ?? t.jsonParseMs ?? 0).toFixed(1)} fold=${t.foldMs.toFixed(1)} frames=${t.totalFrames ?? '-'} decoded=${t.decodedBytes ?? '-'} chars=${t.pageChars ?? '-'}`;
try {
  await worker.call('session.cache.drop', {}, 60_000);
  console.log('cache dropped');
  for (const [label, params] of [['COLD', { path: resolve(LOG), limit: 2 }], ['WARM', { path: resolve(LOG), limit: 2 }]]) {
    const t0 = performance.now();
    const r = await worker.call('session.open', params, 180_000);
    const wall = performance.now() - t0;
    console.log(`\n[${label}] wall=${wall.toFixed(1)} ms`);
    console.log('  counts:', JSON.stringify(r.counts), 'total=', r.total, 'size=', r.size);
    console.log('  ' + fmt(r.timings));
    console.log('  page[0]:', JSON.stringify(r.page?.[0])?.slice(0, 240));
  }
} finally {
  await worker.dispose?.();
  process.exit(0);
}

