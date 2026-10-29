# DSH 原生工具 schema 实测（2026-10-29）

目的：给「节省」报表一个**原生对照基线**——不再拿本插件 1.4.1 的 1,812 tok 当分母，而是直接量
DSH 自己发的工具定义每请求要多少 token。

## 1. 环境

| 项 | 值 |
|---|---|
| 运行时 | `D:\deepseekHarness\dsh\resources\app.asar`（182,434,783 B，单文件，非目录） |
| 包 | `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.3** |
| profile | `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`（**未**启用 `dsh-tool-str-replace-editor`） |
| 分词 | js-tiktoken **cl100k_base**（与 1,812 / 719 那两次测量同一套） |
| Node | v24.13.0 |

## 2. 量法（可复现）

1. `_native/measure/asar.mjs` 读 asar 头。**坑**：`dataStart` 是 `16 + headerSize + 1`（header 之后
   还有一个长度字节），少算 1 会让每个文件少末尾 `}`、并把下一个文件首字节带进来。校准时用 623 个
   `package.json` 逐偏移试：`+0` → 74 通过 / 549 坏，`+1` → **623 通过 / 0 坏**（`_native/measure/calib.mjs`）。
2. `_native/measure/extract_native.mjs` 把 `dsh/node_modules/**` 顺序落盘到 `.tmp/native`
   （15,558 个文件，跳过 2,630 个 unpacked/link 条目，约 175 s）。
3. `_native/measure/native_tools.mjs` 逐个 `import` `dsh-tool-*/lib/index.js`，用 Proxy 桩 `ctx`
   收 `ctx.tools.register(defineTool({…}))` 的定义。两个包必须有配置才能注册：
   `dsh-tool-fs-search: { sampleOverCapGlobResults: true }`、`dsh-tool-todo: { allowParallelInProgress: false }`。
   产出 `_native/measure/native_tools.json`（34 个工具）。
4. `_native/measure/native_tokens.mjs` 对每个定义算
   `cl100k(JSON.stringify({ name, description, parameters }))`——与 1.4.1/1.7.x 那两次测量**同一量法**，
   所以可以直接相减。

未捕获到的：`dsh-tool-session-query`（依赖包 `dsh-session-format-catalog` 在抽取后 import 失败）、
`dsh-tool-subagent` 与 `dsh-experimental-tool-agent-team`（懒注册，`apply()` 时注册 0 个）。
这三项不参与下面的对照（本插件也没有对应工具）。

## 3. 逐工具实测（cl100k，total = desc + params + name 开销）

| 工具 | total | desc | params |
|---|---:|---:|---:|
| `pwsh` | 758 | 456 | 292 |
| `workflow` | 736 | 373 | 345 |
| `schedule_create` | 691 | 79 | 602 |
| `schedule_update` | 549 | 42 | 497 |
| `ask_user_question` | 256 | 20 | 225 |
| `edit` | 234 | 13 | 212 |
| `update_goal` | 191 | 5 | 176 |
| `write` | 174 | 11 | 154 |
| `todo_write` | 173 | 58 | 105 |
| `glob` | 166 | 48 | 109 |
| `terminal_send` | 161 | 44 | 107 |
| `present` | 159 | 54 | 96 |
| `grep` | 152 | 40 | 103 |
| `create_worktree` | 138 | 63 | 64 |
| `job_output` | 128 | 24 | 94 |
| `terminal_open` | 118 | 29 | 79 |
| `send_message` | 112 | 37 | 65 |
| `create_goal` | 109 | 43 | 55 |
| `interrupt_agent` | 102 | 52 | 40 |
| `read` | 99 | 14 | 76 |
| `terminal_signal` | 99 | 15 | 74 |
| `terminal_read` | 90 | 15 | 65 |
| `read_image` | 81 | 36 | 35 |
| `job_kill` | 76 | 8 | 58 |
| `skill` | 68 | 28 | 31 |
| `working_directory` | 68 | 29 | 29 |
| `web_search` | 66 | 19 | 37 |
| `schedule_delete` | 60 | 25 | 25 |
| `web_fetch` | 56 | 17 | 29 |
| `terminal_close` | 50 | 15 | 25 |
| `job_list` | 36 | 18 | 9 |
| `get_goal` | 34 | 16 | 9 |
| `terminal_list` | 28 | 10 | 9 |
| `schedule_list` | 27 | 9 | 9 |
| **合计 34 个** | **6,045** | | |

## 4. 对照基线怎么取（为什么是 1,583 而不是 6,045）

`rust_*` 与本插件**增量注册**（没有 unregister/disable 原生工具），所以「6,045 − 719」不是诚实口径：
原生工具还在，用户真要用 `rust_*` 顶掉的是**同功能的六个**。

| 原生工具 | tok | 本插件常驻对应 |
|---|---:|---|
| `read` | 99 | `rust_read` |
| `write` | 174 | （`rust_exec` 内假 write） |
| `edit` | 234 | （同上） |
| `glob` | 166 | `rust_search` |
| `grep` | 152 | `rust_search` |
| `pwsh` | 758 | `rust_exec` |
| **合计** | **1,583** | 常驻五工具 **719** |

- `str_replace_editor` 单独量到 **708 tok**，但 `dsh-base/cordis.patch.yml` 里没有这个包，本 profile
  不发这个工具，所以**不计入**（若哪天启用，基线变成 1,583 + 708 = 2,291）。
- `read_image` / `todo_write` / `web_*` / `schedule_*` / `terminal_*` / `job_*` 等本插件没有替代，
  也不计入——它们和插件同时存在，算进来只会虚高。

结论：**每轮固定节省 = 1,583 − 719 = 864 tok**（1.7.3 的 1,093 是用插件自己的 1.4.1 当分母，
口径不对，1.7.4 换掉）。之所以比 1,093 小，是因为 1.4.1 一个插件就发了十个工具（1,812），
而原生只发六个同功能工具（1,583）——原生工具面本来就比那个版本瘦。

## 5. 落地

- 宿主 `packages/dsh-rust-exec/index.js`：`SAVINGS_NATIVE_TOOLS = { read: 99, write: 174, edit: 234, glob: 166, grep: 152, pwsh: 758 }`，
  `SAVINGS_PER_TURN_BASELINE = Object.values(SAVINGS_NATIVE_TOOLS).reduce((sum, n) => sum + n, 0)`（=1,583），
  `savingsSnapshot()` 把整张表随 `nativeTools` 一起返回，方便面板/接口自证。
- 前端 `packages/dsh-rust-exec/client.js`：副标题 `原生 1,583 → 当前 719`。
- 测试 `tools/monitor_render_test.mjs`：断言 `864`，并断言副标题里**没有** `1,812`。
