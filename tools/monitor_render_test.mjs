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
      // 三个长跨度会话：验证「最近调用」能表达 20 小时 / 2 天 / 3 月，而不是只到分钟。
      { sessionId: 'sess-old', inflight: 0, busy: false, calls: 4, lastCallMs: 0, lastTool: 'read', lastSeenAt: Date.now() - 20 * 3600_000 },
      { sessionId: 'sess-2d', inflight: 0, busy: false, calls: 5, lastCallMs: 0, lastTool: 'grep', lastSeenAt: Date.now() - 2 * 86400_000 },
      { sessionId: 'sess-3mo', inflight: 0, busy: false, calls: 6, lastCallMs: 0, lastTool: 'exec', lastSeenAt: Date.now() - 92 * 86400_000 },
    ],
  },
  // 节省报表（§15）：固定 1,093/轮 + 调用面（exec 20×13 + read 12×33 + stat 5×31 + write 3×26 = 889）。
  savings: {
    schema: 'dsh-rust-exec/savings@1',
    baselinePerTurn: 1812, residentPerTurn: 719, fixedPerTurn: 1093,
    turns: 12, calls: 40,
    byTool: { exec: 20, read: 12, stat: 5, write: 3 },
    callTokens: 889, savedTokens: 14005, savedSeconds: 311,
    outputTokPerSec: 45, indexBaselineMs: 171,
    perCall: { read: 33, write: 26, edit: 22, stat: 31, exec: 13, ls: 0, search: 0, symbols: 0, session_open: 0, health: 0 },
    basis: 'lower-bound',
    note: '每轮固定取 1.4.1 实测下界；调用面只计已实测六类；省时按 45 tok/s 估算',
    sessions: [
      { sessionId: 'sess-abc123', turns: 5, calls: 7, savedTokens: 5869, lastSeenAt: Date.now() - 3000, counted: true },
      { sessionId: 'sess-idle', turns: 4, calls: 3, savedTokens: 4586, lastSeenAt: Date.now() - 9000, counted: true },
      { sessionId: 'sess-old', turns: 3, calls: 4, savedTokens: 3439, lastSeenAt: Date.now() - 20 * 3600_000, counted: true },
    ],
  },
}
// `/sessions` 是会话卡的权威列表：这里给两个会话，第二个空闲（inflight 0）用于验证
// "在线状态不再退化成 —"，删除其中一条后验证卡片在同一轮轮询内消失。
let SESSIONS = {
  sessions: [
    { id: 'sess-abc123', workspace: 'w', size: 2048, mtimeMs: Date.now() - 3000 },
    { id: 'sess-idle', workspace: 'w', size: 1024, mtimeMs: Date.now() - 9000 },
    { id: 'sess-old', workspace: 'w', size: 1024, mtimeMs: Date.now() - 20 * 3600_000 },
    { id: 'sess-2d', workspace: 'w', size: 1024, mtimeMs: Date.now() - 2 * 86400_000 },
    { id: 'sess-3mo', workspace: 'w', size: 1024, mtimeMs: Date.now() - 92 * 86400_000 },
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
  if (u.includes('/cache')) return { ok: true, status: 200, json: async () => ({ schema: 'dsh-rust-exec/cache@1', index: { files: 438, symbols: 1423, buildMs: 92, reusedFiles: 438, parsedFiles: 0 } }) }
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
// 需求 A：监控弹窗高度降 15%（88vh → 75vh），内容仍完整可滚动。
check('monitor dialog height drops to 75vh',
  /max-height:\s*75vh/.test(dialog?.outerHTML || ''),
  (dialog?.outerHTML || '').match(/max-height:\s*[^;"]+/)?.[0] || 'missing max-height')
// 需求 B：长跨度必须能表达，而不是停在 `4h 12m` 或退化成 —。
{
  const cell = (id) => dialog?.querySelector(`[data-dsh-info="session-${id}"]`)?.textContent || ''
  check('last call shows a 20-hour span', /20 (小时前|h ago)/.test(cell('sess-old')), cell('sess-old'))
  check('last call shows a 2-day span', /2 (天前|d ago)/.test(cell('sess-2d')), cell('sess-2d'))
  check('last call shows a 3-month span', /3 (月前|mo ago)/.test(cell('sess-3mo')), cell('sess-3mo'))
  check('long-span cells keep the full timestamp on hover',
    /T/.test(dialog?.querySelector('[data-dsh-info="session-sess-3mo"] [title*="T"]')?.getAttribute('title') || ''),
    (dialog?.querySelector('[data-dsh-info="session-sess-3mo"] [title*="T"]')?.getAttribute('title') || 'missing title'))
}
// §15 节省报表：固定节省是实测常量，累计/省时/索引加速各有自己的口径与降级方式。
{
  const savingsCard = (id) => dialog?.querySelector(`[data-dsh-info="${id}"]`)?.textContent || ''
  check('savings row renders the measured per-request saving', /1,?093/.test(savingsCard('savings-fixed')), savingsCard('savings-fixed'))
  check('savings total reports tokens and turns', /14k|14,005|13\.1k|13k/.test(savingsCard('savings-total')) && /12/.test(savingsCard('savings-total')), savingsCard('savings-total'))
  check('index speedup uses the live buildMs against the 171 ms baseline', /92 ms/.test(savingsCard('savings-index')), savingsCard('savings-index'))
  const bar = dialog?.querySelector('[data-dsh-savings-bar]')
  const widths = bar ? [...bar.children].map((node) => parseFloat(node.style.width) || 0) : []
  check('savings bar segments cover the whole bar', widths.length >= 3 && Math.abs(widths.reduce((sum, w) => sum + w, 0) - 100) <= 0.6,
    widths.join('+') + ' = ' + widths.reduce((sum, w) => sum + w, 0).toFixed(1))
  const estimates = [...(dialog?.querySelectorAll('[data-dsh-est]') ?? [])]
  check('only the estimated card carries the est badge',
    estimates.length === 1 && Boolean(dialog?.querySelector('[data-dsh-info="savings-time"] [data-dsh-est]')),
    String(estimates.length) + ' badge(s)')
  check('savings session table lists turns/calls/savings', /sess-abc/.test(dialog?.querySelector('[data-dsh-savings-table]')?.textContent || ''),
    (dialog?.querySelector('[data-dsh-savings-table]')?.textContent || '').slice(0, 80))
  // 旧宿主没有 savings 块：四张卡必须整体降级成 —，且不能把弹窗打挂。
  const savedSavings = METRICS.savings
  delete METRICS.savings
  await settle(1400)
  const live = rootEl.querySelector('[data-dsh-rust-monitor="dialog"]')
  check('savings cards degrade to dashes without data',
    !live ? false : ['savings-fixed', 'savings-total', 'savings-time', 'savings-index']
      .every((id) => /—/.test(live.querySelector(`[data-dsh-info="${id}"]`)?.textContent || '')),
    live ? [...live.querySelectorAll('[data-dsh-info^="savings-"]')].map((node) => node.textContent?.trim().slice(0, 24)).join(' | ') : 'dialog gone')
  check('savings row survives a missing payload without NaN', !/NaN|undefined/.test(live?.textContent || 'missing dialog'))
  METRICS.savings = savedSavings
  await settle(1400)
}
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
