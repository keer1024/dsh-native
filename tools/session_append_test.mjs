// Verify the append-only incremental refresh: build a projection, append more frames, and check
// that the second open decodes only the appended frames instead of the whole log.
import { RustWorker } from '../packages/dsh-rust-exec/index.js';
import { copyFileSync, appendFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const EXE = resolve(process.env.DSH_RUST_WORKER_EXE ?? (process.env.DSH_RUST_WORKER ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe'));
const CACHE = resolve('_bench/session-cache-append');
const TMP = resolve('_bench/session-append.jsonl.zstd');
process.env.DSH_RUST_CACHE_DIR = CACHE;
process.env.DSH_PROFILE = 'appendtest';

const [logA, logB] = process.argv.slice(2);
if (!logA || !logB) {
  console.error('usage: node tools/session_append_test.mjs <base.jsonl.zstd> <appended.jsonl.zstd>');
  process.exit(1);
}
rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });
copyFileSync(logA, TMP);

const worker = new RustWorker(EXE, {});
const show = (label, result, wall) => {
  const t = result.timings;
  console.log(`${label}: mode=${t.mode} cached=${t.cacheHit} total=${t.totalMs?.toFixed(1)}ms wall=${wall.toFixed(1)}ms ` +
    `totalMsgs=${result.total} deltaMsgs=${t.deltaMessages ?? '-'} deltaFrames=${t.deltaFrames ?? '-'}/${t.totalFrames ?? '-'} ` +
    `read=${t.readMs?.toFixed?.(1) ?? '-'} decode=${t.decodeMs?.toFixed?.(1) ?? '-'} json=${t.parseMs?.toFixed?.(1) ?? '-'}`);
};

try {
  console.log('base bytes:', statSync(TMP).size);
  let started = performance.now();
  const full = await worker.call('session.open', { path: TMP, limit: 5, refresh: true }, 120000);
  show('full build', full, performance.now() - started);

  started = performance.now();
  const warm = await worker.call('session.open', { path: TMP, limit: 5 }, 120000);
  show('reopen   ', warm, performance.now() - started);

  appendFileSync(TMP, readFileSync(logB));
  console.log('after append bytes:', statSync(TMP).size, '(+' + readFileSync(logB).length + ')');

  started = performance.now();
  const delta = await worker.call('session.open', { path: TMP, limit: 5 }, 120000);
  show('appended ', delta, performance.now() - started);

  const expected = delta.total;
  const page3 = await worker.call('session.open', { path: TMP, limit: 3, cursor: Math.max(0, expected - 3) }, 60000);
  console.log(`tail page: total=${expected} cursor=${page3.cursor} got=${page3.page.length} last=${page3.page.at(-1)?.kind}`);

  started = performance.now();
  const warm2 = await worker.call('session.open', { path: TMP, limit: 5 }, 120000);
  show('warm again', warm2, performance.now() - started);

  const ok = delta.timings.mode === 'append' && delta.total > warm.total && delta.timings.deltaFrames > 0;
  console.log(ok ? 'APPEND-TEST PASS' : 'APPEND-TEST FAIL');
  await worker.call('session.cache.drop', {}, 20000);
  rmSync(TMP, { force: true });
  rmSync(CACHE, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error('APPEND-TEST ERROR', error?.message ?? error);
  process.exit(1);
}

