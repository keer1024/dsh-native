# Rust 业务执行插件 —— 性能收益分析 · 架构设计 · 实施计划

> **v1.2.1 状态（2026-10-21）**：本文档保留历史阶段的设计与实测记录；与当前代码不一致处以下列为准：
> 包名已改为 `dsh-flash`（工具名 `rust_*`、路由前缀 `/api/dsh-rust-exec` 保持不变）；lane 徽标与全部 SVG
> 2026-10-22（1.4.0）：包名再次更名为 `dsh-native`；下文历史记录里的 `dsh-flash` 指同一插件。
> 曲线/图表已删除，资源监控改为设置页 `dsh-flash` 标签页顶部的「资源监控 / 资源监控明细」按钮 + 数字卡片；
> 路由共 7 条（metrics、health、events、sessions、session、session/body、config）；v1.2.1 修复重启失败
> （客户端注册 id 与包名不一致导致 web boot 失败）、锁文件误杀、kill 泄漏 PowerShell 孙进程、低完整性下
> shell server 无法启动。详见 `packages/dsh-rust-exec/CHANGELOG.md`。


> 分析日期：2026-10-16 · 目标机：Windows，8 逻辑核 / 16GB，DSH core `0.2.0-rc.2`
> 全部数字来自本机真实会话日志与现场基准测试，复现脚本见文末「附录 A」。

---

## 0. 结论摘要（TL;DR）

1. **本方案的现实端到端收益：工具密集型会话 ≈ 1.15–1.35×，纯对话型会话 ≈ 1.00–1.05×。**
   不是数量级提升。Amdahl 上限：即使把全部工具耗时压到 0，也只有约 **3.6×**（因为 26% 的时间是模型推理，与本地语言无关）。

2. **钱花在哪很清楚**：实测 5 个真实会话、288 个 step、435 次工具调用中，
   - 工具执行 **≈ 71%** 的 step 时间；
   - 其中 **23.1% 是纯进程启动开销**（`min(耗时, 壳启动基线)` 求和，下界）；
   - 模型等待 **≈ 26%**（均值 5.19s/step，p90 8.5s，max 46.1s；与输出规模强相关，见 §1.4）；
   - 框架/投影/持久化 **≈ 3.5%**。

3. **两个真正可回收的大头**：
   - **① 消除每次工具调用的进程启动**。本机 Windows PowerShell 5.1 冷启动实测 **3.3–4.9s/次**（`cmd /c` 40–90ms、`node -e` 145ms 作对照；`MsMpEng.exe` 常驻高 CPU，Defender 拖慢了进程创建）。262 次 `pwsh` 调用共 2637s，其中 **857s（32.5%）** 落在启动基线上；若每次调用都变成 ~20ms 的进程内操作，可回收 **≈ 852s**。
   - **② 压缩"工具返回"的 token**。实测**工具返回占全部上下文载荷的 62.9%**（1.45M 字符，其中 14.7% 来自单条 >20k 字符的返回）；模型耗时随输出规模上升（输出 >3000 字符的 step 均等待 **11.6s**，<500 字符仅 **1.8s**）。更聪明的检索（符号索引、精确区间、结构化摘要）能同时降低延迟与成本。

4. **必须说清的两个反证（否则方案会重复造轮子）**：
   - DSH 的 `grep`/`glob` **已经在用 Rust**：它 spawn 打包的 ripgrep（`@vscode/ripgrep`，见 `app.asar` 内 `@deepseek-ai/dsh-tool-fs-search/lib/index.js:11-20`）。搜索这条最热的本地路径已经是 Rust 在跑，插件在此处的增量只有"省一次 rg 进程启动"（几十~几百 ms）。
   - 启动开销的绝大部分，**不写一行 Rust 也能拿到**：装 PowerShell 7（DSH 的解析顺序本就优先 `pwsh.exe`，见 `@deepseek-ai/dsh-pwsh-local/lib/index.js:26-32`）或启用常驻 shell 插件。Rust 插件的护城河必须建立在 ripgrep 与常驻 shell 覆盖不到的地方（见 §3）。

5. **架构落点**：三层 —— 常驻 **Rust worker**（进程内文件/索引/执行/编解码）+ **宿主插件**（`ctx.rust` 服务、工具代理、会话投影）+ **客户端插件**（渲染视图模型）。**DSH 保留会话真相源（canonical log）**，Rust 侧持有**可丢弃、可重建的增量投影与渲染模型**——这样最坏情况下插件挂掉，DSH 依旧能完整回放会话。

---

## 1. 实测数据与方法

### 1.1 数据来源
本机 `C:\Users\keer_\.dsh\sessions\*\*\session.v4.jsonl.zstd`（5 个真实会话，含 2 个子代理会话）。日志为**多帧 zstd** JSONL，每帧一条记录；记录带 `seq` 与毫秒级 `time`，含 `step/start`、`assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/start|end` —— 足以做精确归因。

> 复现：`tools/session_probe.py`（解码 + 直方图）、`tools/telemetry.py`（工具耗时表）、`tools/telemetry2.py`（spawn 下界 + 上下文构成）、`tools/telemetry4.py`（模型等待分布与输出规模相关性）。

### 1.2 step 预算（288 step / 435 工具调用）

| 组成 | 合计 | 占比 | 均值 |
|---|---|---|---|
| step 总时长（`step/start`→`step/end`） | 5710s | 100% | 20.0s（p50 10.1s, max 762.9s） |
| 模型等待（`step/start`→`assistant/message`） | 1464s | 25.6% | 5.19s |
| 工具执行（`tool/call`→`tool/result`） | 4050s | 70.9%（工具可并行，故为上限口径） | 9.3s/次 |
| 框架/投影/持久化（残差） | ≈197s | ≈3.5% | — |

### 1.3 工具耗时明细（Top）

| 工具 | 次数 | 总耗时 | 均值 | 中位数 | 最大 | 说明 |
|---|---|---|---|---|---|---|
| `pwsh` | 262 | 2637.4s | 9.9s | 6.53s | 86.3s | 每次调用新起 `powershell.exe` |
| `ask_user_question` | 1 | 736.8s | — | — | — | 人工等待，不可优化 |
| `load_workspace_dependencies` | 1 | 460.2s | — | — | — | 首次运行时依赖探测 |
| `job_output` | 4 | 120.6s | — | — | — | 等待后台作业，本质是等待 |
| `cordis_inspect_query` | 5 | 40.2s | 8.0s | 10.0s | 10.1s | 客户端往返超时 |
| `grep`（ripgrep） | 23 | 34.0s | 1.48s | 0.92s | 4.84s | **已是 Rust** |
| `read` | 47 | 3.6s | 76.6ms | 53.0ms | 320ms | 进程内，已够快 |
| `write` | 11 | 1.1s | 102.6ms | 72.0ms | 320ms | 进程内（含版本守卫+原子写） |
| `edit` | 1 | 0.17s | 166ms | — | — | 进程内 |

**结论**：进程内工具（read/write/edit）已经是 50–170ms 量级，Rust 化只能省下个位数 ms；**唯一值得动的是"每次都要起进程"的那一类**。

### 1.4 模型等待的可信度校验
等待时长与输出规模单调相关 → 该字段确实是"流式结束时刻"，测量可信：

| 输出规模 | 样本 | 平均等待 |
|---|---|---|
| > 3000 字符 | 65 | **11.63s** |
| < 500 字符 | 27 | **1.76s** |

### 1.5 上下文载荷构成（决定 token 成本与后续步延迟）

| 内容 | 字符数 | 占比 |
|---|---|---|
| **工具返回** | 1,449,365 | **62.9%** |
| 　其中单条 >20k 字符 | 338,809 | 14.7% |
| assistant reasoning | 416,625 | 18.1% |
| assistant tool-call 参数 | 367,601 | 16.0% |
| system/developer prompt | 35,821 | 1.6% |
| user 消息 | 27,843 | 1.2% |
| assistant 正文 | 6,580 | 0.3% |
| **合计** | 2,303,835 | 100%（≈ 66 万 token） |

### 1.6 进程启动基线（现场基准，各 12–15 次）

| 启动目标 | 均值 | 备注 |
|---|---|---|
| `powershell.exe -NoProfile -NonInteractive -Command exit 0` | **3.3–4.9s** | DSH 在本机实际使用的壳（未装 pwsh 7） |
| `cmd /c exit 0` | 40–90ms | |
| `node -e 0` | 145ms | |
| `& Get-ChildItem`（壳内再执行一条命令） | 4.2s | 启动是主项 |

> 归因口径：`spawn_floor = Σ min(每次工具耗时, 3.7s)` = **935s**，占全部工具耗时 **23.1%**；仅 `pwsh` 一项 = **857s（32.5%）**。这是**下界**（长命令里启动占比被摊薄）。

---

## 2. 收益模型（Amdahl，逐项测算）

设本机工具密集会话基线：step 总时长 5710s = 模型 1464s + 工具 4050s + 框架 197s。

| # | 优化项 | 可回收时间 | 相对整体 | 是否必须用 Rust | 备注 |
|---|---|---|---|---|---|
| O1 | 消除 shell 进程启动（常驻执行器） | 857–935s | **15–16%** | ❌ 常驻 shell 即可 | Rust 侧可顺带把 fs 操作也做成进程内 |
| O2 | 工具返回 token 压缩 30%（索引+精确区间+结构化摘要） | 模型侧 1464s × ~15% ≈ 220s | ~4% | ✅ 需要索引/解析 | 同时省 ~19% 输入 token（成本） |
| O3 | grep 去掉 rg 进程启动 + 增量索引 | ≈34s 中约 8–12s | <0.3% | ⚠️ 已是 Rust | 增量索引另有 token 收益 |
| O4 | 进程内 read/write 换成 Rust | 3.6s+1.1s 中约 1–2s | <0.05% | ❌ | 不值得动 |
| O5 | 会话投影/框架开销（197s）增量化为 O(Δ) | 约 100–150s | 2–3% | ⚠️ 可 | 仅在超大会话显著；Rust 可把日志编解码+折叠一起做 |
| O6 | 客户端渲染（大会话虚拟化/预折叠视图） | 未测（浏览器侧） | 未知 | ✅ | DSH 现有 UI 不是瓶颈，收益在"体验"与大会话 |

**合计现实区间**：
- 工具密集（本机画像）：回收 15–25% → **1.18–1.33×**；叠加 token 压缩后 **1.25–1.40×**。
- 纯对话画像（工具占比 <10%）：**1.00–1.05×**。
- 理论天花板：**3.6×**（工具全免费）。

**成本侧**：输入 token 减少 15–20% 是确定的（工具返回占上下文 62.9%），这对长会话是复利——每一步的上下文都在为之前的工具输出付钱。

---

## 3. 反事实：不写 Rust 能拿到多少

| 替代手段 | 成本 | 预计回收 | 结论 |
|---|---|---|---|
| 安装 PowerShell 7（`pwsh.exe`） | 一次安装，约 100MB | 启动基线从 3.3–4.9s 降到 ~0.3–0.6s，回收 O1 的约 85% | **应先做**，作为对照基线 |
| 启用 DSH 常驻 shell 插件（`@deepseek-ai/dsh-*-persistent` 已在核心里） | 改配置 | 每次命令 ≈0 启动 | **应先做**，并把 Rust 方案的上限压低 |
| `ctx.subprocess` 复用 / 合并命令 | 低 | 中等 | 需要模型配合（少次多命令） |

**因此本插件的差异化护城河只能是**：
1. **结构化检索与索引**（tree-sitter 符号、依赖图、向量/SQLite FTS）→ 直接减少工具返回 token；
2. **一次调用做完整条业务链**（搜索→定位→读区间→打补丁→校验，过程中不把中间结果回灌上下文）；
3. **进程隔离与并发**：Rust 侧 thread pool，绝不阻塞 Node 主线程；崩溃不带走 DSH；
4. **会话投影/渲染模型**由常驻进程增量维护（O(Δ) 而非 O(n)），并直接供客户端订阅；
5. **编解码与压缩**（zstd 多帧、JSON 增量折叠、token 计数）在 Rust 侧一次完成。

---

## 4. 架构设计

### 4.1 分层与数据流

```
                    ┌──────────────────────── DSH host (Node, Cordis) ────────────────────────┐
  LLM ◄──► agent loop ── tool call ──►  rust-exec 宿主插件 (TypeScript)                      │
                    │                     ├─ ctx.rust  : 生命周期 + 帧协议 + 背压 + 超时        │
                    │                     ├─ tools     : fs.read/write/edit/apply_patch/search  │
                    │                     ├─ session   : 投影订阅（只读）+ 渲染视图模型           │
                    │                     └─ Remote    : 对客户端暴露流                          │
                    └──────────────────────────────┬──────────────────────────────────────────┘
                                                   │  length-prefixed JSON-RPC over stdio
                                                   │  (LSP 风格 framed，支持流式 notification)
                    ┌──────────────────────────────▼──────────────────────────────────────────┐
                    │  dsh-rust-worker (单个静态 exe, tokio)                                   │
                    │   fs: 读/写/原子落盘/版本守卫/patch/diff  |  index: tree-sitter+FTS       │
                    │   exec: 常驻 shell 池 (pwsh/bash) + PTY                  |  codec: zstd    │
                    │   session: 增量投影 + 渲染视图模型 + token 计数                           │
                    └─────────────────────────────────────────────────────────────────────────┘
                                                   ▲ Remote stream
                    ┌──────────────────────────────┴──────────────────────────────────────────┐
                    │  dsh-rust-client (浏览器插件): 占用会话/侧栏插槽渲染视图模型             │
                    └─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 协议
- **传输**：stdio + `Content-Length: N\r\n\r\n{json}` 帧（LSP 风格）。不引入网络端口，天然随宿主进程生命周期收敛。大 payload 走**单独二进制帧**（`Content-Length` + `Content-Type: application/octet-stream`）避免 base64 膨胀。
- **语义**：JSON-RPC 2.0；方法名 `fs/read`、`fs/write`、`fs/applyPatch`、`search/text`、`search/symbol`、`exec/run`、`session/open`、`session/fold`、`index/status`。
- **流式**：长操作用 `$/progress` 通知 + `$/cancel` 请求；宿主插件把流映射成 DSH 的流式工具输出与客户端 Remote stream。
- **版本协商**：`initialize` 返回 `{protocolVersion, capabilities}`；宿主插件按能力降级（老 worker 少几个工具）。

### 4.3 会话语义归属（关键设计决策）
- **DSH 仍是会话真相源**：`session.v4.jsonl.zstd` 由 DSH 的 persistence 后端写入，插件**不篡改**。
- **Rust 侧持有投影**：`session/open` 时一次性构建（zstd 多帧解码 + 增量折叠），之后按 seq 增量更新；产物包括：消息视图模型、token 计数、工具卡片聚合、diff/summary。**可随时丢盘重建**。
- **渲染控制**：客户端插件通过 Remote stream 订阅视图模型并渲染；DSH 内建渲染可保留为降级路径（视图模型缺失时回落）。
- 这样做的收益：超大会话的首屏/回放不再 O(n) 阻塞 Node 主线程；渲染所需数据一次成型，减少客户端 JS 计算与重复 IPC。

### 4.4 工具清单（按实测收益排序）
| 优先级 | 工具 | 替代 | 期望 |
|---|---|---|---|
| P1 | `rust_exec` | `pwsh`（262 次 / 2637s） | 常驻执行器，去掉 3.3–4.9s 启动；结构化返回 |
| P1 | `rust_search` | `grep`（ripgrep spawn） | 复用常驻索引，返回按相关度裁剪的片段（省 token） |
| P1 | `rust_read`/`rust_write`/`rust_edit` | 进程内 fs 工具 | 原子写+版本守卫由 Rust 统一实现；顺带消除 dsh 侧 O(n) 校验 |
| P2 | `rust_symbols` | 无（新增能力） | tree-sitter 提取定义/引用，替代"全文件读" |
| P2 | `rust_apply_patch` | 多次 edit | 一次调用完成多点编辑，减少往返与 token |
| P3 | `rust_session_view` | 客户端投影 | 渲染视图模型 + 增量流 |

### 4.5 目录布局（拟）

```
packages/
  dsh-rust-exec/            # 宿主插件（TS，cordis 插件）
    package.json            # dsh.bundle.patch -> cordis.patch.yml ; dsh.client -> ./lib/client.js
    cordis.patch.yml
    lib/index.js            # ctx.rust 服务 + 工具注册
    lib/client.js           # 客户端半（插槽渲染）
  dsh-rust-worker/          # Rust crate（bin）
    Cargo.toml              # 静态链接，单文件产物
    src/main.rs  src/rpc.rs  src/fs.rs  src/index.rs  src/exec.rs  src/session.rs  src/codec.rs
    tests/                  # 协议一致性 + fs 语义 + 性能回归
  rust-worker-bin/          # 预编译产物（按平台），供插件探测
tools/                      # 本次为分析写的脚本（probe/telemetry）
docs/rust-exec-plugin/      # 本文件与后续设计文档
```

### 4.6 对 DSH 未来版本变化的适配层（用户 18:20 要求）

DSH 还在 0.2.x-rc，插件契约（`ToolDefinition` 形状、宿主服务名、路由注册方式）都可能变。适配策略是**把 DSH 的接触面压到最小并集中一处**，而不是把 DSH 内部结构抄进插件：

| 风险 | 做法 | 位置 |
|---|---|---|
| 无法 import `@deepseek-ai/*`（插件目录只有 cosmokit/schemastery） | **零 import 原则**：只接收注入的 `ctx`，所有宿主能力以 `ctx.get(name)` / `ctx.name` 探测 | `index.js` 全局 |
| 宿主服务改名/换实现（`webServer`、未来的 `sessionProjections` 等） | **单一适配点** `#hostAdapter`：集中探测并产出 `capabilities` 表；能力缺失时**降级而非报错**（路由跳过并记录 `routes.skipped`，工具照常注册） | `index.js:1003-1024`、`1297` |
| `ToolDefinition` 字段增删 | 只用**最小公共子集**：`name`/`description`/`parameters`/`execute`/`output`/`isConcurrencySafe`；`isConcurrencySafe` 缺失时 DSH 会退化为串行 —— 行为正确，只是慢 | 每个工具定义 |
| 会话身份表示方式变化 | 只读 `exec.agent?.id`（`SessionId`）与字符串化后的 `exec.callId`；**不解析**内部结构，不做格式假设 | `index.js` 工具 `execute` |
| worker 协议演进 | `hello{protocol}` → `welcome{protocol,features}` 版本协商；未知方法返回 JSON-RPC `-32601`，老插件配新 worker 不会崩；`caps.features` 逐项声明（`concurrentExec`/`abort`/`resourceMetrics`…） | `main.rs` `dispatch`、`index.js` `#spawn` |
| 宿主升级后行为漂移 | **升级回归三件套**：`node tools/worker_test.mjs`（协议 15 项）+ `node tools/concurrency_test.mjs 4`（C1–C9、10 项）+ 真实会话里各调一次 `rust_exec`/`rust_search`/`rust_health`。三者全过才算兼容 | `tools/` |

版本可见性：`rust_health` 与 `metrics` 路由都带 `workerVersion`/`protocol`/`features`，面板或排障时可直接判断"插件与 worker 是否同一个版本代"。

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 收益被 PowerShell 7/常驻 shell 抢先吃掉 | 方案价值下降 | 先做 §3 对照实验；Rust 插件把重心放在 O2/O5/O6（token 与投影） |
| Windows 特有的 3.3s 启动不具普适性（Linux/macOS/mac 上 bash 启动 ~10ms） | 收益在别的平台蒸发 | 定位为"跨平台的 token/索引收益 + Windows 启动收益" |
| 客户端插槽替换脆弱（DSH 版本升级） | UI 破裂 | 视图模型 + 可降级；不替换核心 slot，优先叠加式插槽；锁定 core 版本 0.2.0-rc.2 |
| IPC 序列化大 payload 反而变慢 | 负优化 | 大结果走二进制帧/文件句柄传递；设阈值（>256KB 走文件 + 路径回传） |
| worker 崩溃 | 业务中断 | 宿主插件自动重启 + 请求重放（幂等方法白名单）；会话真相源不受影响 |
| 两套 fs 语义不一致（版本守卫、沙箱、换行/编码） | 数据损坏 | P1 阶段先做"语义一致性测试套件"，与 DSH `dsh-fs*` 行为对齐 |
| 本机没有 Rust 工具链 | 无法编译/验证 | 见 §7 待决问题 |

---

## 6. 实施计划

| 阶段 | 交付物 | 验收标准 | 写作用域 |
|---|---|---|---|
| **P0 基线固化**（0.5d） | 本文件的测量脚本 + 基线报告 | `tools/telemetry*.py` 可一键重跑；记录 pwsh7/常驻 shell 对照数据 | `tools/**`, `docs/**` |
| **P1 协议骨架**（2–3d） | Rust worker + 宿主插件 + 3 个工具（`read`/`write`/`exec`） | 在 DSH 中真实调用成功；worker 崩溃自动重启；协议一致性测试通过 | `packages/dsh-rust-worker/**`, `packages/dsh-rust-exec/lib/index.js` |
| **P2 检索与索引**（3–4d） | `search` + `symbols` + 增量索引 | vs ripgrep 基线：同等召回下返回 token 减少 ≥30%，端到端 step 时间不劣化 | `packages/dsh-rust-worker/src/index.rs`, `.../lib/index.js` |
| **P3 会话投影**（2–3d） | `session/open|fold` + 视图模型 | 10MB 会话日志首屏投影 < 300ms；Node 主线程阻塞 < 20ms | `packages/dsh-rust-worker/src/session.rs` |
| **P4 客户端渲染**（2–3d） | 客户端插件 + 插槽渲染 | 大会话滚动 60fps；DSH 内建渲染可降级 | `packages/dsh-rust-exec/lib/client.js` |
| **P5 基准与打包**（1–2d） | A/B 基准报告 + 安装脚本 + 预编译产物 | 固定任务集上给出 ≥15% 的 step 时间改善或 ≥15% token 改善，否则回退 | `bench/**`, `packages/**/dist/**` |

**执行纪律**：P1–P4 的写作用域互不重叠（宿主插件主文件在 P1 建好骨架后冻结接口，后续阶段只加方法）；每阶段末由 Lead 跑一次 `tools/telemetry*.py` + 端到端任务集，用同一口径对比，避免"感觉快了"。

### 6.1 执行状态（2026-10-20 12:30 更新）

| 阶段 | 状态 | 证据 |
|---|---|---|
| **P0 基线固化** | ✅ 完成 | `tools/telemetry*.py`、`tools/bench.mjs`、`tools/worker_test.mjs` 均可一键重跑 |
| **P1 协议骨架** | ✅ 完成并上线 | worker 15/15 测试通过；`dsh-rust-exec` 已 `install_bundle`，`fiberPhase: active`，6 个工具在真实会话中调用成功；worker 崩溃自动重启已验证（4.2 s）。P2 工具加入后共 8 个工具，已用宿主 `listTools` 确认可见 |
| **P1.5 伴生生命周期** | ✅ 完成并验收 10/10 | `tools/lifecycle_test.mjs`：强杀 worker → 9.5 s 自动恢复（新 pid，restarts=1）；强杀宿主 → worker 260 ms 内 exit(3)；陈旧实例锁 0 ms 回收；冻结宿主 20 s → 存活且无假重启。实现：hello 握手 + 双向心跳（2 s）+ 宿主 pid 看护（OpenProcess/WaitForSingleObject）+ 单实例锁 + 退避重启 |
| **P2 检索与索引** | ✅ 完成并验收（同召回 **-80%** token） | `rust_search`/`rust_symbols` 已在宿主 `listTools` 可见并在本会话真实调用成功（4 ms / 1 ms）。基准 `node tools/p2_bench.mjs`：400 文件语料、等召回口径 88,202 B → 17,589 B（-80%，验收线 ≥30%），详见 `RESULTS.md` §7。已知限制：正则启发式符号抽取不覆盖类方法 |
| **P2.5 并发与资源治理** | ✅ 完成并验收 **10/10**（2026-10-19 18:30） | lane 池按调用租借（默认 4，`DSH_RUST_LANES`）+ 排队闸门 + 路径 keyed mutex + `exec.abort`(TerminateProcess) + 1 s FFI 资源采样 + `GET /api/dsh-rust-exec/metrics` + `POST /api/dsh-rust-exec/config` + `rust_health`；宿主侧 `isConcurrencySafe:()=>true` 与 abort 接线。`node tools/concurrency_test.mjs 4` 10/10 PASS（C1 跨 cwd 隔离 566 ms、C7 同 step 3 并行 566 ms、T1 4×300 ms 串行 1362 ms → 并发 343 ms = **×3.97**、C9 abort 单 lane 不影响其余、M1 采样 14.7 MB/99 handles）；真实会话同 step 3 路并发 1189/1191/1193 ms（lane 0/1/2）。详见 `RESULTS.md` §8。限制：冷启动 N lane ≈ N×3 s |
| **S1 P2.5 治理收尾** | ✅ 完成并验收 **10/10**（2026-10-20 12:30） | `tools/pool_test.mjs`：C5 采样偏差 0.08%、C6a 负载扩容到 2、C6b 热缩 2→1、C6c 空闲 worker 回收、C7 小会话不被饿死（3/4 完成）、C8 超队 `WORKER_BUSY` rejected=7、S1 软限丢索引 439→0、S2 暂停/恢复构建、S3 暂停期间 exec 不受限。新增 `WorkerPool`/`maxInFlightPerSession`/公平轮转/`index.pause|resume|drop`/空闲 lane 回收；`GET|POST /api/dsh-rust-exec/config` 热生效（非法值 400）。详见 `RESULTS.md` §8.5 |
| **S3 P3 会话投影** | ✅ 完成并验收（2026-10-20 13:10） | worker `src/session.rs`：自实现 zstd 多帧切分（DSH 每 append 一帧）+ 并行解码（15 MB 586 ms→100–160 ms）+ 投影缓存 v2（`full`/`append`/`warm` 三模式，append 只解新帧）+ `session.open/cache.stats/cache.drop`；插件第 10 个工具 `rust_session_open` 已在本会话真实调用：full **43.5 ms**、warm **1.5 ms**、cursor 页 **2.5 ms**。**冷建比 Node 慢（42 vs 10 ms/MB，无 C 编译器不能用 zstd crate）**，收益在 warm/append（2.77 MB 会话 warm 30 ms、append 208 ms、再 warm 7.3 ms）。详见 `RESULTS.md` §8.7 |
| **P6 监控面板** | ✅ 完成（2026-10-20 12:50） | `packages/dsh-rust-exec/client.js` 注册到 `settings.plugins.tab`（id `rust-exec`, order 20）：1 s 轮询 metrics、4 条零依赖 SVG 曲线（CPU/RSS/队列/在飞）、worker 与会话在飞表格、5 项并发/限额表单 → `POST /config` 热生效。`node tools/panel_render_test.mjs` **12/12 PASS**（jsdom + React 18 真实挂载，含错误态/空态/无 NaN 泄漏/POST 回执）。唯一限制：已打开的页面需刷新一次才看到 tab。详见 `RESULTS.md` §8.6 |
| **P4 客户端渲染** | ✅ 降级完成（2026-10-20 13:30） | 叠加式：`settings.plugins.tab` 只读投影卡片（会话选择 + `Load more` 游标分页 + 四段耗时行）+ `conversation.input.dock` 的 lane 徽标；不替换 DSH 对话渲染，槽位用 `try/catch` 包裹，改 ABI 即退化不注册。`tools/projection_render_test.mjs` **15/15 PASS**；真实宿主 `/sessions` 列出 10 个会话、`/session` full 182.8 ms / warm 复开。详见 `RESULTS.md` §8.8 |
| **P5 基准与打包** | ✅ 完成（数据见 `RESULTS.md`） | 单次 shell 命令 4387 ms → 32 ms（137×）；端到端 1.15–1.25×，**未达 §6 表中"≥1.3×"的乐观档**，原因与证伪条件已写入 `RESULTS.md` §4 |

实现落点与本文 §4 的差异（实测后修正）：

1. **P1 只做了 `exec` + 原生 fs，没有先做"Node 参考 worker"** —— 工具链装好后直接上 Rust，省掉一轮返工。
2. **传输层用 loopback TCP 命令服务，不是 PTY**：PowerShell 5.1 在 stdin 被重定向时**不会执行也不会流式输出**（实测 5 种调用方式，进程常驻但零输出、零退出），所以常驻 shell 由一个监听 `127.0.0.1` 的 PowerShell 脚本提供，Rust worker 作为客户端转发命令。这样没有终端回显/ANSI 需要清洗，退出码与超时都确定。
3. **`fs.read` 没有做成"比内置 `read` 更快"**：1 MiB 读取实测 Node `fs` 8 ms vs worker `fs.read` 20 ms（JSON + 帧封装开销）。所以工具的定位是"配套能力 + 版本守卫"，性能主张只在 `exec` 和后续索引上，不吹 fs 工具。

---

### 6.2 剩余执行顺序（2026-10-20 09:10 定稿，12:00 起按序执行）

排序原则：先补齐已承诺的并发语义（便宜、解除验收阻塞）→ 再做用户点名要的资源可视化 → 再谈性能 → 最后动高风险渲染接管。
逐项细节、判据与环境坑见 `RESUME.md`「剩余计划（已排序）」。

| 序 | 任务 | 估时 | 关键判据 |
|---|---|---|---|
| **S1** ✅ 已完成（2026-10-20 12:30） | P2.5 治理收尾：`maxWorkers` 多进程池 + 空闲回收、每会话 `maxInFlightPerSession` + 公平轮转、`maxShells`、rss/cpu 软限动作、空闲 lane 回收 | 3–4 h | C5、C6 过 + `tools/concurrency_test.mjs` 回归全绿 |
| **S2** ✅ 已完成（2026-10-20 12:50） | P6 资源面板 + SVG 曲线 + 并发滑块（叠加式，不换对话渲染） | 3–5 h | `client.js` 12/12（`tools/panel_render_test.mjs`）；页面需刷新一次才出现 tab |
| **S3** ✅ 已完成（2026-10-20 13:10） | P3 会话打开四段埋点（T1–T4）→ 按瓶颈定向优化（L2 投影 / L3 首屏切片） | 4–6 h | 四段数字落盘 ✅（read/decode/json/fold 全部分段）；结论与判据相反但同样有效：**瓶颈不在后端**（真实会话 full 43.5 ms、warm 1.5 ms），首屏慢主要在水合 T4，故不再做 L1 帧索引（仅 >20 MB 会话有意义） |
| **S4** ✅ 已完成（2026-10-20 13:30） | P4 客户端渲染接管（**降级为叠加式**；槽位探测不到即止步于 S2） | 6–10 h | 投影卡片（`settings.plugins.tab`，会话选择 + 游标分页 + 四段耗时）+ 对话输入区 lane 徽标（`conversation.input.dock`），`tools/projection_render_test.mjs` **15/15**；真实宿主 `/sessions` 10 条、`/session` full 182.8 ms；原对话渲染零改动 |
| **S5** ✅ 已完成（2026-10-20 13:40） | 文档收尾 + 一页汇报 | 0.5 h | README 一页重写、`SLOT_PROBE.md` 新建、RESULTS §8.8 补齐、ANALYSIS §6.1/§6.2 与 RESUME 三处一致（10 个工具全列出） |
| **S6** ✅ 完成（2026-10-20 18:20，冷建目标未达标并如实记录） | 逐帧对账 + 解析重写：先加 `session.debug.decode` 与 Python 真实帧边界对账，再按结论改 `session.rs`（去 `serde(untagged)` 双遍缓冲，改零拷贝单遍 visitor） | 2–3 h | 对账：3737 帧 / 20,442,461 B / 6,054 行 **完全一致**（并修掉 `decodedBytes` 账目 bug 4.14 MB→20.44 MB）；解析 1236.8→132.4 ms（宿主口径，3.7–9.3×）；解码线程 A/B 推翻并行结论（1t 671 / 4t 752 / 8t 844 ms，默认改 1 线程）；冷建 555.3 ms（read 3.3/decode 367.1/json 132.4/fold 21.8）、warm 15.6 ms、翻页 17.4 ms。**≤150 ms 未达标**：瓶颈是纯 Rust `ruzstd` 33 MB/s，本机无 C 编译器；正解是"首页快速通道 + 后台建全量缓存"（未做，已记入 RESULTS §8.9） |
| **S7** ✅ 完成（2026-10-20 18:25，jsdom 15/15 + 真机 metrics 复核） | 面板栏「资源监控」入口 + 浮层仪表盘（RSS/CPU/句柄/IO/队列/在飞/索引/worker 表 + 4 条曲线）；**并且**对话区底部一行百分比缩略 `rust · CPU 12% · RSS 16 MB · 队列 2 · 在飞 2` | 2–4 h | 槽位实测选定 `sidebar.panellist`（list，`replaceRisk: none`）与 `conversation.composer.dock`（list，none），不碰 `root`/`sidebar`/`main`；`tools/monitor_render_test.mjs` **15/15 PASS**（注册契约、缩略行数值、无 NaN、失败降级、点击开合、4 条 SVG、worker 行、关闭复位）；`remove_bundle → install_bundle` applied；真机 `/metrics` running、1 worker / 4 lanes / RSS 13.2 MB。限制：需刷新页面；数据是**插件 worker 进程**而非全机器；未接 `shell.overlay`（未来可迁移） |

| **T0** ✅ 完成（2026-10-21 12:15） | 修监控面板 `HTTP 404`：根因是插件 `apply()` 早于 `webServer` 就绪时旧代码只 log 一次就永久放弃挂路由 | 0.5–1 h | 改为带退避的重试挂载（快速窗口 0/100/250/500/1000/2000 ms×4 + 15 s 慢重试永不停），`routeState`（attempts/mounted/errors/mountedAt）进 `rust_health` 与 `/health`；`tools/route_retry_test.mjs` **11/11 PASS**（webServer 晚 600 ms 出现仍 6 条全挂、attempts>1、dispose 卸载）；`remove_bundle → install_bundle` applied，真机 6/6 路由 200、`attempts=1` |
| **T1** ✅ 完成（2026-10-21 12:32） | 首页快速通道：`project_head()` 按 64 帧一批解码到够填当前页即停 → `partial/hasMore`，全量缓存后台线程建（`building_set()` 去重） | 1–2 h | `tools/head_open_test.mjs` **ALL PASS**：冷首屏 `limit=50` **34.2 ms**（read 17.8 / decode 9.3 / json 3.6 / fold 0.8，只解 128/3737 帧 = 0.72 MB / 19.50 MB）vs 强制全量 **1069.4 ms** ≈ **31×**；后台构建完成后 warm 30.3 ms、1895 条；真实 DSH 工具 `rust_session_open` head 14.8 ms → warm 11.3 ms。限制：head 的 counts/total 是"至少 N"，工具渲染用 `≥` 标记 |

| **T2** ✅ 完成（2026-10-21 12:39） | 真接管视图体验：worker 新增 `session.body`（按需全文，只解到目标 seq 出现的帧批）+ 宿主路由 `/session/body` + `conversation.view` 重写（按需全文、最小 markdown、tool-call 折叠、窗口化渲染） | 2–3 h | `tools/body_probe.mjs`：open(head) 18.4 ms → body 3 条 **15.5 ms**（read 5.6/decode 8.7/parse 0.3）；真机 `/session/body` **24.2 ms 服务端 / 58 ms 墙体**、3/3 命中、缺参 400；`tools/projection_render_test.mjs` **42/42 PASS**（新增 27 条含 markdown 三类、折叠、400 行只渲染 18 行 DOM）；`monitor_render_test` 18/18 无回归。限制：仍只读、未做 body 缓存、需在视图切换器手动选中 |

| **T3** ✅ 完成（2026-10-21 12:44） | 可分发包：版本号、`files` 校验、`npm pack` + 包内 exe sha256、CHANGELOG | 0.5 h | `package.json` bump **1.1.0** + `CHANGELOG.md` + `scripts.check`/`pack:check`（`CHANGELOG.md` 进 `files`）；`npm pack` → 9 文件、**1 019 760 B**、sha256 `CC2F923C9B3F1E6E…`；包内 exe sha256 `4C8867DD…`（2 254 336 B）与源**字节一致**；记录写入 `DISTRIBUTION.md` 顶部「最新打包记录」。未发布 registry、未签名、未交叉编译 |

当前进度：S1 ✅（12:30，10/10）、S2 ✅（12:50，12/12）、S3 ✅（13:10，端到端 43.5→1.5 ms）、S4 ✅（13:30，15/15）、S5 ✅（13:40）、**S6 ✅（18:20，逐帧对账一致 + 解析 3.7–9.3×，冷建 ≤150 ms 未达标并如实记录）**、**S7 ✅（18:25，监控入口 + 仪表盘 + 缩略行，15/15 PASS）**、**T0 ✅（10-21 12:15，监控 404 根因=路由早于 webServer 挂载被永久放弃；改退避重挂载 + routes 状态进 `rust_health`，11/11 PASS，真机 6/6 路由 200）**、**T1 ✅（10-21 12:32，首页 head 窗口：冷首屏 34.2 ms vs 全量 1069.4 ms ≈ 31×，ALL PASS，真机 head 14.8 / warm 11.3 ms）**、**T2 ✅（10-21 12:39，`session.body`+视图重写：全文按需拉取 15.5/24.2 ms、markdown/折叠/窗口化，42/42 PASS）**、**T3 ✅（10-21 12:44，包 1.1.0 + CHANGELOG，tarball 1 019 760 B / sha `CC2F923C…`，包内 exe 与源字节一致）**。只剩末尾 **T4（打磨）**，见 RESUME 队列表。

---

## 7. 待你确认的三件事（均已落定，保留作历史）

> 2026-10-19/20 状态：①Rust 工具链已装到 `D:\software\rust`；②范围选「性能优先」，P4 延后为 S4 且降级为叠加式；③对照组已实测（PowerShell 5.1 冷启动 3.1–4.9 s vs warm exec 38.6 ms），基线定在"日志口径 `tool/call`→`tool/result`"。


1. **Rust 工具链**：本机无 `cargo`/`rustc`。是否安装 rustup（≈1GB，改系统 PATH）？否则我会先交付源码 + 同协议 Node 参考 worker 做端到端验证。
2. **范围**：先做「性能优先」（P1–P2：执行器 + 检索索引，风险低、收益可测），还是同时做「渲染接管」（P4，收益偏体验、与 DSH 版本耦合）？
3. **对照组**：是否允许我先花 30 分钟装 PowerShell 7 / 启用常驻 shell，实测"零成本方案"能回收多少？这决定 Rust 插件的指标基线定在哪里。

---

## 附录 A：复现脚本

| 脚本 | 作用 |
|---|---|
| `tools/asar.mjs` | 只读列出/提取/读取 `app.asar` 内容 |
| `tools/asar_grep.mjs` | 在 asar 内按 路径正则 + 内容正则 搜索（用于确认 DSH 内部实现） |
| `tools/zstd_probe.mjs` | Node 侧单帧 zstd 探测（Node 的 `node:zlib` zstd 不跨帧，故改用 Python） |
| `tools/session_probe.py` | 多帧 zstd 解码 + 记录类型直方图 + 样本 |
| `tools/telemetry.py` | 工具耗时表、模型等待、框架残差 |
| `tools/telemetry2.py` | spawn 下界归因 + 上下文构成 + 最大工具返回 |
| `tools/telemetry3.py` | 上下文载荷分角色统计 + 模型等待总量 |
| `tools/telemetry4.py` | 模型等待分布 + 与输出规模的相关性校验 |

数据口径备注：`tool/call`→`tool/result` 的耗时包含 DSH 框架侧准备与结果后处理；`step/start`→`assistant/message` 包含上下文组装与流式生成。工具在同一 step 内可能并行，故工具耗时之和是**上限**口径，spawn 下界因此也是**下界**口径。
