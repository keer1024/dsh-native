// Live check of the plugin's HTTP routes on the current host port.
// The desktop GUI picks a fresh port on every launch, so pass it explicitly:
//   node tools/live_route_check.mjs 63120
const port = process.argv[2] ?? process.env.DSH_WEB_PORT ?? process.env.DSH_WEB_URL?.match(/:(\d+)/)?.[1] ?? '63120'
const base = `http://127.0.0.1:${port}`
const get = async (path) => {
  const res = await fetch(base + path, { cache: 'no-store' })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const sessions = await get('/api/dsh-rust-exec/sessions')
console.log('sessions:', sessions.status, 'n=' + (sessions.body?.sessions?.length ?? 0))
const list = sessions.body?.sessions ?? []
const target = list.slice().sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]
if (!target) {
  console.log('no session logs found')
  process.exit(0)
}
console.log('target:', target.id, Math.round((target.size ?? 0) / 1024) + ' KB')

const open = await get('/api/dsh-rust-exec/session?id=' + encodeURIComponent(target.id) + '&limit=3')
console.log('session:', open.status, open.body?.schema, 'mode=' + open.body?.timings?.mode, 'total=' + open.body?.timings?.totalMs + 'ms', 'partial=' + open.body?.partial, 'total_messages=' + open.body?.total)
const seqs = (open.body?.page ?? []).map((row) => row.seq)
console.log('seqs:', seqs.join(','))

const started = Date.now()
const body = await get('/api/dsh-rust-exec/session/body?id=' + encodeURIComponent(target.id) + '&seqs=' + seqs.slice(0, 3).join(','))
console.log('body:', body.status, body.body?.schema, 'found=' + body.body?.found + '/' + body.body?.requested, 'timings=' + JSON.stringify(body.body?.timings), 'wall=' + (Date.now() - started) + 'ms')
for (const item of body.body?.items ?? []) {
  console.log('  #' + item.seq, item.kind, 'chars=' + item.chars, 'blocks=' + (item.blocks ?? []).map((block) => block.type).join('+'))
}

const bad = await get('/api/dsh-rust-exec/session/body?id=' + encodeURIComponent(target.id) + '&seqs=')
console.log('body without seqs:', bad.status, JSON.stringify(bad.body).slice(0, 120))
