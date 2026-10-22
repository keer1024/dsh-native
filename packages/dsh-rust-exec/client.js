// Registration id must equal package.json "name" (dsh-native). The host keys its
// client-graph rows by package name and re-serves a bundle whose registration id
// does not match the row id; that second execution throws "duplicate factory
// registration" and fails the whole web boot (crash log: "dsh-native: import
// failed"). Keep this in sync with package.json — tools/check_client_identity.mjs
// enforces it.
window.__ModuleLoader__.load({
  id: 'dsh-native',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const API = '/api/dsh-rust-exec'
    const POLL_MS = 1000
    const SPARK = 120

    const DICT = {
      en: {
        title: 'dsh-native worker',
        subtitle: 'Warm PowerShell lanes, persistent code index, resource governance',
        refresh: 'Refresh',
        running: 'running',
        stopped: 'not running',
        cpu: 'CPU (one core)',
        rss: 'Working set',
        queue: 'Queue depth',
        inflight: 'In flight',
        index: 'Index',
        latency: 'Last sample',
        workers: 'Workers',
        calls: 'calls',
        rejected: 'rejected',
        spawned: 'spawned',
        retired: 'retired',
        settings: 'Concurrency and limits',
        apply: 'Apply',
        applying: 'Applying…',
        applied: 'Applied',
        failed: 'Failed',
        maxWorkers: 'Workers',
        maxInFlightPerSession: 'In flight per session',
        idleReapMs: 'Idle reap (ms)',
        rssSoftLimitMb: 'RSS soft limit (MB)',
        cpuSoftLimitPct: 'CPU soft limit (%)',
        unavailable: 'Metrics endpoint unavailable',
        noSession: 'No session activity yet',
      },
      zh: {
        title: 'dsh-native',
        subtitle: '常驻 PowerShell lane、常驻代码索引、资源治理',
        refresh: '刷新',
        running: '运行中',
        stopped: '未运行',
        cpu: 'CPU（单核）',
        rss: '工作集内存',
        queue: '队列深度',
        inflight: '运行中请求',
        index: '索引',
        latency: '最近采样',
        workers: 'Worker 列表',
        calls: '调用',
        rejected: '拒绝',
        spawned: '新建',
        retired: '退休',
        settings: '并发与限额',
        apply: '应用',
        applying: '应用中…',
        applied: '已应用',
        failed: '失败',
        maxWorkers: 'Worker 数',
        maxInFlightPerSession: '每会话运行中',
        idleReapMs: '空闲回收 (ms)',
        rssSoftLimitMb: 'RSS 软限 (MB)',
        cpuSoftLimitPct: 'CPU 软限 (%)',
        unavailable: '指标接口不可用',
        noSession: '暂无会话活动',
      },
    }

    const COLORS = {
      accent: '#2f81f7',
      ok: '#3fb950',
      warn: '#d29922',
      bad: '#f85149',
      muted: 'currentColor',
    }

    function fmtBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function fmtDuration(ms) {
      const n = Math.max(0, Number(ms) || 0)
      const s = Math.round(n / 1000)
      if (s < 60) return s + 's'
      const m = Math.floor(s / 60)
      if (m < 60) return m + 'm ' + (s % 60) + 's'
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
    }

    function ago(ms) {
      if (!ms) return '—'
      return fmtDuration(Date.now() - ms) + ' ago'
    }

    function Sparkline({ points, color, label, value }) {
      const w = 100
      const hgt = 30
      const values = points.length ? points : [0]
      const max = Math.max(1, ...values)
      const step = values.length > 1 ? w / (values.length - 1) : w
      const path = values
        .map((v, i) => (i === 0 ? 'M' : 'L') + (i * step).toFixed(2) + ' ' + (hgt - (v / max) * (hgt - 2) - 1).toFixed(2))
        .join(' ')
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, opacity: 0.72 } },
          h('span', null, label),
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, value),
        ),
        h('svg', { viewBox: '0 0 ' + w + ' ' + hgt, preserveAspectRatio: 'none', style: { width: '100%', height: hgt, display: 'block', overflow: 'visible' } },
          h('path', { d: path, fill: 'none', stroke: color, strokeWidth: 1.4, vectorEffect: 'non-scaling-stroke', strokeLinejoin: 'round' }),
        ),
      )
    }

    function StatCard({ label, value, hint, tone }) {
      return h('div', {
        style: {
          border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
          borderRadius: 8, padding: '8px 10px', minWidth: 0,
          display: 'flex', flexDirection: 'column', gap: 2,
        },
      },
        h('span', { style: { fontSize: 11, opacity: 0.66 } }, label),
        h('span', { style: { fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: tone } }, value),
        hint ? h('span', { style: { fontSize: 10.5, opacity: 0.55 } }, hint) : null,
      )
    }

    function NumberField({ label, value, step, min, max, onChange }) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11.5, minWidth: 110, flex: '1 1 110px' } },
        h('span', { style: { opacity: 0.7 } }, label),
        h('input', {
          type: 'number', value, step: step, min: min, max: max,
          onChange: (event) => onChange(Number(event.target.value)),
          style: {
            background: 'transparent', color: 'inherit', fontSize: 13, padding: '4px 6px',
            border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', borderRadius: 6,
          },
        }),
      )
    }

    function useMetrics(intervalMs, nonce = 0) {
      const [state, setState] = useState({ data: null, error: null })
      useEffect(() => {
        let disposed = false
        let timer = null
        const tick = async () => {
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          const abortTimer = controller ? setTimeout(() => controller.abort(), 8000) : null
          let retryMs = intervalMs
          try {
            const res = await fetch(API + '/metrics', {
              headers: { accept: 'application/json' },
              signal: controller ? controller.signal : undefined,
            })
            if (!res.ok) {
              const failure = new Error('HTTP ' + res.status)
              failure.status = res.status
              throw failure
            }
            const data = await res.json()
            if (!disposed) setState({ data, error: null })
          } catch (error) {
            // A 404 means the route was never mounted in this host boot: that is a
            // plugin/host seam problem, not a transient one. Say so, and stop
            // hammering the server every second while the user fixes it.
            if (error && error.status === 404) {
              retryMs = 30000
              if (!disposed) {
                setState((prev) => ({
                  data: prev.data,
                  error: pick(
                    'HTTP 404 · 指标路由未注册（重载插件后刷新页面）；30 秒后重试',
                    'HTTP 404 · metrics route not mounted (reload the plugin, then refresh); retrying in 30 s',
                  ),
                }))
              }
            } else if (!disposed) {
              setState((prev) => ({ data: prev.data, error: error.message || String(error) }))
            }
          } finally {
            if (abortTimer) clearTimeout(abortTimer)
            if (!disposed) timer = setTimeout(tick, retryMs)
          }
        }
        tick()
        return () => { disposed = true; if (timer) clearTimeout(timer) }
      }, [intervalMs, nonce])
      return state
    }

    function RustExecPanel() {
      const [nonce, setNonce] = useState(0)
      const { data, error } = useMetrics(POLL_MS, nonce)
      const [draft, setDraft] = useState(null)
      const [applyState, setApplyState] = useState({ status: 'idle', message: '' })
      const [monitorOpen, setMonitorOpen] = useState(false)
      const config = data?.config ?? null
      const pool = data?.pool ?? data?.last?.pool ?? null
      const fast = useMemo(() => {
        const list = data?.history?.fast
        return Array.isArray(list) ? list.slice(-SPARK) : []
      }, [data])
      const last = fast.length ? fast[fast.length - 1] : null

      const effective = draft ?? (config ? {
        maxWorkers: config.maxWorkers,
        maxInFlightPerSession: config.maxInFlightPerSession,
        idleReapMs: config.idleReapMs,
        rssSoftLimitMb: config.rssSoftLimitMb,
        cpuSoftLimitPct: config.cpuSoftLimitPct,
      } : null)

      const apply = async () => {
        if (!effective) return
        setApplyState({ status: 'applying', message: '' })
        try {
          const res = await fetch(API + '/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(effective),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status)
          setApplyState({ status: 'applied', message: JSON.stringify(body.applied ?? {}) })
          setDraft(null)
        } catch (err) {
          setApplyState({ status: 'failed', message: err.message || String(err) })
        }
      }

      const series = (pick) => fast.map(pick)
      const running = Boolean(data?.running)
      const statusColor = !running ? COLORS.bad : (pool?.softLimits?.paused ? COLORS.warn : COLORS.ok)
      const statusText = !running ? 'stopped' : (pool?.softLimits?.paused ? 'index paused' : 'running')

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px 18px', minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: () => setNonce((value) => value + 1), style: VIEW_BUTTON_STYLE },
            pick('刷新', 'Refresh')),
          h('button', {
            type: 'button', 'data-dsh-rust-monitor-open': '1',
            onClick: () => setMonitorOpen(true), style: VIEW_BUTTON_STYLE,
          }, pick('监控器', 'Monitor')),
          h('span', { style: { fontSize: 11, opacity: 0.55 } },
            pick('Grafana 风格性能面板：进程生命周期 min/max · 最近 2 分钟曲线', 'Grafana-style panel: lifetime min/max · last 2 minutes')),
        ),
        monitorOpen ? h(MonitorDialog, { onClose: () => setMonitorOpen(false) }) : null,
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },

          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { width: 8, height: 8, borderRadius: 99, background: statusColor, display: 'inline-block' } }),
            h('strong', { style: { fontSize: 14 } }, 'dsh-native worker'),
            h('span', { style: { fontSize: 11.5, opacity: 0.66 } }, statusText),
          ),
          h('span', { style: { fontSize: 11.5, opacity: 0.6, fontVariantNumeric: 'tabular-nums' } },
            data ? ('samples ' + data.samples + ' · ' + (data.intervalMs || POLL_MS) + ' ms') : ''),
        ),

        error ? h('div', { style: { fontSize: 12, color: COLORS.bad } }, 'metrics unavailable: ' + error) : null,
        !data && !error ? h('div', { style: { fontSize: 12, opacity: 0.6 } }, 'loading…') : null,

        data ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 } },
          h(StatCard, { label: 'CPU (one core)', value: last ? last.cpuPctOneCore + '%' : '—', hint: last ? 'cpuMs ' + last.cpuMsTotal : '' }),
          h(StatCard, { label: 'Working set', value: last ? fmtBytes(last.workingSetBytes) : '—', hint: last ? 'private ' + fmtBytes(last.privateBytes) : '' }),
          h(StatCard, { label: 'Queue depth', value: String(pool?.queueDepth ?? last?.queued ?? 0), hint: 'peak ' + (last?.peakQueued ?? 0) }),
          h(StatCard, { label: 'Running', value: String(last?.inflight ?? 0), hint: (pool?.workers ?? 0) + ' worker(s) · ' + (pool?.lanesPerWorker ?? 0) + ' lanes' }),
          h(StatCard, { label: 'Index', value: String(last?.indexFiles ?? 0), hint: (last?.indexSymbols ?? 0) + ' symbols · ' + fmtDuration(last?.indexAgeMs ?? 0) + ' old' }),
          h(StatCard, { label: 'Calls', value: String(pool?.stats?.calls ?? 0), hint: 'rejected ' + (pool?.stats?.rejected ?? 0) + ' · spawned ' + (pool?.stats?.spawned ?? 0) }),
        ) : null,

        

        pool ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, 'Workers'),
          h('div', { style: { fontSize: 11.5, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 } },
            (pool.workersDetail ?? []).map((w) => h('div', {
              key: w.id,
              style: { border: '1px solid color-mix(in srgb, currentColor 12%, transparent)', borderRadius: 6, padding: '5px 8px', display: 'flex', gap: 8, justifyContent: 'space-between' },
            },
              h('span', null, '#' + w.id + ' pid ' + w.pid),
              h('span', { style: { opacity: 0.7 } }, (w.inflight || 0) + '/' + (w.lanes || 0) + (w.retiring ? ' · retiring' : '')),
            )),
            (pool.workersDetail ?? []).length === 0 ? h('div', { style: { opacity: 0.6 } }, 'none (lazy spawn)') : null,
          ),
          (pool.sessions ?? []).length
            ? h('div', { style: { fontSize: 11.5, opacity: 0.72 } }, (pool.sessions ?? []).map((s) => (s.sessionId || s.id) + ':' + (s.inflight ?? 0)).join('  '))
            : h('div', { style: { fontSize: 11.5, opacity: 0.55 } }, 'no session activity yet'),
        ) : null,

        effective ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)', paddingTop: 12 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, 'Concurrency and limits'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' } },
            h(NumberField, { label: 'Workers', value: effective.maxWorkers, min: 1, max: 8, step: 1, onChange: (v) => setDraft({ ...effective, maxWorkers: v }) }),
            h(NumberField, { label: 'In flight per session', value: effective.maxInFlightPerSession, min: 1, max: 64, step: 1, onChange: (v) => setDraft({ ...effective, maxInFlightPerSession: v }) }),
            h(NumberField, { label: 'Idle reap (ms)', value: effective.idleReapMs, min: 10000, max: 3600000, step: 10000, onChange: (v) => setDraft({ ...effective, idleReapMs: v }) }),
            h(NumberField, { label: 'RSS soft limit (MB)', value: effective.rssSoftLimitMb, min: 64, max: 8192, step: 64, onChange: (v) => setDraft({ ...effective, rssSoftLimitMb: v }) }),
            h(NumberField, { label: 'CPU soft limit (%)', value: effective.cpuSoftLimitPct, min: 10, max: 100, step: 5, onChange: (v) => setDraft({ ...effective, cpuSoftLimitPct: v }) }),
            h('button', {
              type: 'button',
              onClick: apply,
              disabled: applyState.status === 'applying' || !draft,
              style: {
                fontSize: 12.5, padding: '6px 14px', borderRadius: 6, cursor: draft ? 'pointer' : 'default',
                border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
                background: draft ? COLORS.accent : 'transparent',
                color: draft ? '#fff' : 'inherit',
                opacity: applyState.status === 'applying' ? 0.6 : 1,
              },
            }, applyState.status === 'applying' ? 'Applying…' : 'Apply'),
          ),
          applyState.status !== 'idle' ? h('div', { style: { fontSize: 11, opacity: applyState.status === 'failed' ? 1 : 0.66, color: applyState.status === 'failed' ? COLORS.bad : undefined } },
            applyState.status === 'failed' ? 'failed: ' + applyState.message : 'applied ' + applyState.message) : null,
        ) : null,

        h(SessionProjectionCard),
      )
    }

    /**
     * Read-only session projection browser. DSH still owns the session truth
     * source; this card just renders the Rust worker's paged projection of a
     * `session.v*.jsonl.zstd` log and the per-stage timings the worker reported.
     */
    function SessionProjectionCard() {
      const PAGE_SIZE = 20
      const [open, setOpen] = useState(false)
      const [sessions, setSessions] = useState(null)
      const [listError, setListError] = useState('')
      const [selected, setSelected] = useState('')
      const [acc, setAcc] = useState(null)
      const [projError, setProjError] = useState('')
      const [busy, setBusy] = useState(false)

      const loadSession = async (id, cursor, reset) => {
        setBusy(true)
        setProjError('')
        try {
          const url = API + '/session?id=' + encodeURIComponent(id) + '&limit=' + PAGE_SIZE + (cursor ? '&cursor=' + cursor : '')
          const res = await fetch(url, { cache: 'no-store' })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status)
          setAcc((prev) => ({
            id,
            messages: ((reset || !prev || prev.id !== id ? [] : prev.messages)).concat(Array.isArray(body.page) ? body.page : []),
            timings: body.timings || {},
            counts: body.counts || {},
            total: body.total || 0,
            nextCursor: body.nextCursor ?? null,
            partial: Boolean(body.partial),
            hasMore: body.hasMore !== undefined ? Boolean(body.hasMore) : (body.nextCursor ?? null) != null,
            size: body.size || 0,
          }))
        } catch (err) {
          setProjError(err.message || String(err))
        } finally {
          setBusy(false)
        }
      }

      const loadList = async () => {
        setListError('')
        try {
          const res = await fetch(API + '/sessions', { cache: 'no-store' })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status)
          const list = Array.isArray(body.sessions) ? body.sessions : []
          setSessions(list)
          if (list.length) {
            setSelected(list[0].id)
            await loadSession(list[0].id, 0, true)
          }
        } catch (err) {
          setListError(err.message || String(err))
        }
      }

      useEffect(() => {
        if (open && !sessions) loadList()
      }, [open, sessions])

      const timings = acc?.timings || {}
      const timingLine = acc
        ? ['mode ' + (timings.mode || '?'),
          'total ' + Math.round(timings.totalMs || 0) + ' ms',
          timings.decodeMs != null ? 'decode ' + Math.round(timings.decodeMs) + ' ms' : null,
          timings.parseMs != null ? 'json ' + Math.round(timings.parseMs) + ' ms' : null,
          timings.foldMs != null ? 'fold ' + Math.round(timings.foldMs) + ' ms' : null]
          .filter(Boolean).join(' · ')
        : ''

      const muted = { fontSize: 11.5, opacity: 0.66 }

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)', paddingTop: 12 },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            h('span', { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, 'Session projection'),
            h('span', muted, 'read-only · truth source stays in DSH'),
          ),
          h('button', {
            type: 'button',
            onClick: () => setOpen((v) => !v),
            style: {
              fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
              background: 'transparent', color: 'inherit',
            },
          }, open ? 'Hide' : 'Browse sessions'),
        ),

        open ? (listError
          ? h('div', { style: { fontSize: 12, color: COLORS.bad } }, 'session list unavailable: ' + listError)
          : !sessions
            ? h('div', muted, 'loading…')
            : sessions.length === 0
              ? h('div', muted, 'no session logs found under the sessions root')
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h('select', {
                  value: selected,
                  onChange: (event) => {
                    const id = event.target.value
                    setSelected(id)
                    setAcc(null)
                    loadSession(id, 0, true)
                  },
                  style: { fontSize: 12, padding: '5px 8px', borderRadius: 6, maxWidth: '100%' },
                }, sessions.map((entry) => h('option', { key: entry.id, value: entry.id },
                  entry.id.slice(0, 12) + ' · ' + (entry.size / 1048576).toFixed(2) + ' MB · ' + ago(entry.mtimeMs)))),
                acc ? h('div', muted, timingLine + ' · ' + (acc.counts.messages || acc.total) + ' messages' + (acc.counts.toolCalls ? ' · ' + acc.counts.toolCalls + ' tool calls' : '')) : null,
                projError ? h('div', { style: { fontSize: 12, color: COLORS.bad } }, 'projection failed: ' + projError) : null,
                acc ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 320, overflowY: 'auto' } },
                  acc.messages.map((message) => h('div', {
                    key: message.seq,
                    style: { display: 'flex', gap: 8, fontSize: 11.5, alignItems: 'baseline', fontVariantNumeric: 'tabular-nums' },
                  },
                    h('span', { style: { opacity: 0.5, minWidth: 34 } }, '#' + message.seq),
                    h('span', { style: { minWidth: 62, opacity: 0.85 } }, message.kind || '?'),
                    h('span', { style: { minWidth: 74, opacity: 0.6 } }, (message.name || '') || ('t' + message.turn + '/' + message.step)),
                    h('span', { style: { opacity: 0.45, minWidth: 52 } }, (message.chars || 0) + 'ch'),
                    h('span', { style: { opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, message.preview || ''),
                  )),
                ) : busy ? h('div', muted, 'projecting…') : null,
                acc && acc.nextCursor != null
                  ? h('button', {
                    type: 'button',
                    disabled: busy,
                    onClick: () => loadSession(acc.id, acc.nextCursor, false),
                    style: {
                      alignSelf: 'flex-start', fontSize: 12, padding: '5px 12px', borderRadius: 6,
                      cursor: busy ? 'default' : 'pointer',
                      border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
                      background: 'transparent', color: 'inherit', opacity: busy ? 0.6 : 1,
                    },
                  }, busy ? 'Loading…' : 'Load more (' + acc.messages.length + '/' + acc.total + ')')
                  : null,
              ))
          : null,
      )
    }

    /** Tiny bilingual picker for the View: the client locale API is optional here. */
    function pick(zh, en) {
      const lang = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
      return lang.startsWith('zh') ? zh : en
    }

    const VIEW_KIND_COLORS = {
      user: COLORS.accent,
      assistant: COLORS.ok,
      tool: COLORS.warn,
      system: 'color-mix(in srgb, currentColor 55%, transparent)',
      reasoning: 'color-mix(in srgb, currentColor 42%, transparent)',
    }
    const VIEW_ROW_STYLE = {
      display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 4px', borderRadius: 4,
      fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid color-mix(in srgb, currentColor 7%, transparent)',
    }
    const VIEW_BUTTON_STYLE = {
      fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', color: 'inherit',
      border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', background: 'transparent',
    }

    /**
     * Real conversation-view takeover, additive and non-destructive.
     *
     * Registered on `conversation.view` — a list slot whose replaceRisk is "none" — so it
     * lives BESIDE the shipped `chat` and `trajectory` views instead of replacing them.
     * Every row is fetched from this plugin's own Rust projection service
     * (`GET /api/dsh-rust-exec/session?id=<sessionId>`), so the rendering decisions for this
     * view belong to the plugin and its Rust worker rather than to the host's chat renderer.
     * It is read-only: prompts are still sent from the shipped chat view.
     */
    /**
     * Minimal markdown: fenced code blocks, bullet lines, `inline code` and **bold**.
     *
     * Deliberately tiny — the point of this view is that a Rust service owns the projection and
     * the plugin owns the rendering, not that we ship a markdown implementation.
     */
    function renderInline(text) {
      const nodes = []
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
      let last = 0
      let match = pattern.exec(text)
      while (match !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key: 'b' + match.index }, token.slice(2, -2)))
        } else {
          nodes.push(h('code', {
            key: 'c' + match.index,
            style: { fontSize: 11, padding: '0 3px', borderRadius: 3, background: 'color-mix(in srgb, currentColor 12%, transparent)' },
          }, token.slice(1, -1)))
        }
        last = match.index + token.length
        match = pattern.exec(text)
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    const CODE_BLOCK_STYLE = {
      margin: '4px 0', padding: 8, borderRadius: 6, overflow: 'auto', maxHeight: 260,
      background: 'color-mix(in srgb, currentColor 9%, transparent)', fontSize: 11, lineHeight: 1.5,
    }

    function renderMarkdown(text) {
      const lines = String(text ?? '').split('\n')
      const nodes = []
      let code = null
      let buffer = []
      const flush = () => {
        if (buffer.length === 0) return
        const body = buffer.map((line, index) => h('div', { key: index }, renderInline(line)))
        nodes.push(h('div', { key: 'p' + nodes.length, style: { margin: '2px 0' } }, body))
        buffer = []
      }
      for (const line of lines) {
        if (line.startsWith('```')) {
          if (code === null) {
            flush()
            code = []
          } else {
            nodes.push(h('pre', { key: 'pre' + nodes.length, style: CODE_BLOCK_STYLE }, code.join('\n')))
            code = null
          }
          continue
        }
        if (code !== null) {
          code.push(line)
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) buffer.push('• ' + line.replace(/^\s*[-*]\s+/, ''))
        else buffer.push(line)
      }
      if (code !== null) nodes.push(h('pre', { key: 'pre-open', style: CODE_BLOCK_STYLE }, code.join('\n')))
      flush()
      return nodes
    }

    /** One body block: prose is rendered, tool-call arguments start collapsed. */
    function BodyBlock({ block }) {
      const collapsible = block.type === 'tool-call'
      const [open, setOpen] = useState(!collapsible)
      return h('div', { style: { marginBottom: 10 } },
        h('div', {
          style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, opacity: 0.65, cursor: collapsible ? 'pointer' : 'default' },
          onClick: collapsible ? () => setOpen((value) => !value) : undefined,
        },
          h('span', null, block.type),
          h('span', null, (block.chars || 0) + ' ch'),
          block.truncated ? h('span', { style: { color: COLORS.warn } }, 'truncated') : null,
          collapsible ? h('span', null, open ? '▾' : '▸') : null,
        ),
        open
          ? (collapsible
            ? h('pre', { style: CODE_BLOCK_STYLE }, block.text || '')
            : h('div', { style: { fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, renderMarkdown(block.text)))
          : null,
      )
    }

    const VIEW_ROW_HEIGHT = 46
    const VIEW_OVERSCAN = 8

    const DETAIL_WIDTH = 420
    const NARROW_BREAKPOINT = 720

    const KIND_LABELS = {
      user: ['用户', 'user'],
      assistant: ['助手', 'assistant'],
      tool: ['工具', 'tool'],
      system: ['系统', 'system'],
      reasoning: ['推理', 'reasoning'],
    }

    function kindLabel(kind) {
      const entry = KIND_LABELS[String(kind || '').toLowerCase()]
      return entry ? pick(entry[0], entry[1]) : String(kind || '?')
    }

    // Stable option order for the kind dropdown: the four kinds DSH emits most often first, then
    // any kind a future DSH version adds (alphabetical), so the order never drifts with load order.
    const KIND_ORDER = ['system', 'user', 'assistant', 'tool']

    function kindRank(kind) {
      const at = KIND_ORDER.indexOf(String(kind || '').toLowerCase())
      return at < 0 ? KIND_ORDER.length : at
    }

    /** Case-insensitive subsequence match: "tst" finds "test". An empty query matches all. */
    function fuzzyMatch(needle, haystack) {
      if (!needle) return true
      const hay = String(haystack || '').toLowerCase()
      let at = 0
      for (let index = 0; index < hay.length && at < needle.length; index += 1) {
        if (hay[index] === needle[at]) at += 1
      }
      return at === needle.length
    }

    /** Highlight contiguous occurrences of the query; subsequence-only hits stay plain. */
    function Highlight({ text, query }) {
      const value = String(text == null ? '' : text)
      const needle = String(query || '').trim().toLowerCase()
      if (!needle) return value
      const lower = value.toLowerCase()
      const nodes = []
      let at = 0
      let found = lower.indexOf(needle, at)
      while (found >= 0) {
        if (found > at) nodes.push(value.slice(at, found))
        nodes.push(h('mark', {
          key: 'm' + found,
          style: { background: 'color-mix(in srgb, #d29922 45%, transparent)', color: 'inherit', borderRadius: 2, padding: '0 1px' },
        }, value.slice(found, found + needle.length)))
        at = found + needle.length
        found = lower.indexOf(needle, at)
      }
      if (at < value.length) nodes.push(value.slice(at))
      return nodes
    }

    function RustConversationView(props) {
      const sessionId = (props && (props.sessionId || (props.session && props.session.id))) || ''
      const [rows, setRows] = useState([])
      const [meta, setMeta] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [scrollTop, setScrollTop] = useState(0)
      const [viewportHeight, setViewportHeight] = useState(420)
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState(null)
      const [query, setQuery] = useState('')
      const [kindFilter, setKindFilter] = useState('all')
      const [toolFilter, setToolFilter] = useState('')
      const [wide, setWide] = useState(true)
      const [monitorOpen, setMonitorOpen] = useState(false)
      const [boxHeight, setBoxHeight] = useState(0)
      const cursor = useRef(0)
      const alive = useRef(true)
      const listRef = useRef(null)
      const rootRef = useRef(null)

      async function load(append, quiet) {
        if (!sessionId) return
        if (!quiet) setBusy(true)
        try {
          const offset = append ? cursor.current : 0
          const url = API + '/session?id=' + encodeURIComponent(sessionId) + '&limit=200'
            + (offset > 0 ? '&cursor=' + offset : '')
          const res = await fetch(url, { cache: 'no-store' })
          const body = await res.json().catch(() => null)
          if (!alive.current) return
          if (!res.ok || !body || body.error) throw new Error((body && body.error) || ('HTTP ' + res.status))
          const page = Array.isArray(body.page) ? body.page : []
          setRows((prev) => {
            const base = append ? prev : []
            const seen = new Set(base.map((row) => row.seq))
            return base.concat(page.filter((row) => !seen.has(row.seq)))
          })
          cursor.current = offset + page.length
          setMeta({ total: body.total || 0, counts: body.counts || null, timings: body.timings || null, nextCursor: body.nextCursor, partial: Boolean(body.partial), hasMore: body.hasMore })
          setError(null)
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        } finally {
          if (alive.current && !quiet) setBusy(false)
        }
      }

      async function openRow(row) {
        setSelected(row)
        setDetail({ loading: true, items: [] })
        try {
          const url = API + '/session/body?id=' + encodeURIComponent(sessionId) + '&seqs=' + String(row.seq)
          const res = await fetch(url, { cache: 'no-store' })
          const body = await res.json().catch(() => null)
          if (!alive.current) return
          if (!res.ok || !body || body.error) throw new Error((body && body.error) || ('HTTP ' + res.status))
          const item = Array.isArray(body.items) ? body.items[0] : null
          setDetail({ loading: false, item: item || null, timings: body.timings || null })
        } catch (err) {
          if (alive.current) setDetail({ loading: false, item: null, error: err && err.message ? err.message : String(err) })
        }
      }

      useEffect(() => {
        alive.current = true
        cursor.current = 0
        if (sessionId) load(false, false)
        return () => { alive.current = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])

      useEffect(() => {
        if (!sessionId) return undefined
        const timer = setInterval(() => { load(true, true) }, 3000)
        return () => clearInterval(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])

      useEffect(() => {
        const element = listRef.current
        if (!element) return undefined
        const measure = () => setViewportHeight(element.clientHeight || 420)
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(element)
          return () => observer.disconnect()
        }
        return undefined
      }, [])

      // DSH renders plugin conversation views inside a shared resident scrollport
      // (`[data-conversation-scroll]`) whose height is auto, so `height: 100%` lets the whole tab
      // scroll and the header disappears. Measure that scrollport's visible box, reserve the
      // composer band that overlays it, and pin the view to the result: only the message list and
      // the detail pane stay scrollable, while the header and the detail column stay put.
      useEffect(() => {
        const element = rootRef.current
        if (!element || typeof window === 'undefined') return undefined
        const scroller = typeof element.closest === 'function' ? element.closest('[data-conversation-scroll]') : null
        const seat = scroller && typeof scroller.querySelector === 'function' ? scroller.querySelector('[data-composer-seat]') : null
        const measure = () => {
          const rect = element.getBoundingClientRect()
          let node = scroller || element.parentElement
          let visible = null
          let guard = 0
          while (node && node !== document.documentElement && guard < 12) {
            guard += 1
            const style = window.getComputedStyle(node)
            const clipping = node === scroller
              || style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'hidden'
            if (clipping && node.clientHeight > 0) {
              const padBottom = parseFloat(style.paddingBottom) || 0
              // Layout offset, independent of the current scroll position: `rect.top - box.top`
              // already includes -scrollTop for a scrolled scrollport, so add it back.
              const scrolled = node === scroller ? (scroller.scrollTop || 0) : 0
              const offset = Math.max(0, rect.top - node.getBoundingClientRect().top + scrolled)
              visible = node.clientHeight - padBottom - offset
              break
            }
            node = node.parentElement
          }
          // The composer floats over the scrollport in this layout; keep its band clear so the
          // last rows remain reachable instead of hiding under the input card.
          const seatEl = seat || (typeof document.querySelector === 'function' ? document.querySelector('[data-composer-seat]') : null)
          let composerInset = 0
          if (seatEl && typeof seatEl.getBoundingClientRect === 'function') {
            const seatRect = seatEl.getBoundingClientRect()
            const baseRect = (scroller || element).getBoundingClientRect()
            composerInset = seatRect.height > 0 ? seatRect.height : Math.max(0, baseRect.bottom - seatRect.top)
          } else if (typeof window.getComputedStyle === 'function') {
            const declared = parseFloat(window.getComputedStyle(element).getPropertyValue('--dsh-composer-height'))
            if (Number.isFinite(declared)) composerInset = declared
          }
          composerInset = Math.min(280, Math.max(0, Math.round(composerInset)))
          const fallback = Math.floor((window.innerHeight || 800) - Math.max(0, rect.top) - 16 - composerInset)
          let declaredHeight = NaN
          if (visible == null && typeof window.getComputedStyle === 'function') {
            declaredHeight = parseFloat(window.getComputedStyle(element).getPropertyValue('--dsh-conversation-viewport-height'))
          }
          const base = visible != null && visible > 240
            ? visible - composerInset
            : Number.isFinite(declaredHeight) && declaredHeight > 240
              ? declaredHeight - composerInset
              : fallback
          setBoxHeight(Math.max(240, Math.floor(base) - 1))
        }
        let frame = 0
        const raf = typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame.bind(window)
          : (callback) => setTimeout(callback, 16)
        const cancel = typeof window.cancelAnimationFrame === 'function'
          ? window.cancelAnimationFrame.bind(window)
          : clearTimeout
        const schedule = () => {
          if (frame) return
          frame = raf(() => { frame = 0; measure() })
        }
        schedule()
        window.addEventListener('resize', schedule)
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
        if (observer) {
          if (scroller) observer.observe(scroller)
          if (seat) observer.observe(seat)
          let node = element.parentElement
          let guard = 0
          while (node && node !== document.documentElement && guard < 6) {
            observer.observe(node)
            node = node.parentElement
            guard += 1
          }
        }
        const timer = setTimeout(schedule, 250)
        return () => {
          window.removeEventListener('resize', schedule)
          if (observer) observer.disconnect()
          clearTimeout(timer)
          if (frame) window.cancelAnimationFrame(frame)
        }
      }, [])

      const counts = (meta && meta.counts) || {}
      const timings = (meta && meta.timings) || {}
      const totalMs = typeof timings.totalMs === 'number' ? Math.round(timings.totalMs * 10) / 10 : null
      const sortedRows = rows
      const kinds = useMemo(() => [...new Set(sortedRows.map((row) => String(row.kind || '')))].filter(Boolean)
        .sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b)), [sortedRows])
      const toolNames = useMemo(() => [...new Set(sortedRows
        .filter((row) => String(row.kind || '').toLowerCase().includes('tool'))
        .map((row) => row.name)
        .filter(Boolean))].slice(0, 20), [sortedRows])
      const needle = query.trim().toLowerCase()
      const filtered = useMemo(() => sortedRows.filter((row) => {
        if (kindFilter !== 'all' && String(row.kind || '') !== kindFilter) return false
        if (toolFilter && row.name !== toolFilter) return false
        if (!needle) return true
        return fuzzyMatch(needle, [row.preview, row.name, row.kind, '#' + row.seq].join(' '))
      }), [sortedRows, kindFilter, toolFilter, needle])
      const filterKey = kindFilter + '|' + toolFilter + '|' + needle

      // Default the detail pane to the first row of the current filter, and keep the
      // selection inside the filter when it changes. Read-only: nothing here mutates DSH.
      useEffect(() => {
        if (listRef.current) listRef.current.scrollTop = 0
        setScrollTop(0)
        if (filtered.length === 0) {
          setSelected(null)
          setDetail(null)
          return
        }
        if (selected && filtered.some((row) => row.seq === selected.seq)) return
        void openRow(filtered[0])
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [filterKey, rows.length])

      // Windowed rendering: only the rows inside the viewport (plus overscan) reach the DOM, so a
      // 2000-message session does not create 2000 row nodes on open.
      const start = Math.max(0, Math.floor(scrollTop / VIEW_ROW_HEIGHT) - VIEW_OVERSCAN)
      const end = Math.min(filtered.length, Math.ceil((scrollTop + viewportHeight) / VIEW_ROW_HEIGHT) + VIEW_OVERSCAN)
      const visible = filtered.slice(start, end)
      return h('div', {
        ref: rootRef,
        'data-dsh-rust-view': 'conversation',
        style: { display: 'flex', flexDirection: 'column', gap: 0, padding: '10px 12px', fontSize: 12, boxSizing: 'border-box', height: boxHeight > 0 ? boxHeight + 'px' : '100%', minHeight: 0, overflow: 'hidden' },
        'data-dsh-rust-fit': boxHeight > 0 ? 'pinned' : 'auto',
      },
        h('div', {
          'data-dsh-rust-header': 'fixed',
          style: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 8, borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('strong', null, pick('R-Native 视图', 'R-Native view')),
            h('span', { style: { opacity: 0.6 } }, (counts.messages != null ? counts.messages : rows.length) + ' ' + pick('条消息', 'messages')),
            counts.toolCalls != null ? h('span', { style: { opacity: 0.6 } }, counts.toolCalls + ' ' + pick('次工具调用', 'tool calls')) : null,
            needle || kindFilter !== 'all' || toolFilter
              ? h('span', { style: { opacity: 0.75, fontVariantNumeric: 'tabular-nums' } }, filtered.length + ' / ' + rows.length)
              : null,
            timings.mode ? h('span', { style: { opacity: 0.5 } }, 'mode ' + timings.mode + (totalMs != null ? ' · ' + totalMs + ' ms' : '')) : null,
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button', 'data-dsh-rust-monitor': '1',
              onClick: () => setMonitorOpen(true), style: VIEW_BUTTON_STYLE,
            }, pick('监控器', 'Monitor')),
            h('button', { type: 'button', onClick: () => load(false, false), disabled: busy, style: VIEW_BUTTON_STYLE },
              busy ? pick('读取中…', 'Loading…') : pick('刷新', 'Refresh')),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              type: 'search',
              value: query,
              'data-dsh-rust-search': '1',
              placeholder: pick('模糊匹配：预览 / 工具名 / 类别 / 序号', 'Fuzzy filter: preview, tool, kind, seq'),
              onChange: (event) => setQuery(event.target.value),
              style: { flex: '1 1 240px', minWidth: 140, background: 'transparent', color: 'inherit', fontSize: 12, padding: '4px 8px', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', borderRadius: 6 },
            }),
            h('select', {
              value: kindFilter,
              'data-dsh-rust-kind': '1',
              'aria-label': pick('类别筛选', 'filter by kind'),
              title: pick('按类别筛选', 'filter by kind'),
              onChange: (event) => setKindFilter(event.target.value),
              style: { fontSize: 11.5, padding: '3px 6px', borderRadius: 6, maxWidth: 150, flex: '0 0 auto' },
            },
              h('option', { value: 'all' }, pick('全部类别', 'all kinds')),
              kinds.map((kind) => h('option', { key: kind, value: kind }, kindLabel(kind))),
            ),
            toolNames.length ? h('select', {
              value: toolFilter,
              'data-dsh-rust-tool': '1',
              onChange: (event) => setToolFilter(event.target.value),
              style: { fontSize: 11.5, padding: '3px 6px', borderRadius: 6, maxWidth: 170, flex: '0 0 auto' },
            },
              h('option', { value: '' }, pick('全部工具', 'all tools')),
              toolNames.map((name) => h('option', { key: name, value: name }, name)),
            ) : null,
          ),
        ),
        error ? h('div', { style: { color: COLORS.warn, flex: '0 0 auto', paddingTop: 6 } }, pick('读取投影失败: ', 'projection failed: ') + error) : null,
        h('div', { style: { display: 'flex', flexDirection: wide ? 'row' : 'column', gap: 10, flex: 1, minHeight: 0, paddingTop: 8, overflow: 'hidden' } },
          h('div', {
            ref: listRef,
            onScroll: (event) => setScrollTop(event.currentTarget.scrollTop),
            style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto', border: '1px solid color-mix(in srgb, currentColor 12%, transparent)', borderRadius: 6 },
          },
            filtered.length === 0
              ? h('div', { style: { padding: 10, opacity: 0.6 } }, rows.length === 0
                ? (busy ? pick('读取中…', 'Loading…') : pick('暂无消息', 'No messages yet'))
                : pick('没有匹配的消息', 'No message matches the filter'))
              : null,
            h('div', { style: { height: start * VIEW_ROW_HEIGHT } }),
            visible.map((row) => h('div', {
              key: String(row.turn) + ':' + String(row.seq),
              'data-dsh-rust-row': String(row.seq),
              onClick: () => openRow(row),
              style: {
                ...VIEW_ROW_STYLE,
                height: VIEW_ROW_HEIGHT - 2,
                cursor: 'pointer',
                background: selected && selected.seq === row.seq ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent',
              },
            },
              h('span', { style: { opacity: 0.45, width: 46, flexShrink: 0, fontVariantNumeric: 'tabular-nums' } }, '#' + row.seq),
              h('span', { style: { color: VIEW_KIND_COLORS[row.kind] || 'inherit', width: 74, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.kind),
              h('span', { style: { opacity: 0.6, width: 62, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.name || ('t' + row.turn + '/' + row.step)),
              h('span', { style: { opacity: 0.45, width: 50, flexShrink: 0, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, (row.chars || 0) + 'ch'),
              h('span', { style: { opacity: 0.8, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                h(Highlight, { text: row.preview || '', query })),
            )),
            h('div', { style: { height: Math.max(0, (filtered.length - end) * VIEW_ROW_HEIGHT) } }),
            meta && meta.nextCursor != null && (meta.hasMore === true || meta.nextCursor < (meta.total || 0))
              ? h('button', {
                type: 'button',
                onClick: (event) => { event.stopPropagation(); load(true, false) },
                disabled: busy,
                style: { ...VIEW_BUTTON_STYLE, margin: 8 },
              }, pick('加载更多', 'Load more') + ' (' + rows.length + '/' + (meta.total || '?') + ')')
              : null,
          ),
          h('div', {
            'data-dsh-rust-view': 'detail',
            'data-dsh-rust-detail-width': String(DETAIL_WIDTH),
            style: wide
              ? {
                flex: '0 0 ' + DETAIL_WIDTH + 'px', width: DETAIL_WIDTH, minWidth: DETAIL_WIDTH, maxWidth: DETAIL_WIDTH,
                minHeight: 0, overflow: 'auto', border: '1px solid color-mix(in srgb, currentColor 12%, transparent)', borderRadius: 6,
              }
              : {
                flex: '0 0 auto', maxHeight: '45%', minHeight: 120, overflow: 'auto',
                border: '1px solid color-mix(in srgb, currentColor 12%, transparent)', borderRadius: 6,
              },
          },
            !selected
              ? h('div', { style: { padding: 10, opacity: 0.6 } }, pick('点击左侧任意消息查看完整内容', 'Select a message to read its full body'))
              : h('div', { style: { padding: 8 } },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 } },
                  h('strong', null, '#' + selected.seq),
                  h('span', { style: { color: VIEW_KIND_COLORS[selected.kind] || 'inherit' } }, selected.kind),
                  selected.name ? h('span', { style: { opacity: 0.6 } }, selected.name) : null,
                  h('span', { style: { flex: 1 } }),
                  detail && detail.timings && typeof detail.timings.totalMs === 'number'
                    ? h('span', { style: { opacity: 0.45 } }, Math.round(detail.timings.totalMs * 10) / 10 + ' ms')
                    : null,
                ),
                detail && detail.loading ? h('div', { style: { opacity: 0.6 } }, pick('读取中…', 'Loading…')) : null,
                detail && detail.error ? h('div', { style: { color: COLORS.warn } }, 'body failed: ' + detail.error) : null,
                detail && !detail.loading && !detail.error && detail.item
                  ? (detail.item.blocks && detail.item.blocks.length > 0
                    ? detail.item.blocks.map((block, index) => h(BodyBlock, { key: index, block }))
                    : h('div', { style: { opacity: 0.6 } }, pick('这条消息没有文本内容', 'This message has no text blocks')))
                  : null,
              ),
          ),
        ),
        monitorOpen ? h(MonitorDialog, { onClose: () => setMonitorOpen(false) }) : null,
      )
    }

    // ---- Grafana-style performance monitor. One dialog, opened from the settings tab
    // and from the conversation view header; the old rail entries and overlay are gone.
    const MONITOR_COLORS = {
      bg: '#111217', panel: '#181b1f', border: 'rgba(255,255,255,0.08)',
      text: '#d8d9da', muted: '#8e9297', blue: '#3274d9', green: '#73bf69',
      orange: '#ff9830', red: '#f2495c', yellow: '#fade2a',
    }

    const fmtInt = (value) => String(Math.round(Number(value) || 0))
    const fmtPct = (value) => (Number(value) || 0).toFixed(1) + '%'

    function MonitorCard({ label, value, min, max, series, color, ratio, ratioMax }) {
      const values = Array.isArray(series) && series.length ? series : [0]
      const ceiling = Math.max(1, ...values.map((entry) => Number(entry) || 0))
      const width = 120
      const height = 26
      const step = values.length > 1 ? width / (values.length - 1) : width
      const path = values.map((entry, index) => {
        const at = index * step
        const y = height - (Math.min(Number(entry) || 0, ceiling) / ceiling) * (height - 2) - 1
        return (index === 0 ? 'M' : 'L') + at.toFixed(2) + ' ' + y.toFixed(2)
      }).join(' ')
      const pct = ratio != null && ratioMax ? Math.max(0, Math.min(1, Number(ratio) / ratioMax)) : null
      return h('div', {
        'data-dsh-rust-monitor-card': label,
        style: {
          background: MONITOR_COLORS.panel, border: '1px solid ' + MONITOR_COLORS.border,
          borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
        },
      },
        h('div', { style: { fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase', color: MONITOR_COLORS.muted } }, label),
        h('div', { style: { fontSize: 24, fontWeight: 600, lineHeight: 1.1, color: MONITOR_COLORS.text, fontVariantNumeric: 'tabular-nums' } }, value),
        h('div', { style: { display: 'flex', gap: 12, fontSize: 11, color: MONITOR_COLORS.muted, fontVariantNumeric: 'tabular-nums' } },
          h('span', null, 'min ' + (min == null ? '—' : min)),
          h('span', null, 'max ' + (max == null ? '—' : max)),
        ),
        h('svg', {
          viewBox: '0 0 ' + width + ' ' + height,
          preserveAspectRatio: 'none',
          'data-dsh-rust-sparkline': '1',
          style: { width: '100%', height, display: 'block' },
        },
          h('path', { d: path, fill: 'none', stroke: color, strokeWidth: 1.4, vectorEffect: 'non-scaling-stroke', strokeLinejoin: 'round' }),
        ),
        pct == null ? null : h('div', { style: { height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' } },
          h('div', { style: { width: Math.round(pct * 100) + '%', height: '100%', background: color } }),
        ),
      )
    }

    function MonitorTable({ title, count, headers, rows, empty }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('strong', { style: { fontSize: 12.5, color: MONITOR_COLORS.text } }, title),
          count != null ? h('span', { style: { fontSize: 11, color: MONITOR_COLORS.muted } }, String(count)) : null,
        ),
        rows.length === 0
          ? h('div', { style: { fontSize: 11.5, color: MONITOR_COLORS.muted, padding: '6px 2px' } }, empty)
          : h('div', { style: { border: '1px solid ' + MONITOR_COLORS.border, borderRadius: 6, overflow: 'hidden' } },
            h('div', {
              style: {
                display: 'grid', gridTemplateColumns: 'repeat(' + headers.length + ', minmax(0, 1fr))', gap: 8,
                padding: '6px 10px', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4,
                color: MONITOR_COLORS.muted, background: 'rgba(255,255,255,0.03)',
              },
            }, headers.map((header) => h('span', { key: header }, header))),
            rows.map((row, index) => h('div', {
              key: index,
              'data-dsh-rust-monitor-row': String(index),
              style: {
                display: 'grid', gridTemplateColumns: 'repeat(' + headers.length + ', minmax(0, 1fr))', gap: 8,
                padding: '5px 10px', fontSize: 11.5, color: MONITOR_COLORS.text, fontVariantNumeric: 'tabular-nums',
                borderTop: '1px solid ' + MONITOR_COLORS.border, whiteSpace: 'nowrap', overflow: 'hidden',
              },
            }, row.map((cell, cellIndex) => h('span', {
              key: cellIndex,
              style: { overflow: 'hidden', textOverflow: 'ellipsis' },
            }, cell)))),
          ),
      )
    }

    function MonitorDialog({ onClose }) {
      const { data, error } = useMetrics(POLL_MS)
      const fast = useMemo(() => {
        const list = data?.history?.fast
        return Array.isArray(list) ? list.slice(-SPARK) : []
      }, [data])
      const last = fast.length ? fast[fast.length - 1] : null
      const pool = data?.pool ?? null
      const extremes = data?.extremes ?? null
      const running = Boolean(data?.running)
      const series = (key) => fast.map((point) => Number(point[key]) || 0)
      const extreme = (key) => (extremes && extremes.fields ? extremes.fields[key] : null) || null
      const rssLimit = Math.max(1, (pool?.rssSoftLimitMb ?? 512) * 1048576)
      const laneTotal = Math.max(1, (pool?.workers ?? 1) * (pool?.lanesPerWorker ?? 1))
      const sessions = Array.isArray(pool?.sessions) ? pool.sessions : []
      const workers = Array.isArray(pool?.workersDetail) ? pool.workersDetail : []

      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const card = (key, label, format, color, ratioMax) => {
        const ext = extreme(key)
        return h(MonitorCard, {
          key,
          label,
          value: last ? format(last[key]) : '—',
          min: ext ? format(ext.min) : null,
          max: ext ? format(ext.max) : null,
          series: series(key),
          color,
          ratio: last ? Number(last[key]) || 0 : null,
          ratioMax,
        })
      }

      return h('div', {
        'data-dsh-rust-monitor': 'dialog',
        style: {
          position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,0.58)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        },
        onClick: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('div', {
          role: 'dialog',
          'aria-label': pick('dsh-native 性能监控', 'dsh-native performance monitor'),
          style: {
            width: 'min(1100px, 96vw)', maxHeight: '88vh', overflow: 'auto',
            background: MONITOR_COLORS.bg, color: MONITOR_COLORS.text,
            border: '1px solid ' + MONITOR_COLORS.border, borderRadius: 10,
            padding: '14px 16px 18px', boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            display: 'flex', flexDirection: 'column', gap: 14,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', { style: { width: 9, height: 9, borderRadius: 99, background: running ? MONITOR_COLORS.green : MONITOR_COLORS.red, display: 'inline-block' } }),
            h('strong', { style: { fontSize: 15 } }, pick('dsh-native · 性能监控', 'dsh-native · performance')),
            h('span', { style: { fontSize: 11, color: MONITOR_COLORS.muted } },
              pick('进程生命周期', 'process lifecycle') + ' · ' + pick('最近 2 分钟曲线', 'last 2 minutes')),
            h('span', { style: { flex: 1 } }),
            h('span', { style: { fontSize: 11, color: MONITOR_COLORS.muted, fontVariantNumeric: 'tabular-nums' } },
              (extremes && extremes.samples ? extreme('cpuPctOneCore') ? fmtInt(extremes.samples) + ' ' + pick('样本', 'samples') : '' : '')),
            h('button', {
              type: 'button', onClick: onClose,
              style: {
                background: 'transparent', color: MONITOR_COLORS.text,
                border: '1px solid ' + MONITOR_COLORS.border, borderRadius: 6,
                padding: '4px 12px', fontSize: 12, cursor: 'pointer',
              },
            }, pick('关闭', 'Close')),
          ),
          error ? h('div', { style: { fontSize: 12, color: MONITOR_COLORS.red } }, 'metrics unavailable: ' + error) : null,
          !data ? h('div', { style: { fontSize: 12, color: MONITOR_COLORS.muted } }, pick('读取中…', 'loading…')) : null,
          data ? h('div', {
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 },
          },
            card('cpuPctOneCore', pick('CPU · 单核', 'CPU · one core'), fmtPct, MONITOR_COLORS.blue, 100),
            card('workingSetBytes', pick('内存 · 工作集', 'Memory · working set'), fmtBytes, MONITOR_COLORS.green, Math.max(rssLimit, ...series('workingSetBytes'))),
            card('privateBytes', pick('内存 · 私有', 'Memory · private'), fmtBytes, MONITOR_COLORS.green, Math.max(rssLimit, ...series('privateBytes'))),
            card('handles', pick('句柄', 'Handles'), fmtInt, MONITOR_COLORS.orange, Math.max(1, ...series('handles'))),
            card('queued', pick('队列深度', 'Queue depth'), fmtInt, MONITOR_COLORS.yellow, Math.max(1, ...series('queued'))),
            card('inflight', pick('运行中', 'Running'), fmtInt, MONITOR_COLORS.blue, laneTotal),
            card('indexFiles', pick('索引文件', 'Index files'), fmtInt, MONITOR_COLORS.muted, Math.max(1, ...series('indexFiles'))),
            card('indexSymbols', pick('索引符号', 'Index symbols'), fmtInt, MONITOR_COLORS.muted, Math.max(1, ...series('indexSymbols'))),
          ) : null,
          pool ? h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 11.5, color: MONITOR_COLORS.muted, fontVariantNumeric: 'tabular-nums' } },
            h('span', null, pick('调用 ', 'calls ') + String(pool.stats?.calls ?? 0)),
            h('span', null, pick('拒绝 ', 'rejected ') + String(pool.stats?.rejected ?? 0)),
            h('span', null, pick('软限 ', 'soft limit ') + (pool.rssSoftLimitMb ?? '—') + ' MB / ' + (pool.cpuSoftLimitPct ?? '—') + '%'),
            h('span', null, pick('软限动作 ', 'soft action ') + String(pool.softLimits?.lastAction ?? 'none')),
          ) : null,
          h(MonitorTable, {
            title: pick('Workers', 'Workers'),
            count: workers.length,
            headers: ['#', 'pid', pick('运行中', 'running'), 'lanes', pick('状态', 'state')],
            rows: workers.map((worker) => [
              '#' + worker.id,
              String(worker.pid ?? '—'),
              String(worker.inflight ?? 0),
              String(worker.lanes ?? 0),
              worker.retiring ? 'retiring' : 'active',
            ]),
            empty: pick('没有 worker', 'No worker'),
          }),
          h(MonitorTable, {
            title: pick('会话进行时', 'Active sessions'),
            count: sessions.length,
            headers: [pick('会话', 'session'), pick('运行中', 'running'), pick('调用', 'calls'), pick('上次耗时', 'last ms'), pick('最近活动', 'last seen')],
            rows: sessions.map((session) => [
              String(session.sessionId || '').slice(0, 18) || '—',
              String(session.inflight ?? 0),
              String(session.calls ?? 0),
              session.lastCallMs ? Math.round(session.lastCallMs) + ' ms' : '—',
              session.lastSeenAt ? ago(session.lastSeenAt) : '—',
            ]),
            empty: pick('当前没有进行中的会话', 'No session has called the worker yet'),
          }),
        ),
      )
    }

    function MetricsStrip() {
      const { data, error } = useMetrics(POLL_MS)
      const last = data?.history?.fast?.slice(-1)[0]
      if (!data || !last) return error ? null : null
      const rss = Math.round((last.workingSetBytes || 0) / (1024 * 1024))
      // Label and value are separate nodes with a fixed-width, right-aligned value: tabular digits
      // alone still change the string length ("0%" -> "100%"), which made the centred strip jump.
      const itemStyle = { display: 'inline-flex', alignItems: 'baseline', gap: 4 }
      const valueStyle = (width) => ({
        display: 'inline-block', textAlign: 'right', minWidth: width,
        fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"',
      })
      const items = [
        ['CPU', Math.round(last.cpuPctOneCore || 0) + '%', '4ch'],
        ['RSS', rss + ' MB', '7ch'],
        [pick('运行中', 'running'), String(last.inflight || 0), '2ch'],
        [pick('队列', 'queue'), String(last.queued || 0), '2ch'],
      ]
      return h('div', {
        title: pick('R-Native · dsh-native 实时资源', 'R-Native · dsh-native live resources'),
        style: {
          display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center',
          fontSize: 11, opacity: 0.62, padding: '2px 4px 4px', fontVariantNumeric: 'tabular-nums',
          userSelect: 'none', flexWrap: 'wrap',
        },
      },
        h('span', { style: { width: 6, height: 6, borderRadius: 99, background: (last.cpuPctOneCore || 0) > 50 ? COLORS.warn : COLORS.ok, display: 'inline-block' } }),
        h('span', null, 'R-Native'),
        ...items.map(([label, value, width], index) => h('span', { key: label, style: itemStyle },
          h('span', null, label),
          h('span', { 'data-dsh-rust-metric': index, style: valueStyle(width) }, value),
        )),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') return
        // Each registration is independent: one unavailable slot must not cost the other.
        try {
          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
            name: 'settings.plugins.tab',
            id: 'dsh-native',
            order: 20,
            label: () => {
              const lang = String((typeof navigator !== 'undefined' && navigator.language) || 'en')
              return lang.toLowerCase().startsWith('zh') ? 'dsh-native' : 'dsh-native'
            },
          }, RustExecPanel))
        } catch {
          // Slot contract changed or slot missing: the panel simply does not appear.
        }
        // Additive Conversation View: a plugin-rendered view beside the shipped chat/trajectory
        // views (list slot, replaceRisk "none"); the shipped views stay selected by default.
        try {
          ctx.slots.inject('conversation.view', () => ctx.slots.register({
            name: 'conversation.view',
            id: 'dsh-native-view',
            order: 20,
            label: () => pick('dsh-native 视图', 'dsh-native view'),
          }, RustConversationView))
        } catch {
          // View slot unavailable: conversation rendering is untouched.
        }
        // S7: one-line ambient resource summary below the composer card (pure text).
        try {
          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'dsh-native-strip',
            order: 40,
          }, MetricsStrip))
        } catch {
          // Composer dock unavailable: the strip is decorative, never required.
        }
      },
    }
  },
})
