# dsh-native 分发与跨机安装（1.7.0 · 2026-10-26）

> 本文回答一个问题：**怎么把 `packages/dsh-rust-exec` 变成能装到另一台机器上的东西**，以及装完怎么验收、出问题怎么查。
> 发布到 npm registry、提交插件市场见 [PUBLISHING.md](PUBLISHING.md)。1.7.0 的包名变更见 [PACKAGE_RENAME_1.7.0.md](PACKAGE_RENAME_1.7.0.md)；历史差异看 [CHANGELOG](../../packages/dsh-rust-exec/CHANGELOG.md)。

## 0. 当前产物（唯一有效记录）

| 项 | 值 |
| --- | --- |
| 包名 / 版本 | `dsh-native@1.7.0`（1.7.0 起去掉 scope；worker 的 `Cargo.toml` 仍是 `0.1.0`，两套版本号刻意不统一） |
| tarball | `bin/dsh-native-1.7.0.tgz` · **1 088 625** 字节 · 11 个文件 |
| tarball sha256 | `15E67FF101AA635BEA3712719F81E14C17CB02FFB515DE9B147DEBE30E3D5DB7` |
| 包内 exe | `bin/dsh-rust-worker.exe` · 2 287 104 B · sha256 `9B07BB54CA2F4E839E9BA640EC8A4E6B546D87202AD1C4261CB796E68D239E50` |
| `index.js` | 144 968 B · sha256 `35DDDC5FC4BBCCABA2AC093F34363B91E788B77942C2E57B74579374258F87AC` |
| `client.js` | 102 820 B · sha256 `53FE7E8FBB4AB010B7B27678207F6122DC81372E09A38E9C1A75F2E37DC64A6B` |
| 包内文件 | `package.json`、`README.md`、`LICENSE`、`CHANGELOG.md`、`index.js`、`client.js`、`cordis.patch.yml`、`icon.svg`、`locale/{en,zh}.json`、`bin/dsh-rust-worker.exe` |
| 平台 | 仅 win32-x64；exe 未签名（首次运行会被 SmartScreen 拦一次）；依赖目标机自带的 Windows PowerShell 5.1 |

> 旧产物在 `dist/`（1.5.1 / 1.6.0 / 1.6.1 的历史归档，已 gitignore），**只有 `bin/` 里这一份是「当前版本」**。
> npm 上旧 scope 包 `@keer1024/dsh-native` 停在 1.6.1（2026-10-26 09:26 CST 发布）；裸名 `dsh-native`
> 由本仓库占位（`0.0.0-stage`），1.7.0 在该名下发布。

包名三处必须一致，否则重启会出现 `web boot: 1 entry did not activate`：

1. `package.json` → `name`
2. `cordis.patch.yml` → `- id:`（以及 `name:`）
3. `client.js` → `__ModuleLoader__.load({ id: ... })`

改完跑 `node tools/check_client_identity.mjs` 应得 20/20。

## 1. 打出 tarball

```powershell
cd E:\study\dsh-plugin
node --check packages\dsh-rust-exec\index.js
node --check packages\dsh-rust-exec\client.js
node tools\check_client_identity.mjs
node tools\build_plugin.mjs --skip-rust --no-archive   # 或 npm pack ./packages/dsh-rust-exec --pack-destination bin
tar -tzf bin\dsh-native-1.7.0.tgz        # 正好 11 个文件
(Get-FileHash bin\dsh-native-1.7.0.tgz -Algorithm SHA256).Hash
```

- `npm pack packages\dsh-rust-exec` **不带 `./`** 会被 npm 当成 GitHub 简写（`ssh://git@github.com/packages/...`）直接失败，必须写 `./packages/...`。
- 只收 `package.json` 的 `files[]` 白名单；`bin/*.old`、`src/`、测试脚本、`dist/` 都不会进包，`README.md`/`LICENSE`/`package.json` 由 npm 自动带上。

## 2. 在另一台机器安装

目标机先装好 DSH 桌面版（Windows 10/11 x64；自带 pnpm 与 PowerShell 5.1，无需另装 Node）。

### 路线 A：tarball（离线，推荐）

1. 拷 `dsh-native-1.7.0.tgz` 到目标机，例如 `C:\dsh\dist\`。
2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：
   ```json
   {
     "dependencies": { "dsh-native": "file:C:/dsh/dist/dsh-native-1.7.0.tgz" },
     "dsh": { "profile": { "bundles": [
       "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-native"
     ] } }
   }
   ```
   `dependencies` 负责装包，`dsh.profile.bundles` 负责本次启动挂载 —— **两处都要有**。
3. 在 profile 目录执行 `pnpm install`（或直接用 DSH 的插件管理页安装同一个 tarball）。
4. `Test-Path .\node_modules\dsh-native\bin\dsh-rust-worker.exe` → `True`。
5. 重启 DSH。

### 路线 B：目录 link（开发机方式，改代码即时生效）

把 `packages\dsh-rust-exec` 拷到目标机，`dependencies` 写
`"dsh-native": "link:C:/dsh/plugins/dsh-native"`，`bundles` 同样加 `"dsh-native"`，再 `pnpm install` + 重启。
改 `index.js` 需重启；改 `client.js` 刷新页面即可。

### 路线 C：npm registry

包名自 1.7.0 起是无 scope 的 `dsh-native`，发布后 `dependencies` 写 `"dsh-native": "^1.7.0"` 即可。
发布流程与 2FA 要求见 [PUBLISHING.md](PUBLISHING.md)。

> 从旧版升级：把 profile 里 `dependencies` 的键与 `bundles` 里的 `@keer1024/dsh-native` 同时改成
> `dsh-native`，`pnpm install` 后重启。旧的 `@keer1024/dsh-native@1.6.1` 仍可回退使用。

## 3. 装后验收

| 检查 | 期望 |
| --- | --- |
| 设置页 → 插件 | 出现 `dsh-native` 标签页，顶部只有「刷新」「监控器」两个按钮 |
| 输入框下沿状态条 | `● R-Native  CPU: 0%  -  RSS: 26M  -  运行中: 1  -  队列: 0`，两位数变化时其他项不位移 |
| `GET /api/dsh-rust-exec/health` | 200，含 `hostPid`、`worker.pid`、`routes: 7` |
| 工具列表 | `rust_exec`、`rust_read`、`rust_search`、`rust_symbols`、`rust_session_open` 等 |
| 会话页 `R-Native 视图` | 顶部栏与右侧 420px 详情固定，只有消息列表滚动；类别为下拉 |
| 监控器 | 卡片显示当前值 + min/max + sparkline；Workers / 活动会话两张表 |
| 重启 DSH | 不出现 `web boot: 1 entry did not activate` / `duplicate factory registration` |

## 4. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 重启后没有 `rust_*` 工具 | `dsh.profile.bundles` 缺 `dsh-native`（只写 `dependencies` 不够），或没跑 `pnpm install` |
| `web boot: 1 entry did not activate` / `duplicate factory registration` | 包名与注册 id 不一致；跑 `node tools/check_client_identity.mjs` |
| `Cannot find module 'dsh-native'` | profile 里没装依赖，回路线 A 第 3 步 |
| 工具报 `拒绝访问 (os error 5)` 写 `%TEMP%` 或 `~/.dsh` | worker 以低完整性级别运行，只能写工作区；预期限制 |
| 首次 `exec` 3–20 秒 | PowerShell 冷启动（Defender 扫描）；之后同 lane 毫秒级，DSH 启动时已预热 |
| SmartScreen 拦截 | exe 未签名，点「更多信息 → 仍要运行」；正式分发需代码签名 |
| 状态条/视图不更新 | 页面拿到旧 client bundle；刷新页面，仍不行重启 DSH |

## 5. 升级与回滚

1. 改代码 → bump `package.json` 的 `version` → `npm pack` → 更新本文件 §0 的数字。
2. 停掉占用 exe 的 worker：`Get-Process dsh-rust-worker -ErrorAction SilentlyContinue | Stop-Process -Force`。
3. 覆盖 `bin/dsh-rust-worker.exe` 时若报「正由另一进程使用」，先 `Move-Item` 改名为 `.old` 再复制（Windows 允许重命名运行中的镜像）。
4. 目标机 `pnpm install`（新 tarball）→ 重启 DSH。
5. 回滚＝把 `dist` 里上一版 tarball 重新装上，`version` 回退同样的三处引用。

**exe 的 sha256 才是契约**：包版本可能因文档改动而变，worker 换没换只看 §0 的 exe 指纹。
