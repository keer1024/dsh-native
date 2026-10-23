# 发布与维护手册（dsh-native）

面向维护者：把 `packages/dsh-rust-exec` 打包、发布、提交到插件市场，以及之后的版本与回滚策略。
命令都在 Windows PowerShell 下验证过；**`npm publish` 与提 PR 需要维护者本人执行**，本文只给步骤与判据。

---

## 0. 先决事实（2026-10-22 核实）

| 项 | 结论 |
|---|---|
| npm 包名 | **`@keer1024/dsh-native`**（1.5.0 起启用 scope；裸名 `dsh-native` 当时未被占用，保留给未来公共分发） |
| 历史名称 | `dsh-flash` 已被第三方占用（`1.1.0`）→ 1.4.0 改名 `dsh-native` → 1.5.0 加 scope |
| 发布账号 | `npm whoami` → `keer1024`；**发布要求 2FA**：`npm publish --otp <6 位>`，或用勾选 Bypass 2FA 的 Granular Access Token |
| 市场目录仓库 | [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，数据在 `data/plugins/`，一个插件一个 YAML |
| 安装前提 | `package.json` 必须声明 `dsh.bundle.patch`（我们已有 `./cordis.patch.yml`），否则市场判为不可安装 |
| 提交粒度 | 一个 PR 最多 3 条；更新自己的条目只改自己那一个文件；README 由脚本生成，不要手改 |
| 审核 | CI 先过（manifest / 仓库满 1 天 / YAML 格式 / README 可再生成），再由维护者读源码核对描述 |

**包名决策**

1. 当前发布名为 `@keer1024/dsh-native`，命令固定带 `--access public`（scoped 包不带会按私有包收费失败）。
2. 若要换 scope 或回到裸名，三处必须一起改：`package.json` 的 `name`、`cordis.patch.yml` 的 `name`/`id`、
   `client.js` 的注册 id；`tools/check_client_identity.mjs` 会把不一致直接判红 —— 半途改名会导致重启
   `duplicate factory registration`（1.2.1 与 1.5.1 各踩过一次）。
3. 不发布 npm 也能上架：把 `npm pack` 产物挂到 GitHub Release，市场条目用 `tarball:` 指向它。

市场条目里的 `name:` 用的是仓库（如 `keer/dsh-native`），与 npm 包名无关，所以改名不影响上架。

---

## 1. 发布前清单（代码侧）

```powershell
cd packages\dsh-rust-exec
node --check index.js; node --check client.js
node ..\..\tools\check_client_identity.mjs          # 包名 / client 注册 id / patch 名 / files[] 一致
node ..\..\tools\worker_test.mjs                    # 15 项协议
node ..\..\tools\lifecycle_test.mjs                 # 10 项生命周期
node ..\..\tools\reap_guard_test.mjs                # 7 项锁安全
node ..\..\tools\pool_test.mjs                      # 10 项治理
npm pack --dry-run                                  # 看清单与体积（不应包含 .old / .tmp / target）
```

`package.json` 的这些字段已在 1.5.1 补齐（发布前只需核对，不必重写）：

```jsonc
{
  "name": "@keer1024/dsh-native",
  "version": "1.5.1",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/keer1024/dsh-native.git" },
  "homepage": "https://github.com/keer1024/dsh-native#readme",
  "bugs": { "url": "https://github.com/keer1024/dsh-native/issues" },
  "engines": { "node": ">=20" },
  "os": ["win32"], "cpu": ["x64"],
  "publishConfig": { "registry": "https://registry.npmjs.org", "access": "public" }
}
```

- `bin/dsh-rust-worker.exe` 必须与 `packages/dsh-rust-worker` 源码同版本构建（把源码与 `Cargo.lock` 一起进仓库）。
- 体积参考：exe ≈ 2.25 MB，`npm pack` 产物 1.0–1.2 MB（gzip 后）。
- 记录 exe 的 sha256，发布说明里带上，便于用户核对。

## 2. npm 发布（维护者执行）

```powershell
cd packages\dsh-rust-exec
npm whoami --registry=https://registry.npmjs.org      # 期望 keer1024
npm publish --access public --otp <6 位验证码>          # 2FA 账号必须带 OTP，或改用 Bypass-2FA 的 Granular Token
```

- `~/.npmrc` 的 registry 可能指向 `registry.npmmirror.com`（只读镜像）；`publishConfig` 已把发布源固定到官方源，**不要**用 `--registry` 覆盖成镜像。
- 2FA 只接受 6 位 TOTP；恢复码（recovery codes）与 `--otp` 不通用，只能在网页端重新绑定验证器或生成 Granular Token。

### 2.1 GitHub Packages（仓库里 `.npmrc` 指向的通道，无需 2FA）

`packages/dsh-rust-exec/.npmrc` 把 `@keer1024` 映射到 `https://npm.pkg.github.com`，所以**默认 `npm publish` 发到 GitHub Packages**：

```powershell
$env:NODE_AUTH_TOKEN = '<有 write:packages 权限的 PAT>'
npm publish                       # 读到 .npmrc 的 scope 映射 → GitHub Packages
```

- 版本不可覆盖：每次发布必须先 bump `version` 并打 tag（`packages/dsh-rust-exec/.github/workflows/publish.yml` 在 `v*` tag 上自动跑，先校验 tag 与 `package.json` 版本一致）。
- 安装方需要 `@keer1024:registry=https://npm.pkg.github.com` 与一个有 `read:packages` 的 token（写在 `~/.npmrc` 的 `_authToken`）。
- 想发公共 npm 时临时覆盖 scope 的源（裸 `--registry` 对 scoped 包无效）：
  `npm publish --@keer1024:registry=https://registry.npmjs.org --otp <6 位>`。
- ⚠️ 该 workflow 假定 **`package.json` 在仓库根**；如果仓库像交付目录那样把包放在 `packages/dsh-rust-exec/`，要把 workflow 移到仓库根并给 `npm publish` 加 `working-directory: packages/dsh-rust-exec`，否则 tag 触发会因找不到 `./package.json` 失败。

发布后立刻验证安装链路（干净 profile）：

```powershell
$env:DSH_PROFILE='pubtest'   # 或在插件管理里新建测试 profile
dsh plugin add <包名>        # 等价于插件市场的安装动作
# 重启 DSH → 新会话里应能看到 10 个 rust_* 工具
# 浏览器刷新一次 → 设置页出现 dsh-native 标签页 + 「监控器」按钮
dsh plugin remove <包名>     # 再装回，确认可卸载、可重装
```

## 3. 上架市场（一个 YAML 文件）

Fork `awesome-dsh-plugin/awesome-dsh-plugin`，新增 `data/plugins/<owner>__<repo>.yml`：

```yaml
url: https://github.com/<owner>/<repo>
name: <owner>/<repo>
category: tools
description:
  en: 'dsh-native: a resident Rust worker handles command execution, sha256-guarded file IO, code indexing and search, session-log projection and resource sampling; the host stays a thin JSON-RPC, lane-scheduling, 7-route layer. The UI adds a pinned-header projection view with fuzzy filtering and a fixed 420 px detail pane, a Grafana-style monitor with lifetime min/max and sparklines, and the R-Native resource strip.'
  zh: 'dsh-native：常驻 Rust worker 承担命令执行、sha256 校验的文件读写、代码索引与检索、会话日志投影与资源采样；宿主只做 JSON-RPC 管道、lane 调度与 7 条 HTTP 路由。界面提供固定头部的会话投影视图（模糊筛选、固定 420px 详情）、Grafana 风格监控器（生命周期 min/max + sparkline）和 R-Native 资源状态条。'
npm: @keer1024/dsh-native   # 发了 npm 才写；否则删掉这行
# tarball: https://github.com/keer1024/dsh-native/releases/download/v1.5.1/keer1024-dsh-native-1.5.1.tgz
screenshots:
  - docs/rust-exec-plugin/assets/settings-tab.png
```

要点：
- `description.en` 必填、以句号结尾；含 `: ` 必须加引号（否则 YAML 解析成嵌套键）。
- `category` 从固定集合里选：`tools` 最贴切（也可论证 `dev`）。
- 截图走仓库内相对路径，或 GitHub 托管的 https 绝对地址；第三方图床会被拒。
- 一个 PR ≤ 3 条；只改自己那条，不要顺手改别人的描述。
- 仓库要满 1 天、有真实代码、`package.json` 里 `dsh.bundle.patch` 存在——这三条是最常见的被拒原因。

## 4. 上架后验证

```powershell
# 市场安装 → 重启 → 验收
node tools\check_client_identity.mjs
node tools\live_route_check.mjs          # 7 条路由 + 10 个工具
```

浏览器里逐项确认：设置页 `dsh-native` 标签页、监控器浮层（数字卡片 + 生命周期 min/max + sparkline）、会话投影视图、
`R-Native` 状态条；再确认**重启一次 DSH 不报 `web boot: … entry did not activate`**
（这是 1.2.1 修掉的问题，回归必查）。

## 5. 维护

**版本语义**
- 修 bug / 兼容性修复 → patch（1.2.x）；新工具或新路由 → minor；改名、删工具、改路由前缀 → major。
- 每次发布：`CHANGELOG.md` 顶部加条目 → 同步 `package.json` 版本 → `git tag vX.Y.Z` → GitHub Release 附 tarball 与 exe sha256。

**兼容矩阵（发布说明里贴一张）**

| 组件 | 期望 |
|---|---|
| DSH | 记录实测通过的版本（当前 0.2.1-rc.2 / Electron 44 / Node 24） |
| Node | ≥ 22（host 插件只用 `node:` 内置模块） |
| Windows | 10/11 x64；低完整性沙箱下已验证（`-EncodedCommand`、宿主写锁） |
| 其他平台 | 未验证：worker 是 Windows PE，macOS/Linux 需要另出二进制 |

**升级与回滚**
- 升级：`dsh plugin add <包名>@<新版本>` → 重启 → 跑第 4 节验收。
- 回滚：`dsh plugin add <包名>@<旧版本>`；npm 侧可用 `npm deprecate <包名>@<坏版本> "reason"`，
  必要时 `npm unpublish`（24 小时内且无依赖才允许）。
- 破坏性改动的兜底：市场条目里保留 `tarball:` 指向最后一个已知良好版本。

**issue / PR 模板建议**
- issue：DSH 版本、OS、`rust_health` 输出、`~/.dsh/run/dsh-rust-worker-*.lock` 内容、是否重启后复现。
- PR：变更点、影响面（工具/路由/客户端槽位）、跑过的验收脚本与结果、CHANGELOG 是否更新。

**CI 建议**
- 每次 push：`node --check`、`check_client_identity`、`worker_test`、`reap_guard_test`、`panel_render_test`。
- tag 构建：`cargo build --release` → 比对 exe sha256 → `npm pack` → 上传 Release。
- 别把 `lifecycle_test` / `pool_test` 放进快速 CI（要真实进程，10 分钟级），放 nightly。

## 6. 私有分发（不发布 npm 的备选）

1. **本地 bundle**：把 `packages/dsh-rust-exec` 目录给用户，`dsh plugin add <本地路径>`。
2. **link 依赖**：`"dsh-native": "link:C:/path/to/packages/dsh-rust-exec"`，并把它加进 profile 的
   `dsh.profile.bundles`——两条都写才算挂载（这是本机当前的形态）。
3. **GitHub Release tarball**：`npm pack` 产物挂 Release，市场条目用 `tarball:` 字段。

任一方式都要提醒用户：**首次安装后刷新页面一次**，并重启 DSH 让 host 侧重新加载。
