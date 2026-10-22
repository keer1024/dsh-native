// jsdom render test for the S4 "Session projection" card inside the Rust plugin panel.
// Drives the real component: click Browse sessions -> session list loads -> first page renders
// -> Load more appends the next page through the same route with a cursor.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = 'C:/Users/keer_/Documents/deepseek-harness/default-workspace'
const require = createRequire(path.join(ROOT, '_bench/panel-test/'))
const React = require('react')
const ReactDOMClient = require('react-dom/client')
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="badge"></div></body></html>', {
  url: 'http://127.0.0.1:55983/settings',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
try {
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
} catch {
  // Node 24 exposes `navigator` as a getter; the jsdom one is not needed here.
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
const source = readFileSync(path.join(ROOT, 'packages/dsh-rust-exec/client.js'), 'utf8')
await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))
if (!captured) throw new Error('module loader was not called')

let registered = null
const registrations = []
const ctx = {
  slots: {
    inject(_key, callback) { return callback() },
    register(options, Component) {
      registrations.push({ options, Component })
      if (options.name === 'settings.plugins.tab') registered = { options, Component }
      return () => {}
    },
  },
}
captured.mod.apply(ctx)
if (!registered) throw new Error('nothing registered')
console.log('registrations:', registrations.map((r) => r.options.name + '#' + r.options.id).join(', '))

// ---- fetch harness -----------------------------------------------------------
const SESSIONS = [
  { id: 'session-aaa', workspace: 'w1', file: 'session.v4.jsonl.zstd', size: 2097152, mtimeMs: Date.now() - 60000 },
  { id: 'session-bbb', workspace: 'w1', file: 'session.v4.jsonl.zstd', size: 524288, mtimeMs: Date.now() - 3600000 },
]
const PAGE_1 = {
  schema: 'dsh-rust-exec/session-projection@1',
  total: 3,
  count: 0,
  counts: { messages: 3, toolCalls: 2 },
  timings: { mode: 'warm', cacheHit: true, totalMs: 1.5 },
  page: [
    { seq: 0, kind: 'system', name: '', turn: 1, step: 1, chars: 42, preview: 'system prompt' },
    { seq: 1, kind: 'user', name: '', turn: 1, step: 1, chars: 12, preview: 'hello there' },
  ],
  nextCursor: 2,
}
const PAGE_2 = {
  schema: 'dsh-rust-exec/session-projection@1',
  total: 3,
  counts: { messages: 3, toolCalls: 2 },
  timings: { mode: 'warm', cacheHit: true, totalMs: 0.9 },
  page: [{ seq: 2, kind: 'assistant', name: 'pwsh', turn: 1, step: 2, chars: 88, preview: 'ran the tests' }],
  nextCursor: null,
}
const calls = []
let metricsDown = false
const BIG_ROWS = Array.from({ length: 400 }, (_value, index) => ({
  seq: index, kind: index % 3 === 0 ? 'assistant' : 'tool', name: 'pwsh', turn: 1, step: index + 1, chars: 60, preview: 'row ' + index,
}))
const BODY = {
  schema: 'dsh-rust-exec/session-bodies@1',
  totalFrames: 100,
  framesUsed: 64,
  requested: 1,
  found: 1,
  partial: false,
  timings: { readMs: 1.2, decodeMs: 2.4, parseMs: 0.6, totalMs: 4.2 },
  items: [{
    seq: 1,
    kind: 'assistant',
    name: 'pwsh',
    t: 1,
    chars: 96,
    blocks: [
      { type: 'text', text: '**bold move** and `inline code` here', chars: 39, truncated: false },
      { type: 'text', text: '```powershell\nGet-ChildItem\nWrite-Host done\n```', chars: 47, truncated: false },
      { type: 'tool-call', text: '{"command":"Get-ChildItem"}', chars: 26, truncated: false },
    ],
  }],
}
globalThis.fetch = dom.window.fetch = async (url) => {
  const u = String(url)
  calls.push(u)
  if (u.includes('/session/body')) return { ok: true, status: 200, json: async () => BODY }
  if (u.includes('/sessions')) return { ok: true, status: 200, json: async () => ({ schema: 'dsh-rust-exec/sessions@1', sessions: SESSIONS }) }
  if (u.includes('/session?id=session-big')) {
    return { ok: true, status: 200, json: async () => ({ schema: 'dsh-rust-exec/session-projection@1', total: 400, counts: { messages: 400, toolCalls: 300 }, timings: { mode: 'head', totalMs: 12 }, page: BIG_ROWS, nextCursor: null, hasMore: false }) }
  }
  if (u.includes('/session?id=')) {
    const cursor = /cursor=(\d+)/.exec(u)
    return { ok: true, status: 200, json: async () => (cursor ? PAGE_2 : PAGE_1) }
  }
  if (u.includes('/metrics')) {
    if (metricsDown) return { ok: false, status: 500, json: async () => ({}) }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        schema: 'dsh-rust-exec/metrics@1',
        samples: 1,
        intervalMs: 1000,
        running: true,
        history: { fast: [{ cpuPctOneCore: 3, workingSetBytes: 15 * 1048576, queued: 0, inflight: 0, indexFiles: 438, indexSymbols: 1423, indexAgeMs: 1000 }] },
        config: { maxWorkers: 1, maxInFlightPerSession: 4, idleReapMs: 300000, rssSoftLimitMb: 512, cpuSoftLimitPct: 70 },
        pool: { workers: 1, lanesPerWorker: 4, queueDepth: 0, stats: { calls: 3, rejected: 0, spawned: 1 }, workersDetail: [{ id: 0, pid: 1234, lanes: 4, inflight: 0 }], sessions: [] },
      }),
    }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

const settle = async (ms = 150) => {
  await new Promise((r) => setTimeout(r, ms))
  await new Promise((r) => setTimeout(r, 0))
}
const { act } = require('@testing-library/react')
const text = () => document.getElementById('root').textContent.replace(/\s+/g, ' ').trim()
const buttons = () => [...document.querySelectorAll('#root button')]
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

const root = ReactDOMClient.createRoot(document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(registered.Component))
})
await settle(250)

console.log('\n[collapsed]', text().slice(0, 200))
check('projection card visible', /Session projection/.test(text()))
check('read-only note shown', /truth source stays in DSH/.test(text()))
check('session list not fetched while collapsed', !calls.some((u) => u.includes('/sessions')), calls.join(' '))

const browse = buttons().find((b) => /Browse sessions/.test(b.textContent))
check('browse button present', Boolean(browse))
await click(browse)

console.log('\n[expanded]', text().slice(0, 360))
check('session list fetched', calls.some((u) => u.includes('/sessions')))
check('session route called for first entry', calls.some((u) => u.includes('/session?id=session-aaa')))
check('two session options rendered', document.querySelectorAll('#root select option').length === 2, String(document.querySelectorAll('#root select option').length))
check('timing line rendered', /mode warm .*total 1(\.|,)?5? ?ms|total 2 ms|total 1/.test(text()) || /mode warm/.test(text()))
check('first page rows rendered', /hello there/.test(text()) && /system prompt/.test(text()))
check('counts rendered', /3 messages/.test(text()) && /2 tool calls/.test(text()))
check('load more shows progress', /Load more \(2\/3\)/.test(text()))

const more = buttons().find((b) => /Load more/.test(b.textContent))
check('load more button present', Boolean(more))
await click(more)

console.log('\n[appended]', text().slice(0, 420))
check('cursor used for second page', calls.some((u) => u.includes('cursor=2')), calls.filter((u) => u.includes('cursor')).join(' '))
check('second page appended', /ran the tests/.test(text()))
check('load more hidden at end', !/Load more/.test(text()))

// ---- composer badge removed (user request): the input dock must stay empty ----------
check(
  'no conversation.input.dock registration (bar above composer removed)',
  !registrations.some((r) => r.options.name === 'conversation.input.dock'),
  JSON.stringify(registrations.map((r) => r.options.name)),
)

// ---- additive conversation view (conversation.view) ---------------------------
const viewReg = registrations.find((r) => r.options.name === 'conversation.view')
check('conversation view registered additively', Boolean(viewReg), viewReg ? JSON.stringify(viewReg.options) : 'missing')
check('view id/order are ours', Boolean(viewReg) && viewReg.options.id === 'dsh-native-view' && viewReg.options.order === 20, viewReg ? viewReg.options.id + '/' + viewReg.options.order : '')
check('view label localized', Boolean(viewReg) && /dsh-native/.test(String(viewReg.options.label())), viewReg ? String(viewReg.options.label()) : '')

const viewHost = document.createElement('div')
viewHost.id = 'view'
document.body.appendChild(viewHost)
const viewRoot = ReactDOMClient.createRoot(viewHost)
calls.length = 0
await act(async () => {
  viewRoot.render(React.createElement(viewReg.Component, { sessionId: 'session-aaa' }))
})
await settle(250)
const viewText = () => (viewHost.textContent || '').replace(/\s+/g, ' ').trim()
const viewButtons = () => [...viewHost.querySelectorAll('button')]
console.log('\n[view]', viewText().slice(0, 300))
check('view fetches this plugin\'s projection route', calls.some((u) => u.includes('/session?id=session-aaa')), calls.join(' '))
check('view renders rows from the rust projection', /hello there/.test(viewText()) && /system prompt/.test(viewText()))
check('view shows counts and projection mode', /3 messages/.test(viewText()) && /mode warm/.test(viewText()))
check('view marks itself as plugin-rendered', viewHost.querySelector('[data-dsh-rust-view="conversation"]') !== null)
check('view has no NaN/undefined leak', !/NaN|undefined/.test(viewText()), viewText())

// ---- fixed header, fuzzy filter, fixed detail pane (user request m01324) ------
const headerEl = viewHost.querySelector('[data-dsh-rust-header="fixed"]')
check('header is a fixed row outside the scroll area', headerEl !== null && headerEl.parentElement === viewHost.querySelector('[data-dsh-rust-view="conversation"]'), headerEl ? String(headerEl.parentElement?.getAttribute('data-dsh-rust-view')) : 'missing')
check('header carries refresh and monitor buttons', viewButtons().some((b) => /刷新|Refresh/.test(b.textContent)) && viewButtons().some((b) => /监控器|Monitor/.test(b.textContent)))
check('fuzzy search box present', viewHost.querySelector('[data-dsh-rust-search]') !== null)
check('detail defaults to the first row', calls.some((u) => u.includes('/session/body')), calls.filter((u) => u.includes('/session/body')).join(' '))
const detailBox = viewHost.querySelector('[data-dsh-rust-view="detail"]')
check('detail pane width is fixed at 420', detailBox !== null && detailBox.getAttribute('data-dsh-rust-detail-width') === '420' && /420px/.test(detailBox.getAttribute('style') || ''), detailBox ? detailBox.getAttribute('style') : '')
check('detail pane is no longer draggable', viewHost.querySelector('[data-dsh-rust-split]') === null)

const typeInto = async (node, value) => {
  await act(async () => {
    const key = Object.keys(node).find((k) => k.startsWith('__reactProps'))
    if (key && node[key]?.onChange) node[key].onChange({ target: { value } })
  })
  await settle(200)
}
const search = viewHost.querySelector('[data-dsh-rust-search]')
await typeInto(search, 'system')
check('fuzzy filter narrows the list', viewHost.querySelectorAll('[data-dsh-rust-row]').length === 1, String(viewHost.querySelectorAll('[data-dsh-rust-row]').length))
check('filter shows filtered/total counter', /1 \/ 2/.test(viewText()), viewText().slice(0, 140))
check('contiguous hits are highlighted with <mark>', viewHost.querySelectorAll('mark').length > 0)
await typeInto(search, 'zzz-no-match')
check('empty filter state is explicit', /没有匹配的消息|No message matches/.test(viewText()), viewText().slice(0, 140))
await typeInto(search, '')
check('clearing the filter restores every row', viewHost.querySelectorAll('[data-dsh-rust-row]').length === 2, String(viewHost.querySelectorAll('[data-dsh-rust-row]').length))

// ---- kind filter is one dropdown, not a chip row (user request m02273) --------
const kindSelects = viewHost.querySelectorAll('[data-dsh-rust-kind]')
check('kind filter is a single select', kindSelects.length === 1 && kindSelects[0].tagName === 'SELECT', String(kindSelects.length))
check('kind chips are gone', viewHost.querySelectorAll('button[data-dsh-rust-kind]').length === 0)
const kindOptions = [...viewHost.querySelectorAll('[data-dsh-rust-kind] option')].map((option) => option.value)
check('kind options are all + every kind', kindOptions.join(',') === 'all,system,user', kindOptions.join(','))
const pickKind = async (value) => {
  await act(async () => {
    const node = viewHost.querySelector('[data-dsh-rust-kind]')
    const key = Object.keys(node).find((name) => name.startsWith('__reactProps'))
    if (key && node[key]?.onChange) node[key].onChange({ target: { value } })
  })
  await settle(200)
}
await pickKind('system')
check('kind dropdown filters the list', viewHost.querySelectorAll('[data-dsh-rust-row]').length === 1 && /1 \/ 2/.test(viewText()), viewText().slice(0, 140))
await pickKind('all')
check('kind dropdown restores every row', viewHost.querySelectorAll('[data-dsh-rust-row]').length === 2, String(viewHost.querySelectorAll('[data-dsh-rust-row]').length))

const viewMore = viewButtons().find((b) => /Load more|加载更多/.test(b.textContent))
check('view load-more button present', Boolean(viewMore))
await click(viewMore)
check('view appends the next page', /ran the tests/.test(viewText()), viewText().slice(-160))
check('view hides load-more at the end', !viewButtons().some((b) => /Load more|加载更多/.test(b.textContent)))

// ---- T2: full body on demand, minimal markdown, tool-card collapse -------------
const clickAny = async (node) => {
  await act(async () => {
    if (!node) return
    const propsKey = Object.keys(node).find((k) => k.startsWith('__reactProps'))
    if (propsKey && node[propsKey]?.onClick) node[propsKey].onClick({ preventDefault() {}, stopPropagation() {} })
    else node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle(200)
}
const rowOne = viewHost.querySelector('[data-dsh-rust-row="1"]')
check('view rows carry data-dsh-rust-row', rowOne !== null)
await clickAny(rowOne)
check('clicking a row fetches the full body', calls.some((u) => u.includes('/session/body') && u.includes('seqs=1')), calls.slice(-3).join(' '))
const viewHtml = () => viewHost.innerHTML
const detailHost = viewHost.querySelector('[data-dsh-rust-view="detail"]')
check('detail panel exists', detailHost !== null)
check('markdown bold rendered as <strong>', detailHost !== null && /<strong>bold move<\/strong>/.test(detailHost.innerHTML), detailHost ? detailHost.innerHTML.slice(0, 200) : '')
check('markdown inline code rendered as <code>', detailHost !== null && /<code[^>]*>inline code<\/code>/.test(detailHost.innerHTML), detailHost ? detailHost.innerHTML.slice(0, 300) : '')
check('markdown fenced block rendered as <pre>', detailHost !== null && /<pre[^>]*>[^<]*Get-ChildItem/.test(detailHost.innerHTML), detailHost ? detailHost.innerHTML.slice(0, 400) : '')
check('detail shows body timing', detailHost !== null && /4\.2 ms/.test(detailHost.textContent || ''), detailHost ? detailHost.textContent.slice(0, 120) : '')
check('tool-call block starts collapsed', detailHost !== null && !/\{"command"/.test(detailHost.textContent || ''), detailHost ? detailHost.textContent.slice(0, 200) : '')
const toolCallHeader = detailHost ? [...detailHost.querySelectorAll('div')].find((node) => {
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps'))
  return Boolean(key && node[key] && node[key].onClick) && /^tool-call/.test((node.textContent || '').trim())
}) : null
check('tool-call header present', Boolean(toolCallHeader))
await clickAny(toolCallHeader)
check('tool-call expands on click', /\{"command":"Get-ChildItem"\}/.test((detailHost && detailHost.textContent) || ''), detailHost ? detailHost.textContent.slice(0, 300) : '')
check('view has no NaN/undefined leak after body', !/NaN|undefined/.test(viewText()), viewText().slice(-200))
viewRoot.unmount()

// ---- T2: windowed rendering keeps a 400-row page small ------------------------
const bigHost = document.createElement('div')
bigHost.id = 'view-big'
document.body.appendChild(bigHost)
const bigRoot = ReactDOMClient.createRoot(bigHost)
await act(async () => {
  bigRoot.render(React.createElement(viewReg.Component, { sessionId: 'session-big' }))
})
await settle(250)
const renderedRows = bigHost.querySelectorAll('[data-dsh-rust-row]').length
console.log('\n[view-big] rendered rows:', renderedRows, 'of 400')
check('big page reports all messages', /400 messages/.test((bigHost.textContent || '').replace(/\s+/g, ' ')))
check('windowed rendering caps DOM rows', renderedRows > 0 && renderedRows < 60, String(renderedRows))
bigRoot.unmount()

console.log(`\n---- ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ----`)
process.exit(failures === 0 ? 0 : 1)
