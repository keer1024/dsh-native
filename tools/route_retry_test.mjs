// Regression test for the "metrics route 404" seam bug.
//
// The failure this pins down: DSH activates services in dependency order, and a
// plugin applied *before* `webServer` exists used to log `routes.skipped` once and
// never retry — the HTTP metrics route was then missing for the whole boot, so the
// resource panel showed "metrics unavailable: HTTP 404" forever.
//
// The contract under test:
//   1. apply() with no webServer must not throw and must register no routes yet;
//   2. when webServer appears a few hundred ms later, every route is mounted;
//   3. `rust_health` reports the mount state and the probe count;
//   4. disposing the plugin's route effect unmounts everything.
//
// Run: node tools/route_retry_test.mjs
import { apply } from '../packages/dsh-rust-exec/index.js'

const EXPECTED_PATHS = [
  '/api/dsh-rust-exec/metrics',
  '/api/dsh-rust-exec/health',
  '/api/dsh-rust-exec/events',
  '/api/dsh-rust-exec/sessions',
  '/api/dsh-rust-exec/session',
  '/api/dsh-rust-exec/session/body',
  '/api/dsh-rust-exec/config',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failures = []
function check(name, ok, detail) {
  if (ok) {
    console.log('  PASS ' + name)
    return
  }
  failures.push(name + (detail ? ' — ' + detail : ''))
  console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''))
}

let webServer = null
const handlers = new Map()
const effects = []
const definitions = []
const logs = []

const ctx = {
  tools: {
    register(definition) {
      definitions.push(definition)
      return () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  get(name) {
    return name === 'webServer' ? webServer : undefined
  },
  on() {},
  logger: (level) => (...args) => logs.push({ level, args }),
  log: {
    info(...args) { logs.push({ level: 'info', args }) },
    warn(...args) { logs.push({ level: 'warn', args }) },
    error(...args) { logs.push({ level: 'error', args }) },
  },
}

const config = {
  workerPath: 'C:\\no-such-dir\\dsh-rust-worker.exe',
  defaultTimeoutMs: 2000,
}

console.log('scenario: webServer appears 600 ms after apply()')
apply(ctx, config)

const t0 = Date.now()
await sleep(400)
check('no routes mounted while webServer is absent', handlers.size === 0, 'handlers=' + handlers.size)
check('apply() registered the tool definitions anyway', definitions.length >= 9, 'definitions=' + definitions.length)

webServer = {
  register(route) {
    handlers.set(route.path, route.handler)
    return () => {
      handlers.delete(route.path)
    }
  },
}

let mounted = false
for (let i = 0; i < 20 && !mounted; i++) {
  await sleep(150)
  mounted = EXPECTED_PATHS.every((path) => handlers.has(path))
}
const elapsed = Date.now() - t0
check('all six routes mount once webServer appears', mounted, 'mounted=' + handlers.size + ' after ' + elapsed + ' ms')
check('mount happened on a retry attempt, not the first probe', elapsed > 400, elapsed + ' ms')

const health = definitions.find((definition) => definition.name === 'rust_health')
check('rust_health is registered', Boolean(health))
if (health) {
  let value = null
  try {
    value = await health.execute({}, { callId: 'test', signal: new AbortController().signal })
  } catch (error) {
    value = { executeError: error?.message ?? String(error) }
  }
  const routes = value?.routes
  check('rust_health reports route state', Boolean(routes), JSON.stringify(routes ?? null))
  check('reported mount count matches reality', routes?.mounted?.length === EXPECTED_PATHS.length, 'reported=' + (routes?.mounted?.length ?? -1))
  check('reported attempts > 1 (retries were used)', (routes?.attempts ?? 0) > 1, 'attempts=' + (routes?.attempts ?? -1))
  const text = health.output?.render ? health.output.render({}, value) : null
  const rendered = typeof text === 'string' ? text : text?.content?.[0]?.text ?? JSON.stringify(text)
  check('rendered health mentions the http routes', /http routes: 7 mounted/.test(String(rendered)), String(rendered).split('\n').slice(0, 2).join(' | '))
}

for (const dispose of effects.reverse()) {
  try {
    dispose?.()
  } catch {
    // ignore
  }
}
await sleep(50)
check('disposing the plugin unmounts the routes', handlers.size === 0, 'handlers=' + handlers.size)

const exhaustedLogged = logs.some((entry) => String(entry.args?.[0] ?? '').includes('route.retry'))
check('retries are logged (route.retry)', exhaustedLogged)

console.log('')
if (failures.length) {
  console.log('---- FAILURES (' + failures.length + ') ----')
  for (const failure of failures) console.log('  ' + failure)
  process.exit(1)
}
console.log('---- ALL PASS ----')
process.exit(0)
