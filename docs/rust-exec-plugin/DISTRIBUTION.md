# dsh-native 分发与跨机安装（1.4.2 · 2026-10-22）

> 本文给出把 `packages/dsh-rust-exec` 变成**自带 worker 二进制、可脱离本仓库安装**的 bundle 的当前做法，
> 以及在一台干净机器上安装、验收、排错的步骤。发布到 npm / 插件市场见
> [PUBLISHING.md](PUBLISHING.md)；下文第 1–5 节是 1.0.0 的历史打包记录，仅供对照。

## 0. 当前产物（唯一有效记录）

| 项 | 值 |
| --- | --- |
| 包版本 | `dsh-native@1.4.2`（worker 的 `Cargo.toml` 仍是 `0.1.0`，两套版本号未统一） |
| tarball | `dist/dsh-native-1.4.2.tgz` · **1 037 336** 字节 · 解压 2.4 MB · 11 个文件 |
| tarball sha256 | `ce990f9d0ac456b7d9fcf4995d8b1f8e4c8d14fba6036d191fd0083616c8cdc1` |
| 包内 exe | `bin/dsh-rust-worker.exe` · 2 255 872 B · sha256 `AD343EF0B730985CF4B8FA5B67637AA11B56E17928ACC0160E0A6E0CFDC42B04` |
| 包内文件 | `package.json`、`index.js`、`client.js`、`cordis.patch.yml`、`icon.svg`、`locale/{en,zh}.json`、`bin/dsh-rust-worker.exe`、`CHANGELOG.md` |
| 实测 | `pnpm install`（pnpm 10.32.1）从 tarball 装进空目录 → `node_modules/dsh-native` 9 个条目齐全 → `import('dsh-native')` 导出 `Config,RustWorker,WorkerPool,apply,inject` → `check_client_identity` 17/17 |
| 已知限制 | 未发布 registry（`private: true`）、exe 未签名（SmartScreen 会拦）、仅 win32-x64、依赖目标机的 Windows PowerShell 5.1 |

## 1. 从源码打出 tarball

```powershell
cd C:\Users\keer_\Documents\deepseek-harness\default-workspace
node --check packages\dsh-rust-exec\index.js
node --check packages\dsh-rust-exec\client.js
node tools\check_client_identity.mjs
npm pack packages\dsh-rust-exec --pack-destination dist
tar -tzf dist\dsh-native-1.4.2.tgz          # 必须正好 11 个文件
(Get-FileHash dist\dsh-native-1.4.2.tgz -Algorithm SHA256).Hash
```

`npm pack` 只收 `package.json` 的 `files[]` 白名单里的东西，`bin/*.old`、`src/`、测试脚本都不会进包。

## 2. 在另一台机器安装

目标机先装好 DSH 桌面版（Windows 10/11 x64，自带 pnpm 与 PowerShell 5.1，不需要单独装 Node 运行时）。

### 路线 A：tarball 离线安装（推荐，已实测）

1. 把 `dsh-native-1.4.2.tgz` 拷到目标机，例如 `C:\dsh\dist\dsh-native-1.4.2.tgz`。
2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：
   ```json
   {
     "dependencies": {
       "dsh-native": "file:C:/dsh/dist/dsh-native-1.4.2.tgz"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-native"]
       }
     }
   }
   ```
   两处都要有：`dependencies` 负责装包，`dsh.profile.bundles` 负责把插件挂进本次启动。
3. 在该 profile 目录安装依赖：
   ```powershell
   cd $env:USERPROFILE\.dsh\profiles\desktop
   pnpm install
   ```
   （目标机没有 pnpm 时，用 DSH 图形界面的插件管理页安装同一个 tarball，效果相同。）
4. 确认包已就位：`Test-Path .\node_modules\dsh-native\bin\dsh-rust-worker.exe` 应为 `True`。
5. 重启 DSH。

### 路线 B：目录 link（开发机方式，改代码即时生效）

把 `packages\dsh-rust-exec` 整个目录拷到目标机，`dependencies` 写成
`"dsh-native": "link:C:/dsh/plugins/dsh-native"`，`bundles` 同样加 `dsh-native`，再 `pnpm install` + 重启。
改 `index.js` 需重启，改 `client.js` 刷新页面即可。

### 路线 C：npm registry

`dsh-native` 这个包名在 npm 上可用（2026-10-22 复核 404；详见 [PUBLISHING.md](PUBLISHING.md) §0），
发布后 `dependencies` 写版本号即可。若日后改名，必须**同步三处**：
`package.json` 的 `name`、`cordis.patch.yml` 的 `name`/`id`、`client.js` 里 `__ModuleLoader__.load({ id })` 的 id。

## 3. 安装后验收

| 检查 | 期望 |
| --- | --- |
| 设置页 | 出现 `dsh-native` 标签页，顶部有「刷新」「监控器」两个按钮 |
| 输入框下沿状态条 | 出现绿色状态点 + `DF` + `CPU … RSS … 运行中 … 队列 …` |
| `GET http://127.0.0.1:<port>/api/dsh-rust-exec/health` | 200，含 `hostPid`、`worker.pid`、7 条路由 |
| 工具列表 | 有 `rust_exec`、`rust_read`、`rust_search`、`rust_health` 等 10 个 |
| 重启 DSH | 不出现 `web boot: 1 entry did not activate` / `duplicate factory registration` |
| 会话页 `dsh-native 视图` | 顶部栏与右侧详情固定，只有消息列表滚动 |

## 4. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 重启后插件完全没加载、工具里没有 `rust_*` | `dsh.profile.bundles` 里缺 `dsh-native`（只写 `dependencies` 不够），或 `pnpm install` 没跑 |
| `web boot: 1 entry did not activate`、`duplicate factory registration for "..."` | 包名与 `client.js` 注册 id 不一致；跑 `node tools\check_client_identity.mjs` 定位 |
| `Cannot find module 'dsh-native'` | profile 目录里没装依赖；回路线 A 第 3 步 |
| 工具报 `拒绝访问 (os error 5)` 写 `%TEMP%` 或 `~/.dsh` | worker 以低完整性级别运行（DSH 沙箱派生的镜像），只能写工作区；属预期限制 |
| 首次 `exec` 要 3–20 秒 | PowerShell 进程冷启动（Defender 扫描），之后同一 lane 是毫秒级；DSH 启动时已预热 |
| SmartScreen「Windows 已保护你的电脑」 | exe 未签名；点「更多信息 → 仍要运行」，正式分发需代码签名 |
| 状态条/视图不更新 | 页面拿到的是旧 client bundle；刷新页面，仍不行则重启 DSH |

---

# 附：1.0.0 历史打包记录（2026-10-20）

> 目标：把 `packages/dsh-rust-exec` 做成一个**自带 worker 二进制、可脱离本仓库安装**的 DSH bundle 包。
>
> 状态：**本地可分发已验证**。`npm pack` 产物完整、内嵌 exe 与源码字节一致、exe 能完成 `hello`/`initialize` 握手。
> **尚未发布到任何 npm registry**（`package.json` 里 `"private": true`，且没有 CI、没有版本发布流程），
> 目前只有两种真实可用的安装方式：**本地目录安装** 与 **tarball 安装**。

> [!IMPORTANT] 最新打包记录：**1.1.0（2026-10-21 12:44，T3）**
> 本文档第 2–5 节的数字是 **1.0.0（2026-10-20）** 的历史记录，保留用于对照；**升级/校验请只认下面这组**。
>
> | 项 | 值 |
> | --- | --- |
> | 包版本 | `dsh-rust-exec@1.1.0`（worker `Cargo.toml` 仍是 `0.1.0`，两套版本号未统一） |
> | 打包命令 | `npm pack C:\...\packages\dsh-rust-exec`（Windows 上 `tar -tzf` 可列包内文件） |
> | `files` 校验 | 包内 11 个文件：`index.js`、`client.js`、`package.json`、`cordis.patch.yml`、`icon.svg`、`locale/{en,zh}.json`、`bin/dsh-rust-worker.exe`、`CHANGELOG.md`；无 `src/`、无 `package-lock` |
> | tarball | `dsh-rust-exec-1.1.0.tgz`，**1 019 760** 字节 |
> | tarball sha256 | `CC2F923C9B3F1E6E4D9DCF7974F8E9A9DC68209F369614D3AC94AB990E6F83C6` |
> | 包内 exe sha256 | `4C8867DD50397D04B1876B10A67B56D3F54074F2D56E89EA58CD30FDB30AD4FE`（2 254 336 B） |
> | 源 exe sha256 | 同上（`packages/dsh-rust-exec/bin/dsh-rust-worker.exe`，**字节一致已核对**） |
> | 校验方式 | `tar -xzf <tgz> -C <tmp> 'package/bin/dsh-rust-worker.exe'` 后比 sha256；`npm pack --dry-run` 看文件清单 |
> | 未做（仍是限制） | 未发布 registry、未签名、只 win32-x64、无 CI、无 `bin/*.sha256` 随包分发 |

---

## 1. 产物构成

| 文件 | 字节数 | 作用 |
| --- | --- | --- |
| `bin/dsh-rust-worker.exe` | 2 163 200（2.06 MiB） | 预编译的 Rust worker（win32-x64，console 子系统，包含 `session.open` 投影） |
| `index.js` | 81 808 | Host bundle：10 个工具 + 2 条 HTTP 路由 + metrics + worker 池 |
| `client.js` | 25 313 | 客户端面板/徽标 |
| `cordis.patch.yml` | 75 | bundle patch：`insert` 一行 `rust-exec`，`config: {}` |
| `locale/en.json` | 209 | 英文文案 |
| `locale/zh.json` | 225 | 中文文案 |
| `icon.svg` | 557 | 插件图标 |
| `package.json` | 751 | 包元数据 + `files` 白名单 |

总解压体积 **2.3 MB**，`package.json` 无任何 `dependencies`（Host 侧只用 Node 内置模块，worker 侧是单个静态 exe），
所以安装时不产生 node_modules 依赖树，也不需要构建脚本。

## 2. 打包实测（真实输出）

在 `packages/dsh-rust-exec` 下执行 `npm pack --dry-run`（npm 11.6.2 / node 24.13.0）：

```
npm notice package: dsh-rust-exec@1.0.0
npm notice Tarball Contents
npm notice 2.2MB bin/dsh-rust-worker.exe
npm notice 25.3kB client.js
npm notice 75B cordis.patch.yml
npm notice 557B icon.svg
npm notice 81.8kB index.js
npm notice 209B locale/en.json
npm notice 225B locale/zh.json
npm notice 751B package.json
npm notice Tarball Details
npm notice name: dsh-rust-exec
npm notice version: 1.0.0
npm notice filename: dsh-rust-exec-1.0.0.tgz
npm notice package size: 969.6 kB
npm notice unpacked size: 2.3 MB
npm notice shasum: 3714d30fe07ae5b8b9a21a8663be174f8a87399f
npm notice integrity: sha512-lvJ0VpwUBDN2k[...]UOV8+mONPVQdQ==
npm notice total files: 8
```

- `total files: 8` —— 与上表一一对应，**没有**误带 `node_modules`、`*.map`、测试或文档；
- 压缩后 `969 627` 字节（`package size` 只算 tarball 本身，选它做传输体积）；
- 解压后 `bin/` 里的 exe 与 `packages/dsh-rust-exec/bin/dsh-rust-worker.exe` **sha256 完全一致**
  （已用 `tar -xzf` 解包后重新 `Get-FileHash` 校验，未发生换行/权限位损坏）。

### 2.1 校验值（本次唯一有效记录）

| 对象 | 值 |
| --- | --- |
| `bin/dsh-rust-worker.exe` sha256 | `4715A5C23268F3B5548D3FB8CC4304E89173EE3AC8A4C051ED3DD78A4CD61342` |
| `bin/dsh-rust-worker.exe` 字节数 | `2 163 200` |
| `dsh-rust-exec-1.0.0.tgz` sha256 | `F1161B104D45E0BDAEE9245846DFD38D0186013F8882042ACE0C2C67EC034F6A` |
| `dsh-rust-exec-1.0.0.tgz` sha1（npm shasum） | `3714d30fe07ae5b8b9a21a8663be174f8a87399f` |
| `dsh-rust-exec-1.0.0.tgz` 字节数 | `969 627` |
| `dsh-rust-exec-1.0.0.tgz` integrity（sha512/base64） | `lvJ0VpwUBDN2kvL8b3V7WKUfAOHT0k6zYOTT8m0w+6q/QX2psKKftFsO7lOv1/nCORTCjrExPUOV8+mONPVQdQ==` |

> tarball 是**可复现但不必逐字节复现**的：npm 会在 tar 头里写 mtime，同样的源文件重新打包 sha256 可能变化，
> 但 `integrity`/`shasum` 在 npm 安装时会被核对。**exe 的 sha256 才是契约**，升级时只认它。

## 3. 安装方式

统一走 `plugin_manager`，**不要**用裸 `npm/pnpm add` 绕过 bundle 注册。

### 3.1 本地目录安装（开发/自用，推荐）

```
plugin_manager({ action: "install_bundle", target: "C:\\Users\\keer_\\Documents\\deepseek-harness\\default-workspace\\packages\\dsh-rust-exec" })
```

- pnpm 会以**符号链接**方式把该目录装进当前 profile 的 `node_modules`（本机现状即如此：
  `dsh-rust-exec` 是指向 workspace 包的符号链接），所以**改源码立即落盘生效**，
  但运行中的 Host 仍持有旧模块 —— 必须 `remove_bundle` → `install_bundle`（或重启 DSH）才会重载 JS；
- 这种方式**不经过** `files` 白名单，目录里有但 `files` 没列的文件（如测试、`_bench`）也会被看到，
  所以它验证不了"分发面"，只适合本机迭代。

### 3.2 tarball 安装（这就是"可分发"的意思）

```powershell
cd packages\dsh-rust-exec
npm pack                              # 生成 dsh-rust-exec-1.0.0.tgz
```

```
plugin_manager({ action: "install_bundle", target: "C:\\path\\to\\dsh-rust-exec-1.0.0.tgz" })
```

- tarball 是**真实拷贝**进 profile，只包含 §1 那 8 个文件，这才是终端用户实际拿到的东西；
- `install_bundle` 对 tarball 的版本兼容性检查发生在**安装之后**（tarball 要先下载/解包才知道 `package.json`），
  失败时会回滚 `package.json`/`pnpm-lock.yaml` 并重装原锁文件；
- 装完必须刷新 Web 页面（客户端 bundle 走 HMR/重建），Host 侧走 `applied` 结果确认；
- 升级＝打新 tarball → `remove_bundle` → `install_bundle` 新 tarball。**同名同版本无法覆盖**，升级要顺手 bump `version`。

### 3.3 未做的：npm registry

```
# 目前不可用：private: true，且没有发布流水线
plugin_manager({ action: "install_bundle", target: "dsh-rust-exec" })
```

要开放这条路径，至少需要：去掉/条件化 `private`、确定包名归属、发布 `1.0.0`、以及配套的 `npm publish` 流程。
**本文件不声称支持该方式。**

## 4. worker 二进制解析顺序（关键：目前还没接到 bin/）

`index.js` 现在的真实行为（`normalizeConfig`，index.js:163-165）：

1. `config.workerPath` —— 非空字符串则直接用；
2. 否则用常量 `DEFAULT_WORKER_PATH`（index.js:17-18），当前写死为
   `C:\Users\keer_\Documents\deepseek-harness\default-workspace\packages\dsh-rust-worker\target\release\dsh-rust-worker.exe`；
3. **没有** 相对 `import.meta.url` 的 `./bin/dsh-rust-worker.exe` 兜底，也**没有**存在性检查。

> ⚠️ 也就是说：**内嵌的 `bin/dsh-rust-worker.exe` 现在不会自动被用到**。在本机上之所以能跑，
> 是因为开发机的绝对路径恰好存在。分发到别的机器上，必须显式配 `config.workerPath`，否则会 spawn 失败。
>
> 同样的坑还有 `WORKER_CWD`（index.js:19）写死成开发机 workspace 路径 —— worker 的 `cwd` 参数和
> `initialize` 返回的 `cwd` 都取它，在裸机上是无效目录。

**建议的修法**（属于 `index.js`，本次打包工作未改动该文件，交由 owner 落地）：

```js
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLED_WORKER_PATH = join(HERE, 'bin', 'dsh-rust-worker.exe')
// 解析顺序建议：config.workerPath > env.DSH_RUST_WORKER_PATH > BUNDLED_WORKER_PATH > 旧 DEFAULT_WORKER_PATH
const WORKER_CWD = process.env.DSH_RUST_WORKER_CWD ?? process.cwd()
```

补齐后 `files` 里的 `bin/dsh-rust-worker.exe` 才真正闭环。

## 5. 平台限制

| 项 | 现状 |
| --- | --- |
| OS | **仅 Windows**（worker 用 `OpenProcess` 看护宿主、`powershell.exe` 作为 shell、fs 路径按 Windows 语义） |
| 架构 | **仅 x64**：exe 的 PE `machine = 0x8664`（AMD64），subsystem `0x0003`（console） |
| 交叉编译 | 未做。仓库里只有本机 `cargo build --release` 的产物，没有 arm64 / linux / darwin 构建 |
| 运行时依赖 | exe 只导入 UCRT（`api-ms-win-crt-*`），**不需要** `vcruntime140.dll`，Win10 及以上自带即可 |
| Node | Host 侧使用 Node 内置模块（`node:fs`、`node:child_process` 等），无 npm 依赖；本机验证用 node 24.13.0 |
| PowerShell | worker 默认 shell 为 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（Windows PowerShell 5.1） |

在非 Windows profile 上安装会得到一个**能装但不能用**的包（`spawn` 找不到 exe 或 exe 无法执行）。
如果需要硬性拦截，可以在 `package.json` 加 `"os": ["win32"], "cpu": ["x64"]`；本次**故意没加**，
以免影响现有本机 profile 的安装路径，是否加由 owner 决定。

## 6. 升级步骤（换 worker 二进制）

```powershell
# 1) 必须先停掉占着 exe 的 worker，否则 Copy-Item / cargo 会 os error 5（拒绝访问）
Get-Process dsh-rust-worker -ErrorAction SilentlyContinue | Stop-Process -Force

# 2) 构建（前置环境变量必须设，否则找不到 cargo/rustup）
$env:RUSTUP_HOME='D:\software\rust\rustup'; $env:CARGO_HOME='D:\software\rust\cargo'
$env:Path="D:\software\rust\cargo\bin;"+$env:Path
cd packages\dsh-rust-worker; cargo build --release

# 3) 覆盖内嵌副本（源：优先 _bench/target-session/release/，其次 packages/dsh-rust-worker/target/release/）
Copy-Item -Force _bench\target-session\release\dsh-rust-worker.exe packages\dsh-rust-exec\bin\dsh-rust-worker.exe

# 4) 记录新指纹并写回本文件 §2.1
(Get-FileHash packages\dsh-rust-exec\bin\dsh-rust-worker.exe -Algorithm SHA256).Hash
(Get-Item packages\dsh-rust-exec\bin\dsh-rust-worker.exe).Length
```

然后 `npm pack` 打新 tarball → `remove_bundle` → `install_bundle` → 刷新页面。
**不要只替换 profile 里的 exe 了事**：运行中的 Host 仍连着旧 worker，且下次 `install_bundle` 会把目录整体重写。

## 7. 校验方式

安装后按顺序验证（全部有本次实测数据支撑）：

```powershell
# a. 文件级：指纹必须等于 §2.1
(Get-FileHash <profile>\node_modules\dsh-rust-exec\bin\dsh-rust-worker.exe -Algorithm SHA256).Hash

# b. 包级：npm 会核对的完整性
npm pack --dry-run   # 或对收到的 tgz 校验 sha256 / integrity

# c. 字节级：tarball 里的 exe 必须与源文件同 hash
tar -xzf dsh-rust-exec-1.0.0.tgz -C <tmp> ; (Get-FileHash <tmp>\package\bin\dsh-rust-worker.exe -Algorithm SHA256).Hash

# d. 可执行级（本次实测通过，1314 ms 内完成握手）
node <smoke.mjs> <exe>   # 发 hello{protocol:1,...} + initialize，看 reply
```

`hello` 的成功返回（节选，真实输出）：

```json
{"id":1,"jsonrpc":"2.0","result":{"caps":["fs.read","fs.write","fs.edit","fs.stat","fs.list","exec","search.text","search.symbol","index.status","worker.health"],"protocol":1,"version":"0.1.0","workerPid":28556,"hostPid":14348,"indexGen":0,"lockFile":"C:\\Users\\keer_\\.dsh\\run\\dsh-rust-worker-default.lock"}}
```

`initialize` 返回 `protocol: 1`、`shell.kind: "powershell"`、`shell.transport: "loopback-tcp"`，
`features` 里应包含 `session.open` / `session.cache.stats`（本次实测包含，说明是带 session 投影的最新构建）。

协议校验点：`HELLO_VERSION = 1`（index.js:30）必须与 worker 的 `PROTOCOL_VERSION` 一致，
不一致时 worker 回 `-32001 protocol mismatch` 并以**退出码 2** 退出 —— 升级 exe 后如果工具全挂，
先怀疑这里。

## 8. 已知限制

1. **没有发布到 npm registry**，也没有 CI：所有"可分发"都是本机 tarball 级别的验证。
2. **exe 未签名**（`Get-AuthenticodeSignature` = `NotSigned`，无 signer）。首次运行可能触发
   SmartScreen / 杀软拦截，企业环境需要人工加白或自行签名。
3. **体积**：单个 exe 2.06 MiB 占了包的 96%；tarball 969.6 kB。想瘦身只能开 `cargo` 的
   `strip`/`lto`/`panic=abort`，或者把 zstd/ring 等依赖改成特性开关，收益与风险都要单独评估。
4. **只支持 Windows x64**（见 §5）。
5. **`private: true`**：阻止误发布，同时也意味着 `npm publish` 需要先改这个字段。
6. **`bin/` 还没被 `index.js` 解析**（见 §4）—— 这是目前唯一的功能性缺口。
7. **`WORKER_CWD` 写死**（index.js:19）：裸机上指向不存在的目录。
8. **lock 文件是诊断性的**：worker 在 `%USERPROFILE%\.dsh\run\dsh-rust-worker-<profile>.lock` 写
   `pid\ninstance`，被强杀时不会清理（`release_lock` 只有正常退出才跑）。残留文件不影响启动
   （宿主 `#reapStale` 会读它并尝试 kill 那个 pid，失败即忽略），但会误导排查。
   > 备注：本次冒烟测试用的那个 worker 被强杀，留下过一个指向已死 pid 的 lock 文件；下一次正常
   > `hello` 会覆盖它，无需特殊处理。
9. **无版本协商**：`package.json` 的 `1.0.0` 与 worker 的 `0.1.0` 是两套号，exe 升级不一定会 bump 包版本，
   只能靠 sha256 判断"装的是哪个 worker"。

## 9. 还缺什么（按优先级）

| 优先级 | 事项 | 说明 |
| --- | --- | --- |
| P0 | `index.js` 支持 `bin/` 兜底 + 可配置 `WORKER_CWD` | 否则内嵌 exe 是死重（§4 有建议代码） |
| P0 | 装完自检：exe 存在性 + sha256 + `hello` 握手 | 现在失败表现为"工具调用超时"，很难定位 |
| P1 | `bin/dsh-rust-worker.exe.sha256` 随包分发 | 让用户能离线核对；需同步加进 `files` |
| P1 | `os`/`cpu` 声明或安装期平台检查 | 避免非 Windows 上"装成功但不可用" |
| P2 | 交叉编译矩阵（linux-x64 / mac-arm64） | worker 里 PowerShell/`OpenProcess` 是硬绑定，改动量大 |
| P2 | 代码签名 + 发布流水线（bump version、生成 tarball、上传 registry） | 目前完全没有 |
| P3 | `strip` + `lto` 压体积，或把 exe 改成按需下载 | 目前 2.06 MiB / 969.6 kB 可接受 |
