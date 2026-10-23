// Proves the 1.6.1 diagnostics fix for "工具调用报 拒绝访问 (os error 5)".
//
// DSH's sandbox stamps `Low Mandatory Level` on executables it finds inside a
// workspace, and Windows starts such an image at Low integrity even when the
// parent is High. A Low-IL worker can run commands and read the disk, but every
// write to a file the user owns is denied — which is exactly what rust_write /
// rust_edit hit. A plain copy drops the label, so `relocateWorker` in index.js
// starts the copy instead of the labelled original.
//
// usage: node tools/verify_low_il_fix.mjs [path-to-exe]
// Writes only under .tmp/ plus %LOCALAPPDATA%\dsh-native\bin.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const WORKSPACE = 'E:\\study\\dsh-plugin';
const STAMP = Date.now();
const PROBE = join(WORKSPACE, '.tmp', `il-proof-${STAMP}.txt`);
const source = process.argv[2] ?? join(
  'C:\\Users\\keer_\\Documents\\deepseek-harness\\default-workspace\\packages\\dsh-rust-exec\\bin',
  'dsh-rust-worker.exe',
);

class Client {
  constructor(exe, cwd) {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.stderr = '';
    this.child = spawn(exe, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-2000); });
    this.child.on('error', (error) => this.#rejectAll(error));
    this.child.on('exit', (code) => this.#rejectAll(new Error(`worker exited (${code}) ${this.stderr.slice(-300)}`)));
  }
  #onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString('ascii'));
      if (!match) { this.buf = this.buf.subarray(sep + 4); continue; }
      const body = sep + 4 + Number(match[1]);
      if (this.buf.length < body) return;
      const msg = JSON.parse(this.buf.subarray(sep + 4, body).toString('utf8'));
      this.buf = this.buf.subarray(body);
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
    }
  }
  #rejectAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    this.child.stdin.write(Buffer.concat([
      Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'),
      payload,
    ]));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  stop() {
    this.child.stdin.end();
  }
}

/** `icacls` prints the label Windows honours at launch; no line means unlabelled. */
function integrity(path) {
  const probe = spawnSync('icacls', [path], { encoding: 'utf8', windowsHide: true, timeout: 8_000 });
  if (probe.error) return 'unknown';
  return /Low Mandatory Level/i.test(probe.stdout) ? 'low' : 'normal';
}

/** Same naming rule as `relocateWorker` in packages/dsh-rust-exec/index.js. */
function relocate(path) {
  const info = statSync(path);
  const target = join(process.env.LOCALAPPDATA, 'dsh-native', 'bin', `${basename(path, '.exe')}-${info.size}-${Math.round(info.mtimeMs)}.exe`);
  mkdirSync(join(process.env.LOCALAPPDATA, 'dsh-native', 'bin'), { recursive: true });
  copyFileSync(path, `${target}.partial`);
  renameSync(`${target}.partial`, target);
  return target;
}

const fail = (error) => (error?.message ?? String(error)).split('\n')[0];

async function probeWrite(exe, label) {
  const client = new Client(exe, WORKSPACE);
  try {
    const init = await client.send('initialize');
    let outcome;
    try {
      const write = await client.send('fs.write', { path: `${PROBE}.${label}`, content: `written by ${label}\n` });
      outcome = { ok: true, bytes: write.bytes, hash: String(write.hash ?? '').slice(0, 12) };
    } catch (error) {
      outcome = { ok: false, error: fail(error) };
    }
    // A read proves the process is otherwise healthy, so a write denial cannot be
    // blamed on a broken worker.
    const read = await client.send('fs.read', { path: 'C:\\Windows\\win.ini' }).then(() => 'ok').catch(fail);
    return { label, pid: init.pid, integrity: integrity(exe), read, ...outcome };
  } catch (error) {
    return { label, error: fail(error) };
  } finally {
    client.stop();
  }
}

mkdirSync(join(WORKSPACE, '.tmp'), { recursive: true });
console.log(`source: ${source}`);
console.log(`label:  ${integrity(source)}`);
const copy = relocate(source);
console.log(`copy:   ${copy}`);
console.log(`label:  ${integrity(copy)}\n`);

const results = [await probeWrite(source, 'original'), await probeWrite(copy, 'relocated')];
for (const result of results) {
  const status = result.error ? 'ERROR' : result.ok ? 'PASS write' : 'FAIL write';
  console.log(`${status.padEnd(10)} ${result.label.padEnd(10)} integrity=${result.integrity} read=${result.read} `
    + (result.ok ? `bytes=${result.bytes}` : (result.error ?? '')));
}
for (const suffix of ['original', 'relocated']) {
  try { rmSync(`${PROBE}.${suffix}`, { force: true }); } catch { /* left behind is harmless */ }
}
console.log(JSON.stringify({ source, copy, results }));
process.exit(0);
