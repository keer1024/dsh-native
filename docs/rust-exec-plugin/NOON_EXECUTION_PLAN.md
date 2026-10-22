# 12:00 执行清单：把 Rust 工具链装进 `D:\software\rust` 并开始插件实施

> 触发方式：会话内定时提醒（2026-10-19 12:00 Asia/Shanghai）。
> 本文件是执行时的操作手册，命令可直接复制运行。

## 0. 目标布局（用户指定根目录）

```
D:\software\rust\
  rustup\      # RUSTUP_HOME（工具链本体、target、组件）
  cargo\       # CARGO_HOME（bin\cargo.exe、registry 缓存、config.toml）
  mingw64\     # MinGW-w64（gnu 目标的链接器）
  download\    # 安装包缓存
```

用户级环境变量（持久化，写入后新开 shell 生效）：

| 变量 | 值 |
|---|---|
| `RUSTUP_HOME` | `D:\software\rust\rustup` |
| `CARGO_HOME` | `D:\software\rust\cargo` |
| `PATH`（追加） | `D:\software\rust\cargo\bin` ; `D:\software\rust\mingw64\...\bin` |

## 1. 已核查的前置事实（2026-10-19 上午）

| 项 | 结果 | 影响 |
|---|---|---|
| 管理员权限 | ✅ 有 | 可写系统级/用户级环境变量、winget 安装 |
| `D:\software\rust` | 空目录已存在 | 直接使用，无需新建 |
| 磁盘 | C: 剩余 10GB / D: 剩余 17GB | 装 D:，`minimal` profile 约 0.8–1.5GB |
| rustup-init 下载 | ✅ HTTP 200，12,721,664 B | 从 `static.rust-lang.org` 直连可用（清华镜像 404，不用） |
| MSVC Build Tools / Windows SDK / `link.exe` | ❌ 全部缺失 | **msvc 目标无法链接**，必须走 GNU |
| MinGW | ❌ 无 | 用 winget 装 WinLibs |
| winget | ✅ 可用；`BrechtSanders.WinLibs.POSIX.UCRT` = 16.2.0 | 链接器来源 |

**结论**：使用 `stable-x86_64-pc-windows-gnu` + WinLibs MinGW（UCRT、POSIX 线程）。
备选（先试，能省一个依赖）：`msvc` 目标 + `rust-lld` 自包含链接（`-C linker=rust-lld -C link-self-contained=+linker`）。若失败立即回落 GNU，不要纠缠。

## 2. 执行步骤

### 2.1 目录与环境变量（先做，后续命令都依赖）
```powershell
$ROOT = 'D:\software\rust'
foreach ($d in 'rustup','cargo','download','mingw64') { New-Item -ItemType Directory -Force -Path (Join-Path $ROOT $d) | Out-Null }
[Environment]::SetEnvironmentVariable('RUSTUP_HOME', "$ROOT\rustup", 'User')
[Environment]::SetEnvironmentVariable('CARGO_HOME',  "$ROOT\cargo",  'User')
$env:RUSTUP_HOME = "$ROOT\rustup"; $env:CARGO_HOME = "$ROOT\cargo"
$uPath = [Environment]::GetEnvironmentVariable('Path','User')
if ($uPath -notlike "*$ROOT\cargo\bin*") { [Environment]::SetEnvironmentVariable('Path', "$uPath;$ROOT\cargo\bin", 'User') }
```

### 2.2 MinGW（gnu 目标的链接器）
```powershell
winget install -e --id BrechtSanders.WinLibs.POSIX.UCRT --location D:\software\rust\mingw64 `
  --accept-package-agreements --accept-source-agreements --disable-interactivity
# 安装后探测真实 bin 目录（WinLibs 常多一层 mingw64\）
Get-ChildItem D:\software\rust\mingw64 -Recurse -Filter gcc.exe | Select-Object -First 3 FullName
```
失败兜底：从 `https://github.com/brechtsanders/winlibs_mingw/releases` 下载对应 zip，解压到 `D:\software\rust\mingw64`，再把 `...\bin` 追加进用户 PATH。

### 2.3 安装 Rust（GNU 目标，minimal profile）
```powershell
Invoke-WebRequest -Uri 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' `
  -OutFile 'D:\software\rust\download\rustup-init.exe' -UseBasicParsing
& 'D:\software\rust\download\rustup-init.exe' -y --no-modify-path --profile minimal `
  --default-toolchain stable-x86_64-pc-windows-gnu
& "$env:CARGO_HOME\bin\rustup.exe" component add rustfmt clippy rust-src
```

### 2.4 链接器配置 + 冒烟测试
```powershell
$gcc = (Get-ChildItem D:\software\rust\mingw64 -Recurse -Filter gcc.exe | Select-Object -First 1).FullName
$cfg = "$env:CARGO_HOME\config.toml"
@"
[target.x86_64-pc-windows-gnu]
linker = "$($gcc -replace '\\','\\')"
rustflags = ["-C", "target-feature=+crt-static"]
"@ | Set-Content -Encoding utf8 $cfg

cargo new C:\Users\keer_\Documents\deepseek-harness\default-workspace\_smoke\hello --bin
Push-Location C:\Users\keer_\Documents\deepseek-harness\default-workspace\_smoke\hello
cargo build --release; .\target\release\hello.exe; Pop-Location
```
验收：`cargo --version`、`rustc -vV` 正常；`hello.exe` 输出 `Hello, world!`；在任意目录新开 shell 能直接调 `cargo`。

### 2.5 紧接着开工（性能优先，P1 → P2）
按 `docs/rust-exec-plugin/ANALYSIS_AND_PLAN.md` §4/§6：
1. `packages/dsh-rust-worker`（Rust bin）：`rpc`（Content-Length 帧 + JSON-RPC 2.0）、`fs`（read/write/apply_patch + 版本守卫）、`exec`（常驻 pwsh 池）。
2. `packages/dsh-rust-exec`（宿主插件，TS）：`ctx.rust` 生命周期 + 工具注册（`defineTool`）+ `cordis.patch.yml` 挂载。
3. 端到端：在 DSH 里真实调用 `rust_exec` / `rust_read` / `rust_write`；worker 崩溃自动重启。
4. 复测：`tools/telemetry4.py` 同口径对比基线（见 §0 摘要：工具时间 71%、spawn 下界 23.1%、模型 26%）。

## 3. 风险与回退

| 风险 | 回退 |
|---|---|
| winget 不支持 `--location` | 装到默认目录后用 `Move-Item` 迁到 `D:\software\rust\mingw64`，或直接下 zip |
| gnu 目标链接报错 | 检查 `config.toml` 的 linker 路径；`+crt-static` 保证单文件 exe |
| 磁盘不足 | `minimal` profile + 只保留 `stable` 工具链；`rustup component` 按需 |
| 12:00 会话不在线 | 定时提醒会在下次可用时补投；不影响本文件内容 |

## 4. 不动的东西
- 不修改 DSH 安装目录与 profile 已装插件（只新增插件包）。
- 不改系统级 PATH（只动用户级）。
- 会话真相源仍由 DSH 的 persistence 写入；插件只读 + 自持可重建投影。
