// bench.mjs …same-methodology comparison: one-shot powershell.exe (what DSH's built-in
// `pwsh` tool does today) vs the persistent Rust worker shell.
//
// usage: node tools/bench.mjs [runs]
//
// It measures the two things that decide the win:
//   1. shell command cost (spawn overhead vs warm round-trip)
//   2. file-read cost (Node fs vs worker fs.read over the same bytes)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const RUNS = Number(process.argv[2] ?? 12);
const WORKER = (process.env.DSH_RUST_WORKER ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe');
const SHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const COMMAND = 'Get-ChildItem C:\\Users\\keer_\\Documents\\deepseek-harness | Select-Object -First 3 -ExpandProperty Name';

const now = () => Number(process.hrtime.bigint() / 1_000_000n);
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p50: q(0.5), p95: q(0.95), min: s[0], max: s[s.length - 1] };
};
const fmt = (s) => `mean=${s.mean.toFixed(0)}ms p50=${s.p50}ms p95=${s.p95}ms min=${s.min}ms`;

// ---------------------------------------------------------------------------
// one-shot powershell.exe …the baseline DSH pays per `pwsh` tool call
// ---------------------------------------------------------------------------
function oneShot(command) {
  return new Promise((resolve, reject) => {
    const started = now();
    const child = spawn(SHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: 'C:\\Users\\keer_\\Documents\\deepseek-harness\\default-workspace',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => resolve({ ms: now() - started, code, out }));
  });
}

// ---------------------------------------------------------------------------
// persistent worker
// ---------------------------------------------------------------------------
class Worker {
  constructor(bin) {
    this.pending = new Map();
    this.nextId = 1;
    this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.buf = Buffer.alloc(0);
    this.child.stdout.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const sep = this.buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const header = this.buf.subarray(0, sep).toString('ascii');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) { this.buf = this.buf.subarray(sep + 4); continue; }
        const len = Number(m[1]);
        if (this.buf.length < sep + 4 + len) return;
        const body = this.buf.subarray(sep + 4, sep + 4 + len);
        this.buf = this.buf.subarray(sep + 4 + len);
        const msg = JSON.parse(body.toString('utf8'));
        const waiter = this.pending.get(msg.id);
        if (waiter) { this.pending.delete(msg.id); msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result); }
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
  close() { this.child.kill(); }
}

const results = {};
const LOG = (m) => process.stdout.write(m + '\n');

// --- exec benchmark
LOG('spawning worker...');
const wrk = new Worker(WORKER);
const initStarted = now();
await wrk.request('initialize');
results.init = now() - initStarted;
LOG(`worker ready in ${results.init}ms`);

// warm the shell so the first measured call is not the PowerShell boot
const warmupStarted = now();
await wrk.request('exec', { command: '$global:__bench = 1' });
results.shellBoot = now() - warmupStarted;

const warm = [];
LOG(`warming persistent shell (pays one PowerShell boot)...`);
for (let i = 0; i < RUNS; i++) {
  const t = now();
  await wrk.request('exec', { command: COMMAND });
  warm.push(now() - t);
}
results.execWarm = stat(warm);
LOG(`warm exec done: ${fmt(results.execWarm)}`);

const cold = [];
LOG(`running ${RUNS} one-shot powershell.exe baselines...`);
for (let i = 0; i < RUNS; i++) {
  const r = await oneShot(COMMAND);
  cold.push(r.ms);
  LOG(`  baseline ${i + 1}/${RUNS}: ${r.ms}ms`);
}
results.execOneShot = stat(cold);
results.speedup = results.execOneShot.mean / results.execWarm.mean;
wrk.close();

// --- fs read benchmark: 1 MiB text file
const target = '_bench\\bench-fixture.txt';
const big = 'x'.repeat(1024) + '\n';
const bigText = big.repeat(1024); // ~1 MiB
const before = readFileSync;
{
  const t = now();
  // warm the worker again for the fs comparison
  const w = new Worker(WORKER);
  await w.request('initialize');
  await w.request('fs.write', { path: target, content: bigText });
  const nodeReads = [];
  for (let i = 0; i < 20; i++) {
    const s = now();
    const text = readFileSync(target, 'utf8');
    createHash('sha256').update(text).digest('hex');
    nodeReads.push(now() - s);
  }
  const workerReads = [];
  for (let i = 0; i < 20; i++) {
    const s = now();
    await w.request('fs.read', { path: target });
    workerReads.push(now() - s);
  }
  results.nodeRead = stat(nodeReads);
  results.workerRead = stat(workerReads);
  w.close();
}

console.log(JSON.stringify(results, null, 2));
console.log('\n--- summary ---');
console.log(`exec one-shot powershell.exe : ${fmt(results.execOneShot)}`);
console.log(`exec persistent Rust worker  : ${fmt(results.execWarm)}  (shell already booted)`);
console.log(`speedup                      : ${results.speedup.toFixed(1)}x  (saves ${(results.execOneShot.mean - results.execWarm.mean).toFixed(0)}ms per command)`);
console.log(`shell boot (once per session): ${results.shellBoot}ms, worker init ${results.init}ms`);
console.log(`1 MiB read …node fs         : ${fmt(results.nodeRead)}`);
console.log(`1 MiB read …worker fs.read  : ${fmt(results.workerRead)}`);

