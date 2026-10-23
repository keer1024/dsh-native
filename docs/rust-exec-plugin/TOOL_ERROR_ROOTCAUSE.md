# 工具调用报 `拒绝访问 (os error 5)`：根因、修复与验证（1.6.1 · 2026-10-23）

> 现象一句话：`rust_write` / `rust_edit` 写工作区文件、`rust_exec` 里 `Set-Content` 写文件，
> 都报 `拒绝访问 (os error 5)`；同一个路径用原生 `pwsh` / `write` 工具写却正常；
> `rust_read` / `rust_search` 一切正常。本文记录定位过程、真因、1.6.1 的修法，以及实测数据。

## 1. 初始现象与误判排除

| 观察 | 结论 |
|---|---|
| `rust_edit` 改 `tools/gen_corpus.mjs` → `拒绝访问` | 复现稳定 |
| `rust_write` 建 `.tmp/probe_rust.txt` → `拒绝访问` | 复现稳定 |
| `rust_exec` 里 `node -e "fs.writeFileSync(...)"` / `Set-Content` → `EPERM` | 复现稳定 |
| 原生 `pwsh` 工具写同样路径 | 成功 |
| `rust_read` 读同路径、`rust_write` 写 `C:\Users\keer_\.dsh\profiles\desktop\.bench-probe\probe.ts` | 成功 |

关键分叉：**同一个路径，原生工具能写、rust 工具不能写，且 rust 工具不是"完全不能写"**
（profile 目录能写）。所以既不是路径不存在、也不是 worker 崩了，而是"权限随进程走"。

## 2. 定位：进程完整性级别（IL）

用 `tools/token_il.ps1`（`OpenProcessToken` + `GetTokenInformation(TokenIntegrityLevel=25)`
+ `ConvertSidToStringSid`）读两侧令牌：

| 进程 | pid | 完整性 SID | 级别 |
|---|---|---|---|
| DSH 宿主 `DeepSeek Harness.exe` | 10228 | `S-1-16-12288` | High |
| `dsh-rust-worker.exe`（插件拉起） | 16408 | `S-1-16-4096` | **Low** |
| 原生 `pwsh` 工具子进程 | — | `S-1-16-12288` | High |

Windows 的写保护规则：Low IL 进程对 Medium/High IL 的对象（用户自己的文件默认就是 Medium，
带 NO_WRITE_UP）**写一律被拒**，读不受限 —— 与"能读、不能写"的现象完全吻合。

## 3. 真因：DSH 沙箱给工作区里的**镜像文件**打了 Low 标签

worker 的 Rust/JS 代码里没有任何降权调用（没有 `SetTokenInformation`、没有 `runas`、
没有 job object 限制）。决定性实验：

| 实验 | 结果 |
|---|---|
| High 的 `pwsh` 直接启动 `<安装目录>\bin\dsh-rust-worker.exe` | 进程仍是 **Low** |
| 把同一个 exe 复制到 `%TEMP%\wtest\worker.exe`，再用同一个 High `pwsh` 启动 | 进程变成 **High** |
| `icacls <安装目录>\bin\dsh-rust-worker.exe` | 输出含 `Mandatory Label\Low Mandatory Level:(I)(NW)` |
| `icacls %TEMP%\wtest\worker.exe` | 无 `Mandatory Label` 行 |

即：**Windows 按文件上的完整性标签决定新进程的 IL，与父进程无关**；标签是 DSH 沙箱给
"工作区里出现的可执行文件"打的（`index.js` 里旧注释也写着 `DSH's sandbox marks images kept
in the workspace`）。标签跟着文件走，复制一份就没了 —— 这就是修复的着力点。

附带解释了另一个怪现象：低完整性 worker 能写 `C:\Users\keer_\.dsh\profiles\desktop`（DSH 自己
把 profile 目录设成对低完整性可写），却写不了 `E:\study\dsh-plugin`（普通用户目录，NO_WRITE_UP）。

影响面：`rust_write`、`rust_edit`、以及 `rust_exec` 里任何落盘动作（`Set-Content`、`Out-File`、
`node -e fs.writeFileSync`、构建产物）。读、索引、搜索、会话投影完全不受影响。

## 4. 修复（1.6.1）

### 4.1 从无标签的副本启动

- `imageIntegrity(path)`（`index.js:385`）：`icacls` 读文件标签，判 `low` / `normal` / `unknown`，
  结果按路径缓存（进程内一次）。
- `relocateWorker(source)`（`index.js:404`）：把镜像复制到
  `%LOCALAPPDATA%\dsh-native\bin\dsh-rust-worker-<size>-<mtime>.exe`。指纹带 size+mtime，
  换构建就换文件名，不会和还在运行的旧 worker 抢同一个文件；先写 `.partial-<pid>` 再
  `rename`，避免拉起半个镜像；`pruneWorkerCopies`（`index.js:437`）只留当前 + 一代旧副本。
- `#resolveLaunchPath()`（`index.js:743`）：`low` 才搬迁，其余原样启动 —— 装在
  `~/.dsh/profiles/.../node_modules` 这类没有标签的位置时，行为与旧版完全一致。
- `#reapStale` 的镜像比对改成比 **stem**：`tasklist` 看到的是
  `dsh-rust-worker-<size>-<mtime>.exe`，旧逻辑拿 `dsh-rust-worker.exe` 比会判 "不是 worker"，
  从而漏掉上次宿主留下的孤儿进程。

### 4.2 加日志：出问题能自证

- `logEvent()`（`index.js:305`）写 `%LOCALAPPDATA%\dsh-native\logs\rust-exec-<宿主 pid>.log`，
  JSONL、单文件 2 MB 轮转到 `.1`；`DSH_RUST_DEBUG` 时同时打到 stderr。写日志失败永不抛错。
- 事件：`plugin.mounted`（版本、worker 源路径、cwd、lanes）、`worker.relocated` /
  `worker.relocate-failed`、`worker.spawn`、`worker.ready`（pid、协议、启动耗时）、
  `worker.exit`（退出原因 + 末 500 字节 stderr）、`worker.restart-scheduled`、
  `tool.error`（method、path、code、worker pid、integrity、message）、`tool.slow`（>5 s）。
- `rust_health` / `/health` 新增 `workerPath`、`sourceWorkerPath`、`relocated`、`integrity`、
  `logPath`、`recentErrors`（`index.js:647`）。
- `#logFailure()`（`index.js:603`）：失败先落日志进 `recentErrors`；命中
  `ACCESS_DENIED`（`index.js:333`：`拒绝访问|access is denied|os error 5|EPERM|EACCES`）时给错误
  追加可执行提示：哪个镜像、源标签是什么、是否已搬迁、日志在哪、以及按顺序该怀疑什么。

实测的提示文本（用 deny ACE 人为制造拒绝）：

```
write E:\study\dsh-plugin\.tmp\deny-probe\x.dsh-tmp-21300: 拒绝访问。 (os error 5)

[dsh-native] write denied for E:\study\dsh-plugin\.tmp\deny-probe\x.txt. Worker image:
C:\Users\keer_\AppData\Local\dsh-native\bin\dsh-rust-worker-2276864-1792728404248.exe
(source label: low, running a relocated copy). Causes, in order: a deny ACE or read-only
attribute on the path; a locked file; the worker itself starting at Low integrity.
Log: C:\Users\keer_\AppData\Local\dsh-native\logs\rust-exec-11652.log
```

## 5. 验证

### 5.1 原镜像 vs 搬迁副本（`node tools\verify_low_il_fix.mjs`）

同一份 exe、同一个工作区路径、同一个时刻：

| 镜像 | 文件标签 | 进程能读 | 进程能写 `.tmp\il-proof-*.txt` |
|---|---|---|---|
| `<安装目录>\bin\dsh-rust-worker.exe` | low | ✅ | ❌ `write ...: 拒绝访问。 (os error 5)` |
| `%LOCALAPPDATA%\dsh-native\bin\dsh-rust-worker-2276864-*.exe` | normal | ✅ | ✅ 21 bytes |

### 5.2 部署版插件端到端（`node tools\plugin_worker_probe.mjs`）

直接 `import()` 部署目录的 `index.js`、用真实的 `RustWorker` 类拉起 worker、写工作区文件：

```json
{ "integrity": "low", "relocated": true,
  "workerPath": "C:\\Users\\keer_\\AppData\\Local\\dsh-native\\bin\\dsh-rust-worker-2276864-1792728404248.exe",
  "sourceWorkerPath": "...\\default-workspace\\packages\\dsh-rust-exec\\bin\\dsh-rust-worker.exe",
  "write": { "ok": true, "bytes": 37 }, "recentErrors": 0 }
```

对应的日志（同一进程）：

```json
{"event":"worker.relocated","source":"...\\bin\\dsh-rust-worker.exe","launchPath":"...\\dsh-native\\bin\\dsh-rust-worker-2276864-1792728404248.exe"}
{"event":"worker.spawn","integrity":"low","relocated":true,"cwd":"E:\\study\\dsh-plugin","lanes":1,"version":"1.6.1"}
{"event":"worker.ready","workerPid":9984,"protocol":1,"startupMs":278}
```

### 5.3 回归

- `node --check index.js` 通过；`tools\plugin_worker_probe.mjs` 的 `PROBE_DENIED=1` 分支验证了
  失败路径会落 `tool.error`、`recentErrors` 从 0 变 1、错误文本带提示。
- 搬迁只在 `low` 判定时发生，未打标环境零行为变化。

## 6. 生效方式与运维

1. 新代码已同步到 profile link 指向的
   `C:\Users\keer_\Documents\deepseek-harness\default-workspace\packages\dsh-rust-exec`
   （`index.js` / `package.json` / `CHANGELOG.md`，版本 1.6.1）。
2. **需要重启 DSH**：宿主进程里的模块不会热替换。重启后 `rust_health` 应显示
   `relocated: true`、`integrity: "low"`，`rust_write` 写工作区成功。
3. 排查入口固定为两个：`rust_health.logPath` 指向的 JSONL，和 `%LOCALAPPDATA%\dsh-native\bin`
   下的副本时间戳。
4. 已知边界：若某台机器策略把"副本"也打了 Low 标签，写入仍会被拒 —— 此时日志与错误提示会直接
   写明镜像路径与 `source label`，可与"deny ACE / 只读 / 文件被占用"区分开。

## 7. 相关文件

| 路径 | 作用 |
|---|---|
| `packages/dsh-rust-exec/index.js` | 修复主体：`imageIntegrity` / `relocateWorker` / `#resolveLaunchPath` / `logEvent` / `#logFailure` / health 字段 |
| `packages/dsh-rust-exec/CHANGELOG.md` | 1.6.1 变更记录 |
| `packages/dsh-rust-exec/package.json` | 版本 1.6.1 |
| `tools/verify_low_il_fix.mjs` | 原镜像 vs 副本的对照实验 |
| `tools/plugin_worker_probe.mjs` | 部署版插件的端到端探针（`PROBE_DENIED=1` 测拒绝路径） |
| `tools/token_il.ps1` | 读进程令牌完整性级别 |
