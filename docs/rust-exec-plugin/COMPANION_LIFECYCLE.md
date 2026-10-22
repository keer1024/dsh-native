# 伴生进程生命周期与双向心跳（P1.5 设计稿，2026-10-19）

> **v1.2.1 状态（2026-10-21）**：本文档保留历史阶段的设计与实测记录；与当前代码不一致处以下列为准：
> 包名已改为 `dsh-flash`（工具名 `rust_*`、路由前缀 `/api/dsh-rust-exec` 保持不变）；lane 徽标与全部 SVG
> 2026-10-22（1.4.0）：包名再次更名为 `dsh-native`；下文历史记录里的 `dsh-flash` 指同一插件。
> 曲线/图表已删除，资源监控改为设置页 `dsh-flash` 标签页顶部的「资源监控 / 资源监控明细」按钮 + 数字卡片；
> 路由共 7 条（metrics、health、events、sessions、session、session/body、config）；v1.2.1 修复重启失败
> （客户端注册 id 与包名不一致导致 web boot 失败）、锁文件误杀、kill 泄漏 PowerShell 孙进程、低完整性下
> shell server 无法启动。详见 `packages/dsh-rust-exec/CHANGELOG.md`。


> 用户要求：Rust 进程作为 **常驻伴生进程**，生命周期与 DSH 绑定（DSH 停止则 Rust 进程必须停止），
> 二者之间需要 **相互的、抗抖动** 的心跳。本文是把该要求落成可实现的协议与验收清单。
>
> 状态：设计已确认，**待实现**（排在 18:00 恢复后的第一项，先于 P2 基准排查）。

## 1. 现状与目标

已实现：
- worker 由 `packages/dsh-rust-exec/index.js` 的 `apply` 懒启动；`dispose` 时优雅停、3 s 后强杀；
- worker 主循环读 stdin，读到 EOF 即退出（内核级硬保证）；
- 强杀 worker 后，下一次调用 4.2 s 内自动重启（已验证）。

缺口：
- **没有心跳** —— 判定"对方死了"只能靠"下一次调用失败"；
- **没有宿主 pid 看护** —— 若 stdin 写端被孙进程继承导致 EOF 不触发，worker 会残留；
- **没有实例互斥** —— DSH 重启后可能连接到上一个实例残留的 worker；
- DSH 崩溃时 worker 是否残留，**尚未验证**。

目标（三层，缺一不可）：

| 层 | 机制 | 覆盖场景 |
| --- | --- | --- |
| 硬保证 1 | stdin EOF（DSH 进程消失 → 管道关闭 → worker 退出） | 正常退出、崩溃退出 |
| 硬保证 2 | worker 每 2 s `OpenProcess(hostPid)` + `WaitForSingleObject(h,0)` 探测宿主 | 管道被继承、EOF 不触发 |
| 软保证 3 | 双向心跳 + 飞行中请求豁免 + 多击判定 | 进程卡死、冻结、恢复、重连 |

## 2. 协议

### 2.1 握手（必须先于心跳）

```
H→W  hello   {protocol:1, hostPid, hostInstanceId, shellHint, cwd}
W→H  welcome {workerPid, version, protocol:1, caps:[...], indexGen:0}
```

- `protocol` 不匹配 → 双方立即拒绝，worker 以退出码 **2** 退出；
- `hostInstanceId` 是每次 DSH 启动生成的 UUID：新实例遇到持有**不同 token** 的存活 worker 时，
  先发 `shutdown`，1.5 s 不退则强杀，然后重启（避免"连上前一个实例的进程"）；
- 握手超时 5 s → 宿主杀进程并按退避重启。

### 2.2 心跳（对称，但各自独立判定）

```
H→W  ping {seq, monotonicMs, inflight}
W→H  pong {seq, workerUptimeMs, indexGen, queueDepth, busy}
W→H  hb   {workerUptimeMs, indexGen}          # 空闲时 worker 主动发的 2 s 灯塔
```

存活判定规则（抗抖动的核心，**存活 ≠ 收到心跳**）：

1. **任一方向的 RPC 帧都算对方存活**（心跳可搭在正常报文上）；
2. **飞行中请求豁免**：宿主有未完成请求时不因 worker 静默判死，由该请求自身超时兜底（exec 默认 120 s）；
3. **多击判定**：静默超过 6 s 先补发 2 个间隔 1 s 的探测，全无回音才判死（宿主判 worker ≈10 s，worker 判宿主 ≈15 s）；
4. **单调时钟**：两侧只用 monotonic 时间，禁用墙上时钟（避免时钟跳变误杀）；
5. **休眠/唤醒不判死**：单调时间跳变超阈值时先做一次恢复握手，管道通且一次 ping/pong 成功就续期；
6. **心跳线程独立**：Rust 侧心跳/看护在专用线程，长 exec 与索引构建不阻塞心跳（否则 30 s 的 exec 就会误判）；
7. **退出码区分原因**：`0` 宿主正常关闭、`2` 协议/版本不匹配、`3` 心跳判定宿主已死、`4` 陈旧 token。

## 3. 参数（默认值，可在插件 Config 覆盖）

| 项 | 值 | 备注 |
| --- | --- | --- |
| 心跳间隔 | 2 000 ms | 两侧对称 |
| 宿主判 worker 静默阈值 | 10 000 ms | ≈5 次未回；有飞行中请求时豁免 |
| worker 判宿主静默阈值 | 15 000 ms | ≈7 次未回；宽于宿主侧，容忍宿主忙 |
| 探测补发 | 6 s 后补 2 次，间隔 1 s | 两次都失败才判死 |
| 重启退避 | 0 / 500 / 2 000 / 5 000 / 30 000 ms | 连续 5 次失败 → 工具调用返回明确错误 |
| 优雅关闭预算 | shutdown 1 500 ms → SIGTERM 1 500 ms → 强杀 | |
| 握手超时 | 5 000 ms | |
| 单实例锁 | `<dsh-home>/run/dsh-rust-worker-<profile>.lock` | 独占创建；内容是 workerPid |

## 4. 改动点（按文件）

### 4.1 `packages/dsh-rust-worker/src/main.rs`

- [ ] 启动后**先握手**：读首帧 `hello`，校验 protocol/hostPid/hostInstanceId，回 `welcome`；失败 `exit(2)`。
- [ ] 新增 `lifecycle` 模块（或同文件内的 `mod` 区）：
  - `host_watchdog`：`extern "system"` 声明 `OpenProcess/WaitForSingleObject/CloseHandle`（直接 FFI，**不引入 windows-sys 依赖**），每 2 s 探测宿主 pid；宿主消失 → `exit(3)`；
  - `beacon`：专用线程每 2 s 发 `hb`（空闲时）/`pong`（收到 ping 时），写入 stdout 互斥锁；
  - `missed` 计数器 + 6 s 后补探逻辑；
  - 单实例锁：`create_new(true)` 建锁文件，已存在则读 pid 探活，陈旧则覆盖。
- [ ] stdin 主循环：`ping` 报文只更新 `last_host_seen` 并回 `pong`，**不阻塞**；EOF 仍走优雅退出（退出码 0）。
- [ ] `shutdown` 方法：停 shell server（TCP）→ 关索引线程 → 删锁文件 → `exit(0)`。

### 4.2 `packages/dsh-rust-exec/index.js`

- [ ] spawn 时注入 `DSH_RUST_HOST_PID` / `DSH_RUST_HOST_INSTANCE`（每次 `apply` 生成 UUID）。
- [ ] 握手：`hello` 5 s 超时；失败 → 杀 + 退避重试。
- [ ] 心跳：`setTimeout` 链（**不用 `setInterval`**，避免冻结后补发积压）每 2 s 发 `ping`；
      维护 `lastInboundAt` / `inflight`（用现有 pending map 的 size）；
      超阈值 → 判死 → 强杀 + 退避重启。
- [ ] 陈旧实例清理：握手前若发现锁文件里的 pid 存活且 `hostInstanceId` 不同 → `shutdown` → 强杀。
- [ ] `dispose`：`shutdown` RPC → 1.5 s → `kill()` → 1.5 s → 强杀；`process.on('exit')` 尽力而为。
- [ ] 可观测：记录心跳间隔 p50/p99、错过次数直方图、重启次数；新增只读 RPC `worker.health`
      返回 `{uptimeMs, restarts, hbGapP50, hbGapP99, misses, lastExitCode, hostPid}`。

### 4.3 新增 `tools/lifecycle_test.mjs`

四个验收用例（脚本化，可重复跑）：

| # | 用例 | 期望 |
| --- | --- | --- |
| 1 | 强杀 worker 进程 | ≤10 s 判定死亡 → 退避重启 → 下一次调用成功；`worker.health.restarts ≥ 1` |
| 2 | 强杀宿主（模拟 DSH 崩溃） | worker ≤15 s 自行退出；`Get-Process dsh-rust-worker` 归零 |
| 3 | 伪造陈旧 worker（不同 `hostInstanceId` + 存活 pid） | 新实例识别并清掉它，随后正常启动自己的 worker |
| 4 | 宿主暂停 20 s（模拟卡顿/休眠） | worker 不退出；恢复后首个请求正常，心跳间隔统计出现一次大间隔但有恢复记录 |

## 5. 不做的事

- 不用 Windows Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）：DSH 是 Node/Electron，创建 Job 需要 FFI 或外部 helper，
  收益只是"比 stdin EOF + pid 看护更强一点"，而我们两层硬保证已覆盖。留作可选加固。
- 不让心跳承担"业务探活"：心跳只证明进程活着，业务是否可用由真实 RPC 错误码表达
  （`worker.health.lastError` + 工具返回的结构化错误）。
