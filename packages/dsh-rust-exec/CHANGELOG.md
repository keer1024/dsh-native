# Changelog

All notable changes to `dsh-rust-exec` (the DSH Host plugin) and its `dsh-rust-worker` sidecar.

## 1.6.0 — 2026-10-23

Async start plus the monitor redesign: DSH paints first and the worker follows, and the panel
shows one row per class instead of two tables at the bottom.

### Changed — the worker starts after the host, not during it
- `deferStart` (default `true`) schedules `pool.start()` `startDelayMs` (default 1200 ms) after
  the plugin mounts; `prewarmIndex` (default `true`) now warms the code index *after* the worker
  answers instead of at process start. The sidecar honours `DSH_RUST_PREWARM=0`, which skips
  both the index prewarm thread and the PowerShell lane prewarm.
- `/health` reports `phase: pending | starting | ready | failed` plus `readiness`
  (`readyMs`, `workerPid`, `index`, `error`). A probe while `pending` counts as a demand signal
  and starts the worker immediately, so a page refresh never waits out the delay.
  `/metrics` carries the same object, so the panel and the route cannot disagree.
- The metrics sampler stays quiet until `phase` is `ready`: the one-second tick can no longer
  spawn the worker ahead of the schedule.
- The panel jumps its next poll forward the moment `phase` turns `ready`, then refills
  `/metrics`, `/sessions`, `/health` and `/cache` without a page reload.

### Changed — monitor cards
- Worker, session and cache cards are two-column, ~196–244 px wide, with a 9 px label above an
  11 px value; every value keeps a `title` with the full text.
- Session cards carry a status dot (green while `inflight > 0`, muted when idle) with
  `aria-label` and `title`, so the state is never colour-only.
- The chart block moved under the worker row and follows the selected card: `worker #id · pid`,
  one two-minute series per metric read from `/metrics.workers[i].history`. The global ring
  stays as the fallback when only one worker is running.
- The trailing `Workers (lanes)` and `会话进行时` tables are gone; the per-class rows and the
  chart block replace them.

### Fixed
- `MetricsStore.readiness` was never linked to the runtime object, so `/metrics` reported
  `readiness: null` while `/health` reported the live phase.

## 1.5.1 — 2026-10-23

### Changed — the status strip reads as `label: value - label: value`
- The composer strip is now `● R-Native  CPU: 0%  -  RSS: 26M  -  运行中: 1  -  队列: 0`: every
  metric gets a `label:` prefix and the four are separated by a muted ` - `.
- RSS switches from `MB` to `M` (`16 MB` → `16M`) and its fixed slot narrows to `5ch`, so the
  line is shorter without losing the no-jump guarantee earned in 1.4.2.

### Fixed — scoped package name finished in all three identity places
- `package.json` and `cordis.patch.yml` already said `@keer1024/dsh-native`, but `client.js` still
  registered `dsh-native` and the profile still listed the unscoped bundle. That is exactly the
  mismatch that fails web boot with `duplicate factory registration`, so the client id, the patch
  id and the profile dependency/bundle are now all `@keer1024/dsh-native`.
  `tools/check_client_identity.mjs` is back to 20/20.

## 1.5.0 — 2026-10-22

Token and latency pass: the model-facing surface got ~62% smaller, oversized outputs are now
bounded at the source, and the code index survives a worker restart.

### Added
- `native_help` — the one discovery tool. The six rarely-used tools (`rust_write`, `rust_edit`,
  `rust_stat`, `rust_ls`, `rust_symbols`, `rust_session_open`) are no longer resident: they are
  registered on demand by `native_help({ tools: ["write"] })` (or `["all"]`), which also lists
  what is still activatable. Resident set is now `rust_exec`, `rust_read`, `rust_search`,
  `rust_health`, `native_help` = **719 tok** of schema per request, down from 1,812 for all ten;
  set `progressiveDisclosure: false` for the old always-on behaviour.
- `rust_read({ compact: true })` — comment-only lines become blank lines (line numbers stay
  valid) and the common indent is removed before the page is rendered. Measured with the real
  renderer: −32.6% on a 200-line Rust page, −25.0% at 400 lines, −8…−23% on JS, −12.6%/−18.3%
  for whole-file reads. Opt in per call or globally with `compactReads: true`.
- Disk-persisted code index (`DSH_RUST_INDEX_CACHE_DIR`, else `%LOCALAPPDATA%\dsh-native\index`),
  keyed by scope root and invalidated per file by `size`/`mtime`; parsing runs on up to 8 threads.
  Same workspace (1,278 files / 6,770 symbols): cold build 313 → **171 ms**, warm start
  313 → **92 ms**, `index.drop` → rebuild from cache 72–94 ms.
- `GET /api/dsh-rust-exec/cache` — one payload for both cache layers (`read`: entries/bytes/
  hits/misses/ttl; `index`: files/symbols/buildMs/reusedFiles/parsedFiles/cachePath/roots).
  `/metrics` now also carries `workers[]` and `cache`, so the new monitor cards need no second
  fetch.
- Monitor cards: one non-wrapping row each for workers (one card per worker), live sessions (one
  card per session, newest three expanded), and cache; overflowing rows fade their right edge and
  report the hidden count as `+N`.

### Changed
- Read/search/stat/list footers and hit lines use **workspace-relative paths**, and hashes are
  printed as a 16-hex prefix that `rust_write`/`rust_edit` accept as `expectedHash`. A 64-hex
  digest cost 36 tok per occurrence and an absolute path 31 tok versus 5 relative.
- An unchanged re-read now renders one line (`[unchanged 12s ago · path · 1513 lines · sha …]`,
  36 tok instead of 71), and the happy-path `complete=true` marker is gone from every footer.
- Tool descriptions and parameter docs were rewritten to be terse (`rust_exec` 180 → 54 tok,
  `rust_search` 110 → 57, `rust_health` 68 → 36).
- `rust_exec` output is capped at 24,000 B by default (`maxBytes` overrides) and now reports
  `truncated` / `shownBytes` / `totalBytes` instead of streaming gigabytes into the transcript.

### Fixed
- `rust_health` could fail with `value is not lossless JSON`: the metrics snapshot stored
  `last.raw = undefined`, which JSON.stringify drops but DSH's lossless encoder rejects. The
  snapshot no longer carries that key.
- `rust_write`/`rust_edit` accept the 16-hex `sha` prefix printed by `rust_read` as
  `expectedHash`; previously only a full 64-hex digest or `"absent"` passed the version guard.

### Packaging
- Renamed to **`@keer1024/dsh-native`** (GitHub Packages requires the scope to match the owner)
  and published there via `.github/workflows/publish.yml`; the scope mapping lives in `.npmrc`.
  Existing installs must update `dsh.profile.bundles` to `@keer1024/dsh-native`.

## 1.4.2 — 2026-10-22

### Changed — kind filter is a dropdown, metric slots no longer jump
- The kind chips (`all / system / user / assistant / tool`) are now **one `<select>`**. Every kind
  found in the projection lands in it automatically, so a future kind needs no code change; known
  kinds keep a fixed order (system → user → assistant → tool) and unknown ones sort alphabetically
  after them. The old chip row grew with each kind and pushed the header — which is height-pinned
  against the DSH scrollport — taller.
- The composer strip (`R-Native CPU … RSS … …`) splits each label from its value and gives the value
  a fixed `ch`-wide, right-aligned slot (`4ch / 7ch / 2ch / 2ch`, `tabular-nums` + `"tnum"`).
  Tabular digits alone were not enough: `0% → 100%` and `9 MB → 1024 MB` change the string length,
  so the centred strip shifted left and right on every poll.
- Tests: `projection_render_test` now pins "one select, no chip buttons, option order, filter →
  `1 / 2`, reset → 2 rows"; `monitor_render_test` pins the four fixed slots and re-renders with an
  extreme sample to prove the slot widths do not depend on the values.
- `route_retry_test` sets `progressiveDisclosure: false` so its "tools register even without a
  webServer" assertion counts all ten tools instead of the five resident ones.

## 1.4.1 — 2026-10-22

### Changed — `meta.description` is the pitch, README is the manual
- `locale/{zh,en}.json` `meta.description` and `package.json` `description` now carry the
  medium-length pitch: what the resident worker owns (commands, sha256-guarded IO, index/search,
  session projection, sampling), what the host stays (JSON-RPC, lane scheduling, 7 routes) and what
  the UI adds (pinned-header projection view, Grafana-style monitor with lifetime min/max, R-Native
  strip). The old copy still said `DF`; it is gone.
- README rewritten as the full reference instead of a quick tour: problem statement, design
  principles, architecture and the path of one tool call, all 10 tools with parameters, all 7 routes
  with fields, a config table with ranges and defaults, env vars, the lock-file contract, UI details
  (scrollport measurement for the pinned header, fixed 420 px detail, filter semantics, monitor
  cards), performance with methodology, install/upgrade/uninstall, a troubleshooting table, the test
  matrix, compatibility, layout and the docs index.
- `docs/rust-exec-plugin/PUBLISHING.md`: market YAML `description.en/zh` now mirror
  `meta.description`; post-install checklist mentions the monitor dialog and the R-Native strip.

## 1.4.0 — 2026-10-22

### Changed — renamed to `dsh-native`, strip label `DF` → `R-Native`
- The plugin is now published under the name **`dsh-native`** (npm bare name was free on 2026-10-22;
  the former name `dsh-flash` had been taken by an unrelated package). The package `name`, the
  `cordis.patch.yml` `name`/`id`, and the `client.js` registry id all changed together, so
  `tools/check_client_identity.mjs` stays green.
- Slot ids follow: `dsh-native-view`, `dsh-native-strip`; the settings tab is registered as
  `dsh-native`, and the UI titles read `dsh-native worker` / `R-Native 视图`.
- The composer status strip label is now **`R-Native`** (was `DF`), with the hint
  `R-Native · dsh-native 实时资源`; the strip order stays CPU → memory → running → queue.
- Internals kept their names on purpose: directory `packages/dsh-rust-exec`, route prefix
  `/api/dsh-rust-exec`, worker image `dsh-rust-worker.exe`, lock and env vars. Renaming those would
  break running profiles for no user-visible gain.

## 1.3.1 — 2026-10-22

### Fixed — the conversation view really is pinned now
- The 1.3.0 layout only stated the intent: DSH mounts plugin conversation views inside its shared
  scrollport (`[data-conversation-scroll]`), whose CSS forces the mounted view to `flex: 1 0 auto;
  min-height: auto`. An auto-height parent makes `height: 100%` resolve to `auto`, so the header and
  the detail pane still scrolled away with the whole tab.
- The view now measures that scrollport's visible box, subtracts its bottom padding, the view's own
  layout offset (scroll-position independent: `rect.top - box.top + scrollTop`) and the floating
  composer band (`[data-composer-seat]`, falling back to `--dsh-composer-height`, clamped to 0–280 px)
  and pins itself to the resulting pixel height. Result: the header and the fixed 420 px detail pane
  stay put, only the message/tool list and the detail body scroll, and the outer tab has no scrollbar.
- Re-measures on scrollport/composer/ancestor resize, window resize, and once after mount; falls back
  to `--dsh-conversation-viewport-height` or the window height when the scrollport is absent.

## 1.3.0 — 2026-10-22

### Added — Grafana-style monitor dialog
- The tab header now has a single **监控器 / Monitor** button. It replaces the old 资源监控 /
  资源监控明细 buttons and their overlay with one dialog: eight stat cards (CPU per core, working
  set, private bytes, handles, queue depth, running, index files, index symbols), each showing the
  current value, lifetime min/max, a zero-dependency SVG sparkline (last 120 samples) and a usage
  bar where a soft limit exists. Below them sit a workers table and an active-sessions table
  (sessionId, inflight, calls, lastCallMs, last activity).
- `/metrics` now returns `extremes`: per-field min/max/last accumulated for the lifetime of the host
  process (cleared by a DSH restart, preserved across page refreshes). The session view now carries
  `calls`, `lastCallMs`, `lastTool` and `lastSeenAt` per session.

### Changed — conversation view
- The header (message/tool counts, mode, fuzzy search, kind chips, tool dropdown, refresh, monitor)
  is pinned; only the message list and the detail pane scroll, and the outer view never scrolls.
- Fuzzy subsequence filtering (case-insensitive, over preview/name/kind/seq) with `<mark>` highlights,
  kind chips plus a tool-name dropdown, a `filtered / total` counter and an explicit empty state.
- The detail pane is a fixed 420 px column (stacked, max 45 % height, below 720 px wide), no longer
  draggable, and selects the first message automatically once the projection loads.
- The composer strip label reads `DF` instead of `flash` (tooltip kept), and its order is now
  CPU → memory (RSS) → running → queue.

## 1.2.1 — 2026-10-21

### Fixed — restart no longer fails
- **The host crashed the Web UI on every restart.** `package.json` said `dsh-flash`, but `client.js`
  still registered its module as `dsh-rust-exec`. DSH keys client modules by package name, so the
  loader could not match the module it had just executed, re-fetched the script, and the second run
  died with `client-modules: duplicate factory registration for "dsh-rust-exec"` — reported by the
  desktop host as `web boot: 1 entry did not activate` / `dsh-flash: import failed`. The
  registration id now matches the package name; `tools/check_client_identity.mjs` guards it.
- **A stale lock could kill an innocent process.** `#reapStale()` signalled whatever pid the lock
  file named. Windows reuses pids, so the number could belong to the DSH host, a shell, or the user's
  browser after a reboot. The pid is now verified against the worker image (`tasklist`) before any
  signal, and the host and its parent are never candidates. If the image probe itself fails, the lock
  is left alone rather than dropped — a silent drop used to leak the real orphan.
- **The lock was never written at all.** DSH starts images that live in the workspace at low
  integrity, and a low-integrity process cannot write `~/.dsh` (`拒绝访问`, os error 5), so the
  worker's own `claim_lock` always failed. The host now writes `~/.dsh/run/dsh-rust-worker-<profile>.lock`
  after the handshake and removes it on `kill`, which makes cross-instance reaping work again.
- **`kill()` leaked the PowerShell shell server.** Closing stdin first made the worker exit on EOF,
  and `taskkill /T` could no longer reach the grandchildren, which kept the pipes open. The tree is
  killed before the pipes are torn down.
- **Shell server could not start under the sandbox.** The server script was written to `%TEMP%`
  (`dsh-rust-worker-shell-<pid>.ps1`) and launched with `-File`; a low-integrity worker is denied
  every write outside the workspace, so each lane failed with `write shell server script … 拒绝访问
  (os error 5)`. The script is now handed over with `-EncodedCommand` (UTF-16LE base64, no temp file),
  the sweep identifies orphans by that flag plus a dead parent, and shells left by earlier versions
  are still cleaned up.

### Changed
- **One truncation contract.** `rust_read`, `rust_search` and `rust_symbols` now stamp every result with
  `complete`, or `truncated by lines|bytes · omitted N · complete=false`, so a caller can tell "this is
  everything" from "there is more" without reading prose. Modelled on dsh-ops' paging contract; see
  `docs/rust-exec-plugin/DSH_OPS_COMPARISON.md`.

## 1.2.0 — 2026-10-21

### Changed
- **Renamed to `dsh-flash`** (package name, bundle id, panel titles, locale `meta.title`). Tool wire
  names and HTTP routes are deliberately unchanged (`rust_*`, `/api/dsh-rust-exec/*`) so existing
  scripts and session logs keep working.
- 「在飞」 wording unified to 「运行中」 (host panel, dashboard, launcher).

### Removed
- The lane badge above the composer (`conversation.input.dock` registration). The input area now has
  no plugin-owned row; the composer-dock ambient strip below it is unchanged.

### UI
- Monitor overlay titled `dsh-flash`, and **all charts are gone** — numbers only cards (CPU / working
  set / handles / queue / running / index / calls), on both the overlay and the settings tab.
- **Resource monitor buttons live at the top of the `dsh-flash` settings tab** (`资源监控` /
  `资源监控明细`); the left panel-rail entries introduced earlier are removed.
- Conversation view: row columns are clamped with `text-overflow: ellipsis` (the third column can no
  longer overlap the preview), and the list/detail divider is **draggable** while the detail pane
  keeps a hard **300 px** floor.

## 1.1.0 — 2026-10-21

### Fixed
- **Metrics routes vanished (panel showed `HTTP 404`).** DSH activates services in dependency
  order, so this plugin's `apply()` can run before `webServer` exists; the old code logged one
  warning and gave up forever. Routes now mount on a backoff (0/100/250/500/1000/2000 ms, then a
  15 s slow retry that never stops), and the outcome is visible in `rust_health` and `GET /health`
  as `routes: { attempts, mounted, errors, mountedAt, exhausted }`.

### Added
- **`session.open` head mode** (`partial` / `hasMore`): decode only as many Zstandard frames as the
  current page needs, and build the full snapshot in a background thread. First page of a 5.5 MB
  session drops from ~1069 ms (full cold build) to **34.2 ms**.
- **`session.body` RPC + `GET /api/dsh-rust-exec/session/body`**: full message text for a bounded
  set of `seq`s (blocks: `text` / `reasoning` / `tool-call` arguments), ~15–25 ms for a page.
- **`conversation.view` upgrade**: on-demand full text, minimal markdown (`**bold**`, `` `code` ``,
  fenced blocks, bullets), collapsible tool-call cards, and windowed row rendering (a 400-message
  page mounts 18 rows).
- `scripts.check` / `scripts.pack:check` in `package.json`, this changelog in the published `files`.

### Changed
- Client view reads its own projection route instead of relying on host conversation state; the
  shipped `chat` view is untouched (additive slot, `replaceRisk: none`).

## 1.0.0 — 2026-10-20

Initial working version after the performance programme:

- `dsh-rust-worker`: JSON-RPC over LSP-style `Content-Length` frames; lane pool with per-call
  shell leases and path-keyed write locks; fs read/write/edit/stat/list; regex symbol index with
  `search.text` / `search.symbol`; metrics sampled through `psapi` FFI; companion lifecycle
  (hello/welcome handshake, bidirectional heartbeat, host-pid watchdog).
- `dsh-rust-exec`: 10 host tools (`rust_exec`, `rust_read`, `rust_write`, `rust_edit`, `rust_stat`,
  `rust_ls`, `rust_search`, `rust_symbols`, `rust_health`, `rust_session_open`), metrics/config
  HTTP routes, settings panel, composer strip, and an additive `conversation.view`.
