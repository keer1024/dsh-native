# dsh-native vs 原生工具：模拟任务实测（2026-10-23 19:00）

> 本轮基准由 19:00 的定时任务触发，全部数字都是当晚新跑出来的，没有复用 README 里 10-21/10-22 的旧数据。
> 结论先行：**进程类操作（shell / 搜索）快 10–100 倍，同一模拟任务的工具耗时降到 1/20；端到端墙钟只快 2.4 倍，因为剩下的时间花在模型思考上；小文件读写反而慢 0.3–1.4 倍。**

| 项目 | 值 |
| --- | --- |
| 执行时间 | 2026-10-23 19:00:19 – 19:07:48 CST（微基准 58 s，宏任务 44 s + 18 s） |
| 机器 | KEER-PC，Windows，node v24.13.0 |
| 插件版本 | `@keer1024/dsh-native` 1.6.1（worker 已被搬到 `%LOCALAPPDATA%\dsh-native\bin`，integrity=low → 运行于 High） |
| 语料 | `C:\Users\keer_\.dsh\profiles\desktop\.bench-corpus`，153 个索引文件（`scratch.mjs` 是干扰项） |
| 样本 | 协议层每操作 n=12；会话层每个栈 3 次完整任务（每次 4 个工具调用） |
| 产物 | `.tmp/bench/micro.json`、`.tmp/bench/session.json`、本文 |

---

## 1. 模拟任务

同一个任务的两种实现，语料完全相同：

1. 在 153 个文件的语料里定位 `RETRIES` 的定义（`src/core/config.mjs:2`，干扰项 `scratch.mjs` 里也有同名常量）
2. 读出这个文件
3. 把 `RETRIES = 3` 改成 `RETRIES = 5`
4. 跑 `node smoke.mjs` 验证输出 `SMOKE_OK`，并把文件复位成 3

| 栈 | 定位 | 读 | 改 | 验证 |
| --- | --- | --- | --- | --- |
| 原生 | `grep`（rg 子进程） | `read` | `edit` | `pwsh`（powershell.exe 子进程） |
| dsh-native | `rust_search` | `rust_read` | `rust_edit` | `rust_exec` |

窗口用 `rust_exec` 打印 `PHASE <name> <epoch_ms>` 标记，工具耗时另外从会话日志 `session.v4.jsonl.zstd` 里按 `tool/call` → `tool/result` 配对重算（`tools/tool_latency.mjs`），不靠自报。

---

## 2. 协议层：单次操作成本（n=12）

"原生"= 每次调用起一个 OS 进程（powershell.exe / rg.exe / node fs），"dsh-native"= 一次 JSON-RPC 往返到已经常驻的 worker。worker 冷启动 `initialize` = 72 ms，只付一次。

| 操作 | 原生 mean (p50) | dsh-native mean (p50) | 倍率 |
| --- | --- | --- | --- |
| 执行一条命令 | **2676 ms** (3131) | **24.9 ms** (22) | **107×** |
| 全文搜索 | 873.8 ms (181) | 69 ms 常驻 (58) | 12.7×（中位数 3.1×） |
| 搜索 + 重建索引 | — | 83 ms (82) | — |
| 读 40 行 | 1.5 ms | 2.1 ms | 0.71×（慢 40%） |
| 列目录 | 0.3 ms | 2.6 ms | 慢 8.7× |
| stat | 0.2 ms | 1.0 ms | 慢 5× |
| 写文件 | 12.4 ms (1) | 78.9 ms (72) | 慢 6.4× |
| 编辑 | 28 ms（会话层实测） | 17 ms | 1.6× |

怎么读这张表：

- **执行类**的差距来自"每次 fork 一个 powershell.exe"（冷启动 + profile 加载 + 退出），dsh-native 的 shell 是常驻的，还要走 loopback 传输，但仍只有 25 ms。
- **搜索**原生 mean 被一次 8.5 s 的 rg 冷启动离群值拉高，看中位数更公平：**181 ms → 58 ms ≈ 3.1×**。冷启动后 rg 每次仍是新进程。
- **小文件 IO 反而更慢**：一次 RPC + serde + sha256 的开销（约 1–80 ms）比进程内的 `fs.readFileSync` 还贵。dsh-native 的 `write` 是"写临时文件 + fsync/rename + 计算 sha256"的原子写，安全但更慢。
- `list/stat` 的绝对差只有 1–2 ms，对人类感知无意义，只用来看清成本结构。

---

## 3. 会话层：同一任务的真实工具耗时（每栈 3 轮）

会话日志里按窗口切出来的数字（毫秒）：

| 栈 | 工具 | n | 合计 | 均值 | p50 |
| --- | --- | --- | --- | --- | --- |
| 原生 | pwsh | 3 | **10005** | 3335 | 3380 |
| 原生 | grep | 3 | 1617 | 539 | 568 |
| 原生 | edit | 3 | 83 | 28 | 27 |
| 原生 | read | 3 | 46 | 15 | 15 |
| | **小计** | **12** | **11751** | **979** | |
| dsh-native | rust_exec | 2 | 331 | 166 | 146 |
| dsh-native | rust_search | 3 | 96 | 32 | 29 |
| dsh-native | rust_edit | 3 | 51 | 17 | 17 |
| dsh-native | rust_read | 3 | 38 | 13 | 12 |
| | **小计** | **11** | **516** | **47** | |

- **工具时间：11.75 s → 0.52 s，约 22×**；每个任务 3.92 s → 0.17 s。
- **墙钟（标记到标记）：44.2 s → 18.2 s，2.43×**。差额是模型在两次工具调用之间的思考/生成时间——工具再快也压不掉它。
- 工具时间占墙钟比例：原生 **26.6%** → dsh-native **2.8%**。默认栈里"工具等待"是可见的，dsh-native 把它压到接近噪声。
- 调用次数一样（12 vs 11，rust 侧把"验证 + 复位"合成一条命令），所以提速不是靠少干活。

> 注意：宏任务每个栈只有 3 轮、单机单次，方差大于微基准的 n=12。倍率上下浮动 ±30% 属正常；方向性结论（进程类 10×+、小文件 IO < 1×）在两种测量里一致。

---

## 4. 上下文体量：搜索省、读文件略亏

| 指标 | 原生 | dsh-native | 变化 |
| --- | --- | --- | --- |
| 一次全文搜索返回 | 51,884 B | 4,749 B | **−90.8%**（预算化输出 + 3 命中上限） |
| 读 40 行 | 1,352 B | 1,682 B | +24%（多了 sha / 行号 / next offset 页脚） |
| 整文件读（2400 行） | 84,499 B | 按需分页 | 视 limit 而定 |

搜索省下来的上下文是实打实的：原生 `rg` 会把每条命中整行 + 全路径铺开，dsh-native 只给命中行前后各一行、超预算就截断并说明截断。

---

## 5. 工具"增益"不止时间：五个维度

1. **执行不降权**。1.6.1 之前，worker 镜像被 DSH 打了 Low 完整性标签（`icacls` 可见 `Mandatory Label\Low Mandatory Level:(I)(NW)`），导致 `rust_exec`/`rust_write` 写任何用户文件都 `os error 5`。1.6.1 把镜像复制到 `%LOCALAPPDATA%\dsh-native\bin` 再启动，标签消失，实测写工作区成功。这是"能不能用"级别的增益，不是速度。
2. **写有校验**。`rust_write` 支持 `expectedHash` 乐观锁，`rust_edit` 返回替换计数 + 新 sha256，`rust_read` 回传 sha 前缀可以做 CAS 改写；原生 `edit` 只回一句 "updated successfully"。
3. **读有去重**。同一文件内容没变时 `rust_read` 只回 `[unchanged 23s ago · sha …]`（本轮实测），不再重复灌一遍全文。
4. **编码不变形**。本轮踩到原生 `pwsh` 的真实坑：Windows PowerShell 5.1 的 `Set-Content` 默认 UTF-16LE，一次"复位"就把 UTF-8 源码写成 UTF-16，`read` 直接报 `invalid UTF-8 text`。dsh-native 的 `write/edit` 全程 UTF-8，不改行尾。
5. **上下文税基本持平**。会话日志 `request/header` 实测：
   - 39 个原生工具 = 37,799 字符 ≈ **10,500 tok/次请求**（`pwsh` 971、`edit` 320、`write` 237、`glob` 208、`grep` 195、`read` 122）
   - dsh-native 常驻 5 个 = 3,235 字符 ≈ **899 tok**；全展开 11 个 ≈ **2,074 tok**
   - 也就是说：用 dsh-native 的 11 个工具**替换**原生那 6 个文件/壳工具是**几乎零成本**（2,074 vs 2,053 tok）；只挂常驻 5 个则省 56%，代价是首次用到 `rust_edit`/`rust_write` 需要一次 `native_help` 激活（本轮实测：未激活前 `rust_edit` 不可用，只能用 `rust_exec` 绕，激活后才对齐原生 `edit`）。

---

## 6. 本轮踩到的坑（已记录，供复现者避雷）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `bench_native_vs_rust.mjs` 跑完不退，管道读取 300 s 超时 | 脚本未显式 `process.exit`，子 worker/shell 句柄把事件循环挂住 | 数据已落盘（19:01:17），kill 进程；改用文件重定向读结果 |
| `node -e "..."` 在 `pwsh` 里报 `Expected ')'` | Windows PowerShell 5.1 向原生程序传参时会剥掉双引号 | 改成落盘脚本 `tools/reset_corpus.mjs` 调用，两栈共用 |
| 语料文件变成 UTF-16，`read` 报 invalid UTF-8 | `Set-Content` 默认 UTF-16LE | `[IO.File]::WriteAllText` + `UTF8Encoding($false)` 重写 |
| `rust_search` 一开始 0 命中 | 索引根 = 宿主进程 cwd（`C:\Users\keer_\.dsh\profiles\desktop`），不是会话工作区 | 语料放在 profile 目录下；或用 `DSH_RUST_WORKER_CWD` 覆盖 |
| `rust_edit` 工具不存在 | 渐进披露：常驻只有 `rust_exec/read/search/health` | 先 `native_help tools=["all"]` |
| `edit.rust` 协议层样本无数据 | 微基准脚本两次传了相同 old/new 字符串 | 用会话层的 `rust_edit` 17 ms 作为该操作的值 |

---

## 7. 复现

```powershell
# 0) 前置：语料在 profile 目录（worker 索引根）
node tools\gen_corpus.mjs

# 1) 协议层（n=12，约 60 s）
node tools\bench_native_vs_rust.mjs --runs 12

# 2) 会话层：按第 1 节跑 3 轮原生栈 + 3 轮 dsh-native 栈，窗口用 PHASE 标记
rust_exec: "PHASE native-start $(epoch)"

# 3) 从会话日志重算逐工具耗时
node tools\tool_latency.mjs --cwd dsh-plugin --since <ms> --until <ms> --json .tmp\bench\session.json

# 4) 上下文税
node tools\schema_tokens.mjs --cwd dsh-plugin
```

---

## 8. 结论与选型建议

**值得用 dsh-native 的场景**

- 任何**起进程**的操作：跑构建、跑测试、`git`、`node`、批量脚本——107× 不是实验室数字，宏任务里 `pwsh` 一次 3.3 s vs `rust_exec` 一次 0.15 s 就是它的影子。
- **在中等规模仓库里反复搜索**：3× 中位数、10× 字节节省，且不会因为一条超长命中把上下文打爆。
- 需要**写校验/并发安全**的自动化改写：`expectedHash` + 原子 rename。
- 长会话的**日志/会话投影**（`rust_session_open` 增量解码，纯 JS 解 zstd 会吃满 CPU）。

**不必换的场景**

- 单文件小读小写、`stat`、`ls`：原生 fs 更快，绝对差 1–2 ms，没有收益。
- 需要 PowerShell 生态命令但只跑一两次：一次 3 s 的 pwsh 可以接受，不值得为它激活插件。

**一句话**：dsh-native 买的是"进程启动时间"和"输出预算"，不是"文件系统吞吐"。用对了地方，一个 12 次调用的任务从 44 s 压到 18 s（其中工具时间从 11.8 s 压到 0.5 s）；用错地方，小文件读写会比原生慢几十毫秒，且每次多付一次 RPC。
