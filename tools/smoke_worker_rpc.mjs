// smoke_worker_rpc.mjs — 1.6.2 fs 改动的行为验收（不依赖 DSH 重启）。
//
// 直接以插件身份拉起 dev worker，逐项验证本轮的语义改动：
//   fs.read 的 hash: none / prefix / full 三种模式、行窗口切片的行数与内容
//   fs.stat 的 paths[] 批量形态、fs.list 的 sizes:false、fs.write/fs.edit 的守卫与 hash
// 任何一项不符预期都会打印 FAIL 并以非零退出。
//
// usage: node tools/smoke_worker_rpc.mjs [path-to-plugin-index.js]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugin = process.argv[2] ?? 'E:\\study\\dsh-plugin\\packages\\dsh-rust-exec\\index.js'
const workspace = process.env.SMOKE_WORKSPACE ?? 'E:\\study\\dsh-plugin'
const probeHome = join(workspace, '.tmp', 'smoke-home')
mkdirSync(join(probeHome, 'run'), { recursive: true })
process.env.DSH_HOME = probeHome
process.env.DSH_PROFILE = 'smoke'

const { RustWorker } = await import(pathToFileURL(plugin).href)
const worker = new RustWorker(join(plugin, '..', 'bin', 'dsh-rust-worker.exe'), { lanes: 1 })

const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}: ${detail}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const file = join(workspace, '.tmp', 'smoke-rpc.mjs')
const dir = join(workspace, '.tmp', 'smoke-rpc-dir')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'child.mjs'), 'export const child = 1;\n')
writeFileSync(file, Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n')

try {
  await worker.start()

  // fs.read：行窗口 + 三种 hash 模式
  const full = await worker.call('fs.read', { path: file, offset: 3, limit: 4 }, 20_000)
  check('read window lines', full.content.split('\n').filter(Boolean).length === 4 && full.content.startsWith('export const line3'), JSON.stringify(full.content.slice(0, 24)))
  check('read totals', full.totalLines === 30 && full.totalBytes > 0, `lines=${full.totalLines}`)
  check('read hash full', typeof full.hash === 'string' && full.hash.length === 64, `len=${full.hash?.length}`)
  check('read offset 1 starts at first line', (await worker.call('fs.read', { path: file, limit: 1 }, 20_000)).content.startsWith('export const line1'))
  const prefixed = await worker.call('fs.read', { path: file, limit: 2, hash: 'prefix' }, 20_000)
  check('read hash prefix', prefixed.hash?.length === 16 && prefixed.hash === full.hash.slice(0, 16), `${prefixed.hash}`)
  const none = await worker.call('fs.read', { path: file, limit: 2, hash: 'none' }, 20_000)
  check('read hash none', none.hash === undefined || none.hash === null, String(none.hash))
  const lastWindow = await worker.call('fs.read', { path: file, offset: 29, limit: 5 }, 20_000)
  check('read tail clamp', lastWindow.content.startsWith('export const line29') && !lastWindow.content.includes('line31'), JSON.stringify(lastWindow.content.slice(0, 30)))

  // fs.stat：单条与批量
  const one = await worker.call('fs.stat', { path: file }, 20_000)
  check('stat single', one.exists === true && one.isDir === false && one.size > 0, `${one.size} B`)
  const many = await worker.call('fs.stat', { paths: [file, dir, join(workspace, '.tmp', 'nope-does-not-exist')] }, 20_000)
  check('stat batch shape', Array.isArray(many.entries) && many.entries.length === 3, `n=${many.entries?.length}`)
  check('stat batch semantics', many.entries[0].exists && many.entries[1].isDir && many.entries[2].exists === false)

  // fs.list：默认带 size，sizes:false 不带
  const sized = await worker.call('fs.list', { path: dir }, 20_000)
  check('list default has size', Array.isArray(sized.entries) && sized.entries.every((e) => 'size' in e), `n=${sized.entries.length}`)
  const unsized = await worker.call('fs.list', { path: dir, sizes: false }, 20_000)
  check('list sizes:false omits size', Array.isArray(unsized.entries) && unsized.entries.every((e) => !('size' in e)))

  // fs.write → fs.edit：守卫、替换计数、hash 变化
  const written = await worker.call('fs.write', { path: file, content: 'alpha\nbeta\ngamma\n' }, 20_000)
  check('write hash', typeof written.hash === 'string' && written.hash.length === 64 && written.bytes === 17, `bytes=${written.bytes}`)
  const stale = await worker.call('fs.write', { path: file, content: 'nope\n', expectedHash: '0'.repeat(64) }, 20_000).then(() => 'no-error', (err) => err.message)
  check('write guard rejects stale hash', /guard|expected/i.test(String(stale)), String(stale).split('\n')[0])
  const edited = await worker.call('fs.edit', { path: file, oldString: 'beta', newString: 'BETA', expectedHash: written.hash }, 20_000)
  check('edit replacement', edited.replacements === 1 && edited.hash !== written.hash, `sha ${edited.hash.slice(0, 8)}`)
  check('edit content persisted', (await worker.call('fs.read', { path: file, hash: 'none' }, 20_000)).content.includes('BETA'))
} catch (error) {
  failures.push(`threw: ${error?.message ?? error}`)
} finally {
  worker.kill('smoke finished')
  try { rmSync(file, { force: true }); rmSync(dir, { recursive: true, force: true }) } catch { /* optional */ }
}

console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nall checks passed')
process.exit(failures.length ? 1 : 0)
