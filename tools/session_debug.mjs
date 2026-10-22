// Cross-check the worker's hand-written zstd frame splitter against an independent decoder.
// Usage: node tools/session_debug.mjs <session.jsonl.zstd>
// Writes _bench/frames.json (per-frame ranges + byte counts) and prints a summary.
import { RustWorker } from '../packages/dsh-rust-exec/index.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXE = resolve(process.env.DSH_RUST_WORKER_EXE ?? (process.env.DSH_RUST_WORKER ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe'));
if (!existsSync(EXE)) {
  console.error('worker binary missing:', EXE);
  process.exit(1);
}
const LOG = process.argv[2];
if (!LOG) {
  console.error('usage: node tools/session_debug.mjs <session.jsonl.zstd>');
  process.exit(1);
}

process.env.DSH_PROFILE = 'sessiondebug';
const worker = new RustWorker(EXE, {});
try {
  const result = await worker.call('session.debug.decode', { path: resolve(LOG) }, 180_000);
  mkdirSync('_bench', { recursive: true });
  writeFileSync('_bench/frames.json', JSON.stringify(result.detail, null, 0));
  const { frames, totalBytes, totalLines, compressedBytes, readMs, decodeMs } = result;
  console.log(`file=${LOG}`);
  console.log(`compressed=${compressedBytes} B frames=${frames} decoded=${totalBytes} B lines=${totalLines}`);
  console.log(`read=${readMs.toFixed(1)} ms decode=${decodeMs.toFixed(1)} ms`);
  const detail = result.detail;
  console.log('first 5 frames:', detail.slice(0, 5).map((f) => `${f.start}-${f.end}:${f.bytes}`).join(' | '));
  const zero = detail.filter((f) => f.bytes === 0).length;
  const sizes = detail.map((f) => f.bytes).sort((a, b) => a - b);
  console.log(`zero-byte frames=${zero} median=${sizes[Math.floor(sizes.length / 2)]} max=${sizes[sizes.length - 1]}`);
  console.log('wrote _bench/frames.json');
} finally {
  await worker.dispose?.();
  process.exit(0);
}

