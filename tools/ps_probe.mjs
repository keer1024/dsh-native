// Probe which PowerShell stdin-driven invocation actually streams output on Windows.
import { spawn } from 'node:child_process';

const variants = [
  { name: 'A: -Command - (plain)', args: ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], payload: 'Write-Output "hi-A"\n' },
  { name: 'B: -Command - + Flush', args: ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], payload: 'Write-Output "hi-B"; [Console]::Out.Flush()\n' },
  { name: 'C: -NoExit -Command -', args: ['-NoProfile', '-NoLogo', '-NonInteractive', '-NoExit', '-Command', '-'], payload: 'Write-Output "hi-C"\n' },
  { name: 'D: -Command - Write-Host', args: ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], payload: 'Write-Host "hi-D"\n' },
  { name: 'E: -EncodedCommand once', args: ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], payload: '[Console]::Out.Flush(); Write-Output "hi-E"\n' },
];

const probed = await Promise.all(
  variants.map((v) => new Promise((resolve) => {
    const child = spawn('powershell.exe', v.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t0 = performance.now();
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.stdin.write(v.payload);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ name: v.name, ms: Math.round(performance.now() - t0), exited: false, out: out.slice(0, 160), err: err.slice(0, 160) });
    }, 4000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ name: v.name, ms: Math.round(performance.now() - t0), exited: true, code, out: out.slice(0, 160), err: err.slice(0, 160) });
    });
  })),
);

for (const p of probed) {
  console.log(`\n### ${p.name}  (${p.ms}ms, exited=${p.exited}${p.exited ? ' code=' + p.code : ' — still alive: output did not stream'})`);
  console.log('  stdout:', JSON.stringify(p.out));
  if (p.err) console.log('  stderr:', JSON.stringify(p.err));
}
