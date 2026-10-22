# 对标 dsh-ops：设计对比与能力取舍

对标对象：[`T-Auto/dsh-ops`](https://github.com/T-Auto/dsh-ops)（v0.4.1，`dsh-plugin.json` id `dsh-ops.native`）。
调研方式：GitHub API 读取仓库树与源码（`api.github.com` 可用；`raw.githubusercontent.com` 在本机 DNS 不可达）。
本文只记录**结论与取舍**，每条技术点都标了来源文件，方便复核。

## 1. 两者定位不同

| | dsh-ops | dsh-native |
|---|---|---|
| 形态 | DSH 插件 + 原生内核（Rust/C++ 子进程 **每次调用冷启动**） | DSH 插件 + **常驻** worker（热 lane 池、握手、心跳、看护） |
| 工具面 | 20 个专用工具，1 个常驻（`ops_read_files`），其余按需发现 | 10 个工具全部常驻可见，语义按「执行 / 文件 / 检索 / 会话」分组 |
| 强项 | 输出预算、溢出落盘、引用句柄、批量状态机 | 常驻 shell 热执行、进程生命周期治理、会话投影 |
| 弱项 | 每次调用都要付进程创建 | 输出契约不如对方细致，缺批量与引用句柄 |

结论：**不照搬架构**（冷启动 per call 正是我们花力气消除的成本），只吸收它在「返回体积与可续页」上的做法。

## 2. 值得吸收的机制

| # | 机制 | 出处 | 我们的处理 |
|---|---|---|---|
| 1 | 读一次去重：`(tool, arguments, path, revision, size, mtimeNs, ctimeNs)` 为键，命中返回 `[Notice: Unchanged file range; body already present …]` | `src/modes/native/read-observation.ts:30-67` | **已具备**：`readCache`（256 条、5 min TTL）+ `renderRead` 的 `[unchanged · …]` |
| 2 | 统一截断契约：`complete` / `truncated` / `truncatedBy` / `nextOffset` / `nextAction` | `paging.rs:56-96`、`render.ts:10-38` | **已补齐**（v1.2.1）：`completeness()` 统一输出 `complete` 或 `truncated by lines/bytes · omitted N · complete=false`，读/检索/符号三处共用 |
| 3 | 原生输出上限阶梯：request 2 MiB / response 96 KiB / transport 128 KiB / model 64 KiB | `kernel/result-storage.ts:32-36` | 我们已有 `maxBytes` + worker 侧硬上限；**未做**多级预算拆分 |
| 4 | 溢出落盘 + `{text,nextOffset,shown,omitted,hasMore,stub}` | `native/crates/ops-files/src/spill.rs:13-114` | **未做**：大结果目前靠截断，不落盘也不给 stub |
| 5 | 不透明续页游标 `s1:<binding>:<snapshot>:<next>:<sha256>`，失效报 `SEARCH_STALE` | `ops-search/src/paging.rs:20-40` | **未做**：检索分页靠 `maxHits` 重跑，索引变了结果可能漂移 |
| 6 | 引用句柄 `ref://<scope>/<producer>/<uuid>` + `ops_result` 分页 | `ops-results/src/references.rs:38-140` | **未做**：长输出只能当场看完或截断 |
| 7 | 会话结果缓存：10 MiB/result、100 MiB/session、4096 条、LRU + temp/rename/sync | `ops-results/src/cache.rs:11-113` | 部分等价：worker 侧会话投影有 `full`/`append`/`warm` 缓存 |
| 8 | 批量 plan → resume（id 续跑） | `ops-batch/lib.rs:11-36` | **未做**：并发靠模型同 step 多调用 |
| 9 | 并发上限 `MAX_ACTIVE_CALLS=2` / `MAX_WAITING_CALLS=8` → `JOB_BUSY` | `kernel/call-budget.ts:2-3` | 已有 `WORKER_BUSY` / `maxQueue` / 每会话在飞上限 |
| 10 | `effectState: none\|applied\|partial\|unknown` + `RESULT_UNKNOWN` | `file/worker.ts:200-205` | **未做**：写失败有错误、成功有 hash，但没有统一三态标记 |
| 11 | 没有索引，检索明确给出覆盖结论 Complete/Incomplete | `paging.rs:87-95` | 我们有常驻索引（更快），同样在 footer 给 `complete` |

**明确不抄**：plan/run/resume 持久化状态机（我们单次调用内完成）、per-call 冷启动、C++/MSYS bash-ipc 代理、
20 个专用 schema（工具越少，模型选择成本越低）。

## 3. 本轮已落地的改动

1. `completeness()` + 三处 render（`rust_read`、`rust_search`、`rust_symbols`）统一输出完整性标记；
   截断时一并给出按什么截断、省略多少条。→ 模型不必从散文里猜「还有没有」。
2. 读一次去重（原有实现）复核：键含 `agent id / path / offset / limit`，命中返回 `[unchanged · …]`，
   `refresh: true` 强制重印；TTL 5 分钟、上限 256 条。
3. 这条链路和 v1.2.1 的重启修复一起进入验收脚本（`tools/*_test.mjs` 全绿）。

## 4. 待办（按收益/成本排序）

| 优先 | 项 | 收益 | 成本 |
|---|---|---|---|
| P0 | 检索续页游标（`searchCursor` + 索引代次校验，失效报 `SEARCH_STALE`） | 分页不再重跑、结果不漂移 | M |
| P1 | `effectState` 三态（写/改/删统一） | 失败与未知可区分，重试更安全 | S |
| P1 | 溢出落盘 + `spill` stub（大结果给路径与续读指令） | 大输出不再被硬截断 | M |
| P2 | `ref://` 引用句柄 + `rust_result` 分页 | 一次调用产出的长结果可分段消费 | L |
| P2 | `rust_batch`（plan → 逐项 → resume） | 少一轮工具往返 | M |
| P3 | 多级预算阶梯（request/response/transport/model） | 极端大结果更稳 | S |
