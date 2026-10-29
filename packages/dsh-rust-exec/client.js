// dsh-native 插件客户端：浏览器侧的 React 叠加物，不持有任何会话真相。
//
// 职责（通过 ctx.slots 挂三个 slot，彼此独立注册）：
//   1. settings.plugins.tab       -> RustExecPanel：配置、运行状态与「监控器」入口；
//   2. conversation.view          -> RustConversationView（会话投影只读浏览器）；
//   3. conversation.composer.dock -> MetricsStrip：输入框下方一行 R-Native 资源摘要。
// 数据面：probeJson / useMetrics 轮询插件自己的 /metrics、/health、/sessions、/cache，
// 由 readiness.phase 状态机决定何时显示占位符、何时立即补齐数据。
//
// 约束（改本文件时必须保持）：
//   - 绝不调用 location.reload()：slot 由宿主热管理，刷新会丢失当前会话上下文；
//   - 轮询必须节流：一个对话框只允许一条定时器，/sessions 隔次采、/cache 每四次采一次；
//   - 没有数据时一律显示 `—`（见 DASH），不显示 undefined/NaN，也不假装有值；
//   - 状态点不能只靠颜色表意，必须带 aria-label/title（见 Dot 组件）。
//
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

    // API 前缀、轮询周期、曲线保留点数（1 s × 120 ≈ 最近 2 分钟）。
    const API = '/api/dsh-rust-exec'
    const POLL_MS = 1000
    const SPARK = 120

    // 设置页两种语言的静态文案；语言由 pick() 在渲染时决定，这里只做数据表。
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

    // 语义色板（跟随主题）：accent 可交互、ok 正常、warn 降级、bad 故障；监控弹窗另有一套 MONITOR_COLORS。
    const COLORS = {
      accent: '#2f81f7',
      ok: '#3fb950',
      warn: '#d29922',
      bad: '#f85149',
      muted: 'currentColor',
    }

    // 字节数 -> B/KB/MB；Number() || 0 兜住 null/NaN/字符串，保证永不输出 NaN。
    function fmtBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / (1024 * 1024)).toFixed(1) + ' MB'
    }

    // 毫秒 -> s / m+s / h+m 三段式；负数与非法值统一钳成 0，避免出现 "-3s"。
    function fmtDuration(ms) {
      const n = Math.max(0, Number(ms) || 0)
      const s = Math.round(n / 1000)
      if (s < 60) return s + 's'
      const m = Math.floor(s / 60)
      if (m < 60) return m + 'm ' + (s % 60) + 's'
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
    }

    // “多久以前”；缺少时间戳时直接返回 —，调用方不必再判空。
    function ago(ms) {
      if (!ms) return '—'
      return fmtDuration(Date.now() - ms) + ' ago'
    }

    // 长跨度时间：秒 / 分钟 / 小时 / 天 / 月 / 年。
    // 为什么不复用 `fmtDuration`：它只到 `h m`，而且心跳、活动、index age、ttl/build 都靠它保持
    // 短格式；把这里的长单位塞进去会连带改掉那些格子，所以单开一个函数，只服务「最近调用」。
    function fmtSpan(ms) {
      const n = Math.max(0, Number(ms) || 0)
      const s = Math.round(n / 1000)
      if (s < 60) return s + pick(' 秒', ' s')
      const m = Math.floor(s / 60)
      if (m < 60) return m + pick(' 分钟', ' min')
      const hours = Math.floor(m / 60)
      if (hours < 24) return hours + pick(' 小时', ' h')
      const days = Math.floor(hours / 24)
      if (days < 30) return days + pick(' 天', ' d')
      const months = Math.floor(days / 30)
      if (months < 12) return months + pick(' 月', ' mo')
      return Math.floor(days / 365) + pick(' 年', ' y')
    }

    // 距今时间（`20 小时前` / `2 天前` / `3 月前`）；没有时间戳时返回 —，调用方不必判空。
    function fmtSpanAgo(ms) {
      if (!ms) return '—'
      return fmtSpan(Date.now() - ms) + pick('前', ' ago')
    }

    // 极简 sparkline：按数据最大值等比缩放到 100×30 视口；单点数据时补 0 并按整宽取步长，
    // 避免除零、也让曲线退化成一条水平线而不是空 path。
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

    // 设置页的单个指标块：label + 大号数值 + 可选提示；tone 只影响数值颜色。
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

    // 受控数字输入：onChange 统一转 Number，清空输入会得到 0（范围由 min/max 属性提示）。
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

    // 单次 JSON GET，自带 AbortController 超时预算；监控器把多次探测折叠进同一拍。
    /** One JSON GET with its own abort budget; the monitor folds several of these into one tick. */
    async function probeJson(path, timeoutMs = 8000) {
      // 老环境没有 AbortController 时，退化为不带超时的普通 fetch。
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const abortTimer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
      try {
        const res = await fetch(API + path, {
          headers: { accept: 'application/json' },
          signal: controller ? controller.signal : undefined,
        })
        if (!res.ok) {
          const failure = new Error('HTTP ' + res.status)
          failure.status = res.status
          throw failure
        }
        return await res.json()
      } finally {
        if (abortTimer) clearTimeout(abortTimer)
      }
    }

    // 全文件唯一的轮询 hook：一个 tick 拉 /metrics，`withMonitorFeed` 时顺带捎上 /sessions、
    // /health、/cache（各自节流），因此一个对话框只跑一条定时器。
    /**
     * The dialog's only poll loop. `withMonitorFeed` rides the card rows' two extra feeds on the
     * same timer: /sessions is a directory scan (every other tick) and /health is a local RPC, so
     * the monitor never needs a second timer.
     */
    function useMetrics(intervalMs, nonce = 0, withMonitorFeed = false) {
      const [state, setState] = useState({ data: null, error: null, sessions: null, health: null, cache: null })
      useEffect(() => {
        let disposed = false
        let timer = null
        let ticks = 0
        let lastPhase = null
        // 一拍：一次 /metrics + 可选的卡片数据；retryMs 由本拍结果决定下一拍何时到来。
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
            // A deferred start finishes a few seconds after the panel opens. The moment the
            // worker turns ready, refetch every feed at once instead of waiting out the
            // interval, so the cards fill in as soon as the backend is actually up.
            // 只有“从非 ready 跨进 ready”才算就绪跃迁；null 表示还没拿到基线，不算。
            const phase = data?.readiness?.phase ?? null
            const becameReady = phase === 'ready' && lastPhase !== null && lastPhase !== 'ready'
            lastPhase = phase
            // 就绪当拍把下一拍延到 0 ms：先补齐卡片，再恢复常规间隔。
            if (becameReady) retryMs = 0
            // Both card feeds are optional: a failed /sessions or /health never costs the
            // metrics ring, it only leaves the previous values (or `—`) in place.
            let feed = null
            if (withMonitorFeed) {
              // `/sessions` 每拍都拉：删掉会话后卡片要在 1 秒内消失，隔拍拉会看起来"卡住"。
              // `/health` 要一次 worker RPC，保持 2 拍；`/cache` 更慢（4 拍）。
              const wantsHealth = becameReady || ticks % 2 === 0
              const wantsCache = becameReady || ticks % 4 === 0
              feed = await Promise.all([
                probeJson('/sessions').catch(() => null),
                wantsHealth ? probeJson('/health').catch(() => null) : Promise.resolve(null),
                // The cache view asks the worker for `index.status`, so it rides a
                // slower cadence than the counters it sits next to.
                wantsCache ? probeJson('/cache').catch(() => null) : Promise.resolve(null),
              ])
            }
            ticks += 1
            if (!disposed) {
              setState((prev) => ({
                data,
                error: null,
                sessions: feed?.[0]?.sessions ?? prev.sessions,
                health: feed?.[1] ?? prev.health,
                cache: feed?.[2] ?? prev.cache,
              }))
            }
          } catch (error) {
            // A 404 means the route was never mounted in this host boot: that is a
            // plugin/host seam problem, not a transient one. Say so, and stop
            // hammering the server every second while the user fixes it.
            // 404 是装配问题而不是瞬态抖动：退避到 30 s，避免每秒打空路由。
            if (error && error.status === 404) {
              retryMs = 30000
              if (!disposed) {
                setState((prev) => ({
                  ...prev,
                  data: prev.data,
                  error: pick(
                    'HTTP 404 · 指标路由未注册（重载插件后刷新页面）；30 秒后重试',
                    'HTTP 404 · metrics route not mounted (reload the plugin, then refresh); retrying in 30 s',
                  ),
                }))
              }
            } else if (!disposed) {
              setState((prev) => ({ ...prev, data: prev.data, error: error.message || String(error) }))
            }
          } finally {
            // 无论成功失败都清掉 abort 定时器，并把下一拍挂到 retryMs 之后。
            if (abortTimer) clearTimeout(abortTimer)
            if (!disposed) timer = setTimeout(tick, retryMs)
          }
        }
        tick()
        // 卸载时只置标志并清定时器：已发出的请求返回后会看到 disposed 而丢弃结果。
        return () => { disposed = true; if (timer) clearTimeout(timer) }
      }, [intervalMs, nonce, withMonitorFeed])
      return state
    }

    // 设置页主面板：运行状态、采样摘要、worker 明细、并发限额表单，底部内嵌会话投影卡。
    // 表单保持 draft/effective 双轨：只有用户改过 draft，Apply 才可点且不会被轮询覆盖。
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

      // 没有编辑意图时直接映射后端 config；一旦编辑就用 draft，防止每秒轮询把输入冲掉。
      const effective = draft ?? (config ? {
        maxWorkers: config.maxWorkers,
        maxInFlightPerSession: config.maxInFlightPerSession,
        idleReapMs: config.idleReapMs,
        rssSoftLimitMb: config.rssSoftLimitMb,
        cpuSoftLimitPct: config.cpuSoftLimitPct,
      } : null)

      // 提交整份限额；成功后清空 draft，让表单重新跟随服务端回执。
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

    // 只读会话投影浏览器：展开时才拉 /sessions 列表，再按游标分页拉 /session 正文；
    // 它只渲染 Rust worker 投影出的行，会话真相仍在 DSH 自己的 jsonl 日志里。
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

      // 拉取一页投影：reset 或切换会话时从空累积，否则把新页拼到已有消息后面。
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

      // 会话列表只拉一次：展开面板时按需加载，随后默认选中最新一条并取第一页。
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
      // 把各阶段耗时拼成一行（mode / total / decode / json / fold），缺失的阶段自动省略。
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

    // 中英二选一：优先浏览器语言，拿不到就按英文处理（locale API 在此处是可选的）。
    /** Tiny bilingual picker for the View: the client locale API is optional here. */
    function pick(zh, en) {
      const lang = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
      return lang.startsWith('zh') ? zh : en
    }

    // kind -> 行内前景色；未知 kind 不配色，直接继承正文色。
    const VIEW_KIND_COLORS = {
      user: COLORS.accent,
      assistant: COLORS.ok,
      tool: COLORS.warn,
      system: 'color-mix(in srgb, currentColor 55%, transparent)',
      reasoning: 'color-mix(in srgb, currentColor 42%, transparent)',
    }
    // 会话视图共用的行样式与按钮样式；行高固定，虚拟滚动才能用 scrollTop 直接换算下标。
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
    // 行内标记：只认 **粗体** 与 `反引号代码`，一次正则扫完，未匹配的片段原样输出。
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

    // 按行状态机解析：围栏之间整段塞进 <pre>，其余行攒成段落，列表前缀替换成 •。
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

    // 正文块：tool-call 默认折叠（点标题栏展开），其余类型的文本直接渲染；降级用 warn 色标注。
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

    // 虚拟滚动参数：固定行高 46 px，上下各多渲染 8 行以掩盖快速滚动时的白屏。
    const VIEW_ROW_HEIGHT = 46
    const VIEW_OVERSCAN = 8

    // 详情栏固定 420 px；NARROW_BREAKPOINT 为窄屏布局预留，当前宽窄由 wide 状态控制（默认宽屏）。
    const DETAIL_WIDTH = 420
    const NARROW_BREAKPOINT = 720

    // kind 的展示名（[中文, 英文] 成对）；表里没有的 kind 由 kindLabel 原样返回。
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

    // 未知 kind 一律排在已知四类之后；同类之间再按字母序（见 kinds 的 localeCompare）。
    function kindRank(kind) {
      const at = KIND_ORDER.indexOf(String(kind || '').toLowerCase())
      return at < 0 ? KIND_ORDER.length : at
    }

    // 子序列匹配（"tst" 命中 "test"）：空查询视为全匹配；只用于过滤，高亮走的是连续匹配。
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

    // 只高亮连续命中的片段；仅子序列命中的行保持原文，不做逐字符标记。
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

    // 会话视图主体：过滤 + 虚拟滚动 + 按需取正文，高度跟随宿主 scrollport（见下方测量 effect）。
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

      // 分页读投影；quiet 供 3 s 轮询使用，不显示 loading 也不打断当前选中项。
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

      // 点中某行才按 seq 拉正文块，避免打开视图就下载整份会话。
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
        // 切换会话：重置游标并整页重载；alive 标志防止旧请求回写到新会话。
        alive.current = true
        cursor.current = 0
        if (sessionId) load(false, false)
        return () => { alive.current = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])

      useEffect(() => {
        if (!sessionId) return undefined
        // 3 s 静默增量刷新：只 append 新行，不显示 loading、不影响正在阅读的详情。
        const timer = setInterval(() => { load(true, true) }, 3000)
        return () => clearInterval(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])

      useEffect(() => {
        const element = listRef.current
        if (!element) return undefined
        // 列表可视高度变化时更新虚拟滚动窗口；clientHeight 为 0 时先用 420 兜底。
        const measure = () => setViewportHeight(element.clientHeight || 420)
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(element)
          return () => observer.disconnect()
        }
        return undefined
      }, [])

      // 高度自适应：视图挂在宿主共享 scrollport 内，整页滚动会让表头和详情栏一起被顶走；
      // 这里量出 scrollport 的可见高度、扣掉悬浮输入框占位，把视图钉成固定高度。
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
          // 三层来源依次退化：宿主可见高度 > CSS 变量 > 视口兜底；最终不小于 240 px。
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
      // 过滤在内存里完成：kind → tool → 模糊关键词，三者取交集，不修改原始 rows。
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

      // 只渲染 [start, end) 窗口内的行，窗口上下各留白 overscan；上下留白用等高 div 撑出
      // 与真实列表一致的滚动条长度。
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

    // 监控弹窗：设置页与会话视图两个入口共用同一组件；固定一套深色色板，不跟随站点主题。
    // ---- Grafana-style performance monitor. One dialog, opened from the settings tab
    // and from the conversation view header; the old rail entries and overlay are gone.
    // 监控面板专用色板；卡片、图表、状态点与告警色都从这里取。
    const MONITOR_COLORS = {
      bg: '#111217', panel: '#181b1f', border: 'rgba(255,255,255,0.08)',
      text: '#d8d9da', muted: '#8e9297', blue: '#3274d9', green: '#73bf69',
      orange: '#ff9830', red: '#f2495c', yellow: '#fade2a',
    }

    // 数字格式化：fmtInt 四舍五入取整、非法值归 0；fmtPct 固定保留一位小数。
    const fmtInt = (value) => String(Math.round(Number(value) || 0))
    const fmtPct = (value) => (Number(value) || 0).toFixed(1) + '%'

    // ---- Phase-4 card rows, pinned to the top of the monitor dialog. Hard layout contract
    // (grep targets: flex-wrap:nowrap, clamp(196px,16.5vw,244px)):
    //   row  = display:flex; flex-wrap:nowrap; overflow-x:auto    (CARD_ROW_STYLE)
    //   card = flex:0 0 auto; width:clamp(196px,16.5vw,244px)     (CARD_STYLE)
    // Rows never wrap and cards never shrink to fit. When cards fall off the right edge the row
    // draws a fade over that edge and its heading shows a `+N` chip counting the hidden cards.
    // Card bodies are a two-column label-over-value grid: half the height of the old
    // one-row-per-field stack, and values keep their full text in a `title` for long paths.
    // 卡片宽度用 clamp(196px,16.5vw,244px) 随视口伸缩；flex:0 0 auto 保证永不收缩，超出即横向滚动。
    const CARD_WIDTH = 'clamp(196px,16.5vw,244px)'
    const CARD_STYLE = {
      boxSizing: 'border-box', flex: '0 0 auto', width: CARD_WIDTH, minWidth: 0,
      display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left', font: 'inherit',
      background: MONITOR_COLORS.panel, border: '1px solid ' + MONITOR_COLORS.border,
      borderRadius: 6, padding: '8px 10px', color: MONITOR_COLORS.text,
    }
    const CARD_ROW_STYLE = {
      display: 'flex', flexWrap: 'nowrap', alignItems: 'stretch', gap: 8,
      overflowX: 'auto', overflowY: 'hidden', paddingBottom: 4,
    }

    // 7 px 状态灯：语义完全交给 aria-label/title，颜色只是辅助，不能只靠颜色表意。
    /** 7 px state light. Never colour-only: `label` carries the meaning for AT and hover. */
    function Dot({ on, label }) {
      return h('span', {
        role: 'img',
        'aria-label': label,
        title: label,
        style: {
          flex: '0 0 auto', width: 7, height: 7, borderRadius: 99,
          background: on ? MONITOR_COLORS.green : MONITOR_COLORS.muted,
          boxShadow: on ? '0 0 6px ' + MONITOR_COLORS.green : 'none',
          opacity: on ? 1 : 0.55,
        },
      })
    }

    // 所有卡片共用的两列 label-over-value 网格（grid: repeat(2, minmax(0,1fr))），
    // 高度约为逐字段竖排的一半；字符串值额外写 title，长路径截断后仍可悬停查看。
    /** Two-column label/value grid used by all three card kinds; rows are `[label, value]` pairs. */
    function InfoCard({ title, subtitle, rows, accent, dot, testId }) {
      const list = Array.isArray(rows) ? rows : []
      return h('div', {
        // 测试与无障碍共用的稳定标识（`session-<id>` / `worker-<id>`）；正常渲染不影响布局。
        'data-dsh-info': testId,
        style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('strong', {
            title,
            style: {
              fontSize: 11.5, color: accent || MONITOR_COLORS.text, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, title),
          subtitle
            ? h('span', {
              style: {
                fontSize: 9.5, color: MONITOR_COLORS.muted, whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
              },
            }, subtitle)
            : null,
          h('span', { style: { flex: '1 1 auto' } }),
          dot ? h(Dot, dot) : null,
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '3px 10px' } },
          list.map((row, index) => h('div', {
            key: index,
            style: { display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0 },
          },
            h('span', {
              style: {
                fontSize: 9, lineHeight: '11px', letterSpacing: 0.2, textTransform: 'uppercase',
                color: MONITOR_COLORS.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, row[0]),
            h('span', {
              // 行可以是 `[label, value]`，也可以是 `[label, value, title]`：后者让显示值保持简短
              // （相对时间、截断路径），悬停仍能看到完整内容。
              title: row[2] ?? (typeof row[1] === 'string' ? row[1] : undefined),
              style: {
                fontSize: 11, lineHeight: '14px', fontVariantNumeric: 'tabular-nums', minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, String(row[1])),
          )),
        ),
      )
    }

    // 空状态占位卡：占满整行并居中，避免空数据时整行折叠成 0 高度。
    function MutedCard({ text }) {
      return h('div', {
        style: {
          ...CARD_STYLE, width: '100%', flex: '1 1 auto', alignItems: 'center', justifyContent: 'center',
          minHeight: 62, color: MONITOR_COLORS.muted, fontSize: 11.5,
        },
      }, text)
    }

    // 不换行卡片行：横向滚动，右缘渐隐，标题旁 +N 报告被裁掉的卡片数。
    /**
     * One never-wrapping row of fixed-width cards. `items` is `[{ key, node, label }]`; an empty
     * list renders the single muted placeholder instead of an empty strip. Passing `onSelect`
     * turns every card into a focusable button (the worker rows use this to pick a chart source).
     */
    function CardRow({ title, items, empty, onSelect, selectedIndex }) {
      const scrollerRef = useRef(null)
      const [hidden, setHidden] = useState(0)
      const cards = Array.isArray(items) ? items : []
      const measure = () => {
        const node = scrollerRef.current
        if (!node) return
        if (cards.length === 0) { setHidden(0); return }
        // 被裁卡片计数：可视右缘 = scrollLeft + clientWidth，卡片右边界超过它的即算隐藏；
        // +1 的容差吸收亚像素舍入，避免恰好贴边的卡片被误计。
        const edge = node.scrollLeft + node.clientWidth
        let clipped = 0
        for (let index = 0; index < node.children.length; index += 1) {
          const child = node.children[index]
          if (child.offsetLeft + child.offsetWidth > edge + 1) clipped += 1
        }
        // 数量没变就复用旧值，滚动过程中避免每帧触发重渲染。
        setHidden((prev) => (prev === clipped ? prev : clipped))
      }
      useEffect(() => {
        measure()
        if (typeof window === 'undefined') return undefined
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [cards.length, title])
      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('strong', { style: { fontSize: 12.5, color: MONITOR_COLORS.text } }, title),
          h('span', { style: { fontSize: 10.5, color: MONITOR_COLORS.muted } }, String(cards.length)),
          // +N chip：被裁卡片数量，悬停可看到完整说明（中文/英文各一条 title）。
          hidden > 0
            ? h('span', {
              title: pick(hidden + ' 张卡片在右侧', hidden + ' more card(s) to the right'),
              style: {
                marginLeft: 'auto', fontSize: 10.5, color: MONITOR_COLORS.orange,
                border: '1px solid ' + MONITOR_COLORS.border, borderRadius: 9,
                padding: '0 6px', lineHeight: '15px',
              },
            }, '+' + hidden)
            : null,
        ),
        h('div', { style: { position: 'relative', minWidth: 0 } },
          h('div', { ref: scrollerRef, style: CARD_ROW_STYLE, onScroll: measure },
            cards.length > 0
              ? cards.map((card, index) => {
                const key = card.key == null ? index : card.key
                // 传了 onSelect 就渲染成真按钮：可 Tab 聚焦、回车触发，aria-pressed 表达选中态。
                const interactive = typeof onSelect === 'function'
                const selected = interactive && Number(selectedIndex) === index
                return h(interactive ? 'button' : 'div', {
                  key,
                  type: interactive ? 'button' : undefined,
                  title: card.label || undefined,
                  onClick: interactive ? () => onSelect(index) : undefined,
                  'aria-pressed': interactive ? selected : undefined,
                  style: {
                    ...CARD_STYLE,
                    cursor: interactive ? 'pointer' : 'default',
                    appearance: 'none',
                    borderColor: selected ? MONITOR_COLORS.green : MONITOR_COLORS.border,
                    boxShadow: selected ? '0 0 0 1px ' + MONITOR_COLORS.green + ' inset' : 'none',
                  },
                }, card.node)
              })
              : h(MutedCard, { text: empty || '—' }),
          ),
          // 右缘 48 px 渐隐遮罩：暗示右侧还有卡片；pointerEvents: none 保证不挡横向滚动。
          hidden > 0
            ? h('div', {
              style: {
                position: 'absolute', top: 0, right: 0, bottom: 4, width: 48, pointerEvents: 'none',
                background: 'linear-gradient(to right, rgba(17,18,23,0), ' + MONITOR_COLORS.bg + ')',
              },
            })
            : null,
        ),
      )
    }

    // 单指标卡：大数字 + min/max + sparkline，可选 ratio 进度条（内存、车道占用等）。
    function MonitorCard({ label, value, min, max, series, color, ratio, ratioMax }) {
      const values = Array.isArray(series) && series.length ? series : [0]
      // 纵轴上限取本序列峰值，至少为 1：空序列或全 0 时也不会除零。
      const ceiling = Math.max(1, ...values.map((entry) => Number(entry) || 0))
      const width = 120
      const height = 26
      const step = values.length > 1 ? width / (values.length - 1) : width
      const path = values.map((entry, index) => {
        const at = index * step
        const y = height - (Math.min(Number(entry) || 0, ceiling) / ceiling) * (height - 2) - 1
        return (index === 0 ? 'M' : 'L') + at.toFixed(2) + ' ' + y.toFixed(2)
      }).join(' ')
      // 比值先钳到 [0,1]；没有 ratioMax 就不画进度条。
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


    // ---- Card sources for the three top rows. Builders only read published payload shapes and
    // fall back to '—', so a field the host has not shipped yet costs a dash, never a crash.
    // Host contract still owed (see Phase-4 report):
    //   GET /metrics -> optional `workers: [{id, pid, running, inflight, lanes, queued,
    //                   cpuPctOneCore, workingSetBytes, privateBytes, uptimeMs, restarts,
    //                   lastUsedAt}]`  (today only `pool.workersDetail` exists, and the flat
    //                   sample describes the primary worker alone)
    //   GET /metrics -> optional `cache: { read: { entries, hits, misses, bytes, ttlMs },
    //                                   index: { roots, files, symbols } }`
    // 所有「无数据」单元格统一显示长破折号，不用空串、0 或 undefined。
    const DASH = '—'
    // numOrDash：数字或破折号——卡片字段唯一的降级入口；format 默认取整，可按需换成字节/时长。
    /** Number or the em dash: the single degradation rule every card field follows. */
    const numOrDash = (value, format = fmtInt) => (value == null || !Number.isFinite(Number(value)) ? DASH : format(Number(value)))

    // 第一行：每个存活 worker 一张卡。N>1 时没有逐 worker 的 cpu/内存采样，
    // 所以只有 pid/lanes/inflight 来自 /metrics，其余字段一律 —。
    /** Row 1: one card per live worker. With N > 1 workers the per-worker cpu/memory sample is
     * genuinely unknown, so only pid/lanes/inflight come from `/metrics` and the rest is `—`. */
    function workerCards(data, health) {
      const pool = data?.pool ?? {}
      const detail = Array.isArray(pool.workersDetail) ? pool.workersDetail : []
      // 优先读新宿主的 workers[]，没有就退回 pool.workersDetail。
      const list = Array.isArray(data?.workers) && data.workers.length ? data.workers : detail
      // No list at all and no live pool: let the row render its muted placeholder instead.
      const workers = list.length ? list : (Number(pool.workers) > 0 || data?.last ? [{}] : [])
      const single = workers.length === 1
      const sample = single ? (data?.last ?? null) : null
      const probe = (health && health.worker) || {}
      const restartsOf = (worker, index) => {
        if (typeof worker.restarts === 'number') return String(worker.restarts)
        return index === 0 && typeof health?.restarts === 'number' ? String(health.restarts) : DASH
      }
      const uptimeOf = (worker, index) => {
        const value = Number(worker.uptimeMs ?? (index === 0 ? probe.uptimeMs : null))
        return Number.isFinite(value) && value > 0 ? fmtDuration(value) : DASH
      }
      const pidOf = (worker, index) => {
        const value = Number(worker.pid ?? (index === 0 ? probe.pid : null))
        return Number.isFinite(value) && value > 0 ? String(value) : DASH
      }
      const beatOf = (index) => {
        if (index !== 0) return DASH
        const value = Number(probe.lastHostSeenMsAgo)
        return Number.isFinite(value) && value >= 0 ? fmtDuration(value) + ' ago' : DASH
      }
      // 心跳计数：宿主按 worker 记的 ping 次数；缺失时返回 null，卡片只显示"多久之前"。
      const beatCountOf = (worker, index) => {
        const raw = worker.beatCount ?? (index === 0 ? health?.worker?.beats : null)
        const value = Number(raw)
        return Number.isFinite(value) && value >= 0 ? fmtInt(value) : null
      }
      return workers.map((entry, index) => {
        const worker = entry || {}
        const inflight = Number(worker.inflight ?? sample?.inflight ?? NaN)
        const queued = Number(worker.queued ?? sample?.queued ?? pool.queueDepth ?? NaN)
        const running = worker.running === false ? false : true
        const workingSet = sample?.workingSetBytes ?? worker.workingSetBytes
        const beats = beatCountOf(worker, index)
        const rows = [
          ['pid', pidOf(worker, index)],
          [pick('运行', 'uptime'), uptimeOf(worker, index)],
          [pick('CPU 单核', 'cpu one core'), sample ? fmtPct(sample.cpuPctOneCore) : DASH],
          ['working set', workingSet == null || !Number.isFinite(Number(workingSet)) ? DASH : fmtBytes(workingSet)],
          ['inflight/queued', (Number.isFinite(inflight) ? inflight : DASH) + '/' + (Number.isFinite(queued) ? queued : DASH)],
          [pick('重启', 'restarts'), restartsOf(worker, index)],
          [pick('心跳', 'heartbeat'), beatOf(index) + (beats === null ? '' : ' · #' + beats)],
        ]
        return {
          key: 'worker-' + (worker.id ?? index),
          label: 'worker #' + (worker.id ?? index) + ' · pid ' + pidOf(worker, index),
          node: h(InfoCard, {
            testId: 'worker-' + (worker.id ?? index),
            title: pick('Worker ', 'Worker ') + (worker.id ?? index),
            subtitle: running ? (sample ? '' : pick('无采样', 'no sample')) : pick('空闲', 'idle'),
            accent: running ? MONITOR_COLORS.green : MONITOR_COLORS.red,
            rows,
          }),
        }
      })
    }

    // 第二行：每个活跃会话一张卡，顺序沿用 /sessions 的“最新在前”；
    // 投影详情没取到时，「投影」一栏保持 —，不猜数值。
    /** Row 2: one card per active session, newest first (that is the order `/sessions` returns).
     * Detail is honest about being unavailable: without a projection the cache cell stays `—`. */
    function sessionCards(list, details, pool) {
      const rows = Array.isArray(list) ? list : []
      // 两处来源的 id 形状不同：`/sessions` 是会话目录名（可能带 `session-` 前缀、大小写不一），
      // `pool.sessions` 是 DSH 传进 `pool.call` 的 sessionId。归一化后再比对，
      // 否则整列会退化成 `—`（本次修复的第二个根因）。
      const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/^session-/, '')
      const live = new Map()
      ;(Array.isArray(pool?.sessions) ? pool.sessions : []).forEach((entry) => {
        if (entry && entry.sessionId) live.set(norm(entry.sessionId), entry)
      })
      // `/sessions` lists log files; when that route has never answered the pool still knows which
      // sessions are calling right now, so the row falls back to live activity instead of rendering
      // an empty placeholder. Once the route answers, its list is authoritative: a deleted session
      // must lose its card on the next poll instead of being resurrected by the pool fallback.
      const sources = Array.isArray(list)
        ? list
        : [...live.values()].map((entry) => ({ id: entry.sessionId, mtimeMs: entry.lastSeenAt }))
      return sources.map((entry, index) => {
        const id = String(entry?.id ?? '')
        const short = id.replace(/^session-/, '').slice(0, 8) || pick('会话 ', 'session ') + index
        const detail = details ? details[id] : null
        const counts = detail?.counts ?? null
        const inflight = live.get(norm(id)) ?? null
        const active = Number.isFinite(Number(entry?.mtimeMs)) ? ago(Number(entry.mtimeMs)) : DASH
        // 已知会话一律给数字：没有在途调用就是 0（空闲），`—` 只留给"这个会话根本不认识"。
        const inflightCount = inflight ? Math.max(0, Number(inflight.inflight ?? 0) || 0) : 0
        const lastCallMs = inflight && Number.isFinite(Number(inflight.lastCallMs)) ? Number(inflight.lastCallMs) : null
        const lastSeenAt = inflight && Number.isFinite(Number(inflight.lastSeenAt)) ? Number(inflight.lastSeenAt) : null
        // 「最近调用」要能表达 20 小时 / 2 天 / 3 月这种跨度，所以距今时间用 fmtSpanAgo（长单位），
        // 已知单次耗时再附 `· 42 ms`；悬停给完整 ISO 时间，方便核对而不是靠换算。
        const lastCall = lastSeenAt
          ? fmtSpanAgo(lastSeenAt) + (lastCallMs !== null && lastCallMs > 0 ? ' · ' + fmtInt(lastCallMs) + ' ms' : '')
          : lastCallMs !== null && lastCallMs > 0
            ? fmtInt(lastCallMs) + ' ms'
            : DASH
        const cache = detail?.loading
          ? pick('读取中…', 'loading…')
          : detail && detail.nextCursor != null
            ? pick('已投影 ', 'projected ') + String(detail.nextCursor)
            : DASH
        return {
          key: 'session-' + (id || index),
          node: h(InfoCard, {
            testId: 'session-' + (id || index),
            title: short,
            subtitle: detail?.timings?.mode ? String(detail.timings.mode) : undefined,
            // Green light = this session has a call in flight right now; grey = idle.
            dot: {
              on: inflightCount > 0,
              label: inflightCount > 0
                ? pick('正在通信 · inflight ' + inflightCount, 'communicating · inflight ' + inflightCount)
                : pick('空闲,无调用在途', 'idle, no call in flight'),
            },
            rows: [
              [pick('日志', 'bytes'), Number.isFinite(Number(entry?.size)) ? fmtBytes(Number(entry.size)) : DASH],
              [pick('记录', 'records'), counts && Number.isFinite(counts.records) ? fmtInt(counts.records) : numOrDash(detail?.total)],
              [pick('步骤/轮次', 'steps/turns'), counts ? fmtInt(counts.steps) + '/' + fmtInt(counts.turns) : DASH],
              [pick('活动', 'active'), active],
              ['inflight', String(inflightCount)],
              // 第三个元素是悬停标题：显示相对时间，悬停看完整 ISO 时间。
              [pick('最近调用', 'last call'), lastCall, lastSeenAt ? new Date(lastSeenAt).toISOString() : undefined],
              [pick('投影', 'cache'), cache],
            ],
          }),
        }
      })
    }

    // 第三行：固定一张缓存卡。read/index 两块在 /metrics 里都是可选的；
    // 索引计数缺失时退回最新采样里的 indexFiles/indexSymbols，其余保持 —。
    /** Row 3: exactly one card. Both caches are optional in `/metrics`; index counts fall back to
     * the sample the host already publishes, everything else stays `—` until it ships. */
    function cacheCard(data, live) {
      const cache = live ?? data?.cache ?? null
      const read = cache?.read ?? null
      const index = cache?.index ?? null
      const last = data?.last ?? null
      const num = numOrDash
      const roots = index && Array.isArray(index.roots) ? index.roots.filter(Boolean).map(String) : []
      // 索引根可能是数组、单字符串或缺失，按形态依次降级，最终落到 —。
      const rootText = roots.length
        ? roots.join(', ')
        : index && typeof index.root === 'string' && index.root
          ? index.root
          : index && typeof index.roots === 'string' && index.roots ? index.roots : DASH
      return {
        key: 'cache',
        node: h(InfoCard, {
          title: pick('缓存', 'cache'),
          subtitle: 'ttl ' + num(read?.ttlMs, fmtDuration) + ' · build ' + num(index?.buildMs, fmtDuration),
          rows: [
            [pick('读条目', 'read entries'), num(read?.entries, fmtInt)],
            [pick('读字节', 'read bytes'), num(read?.bytes, fmtBytes)],
            [pick('命中/未命中', 'hits/misses'), num(read?.hits, fmtInt) + ' / ' + num(read?.misses, fmtInt)],
            [pick('索引根', 'index roots'), rootText],
            [pick('文件/符号', 'files/symbols'), num(index?.files ?? last?.indexFiles, fmtInt) + ' / ' + num(index?.symbols ?? last?.indexSymbols, fmtInt)],
            [pick('复用/重解析', 'reused/parsed'), num(index?.reusedFiles, fmtInt) + ' / ' + num(index?.parsedFiles, fmtInt)],
          ],
        }),
      }
    }

    // 只为最新几条会话拉投影详情；用 size+mtime 作签名去重，日志没变就不发请求。
    /**
     * `/session` detail for the newest few sessions only, refetched when that log's size/mtime
     * changes. A cold projection decodes the whole log, so the page size is 1 and the request is
     * deduped per `id:size:mtimeMs`; the host's warm cache makes the repeat cheap.
     */
    function useSessionDetails(list, limit = 3) {
      const [details, setDetails] = useState({})
      const seen = useRef({})
      const wanted = (Array.isArray(list) ? list : [])
        .filter((entry) => entry && entry.id)
        .slice(0, limit)
        .map((entry) => ({ id: String(entry.id), sig: String(entry.size ?? '') + ':' + String(entry.mtimeMs ?? '') }))
      const wantedKey = wanted.map((entry) => entry.id + '@' + entry.sig).join(',')
      useEffect(() => {
        let disposed = false
        wanted.forEach((entry) => {
          const previous = seen.current[entry.id]
          if (previous === entry.sig) return
          // Only a log whose size/mtime moved triggers a request; the host's warm cache turns
          // the repeat into an append-sized decode instead of a full projection.
          seen.current[entry.id] = entry.sig
          setDetails((prev) => ({ ...prev, [entry.id]: { ...(prev[entry.id] || {}), loading: true } }))
          probeJson('/session?id=' + encodeURIComponent(entry.id) + '&limit=1')
            .then((detail) => {
              if (disposed) return
              setDetails((prev) => ({ ...prev, [entry.id]: { loading: false, ...detail } }))
            })
            .catch((error) => {
              if (disposed) return
              setDetails((prev) => ({ ...prev, [entry.id]: { loading: false, error: error.message || String(error) } }))
            })
        })
        return () => { disposed = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [wantedKey, limit])
      return details
    }

    // 选中 worker 的资源曲线，紧贴在 worker 卡片行下方；缺少逐 worker 历史时用全局环代替 #0。
    /**
     * Charts for one worker, drawn directly under the worker row. The host publishes a
     * per-worker ring in `workers[i].history`; when it is empty (older host, or N workers
     * with no per-worker sampling) the global ring stands in for worker #0 so the block is
     * never blank.
     */
    function workerCharts(data, index) {
      const pool = data?.pool ?? {}
      const workers = Array.isArray(data?.workers) ? data.workers : []
      const worker = workers[index] ?? workers[0] ?? null
      const own = Array.isArray(worker?.history) ? worker.history : []
      const global = Array.isArray(data?.history?.fast) ? data.history.fast : []
      const points = (own.length ? own : (index === 0 ? global : [])).slice(-SPARK)
      const last = points.length ? points[points.length - 1] : null
      const series = (key) => points.map((point) => Number(point[key]) || 0)
      const range = (key) => {
        const values = series(key)
        return values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: null, max: null }
      }
      const rssLimit = Math.max(1, (pool.rssSoftLimitMb ?? 512) * 1048576)
      const laneTotal = Math.max(1, (pool.workers ?? 1) * (pool.lanesPerWorker ?? 1))
      const card = (key, label, format, color, ratioMax) => {
        const ext = range(key)
        return h(MonitorCard, {
          key,
          label,
          value: last ? format(last[key]) : DASH,
          min: ext.min == null ? null : format(ext.min),
          max: ext.max == null ? null : format(ext.max),
          series: series(key),
          color,
          ratio: last ? Number(last[key]) || 0 : null,
          ratioMax,
        })
      }
      const pid = worker?.pid ?? (index === 0 ? pool.workersDetail?.[0]?.pid : null) ?? null
      const id = worker?.id ?? index
      return h('section', { 'data-dsh-rust-charts': 'worker', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('strong', { style: { fontSize: 12.5, color: MONITOR_COLORS.text } }, pick('资源曲线', 'Resource charts')),
          h('span', { style: { fontSize: 10.5, color: MONITOR_COLORS.muted, fontVariantNumeric: 'tabular-nums' } },
            'worker #' + id + (pid != null ? ' · pid ' + pid : '') + ' · ' + pick('最近 2 分钟', 'last 2 minutes')),
          points.length === 0
            ? h('span', { style: { fontSize: 10.5, color: MONITOR_COLORS.orange } }, pick('等待采样…', 'waiting for samples…'))
            : null,
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 } },
          card('cpuPctOneCore', pick('CPU · 单核', 'CPU · one core'), fmtPct, MONITOR_COLORS.blue, 100),
          card('workingSetBytes', pick('内存 · 工作集', 'Memory · working set'), fmtBytes, MONITOR_COLORS.green, Math.max(rssLimit, ...series('workingSetBytes'), 1)),
          card('privateBytes', pick('内存 · 私有', 'Memory · private'), fmtBytes, MONITOR_COLORS.green, Math.max(rssLimit, ...series('privateBytes'), 1)),
          card('handles', pick('句柄', 'Handles'), fmtInt, MONITOR_COLORS.orange, Math.max(1, ...series('handles'))),
          card('queued', pick('队列深度', 'Queue depth'), fmtInt, MONITOR_COLORS.yellow, Math.max(1, ...series('queued'))),
          card('inflight', pick('运行中', 'Running'), fmtInt, MONITOR_COLORS.blue, laneTotal),
          card('indexFiles', pick('索引文件', 'Index files'), fmtInt, MONITOR_COLORS.muted, Math.max(1, ...series('indexFiles'))),
          card('indexSymbols', pick('索引符号', 'Index symbols'), fmtInt, MONITOR_COLORS.muted, Math.max(1, ...series('indexSymbols'))),
        ),
      )
    }

    // 第四行：节省报表（§15）。所有数字来自宿主 `/metrics.savings`（常量表 × 真实计数），
    // 只有「估算省时」是折算值，所以它单独挂 est 徽章；缺字段一律 —，不猜。
    /**
     * Savings report: fixed per-request saving (measured constants) + per-call saving
     * (measured deltas × real call counts), a contribution bar and the newest sessions.
     * Everything is a lower bound; only the seconds figure is an estimate and carries `est`.
     */
    function savingsRow(data, cache) {
      const savings = data?.savings ?? null
      const num = numOrDash
      const kNum = (value) => {
        const n = Number(value)
        if (value == null || !Number.isFinite(n)) return DASH
        if (Math.abs(n) < 1000) return fmtInt(n)
        return n >= 10000 ? Math.round(n / 1000) + 'k' : (n / 1000).toFixed(1) + 'k'
      }
      // 徽章只有一份文案：估算 = 用吐字速率折算出来的秒数，不是实测耗时。
      const est = (title) => h('span', {
        'data-dsh-est': 'savings',
        title,
        style: {
          fontSize: 8.5, lineHeight: '10px', padding: '1px 4px', borderRadius: 3,
          border: '1px solid ' + MONITOR_COLORS.border, color: MONITOR_COLORS.muted,
          textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap',
        },
      }, 'est')
      const fixed = savings?.fixedPerTurn ?? (savings ? 864 : null)
      const baseline = savings?.baselinePerTurn ?? null
      const resident = savings?.residentPerTurn ?? null
      const turns = savings?.turns ?? null
      const calls = savings?.calls ?? null
      const savedTokens = savings?.savedTokens ?? null
      const savedSeconds = savings?.savedSeconds ?? null
      const buildMs = cache?.index?.buildMs ?? data?.cache?.index?.buildMs ?? null
      const baseMs = savings?.indexBaselineMs ?? null
      const speed = baseMs && buildMs ? Math.round((baseMs / Math.max(1, buildMs)) * 10) / 10 : null
      const cards = [
        {
          key: 'fixed', testId: 'savings-fixed',
          node: h(InfoCard, {
            testId: 'savings-fixed',
            title: pick('每轮固定', 'per request'),
            subtitle: baseline != null && resident != null ? pick('原生 ', 'native ') + fmtInt(baseline) + ' → ' + pick('当前 ', 'now ') + fmtInt(resident) : DASH,
            accent: MONITOR_COLORS.green,
            rows: [
              [pick('固定节省', 'fixed saving'), fixed == null ? DASH : fmtInt(fixed) + ' tok'],
              [pick('口径', 'basis'), savings ? (savings.basis === 'lower-bound' ? pick('下界', 'lower bound') : String(savings.basis)) : DASH],
            ],
          }),
        },
        {
          key: 'total', testId: 'savings-total',
          node: h(InfoCard, {
            testId: 'savings-total',
            title: pick('累计节省', 'saved so far'),
            subtitle: (turns == null ? DASH : fmtInt(turns) + ' turns') + ' · ' + (calls == null ? DASH : fmtInt(calls) + ' calls'),
            accent: MONITOR_COLORS.green,
            rows: [
              [pick('合计', 'total'), kNum(savedTokens) + (savedTokens == null ? '' : ' tok')],
              [pick('固定 / 调用面', 'fixed / calls'), kNum(fixed == null || turns == null ? null : fixed * turns) + ' / ' + kNum(savings?.callTokens)],
            ],
          }),
        },
        {
          key: 'time', testId: 'savings-time',
          node: h(InfoCard, {
            testId: 'savings-time',
            title: pick('估算省时', 'est. time saved'),
            // est 徽章放在副标题里：它是唯一一个「折算值」，必须一眼能和实测值区分开。
            subtitle: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              '≈' + fmtInt(savings?.outputTokPerSec ?? 45) + ' tok/s',
              est(pick('按输出 token 折算，不是实测耗时', 'divided by output tok/s; not measured wall time')),
            ),
            accent: MONITOR_COLORS.orange,
            rows: [
              [pick('折算', 'folded'), savedSeconds == null ? DASH : fmtSpan(savedSeconds * 1000)],
              [pick('来源', 'from'), savedTokens == null ? DASH : kNum(savedTokens) + ' tok'],
            ],
          }),
        },
        {
          key: 'index', testId: 'savings-index',
          node: h(InfoCard, {
            testId: 'savings-index',
            title: pick('索引加速', 'index speedup'),
            subtitle: baseMs == null ? DASH : pick('冷建 ', 'cold ') + fmtInt(baseMs) + ' ms',
            accent: MONITOR_COLORS.blue,
            rows: [
              [pick('当前 buildMs', 'build now'), buildMs == null ? DASH : fmtInt(buildMs) + ' ms'],
              [pick('加速', 'speedup'), speed == null ? DASH : speed + '×'],
            ],
          }),
        },
      ]
      // 堆叠条：各工具「调用次数 × 单次节省」的占比；未定标工具不进条（按 0 计）。
      const perCall = savings?.perCall ?? {}
      const byTool = savings?.byTool ?? {}
      const parts = Object.entries(byTool)
        .map(([tool, count]) => ({ tool, count: Number(count) || 0, tok: (Number(count) || 0) * (Number(perCall[tool]) || 0) }))
        .filter((part) => part.tok > 0)
        .sort((a, b) => b.tok - a.tok)
      const totalTok = parts.reduce((sum, part) => sum + part.tok, 0)
      const barColors = [MONITOR_COLORS.green, MONITOR_COLORS.blue, MONITOR_COLORS.orange, MONITOR_COLORS.yellow, MONITOR_COLORS.red]
      let used = 0
      const segments = parts.map((part, index) => {
        const pct = index === parts.length - 1 ? Math.max(0, 100 - used) : Math.round((part.tok / totalTok) * 1000) / 10
        used += pct
        return h('div', {
          key: part.tool,
          title: part.tool + ' ×' + fmtInt(part.count) + ' = ' + fmtInt(part.tok) + ' tok',
          style: { width: pct + '%', background: barColors[index % barColors.length], height: '100%' },
        })
      })
      const bar = h('div', {
        'data-dsh-savings-bar': 'tools',
        style: {
          display: 'flex', height: 8, borderRadius: 3, overflow: 'hidden',
          background: MONITOR_COLORS.panel, border: '1px solid ' + MONITOR_COLORS.border,
        },
      }, segments.length ? segments : null)
      const header = ['会话', 'turns', 'calls', '节省']
      const rows = (Array.isArray(savings?.sessions) ? savings.sessions : []).slice(0, 3)
      const table = h('div', { 'data-dsh-savings-table': 'sessions', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 52px 52px 72px', gap: 6 } },
          header.map((label, index) => h('span', {
            key: label,
            style: {
              fontSize: 9, lineHeight: '11px', letterSpacing: 0.2, textTransform: 'uppercase', color: MONITOR_COLORS.muted,
              textAlign: index === 0 ? 'left' : 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, index === 0 ? pick('会话', 'session') : label)),
        ),
        rows.length
          ? rows.map((row) => h('div', {
            key: String(row.sessionId),
            style: { display: 'grid', gridTemplateColumns: '1fr 52px 52px 72px', gap: 6, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' },
          },
            h('span', { title: String(row.sessionId), style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(row.sessionId).slice(0, 8)),
            h('span', { style: { textAlign: 'right', color: row.counted ? MONITOR_COLORS.text : MONITOR_COLORS.muted }, title: row.counted ? undefined : pick('日志投影还没读到，按 0 计', 'log projection not read yet; counted as 0') }, row.counted ? fmtInt(row.turns) : DASH),
            h('span', { style: { textAlign: 'right' } }, fmtInt(row.calls)),
            h('span', { style: { textAlign: 'right' } }, kNum(row.savedTokens)),
          ))
          : h('span', { style: { fontSize: 10.5, color: MONITOR_COLORS.muted } }, savings ? pick('没有已计算的会话', 'no counted session yet') : DASH),
      )
      return h('section', {
        'data-dsh-savings': 'row',
        style: { display: 'flex', flexDirection: 'column', gap: 6 },
      },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('strong', { style: { fontSize: 12.5, color: MONITOR_COLORS.text } }, pick('节省', 'savings')),
          h('span', { style: { fontSize: 10.5, color: MONITOR_COLORS.muted } },
            savings?.note ?? pick('对比 1.4.1 基线；估算项带 est', 'vs the 1.4.1 baseline; estimates carry est')),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'nowrap', alignItems: 'stretch', gap: 8, overflowX: 'auto', paddingBottom: 4 } },
          cards.map((card) => h('div', { key: card.key, style: { ...CARD_STYLE } }, card.node)),
        ),
        bar,
        table,
      )
    }

    // 三行卡片 + 曲线块的整体：弹窗只做布局，数据拼装都留在各 builder 里。
    /** The three Phase-4 rows as one block, so MonitorDialog itself stays a layout function. */
    function MonitorCardRows({ data, sessionLogs, sessionDetails, health, cache, selectedWorker, onSelectWorker, phase }) {
      // 未就绪时卡片行只显示占位文案，不渲染一整排破折号卡片。
      const reading = phase && phase !== 'ready'
      return h(React.Fragment, null,
        h(CardRow, {
          title: 'Workers',
          items: reading ? [] : workerCards(data, health),
          empty: reading ? pick('启动中…', 'starting…') : pick('没有活跃 worker', 'no active worker'),
          onSelect: reading ? undefined : onSelectWorker,
          selectedIndex: selectedWorker,
        }),
        // Charts follow the selected worker and sit immediately under the worker row.
        workerCharts(data, selectedWorker),
        h(CardRow, {
          title: 'Sessions',
          items: reading ? [] : sessionCards(sessionLogs, sessionDetails, data?.pool),
          empty: reading ? pick('启动中…', 'starting…') : pick('没有活跃会话', 'no active session'),
        }),
        h(CardRow, {
          title: 'Cache',
          items: [cacheCard(data, cache)],
        }),
        // 第四行：节省报表，紧跟 Cache 行（§15.2）。
        savingsRow(data, cache),
      )
    }

    // 监控弹窗：固定深色面板；Escape 或点遮罩关闭，phase 决定状态灯与标题文案。
    function MonitorDialog({ onClose }) {
      const { data, error, sessions: sessionLogs, health, cache } = useMetrics(POLL_MS, 0, true)
      const pool = data?.pool ?? null
      const extremes = data?.extremes ?? null
      // 'pending' | 'starting' | 'ready' | 'failed' from the host's readiness block. The
      // panel shows placeholders instead of a wall of dashes while the worker boots.
      // phase 来自宿主的 readiness 块；旧宿主没有该块时，data 一到就按 ready 处理。
      const phase = data?.readiness?.phase ?? (data ? 'ready' : 'pending')
      const running = Boolean(data?.running)
      // Charts are bound to one worker; clicking a worker card switches them.
      const [selectedWorker, setSelectedWorker] = useState(0)

      // 全局 Escape 关闭；onClose 变化时重新绑定，卸载时解绑。
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      // Projection detail for the newest sessions; same poll loop, no extra timer.
      const sessionDetails = useSessionDetails(sessionLogs)

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
            width: 'min(1100px, 96vw)', maxHeight: '75vh', overflow: 'auto',
            background: MONITOR_COLORS.bg, color: MONITOR_COLORS.text,
            border: '1px solid ' + MONITOR_COLORS.border, borderRadius: 10,
            padding: '14px 16px 18px', boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            display: 'flex', flexDirection: 'column', gap: 14,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', {
              style: {
                width: 9, height: 9, borderRadius: 99, display: 'inline-block',
                // 状态灯：ready 按 running 取绿/红，failed 红，其余（pending/starting）橙。
                background: phase === 'ready' ? (running ? MONITOR_COLORS.green : MONITOR_COLORS.red)
                  : phase === 'failed' ? MONITOR_COLORS.red : MONITOR_COLORS.orange,
              },
            }),
            h('strong', { style: { fontSize: 15 } }, pick('dsh-native · 性能监控', 'dsh-native · performance')),
            h('span', { style: { fontSize: 11, color: MONITOR_COLORS.muted } },
              phase === 'ready'
                ? pick('进程生命周期', 'process lifecycle') + ' · ' + pick('最近 2 分钟曲线', 'last 2 minutes')
                : phase === 'failed'
                  ? pick('启动失败:见下方状态', 'start failed: see status below')
                  : pick('启动中 · 就绪后自动补齐数据', 'starting · data fills in automatically')),
            h('span', { style: { flex: 1 } }),
            h('span', { style: { fontSize: 11, color: MONITOR_COLORS.muted, fontVariantNumeric: 'tabular-nums' } },
              (extremes && extremes.samples ? fmtInt(extremes.samples) + ' ' + pick('样本', 'samples') : '')),
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
          // Phase-4 rows, pinned above the older stats line. One row per class, never wraps; a
          // row that overflows fades its right edge and reports the hidden count as `+N`.
          // Charts live inside the block, immediately under the worker row.
          data ? h(MonitorCardRows, {
            data,
            sessionLogs,
            sessionDetails,
            health,
            cache,
            selectedWorker,
            onSelectWorker: setSelectedWorker,
            phase,
          }) : null,
          pool ? h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 11.5, color: MONITOR_COLORS.muted, fontVariantNumeric: 'tabular-nums' } },
            h('span', null, pick('调用 ', 'calls ') + String(pool.stats?.calls ?? 0)),
            h('span', null, pick('拒绝 ', 'rejected ') + String(pool.stats?.rejected ?? 0)),
            h('span', null, pick('软限 ', 'soft limit ') + (pool.rssSoftLimitMb ?? '—') + ' MB / ' + (pool.cpuSoftLimitPct ?? '—') + '%'),
            h('span', null, pick('软限动作 ', 'soft action ') + String(pool.softLimits?.lastAction ?? 'none')),
          ) : null,
        ),
      )
    }

    // 输入框下方的一行常驻资源摘要：整条可点开监控弹窗（Esc 关闭），拿不到采样时整条不渲染。
    function MetricsStrip() {
      const { data, error } = useMetrics(POLL_MS)
      const [open, setOpen] = useState(false)
      const [hover, setHover] = useState(false)
      const [focus, setFocus] = useState(false)
      const last = data?.history?.fast?.slice(-1)[0]
      if (!data || !last) return error ? null : null
      const rss = Math.round((last.workingSetBytes || 0) / (1024 * 1024))
      // 数值列用 ch 固定最小宽度：否则 "0%" 变成 "100%" 会把居中的整条文本顶得左右跳。
      // Label and value are separate nodes with a fixed-width, right-aligned value: tabular digits
      // alone still change the string length ("0%" -> "100%"), which made the centred strip jump.
      const itemStyle = { display: 'inline-flex', alignItems: 'baseline', gap: 4 }
      const valueStyle = (width) => ({
        display: 'inline-block', textAlign: 'right', minWidth: width,
        fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"',
      })
      const items = [
        ['CPU:', Math.round(last.cpuPctOneCore || 0) + '%', '4ch'],
        ['RSS:', rss + 'M', '5ch'],
        [pick('运行中:', 'running:'), String(last.inflight || 0), '2ch'],
        [pick('队列:', 'queue:'), String(last.queued || 0), '2ch'],
      ]
      const nodes = []
      items.forEach(([label, value, width], index) => {
        if (index > 0) nodes.push(h('span', { key: 'sep-' + index, style: { opacity: 0.45 } }, ' - '))
        nodes.push(h('span', { key: label, style: itemStyle },
          h('span', null, label),
          h('span', { 'data-dsh-rust-metric': index, style: valueStyle(width) }, value),
        ))
      })
      const strip = h('div', {
        role: 'button',
        tabIndex: 0,
        'aria-label': pick('打开 dsh-native 监控面板', 'open the dsh-native monitor'),
        'data-dsh-rust-strip': 'summary',
        title: pick('R-Native · dsh-native 实时资源 · 点击查看监控', 'R-Native · dsh-native live resources · click for the monitor'),
        onClick: () => setOpen(true),
        onKeyDown: (event) => {
          // 键盘等价物：Enter 与 Space 都要打开，Space 记得阻止页面滚动。
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault()
            setOpen(true)
          }
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false),
        style: {
          display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center',
          fontSize: 11, opacity: hover || focus ? 0.95 : 0.62, padding: '2px 6px 4px',
          fontVariantNumeric: 'tabular-nums', userSelect: 'none', flexWrap: 'wrap',
          cursor: 'pointer', borderRadius: 6,
          border: '1px solid ' + (hover ? MONITOR_COLORS.border : 'transparent'),
          boxShadow: focus ? '0 0 0 2px ' + COLORS.accent : 'none',
          transition: 'opacity 120ms ease, border-color 120ms ease',
        },
      },
        // 小圆点只是粗略提示：单核 CPU 超过 50% 转警告色，其余为正常色。
        h('span', { style: { width: 6, height: 6, borderRadius: 99, background: (last.cpuPctOneCore || 0) > 50 ? COLORS.warn : COLORS.ok, display: 'inline-block' } }),
        h('span', { style: { marginRight: 2 } }, 'R-Native'),
        ...nodes,
      )
      if (!open) return strip
      return h(React.Fragment, null, strip, h(MonitorDialog, { onClose: () => setOpen(false) }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 三个 slot 各自 try/catch：任一 slot 缺失或契约变化，不能拖垮另外两个。
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
