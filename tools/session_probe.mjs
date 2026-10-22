// Probe the Rust session projection service directly against real DSH session logs.
// Cold run drops the cache first; warm run reuses it.
import { RustWorker } from '../packages/dsh-rust-exec/index.js';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXE = resolve(process.env.DSH_RUST_WORKER_EXE ?? (process.env.DSH_RUST_WORKER ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe'));
const CACHE = resolve('_bench/session-cache');
if (!existsSync(EXE)) {
  console.error('worker binary missing:', EXE);
  process.exit(1);
}
process.env.DSH_RUST_CACHE_DIR = CACHE;
process.env.DSH_PROFILE = 'sessionprobe';

const LOGS = process.argv.slice(2);
if (LOGS.length === 0) {
  console.error('usage: node tools/session_probe.mjs <session.jsonl.zstd> [more...]');
  process.exit(1);
}

if (process.env.DROP_CACHE === '1') rmSync(CACHE, { recursive: true, force: true });

const worker = new RustWorker(EXE, {});
const rows = [];

async function open(log, label) {
  const started = performance.now();
  const result = await worker.call('session.open', { path: resolve(log), limit: 50 }, 60000);
  const wall = performance.now() - started;
  return { label, wall, result };
}

try {
  console.log('--- caps ---');
  const caps = await worker.call('caps', {}, 20000).catch(() => null);
  console.log('features has session.open:', JSON.stringify(caps).includes('session.open'));
  console.log('cache dir before:', JSON.stringify(await worker.call('session.cache.stats', {}, 20000)));

  for (const log of LOGS) {
    const cold = await open(log, 'cold');
    const t = cold.result.timings;
    console.log(`\n=== ${log.split('\\').pop()} (${(cold.result.size / 1048576).toFixed(2)} MB) ===`);
    console.log(`cached=${t.cacheHit} read=${t.readMs?.toFixed(1)}ms decode=${t.decodeMs?.toFixed(1)}ms ` +
      `jsonParse=${t.parseMs?.toFixed(1)}ms fold=${t.foldMs?.toFixed(1)}ms frames=${t.frames} total=${t.totalMs?.toFixed(1)}ms wall=${cold.wall.toFixed(1)}ms`);
    console.log(`records=${cold.result.counts.records} messages=${cold.result.total} turns=${cold.result.counts.turns} ` +
      `steps=${cold.result.counts.steps} toolCalls=${cold.result.counts.toolCalls} malformed=${cold.result.counts.malformed}`);
    console.log(`decoded=${((t.decodedBytes ?? 0) / 1048576).toFixed(2)} MB compressed=${(t.compressedBytes / 1048576).toFixed(2)} MB ` +
      `pageChars=${cold.result.pageChars} nextCursor=${cold.result.nextCursor}`);

    const warm = await open(log, 'warm');
    const wt = warm.result.timings;
    console.log(`warm: cached=${wt.cacheHit} cacheLoad=${wt.cacheLoadMs?.toFixed(1)}ms total=${wt.totalMs?.toFixed(1)}ms wall=${warm.wall.toFixed(1)}ms`);

    const page2 = await worker.call('session.open', { path: resolve(log), limit: 10, cursor: 40 }, 30000);
    console.log(`cursor page: from=${page2.cursor} got=${page2.page.length} next=${page2.nextCursor} first=${page2.page[0]?.kind}/${page2.page[0]?.chars}ch`);

    const toolKeys = Object.keys(cold.result.tools ?? {}).slice(0, 6).join(',');
    console.log(`tools: ${toolKeys}`);
    rows.push({ log, size: cold.result.size, total: cold.result.total, coldTotal: t.totalMs, warmTotal: wt.totalMs });
  }

  console.log('\ncache dir after:', JSON.stringify(await worker.call('session.cache.stats', {}, 20000)));
  console.log('\n--- summary (ms) ---');
  for (const row of rows) {
    console.log(`  ${String(row.total).padStart(4)} msgs  cold ${row.coldTotal.toFixed(1).padStart(7)}  warm ${row.warmTotal.toFixed(1).padStart(6)}`);
  }
} finally {
  await worker.close?.().catch(() => {});
  process.exit(0);
}

