// Direct protocol probe for the Rust worker's index/search methods.
// usage: node tools/index_probe.mjs <cwd-for-worker> <query> [symbolQuery]
import { spawn } from 'node:child_process';

const exe = (process.env.DSH_RUST_WORKER ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe');
const cwd = process.argv[2] ?? process.cwd();
const query = process.argv[3] ?? 'createServer';
const symbolQuery = process.argv[4];

function connect() {
  const child = spawn(exe, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const m = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
      if (!m) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const start = headerEnd + 4;
      const end = start + Number(m[1]);
      if (buffer.length < end) return;
      const msg = JSON.parse(buffer.subarray(start, end).toString('utf8'));
      buffer = buffer.subarray(end);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    }
  });
  const call = (method, params = {}) => {
    const id = nextId++;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'), payload]));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { call, child };
}

const { call, child } = connect();
const t0 = Date.now();
const status = await call('index.status');
console.log('index.status', JSON.stringify(status), 'roundtrip', Date.now() - t0, 'ms');

const t1 = Date.now();
const text = await call('search.text', { query, maxHits: 8, maxBytes: 4000, contextLines: 1 });
const ms1 = Date.now() - t1;
console.log(`\nsearch.text "${query}": ${ms1} ms, ${text.shown}/${text.totalHits} hits, files ${text.filesMatched}/${text.filesScanned}, trunc=${text.truncated}`);
for (const hit of text.hits) console.log(`  ${hit.path}:${hit.line} [${hit.kind || 'ref'}] ${String(hit.text).slice(0, 110)}`);
console.log('  payload chars:', JSON.stringify(text).length);

if (symbolQuery) {
  const t2 = Date.now();
  const sym = await call('search.symbol', { query: symbolQuery, limit: 10, maxBytes: 3000 });
  console.log(`\nsearch.symbol "${symbolQuery}": ${Date.now() - t2} ms, ${sym.shown}/${sym.totalMatched} matched`);
  for (const s of sym.symbols) console.log(`  ${s.path}:${s.line} [${s.kind}] ${s.name}  ${String(s.sig).slice(0, 90)}`);
  console.log('  payload chars:', JSON.stringify(sym).length);
}

const t3 = Date.now();
const refreshed = await call('index.status', { refresh: true });
console.log('\nrefresh roundtrip', Date.now() - t3, 'ms; buildMs', refreshed.buildMs, 'ageMs', refreshed.ageMs);
child.stdin.end();

