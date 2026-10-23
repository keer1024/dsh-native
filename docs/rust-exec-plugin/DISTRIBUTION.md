# dsh-native 分发与跨机安装（1.5.1 · 2026-10-23）

> 本文回答一个问题：**怎么把 `packages/dsh-rust-exec` 变成能装到另一台机器上的东西**，以及装完怎么验收、出问题怎么查。
> 发布到 npm registry、提交插件市场见 [PUBLISHING.md](PUBLISHING.md)。1.0.0 的旧打包记录已删，历史差异看 [CHANGELOG](../../packages/dsh-rust-exec/CHANGELOG.md)。

## 0. 当前产物（唯一有效记录）

| 项 | 值 |
| --- | --- |
| 包名 / 版本 | `@keer1024/dsh-native@1.5.1`（worker 的 `Cargo.toml` 仍是 `0.1.0`，两套版本号刻意不统一） |
| tarball | `dist/keer1024-dsh-native-1.5.1.tgz` · **1 056 035** 字节 · 解压约 2.5 MB · 11 个文件 |
| tarball sha256 | `52DA51DEC530F5B43194B6BCDCBDB5467BEF461FD2939A8BE5389F7FBE10CC00` |
| 包内 exe | `bin/dsh-rust-worker.exe` · 2 276 864 B · sha256 `39C7F35DA1C9B7FA5D64F2E2F57332A7225D072CB238DEED0FDB3A0D7E7CFB76` |
| `index.js` | 107 166 B · sha256 `DA2CCCABF87C87B5E8D11D1349F09B824C5538F6DCD2DE643718343A032E5BF6` |
| `client.js` | 86 201 B · sha256 `89428AE09BF759CA7D3E0D0E88F749AFF6D9699F9043E9965A2D6870098B18BB` |
| 包内文件 | `package.json`、`README.md`、`LICENSE`、`CHANGELOG.md`、`index.js`、`client.js`、`cordis.patch.yml`、`icon.svg`、`locale/{en,zh}.json`、`bin/dsh-rust-worker.exe` |
| 平台 | 仅 win32-x64；exe 未签名（首次运行会被 SmartScreen 拦一次）；依赖目标机自带的 Windows PowerShell 5.1 |

包名三处必须一致，否则重启会出现 `web boot: 1 entry did not activate`：

1. `package.json` → `name`
2. `cordis.patch.yml` → `- id:`（以及 `name:`）
3. `client.js` → `__ModuleLoader__.load({ id: ... })`

改完跑 `node tools/check_client_identity.mjs` 应得 20/20。

## 1. 打出 tarball

```powershell
cd C:\Users\keer_\Documents\deepseek-harness\default-workspace
node --check packages\dsh-rust-exec\index.js
node --check packages\dsh-rust-exec\client.js
node tools\check_client_identity.mjs
npm pack ./packages/dsh-rust-exec --pack-destination dist
tar -tzf dist\keer1024-dsh-native-1.5.1.tgz        # 正好 11 个文件
(Get-FileHash dist\keer1024-dsh-native-1.5.1.tgz -Algorithm SHA256).Hash
```

- `npm pack packages\dsh-rust-exec` **不带 `./`** 会被 npm 当成 GitHub 简写（`ssh://git@github.com/packages/...`）直接失败，必须写 `./packages/...`。
- 只收 `package.json` 的 `files[]` 白名单；`bin/*.old`、`src/`、测试脚本、`dist/` 都不会进包，`README.md`/`LICENSE`/`package.json` 由 npm 自动带上。

## 2. 在另一台机器安装

目标机先装好 DSH 桌面版（Windows 10/11 x64；自带 pnpm 与 PowerShell 5.1，无需另装 Node）。

### 路线 A：tarball（离线，推荐）

1. 拷 `keer1024-dsh-native-1.5.1.tgz` 到目标机，例如 `C:\dsh\dist\`。
2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：
   ```json
   {
     "dependencies": { "@keer1024/dsh-native": "file:C:/dsh/dist/keer1024-dsh-native-1.5.1.tgz" },
     "dsh": { "profile": { "bundles": [
       "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@keer1024/dsh-native"
     ] } }
   }
   ```
   `dependencies` 负责装包，`dsh.profile.bundles` 负责本次启动挂载 —— **两处都要有**。
3. 在 profile 目录执行 `pnpm install`（或直接用 DSH 的插件管理页安装同一个 tarball）。
4. `Test-Path .\node_modules\@keer1024\dsh-native\bin\dsh-rust-worker.exe` → `True`。
5. 重启 DSH。

### 路线 B：目录 link（开发机方式，改代码即时生效）

把 `packages\dsh-rust-exec` 拷到目标机，`dependencies` 写
`"@keer1024/dsh-native": "link:C:/dsh/plugins/dsh-native"`，`bundles` 同样加 scoped 名，再 `pnpm install` + 重启。
改 `index.js` 需重启；改 `client.js` 刷新页面即可。

### 路线 C：npm registry

包名 scope 为 `@keer1024`，发布后 `dependencies` 写 `"@keer1024/dsh-native": "^1.5.1"` 即可。
发布流程与 2FA 要求见 [PUBLISHING.md](PUBLISHING.md)。

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
| 重启后没有 `rust_*` 工具 | `dsh.profile.bundles` 缺 scoped 名（只写 `dependencies` 不够），或没跑 `pnpm install` |
| `web boot: 1 entry did not activate` / `duplicate factory registration` | 包名与注册 id 不一致；跑 `node tools/check_client_identity.mjs` |
| `Cannot find module '@keer1024/dsh-native'` | profile 里没装依赖，回路线 A 第 3 步 |
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
