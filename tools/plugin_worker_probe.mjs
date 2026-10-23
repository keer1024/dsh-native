// Exercises the shipped 1.6.1 worker-relocation path without restarting DSH.
//
// Imports the *deployed* plugin module, starts a real worker through RustWorker,
// and writes a workspace file — the exact call that failed with
// `拒绝访问 (os error 5)` before the fix. DSH_HOME points at .tmp so this probe
// can never touch the profile lock the live DSH worker owns.
//
// usage: node tools/plugin_worker_probe.mjs [path-to-plugin-index.js]
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const plugin = process.argv[2]
  ?? 'C:\\Users\\keer_\\Documents\\deepseek-harness\\default-workspace\\packages\\dsh-rust-exec\\index.js';
const workspace = 'E:\\study\\dsh-plugin';
const probeHome = join(workspace, '.tmp', 'probe-home');
mkdirSync(join(probeHome, 'run'), { recursive: true });
process.env.DSH_HOME = probeHome;
process.env.DSH_PROFILE = 'probe';

const { RustWorker } = await import(pathToFileURL(plugin).href);
const worker = new RustWorker(join(plugin, '..', 'bin', 'dsh-rust-worker.exe'), { lanes: 1 });
const report = { plugin };
try {
  await worker.start();
  const health = await worker.health();
  report.workerPid = health.worker?.pid ?? null;
  report.integrity = health.integrity;
  report.relocated = health.relocated;
  report.workerPath = health.workerPath;
  report.sourceWorkerPath = health.sourceWorkerPath;
  report.logPath = health.logPath;
  const target = join(workspace, '.tmp', 'plugin-probe.txt');
  try {
    const write = await worker.call('fs.write', { path: target, content: 'written through the relocated worker\n' }, 20_000);
    report.write = { ok: true, bytes: write.bytes };
  } catch (error) {
    report.write = { ok: false, error: (error?.message ?? String(error)).split('\n')[0] };
  }
  report.recentErrors = (await worker.health()).recentErrors?.length ?? 0;
  if (process.env.PROBE_DENIED === '1') {
    // A path the user owns but cannot write: the failure must be logged and must
    // grow the actionable hint instead of a bare `os error 5`.
    const denied = process.env.PROBE_DENIED_PATH
      ?? join('C:\\Windows\\System32\\drivers\\etc', 'dsh-native-probe.txt');
    try {
      await worker.call('fs.write', { path: denied, content: 'nope\n' }, 20_000);
      report.denied = { denied: false };
    } catch (error) {
      report.denied = { denied: true, message: error?.message };
    }
    report.recentErrorsAfter = (await worker.health()).recentErrors?.length ?? 0;
  }
} catch (error) {
  report.startError = error?.message ?? String(error);
} finally {
  worker.kill('probe finished');
  try { rmSync(join(workspace, '.tmp', 'plugin-probe.txt'), { force: true }); } catch { /* optional */ }
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.write?.ok ? 0 : 1);
