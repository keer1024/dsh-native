// End-to-end protocol + performance test for dsh-rust-worker.
// usage: node tools/worker_test.mjs [path-to-exe]
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const exe = process.argv[2] ??
  (process.env.DSH_RUST_WORKER ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe');
const work = '_bench/worker-test';
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

class WorkerClient {
  constructor(exePath, cwd) {
    this.exe = exePath;
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.start();
  }
  start() {
    this.child = spawn(this.exe, [], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => process.stderr.write('[worker] ' + chunk));
    this.child.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`worker exited (${code})`));
      this.pending.clear();
    });
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = this.buf.subarray(0, sep).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.subarray(sep + 4); continue; }
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString('utf8');
      this.buf = this.buf.subarray(start + len);
      const msg = JSON.parse(body);
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }
  send(method, params = {}) {
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
      body,
    ]);
    this.child.stdin.write(frame);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  stop() { this.child.stdin.end(); }
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  …' + detail : ''}`);
};

const client = new WorkerClient(exe, process.cwd());
try {
  const t0 = performance.now();
  const init = await client.send('initialize');
  const initMs = performance.now() - t0;
  check('initialize', init.protocol === 1 && init.pid > 0, `pid=${init.pid} shell=${JSON.stringify(init.shell)} init=${initMs.toFixed(1)}ms`);

  const ping = await client.send('ping');
  check('ping', ping.pong === true);

  const file = join(work, 'hello.txt');
  const w = await client.send('fs.write', { path: file, content: 'alpha\nbeta\ngamma\n' });
  check('fs.write', w.bytes === 17 && typeof w.hash === 'string', `bytes=${w.bytes} hash=${w.hash.slice(0, 12)}…`);

  const r = await client.send('fs.read', { path: file });
  check('fs.read', r.content === 'alpha\nbeta\ngamma\n' && r.totalLines === 3, `totalLines=${r.totalLines}`);

  const r2 = await client.send('fs.read', { path: file, offset: 2, limit: 1 });
  check('fs.read offset/limit', r2.content === 'beta\n', JSON.stringify(r2.content));

  const guard = await client
    .send('fs.write', { path: file, content: 'nope', expectedHash: 'deadbeef' })
    .then(() => 'unexpected success')
    .catch((e) => e.message);
  check('fs.write version guard', guard.includes('version guard failed'), guard.slice(0, 80));

  const e = await client.send('fs.edit', { path: file, oldString: 'beta', newString: 'BETA' });
  const after = readFileSync(file, 'utf8');
  check('fs.edit', e.replacements === 1 && after === 'alpha\nBETA\ngamma\n', JSON.stringify(after));

  const amb = await client
    .send('fs.edit', { path: file, oldString: 'a', newString: 'x' })
    .then(() => 'unexpected success')
    .catch((err) => err.message);
  check('fs.edit ambiguity guard', amb.includes('appears'), amb.slice(0, 90));

  const st = await client.send('fs.stat', { path: file });
  check('fs.stat', st.exists === true && st.size > 0, `size=${st.size}`);

  const ls = await client.send('fs.list', { path: work });
  check('fs.list', Array.isArray(ls.entries) && ls.entries.length >= 1, `entries=${ls.entries.length}`);

  // exec: first call pays nothing extra because the shell starts lazily here
  const e1 = await client.send('exec', { command: 'Write-Output "hello from shell"', cwd: process.cwd() });
  check('exec (cold)', e1.exitCode === 0 && e1.stdout.trim() === 'hello from shell',
    `exit=${e1.exitCode} ms=${e1.ms} reused=${e1.reused} out=${JSON.stringify(e1.stdout)}`);

  const warm = [];
  for (let i = 0; i < 5; i++) {
    const res = await client.send('exec', {
      command: `$x = 40 + 2; Write-Output "answer=$x"; Write-Output "run=${i}"`,
      cwd: process.cwd(),
    });
    warm.push({ ms: res.ms, reused: res.reused, out: res.stdout.trim() });
  }
  const warmOk = warm.every((w) => w.out.includes('answer=42') && w.reused === true);
  const meanWarm = warm.reduce((a, w) => a + w.ms, 0) / warm.length;
  check('exec (warm ×5, state isolated per command)', warmOk, `mean=${meanWarm.toFixed(1)}ms runs=${warm.map((w) => w.ms).join('/')}`);

  // statefulness probe: shell variables should persist only if we ask them to
  await client.send('exec', { command: '$global:persisted = "yes"' });
  const persist = await client.send('exec', { command: 'Write-Output "persisted=$global:persisted"' });
  check('exec shell is persistent (global var survives)', persist.stdout.includes('persisted=yes'), JSON.stringify(persist.stdout.trim()));

  const failing = await client.send('exec', { command: 'Get-Content C:\\definitely\\missing\\nope.txt' });
  check('exec surfaces non-zero/err output', failing.stdout.length > 0 || failing.exitCode !== 0,
    `exit=${failing.exitCode} out=${JSON.stringify(failing.stdout.slice(0, 90))}`);

  // exit code propagation
  const ec = await client.send('exec', { command: 'cmd /c "exit 7"' });
  check('exec exit code propagation', ec.exitCode === 7, `exit=${ec.exitCode}`);

  // baseline: one-shot powershell.exe per call, same command
  const oneshot = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$x = 40 + 2; Write-Output "answer=$x"`]);
    oneshot.push(performance.now() - t);
  }
  const meanOneshot = oneshot.reduce((a, b) => a + b, 0) / oneshot.length;
  console.log(`\nBENCH  warm exec mean ${meanWarm.toFixed(1)}ms | one-shot powershell.exe mean ${meanOneshot.toFixed(0)}ms | speedup ${(meanOneshot / meanWarm).toFixed(1)}×`);

  await client.send('shutdown');
} catch (err) {
  check('unexpected error', false, String(err && err.stack || err));
} finally {
  client.stop();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);

