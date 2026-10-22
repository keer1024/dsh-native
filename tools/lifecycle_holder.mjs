// Holds one RustWorker alive so a parent script can test crash/stale scenarios.
// Prints `READY <workerPid>` once the handshake settled, then idles until killed.
import { RustWorker } from '../packages/dsh-rust-exec/index.js'

const worker = new RustWorker(process.env.DSH_RUST_WORKER_PATH)
const info = await worker.start()
const workerPid = info?.welcome?.workerPid ?? info?.pid
console.log(`READY ${workerPid}`)
setInterval(() => {}, 1_000).unref?.()
process.stdin.resume()
process.stdin.on('end', () => {
  worker.kill('holder stopped')
  process.exit(0)
})
