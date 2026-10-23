// Protocol-level comparison: "what DSH's native tools cost today" vs "what the
// dsh-native worker costs", measured side by side on the same corpus and the
// same operations.
//
//   native side  = one OS process spawn per call, the way the built-in tools
//                  work (powershell.exe for `pwsh`, rg.exe for `grep`, Node fs
//                  for the in-process read/write/edit/stat/list tools).
//   dsh-native   = one JSON-RPC round-trip to an already-booted worker.
//
// usage: node tools/bench_native_vs_rust.mjs [--runs 15] [--corpus DIR] [--out FILE]
//
// Only measures transport + process cost; harness/UI overhead is added by the
// session-level run (see tool_latency.mjs).  Every number is machine-specific.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
    return acc;
  }, []),
);
const RUNS = Number(args.runs ?? 15);
const CORPUS = args.corpus ?? 'C:\\Users\\keer_\\.dsh\\profiles\\desktop\\.bench-corpus';
const OUT = args.out ?? join('E:\\study\\dsh-plugin', '.tmp', 'bench', 'micro.json');
const PROFILE = 'C:\\Users\\keer_\\.dsh\\profiles\\desktop';
const WORKER = 'E:\\study\\dsh-plugin\\packages\\dsh-rust-exec\\bin\\dsh-rust-worker.exe';
const SHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const RG = 'D:\\deepseekHarness\\dsh\\resources\\app.asar.unpacked\\dsh\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe';

const now = () => Number(process.hrtime.bigint() / 1_000_000n);
const pct = (x, p) => { const s = [...x].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stat = (xs) => ({
  n: xs.length,
  mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1),
  p50: pct(xs, 0.5),
  p95: pct(xs, 0.95),
  min: Math.min(...xs),
  max: Math.max(...xs),
  total: +xs.reduce((a, b) => a + b, 0).toFixed(1),
});
const log = (m) => process.stdout.write(m + '\n');
const time = async (fn) => { const t = now(); const r = await fn(); return { ms: now() - t, r }; };

// --------------------------------------------------------------- native side
function spawnOnce(bin, argv, opts) {
  const started = now();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', () => resolve({ ms: now() - started, out }));
  });
}

// ------------------------------------------------------------- worker client
class Worker {
  constructor(bin, cwd) {
    this.pending = new Map();
    this.nextId = 1;
    this.buf = Buffer.alloc(0);
    this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd });
    this.child.stdout.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const sep = this.buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const len = Number(/Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString('ascii'))?.[1] ?? -1);
        if (!Number.isFinite(len) || len < 0) { this.buf = this.buf.subarray(sep + 4); continue; }
        if (this.buf.length < sep + 4 + len) return;
        const msg = JSON.parse(this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8'));
        this.buf = this.buf.subarray(sep + 4 + len);
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
        }
      }
    });
    this.child.stderr.on('data', (d) => process.stderr.write(`[worker] ${d}`));
  }
  request(method, params = {}, timeoutMs = 120_000) {
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }
  close() { try { this.child.kill(); } catch {} }
}

const out = {
  meta: {
    startedAt: new Date().toISOString(),
    runs: RUNS,
    corpus: CORPUS,
    host: process.env.COMPUTERNAME,
    node: process.version,
    workerExe: WORKER,
  },
  ops: {},
  payload: {},
};

// ------------------------------------------------------------------- exec
{
  log('exec: native one-shot powershell.exe vs warm worker');
  const nat = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await spawnOnce(SHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-Date -Format o'], { cwd: CORPUS });
    nat.push(r.ms);
  }
  out.ops['exec.native'] = stat(nat);
  out.payload['exec.native'] = 0;

  const w = new Worker(WORKER, PROFILE);
  const tInit = now();
  await w.request('initialize');
  out.ops['worker.initialize'] = { ms: now() - tInit };
  await w.request('exec', { command: '$global:__warm = 1' });

  const rust = [];
  let payload = 0;
  for (let i = 0; i < RUNS; i++) {
    const { ms: t, r } = await time(() => w.request('exec', { command: 'Get-Date -Format o' }));
    rust.push(t);
    payload += JSON.stringify(r).length;
  }
  out.ops['exec.rust'] = stat(rust);
  out.payload['exec.rust'] = payload / RUNS;
  out.ratio = { exec: +(out.ops['exec.native'].mean / out.ops['exec.rust'].mean).toFixed(2) };

  // ----------------------------------------------------------------- search
  log('search: rg.exe spawn vs indexed worker search');
  {
    const nat = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await spawnOnce(RG, ['-n', '--no-heading', '--color', 'never', 'RETRIES', CORPUS], { cwd: CORPUS });
      nat.push(r.ms);
      out.payload['search.native'] = r.out.length;
    }
    out.ops['search.native'] = stat(nat);

    const warm = [];
    let payload = 0;
    for (let i = 0; i < RUNS; i++) {
      const { ms: t, r } = await time(() => w.request('search.text', { query: 'RETRIES', maxBytes: 6000 }));
      warm.push(t);
      payload += JSON.stringify(r).length;
    }
    out.ops['search.rust.warm'] = stat(warm);
    out.payload['search.rust'] = payload / RUNS;
    out.ratio.search = +(out.ops['search.native'].mean / out.ops['search.rust.warm'].mean).toFixed(2);

    const refresh = [];
    for (let i = 0; i < 3; i++) {
      const { ms: t } = await time(() => w.request('search.text', { query: 'RETRIES', refresh: true, maxBytes: 6000 }));
      refresh.push(t);
    }
    out.ops['search.rust.refresh'] = stat(refresh);
  }

  // ------------------------------------------------------------------- read
  log('read: Node fs slice vs worker fs.read');
  {
    const big = join(CORPUS, 'src', 'core', 'big.mjs');
    const nat = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = now();
      const text = readFileSync(big, 'utf8').split('\n').slice(1200, 1240).join('\n');
      nat.push(now() - t0);
      out.payload['read.native.40lines'] = text.length;
    }
    out.ops['read.native.40lines'] = stat(nat);

    const rust = [];
    let payload = 0;
    for (let i = 0; i < RUNS; i++) {
      const { ms: t, r } = await time(() => w.request('fs.read', { path: big, offset: 1201, limit: 40 }));
      rust.push(t);
      payload += JSON.stringify(r).length;
    }
    out.ops['read.rust.40lines'] = stat(rust);
    out.payload['read.rust.40lines'] = payload / RUNS;
    out.ratio.read = +(out.ops['read.native.40lines'].mean / out.ops['read.rust.40lines'].mean).toFixed(2);

    // whole-file payloads: what a naive "read the file" costs each side
    out.payload['read.native.wholefile'] = readFileSync(big, 'utf8').length;
  }

  // --------------------------------------------------------------- ls/stat
  log('ls/stat: Node fs vs worker');
  {
    const dir = join(CORPUS, 'src');
    const nat = [], rust = [];
    let payload = 0;
    for (let i = 0; i < RUNS; i++) {
      const t0 = now();
      readdirSync(dir);
      nat.push(now() - t0);
    }
    out.ops['ls.native'] = stat(nat);
    for (let i = 0; i < RUNS; i++) {
      const { ms: t, r } = await time(() => w.request('fs.list', { path: dir }));
      rust.push(t);
      payload += JSON.stringify(r).length;
    }
    out.ops['ls.rust'] = stat(rust);
    out.payload['ls.rust'] = payload / RUNS;

    const file = join(CORPUS, 'src', 'core', 'config.mjs');
    const nat2 = [], rust2 = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = now();
      statSync(file);
      nat2.push(now() - t0);
    }
    for (let i = 0; i < RUNS; i++) {
      const { ms: t } = await time(() => w.request('fs.stat', { path: file }));
      rust2.push(t);
    }
    out.ops['stat.native'] = stat(nat2);
    out.ops['stat.rust'] = stat(rust2);
  }

  // ------------------------------------------------------------- write/edit
  log('write/edit: Node fs vs worker fs.write / fs.edit');
  {
    const scratch = join(PROFILE, '.bench-corpus', 'scratch.mjs');
    const body = 'export const PAD = 1;\n'.repeat(280);
    const nat = [], rust = [];
    try {
      for (let i = 0; i < RUNS; i++) {
        const t0 = now();
        writeFileSync(scratch, body + `// ${i}\n`);
        nat.push(now() - t0);
      }
      out.ops['write.native'] = stat(nat);
    } catch (e) { out.ops['write.native'] = { error: String(e) }; }
    try {
      const rw = [];
      for (let i = 0; i < RUNS; i++) {
        const { ms: t } = await time(() => w.request('fs.write', { path: scratch, content: body + `// w${i}\n` }));
        rw.push(t);
      }
      out.ops['write.rust'] = stat(rw);
    } catch (e) { out.ops['write.rust'] = { error: String(e) }; }

    try {
      writeFileSync(scratch, 'const RETRIES = 3;\nexport default RETRIES;\n');
      const rw = [];
      for (let i = 0; i < RUNS; i++) {
        writeFileSync(scratch, 'const RETRIES = 3;\nexport default RETRIES;\n');
        const { ms: t } = await time(() => w.request('fs.edit', { path: scratch, oldString: '= 3;', newString: `= ${3 + (i % 2)};` }));
        rw.push(t);
      }
      out.ops['edit.rust'] = stat(rw);
      const en = [];
      for (let i = 0; i < RUNS; i++) {
        writeFileSync(scratch, 'const RETRIES = 3;\nexport default RETRIES;\n');
        const t0 = now();
        const text = readFileSync(scratch, 'utf8').replace('= 3;', `= ${3 + (i % 2)};`);
        writeFileSync(scratch, text);
        en.push(now() - t0);
      }
      out.ops['edit.native'] = stat(en);
    } catch (e) { out.ops['edit.rust'] = { error: String(e) }; }
  }

  w.close();
}

out.summary = {
  exec: `${out.ops['exec.native'].mean}ms -> ${out.ops['exec.rust'].mean}ms (${out.ratio.exec}x)`,
  search: `${out.ops['search.native'].mean}ms -> ${out.ops['search.rust.warm'].mean}ms (${out.ratio.search}x)`,
  read: `${out.ops['read.native.40lines'].mean}ms -> ${out.ops['read.rust.40lines'].mean}ms (${out.ratio.read}x)`,
  payload: {
    searchBytes: `${out.payload['search.native']} -> ${Math.round(out.payload['search.rust'])}`,
    read40Bytes: `${out.payload['read.native.40lines']} -> ${Math.round(out.payload['read.rust.40lines'])}`,
    wholeFileBytes: out.payload['read.native.wholefile'],
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
log('\n' + JSON.stringify(out.summary, null, 2));
log(`\nraw -> ${OUT}`);
