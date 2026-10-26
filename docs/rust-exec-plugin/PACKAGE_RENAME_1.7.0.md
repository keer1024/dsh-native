# 包名去 scope：`@keer1024/dsh-native` → `dsh-native`（1.7.0 · 2026-10-26）

> 这次只改**包的身份**，不改一行运行时逻辑：worker 二进制与 `index.js` 与 1.6.2 逐字节相同。
> 但它是一次破坏性改名 —— profile 里两处引用、插件三处 id 必须同时换，否则下次重启 DSH 直接起不来。

## 0. 为什么改

1. **文件名污染**：`npm pack` 会把 scope 拼进文件名（`keer1024-dsh-native-1.6.2.tgz`），分发给用户时
   文件名里的个人 ID 既长又无意义；裸名包直接产 `dsh-native-1.7.0.tgz`。
2. **scope 本来只是历史包袱**：1.5.0 加 `@keer1024` 是为了绕开当时 GitHub Packages 对 scope 的要求，
   后来改走 npmjs.com，这条理由已消失。
3. **裸名是我们自己占的**：npm 上 `dsh-native` 的 maintainer 是 `keer1024 <keer_mail@163.com>`，
   `dist-tag latest = 0.0.0-stage`，描述 "Temporary package placeholder for staged publishing"。
   1.7.0 直接在这个名下发布，不用另找名字。

旧的 `@keer1024/dsh-native@1.6.1` 保持可安装，作为未迁移用户的回退点。

## 1. 四处耦合（改一处就会炸）

| 位置 | 文件 | 现在 |
| --- | --- | --- |
| 包名 | `packages/dsh-rust-exec/package.json` → `name` | `dsh-native` |
| 插件 id | `packages/dsh-rust-exec/cordis.patch.yml` → `- id:` | `dsh-native` |
| 插件名 | 同上 → `name:` | `dsh-native` |
| 浏览器注册 id | `packages/dsh-rust-exec/client.js:23` → `__ModuleLoader__.load({ id })` | `dsh-native` |

为什么必须一致：DSH 宿主用 `package.json#name` 作为 client-graph 的行 key，用 `load({ id })` 作为
浏览器端 factory 的注册 key。两者不一致时宿主会**重新下发**同一份 bundle，第二次执行抛
`client-modules: duplicate factory registration for "..."`，整个 web boot 报 `1 entry did not activate`。

第五处是 profile，不参与打包但决定能不能加载：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-native": "link:C:/.../packages/dsh-rust-exec" },   // 键必须叫 dsh-native
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-native"] } }
}
```

## 2. 本次改了什么（逐文件）

- `packages/dsh-rust-exec/package.json`：`name` → `dsh-native`，`version` → `1.7.0`。
- `packages/dsh-rust-exec/cordis.patch.yml`：`id`/`name` → `dsh-native`。
- `packages/dsh-rust-exec/client.js`：注册 id 与文件头注释里的旧名 → `dsh-native`。
- `tools/build_plugin.mjs`：`packTarball()` 在包名没有 scope 时**不改名**（此前 `raw === produced`
  会 `rename` 到自己，报 `ENOENT`）。
- 文档：README（安装命令、升级、排障、分发状态）、`packages/dsh-rust-exec/README.md`（安装段）、
  `DISTRIBUTION.md`（§0 产物表、打包命令、路线 A/B、路线 C、排障表）、`PUBLISHING.md`（包名事实、
  `package.json` 示例、发布命令、市场条目 `npm:`/`tarball:` 行）、`CHANGELOG.md`（1.7.0 段）。

**没改**：工具名 `rust_*`、HTTP 路由前缀 `/api/dsh-rust-exec/*`、worker 镜像名
`dsh-rust-worker.exe`、`%LOCALAPPDATA%\dsh-native` 下的缓存与日志目录、worker 协议。也就是说
已装的 worker 进程和索引缓存不需要迁移。

## 3. 迁移（已装 1.6.x 的用户）

### 3.1 目录 link（本机开发方式，也是本次的验证方式）

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json" "$p\package.json.bak-1.6"      # 先备份
# 编辑 package.json：
#   dependencies 的键     "@keer1024/dsh-native" → "dsh-native"（值不变）
#   dsh.profile.bundles   "@keer1024/dsh-native" → "dsh-native"
cd $p; pnpm install
Test-Path .\node_modules\dsh-native\bin\dsh-rust-worker.exe   # → True
```

### 3.2 tarball

```powershell
npm i .\bin\dsh-native-1.7.0.tgz        # 依赖键改成 "dsh-native"
```

### 3.3 npm（发布后）

```powershell
pnpm add dsh-native@^1.7.0
```

三条路都要改 `dsh.profile.bundles`，然后**重启 DSH**。`index.js` 与 worker 都在包里，重启即生效。

## 4. 本次实测（本机，2026-10-26 19:0x）

```
$ node tools\check_client_identity.mjs --no-profile
  ok   package.json readable (dsh-native@1.7.0)
  ok   registration id matches package name (dsh-native)
  ok   bundle patch name matches package name
  ok   bundle patch id matches package name
  ...
17/17 checks passed
```

带 profile 的 20 项检查在 profile 切换并 `pnpm install` 之后跑（见 §5）。打包产物：

| 项 | 值 |
| --- | --- |
| tarball | `bin/dsh-native-1.7.0.tgz` · 1 088 625 B · 11 个文件 |
| sha256 | `15e67ff101aa635bea3712719f81e14c17cb02ffb515de9b147debe30e3d5db7` |
| worker | 与 1.6.2 同一二进制（2 287 104 B，sha `9b07bb54…`），未重建 |

## 5. 回滚

1. 把 `package.json.bak-1.6` 覆盖回 profile（等价于把两处引用改回 `@keer1024/dsh-native`）。
2. `pnpm install`，确认 `node_modules/@keer1024/dsh-native` 存在。
3. 重启 DSH。

包本身不用动：把部署副本的 `package.json` 改回 `@keer1024/dsh-native@1.6.2`（或直接
`npm i @keer1024/dsh-native@1.6.1`）即可，因为两版运行时完全一致。**但三处 id 必须一起回**，
只回包名不回 `cordis.patch.yml`/`client.js` 就会重复踩 `duplicate factory registration`。

## 6. 发布状态

- npm 上 `dsh-native` 目前是占位 `0.0.0-stage`，1.7.0 **尚未发布**（需要 `npm publish --otp <6位>`）。
- 发布后把市场条目的 `npm:` 行写成 `dsh-native`，`tarball:` 指向
  `releases/download/v1.7.0/dsh-native-1.7.0.tgz`。
- 发布前核对：`npm publish --dry-run` 的清单里应只有 11 个文件，且不含 `*.old`/`src/`/测试脚本。
