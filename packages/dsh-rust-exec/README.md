# dsh-native

**A resident Rust sidecar for DeepSeek Harness (DSH).** Command execution, sha256-guarded file IO,
code indexing and search, session-log projection and resource sampling run in a long-lived Rust
worker; the DSH host stays a thin JSON-RPC / lane-scheduling / route layer, and the browser side
only adds display.

原名 `dsh-flash`（1.4.0 起更名，内部路由 `/api/dsh-rust-exec` 与 worker 名 `dsh-rust-worker` 保持不变）。

## Install

```bash
# 1) install the package into your DSH profile
pnpm add dsh-native            # or: npm i dsh-native

# 2) mount the bundle — the package ships cordis.patch.yml
#    add "dsh-native" to dsh.profile.bundles in <DSH_HOME>/profiles/<profile>/package.json
```

Restart DSH, then check:

```bash
curl http://127.0.0.1:<port>/api/dsh-rust-exec/health
```

A healthy answer contains `ok: true`, the worker pid and the mounted route count (7).

## What you get

| | |
|---|---|
| Tools | `rust_exec`, `rust_read`, `rust_write`, `rust_edit`, `rust_stat`, `rust_ls`, `rust_search`, `rust_symbols`, `rust_session_open`, `rust_health` |
| Routes | `/api/dsh-rust-exec/{metrics,health,events,sessions,session,session/body,config}` |
| UI | pinned-header session projection view (fuzzy filter, fixed 420 px detail), Grafana-style monitor (lifecycle min/max + sparkline), `R-Native` resource strip |
| Worker | warm PowerShell lanes (default 4, max 16), session affinity, soft RSS/CPU limits, watchdog against host exit |

## Requirements

Windows 10/11 x64 · DSH desktop · PowerShell 5.1. No Node.js needed on the target machine.
The bundled `dsh-rust-worker.exe` is **unsigned** — SmartScreen may warn on first launch.

## Docs

- Full manual (architecture, all tool parameters, config table, troubleshooting): https://github.com/keer1024/dsh-native#readme
- Changelog: [CHANGELOG.md](./CHANGELOG.md)

## License

MIT
