# 小文件 IO 为什么慢：一次基于测量的修复（1.6.2，2026-10-26）

> 任务来自 12:00 的定时触发：查清 `rust_read` / `rust_stat` / `rust_ls` / `rust_write` 相对原生
> 工具慢的原因并动手修。**先说结论：10-23 那份数字里"小文件操作慢"的幅度，一半是环境负载，
> 另一半确实存在——而且慢的不是文件 IO，是"写一次文件顺手重写整份索引缓存"。**

| 操作 | 修前 p50 | 修后 p50 | 结论 |
| --- | --- | --- | --- |
| `fs.write`（索引根内） | 17.7 / 47.8 ms（双峰，尖峰到 90 ms） | **4.3 / 6.3 ms** | 3–10×，尖峰消失 |
| `fs.write`（索引根外） | 12.3 / 19.5 ms | **5.1 ms** | 2.4–3.8× |
| `fs.read`（84 KB 文件读 40 行） | 1.84 ms | **1.16 ms** | 1.6× |
| `fs.read`（20 B 文件） | 1.17 ms | 0.97 ms | 持平（噪声内） |
| `fs.stat` | 0.94 ms | 0.81 ms | 持平 |
| `fs.list`（153 项目录） | 2.15 ms | 1.83 ms | 持平 |
| `ping`（RPC 地板） | 0.63 ms | 0.50 ms | 未改动核心循环 |

---

## 1. 先把测量方法修好

10-23 的协议层基准把 12 种操作连着跑，每种 12 次；其中 `exec.native` 会起 12 个
`powershell.exe`。这一轮重新测量时发现：**同一份二进制、同一台机器，`exec.native` 的均值在
2013–2120 ms 之间摆动，`search.native` 在 149–410 ms 之间摆动**——机器负载对"起进程"类操作的影响
能到 2.7×，而 `stat` 只有 0.2–0.9 ms，完全被这种漂移淹没。

所以这一轮不再用一个协议层大表下结论，而是：

1. **分解基准** `tools/bench_fs_breakdown.mjs`：每次只测一种操作，n=40–150，另外带三条纯原生对照
   （`native.inplace` = 原地写、`native.tmpRename` = 临时文件 + rename、`native.tmpRename45k` =
   写 45 KB 再 rename）。原生对照是"这一次运行的速度标尺"，用来判断机器是否漂了。
2. **交错 A/B**：把旧二进制（`.old`）和新二进制交替跑（第 1 轮新先跑、第 2 轮旧先跑……），6 对，
   每对 50 次/操作；另有一组 4 对、150 次/操作的复核。
3. **归一化**：把每个操作除以同一次运行里的 `native.tmpRename`，得到"相当于几次原生写入"，
   机器漂移在这张表里互相抵消（`tools/compare_fs_runs.mjs`）。

---

## 2. 五个根因，两个被推翻

### 2.1 被推翻：RPC 地板不是 1 ms，是 0.27 ms

`ping` 在 40 次采样里的 p50 是 **0.27 ms**（`fs.stat` 0.32 ms、`fs.read` 小文件 0.45 ms）。
10-23 那份数据里 `stat 1.0 / read 1.6 / ls 2.1` 是同一轮 36 次进程启动带来的系统负载抬高的，
不是协议开销。**结论：不要为了省 0.3 ms 去改传输层。**

### 2.2 被推翻：45 KB 缓存落盘本身只要 1.14 ms

`native.tmpRename45k`（写 45,721 B 再 rename）p50 = **1.14 ms**。所以"Defender 扫描 45 KB 新文件"
不是 `fs.write` 花掉 50 ms 的原因。

### 2.3 真因：每次写都重写整份索引缓存

`fs.write` / `fs.edit` 成功后都会走 `index::note_change`
（`packages/dsh-rust-worker/sources/src/index.rs:626`）：重解析该文件、`files.retain` 遍历全表、
重新排序、重算符号总数，最后 `save_cache`（`index.rs:238`）把**整份缓存**序列化到临时文件再 rename。
本机 153 个文件 = 45,721 B；真实仓库是几 MB。

分解基准里"根内 12.75 ms vs 根外 7.76 ms"的 5 ms 差，就是"这份文件在索引里"额外触发的重解析 + 重排；
剩下 6–7 ms 是那次全量落盘加上序列化 153 条 `Value` 的开销。旧版在连续写时还会双峰（p95 到 90 ms），
因为缓存写入与下一次写叠在一起。

### 2.4 真因：读 40 行先把整个文件拆成行指针表

旧 `fs_read` 用 `split_inclusive('\n').collect::<Vec<&str>>()`，2400 行的 `big.mjs` 为了返回 40 行
要分配 2400 个指针（38 KB 临时分配），再对整份内容算一次 SHA-256。窗口语义完全不需要这两步。

### 2.5 真因（次要）：`fs.list` 逐条 metadata、`hash` 反复算

`fs.list` 每次 `read_dir` 后对每个条目 `metadata()`（153 次系统调用 + 约 7 KB JSON）；
`fs.read` 的哈希没有任何缓存，同一文件连续读 N 次要算 N 次。

---

## 3. 改了什么

| 文件:行号 | 改动 | 语义影响 |
| --- | --- | --- |
| `index.rs:266-296` | 新增 `CACHE_FLUSH_DEBOUNCE_MS = 500`、`CACHE_DIRTY`、`mark_cache_dirty()`：只标脏，由唯一的后台线程合并落盘；线程起不来时返回 false | 内存索引仍然同步更新，磁盘缓存最迟 0.5 s 后一致 |
| `index.rs:626` `note_change` | `save_cache(...)` → `if !mark_cache_dirty() { save_cache(...) }` | 一次写不再等一次全量落盘 |
| `main.rs:641` `file_sha256` | 按 `(path, size, mtime)` 缓存摘要，256 条上限，满了清空 | 内容没变就不重算；写一次必然改 mtime，不会命中旧值 |
| `main.rs:666/680` `count_lines` / `line_offset` | `memchr` 数行 + 两次换行扫描定位窗口 | 与 `split_inclusive` 行数语义一致；切点落在 `\n` 之后，永远是 UTF-8 边界 |
| `main.rs:708` `fs_read` | 按字节切片替代整文件拆行；新增 `hash: "full" \| "prefix" \| "none"`（默认 full） | 默认行为不变；`none` 省掉整文件哈希 |
| `main.rs:776` `fs_write` | 父目录已是目录时跳过 `create_dir_all` | 原子写（tmp + rename）与 `expectedHash` 守卫不变 |
| `main.rs:877/893` `fs_stat` | 新增 `paths: string[]`（≤256）→ `{ entries: [...] }`；单路径形态不变 | 批量探测 1 次 RPC |
| `main.rs:910` `fs_list` | 新增 `sizes: false`；`sizes` 为真时只取一次 `metadata()`（同时给 isDir 与 size） | 只要名字时省掉 N 次 metadata |
| `index.js:2102` | `rust_read` 改传 `hash: 'prefix'`（页脚只显示 16 位，16 位也是合法 `expectedHash` 前缀） | 每次读少 48 B 载荷 |
| `index.js:1362/2196` | `rust_stat` 暴露 `paths` 批量形态 + `renderStatMany` 渲染 | 新增能力，旧调用不受影响 |

不变量仍然成立：写走临时文件 + 原子 rename；`expectedHash` 版本守卫照旧（`smoke` 里特意验证了下发一个
全零 hash 会被拒）；`fs.read` 的截断仍落在字符边界。

---

## 4. 数字

### 4.1 交错 A/B（6 对 × 50 次，p50 的中位数）

| 操作 | 旧 | 新 | 归一化旧 | 归一化新 | 归一化变化 |
| --- | --- | --- | --- | --- | --- |
| `write` 根内 | 17.70 | **6.25** | 9.20 | **3.13** | **0.34×** |
| `write` 根外 | 12.34 | **5.21** | 6.78 | **2.77** | **0.41×** |
| `read` 84 KB 40 行 | 1.73 | 1.33 | 0.92 | 0.63 | 0.69× |
| `read` 小文件 | 1.02 | 1.38 | 0.55 | 0.68 | 1.23×（噪声内） |
| `stat` | 0.69 | 0.81 | 0.39 | 0.41 | 1.07× |
| `list` | 1.83 | 2.59 | 1.00 | 1.24 | 1.24×（后经 150 次复核为 0.85×） |
| `ping` | 0.46 | 0.52 | 0.25 | 0.24 | 0.96× |
| 原生 `tmp+rename`（标尺） | 1.85 | 2.00 | 1.00 | 1.00 | — |

### 4.2 高样本复核（4 对 × 150 次）

| 操作 | 旧 p50 | 新 p50 | 变化 |
| --- | --- | --- | --- |
| `write` 根内 | 47.75 | **4.25** | 0.09× |
| `write` 根外 | 19.45 | **5.21** | 0.26× |
| `read` 84 KB 40 行 | 1.84 | **1.16** | 0.63× |
| `read` 小文件 | 1.17 | 0.97 | 0.83× |
| `stat` | 0.94 | 0.81 | 0.87× |
| `list` | 2.15 | 1.83 | 0.85× |
| 原生 `inplace` / `tmp+rename`（标尺） | 0.73 / 1.91 | 0.58 / 1.88 | 0.80× / 0.98× |

旧版的 `write` 绝对值在两组之间从 17.7 变到 47.8，是因为它有双峰：连续写时下一次写会撞上上一次的
缓存落盘。新版没有这个双峰（150 次里最大 16 ms）。

### 4.3 缓存去抖的另一面：不再丢即时性

`tools/probe_cache_debounce.mjs`（12 个文件连写，写进 workspace 索引根）：

```
writeMs: { min: 9, p50: 13, max: 16 }   totalWriteMs: 149
searchImmediatelyAfterWrites: 1          // 写完立刻能搜到新符号
indexFilesBefore: 84 → indexFilesAfter: 96
```

即：**内存索引是同步更新的，去抖只作用于磁盘缓存**，所以 `rust_search` 不会因为这项优化看到陈旧数据。

### 4.4 协议层大表（仅供参考，别拿来比小文件）

| 操作 | 旧（12:00 基线） | 新（12:0x） |
| --- | --- | --- |
| `exec` | 2120.4 → 10.6 ms | 2013.8 → 8.5 ms |
| `search` | 410.1 → 59.3 ms | 148.9 → 58.4 ms |
| `write` | 3.6 → 53.3 ms | 6.0 → 16.2 ms |

同一张表里 `exec.native` 从 2120 变 2014、`search.native` 从 410 变 149，说明这张表测到的主要是机器状态；
小文件操作的结论一律以 4.1/4.2 为准。

---

## 5. 没做什么，为什么

- **换传输层（AF_UNIX / 命名管道 / 共享内存）**：`ping` 已经 0.27 ms，收益上限不到 0.3 ms/次；
  代价是改协议、改部署、改非 Windows 路径。不值得。
- **`fs.batch`（一次 RPC 跑多个异构 fs 操作）**：只做了 `fs.stat paths[]` 这一个高频形态。
  真正的异构批处理要设计子操作 schema 与错误归属，而当前每个工具调用本来就只做一件事——
  先看真实需求再上。`ponytail:` 如果以后出现"一次调用要 stat+read+list 十几项"的场景，再补。
- **把 `fs.*` 改成异步线程池**：现在单次操作 0.3–4 ms，瓶颈是往返而不是 CPU；异步只会把
  "等待" 变成 "更复杂的等待"。`exec` 已经有 lane 池承担长任务并发。
- **对 `search` 的索引缓存做同样去抖**：构建索引本来就只在 TTL/refresh 时落盘一次，没有热点。

---

## 6. 验收

| 项 | 结果 |
| --- | --- |
| `node --check packages/dsh-rust-exec/index.js` | 通过 |
| `cargo build --release`（LTO，`codegen-units=1`） | 通过，1m01s，仅剩两条既有 `dead_code` 警告 |
| `tools/smoke_worker_rpc.mjs`（16 项行为检查：三种 hash 模式、行窗口边界、stat 批量、list sizes、写守卫、edit 替换计数） | 全部通过 |
| `tools/plugin_worker_probe.mjs`（部署副本 + 搬迁 worker） | `relocated:true`、`integrity:low`、`write.ok:true` |
| 部署到 `C:\Users\keer_\Documents\deepseek-harness\default-workspace\packages\dsh-rust-exec` | index.js 144,968 B、worker 2,287,104 B（sha256 `9B07BB54…D239E50`） |

**需要重启 DSH 才会用上新 worker**：正在跑的 worker 进程仍是 1.6.1 的镜像（它已经把旧二进制
映射进内存了，"先把镜像搬到 `%LOCALAPPDATA%`" 这个机制本身也是靠进程重启生效的）。1.6.1 的
行为（relocation + 日志 + 低完整性修复）不受影响。

---

## 7. 复现

```powershell
# 分解基准：ping / stat / list / read / write + 原生标尺
node tools\bench_fs_breakdown.mjs --runs 150 --out .tmp\bench\fs-new-1.json

# 交错 A/B（需要先准备 <bin>.old，见下），再比较
node tools\compare_fs_runs.mjs 6 fs-new fs-old

# 行为回归
node tools\smoke_worker_rpc.mjs

# 缓存去抖与即时可见性
node .tmp\probe_cache_debounce.mjs
```

准备 `.old` 的方式：`Copy-Item bin\dsh-rust-worker.exe bin\dsh-rust-worker.exe.old` 在换装新二进制前执行一次。

`tools/bench_fs_breakdown.mjs` 的原生标尺（`native.inplace` / `native.tmpRename` / `native.tmpRename45k`）
是这套方法的支点：没有它们，就分不清"代码变快"和"机器变快"。
