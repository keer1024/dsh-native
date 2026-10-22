# 跨会话并发、资源治理与监控曲线（P2.5 / P6 设计稿，2026-10-19）

> **v1.2.1 状态（2026-10-21）**：本文档保留历史阶段的设计与实测记录；与当前代码不一致处以下列为准：
> 包名已改为 `dsh-flash`（工具名 `rust_*`、路由前缀 `/api/dsh-rust-exec` 保持不变）；lane 徽标与全部 SVG
> 2026-10-22（1.4.0）：包名再次更名为 `dsh-native`；下文历史记录里的 `dsh-flash` 指同一插件。
> 曲线/图表已删除，资源监控改为设置页 `dsh-flash` 标签页顶部的「资源监控 / 资源监控明细」按钮 + 数字卡片；
> 路由共 7 条（metrics、health、events、sessions、session、session/body、config）；v1.2.1 修复重启失败
> （客户端注册 id 与包名不一致导致 web boot 失败）、锁文件误杀、kill 泄漏 PowerShell 孙进程、低完整性下
> shell server 无法启动。详见 `packages/dsh-rust-exec/CHANGELOG.md`。


> 用户要求（15:58 + 16:00 澄清）：插件必须能**并发执行任务**，**同会话内多工具并行**与**跨会话并行**
> 都不得相互影响；DSH 与 Rust 两侧协同解决；插件设置里要有**线程数 / 任务并发数**；
> 要能**回显插件消耗的系统资源**，并给出**监控曲线**。
>
> 状态：设计待实现。顺序 P1.5（伴生生命周期）→ P2（检索验收）→ **P2.5（并发与资源治理，后端）** → **P6（面板与曲线，客户端）**。

## 1. 现状为什么不能并发

| 环节 | 现状 | 后果 |
| --- | --- | --- |
| worker 进程 | 全局单例 | 所有会话共用一条命令通道 |
| shell | `Arc<Mutex<Shell>>` 单例 + 全局互斥 | 同会话并行调用、跨会话调用**全部串行** |
| shell 的 cwd | 进程级全局状态 | A 的 `cd` 泄漏给 B；并行时交错执行会互相改 cwd |
| 工具调度 | `defineTool.isConcurrencySafe()` 已支持并行，但 exec 未声明安全 | DSH 把 exec 判为 exclusive，同一步内的多个 exec 被串行 |
| 索引 | 单实体索引 + 10 s TTL + 写后标脏 | 多会话同时写 → 频繁全量重建（CPU 尖峰） |

关键认识：**DSH 本身已经具备并行能力**（同一 assistant 消息里的多个工具调用按 `isConcurrencySafe` 并行、
多会话各有独立 agent loop），缺口在"我们这一侧是单例 + 全局状态"。所以 P2.5 是**拆单例 + 明确隔离边界**，
并让 DSH 侧的三项契约配合（见 §2.7），不是重写调度器。

## 2. 目标架构

```
DSH 进程（同会话 N 个并行工具调用 + 多会话）
  └─ dsh-rust-exec（宿主插件，单实例）
       ├─ WorkerPool：M 个 dsh-rust-worker.exe（M = maxWorkers，默认 min(4, max(1, cores/2))）
       │    └─ 每个 worker
       │         ├─ ShellLanes：**按调用租借**的常驻 PowerShell（借出→独占→归还），非按会话固定
       │         ├─ FsLocks：按规范化路径的 keyed mutex（同文件写串行，不交错）
       │         ├─ Index：每 worker 一份只读快照 + 增量标脏（Arc 快照，读无锁）
       │         └─ Governor：信号量（build=1 / inflight<=maxInFlightPerWorker / queue<=maxQueueDepth）
       └─ Scheduler：按会话的公平轮转队列 + 每会话配额
       └─ MetricsStore：1 s 采样环形缓冲（5 min 原始 + 1 h 降采样）+ 按会话计数器
```

### 2.1 shell 租约（lane）而不是会话分桶（关键决策）

初版设计想"每个 sessionId 一个 shell"，但那样**同会话内并行调用仍会串行**（一个会话只有一个桶），
不满足"同会话并发也不互相影响"。正确模型是**按调用租借**：

1. 每次 `exec` 调用 **独占**借出一个 shell（lane），命令在该 lane 内串行执行、调用结束归还；
   同一会话的并行调用会借到**不同 lane**，因此各命令的 cwd、临时变量、输出流互不干扰。
2. lane 归还时保留其 cwd/env；**同会话的顺序调用优先借回上次那个 lane**（亲和，保住热态与零冷启动），
   但如果它正被占用（并行场景）就借空闲 lane，**不加锁等待**——亲和是优化，不是约束。
3. 每次执行前显式设置 lane 的 `cwd`：取工具参数 `cwd`，缺省用该会话上次的 cwd（=上次归还的 lane 的 cwd），
   再缺省用工作区根。这样即使并行调用借到"别人的"lane，语义也是确定的。
4. lane 上限 `maxShells`（默认 `maxWorkers × 2`）：借不到就进该会话队列，超 `queueTimeoutMs` 返回 `BUSY`。
5. **取消即销毁**：调用被 DSH abort（`ToolExecutionInput.signal`）时，立即杀掉该 lane 的 PowerShell 进程并
   从池中移除（下次按需新起），避免挂起命令的输出在下一次借出时污染结果。这是"同会话并行"最容易出事的地方。

### 2.2 隔离与"相互不影响"的五条铁律

1. **cwd 隔离**：lane 独占 + 每调用显式 cwd（§2.1）；`cd` 只影响当前调用及其后续顺序调用。
2. **文件写隔离**：`fs.write`/`fs.edit` 在 Rust 侧对 canonical path 取 keyed mutex；配合已有的
   `expectedHash` 版本守卫（sha256 或字面量 `absent`）→ 同一文件并发写时，后来者拿到 `VERSION_CONFLICT`
   而不是交错写入。读取不加锁（原子 rename 保证读到完整旧版或完整新版）。
3. **索引隔离**：每 worker 一份索引，搜索读 `Arc` 快照（无锁）；写只标脏（原子 set），构建单闸门。
4. **失败隔离**：一个调用卡死只占住它自己的 lane；超时/abort → 杀 lane → 重启 lane，其他调用零影响。
5. **公平性**：跨会话不能出现"一个会话的 100 个调用饿死另一个会话"。调度器按会话轮转取队首，
   并限制 `maxInFlightPerSession`（默认 `maxInFlightPerWorker`），保证任何会话都能拿到执行机会。

### 2.3 并发闸门（防打死机器）

| 闸门 | 默认 | 超限行为 |
| --- | --- | --- |
| `maxWorkers` | `min(4, max(1, cores/2))` | 超出的会话进队列 |
| `maxShells` | `maxWorkers × 2` | 进会话队列，超时 `BUSY` |
| `maxInFlightPerWorker` | `max(2, cores/4)` | 排队 |
| `maxInFlightPerSession` | 同上 | 该会话排队（公平性） |
| `maxQueueDepth` | `64` | 立即返回结构化 `BUSY`（含 `retryAfterMs`） |
| 索引构建 | 全局 1 个（构建用 `maxIndexThreads`，默认 `cores/2`） | 已有构建则复用，不叠加 |
| `rssSoftLimitMb` | `512` | 超限先丢索引（可懒重建），再拒绝新索引构建 |
| `cpuSoftLimitPct` | `70` | 超限降 `maxIndexThreads` → 暂停索引构建（exec/fs 不限） |

### 2.4 资源回显（采样点与字段）

worker 自采样（每 1 s，随 `hb`/`pong` 上报，FFI 直连，不引依赖）：

- `GetProcessMemoryInfo(psapi)`：`WorkingSetSize`、`PrivateUsage`
- `GetProcessTimes(kernel32)`：user / kernel 累计 CPU（差值算 CPU%）
- `GetProcessIoCounters`：读/写字节数、读/写次数
- `GetProcessHandleCount`、线程数、`queueDepth`、`inflight`、`lanes`、`indexFiles`、`indexGen`、`uptimeMs`

宿主侧 `MetricsStore`：原始环形缓冲 1 s × 300（5 min）、降采样 1 min × 60（1 h）、
按会话聚合（调用数、排队等待 p50/p95、执行 p50/p95、读/写字节），
以及宿主自身 + 所有 worker + 所有 shell 子树的 pid 集合（按 pid 用 psapi 采样，1 s 一次，成本约 1 ms）。

### 2.5 对外接口

| 接口 | 形式 | 用途 |
| --- | --- | --- |
| `worker.health` | JSON-RPC（已有） | 单 worker 明细：重启次数、心跳间隔 p50/p99、lastExitCode、lanes |
| `GET /api/dsh-rust-exec/metrics?window=5m` | 宿主 `ctx.webServer.register(route)` | 曲线数据（series + 当前快照 + 配置） |
| `POST /api/dsh-rust-exec/config` | 同上 | 设置面板写配置（校验后热应用） |
| `rust_metrics`（可选工具） | `ctx.tools.register` | 让 agent 自己能看到资源状况（只读） |

### 2.6 客户端面板（P6，并入 P4）

- 插件形态同 `dsh-skills-manager`：`dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-locale"]`，
  `exports["./client"]` → `lib/client.js`（esbuild 打包，react 18 用宿主共享）。
- 槽位先用 `Slots.listSubTree` 探测；首选"设置页/侧栏面板"，**不替换对话渲染**（低风险）。
- 图表：手写 SVG sparkline/折线，零依赖；1 s 轮询 `/api/.../metrics`，30 s 滑动窗口。
- 面板内容：CPU%、RSS、队列深度、在飞请求、p50/p95 延迟、每会话并发条数、worker 列表
  （pid/uptime/restarts/心跳间隔/lanes），以及并发设置滑块（写入即热生效）。

### 2.7 DSH × Rust 分工（"同会话并发也不互相影响"的落点）

**DSH 侧必须配合的三项契约**（不改 DSH 核心，只改我们插件对契约的使用方式 + 少量 DSH 行为依赖）：

1. **声明可并行**：`defineTool.isConcurrencySafe()` 对 `rust_exec` 返回 `true`。上面 §2.1 的 lane 模型保证了
   并行安全；不声明的话 DSH 会把同一步内的多个 exec 串行，Rust 侧做得再好也没用。
2. **取消传播**：`execute(args, exec)` 里监听 `exec.signal`（`ToolExecutionInput.signal: AbortSignal`）。
   abort → 杀该调用独占的 lane（§2.1-5）→ 返回 `ABORTED` 语义的结构化错误。否则"用户打断"会留下挂起命令。
3. **身份与归属**：用 `exec.agent.id`（`Agent.id: SessionId`）做**配额与公平调度**的键、用
   `exec.callId`（`ToolCallId`）做 lane 租约与日志关联；`ToolRunContext` 的 `deferContext`/`concludeTurn`
   只在需要时用（本阶段不用）。

**Rust 侧负责**：lane 池与租借/销毁、路径锁与版本守卫、索引快照与标脏、并发闸门、资源采样、
协议层的请求间隔离（每条命令一个 TCP 连接、输出只属于本次调用）。

**两侧共同保证的语义**：
- 同会话并行：N 个 exec 各占 lane，cwd/输出/超时互不可见；
- 跨会话并行：由 WorkerPool + 每会话队列 + 公平轮转做隔离与公平；
- 冲突可检测：同文件并发写必有一个 `VERSION_CONFLICT`；同 cwd 下并发写由用户/模型显式串行或重试。

## 3. 配置项（插件设置里暴露）

```jsonc
{
  "maxWorkers": 4,               // 进程数上限
  "maxShells": 8,                // 常驻 shell(lane) 上限
  "maxInFlightPerWorker": 4,     // 每进程在飞请求
  "maxInFlightPerSession": 4,    // 每会话在飞请求（公平性）
  "maxQueueDepth": 64,           // 排队上限，超限返回 BUSY
  "queueTimeoutMs": 30000,       // 排队等待上限
  "maxIndexThreads": 4,          // 索引构建线程
  "indexTtlMs": 10000,           // 索引新鲜度
  "maxFileBytes": 1572864,       // 单文件索引上限（1.5 MiB）
  "rssSoftLimitMb": 512,
  "cpuSoftLimitPct": 70,
  "sampleIntervalMs": 1000,
  "metricsRetentionMs": 3600000,
  "uiRefreshMs": 1000,
  "heartbeat": { "intervalMs": 2000, "hostDeadMs": 10000, "workerDeadMs": 15000 }
}
```

落地方式（实现时验证一次即可）：优先 `Config = Schema`（profile 里有 `schemastery`，但 linked 包的模块解析需实测）；
不行则退化为 **JSON 配置文件 + 自带设置面板**（`<workspace>/.dsh-rust-exec.json`，热重载），对用户等价。

## 4. 验收（脚本化）

| # | 用例 | 期望 |
| --- | --- | --- |
| C1 | 3 个会话同时各跑 `Start-Sleep 2` | 总墙钟 ≈ 2–3 s（现状 ≈ 6 s+），三份日志 cwd 互不污染 |
| C2 | 两会话同时对同一文件 `rust_write`（同一 `expectedHash`） | 一个成功、一个 `VERSION_CONFLICT`，文件完整无交错 |
| C3 | 一个会话 exec 卡 30 s，另一会话跑 fs + exec | 后者全部正常返回（失败隔离） |
| C4 | 8 并发压测 60 s | RSS ≤ `rssSoftLimitMb`；队列满返回 `BUSY`；无 worker/lane 泄漏 |
| C5 | 监控曲线 vs psapi 实测 | CPU/RSS 偏差 ≤ 5%；1 s 刷新不断流 |
| C6 | 改设置（`maxWorkers` 4→2） | 热生效；后续会话落到 2 个 worker，空闲 worker 回收 |
| C7 | **同一会话同一步**发 3 个 exec（不同 cwd，各 `Start-Sleep 1`） | 墙钟 ≈ 1–1.5 s（而非 3 s）；三个 cwd 互不影响；输出不串 |
| C8 | 同一会话并行 2 个 exec，其一写文件、其一读同文件 | 读到的是完整旧版或完整新版（不出现半截） |
| C9 | 同一步并发 3 个 exec，中途 abort 其中一个 | 另两个正常完成；被 abort 的 lane 被销毁（`lanes` 数回落） |

## 5. 排期与风险

- **P2.5（后端并发+治理+metrics）**：估 4–5 h（比初版 +1 h：lane 租约、公平调度、abort 销毁、DSH 契约配合）。
  改动集中在 `main.rs`（ShellLanes/FsLocks/Governor/采样/abort）与 `index.js`（WorkerPool/Scheduler 公平队列/
  MetricsStore/HTTP 路由/`isConcurrencySafe`/`signal` 处理）。
- **P6（客户端面板+曲线）**：估 3–5 h。风险：槽位需探测、客户端 bundle 需 esbuild、HMR 只对
  `pnpm run dev:web` 生效 → 改完重装 bundle 并刷新页面验证。
- 风险与缓解：
  - 多 worker = 多份索引内存 → `rssSoftLimitMb` + 空闲 worker 回收（`idleReapMs`）兜底；
  - 每 lane 一个 PowerShell 进程（约 40–60 MB）→ `maxShells` + 空闲 lane 回收（5 min 无命令则退）；
  - abort 杀 PowerShell 会带来一次冷启动（PowerShell 5.1 冷启动 3.3–4.9 s，但只有在跑 GC 时）→
    lane 销毁是**异常路径**，恢复到稳态后 32 ms/命令；
  - 曲线数据放宿主内存 → 环形缓冲固定上限，不随会话数增长（每会话仅计数器）。
