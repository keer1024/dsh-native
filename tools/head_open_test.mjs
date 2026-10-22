// T1 acceptance: first page of a cold session log must come from the decoded head window, not a
// full 3,700-frame decode. Targets (RESUME.md queue T1): cold `limit=50` open ≤150 ms, partial
// response flagged, background build turns the next call warm, and `partial:false` still forces
// the complete projection.
//
// Run: node tools/head_open_test.mjs [log]
import { RustWorker } from '../packages/dsh-rust-exec/index.js';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXE = resolve(process.env.DSH_RUST_WORKER_EXE ?? '_bench/target-session/release/dsh-rust-worker.exe');
const CACHE = resolve('_bench/head-cache');
const LOG = resolve(process.argv[2] ?? '_bench/frozen-session.jsonl.zstd');

if (!existsSync(EXE)) {
  console.error('worker binary missing:', EXE);
  process.exit(2);
}
if (!existsSync(LOG)) {
  console.error('session log missing:', LOG);
  process.exit(2);
}

rmSync(CACHE, { recursive: true, force: true });
process.env.DSH_RUST_CACHE_DIR = CACHE;
process.env.DSH_PROFILE = 'headtest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(name, ok, detail) {
  if (ok) console.log('  PASS ' + name + (detail ? ' — ' + detail : ''));
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const worker = new RustWorker(EXE, {});
const LOG_SIZE = (await import('node:fs')).statSync(LOG).size;
console.log(`log ${LOG.split(/[\\/]/).pop()} · ${(LOG_SIZE / 1048576).toFixed(2)} MB`);

// Pay the one-time worker boot (spawn + hello handshake ≈ 0.8–1 s) before measuring, so the
// numbers below describe the request path rather than process startup.
const bootStarted = performance.now();
await worker.call('ping', {}, 60000);
console.log(`worker boot ${(performance.now() - bootStarted).toFixed(0)} ms (paid once per worker)`);

async function open(params) {
  const started = performance.now();
  const result = await worker.call('session.open', { path: LOG, ...params }, 120000);
  return { wall: performance.now() - started, result, t: result.timings };
}

try {
  console.log('\n[1] cold first page (limit=50, no cache)')
  const cold = await open({ limit: 50 });
  const t = cold.t;
  console.log(`    mode=${t.mode} partial=${cold.result.partial} hasMore=${cold.result.hasMore} `
    + `total=${cold.result.total} frames=${t.frames}/${t.totalFrames} `
    + `read=${t.readMs?.toFixed(1)} decode=${t.decodeMs?.toFixed(1)} json=${t.parseMs?.toFixed(1)} fold=${t.foldMs?.toFixed(1)} `
    + `totalMs=${t.totalMs?.toFixed(1)} wall=${cold.wall.toFixed(1)}ms`)
  check('mode is head', t.mode === 'head', 'mode=' + t.mode)
  check('flagged partial', cold.result.partial === true)
  check('page filled', cold.result.page.length === 50, 'page=' + cold.result.page.length)
  check('decoded a fraction of the frames', (t.frames ?? 0) < (t.totalFrames ?? 0), `${t.frames}/${t.totalFrames}`)
  check('cold first page ≤150 ms (server totalMs)', (t.totalMs ?? 9999) <= 150, (t.totalMs ?? -1).toFixed(1) + ' ms server / ' + cold.wall.toFixed(1) + ' ms wall')
  check('nextCursor is past the page', cold.result.nextCursor === 50, 'next=' + cold.result.nextCursor)
  check('background build was started', t.backgroundBuild === true)
  const headDecoded = t.decodedBytes ?? 0

  console.log('\n[2] second page while the full build is still running')
  const second = await open({ limit: 50, cursor: 50 })
  console.log(`    mode=${second.t.mode} partial=${second.result.partial} wall=${second.wall.toFixed(1)}ms page=${second.result.page.length}`)
  check('second page served', second.result.page.length === 50, 'page=' + second.result.page.length)
  check('second page stayed fast', second.wall <= 250, second.wall.toFixed(1) + ' ms')
  check('first row of page two is not page one', second.result.page[0]?.seq !== cold.result.page[0]?.seq)

  console.log('\n[3] background build finishes → next open is warm and complete')
  let warm = null
  for (let i = 0; i < 60; i++) {
    await sleep(200)
    warm = await open({ limit: 50 })
    if (warm.t.mode === 'warm') break
  }
  const fullTotal = warm?.result.total ?? 0
  console.log(`    mode=${warm?.t.mode} partial=${warm?.result.partial} total=${fullTotal} wall=${warm?.wall.toFixed(1)}ms`)
  check('mode is warm', warm?.t.mode === 'warm', 'mode=' + warm?.t.mode)
  check('projection is complete', warm?.result.partial === false)
  check('total covers the whole log', fullTotal > cold.result.total, `${cold.result.total} → ${fullTotal}`)
  check('warm open ≤60 ms (server totalMs)', (warm?.t.totalMs ?? 9999) <= 60, (warm?.t.totalMs ?? -1).toFixed(1) + ' ms server / ' + (warm?.wall ?? 0).toFixed(1) + ' ms wall')

  console.log('\n[4] page inside the head window now comes from the cache, still complete')
  const paged = await open({ limit: 10, cursor: 40 })
  console.log(`    mode=${paged.t.mode} total=${paged.result.total} page=[${paged.result.cursor}..${paged.result.cursor + paged.result.page.length}) next=${paged.result.nextCursor}`)
  check('cursor page served from cache', paged.result.page.length === 10 && paged.result.cursor === 40)
  check('total is the full count, not the head count', paged.result.total === fullTotal)

  console.log('\n[5] partial:false still forces a complete cold projection')
  await worker.call('session.cache.drop', {}, 20000)
  const forced = await open({ limit: 50, partial: false })
  const ft = forced.t
  console.log(`    mode=${ft.mode} partial=${forced.result.partial} frames=${ft.frames}/${ft.totalFrames} `
    + `decode=${ft.decodeMs?.toFixed(1)} json=${ft.parseMs?.toFixed(1)} totalMs=${ft.totalMs?.toFixed(1)} decoded=${((ft.decodedBytes ?? 0) / 1048576).toFixed(2)} MB`)
  check('mode is full', ft.mode === 'full', 'mode=' + ft.mode)
  check('full projection decodes every frame', ft.frames === ft.totalFrames, `${ft.frames}/${ft.totalFrames}`)
  check('head window decoded fewer bytes than the full projection', headDecoded < (ft.decodedBytes ?? 0), `${(headDecoded / 1048576).toFixed(2)} MB vs ${((ft.decodedBytes ?? 0) / 1048576).toFixed(2)} MB`)
} finally {
  try { await worker.dispose?.() } catch {}
}

console.log('')
if (failures.length) {
  console.log('---- FAILURES (' + failures.length + ') ----')
  for (const failure of failures) console.log('  ' + failure)
  process.exit(1)
}
console.log('---- ALL PASS ----')
process.exit(0)
