# RESUME — dsh-flash（Rust 业务执行插件，2026-10-21 14:10 状态；S1–S7、T0–T3 收尾，T4 部分延期，两轮 UI 反馈已落地（更名 dsh-flash））

> **v1.2.1 状态（2026-10-21）**：本文档保留历史阶段的设计与实测记录；与当前代码不一致处以下列为准：
> 包名已改为 `dsh-flash`（工具名 `rust_*`、路由前缀 `/api/dsh-rust-exec` 保持不变）；lane 徽标与全部 SVG
> 2026-10-22（1.4.0）：包名再次更名为 `dsh-native`；下文历史记录里的 `dsh-flash` 指同一插件。
> 曲线/图表已删除，资源监控改为设置页 `dsh-flash` 标签页顶部的「资源监控 / 资源监控明细」按钮 + 数字卡片；
> 路由共 7 条（metrics、health、events、sessions、session、session/body、config）；v1.2.1 修复重启失败
> （客户端注册 id 与包名不一致导致 web boot 失败）、锁文件误杀、kill 泄漏 PowerShell 孙进程、低完整性下
> shell server 无法启动。详见 `packages/dsh-rust-exec/CHANGELOG.md`。

## 当前状态（v1.2.1，2026-10-21 晚）

- **重启失败已定位并修复**：`client.js` 用 `dsh-rust-exec` 注册，而包名是 `dsh-flash`；DSH 按包名给客户端模块建索引，
  注册 id 不匹配会让加载器回退重取同一脚本，第二次执行直接抛
  `client-modules: duplicate factory registration`，桌面端表现为 `web boot: 1 entry did not activate`。
  现注册 id 与包名一致，`tools/check_client_identity.mjs` 静态守住这条约束。
- **伴生进程治理**：锁文件先校验镜像再发信号（pid 复用不再误杀宿主/无关进程）；探测失败时保留锁而不是静默丢弃；
  低完整性进程写不了 `~/.dsh`，锁改由宿主在握手后写入、`kill` 时删除；`kill()` 先 `taskkill /T` 再拆管道
  （否则 worker 先退出、孙进程 PowerShell 永久占管道）。
- **低完整性沙箱适配**：shell server 脚本不再写 `%TEMP%`（拒绝访问 os error 5），改用 `-EncodedCommand`；
  孤儿清扫按 `-EncodedCommand` + 父进程已死识别。
- **验收**：`check_client_identity` 20/20、`reap_guard_test` 7/7、`lifecycle_test` 10/10、`worker_test` 15/15、
  `pool_test` 10/10、`sweep_test` 3/3、`route_retry_test` 全绿、面板/投影/监控/head 渲染全绿。
- **已知环境成本**：本机新起 `powershell.exe` 需 3–20 s（Defender + 模块首次使用，低完整性更慢）；插件在
  `apply()` 预热，所以这笔钱落在 DSH 启动期，而不是第一次工具调用。


## 12:00 起执行队列（用户 m03168，已建定时任务 `schedule-6b912873-ef90-4604-bf2a-8c8389e6803a`）

用户原文：「12点开始执行你的建议，按顺序执行。有bug，在12点以后请修改！」+ 截图 `Rust 资源监控 stopped / metrics unavailable: HTTP 404`。

| 序 | 任务 | 判据 |
|---|---|---|
| **T0** ✅ 完成（2026-10-21 12:15） | **修监控面板 HTTP 404**（P0，先做） | 根因=路由早于 `webServer` 就绪被永久放弃；已改退避重挂载，`rust_health` 新增 `routes{attempts,mounted,errors,mountedAt}`（注意字段名是 `mounted` 不是 `registered`）；`tools/route_retry_test.mjs` 11/11 PASS；真机 6/6 路由 200 |
| **T1** ✅ 完成（2026-10-21 12:32） | **首页快速通道**：`project_head()` 解到够填当前页即停 → `partial/hasMore`，全量缓存后台建 | 冷首屏 `limit=50` **34.2 ms**（判据 ≤150 ms）；vs 全量 1069.4 ms ≈ 31×；`tools/head_open_test.mjs` ALL PASS；真机 head 14.8 ms → warm 11.3 ms |
| **T2** ✅ 完成（2026-10-21 12:39） | **真接管渲染**：`conversation.view` 里做可用只读视图（完整文本 + 最小 markdown + 工具卡片折叠 + 虚拟滚动） | worker 新增 `session.body` RPC + 路由 `/session/body`；视图点击行按需拉全文、markdown 三类、tool-call 折叠、窗口化（400 行→18 行 DOM）；`projection_render_test` **42/42 PASS**；真机 body 24.2 ms / 58 ms 墙体。仍未做：写入/发送（只读）、body 缓存 |
| **T3** ✅ 完成（2026-10-21 12:44） | **可分发包**：版本号、files 校验、npm pack + 包内 exe sha256、CHANGELOG | 已 bump `1.1.0`、新增 `CHANGELOG.md` 与 `scripts.check`/`pack:check`；`npm pack` 产物 9 文件 / 1 019 760 B / sha256 `CC2F923C…`；包内 exe sha256 `4C8867DD…` 与源字节一致；记录写入 `DISTRIBUTION.md` 顶部。未发布 registry、未签名、未交叉编译 |
| **T4** ◐ 部分（2026-10-21 12:45 收口） | 打磨：`tool.call.toolview` 工具卡片 → `shell.overlay` 迁移 → locale 接线 → DSH 崩溃后 worker 残留验证 | ①④ 已可判定（见 T4 小节），②③ 延期；按剩余时间取前 2–3 项 |

### T0 现场事实（2026-10-21 09:44 采集，别重复采）
- 插件**是加载着的**：`Tool.listTools` 可见 10 个 `rust_*` 工具；worker 进程在跑 `packages/dsh-rust-exec/bin/dsh-rust-worker.exe`（pid 19904）。
- GUI 端口今天变了：55983（昨天）→ **52686**（今天）。端口每次重启都变，**以 runtime context 的 `DSH_WEB_URL` 为准**。
- 未认证请求 `/api/dsh-rust-exec/metrics`、`/api/dsh-rust-exec/nonexistent`、`/api/definitely-not-a-route-xyz` 在 52686 上**全部返回 401** → 401 是"未认证"统一出口，**不能**用来判断路由是否存在。
- 面板显示 **404**：浏览器带凭据，所以这是"已认证但路由不存在" → **routes 在当前宿主实例里没注册上**（tools 却注册了）。
- 头号嫌疑：`installRoutes()` 在 `apply()` 时 `ctx.webServer` 尚未就绪 / 能力探测失败，而代码是"失败只 warn 不抛"，于是静默 `routes.skipped`。
- 修法方向（未实施）：路由登记结果做成可观测（`routes.registered` / `routes.errors` 进 `rust_health`）+ webServer 晚就绪时带退避重试注册 + 客户端对 404 给可操作提示并 30 s 后重试一次。

## 一句话状态（截至 2026-10-20 18:30，S1–S7）

P1（常驻执行器 `rust_exec`）✅；P1.5（伴生生命周期 + 双向心跳）✅ 10/10 验收通过；
P2（Rust 索引 + `rust_search`/`rust_symbols`）✅ **同召回 token 降幅 80%**（验收线 ≥30%），已在真实会话内调用成功（4 ms / 1 ms）；
P2.5（lane 池并发 + 资源治理 + 埋点/路由）✅ **10/10 验收通过**，并发 ×3.97、真实会话同 step 3 路并行 1189/1191/1193 ms、metrics 路由已通；
S1（治理收尾：多进程池/每会话在飞/公平轮转/软限动作/空闲回收）✅ **10/10**；
S2（P6 监控面板：`settings.plugins.tab` 里 4 条 SVG 曲线 + worker 表 + 5 项并发/限额表单热生效）✅ **12/12**（`tools/panel_render_test.mjs`，jsdom 真实挂载）；
S3（P3 会话投影：zstd 多帧切分 + 并行解码 + `full`/`append`/`warm` 缓存 + 第 10 个工具 `rust_session_open`）✅ 已在真实 DSH 会话内验证 **full 43.5 ms / warm 1.5 ms / 翻页 2.5 ms**（冷建比 Node 慢，收益在 warm/append）。
S4（P4 客户端渲染，**叠加式**）：投影卡片（`settings.plugins.tab`，会话选择 + 游标分页 + 四段耗时）+ 对话输入区 `lane` 徽标（`conversation.input.dock`）✅ **15/15**（`tools/projection_render_test.mjs`），真实宿主 `/sessions` 10 条、`/session` full 182.8 ms；**未替换** DSH 对话渲染；页面需刷新一次。
S6（流式解析 / 冷建）：✅ **对账证明帧切分正确**（3737 帧 / 20,442,461 B / 6,054 行，与 Python 逐项一致），解析改零拷贝 visitor 后 **1236.8 → 132.4 ms（3.7–9.3×）**；冷建 **555.3 ms**（read 3.3/decode 367.1/json 132.4/fold 21.8）、warm **15.6 ms**、翻页 **17.4 ms**。**"≤150 ms" 目标未达标**（瓶颈是纯 Rust ruzstd 33 MB/s，本机无 C 编译器），正解是"首页快速通道 + 后台建全量缓存"，已记录未实施 → RESULTS §8.9。
S7（资源监控 UI）：✅ `sidebar.panellist` 里的「资源监控」入口 + 浮层仪表盘（6 张卡 + 4 条 SVG 曲线 + worker 表）+ `conversation.composer.dock` 一行缩略 `rust · CPU 12% · RSS 16 MB · 队列 2 · 在飞 2`，**15/15 PASS**（`tools/monitor_render_test.mjs`），已部署真机 → RESULTS §8.10。
S1–S7 全部收尾。剩余为可选后续（非阻塞）：首页快速通道（真正把首次打开压到 150 ms）、`shell.overlay` 迁移、P5 npm 打包发布。**客户端新入口/新视图需刷新页面一次才出现。**

### S6 结果（2026-10-20 18:20，已完成、目标未达标并如实记录）

- **对账（先做）**：冻结副本 `_bench/frozen-session.jsonl.zstd`（5,785,607 B），Python `zstandard` 的 `decompressobj().unused_data` 求真实帧边界，与 worker 新增 RPC `session.debug.decode` 逐项比对：**3,737 帧 / 20,442,461 解压字节 / 6,054 行 / 前 5 帧区间 / 中位 742 / 最大 197,760 全部一致，零字节帧 0** → `split_frames` 无边界错误。
- **那个 4.5× "未解之谜"是记账 bug**（不是解码 bug）：`decodedBytes` 早前用消息字符数累加，真实解压字节是 20.44 MB；已修，修后与 Python 逐字节一致。
- **解析重写**：`serde(untagged)` 会把每个 content 块缓冲成中间树再二次反序列化；改为 `#[serde(borrow)]` 的零拷贝单遍 visitor（只取 `text` 长度 / `name` / `kind` / `reasoning` 长度）后 **jsonParse 1236.8 → 132.4 ms**（宿主口径，3.7–9.3×；负载高的脚本口径 267–330 ms）。
- **解码线程 A/B 推翻上一轮"并行 4–5×"结论**：同一冻结日志 1 线程 **671 ms** / 4 线程 **752 ms** / 8 线程 **844 ms**（每线程各自分配 20 MB 级 String，分配器与缓存抖动）→ 默认改为 **1 线程**，`DSH_RUST_DECODE_THREADS` 仍可覆写。
- **端到端（真实宿主工具 `rust_session_open`）**：冷建 **555.3 ms**（read 3.3 / decode 367.1 / json 132.4 / fold 21.8，1,895 消息 / 6,054 记录 / 5.52 MB 日志）；warm **15.6–17.4 ms**；`cursor=40&limit=2` **17.4 ms**。
- **结论**：`≤150 ms` 未达标（差 3.7–8.8×），瓶颈是纯 Rust `ruzstd` 33 MB/s 的解码（占 66%），本机无 C 编译器无法换 `zstd` crate。可交付的是 warm/append/分页 ≤20 ms。正解（未做）：**首页快速通道**——只解码够填当前页的前 N 帧、立即返回 `partial+nextCursor`、全量缓存后台建；其次插件加载时预热最近会话。
- 测量陷阱：会话日志在被测时仍在实时追加，A/B 必须对冻结副本跑。
- 二进制：2,202,112 B，sha256 前缀 `C90BF1F7E52E125A`，已部署 `packages/dsh-rust-exec/bin/dsh-rust-worker.exe`。

### S7 结果（2026-10-20 18:25，已完成）

- 槽位（实测选定，均 `replaceRisk: none` 叠加式 list）：**`sidebar.panellist`** = "Global panel icons"（侧栏全局面板图标栏，最接近用户说的"顶部栏"）→ 放「资源监控」入口；**`conversation.composer.dock`** → 放对话区底部一行缩略。不碰 `root` / `sidebar` / `main`（keyed，已被 `conversation` 占用）。
- `client.js` 新增 `ResourceMonitorLauncher`（状态点 + "资源监控" + CPU%，点击开合）、`MonitorDashboard`（`position:fixed` 浮层：6 张数字卡、4 条零依赖 SVG 曲线、worker 表、关闭按钮）、`MetricsStrip`（`rust · CPU 12% · RSS 16 MB · 队列 2 · 在飞 2`，中英双语）。两条注册各自 `try/catch`，槽位变更时只降级。
- 验证 **15/15 PASS**（`tools/monitor_render_test.mjs`，jsdom + React 18 真实挂载 `client.js`）：注册契约、缩略行数值、失败降级无 NaN、点击开合、4 条 `<path>`、worker 行、关闭复位。
- 部署：`remove_bundle dsh-rust-exec` → `install_bundle <packages/dsh-rust-exec>`；真机 `GET /api/dsh-rust-exec/metrics` running、1 worker / 4 lanes / RSS 13.2 MB。
- 限制：需刷新页面；数据是**插件 worker 进程**（psapi）+ 宿主聚合，**不是全机器 CPU/内存**；浮层用 `position:fixed` + 高 `z-index`，未来有 portal 槽（`shell.overlay`）应迁移。

## 已落地的东西（都在工作区，不依赖会话记忆）

| 路径 | 内容 |
| --- | --- |
| `packages/dsh-rust-worker/` | Rust worker：Content-Length 帧 + JSON-RPC 2.0；`fs.*`、`exec`（lane 池 + loopback TCP 的常驻 PowerShell）、`index.status`/`search.text`/`search.symbol`、`session.open`/`session.cache.stats`/`session.cache.drop`、`caps`/`exec.abort`/`exec.stats`/`metrics.sample`/`hello`/`worker.health`/`index.pause|resume|drop`；生命周期（心跳灯 2 s、宿主 pid 看护、单实例锁、退出码 0/2/3/4）；`src/index.rs`（walker + 正则符号抽取 + TTL 10 s + 写后标脏 + 预热）、`src/session.rs`（zstd 多帧手写切分 + 并行解码 + v2 投影缓存 full/append/warm）、`src/metrics.rs`（零依赖 psapi/kernel32 FFI 采样） |
| `packages/dsh-rust-exec/` | DSH 宿主插件（零 import，仅用 `ctx.tools.register` + `ctx.webServer.register`）：**10 个工具** `rust_exec`/`rust_read`/`rust_write`/`rust_edit`/`rust_stat`/`rust_ls`/`rust_search`/`rust_symbols`/`rust_session_open`/`rust_health`；`WorkerPool`（会话亲和 + 公平轮转 + 热扩缩 + 空闲回收 + RSS/CPU 软限动作）；路由 `/api/dsh-rust-exec/{metrics,sessions,session,config}`；`client.js` 叠加面板 + 投影卡片 + lane 徽标 |
| `tools/p2_bench.mjs` | P2 验收基准：**等召回口径**——baseline = rg 命中行 + 读命中文件（最多 5 个），plugin = 一次 `rust_search`/`rust_symbols` 渲染结果；400 文件合成语料，实测 **-80%** |
| `tools/lifecycle_test.mjs` | P1.5 四用例：强杀 worker / 强杀宿主 / 陈旧实例锁 / 冻结宿主 20 s，10/10 PASS |
| `tools/concurrency_test.mjs` / `tools/pool_test.mjs` | 并发隔离 10/10；治理收尾 10/10（C5/C6a–c/C7/C8 + 软限 + 暂停恢复） |
| `tools/panel_render_test.mjs` / `tools/projection_render_test.mjs` | 客户端 jsdom 真实挂载：面板 12/12、投影卡片 + 徽标 15/15 |
| `tools/session_probe.mjs` / `tools/session_append_test.mjs` | 会话投影冷/热/分页与 append 增量实测 |
| `tools/index_probe.mjs` | 直连协议探针：`node tools/index_probe.mjs <cwd> <query> [symbol]` |
| `tools/telemetry*.py` | 会话日志口径的耗时/上下文构成统计 |
| `docs/rust-exec-plugin/RESULTS.md` | 各阶段实测与交付：§7 P2 −80%、§8 P2.5、§8.5 S1、§8.6 S2、§8.7 S3、§8.8 S4 |
| `docs/rust-exec-plugin/ANALYSIS_AND_PLAN.md` | 设计与收益模型；§6.1 执行状态、§6.2 剩余顺序、§4.6 DSH 适配层 |
| `docs/rust-exec-plugin/SLOT_PROBE.md` | 客户端插槽 ABI、升级后探测三步、代码里的降级行为 |

## 剩余计划（已排序，2026-10-20 12:00 起按序执行）

排序原则：**先补齐已承诺的并发语义（便宜）→ 再做用户点名要的资源可视化 → 再谈性能 → 最后动高风险渲染接管**。
每项做过即更新 `RESULTS.md` + `ANALYSIS_AND_PLAN.md` §6.1，并留下可复跑的验收命令。

| 序 | 任务 | 估时 | 依赖 | 做完的判据 |
| --- | --- | --- | --- | --- |
| S1 | P2.5 治理收尾 | 3–4 h | 无 | ✅ 10/10（2026-10-20 12:30） |
| S2 | P6 资源面板 + 曲线 | 3–5 h | S1 的 metrics 字段 | ✅ 12/12（2026-10-20 12:50，`tools/panel_render_test.mjs`；页面需刷新一次） |
| S3 | P3 会话打开四段埋点 → 定向优化 | 4–6 h | 无 | ✅ 2026-10-20 13:10：四段落盘（read/decode/json/fold），真实会话 full 43.5 ms / warm 1.5 ms；证明瓶颈在 T4，故不做 L1 帧索引 |
| S4 | P4 客户端渲染接管（叠加式，不换对话渲染） | 6–10 h | ✅ 2026-10-20 13:30（`tools/projection_render_test.mjs` 15/15；投影卡片 + lane 徽标；需刷新页面） |
| S5 | 文档收尾 + 汇报 | 0.5 h | ✅ 2026-10-20 13:40：README 一页重写、`SLOT_PROBE.md` 新建、RESULTS §8.8 与 ANALYSIS §6.1/§6.2 对齐、本文件同步 |
| S6 | 流式解析把冷建压到 ≤150 ms 量级（用户 m02662 ②） | 2–3 h | ✅ **已完成（18:20）**：对账一致（3737 帧/20.44 MB/6054 行），解析 1236.8→132.4 ms（3.7–9.3×），解码默认改单线程；冷建 555.3 ms **未达 ≤150 ms**（ruzstd 33 MB/s 是下限，无 C 编译器），正解"首页快速通道"已记录未做 → RESULTS §8.9 |
| S7 | 顶部栏「资源监控」仪表盘 + 对话区底部百分比缩略行（用户 m02904） | 2–4 h | ✅ **已完成（18:25）**：`sidebar.panellist` 入口 + 浮层仪表盘（6 卡 + 4 曲线 + worker 表）+ `conversation.composer.dock` 缩略行，`tools/monitor_render_test.mjs` **15/15**，已部署真机 → RESULTS §8.10 |

### S1 P2.5 治理收尾 —— ✅ 已完成（2026-10-20 12:30，`tools/pool_test.mjs` 10/10）

落地：`WorkerPool` 多进程池（会话亲和 + 轮转 + 热扩缩/退休）、每会话 `maxInFlightPerSession` + 公平轮转（阻塞会话保持队首，不被饿死）、池级 `maxShells` 排队上限、RSS/CPU 软限动作（先丢索引 → 再暂停构建，**exec/fs 永不限**）、空闲 worker 回收（15 s 巡检，`idleReapMs` 默认 300 s）、`index.pause|resume|drop` RPC。

验收：C5 采样偏差 0.08%、C6a 扩容到 2、C6b 热缩 2→1、C6c 空闲回收、C7 小会话 3/4、C8 `WORKER_BUSY` rejected=7、S1 丢索引 439→0、S2 暂停/恢复、S3 暂停期 exec 正常；回归 `node tools/concurrency_test.mjs 4` 10/10；`GET|POST /api/dsh-rust-exec/config` 热生效（非法值 400）。数字见 `RESULTS.md` §8.5。

### S2 P6 监控面板与曲线 —— ✅ 已完成（2026-10-20 12:50，`tools/panel_render_test.mjs` 12/12）

实际做法与下面预案的差异（以此为准）：`exports["./client"]` → **`client.js` 手写零依赖**（无 esbuild 步骤），
`dsh.client = {platform:"web", inject:[ui-slots, locale]}`，槽位用 `settings.plugins.tab`（list，id/order/label），
`inject:['slots']` + `ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({...}, Component))`。
面板已含 CPU/RSS/队列/在飞 4 条 SVG 曲线、worker 表、会话在飞、5 项限额表单→`POST /config` 热生效。
**已知限制：已打开的页面需刷新一次才出现 tab**（客户端模块清单在页面加载时拉取）。
验证脚本会真实挂载组件并断言注册、错误态、空态、曲线数量、无 NaN、POST 回执。详见 `RESULTS.md` §8.6。

<details><summary>原始预案（已被上面的实现取代）</summary>

`dsh.client` 插件（`exports["./client"]` → `lib/client.js`，esbuild 打包，react 18 用宿主共享）+
`Slots.listSubTree` 探测槽位（首选设置页/侧栏，**不替换对话渲染**）+ 零依赖 SVG sparkline。
数据面已就绪：`GET /api/dsh-rust-exec/metrics?window=5m`、`POST /api/dsh-rust-exec/config`、`rust_health`。
面板内容：CPU% / RSS / 队列深度 / 在飞 / p50-p95 延迟 / 每会话并发条数 / worker 列表（pid、uptime、restarts、心跳间隔、lanes）/ 并发滑块。
改完必须 `plugin_manager remove_bundle` → `install_bundle` → 刷新页面验证（HMR 只在 `pnpm run dev:web` 时生效）。

</details>

### S3 P3 会话投影 —— ✅ 已完成（2026-10-20 13:10）

交付 `packages/dsh-rust-worker/src/session.rs`：自实现 zstd 多帧切分（DSH 每次 append 一帧，`StreamingDecoder` 只解首帧）+ 并行解码（15 MB 586→100–160 ms）+ 投影缓存 v2（`full`/`append`/`warm`）+ `session.open|cache.stats|cache.drop`，插件第 10 个工具 `rust_session_open`。
实测：真实会话 full **43.5 ms**（read 0.6 / decode 10.2 / json 22.1 / fold 7.2）、warm **1.5 ms**、翻页 **2.5 ms**；2.77 MB 大会话 cold 630 ms / warm 30 ms / append 208 ms（只解 464/814 帧）/ 再 warm 7.3 ms。
**结论**：后端不是首屏瓶颈（T4 客户端水合才是），故**不做** L1 帧索引；冷建按解压字节算比 Node 慢（42 vs 10 ms/MB，本机无 C 编译器不能用 zstd crate），价值在 warm/append。**不接管真相源**（只读日志 + 可丢弃缓存）。详见 `RESULTS.md` §8.7。

### S4 P4 客户端渲染（叠加式）—— ✅ 已完成（2026-10-20 13:30，`tools/projection_render_test.mjs` 15/15）

宿主两条只读路由：`GET /api/dsh-rust-exec/sessions`（列 `<DSH_HOME>/sessions/*/*/session*.jsonl.zstd`，≤50 条按 mtime 倒序）、
`GET /api/dsh-rust-exec/session?id=&limit=&cursor=`（转发 worker `session.open`，只回 page/timings/counts/total/nextCursor；仅接受 `.jsonl.zstd`，防目录穿越）。
客户端 `client.js`：
- `SessionProjectionCard` 挂 `settings.plugins.tab`——展开才拉列表 → 首页 20 条 → `Load more` 走 nextCursor 追加 → 顶部 `mode · total/decode/json/fold` 行 + 消息数/工具调用数 → 明确标注 read-only、真相源在 DSH。
- `LaneBadge` 挂 `conversation.input.dock`——2 s 轮询，显示 `rust <inflight>/<lanes> · q<queued>`，色点随状态变化；**metrics 不可用时返回 null**（不占位、不报错）。
两个 `slots.inject` 各自 `try/catch`：任一插槽改名/缺失只退化为不注册，不影响另一个、不影响对话渲染。
实测（真实宿主 55983）：`/sessions` 10 条（最大 4.47 MB）、`/session` full **182.8 ms** / warm 复开。数字见 `RESULTS.md` §8.8，ABI 与降级见 `SLOT_PROBE.md`。

### S5 文档收尾 + 汇报 —— ✅ 已完成（2026-10-20 13:40）

`README.md` 重写为一页（10 个工具 + 三条只读路由 + 热配置、S1–S4 验收数字、一条命令复现）；
新建 `SLOT_PROBE.md`（插槽 ABI、升级后探测三步、降级行为）；`RESULTS.md` 补 §8.8；
`ANALYSIS_AND_PLAN.md` §6.1 P4 行、§6.2 S1–S5 行全部改为 ✅；本文件「已落地的东西」表同步到 10 个工具与全部验收脚本。

## 环境与坑（务必遵守）

- 构建：先 `Get-Process dsh-rust-worker | Stop-Process`（exe 被占用会链接失败），再
  `$env:RUSTUP_HOME='D:\software\rust\rustup'; $env:CARGO_HOME='D:\software\rust\cargo'; $env:Path="D:\software\rust\cargo\bin;"+$env:Path; cargo build --release --manifest-path packages\dsh-rust-worker\Cargo.toml`
  （带 `lto` + `codegen-units=1`：冷构建约 3 分钟，不要频繁触发）。
- 插件 JS 改完必须 `plugin_manager remove_bundle dsh-rust-exec` → `install_bundle <绝对路径>` 才会重载。
- 本会话 shell 的 `powershell.exe` 是 5.1：**`Set-Content` 默认 ANSI，会写坏 UTF-8 中文**；写文件用工具或 `[IO.File]::WriteAllText(..., UTF8Encoding($false))`。
- 语料/索引：`DSH_RUST_INDEX_ROOT` 可覆盖索引根目录（探针脚本用它切语料）。
- 大仓建索引受 Defender 影响（665 文件冷缓存实测 2.4–35 s）；基准别直接用 12k 文件的 pnpm store。
- 不要动 `C:\Users\keer_\.dsh` 下的会话日志与已装插件；不要改系统级 PATH。

---

## T4 判定（2026-10-21 12:45，T0–T3 收口后）

| 子项 | 判定 | 依据 / 原因 |
| --- | --- | --- |
| ① `tool.call.toolview` 工具卡片 | **延期** | 契约已定位：`_ref/ui-tool/.../dsh-client-ui-tool/lib/client.js:2422` 注册形态 `{name:"tool.call.toolview", key:"<wire 工具名>", inject?}`，命中即替换通用行；组件收到的 `call` 形状为 `{phase, block}`，`call.block.call?.name`（:1932）、`toolRowModel(toolName, block, cwd, home)`（:307）——但 `block.input/output` 字段名未在源码中确认，盲写卡片有把 `rust_*` 工具行渲染成空白的风险，需真机 DOM 验证后再做。 |
| ② `shell.overlay` 迁移 | **延期** | 纯叠层位置迁移（`sidebar.panellist` 按钮 + `position:fixed` 浮层已可用），无功能收益，且新槽需真机眼验，优先级最低。 |
| ③ locale 接线 | **延期** | client 已按 `navigator.language` 双语，`locale/{en,zh}.json` 目前只做包内声明；客户端 `locale` 服务的取值 API 未核实，改动收益仅为“跟随 DSH 语言开关”。 |
| ④ DSH 崩溃后 worker 残留验证 | **已覆盖，无需重复** | P1.5 用例已验：宿主进程被强杀后 worker **260 ms** 自退（`tools/lifecycle_test.mjs`，靠 `OpenProcess`+`WaitForSingleObject` 看护 `DSH_RUST_HOST_PID`，与“DSH 崩溃”同机制）。 |

**结论**：T0–T3 全部完成并上线；T4 剩 ①②③ 三项均为“需真机眼验/低收益”的打磨项，不做“设计当实现”的表述。