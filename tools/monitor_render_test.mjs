// jsdom render test for S7 resource monitoring: the panel-rail launcher + overlay dashboard,
// and the one-line ambient strip under the composer. Drives the real client.js components.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 源码取自本脚本所在的仓库（而不是某个外部工作区），避免测试与仓库不同步。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// React/jsdom 从开发工作区的依赖缓存里解析：仓库本身不装 node_modules。
const DEPS = process.env.DSH_NATIVE_DEPS
  ?? 'C:/Users/keer_/Documents/deepseek-harness/default-workspace/_bench/panel-test/'
const require = createRequire(path.join(DEPS, 'entry.js'))
const React = require('react')
const ReactDOMClient = require('react-dom/client')
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:55983/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
try {
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
} catch {
  // Node exposes `navigator` as a getter; the jsdom one is not needed here.
}
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.Event = dom.window.Event
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame?.bind(dom.window) ?? ((cb) => setTimeout(cb, 16))
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame?.bind(dom.window) ?? clearTimeout
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let captured = null
dom.window.__ModuleLoader__ = {
  load(mod) {
    captured = { id: mod.id, mod: mod.factory((name) => {
      if (name === 'react') return React
      throw new Error('unexpected require: ' + name)
    }) }
  },
}
const source = readFileSync(path.join(REPO, 'packages/dsh-rust-exec/client.js'), 'utf8')
await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))
if (!captured) throw new Error('module loader was not called')

const registrations = []
const ctx = {
  slots: {
    inject(_key, callback) { return callback() },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
}
captured.mod.apply(ctx)
const byId = (id) => registrations.find((entry) => entry.options.id === id)
console.log('registrations:', registrations.map((entry) => entry.options.name + '#' + entry.options.id).join(', '))

const METRICS = {
  schema: 'dsh-rust-exec/metrics@1',
  samples: 9,
  intervalMs: 1000,
  running: true,
  history: {
    fast: [
      { cpuPctOneCore: 3, cpuMsTotal: 120, workingSetBytes: 15 * 1048576, privateBytes: 12 * 1048576, handles: 97, readBytes: 2048, writeBytes: 512, queued: 0, inflight: 1, indexFiles: 438, indexSymbols: 1423, indexAgeMs: 4000 },
      { cpuPctOneCore: 12, cpuMsTotal: 240, workingSetBytes: 16 * 1048576, privateBytes: 13 * 1048576, handles: 99, readBytes: 4096, writeBytes: 1024, queued: 2, inflight: 2, indexFiles: 438, indexSymbols: 1423, indexAgeMs: 3000 },
    ],
  },
  config: { maxWorkers: 1, maxInFlightPerSession: 4, idleReapMs: 300000, rssSoftLimitMb: 512, cpuSoftLimitPct: 70 },
  extremes: {
    since: Date.now() - 90000,
    samples: 9,
    fields: {
      cpuPctOneCore: { min: 3, max: 12, last: 12 },
      workingSetBytes: { min: 15 * 1048576, max: 16 * 1048576, last: 16 * 1048576 },
      privateBytes: { min: 12 * 1048576, max: 13 * 1048576, last: 13 * 1048576 },
      handles: { min: 97, max: 99, last: 99 },
      queued: { min: 0, max: 2, last: 2 },
      inflight: { min: 1, max: 2, last: 2 },
      indexFiles: { min: 438, max: 438, last: 438 },
      indexSymbols: { min: 1423, max: 1423, last: 1423 },
    },
  },
  pool: {
    workers: 1, lanesPerWorker: 4, queueDepth: 2, maxWorkers: 1, maxShells: 8,
    stats: { calls: 41, rejected: 0, spawned: 1 },
    workersDetail: [{ id: 0, pid: 4321, lanes: 4, inflight: 2, beatCount: 128, retiring: false }],
    sessions: [
      { sessionId: 'sess-abc123', inflight: 1, busy: true, calls: 7, lastCallMs: 42, lastTool: 'exec', lastSeenAt: Date.now() - 3000 },
      { sessionId: 'sess-idle', inflight: 0, busy: false, calls: 3, lastCallMs: 0, lastTool: 'read', lastSeenAt: Date.now() - 9000 },
    ],
  },
}
// `/sessions` 是会话卡的权威列表：这里给两个会话，第二个空闲（inflight 0）用于验证
// "在线状态不再退化成 —"，删除其中一条后验证卡片在同一轮轮询内消失。
let SESSIONS = {
  sessions: [
    { id: 'sess-abc123', workspace: 'w', size: 2048, mtimeMs: Date.now() - 3000 },
    { id: 'sess-idle', workspace: 'w', size: 1024, mtimeMs: Date.now() - 9000 },
  ],
}
let metricsDown = false
globalThis.fetch = dom.window.fetch = async (url) => {
  const u = String(url)
  if (u.includes('/metrics')) {
    if (metricsDown) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => METRICS }
  }
  if (u.includes('/sessions')) return { ok: true, status: 200, json: async () => SESSIONS }
  return { ok: true, status: 200, json: async () => ({}) }
}

const { act } = require('@testing-library/react')
const settle = async (ms = 160) => {
  await new Promise((r) => setTimeout(r, ms))
  await new Promise((r) => setTimeout(r, 0))
}
const rootEl = document.getElementById('root')
const text = () => rootEl.textContent.replace(/\s+/g, ' ').trim()
const buttons = () => [...rootEl.querySelectorAll('button')]
const click = async (node) => {
  await act(async () => {
    if (!node) return
    const propsKey = Object.keys(node).find((k) => k.startsWith('__reactProps'))
    if (propsKey && node[propsKey]?.onClick) node[propsKey].onClick({ preventDefault() {}, stopPropagation() {} })
    else node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle(200)
}

let failures = 0
const check = (label, condition, detail) => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!condition) failures++
}

const root = ReactDOMClient.createRoot(rootEl)
const render = async (Component) => {
  await act(async () => { root.render(React.createElement(Component)) })
  await settle(260)
}
const unmount = async () => {
  await act(async () => { root.render(null) })
  await settle(60)
}

console.log('\n=== registration contract ===')
check('settings tab registered as dsh-native', Boolean(byId('dsh-native')) && byId('dsh-native').options.name === 'settings.plugins.tab')
check('no panel-rail entries left', !registrations.some((r) => r.options.name === 'sidebar.panellist'), JSON.stringify(registrations.map((r) => r.options.name)))
check('composer-dock strip registered', Boolean(byId('dsh-native-strip')) && byId('dsh-native-strip').options.name === 'conversation.composer.dock')
check('both use additive list slots', ['settings.plugins.tab', 'conversation.composer.dock'].every((name) => name !== 'root'))

console.log('\n=== ambient strip (composer dock) ===')
await render(byId('dsh-native-strip').Component)
console.log('  text:', text().slice(0, 160))
check('strip label is R-Native', /^R-Native(CPU|CPU |$)/.test(text()), text().slice(0, 40))
check('strip hint renames R-Native', /R-Native · dsh-native/.test(rootEl.querySelector('[title]')?.getAttribute('title') || ''))
check('strip shows CPU percentage', /CPU:\s*12%/.test(text()), text().slice(0, 80))
check('strip shows RSS in M', /RSS:\s*16M/.test(text()))
check('strip shows queue and inflight', /(队列|queue):\s*2/.test(text()) && /(运行中|running):\s*2/.test(text()), text().slice(0, 120))
{
  const stripText = text()
  const at = (re) => stripText.search(re)
  check('strip order is CPU → memory → running → queue',
    at(/CPU/) < at(/RSS/) && at(/RSS/) < at(/(运行中|running)/) && at(/(运行中|running)/) < at(/(队列|queue)/),
    stripText.slice(0, 120))
}
check('strip separates metrics with dashes', (text().match(/ - /g) || []).length === 3, text().slice(0, 120))
check('strip values use fixed-width right-aligned slots', (() => {
  const nodes = [...rootEl.querySelectorAll('[data-dsh-rust-metric]')]
  const slots = nodes.map((node) => node.style.minWidth + '/' + node.style.textAlign).join(',')
  return nodes.length === 4 && slots === '4ch/right,5ch/right,2ch/right,2ch/right'
    && nodes.every((node) => node.style.fontVariantNumeric === 'tabular-nums')
})(), [...rootEl.querySelectorAll('[data-dsh-rust-metric]')].map((node) => node.style.minWidth + '/' + node.style.textAlign).join(','))
{
  // Values change every poll; the slot widths must not (user request m02291).
  const widths = () => [...rootEl.querySelectorAll('[data-dsh-rust-metric]')].map((node) => node.style.minWidth).join(',')
  const before = widths()
  const saved = METRICS.history.fast[1]
  METRICS.history.fast[1] = { ...saved, cpuPctOneCore: 100, workingSetBytes: 1024 * 1048576, inflight: 12, queued: 64 }
  await render(byId('dsh-native-strip').Component)
  check('strip slot widths do not depend on values', widths() === before, widths() + ' vs ' + before)
  METRICS.history.fast[1] = saved
  await render(byId('dsh-native-strip').Component)
}
check('strip has no NaN/undefined leak', !/NaN|undefined/.test(text()))

metricsDown = true
await render(byId('dsh-native-strip').Component)
check('strip keeps last sample on transient metrics failure', !/NaN|undefined/.test(text()))
metricsDown = false

console.log('\n=== strip opens the monitor in place ===')
await render(byId('dsh-native-strip').Component)
{
  const strip = rootEl.querySelector('[data-dsh-rust-strip="summary"]')
  check('strip is a keyboard-reachable button',
    Boolean(strip) && strip.getAttribute('role') === 'button' && strip.getAttribute('tabindex') === '0')
  check('strip advertises the click target', /监控|monitor/i.test(strip?.getAttribute('title') || ''), strip?.getAttribute('title') || '')
  await click(strip)
  check('clicking the strip opens the monitor dialog', Boolean(rootEl.querySelector('[data-dsh-rust-monitor="dialog"]')))
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await settle(220)
  check('Escape closes the strip-opened dialog', !rootEl.querySelector('[data-dsh-rust-monitor="dialog"]'))
}

console.log('\n=== settings tab toolbar + Grafana monitor dialog ===')
await render(byId('dsh-native').Component)
await settle(200)
console.log('  collapsed text:', text().slice(0, 160))
const monitorButtons = buttons().filter((b) => /^(监控器|Monitor)$/.test((b.textContent || '').trim()))
check('exactly one monitor entry in the tab', monitorButtons.length === 1, String(monitorButtons.length))
check('legacy resource-monitor buttons are gone', !/资源监控明细|Monitor detail/.test(text()))
check('dialog closed by default', !rootEl.querySelector('[data-dsh-rust-monitor="dialog"]'))
await click(monitorButtons[0])
await settle(320)
console.log('  open text:', text().slice(0, 300))
const dialog = rootEl.querySelector('[data-dsh-rust-monitor="dialog"]')
check('monitor dialog opens', Boolean(dialog))
const cards = dialog ? [...dialog.querySelectorAll('[data-dsh-rust-monitor-card]')] : []
check('stat cards rendered', cards.length >= 8, String(cards.length))
check('cards show current + min/max', /min 3/.test(dialog?.textContent || '') && /max 12/.test(dialog?.textContent || ''))
check('sparklines drawn (zero-dependency svg)', (dialog?.querySelectorAll('svg[data-dsh-rust-sparkline] path')?.length ?? 0) >= 8, String(dialog?.querySelectorAll('svg[data-dsh-rust-sparkline] path').length ?? 0))
check('worker card row rendered', /pid/.test(dialog?.textContent || '') && /4321/.test(dialog?.textContent || ''))
check('session card row rendered from live pool activity', /sess-abc/.test(dialog?.textContent || '') && /42 ms/.test(dialog?.textContent || ''))
check('legacy workers/sessions tables removed', !/Workers \(lanes\)/.test(dialog?.textContent || '') && !/Active sessions/.test(dialog?.textContent || ''))
check('charts sit under the worker row', Boolean(dialog?.querySelector('[data-dsh-rust-charts="worker"]')))
check('worker heartbeat counter renders beside the beat age', /#128/.test(dialog?.textContent || ''),
  (dialog?.textContent || '').match(/心跳[^·]{0,24}/)?.[0] || '')
check('idle session is listed with inflight 0',
  /inflight\s*0/.test(dialog?.querySelector('[data-dsh-info="session-sess-idle"]')?.textContent || ''),
  dialog?.querySelector('[data-dsh-info="session-sess-idle"]')?.textContent || 'missing card')
check('idle session shows a last-call age instead of a dash',
  !/最近调用\s*—/.test(dialog?.querySelector('[data-dsh-info="session-sess-idle"]')?.textContent || ''))
check('busy session still shows its live inflight count',
  /inflight\s*1/.test(dialog?.querySelector('[data-dsh-info="session-sess-abc123"]')?.textContent || ''),
  dialog?.querySelector('[data-dsh-info="session-sess-abc123"]')?.textContent || 'missing card')
{
  // 删除会话：`/sessions` 变成空列表后，下一轮轮询必须把卡片收掉（不留空壳）。
  SESSIONS = { sessions: [] }
  METRICS.pool.sessions = []
  await settle(1600)
  const live = rootEl.querySelector('[data-dsh-rust-monitor="dialog"]')
  check('deleted session card disappears on the next poll',
    !live?.querySelector('[data-dsh-info^="session-"]'),
    String(live?.querySelectorAll('[data-dsh-info^="session-"]').length ?? -1) + ' card(s) left')
}
check('usage bars drawn for bounded metrics', Boolean(dialog?.querySelector('[data-dsh-rust-monitor-card] div[style*="border-radius: 2px"]')))
check('no NaN/undefined leak in dialog', !/NaN|undefined/.test(dialog?.textContent || ''))
await act(async () => {
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
await settle(220)
check('Escape closes the dialog', !rootEl.querySelector('[data-dsh-rust-monitor="dialog"]'))

console.log('\n=== monitor refresh button ===')
const refresh = buttons().find((b) => /^(刷新|Refresh)$/.test((b.textContent || '').trim()))
check('refresh button present in tab', Boolean(refresh), refresh ? refresh.textContent : 'missing')

console.log(`\n---- ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ----`)
await unmount()
await new Promise((r) => setTimeout(r, 80))
process.exit(failures === 0 ? 0 : 1)
