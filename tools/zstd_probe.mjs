// Probe a DSH session log (.jsonl.zstd): decompress ALL zstd frames (streaming), histogram event types, dump trimmed samples.
import { createReadStream } from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const chunks = [];
await new Promise((resolve, reject) => {
  const rs = createReadStream(file);
  const zs = zlib.createZstdDecompress();
  rs.on('error', reject); zs.on('error', reject);
  zs.on('data', (c) => chunks.push(c));
  zs.on('end', resolve);
  rs.pipe(zs);
});
const text = Buffer.concat(chunks).toString('utf8');
const lines = text.split('\n').filter((l) => l.trim().length > 0);
console.log('records:', lines.length, 'chars:', text.length);

const hist = new Map();
const samples = new Map();
const keySets = new Map();
for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch { hist.set('PARSE_FAIL', (hist.get('PARSE_FAIL') ?? 0) + 1); continue; }
  const t = o.type ?? o.kind ?? o.event ?? 'NO_TYPE';
  hist.set(t, (hist.get(t) ?? 0) + 1);
  if (!samples.has(t)) samples.set(t, l.slice(0, 700));
  const ks = Object.keys(o).sort().join(',');
  keySets.set(ks, (keySets.get(ks) ?? 0) + 1);
}
console.log('--- type histogram ---');
for (const [k, v] of [...hist.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(7), k);
console.log('--- top-level key sets ---');
for (const [k, v] of [...keySets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(String(v).padStart(7), k);
console.log('--- samples ---');
for (const [k, v] of samples) console.log('### ' + k + '\n' + v);
