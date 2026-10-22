// debug_bench.mjs …step-by-step probe of the bench hang, with progressive logging.
import { spawn } from 'node:child_process';
const LOG = (m) => { process.stdout.write(m + '\n'); };
const now = () => Number(process.hrtime.bigint() / 1_000_000n);
const WORKER = (process.env.DSH_RUST_WORKER ?? 'packages/dsh-rust-exec/bin/dsh-rust-worker.exe');

LOG('step1: spawn worker');
const child = spawn(WORKER, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.on('error', (e) => LOG('child error: ' + e.message));
child.on('exit', (c, s) => LOG(`child exit code=${c} sig=${s}`));
child.stderr.on('data', (d) => LOG('[worker stderr] ' + d.toString().trim()));

const pending = new Map();
let nextId = 1;
let buf = Buffer.alloc(0);
child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString('ascii'));
    if (!m) { buf = buf.subarray(sep + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString('utf8'));
    buf = buf.subarray(sep + 4 + len);
    const w = pending.get(msg.id);
    LOG(`<- response id=${msg.id} ${msg.error ? 'ERROR ' + msg.error.message : 'ok'}`);
    if (w) { pending.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result); }
  }
});

function req(method, params = {}, timeoutMs = 60000) {
  const id = nextId++;
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
  LOG(`-> ${method} id=${id} (${body.length}B)`);
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
  });
}

let t = now();
LOG('step2: initialize');
LOG(JSON.stringify(await req('initialize')).slice(0, 300) + `  (${now() - t}ms)`);

t = now();
LOG('step3: first exec (pays PowerShell boot)');
const r1 = await req('exec', { command: '$global:mark = 7; "boot ok"' });
LOG(`  exit=${r1.exitCode} out=${JSON.stringify(r1.stdout)} shellMs=${r1.shellMs} (${now() - t}ms)`);

t = now();
LOG('step4: warm exec x3');
for (let i = 0; i < 3; i++) {
  const s = now();
  const r = await req('exec', { command: 'Get-ChildItem C:\\Users\\keer_\\Documents\\deepseek-harness | Select-Object -First 3 -ExpandProperty Name' });
  LOG(`  run${i}: ${now() - s}ms exit=${r.exitCode} shellMs=${r.shellMs} out=${JSON.stringify(r.stdout).slice(0, 80)}`);
}

t = now();
LOG('step5: state persistence check');
const r2 = await req('exec', { command: '$global:mark' });
LOG(`  mark=${JSON.stringify(r2.stdout)} (${now() - t}ms)`);

child.kill();
LOG('done');
process.exit(0);

