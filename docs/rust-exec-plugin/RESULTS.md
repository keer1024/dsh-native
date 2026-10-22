# RESULTS — Rust 业务执行插件实测报告

> **v1.2.1 状态（2026-10-21）**：本文档保留历史阶段的设计与实测记录；与当前代码不一致处以下列为准：
> 包名已改为 `dsh-flash`（工具名 `rust_*`、路由前缀 `/api/dsh-rust-exec` 保持不变）；lane 徽标与全部 SVG
> 2026-10-22（1.4.0）：包名再次更名为 `dsh-native`；下文历史记录里的 `dsh-flash` 指同一插件。
> 曲线/图表已删除，资源监控改为设置页 `dsh-flash` 标签页顶部的「资源监控 / 资源监控明细」按钮 + 数字卡片；
> 路由共 7 条（metrics、health、events、sessions、session、session/body、config）；v1.2.1 修复重启失败
> （客户端注册 id 与包名不一致导致 web boot 失败）、锁文件误杀、kill 泄漏 PowerShell 孙进程、低完整性下
> shell server 无法启动。详见 `packages/dsh-rust-exec/CHANGELOG.md`。


> 日期：2026-10-19 · 环境：Windows 10 x64（8 逻辑核 / 15.7 GB）、Defender 实时防护开启（`MsMpEng` 在本机是进程启动的主要拖累）
> 所有数字均为**本机实测**，未测的会明确标注"未测"。

## 0. 结论先行（一句话 + 三个数字）

**把"业务执行"搬进常驻 Rust worker，收益集中在 shell 调用这一环：单次 4.4 s → 0.03 s（137×）；折算到端到端性能，受 LLM 推理主导的 Amdahl 上限约束，现实收益约 1.15–1.25×（成本时间 −16%～−20%），不是数量级提升。**

| 指标 | 前置基线 | 交付后实测 | 变化 |
|---|---|---|---|
| 单次 shell 类命令（工具耗时，DSH 日志口径） | pwsh 中位 **4387 ms**（n=5 交错对照） | rust_exec 中位 **32 ms** | **137×** |
| 同上，均值口径 | 4247.6 ms | 49.8 ms | 85× |
| 常驻 worker 自身微基准 | 一次性 `powershell.exe` 2850 ms | 常驻壳均值 **17.0 ms** | **168×** |
| 累计日志口径（含历史会话） | pwsh 中位 6049 ms（n=444） | rust_exec 中位 86.5 ms（n=10） | 69.9× |
| 每 step 端到端耗时 | 19.92 s | 19.92 − 3.9 = **16.0 s** | **1.24×** |
| 端到端区间（保守/乐观） | — | — | **1.15× / 1.25×** |
| 每个 model 往返的平均成本 | ≈24.6 s | ≈20.7 s | −16% |

## 1. 交付物

| 路径 | 内容 |
|---|---|
| `packages/dsh-rust-worker/` | Rust worker（507 KiB bin）：Content-Length 帧 + JSON-RPC 2.0；`initialize` / `ping` / `fs.*` / `exec` / `shutdown`；fs 带 sha256 版本守卫；常驻 PowerShell 命令服务（loopback TCP）；启动清扫孤儿壳 |
| `packages/dsh-rust-exec/` | DSH 宿主插件：`apply(ctx, config)` 直接 `ctx.tools.register(...)` 注册 6 个工具；worker 生命周期随 `ctx.effect` 回收；崩溃/超时自动重启 |
| `tools/worker_test.mjs` | worker 协议与行为测试 15/15 通过（含版本守卫、歧义守卫、退出码传播、常驻壳状态保持、冷/热基准） |
| `tools/bench.mjs` | Node 侧 1 MiB 读写基线 |
| `docs/rust-exec-plugin/ANALYSIS_AND_PLAN.md` | 设计、收益模型、反事实、风险、分阶段计划（本报告是它的验收证据） |

工具清单：`rust_exec`、`rust_read`、`rust_write`、`rust_edit`、`rust_stat`、`rust_list`。

## 2. 微基准（可一键重跑：`node tools/worker_test.mjs`）

```
PASS  initialize            init=2.8 ms  shell=powershell.exe / loopback-tcp
PASS  exec (cold)           exit=0 ms=759   out="hello from shell"
PASS  exec (warm x5)        mean=17.0 ms   runs=38/13/12/11/11
PASS  exec persistent shell "persisted=yes"（全局变量跨命令存活）
PASS  exec exit code        7
BENCH warm exec mean 17.0 ms | one-shot powershell.exe mean 2850 ms | speedup 167.6x
15/15 checks passed
```

冷启动 759 ms 是**首次 exec**（shell 在插件加载时已预热，故仍标记 `reused=true`）；纯冷启动（worker 刚拉起、壳未预热）在崩溃恢复中实测 2.1–2.3 s，已被"插件加载即预热"挡在用户感知之外。

## 3. 会话内 A/B（真实 DSH 会话，交错执行，结果一致）

同一会话交替调用两个工具，A=`echo $([int]1)`，B=`$PSVersionTable.PSVersion.Build`，各 5 轮交错（避免顺序偏差）：

| 轮 | pwsh（日志 ms） | rust_exec（日志 ms） | rust_exec（界面显示） |
|---|---|---|---|
| 1 | 4150 | 93 | 80 |
| 2 | 4506 | 80 | 60 |
| 3 | 4387 | 22 | 8 |
| 4 | 3773 | 22 | 6 |
| 5 | 4422 | 32 | 16 |
| **中位** | **4387** | **32** | — |

两个工具对两条命令返回**完全相同**的结果，差异只来自进程启动路径。

> 界面显示的 ms 只是壳内执行时间，不含 IPC 与冷启动；本报告一律用**日志口径**（tool/call → tool/result）。缺陷 D2 已修：`rust_exec` 现在同时显示 `wall`（端到端）与 `shell`（壳内）两个耗时。

## 4. 端到端收益模型（推导，可被证伪）

基线取自 7 份会话日志、288 个 step（`tools/telemetry4.py`）：

```
step 均值 19.92 s = LLM 等待 5.19 + step 内工具执行 14.22 + 本地/框架 0.51
工具调用 435 次 / 288 step = 1.51 次/step；pwsh 占工具调用 60.2% (262/435)、占工具时间 64%
```

替换量（只算启动开销，不假设命令本身变快）：

```
节省/step = 1.51 × 60.2% × min(实测启动 3.5–4.4 s, 该次耗时) ≈ 3.9 s
step: 19.92 → 16.0 s     端到端 1.24×
```

引入步数二阶效应（每多一个 step 多付 2 次 LLM 往返 ≈10.4 s + 1.5 次工具 ≈4.2 s ≈ 24.6 s）：
同样总任务，step 数减少 `3.9 / 24.6 ≈ 16%`，即**成本时间 −16%～−20%**。

**为什么不是数量级**：本机基线里 LLM 推理等待占 step 的 26%，而工具执行占 71%——工具时间看起来是最肥的靶子，但其中只有"进程启动"这 23.1%–27.5% 是 Rust 能零成本回收的；剩下的是真实命令执行（编译、测试、网络下载），换语言也不会变快。Amdahl：即使把**整个工具时间**归零，上限也只有 3.6×；现实可达区间是 1.15–1.25×。

**可证伪方式**：跑同一组多步任务，统计 (a) step 内 `pwsh` 调用占比；(b) LLM 等待占比。当前者低于 20% 或后者高于 50% 时，收益按比例缩小，本模型预测的 1.24× 不成立。

## 5. 发现并修复的缺陷

| # | 缺陷 | 影响 | 处置 |
|---|---|---|---|
| **D1** | 强杀 worker 时只监听 `'close'`，被 PowerShell 孙进程占住管道导致事件永不触发 | 下一次调用**空等 65 s** 超时后才报错，需第二次调用才恢复 | ✅ 已修：增加 `'exit'` 监听（立即拒绝在途请求并清槽）；worker 侧 `Drop for Shell` 正常退出回收壳；启动时后台清扫上一条 worker 留下的孤儿壳（只杀 >20 s 的，避免误杀自己的） |
| **D2** | 显示耗时只含壳内执行，冷启动 2327 ms 被显示成 395 ms | 会高估加速比 | ✅ 已修：`execute` 用 `performance.now()` 记端到端，输出 `[exit 0 · 32 ms wall · 8 ms shell · warm shell]` |
| **D3** | 单个 worker 被所有会话共享，任何 kill/挂起会阻塞全部会话（命令在 worker 内串行） | 隔离性风险 | ✅ 已在工具描述中声明；未改架构（与会话级 worker 池相比，共享能保住"一次冷启动"） |
| **D4** | `tools/telemetry*.py` 是累计/多会话口径，含 idle 间隙与 420 s 的异常 pwsh 样本 | 不能当作单次运行仪表 | ✅ 已知并标注：A/B 结论只采用同一会话内交错样本 |
| **D5** | 强杀 worker 会漏掉它的壳（PowerShell 孙进程，Windows 不杀进程树），每个被强杀的 worker 泄漏一个 ~77 MB 的常驻 powershell | 长时间/频繁超时会累积内存 | ✅ 已修：worker 启动时后台清扫"父进程已死"的壳（按父进程存活判断，天然不会误杀自己的壳；也覆盖旧版本遗留）；正常退出路径由 `Drop for Shell` 回收。实测：强杀后遗留的 3 个孤儿壳在下一次 worker 启动后全部消失，收尾检查 0 残留 |

D1 的修复已通过 `remove_bundle` + `install_bundle` 重新加载插件生效（两次操作均 `application: applied`）；复验见 §6。

## 6. 复验记录

| 项 | 结果 |
|---|---|
| worker 协议/行为测试 | 15/15 PASS（新二进制 518,656 B，构建 8.28 s） |
| 插件重新加载 | `remove_bundle` → `install_bundle` 均 applied；`dsh-rust-exec` 为符号链接指向 workspace 包 |
| **崩溃恢复（D1 复验）** | **PASS**。另开会话强杀 worker（pid 21648）后，**紧接着的调用未出现 65 s 空转**：`echo after-kill` 直接成功，`[exit 0 · 4242 ms wall · 417 ms shell]`，日志口径 4254 ms——该次调用当场拉起新 worker（15644）与新壳；随后 `echo recovered` 57 ms、`echo again` 47 ms，恢复热态。旧版本行为是"空等 65 s 报错 + 第二次调用才恢复"，已消除 |
| 冷/热分界 | 新 worker 的首次调用约 4.3 s（进程冷启动 + 壳冷启动），此后单次 33–282 ms；插件加载即预热，正常使用不会踩到冷启动 |
| **孤儿壳清理（D5 复验）** | **PASS**。复验时留有 3 个"父进程已死"的壳（17564 / 25396 / 6856，各 ~77 MB），新 worker 启动后全部消失；收尾检查 0 残留、0 孤儿 |
| 遗留告警 | `@michengai/dsh-skills-manager` 报 `duplicate exact route "/api/michengai/dsh-skills-manager/update"`——**与本次插件无关**，安装前就存在，属该第三方插件重复装载 |

## 7. P2 检索索引：同召回 token 降幅（2026-10-19 实测）

**为什么这比 P1 更重要**：基线里 `tool/result` 占上下文载荷 62.9%（约 145 万字符），其中单条 >20k 的巨型结果合计 33.9 万字符。上下文越大，每次 LLM 往返越慢——工具结果的 token 质量会直接变成模型时间。

**方法**（`node tools/p2_bench.mjs`，可一键重跑）：合成语料 400 个 TS 文件（每个 ~2.8 KB，含定义、注释、长函数体），8 个文本查询 + 3 个符号查询。**等召回口径**：baseline 是"今天代理必须付出"的成本——`rg -n` 的命中行 + 打开命中文件读全文（每个查询最多读 5 个文件，模拟真实代理的阅读上限）；plugin 侧是 `rust_search`/`rust_symbols` 一次调用返回的渲染结果，两者召回同一批命中。

| 查询 | 命中/实际 | 读文件 | baseline B | plugin B | 降幅 | 耗时 |
|---|---|---|---|---|---|---|
| `handle123` | 3/3 | 2 | 2992 | 733 | 76% | 203 ms |
| `helper77` | 3/3 | 2 | 2983 | 685 | 77% | 181 ms |
| `Service88` | 3/3 | 2 | 2956 | 653 | 78% | 204 ms |
| `MARKER_0` | 24/81 | 5 | 14259 | 2891 | 80% | 215 ms |
| `MARKER_3` | 24/81 | 5 | 14272 | 2915 | 80% | 266 ms |
| `pipeline step 7` | 24/401 | 5 | 15125 | 4577 | 70% | 246 ms |
| `timeoutMs` | 24/414 | 5 | 15331 | 2982 | 81% | 294 ms |
| `audit` | 24/803 | 5 | 14715 | 1936 | 87% | 228 ms |
| 符号 `Service88` | 1/1 | 1 | 2771 | 86 | 97% | 1 ms |
| 符号 `helper77` | 1/1 | 1 | 2798 | 110 | 96% | 1 ms |

**合计：88,202 B → 17,589 B，同召回下少 80%**（验收线 ≥30%）。另有 1,660 条命中被预算截断（`maxHits` 24 / `maxBytes` 6 KB 上限），这部分是 baseline 额外的读取成本，**未计入**上表，所以 80% 是保守值。

**会话内端到端**（本会话真实调用，非脚本）：
- `rust_search(query="fn search_text", glob="*.rs")` → `index.rs:496 [fn] pub fn search_text(...)` + 1 行上下文，**1/1 命中 · 4 ms**；
- `rust_symbols(path="src/index.rs", limit=12)` → 12 行结构大纲（struct/fn 名 + 行号），**12/35 symbols · 1 ms**；同样信息量下读全文约 25 KB。

**已知限制（不吹的部分）**：
1. 符号抽取是**正则启发式**，只认行首定义——`async handle123(...)` 这类**类方法不被索引**（基准表里 `handle123` 符号查询 0 命中），补一条方法规则需要重构 + 3 分钟重编译，未做。
2. 索引按目录白名单/黑名单过滤（跳过 `node_modules`、`_ref`、`target`、`.git` 等），深依赖树里的代码不在索引内。
3. 大仓首次建索引受 I/O 与 Defender 影响（665 文件冷缓存实测 2.4–35 s）；工作区规模下预热后构建 139–825 ms。
4. 单次返回上限 120 命中 / 60 KB，超过则显式报告截断条数——这是设计（省 token），不是缺陷。

P2.5（并发与资源治理）✅ 2026-10-19 18:30 完成并验收 10/10（见 §8）；P3（会话投影）、P6（监控面板）尚未实现，设计见 `SESSION_OPEN.md`、`CONCURRENCY_AND_METRICS.md`。

## 8. P2.5 并发与资源治理实测（2026-10-19 18:30）

### 8.1 交付

- **Rust worker**：`Lane` 池按**调用**租借（默认 `min(cores,4)`，`DSH_RUST_LANES` 可配 1–16；归还时保留 cwd/env）；排队闸门 `maxQueueDepth`（默认 64，超限 `QUEUE_FULL`）；规范化路径 keyed mutex（同文件写串行，守卫冲突 `VERSION_CONFLICT`）；`exec.abort` 用 `TerminateProcess` 杀该 lane 的 shell（不阻塞在 shell 锁上）；`caps()` / `exec.stats()` / `metrics.sample`。
- **`src/metrics.rs`**：零依赖 FFI 采样 —— psapi `GetProcessMemoryInfo`（WorkingSet/PrivateUsage）、kernel32 `GetProcessTimes`/`GetProcessIoCounters`/`GetProcessHandleCount`，加 `qps`/`peakQueued`/`rejected`/`inflight`/`indexFiles`/`indexSymbols`。
- **宿主插件**：`isConcurrencySafe: () => true`（否则 DSH 同一步内串行）；`exec.signal` abort → `exec.abort`；1 s 采样环形缓冲（fast 300 / slow 60）；`GET /api/dsh-rust-exec/metrics`、`POST /api/dsh-rust-exec/config`；`rust_health`（第 9 个工具）；`renderExec` 显示 `lane`/排队/墙钟。

### 8.2 离线验收（`node tools/concurrency_test.mjs 4` → **10/10 PASS**）

| 用例 | 结果 |
|---|---|
| C1 跨 cwd 隔离 | 3 并行 566 ms（串行 >1500 ms），cwd 各自正确 |
| C7 同会话同 step 3 路 | 3×500 ms 命令 566 ms 完成 —— **真并行** |
| T1 吞吐 | 4×300 ms：串行 1362 ms → 并发 343 ms = **×3.97** |
| C8 并发读写同文件 | 读到的长度只能是 64 或 5000（无半截文件） |
| C3 卡死隔离 | 超时 lane 报错，其余 p1/p2/p3 正常 |
| C2 同路径写冲突 | wins=1 / conflicts=1（版本守卫生效） |
| C9 并行中 abort 一个 | `abort` ack，仅该 lane 的 shell 被杀，另两个正常返回 |
| M1 资源采样 | rss=14.7 MB、cpuMs 增量、handles≈99、lanes=4 |
| M2 health | hostAlive=true、lastHostSeenMsAgo≈1、锁文件路径正确 |
| C4 8 并发压测 | 8/8 成功，peakQueued=4，maxWall 7.8 s（含冷启动） |

### 8.3 真实 DSH 会话内验证（本会话，同一 step 并发 3 个 `rust_exec`）

- 3 × `Start-Sleep -Milliseconds 900` 在同一 step 并发发出：**1189 / 1191 / 1193 ms**，分别落在 lane 0 / 1 / 2（串行需 >2.7 s）。
- `GET http://127.0.0.1:55983/api/dsh-rust-exec/metrics` 返回 `dsh-rust-exec/metrics@1`：23 个样本、`lanes:4`、`indexFiles:438`、`indexSymbols:1423`、`workingSetBytes≈14.9 MB`、`privateBytes≈11.7 MB`、`handles≈99`、`readBytes/writeBytes` 单调增量，`fast` 环形缓冲 300 格。
- 宿主 `listTools` 确认 9 个 rust 工具可见（`rust_exec/read/write/edit/stat/ls/search/symbols/health`），`rust_exec` 描述已包含 lane 池与排队语义。

### 8.4 已知限制（如实记录）

1. **冷启动昂贵**：N 个 lane 首次全部拉起 ≈ N×3 s（本机 PowerShell 5.1 + Defender）。预热在插件加载时后台做，预热未完成时的首批调用 `maxWall` 可达 7.8–12.4 s —— 这是冷启动抢跑，不是串行化 bug。
2. **采样粒度 1 s**：短于 1 s 的突发会被 `peakQueued` 抹平；`inflight` 在采样时刻为 1 属正常。
3. **默认单进程**：`maxWorkers` 默认 1（是隔离旋钮，不是吞吐旋钮——lane 池已把并发做到 ×3.97）；设为 >1 时按会话亲和挂多 worker（C6a/C6b 已验证热扩缩）；单 worker 崩溃影响全局，由 P1.5 自动重启 + 索引重建兜底。
4. **`exec.abort` 语义**是杀该 lane 的 shell 进程，命令的副作用不回滚。
5. **`ms` 口径**：`wall` 含排队 + RPC + 渲染，`shell` 是 PowerShell 自测的命令耗时；两者并列展示，不要混用。

### 8.5 S1 治理收尾（2026-10-20 12:30，`node tools/pool_test.mjs` → **10/10 PASS**）

补上了设计里承诺但 V1 未实现的 5 项治理。全部可热改（`POST /api/dsh-rust-exec/config`，非法值 400）：

| 项 | 实现 | 验收数字 |
|---|---|---|
| 多进程池 `maxWorkers` | `WorkerPool` 按会话亲和 + 轮转；`lanesPerWorker` 派生 | C6a 负载下扩到 2；C6b 热缩 2→1 立即退休空闲 worker（`applied={"maxWorkers":1,"lanesPerWorker":2}`） |
| 每会话在飞上限 + 公平轮转 | `maxInFlightPerSession`（默认=lanes），阻塞会话保持队首 | C7 小会话在 3/4 位置完成，未被大会话饿死 |
| `maxShells` 闸门 | 池级排队上限 | C8 超限拒绝 `WORKER_BUSY`，`rejected=7` 与 `stats.rejected` 一致 |
| RSS/CPU 软限动作 | 超软限先丢索引（可懒重建）→ 再暂停构建；**exec/fs 永不限** | S1 丢索引 439→0 文件；S2 `paused=true → resumed=false`；S3 暂停期间 `exec` 仍返回 `ok-while-paused` |
| 空闲 lane 回收 | 每 15 s 巡检，`idleReapMs`（默认 300 s，下限 10 s） | C6c 空闲 worker 被回收，池保持 1 |
| 采样正确性 | `metrics.sample` 字段嵌套（`memory.*`/`cpu.*`/`queue.*`） | C5 worker RSS vs OS 偏差 **0.08%**（阈值 ≤5%） |

设计文档 §2.3 的五条闸门至此全部落地；`caps()/features` 现报 `{abort, concurrentExec, idleLaneReclaim, index, indexSoftPause, laneLease, resourceMetrics}`。

## 8.6 S2 P6 监控面板（2026-10-20 12:50）

### 交付
- `packages/dsh-rust-exec/client.js`（零依赖，浏览器侧 Dynamic Client half）：`window.__ModuleLoader__.load({id, factory})` 形态，`inject: ['slots']`，注册到 **`settings.plugins.tab`**（`id: rust-exec`、`order: 20`、`label` 为随 `navigator.language` 切换的 thunk）。
  - 1 s 轮询 `GET /api/dsh-rust-exec/metrics`（8 s AbortController 兜底，出错只降级不清空旧数据）。
  - 统计卡：CPU（单核 %）、工作集/私有字节、队列深度/峰值、在飞请求、索引文件/符号/年龄、调用/拒绝/新建 worker。
  - 四条零依赖 SVG 曲线（CPU%、RSS MB、队列、在飞），取 `history.fast` 最近 120 点（≈2 分钟滑窗）。
  - Worker 表格（id/pid/在飞/lanes/retiring）+ 会话在飞分布。
  - 并发与限额表单（Workers 1–8、每会话在飞 1–64、空闲回收 ms、RSS 软限 MB、CPU 软限 %）→ `POST /api/dsh-rust-exec/config` 热生效并回显 `applied`。**这满足「设置里可配线程/任务并发数」**。
- `packages/dsh-rust-exec/package.json`：`exports["./client"]`、`dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-locale"] }`、`files` 增 `client.js`。未用 `immediately: true`：面板不需要早于 shell 加载，`slots.inject` 天然处理槽位晚声明。

### 验证（`node tools/panel_render_test.mjs` → **12/12 PASS**）
jsdom + React 18 真实挂载组件，走组件自己的轮询路径：`slots.inject(settings.plugins.tab)` → `slots.register {name,id:rust-exec,order:20}` 注册成功；loading 态、HTTP 500 错误态、live 数据态、空数据态逐项渲染；断言标题/CPU%/MB/索引数/4 条曲线（`<path>`）/5 个数字输入框齐全、**无 `NaN`/`undefined` 泄漏**；Apply 通过真实 `onClick` 触发 → 发出 `POST /api/dsh-rust-exec/config` 并回显 `applied {...}`。

### 如实记录的限制
- **需要刷新一次页面**才会出现新 tab：客户端模块清单在页面加载时拉取，安装插件不会热插进已打开的页面。代码侧槽位契约与渲染已用 jsdom 验证。
- Node 侧直接 `fetch` 该 metrics 路由会拿到 401（浏览器里带会话凭据），所以渲染测试里 live 失败时用**字段形状取自真实响应的 fallback payload**。
- 面板文案以英文为主、label 双语；未接客户端 locale 字典（避免动 `@deepseek-ai/dsh-client-locale` 命名空间注册面）。
- 曲线只画 `history.fast`（1 s）；`history.slow`（1 min × 60）已在数据面里但没有长窗口切换开关。

## 8.7 S3 P3 会话打开：投影服务与增量缓存（2026-10-20 13:10）

### 交付
- worker `packages/dsh-rust-worker/src/session.rs`（新增依赖只有 `ruzstd 0.9.1`，纯 Rust，本机无 C 编译器也能构建）
  - **自己实现 zstd 帧切分**：DSH 每次 append 写一个独立帧，`session.v4.jsonl.zstd` 是成千上万个帧的拼接；`StreamingDecoder` 只能吃单帧（`node:zlib` 同样只解首帧，本项目早期踩过这个坑）。按 zstd 帧头/块头规范解析帧边界（含 skippable frame），再逐帧解码。
  - **并行解码** `decode_frames`：帧列表切给 ≤8 线程，回日志顺序拼接；线程数可用 `DSH_RUST_DECODE_THREADS` 覆写做 A/B。
  - **投影缓存 v2**：`<DSH_HOME>/cache/rust-exec-sessions/<log>-<pathhash>.v2.json`，tmp + rename 原子写；缓存键是**路径**（不是 size/mtime），因为要复用旧快照做增量。
  - **三种打开模式**：`full` 冷建 / `append` 只解码 `compressedEnd` 之后的新帧并只 fold 新记录 / `warm` 直接加载快照分页。
  - 记录折叠：user / assistant（含工具名统计）/ tool（callId）/ system / reasoning → `{seq,t,turn,step,kind,name,chars,preview(180)}`，另统计 records / turns / steps / toolCalls / tools 直方图；坏行计入 `malformed` 而不中断。
  - 方法 `session.open` / `session.cache.stats` / `session.cache.drop`；`features`、`stableMethods`、`capabilities.sessionProjection=true` 同步。
- 插件第 10 个工具 `rust_session_open`（`packages/dsh-rust-exec/index.js`，`SESSION_TIMEOUT_MS=120_000`）：渲染每段耗时（read / decode / json / fold）与页信息，描述里写明"只读日志，真相源仍是 DSH"。

### 实测（`tools/session_probe.mjs`、`tools/session_append_test.mjs`）
| 场景 | 日志规模 | 结果 |
|---|---|---|
| 大会话冷建 | 4.24 MB 压缩（探测时；该会话仍在增长，现 4.47 MB）/ 15.05 MB 解压 / 2862 帧 / 4638 记录 / 1457 消息 | full **630 ms** = read 3.3 + decode 88.7 + json 387.4 + fold 121.6 |
| 同会话再打开 | 同上 | warm **30 ms**（cache load 11 ms） |
| 小会话冷建 | 0.52 MB / 563 记录 / 204 消息 | full **105 ms**（read 24 + decode 15 + json 38 + fold 8） |
| 小会话 warm | 同上 | **19.6 ms** |
| **append 增量** | 544 KB 快照 + 767 KB 追加 | mode=append，只解 **464/814 帧**，**208.7 ms**，fold 出 462 消息（原 204 + 新 258） |
| append 后再 warm | 1.31 MB | **7.3 ms** |

- 解码线程 A/B（15 MB 解压）：1 线程 **586 ms** → 8 线程 **100–160 ms**（≈4–5×）。
- 真实 DSH 会话内调用（另一个 agent 在同一宿主进程内执行 3 次 `rust_session_open`）：full **43.5 ms**（read 0.6 / decode 10.2 / json 22.1 / fold 7.2）；warm **1.5 ms**；cursor 页 **2.5 ms**。分页断言一致：`page [0..3) of 204 · 11057 chars · next=3`、`page [10..12) of 204 · 2742 chars · next=12`。

### 如实记录的限制（重要）
- **冷建比 DSH 现有 Node 路径慢**：按解压后字节折算，本服务约 **42 ms/MB**（15.05 MB→630 ms），Node（native zstd + `JSON.parse`）约 **10 ms/MB**（7.35 MB→115 ms 量级，见 `SESSION_OPEN.md`）。原因①`ruzstd` 纯 Rust 解码 ~60–100 MB/s，native zstd 200+ MB/s；②本机无 C 编译器，无法引入 `zstd` crate（需 cc/MinGW）。**收益不在冷建，在 warm / append**：会话反复打开与"只追加了几条"的实时刷新才是这条路径的价值。
- 冷建成本主项是 **serde_json DOM 解析**（387 ms，占 61%），不是解码。要压到 150 ms 量级需改成按需流式解析（自定义 visitor 只取文本长度与预览、不建 DOM），本轮未做，记在 S3 后续。
- 插件**不接管** DSH 会话真相源：只读日志、只缓存投影；停用插件即回到原路径，缓存可整体删除（`session.cache.drop`，`_bench` 下测试用独立目录）。
- 客户端首屏水合（T4）不在本项范围——那需要 P4 渲染接管或 DSH 侧虚拟化调优；本项交付的是后端可观测分段 + 可复用快照，不宣称 GUI 打开变快。
- 只覆盖 `session.v*.jsonl.zstd` 这一种物理格式。若 DSH 换成 `compression: 'none'` 或第三方 persistence 后端，服务会显式报错而不是静默返回空投影。

## 8.8 S4 P4 客户端渲染（叠加式，2026-10-20 13:30）

定位：原始需求是"会话渲染由插件控制"。S4 **降级为叠加式**——不替换 DSH 对话渲染，只在既有插槽里加一个只读投影卡片和一个状态徽标；槽位探测不到即止步（不破坏原渲染是硬约束）。

### 宿主侧新增（`packages/dsh-rust-exec/index.js`）
- `GET /api/dsh-rust-exec/sessions`：列出 `<DSH_HOME>/sessions/*/*/session*.jsonl.zstd`（每项 `{id, path, size, mtimeMs, workspace}`，按 mtime 倒序，上限 50）。根目录优先取 `DSH_RUST_SESSIONS_ROOT`，否则 `DSH_HOME/sessions`；`DSH_HOME` 缺省回落 `~/.dsh`。
- `GET /api/dsh-rust-exec/session?id=<id|path>&limit=&cursor=`：调 worker `session.open`，只回 `page`（不含 180 字符 preview 之外的正文）与 `timings`/`counts`/`total`/`nextCursor`。id 允许 `session-<uuid>` 或 `<uuid>`，找不到就按路径解析；**只接受 `.jsonl.zstd` 后缀**，防目录穿越。
- 两条路由都复用 `#withTimeout` 与现有池，写盘/删缓存动作不外露（`session.cache.drop` 仍只在工具侧）。

### 客户端（`packages/dsh-rust-exec/client.js`）
- 新增 `SessionProjectionCard`（`settings.plugins.tab` 面板内）：可开合，展开才拉列表；下拉选会话 → 首页 20 条；`Load more` 走 `nextCursor` 追加；顶部一行显示 `mode · total ms · decode · json · fold`、消息数与工具调用数；每行 `#seq kind t/step name chars preview`；明确标注"read-only · truth source stays in DSH"。
- 新增 `LaneBadge`：注册到 `conversation.input.dock`（`id: rust-exec-lanes`, `order: 30`），2 s 轮询 metrics，显示 `rust <inflight>/<lanes> · q<queued>`；独占色点（队列>0 黄、在飞>0 蓝、空闲绿）。**metrics 不可用时返回 `null`（不渲染任何东西）**，不占位、不报错。
- 两次注册放在各自的 `try/catch` 里：任一槽位不可用不影响另一个（DSH 未来改插槽名的降级路径）。

### 验证（`node tools/projection_render_test.mjs` → **15/15 PASS**，exit 0）
jsdom + React 18 真实挂载 `client.js` 的工厂产物，桩掉 `window.__ModuleLoader__` 与 `fetch`：
- 注册断言：`settings.plugins.tab#rust-exec` 与 `conversation.input.dock#rust-exec-lanes` 两条都在。
- 折叠态不拉会话列表；展开后拉 `/sessions` 并对首项拉 `/session`；两个会话选项、耗时行、首页行、计数渲染；`Load more` 触发带 `cursor=2` 的第二页并追加；到末尾后按钮隐藏。
- 徽标：metrics 不可用时渲染为空字符串；有数据时 `rust 0/4`。

### 实测（真实宿主，端口 55983）
- `GET /api/dsh-rust-exec/sessions` → 10 个会话（最大 4.47 MB）。
- `GET /api/dsh-rust-exec/session?id=<s3 小会话>&limit=3` → `timings.mode=full total=182.8 ms`、顶层 `total=1590`（消息数）、`page` 三条、`nextCursor=3`；再次请求 `mode=warm`。返回体字段：顶层 `{schema,path,size,mtimeMs,builtAtMs,counts,tools,total,cursor,nextCursor,page,pageChars,timings}`，`counts={records,steps,turns,toolCalls,malformed}`，`timings={mode,cacheHit,totalMs,readMs,decodeMs,parseMs,foldMs,totalFrames,deltaFrames,deltaMessages,cacheFile,cacheWrite}`，`page[i]={seq,t,turn,step,kind,name,chars,preview}`。
- 收尾复查（同一会话已继续增长到 4.89 MB）：首次 `mode=append` **35.0 ms**（只解码新增帧），`cursor=40` 的翻页 `mode=warm` **9.7 ms** —— 说明"日志只追加"这条路径确实被复用，而不是每次都全量重解。
- 浏览器侧需**刷新一次页面**才会看到新卡片/徽标（客户端模块在页面加载时拉取）。

### 如实记录的限制
- 这不是"接管渲染"：DSH 仍然是对话渲染的唯一实现，插件只读日志、只渲染投影；停用插件即消失。
- 投影卡片一次只 20 条/页，没有虚拟滚动；会话很大时靠 `Load more`，不做无限滚动（避免和主对话区抢滚动容器）。
- 徽标 2 s 一轮询、面板 1 s 一轮询，两条轮询互相独立；页面隐藏时不暂停（浏览器后台节流会自然降频）。
- 槽位名（`settings.plugins.tab`、`conversation.input.dock`）是 DSH 当前 ABI；已用 `try/catch` 包裹，改名即退化为不注册，不会白屏。

## 8.9 S6 P3 收尾：逐帧对账、解析重写与冷建目标（2026-10-20 18:20）

### 逐帧对账（结论：帧切分正确，解码字节账目有 bug 已修）
把最大的会话日志冻结成副本 `_bench/frozen-session.jsonl.zstd`（5,785,607 B，测量期间不再追加），用两套独立解码器对同一份字节：
| 指标 | Python `zstandard`（`decompressobj().unused_data` 求真实帧边界） | worker `session.debug.decode` |
|---|---|---|
| 压缩字节 | 5,785,607 | 5,785,607 |
| 帧数 | **3,737** | **3,737** |
| 解压字节 | **20,442,461** | **20,442,461** |
| 行数 | **6,054** | **6,054** |
| 前 5 帧区间 | `0-201:244 \| 201-355:269 \| 355-435:67 \| 435-533:94 \| 533-1185:935` | 完全一致 |
| 零字节帧 / 中位 / 最大 | 0 / 742 / 197,760 | 完全一致 |

- 结论：自写的 `split_frames`（帧头+块头走帧、含 skippable frame）**没有边界错误**。
- 同时定位并修掉一个真实 bug：`decodedBytes` 早前报 4.14 MB（真实 20.4 MB），是累计口径写错；修后与 Python 逐字节一致。
- 与之对照：`session.open` 里 `counts.records=6,054` 与 Python 行数一致 —— 说明解析也没丢记录。

### 解析重写（serde untagged → 单遍零拷贝 visitor）
- 根因：`#[serde(untagged)]` 会把每个 `content` 块先缓冲成中间 `Value` 树再二次反序列化，大日志上纯浪费。
- 改为 `#[serde(borrow)]` 的 `BlockStats<'a>` + 自定义 visitor，只取 `text` 长度、`name`、`kind`、`reasoning` 长度，不建 DOM。
- 效果（同一份 20.4 MB 解压文本）：`jsonParse` **1,236.8 ms → 132.4 ms（真实宿主调用）/ 267–330 ms（负载高的脚本口径）**，即 3.7–9.3×。
- 计划里的判据是"若对账修复后 parse 仍 >300 ms 就上字节级扫描器"；真实宿主口径 **132.4 ms < 300 ms**，因此**不启用**字节级扫描器（记为可选后续）。

### 解码线程 A/B（推翻上一轮的"并行 4–5×"结论）
同一冻结日志、同一二进制，仅改 `DSH_RUST_DECODE_THREADS`：
| 线程数 | decode | 说明 |
|---|---|---|
| 1 | **671 ms** | 33 MB/s，ruzstd 单线程实测 |
| 4 | 752 ms | 反而更慢：每线程各自分配 20 MB 级 `String`，分配器与 L3 抖动 |
| 8 | 844 ms | 更差 |

- 因此把**默认解码线程数改为 1**（`DSH_RUST_DECODE_THREADS` 仍可覆写做实验）。上一轮 §8.7 记的"8 线程 100–160 ms"是在只测帧解码、无 fold/parse 争用、机器空闲时得到的，不能外推到完整打开路径 —— 这里更正口径。

### 真实会话内端到端（本宿主，工具 `rust_session_open`）
| 调用 | 结果 |
|---|---|
| 冷建（首次，cache 已清） | **555.3 ms** = read 3.3 + decode 367.1 + json 132.4 + fold 21.8；1,895 消息 / 6,054 记录 / 974 工具调用 / 5.52 MB 日志 / 解压 20,442,461 B |
| 再打开（warm） | **15.6 ms**（另一次 17.4 ms） |
| `cursor=40&limit=2` 翻页 | **17.4 ms**，`page [40..42) of 1895 · 16126 chars · next=42` |
| 冷建（脚本口径，磁盘冷 + 机器忙） | 866–1,329 ms（read 8–137 / decode 413–620 / json 268–329 / fold 30–42） |

### 对"冷建 ≤150 ms"验收线的结论：**未达标（如实记录）**
- 实测冷建 **555 ms（最好，宿主内）～1.3 s（最差，磁盘冷+负载）**，距 150 ms 差 3.7–8.8×。
- 拆解显示**瓶颈是解码不是解析**：decode 占冷建 66%（367/555），而它是纯 Rust `ruzstd`（33 MB/s）；本机没有 C 编译器，无法改用 `zstd` crate（需 cc/MinGW），所以 20.4 MB 日志的解码下限就被钉在 ~600 ms（8 核并行也救不了，见上表）。
- 能达到的是 **warm / append / 分页 ≤20 ms**，以及解析比改前快 3.7–9.3×。
- 若要真正把"首次打开"压到 150 ms，可行路线（本轮未做，按实测收益排序）：
  1. **首页快速通道**：只解码"够填当前页"的前 N 帧（首页 50 条通常在前 1–3% 帧内），立即返回 `partial + nextCursor`，全量缓存后台继续建。这才是"打开快"的正解，且不依赖解码器。
  2. 插件加载时预热最近会话的缓存（把冷建挪到用户看不见的时候）。
  3. 字节级扫描器：只省 ~130 ms，单独做不解决问题。

## 8.10 S7 资源监控 UI：面板栏入口 + 仪表盘 + 对话区缩略行（2026-10-20 18:25）

### 需求与槽位选择
用户要求：用插件时"顶部栏加一个新选项：资源监控"，用仪表盘渲染 Rust 进程与系统监控数据（内存、CPU 及必要项）；或聊天框底部另起一行显示缩略信息。
客户端槽位实测（`Slots.listSubTree`）后选定两个 `replaceRisk: none` 的 list 槽，**不碰** `root` / `sidebar` / `main`（keyed 已被 `conversation` 占用）：
| 用途 | 槽位 | 语义 |
|---|---|---|
| 「资源监控」入口 + 浮层仪表盘 | `sidebar.panellist`（list，`{id,order,label}`） | "Global panel icons" —— 侧栏全局面板图标栏，最接近用户说的"顶部栏" |
| 对话区底部缩略一行 | `conversation.composer.dock`（list） | "Ambient entries below the composer card" |

### 实现（全部在 `packages/dsh-rust-exec/client.js`，零新依赖）
- `ResourceMonitorLauncher`：一个紧凑按钮（状态点 + "资源监控" + 当前 CPU%），点击开/关浮层；折叠时 5 s 轮询、展开时 1 s。
- `MonitorDashboard`：`position: fixed` 浮层（点遮罩或"关闭"退出），复用既有 `StatCard` / `Sparkline`：6 张数字卡（CPU 单核 % / 工作集+私有 / 句柄+IO / 队列+在飞+workers+lanes / 索引文件+符号 / 调用+拒绝）、4 条零依赖 SVG 曲线（CPU% / RSS MB / 队列 / 在飞，取 `history.fast` 最近 120 点）、worker 表（`#id · pid · inflight · lanes · active/retiring`）。
- `MetricsStrip`：对话输入框下方一行纯文本 `rust · CPU 12% · RSS 16 MB · 队列 2 · 在飞 2`（中英随 `navigator.language`），不触碰任何对话渲染节点。
- 两条注册各自 `try/catch`：槽位改名/缺失时只是不注册，插件其余功能不受影响。

### 验证（`node tools/monitor_render_test.mjs` → **15/15 PASS**，exit 0）
jsdom + React 18 真实挂载 `client.js` 产物、桩 `window.__ModuleLoader__` 与 `fetch`：
- 注册契约：`sidebar.panellist#rust-monitor` 与 `conversation.composer.dock#rust-metrics-strip` 都在，且都是叠加式 list 槽。
- 缩略行：`CPU 12%` / `RSS 16 MB` / `queue 2` / `inflight 2` 渲染正确；metrics 失败时保留最后一个样本、不出现 `NaN`/`undefined`。
- 仪表盘：点入口 → 标题、数字卡、**4 条 `<path>` 曲线**、worker 行（`pid 4321`、`lanes 4`）齐备；点"关闭"浮层消失。
- 全程无 `NaN`/`undefined` 泄漏。

### 部署与真机
- `remove_bundle dsh-rust-exec` → `install_bundle <packages/dsh-rust-exec>`：均 `application: applied`。
- 新 worker 二进制（2,202,112 B，sha256 前缀 `C90BF1F7E52E125A`）已部署到 `packages/dsh-rust-exec/bin/dsh-rust-worker.exe`，运行中进程路径即该文件。
- `GET /api/dsh-rust-exec/metrics` 实时：`running=true`、1 worker、4 lanes、RSS 13.2 MB。

### 如实记录的限制
- **需要刷新一次页面**才会出现新入口/缩略行（客户端模块在页面加载时拉取），这一点和 S2/S4 相同。
- "系统层"数据来自**本插件 worker 进程**（`psapi` 采样的 workingSet/private/CPU/句柄/IO）+ 宿主聚合（队列/在飞/workers）；**不是全机器 CPU/内存**，没接 OS 级采样。
- 浮层用 `z-index: 2147483000` 与半透明遮罩，属于"贴在自己层上"的实现；若 DSH 后续给 portal/overlay 槽位，应迁移到 `shell.overlay`（list，`replaceRisk: none`）以获得正确的层级与焦点语义。
- 入口样式继承侧栏图标栏，未接 DSH 的 icon 组件（避免依赖内部 UI 包）。

## 8.11 T1 首页快速通道：head 窗口解码 + 后台建全量缓存（2026-10-21 12:32）

原判据（RESUME 队列 T1）：**首页 `limit=50` 冷调用 ≤150 ms**（此前冷建 555 ms；2026-10-21 复测同日志全量 1069.4 ms）。

### 做法（`packages/dsh-rust-worker/src/session.rs`）
- 新增 `project_head(compressed, need)`：按 64 帧一批解码，**解到够填当前页就停**；返回已解帧数、`decodedBytes`、是否 `exhausted`。
- `open()` 冷路径默认走 head（`partial` 参数默认 true）；若解完全部帧还不够一页，则直接写缓存并回答 `partial:false`。
- 未解完 → `spawn_full_build()` 后台线程解全量并写快照；`building_set()` 去重，避免轮询堆叠多个构建。
- 响应新增 `partial` / `hasMore`；head 模式也返回 `nextCursor`，客户端「Load more」改看 `hasMore`；工具渲染显示 `head only, full build running in background` 与 `of ≥N`。
- 一致性：`full` 模式补 `totalFrames` 字段（此前只有 `frames`）。

### 实测（`node tools/head_open_test.mjs` → **ALL PASS**；日志 5.52 MB / 3737 帧 / 1895 消息）
| 场景 | server totalMs | 明细 |
|---|---|---|
| 冷首屏 `limit=50`（head） | **34.2 ms** | read 17.8 · decode 9.3 · json 3.6 · fold 0.8；只解 **128/3737 帧 = 0.72 MB / 19.50 MB（3.7%）** |
| 第二页（head，构建中） | 42.2 ms | 再解一批帧 |
| 后台构建完成后 warm | 30.3 ms（wall 49.5） | 全量 1895 消息、`partial:false` |
| 翻页 `cursor=40`（warm） | — | 10 条，total=1895 |
| `partial:false` 强制全量 | 1069.4 ms | decode 673.3 + json 239.9，3737/3737 帧 |

- 冷首屏 **34.2 ms vs 全量 1069.4 ms ≈ 31×**，达标线 150 ms 有约 4.4× 余量；代价是首屏 `total` 为"至少 N 条"。
- 真实 DSH 会话内（工具 `rust_session_open`，`refresh=true`）：`head · total 14.8 ms`；随后同日志 `warm (cache) · 11.3 ms · 1895 条`（后台构建已完成）。

### 如实记录的限制
- head 的 `counts`（records/turns/toolCalls）只统计已解窗口，warm 后才是全量；工具渲染用 `≥` 标记。
- 后台构建失败不会自动重试（下次冷调用重新触发）；同一 worker 内重复冷调用会重复解首批帧（未做内存级 head 缓存）。
- 只优化**首屏**；全量打开仍受 `ruzstd` 解码速度限制（见 §8.9）。

## 8.12 T2 真接管视图：按需全文 + 最小 markdown + 工具卡片折叠 + 窗口化渲染（2026-10-21 12:39）

### 交付
- **worker RPC `session.body`**（`packages/dsh-rust-worker/src/session.rs` 的 `bodies()`）：按 64 帧一批解码直到目标 `seq` 出现，逐行做廉价 `"seq":` 扫描，只对命中的行做 JSON 解析 → 返回 `blocks`（`text` / `reasoning` / `tool-call` 参数），总字符预算 `maxChars` 默认 40 000（clamp 1 000–400 000），`partial` 表示仍有未命中的 seq。
- **宿主路由** `GET /api/dsh-rust-exec/session/body?id=<sessionId>&seqs=1,2,3&maxChars=`（最多 40 个 seq；缺 `seqs` → 400）。
- **客户端 `conversation.view` 重写**：左列表 + 右详情面板；点击行按需拉全文；最小 markdown（`**bold**`、`` `code` ``、``` 围栏代码 ```、`- ` 列表）；`tool-call` 参数块默认折叠、点标题展开；**窗口化渲染**（固定行高 46 px + overscan 8，只把视口内的行挂到 DOM）。

### 实测
| 场景 | 结果 |
|---|---|
| worker 直连 `tools/body_probe.mjs`：`session.open`(head) → `session.body` 3 条 | open **18.4 ms**；body **15.5 ms**（read 5.6 / decode 8.7 / parse 0.3）；重复 15.6 ms |
| 不存在的 seq（`seqs=[9,100000]`） | 解完 **3737/3737 帧**、`found=1/2`、`partial:true`（语义正确，代价是全量解码） |
| 真机路由（端口 52686，会话 b42bdabf 6,727 KB / 2,288 条） | `/session?limit=3` mode=**append** **467.5 ms**；`/session/body?seqs=9,10,11` **24.2 ms 服务端 / 58 ms 墙体**，3/3 命中；缺参数 **400** |
| `node tools/projection_render_test.mjs` | **42/42 PASS**（原有 15 条 + 新增 27 条：全文请求、三类 markdown、tool-call 折叠/展开、详情时延、无 NaN、400 行页面只渲染 **18** 行 DOM） |
| `node tools/monitor_render_test.mjs` | 18/18 PASS（无回归） |

### 如实记录的限制
- 仍是**只读**视图：输入/发送仍在默认 `chat` 视图；`conversation.view` 需在 GUI 视图切换器里手动选中，且需刷新页面加载新 client。
- 详情每次点击都重新解码（未做 body 缓存）；小窗口下 15–25 ms 可接受，跨很远的 seq 会退化为全量解码。
- 窗口化用固定行高估算，超长行展开时会有轻微跳动；markdown 故意只支持三类语法（不引入依赖）。

## 9. 复现步骤

```powershell
# 1) Rust 工具链（已装）：D:\software\rust\{rustup,cargo}，环境变量 RUSTUP_HOME / CARGO_HOME
$env:RUSTUP_HOME='D:\software\rust\rustup'; $env:CARGO_HOME='D:\software\rust\cargo'
$env:Path="D:\software\rust\cargo\bin;"+$env:Path

# 2) 构建 worker（先结束占用 exe 的进程，Windows 会锁文件）
Get-Process dsh-rust-worker -ErrorAction SilentlyContinue | Stop-Process -Force
cargo build --release --manifest-path packages\dsh-rust-worker\Cargo.toml

# 3) 协议与基准
node tools\worker_test.mjs

# 4) 会话日志口径的端到端基线
python tools\telemetry4.py     # 需要 _tools\pyzstd
```

**注意**：替换二进制必须走 `remove_bundle` → `install_bundle`（或重启 DSH），否则运行中的宿主仍持有旧 JS 模块与旧 worker。

## §8.13 UI 反馈落地（2026-10-21 13:55）：更名 dsh-flash + 五条界面调整

需求来源：用户 m03664（附两张截图）——①「在飞」改「运行中」；②「rust」改「flash」，插件名称叫 dsh-flash；③输入框上面那一栏去掉；④资源监控弹窗标题改 dsh-flash、CPU 等改数字即可；⑤左侧菜单栏「资源监控」在前、「资源监控明细」在后。

| 改动 | 落点 | 说明 |
| --- | --- | --- |
| 更名 `dsh-flash` | `package.json.name`、`cordis.patch.yml`（`id: dsh-flash`）、`locale/{zh,en}.json`、面板标题、视图 label、strip 前缀 | **工具名与路由刻意不变**：`rust_exec`…`rust_session_open` 与 `/api/dsh-rust-exec/*`，避免破坏既有脚本与会话记录 |
| 去掉输入框上方一栏 | 删除 `conversation.input.dock` 注册与 `LaneBadge` 组件 | 输入区不再有插件行；composer 下方的纯文本缩略行（`conversation.composer.dock`）保留 |
| 「在飞」→「运行中」 | 宿主面板、浮窗、worker 行、strip | 英文侧 inflight → running |
| 浮窗标题 + 纯数字 | `MonitorDashboard` | 标题 `dsh-flash`；移除 4 条 SVG 折线（`svg path` 数 = 0），只留数字卡 |
| 面板栏两个有序入口 | `sidebar.panellist` | `dsh-flash-monitor`（资源监控，order **10**）在 `dsh-flash-monitor-detail`（资源监控明细，order **11**）之前；明细多 4 张卡：读/写字节、空闲回收、软限、峰值队列 |

**验收**：`tools/monitor_render_test.mjs` **ALL PASS**（含“纯数字无曲线”、双入口有序 10<11、明细 4 卡、无残留 `在飞/inflight` 文案）；`tools/projection_render_test.mjs` **ALL PASS**（含负向断言“无 `conversation.input.dock` 注册”、视图 label 为 `dsh-flash`）；`node --check` index.js/client.js 均 exit 0。
**部署**：`remove_bundle dsh-rust-exec` → `install_bundle <packages/dsh-rust-exec>` → `dsh-flash 1.2.0`、`application: applied`；真机 `GET /api/dsh-rust-exec/health` **200**，`routes.mounted` 7 条。
**限制**：客户端模块清单在页面加载时拉取 → **需要刷新一次页面**才看到新 UI；旧 bundle 名 `dsh-rust-exec` 已从 profile 移除。
### §8.13 补充（2026-10-21 14:10）：第二版 UI 反馈（侧栏入口取消 + 视图可拖动）

用户 m03756（附侧栏截图）：①插件名 dsh-flash；②截图里左侧栏的显示取消，放到 dsh-flash tab 页顶部；③视图第三列信息要缩略避免溢出重叠；④视图列表与明细可拖动，但明细保留 300 px 最低宽度。

| 改动 | 落点 |
| --- | --- |
| 侧栏两个入口取消 | 删除两条 `sidebar.panellist` 注册。**截图里「双份文字」的根因**：槽位自己会渲染 label，我们的按钮又渲染了一份，移出侧栏后自然消失 |
| 移到 dsh-flash tab 顶部 | `RustExecPanel` 顶部新增两个按钮：`资源监控`（概览）/ `资源监控明细`（多 4 卡：读/写字节、空闲回收、软限、峰值队列），点击开合同一浮层 |
| 曲线全部移除 | 浮窗与设置页各 4 条 `Sparkline` 均删（两处 `svg path` 计数 = 0），只留数字卡 |
| 第三列缩略 | 行内列改为固定宽 + `overflow:hidden/text-overflow:ellipsis`：`#seq 46px` / `kind 74px` / `name|t·s 62px` / `chars 50px` / preview `flex:1 minWidth:0`，不再与预览重叠 |
| 可拖动分栏 | 列表与明细之间新增 6 px 分隔条（`data-dsh-rust-split`，`cursor:col-resize`，`touch-action:none`），pointer 事件实时改 `flex` 比例；明细 `minWidth:300`（`data-dsh-rust-detail-min="300"`），列表下限 120 px |

**验收**：`tools/monitor_render_test.mjs` **ALL PASS**（21 项：tab 顶按钮、双模式卡、无曲线、无残留文案）；`tools/projection_render_test.mjs` **ALL PASS**（新增：分隔条存在、明细 300 px 下限、行内列 ellipsis、无 input.dock 注册）；`node --check` OK；`remove_bundle dsh-flash → install_bundle` 均 `applied`；真机 `/api/dsh-rust-exec/health` **200**（running、restarts 0、mounted 7）。
**限制**：与上一条相同——**需刷新一次页面**才会加载新客户端代码（`client.js` 在页面加载时取模块清单）。