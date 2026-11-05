// 逐工具开关的主机侧断言（1.7.7 R2）：不需要 DSH 宿主，用假 Cordis ctx 挂载插件，
// 直接打 `/config` 与 `/metrics`，检查注册表真值而不只是响应体。
//
// 覆盖：
//   1. 默认 11 个工具全部注册；
//   2. POST {tools:{rust_write:false}} 后注册表里真的没了（disposer 被调用）；
//   3. `/metrics.tools` 回的是注册表真值，不是 settings 里的意图；
//   4. 打开回去会重新注册；
//   5. 未知工具名被忽略，不写盘、不报错；
//   6. 关掉的状态写进 settings.json。
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 落盘目录指到临时路径：测试不能碰用户真实设置（LOCALAPPDATA/dsh-rust-exec/settings.json）。
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-rust-exec-switch-'))
process.env.LOCALAPPDATA = sandbox

const { apply } = await import('../packages/dsh-rust-exec/index.js')

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ' — ' + detail}`)
}

const handlers = new Map()
const live = new Set()
const disposed = []
const webServer = {
  register({ path, handler }) {
    handlers.set(path, handler)
    return () => handlers.delete(path)
  },
}
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on() { return () => {} },
  effect(fn) {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  },
  get(name) { return name === 'webServer' ? webServer : undefined },
  tools: {
    register(definition) {
      live.add(definition.name)
      // 宿主契约：register 返回的函数就是精确注销（dsh-tools: "returns the exact disposer"）。
      return () => { live.delete(definition.name); disposed.push(definition.name) }
    },
  },
}

const request = async (method, path, payload) => {
  const handler = handlers.get(path)
  if (!handler) throw new Error('route not mounted: ' + path)
  const listeners = new Map()
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const req = {
    method,
    url: path,
    headers: {},
    on(event, fn) { listeners.set(event, fn); return this },
    destroy() {},
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    end(text) {
      this.body = text
      // 挂在 end 上触发请求体回调：readJsonBody 是 Promise + 事件。
      if (body) listeners.get('data')?.(Buffer.from(body))
      listeners.get('end')?.()
    },
  }
  const done = handler(req, res)
  if (body) listeners.get('data')?.(Buffer.from(body))
  listeners.get('end')?.()
  await done
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const CONFIG = '/api/dsh-rust-exec/config'
const METRICS = '/api/dsh-rust-exec/metrics'
const ALL = [
  'rust_exec', 'rust_read', 'rust_search', 'rust_health', 'native_help',
  'rust_write', 'rust_edit', 'rust_stat', 'rust_ls', 'rust_symbols', 'rust_session_open',
]

console.log('=== per-tool switches (1.7.7) ===')
// deferStart + 大延迟：本次只测注册表与配置面，不拉起 worker。
// progressiveDisclosure 关掉：11 个工具一次注册完，断言不用先走 native_help 激活。
const dispose = apply(ctx, { deferStart: true, startDelayMs: 600_000, lanes: 1, progressiveDisclosure: false })
await wait(80)

check('all 11 tools registered by default', ALL.every((name) => live.has(name)), live.size + '/' + ALL.length)
const first = await request('GET', METRICS)
check('/metrics.tools reports registry truth', first.body?.tools?.rust_exec === true && first.body?.tools?.rust_write === true)

const off = await request('POST', CONFIG, { tools: { rust_write: false } })
check('POST /config disposes the tool', off.status === 200 && off.body?.applied?.tools?.rust_write === false, JSON.stringify(off.body?.applied))
check('registry lost rust_write', !live.has('rust_write'))
check('disposer was the registered one', disposed.includes('rust_write'))
check('siblings untouched', live.has('rust_exec') && live.has('rust_edit'))

const afterOff = await request('GET', METRICS)
check('/metrics reflects the live registry', afterOff.body?.tools?.rust_write === false && afterOff.body?.tools?.rust_exec === true)
check('/metrics.config keeps the intent', afterOff.body?.config?.tools?.rust_write === false)

const on = await request('POST', CONFIG, { tools: { rust_write: true } })
check('POST /config re-registers the tool', on.status === 200 && live.has('rust_write'))

const unknown = await request('POST', CONFIG, { tools: { rust_nope: false } })
check('unknown tool name ignored', Object.keys(unknown.body?.applied ?? {}).length === 0, JSON.stringify(unknown.body?.applied))

// Persistence: the switch lands in settings.json under the sandboxed state dir.
const settingsFile = join(sandbox, 'dsh-rust-exec', 'settings.json')
check('switch persisted to settings.json', existsSync(settingsFile))
if (existsSync(settingsFile)) {
  const persisted = JSON.parse(readFileSync(settingsFile, 'utf8'))
  check('persisted file carries tools', persisted.tools?.rust_write === true && persisted.tools?.rust_exec === true, JSON.stringify(persisted.tools).slice(0, 80))
}

if (typeof dispose === 'function') dispose()
await wait(150)
rmSync(sandbox, { recursive: true, force: true })

console.log(failures === 0 ? '\n---- ALL PASS ----' : `\n---- ${failures} FAILURE(S) ----`)
process.exit(failures === 0 ? 0 : 1)
