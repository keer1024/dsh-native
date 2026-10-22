# 插槽探测报告（SLOT_PROBE）

> **v1.2.1 状态（2026-10-21）**：本文档保留历史阶段的设计与实测记录；与当前代码不一致处以下列为准：
> 包名已改为 `dsh-flash`（工具名 `rust_*`、路由前缀 `/api/dsh-rust-exec` 保持不变）；lane 徽标与全部 SVG
> 2026-10-22（1.4.0）：包名再次更名为 `dsh-native`；下文历史记录里的 `dsh-flash` 指同一插件。
> 曲线/图表已删除，资源监控改为设置页 `dsh-flash` 标签页顶部的「资源监控 / 资源监控明细」按钮 + 数字卡片；
> 路由共 7 条（metrics、health、events、sessions、session、session/body、config）；v1.2.1 修复重启失败
> （客户端注册 id 与包名不一致导致 web boot 失败）、锁文件误杀、kill 泄漏 PowerShell 孙进程、低完整性下
> shell server 无法启动。详见 `packages/dsh-rust-exec/CHANGELOG.md`。


目的：客户端叠加渲染依赖 DSH 的插槽 ABI。DSH 升级后插槽名/注册参数可能变化，本报告给出**当前事实、探测方法、以及我们代码里的降级行为**，避免"升级后白屏"。

## 1. 当前使用的插槽（2026-10-20，DSH 0.2.0-rc.2）

| 插槽名 | 类型 | 注册参数 | 我们的用途 |
| --- | --- | --- | --- |
| `settings.plugins.tab` | list | `{ id, order, label: string \| (() => string) }` | "Rust 执行器"面板：资源曲线、worker 表、并发/限额表单（S2）、会话投影卡片（S4） |
| `conversation.input.dock` | list | `{ id, order }` | 只读状态徽标 `rust <inflight>/<lanes> · q<queued>`（S4） |
| `conversation.view` | list | `{ id, order, label }` | 注册替代会话视图 `Rust 视图`（S4/②，list 槽可并列切换；**没做真接管**） |
| `sidebar.panellist` | list | `{ id, order, label }` | 「资源监控」入口按钮（S7）：侧栏"Global panel icons"，最接近"顶部栏"的可用槽 |
| `conversation.composer.dock` | list | `{ id, order }` | 对话输入框下方一行缩略：`rust · CPU 12% · RSS 16 MB · 队列 2 · 在飞 2`（S7） |

**可用但未用的候选**（`replaceRisk: none`，升级或换落点时优先考虑）：
- `shell.overlay`（list）：整帧浮层/portal 语义 —— S7 的仪表盘现在是自绘 `position:fixed` 浮层，**应迁移到这里**。
- `sidebar.footer.action`（list）：Settings 旁的动作项。
- `conversation.chat.turnTail`（list）：每轮末尾追加行。
- `tool.call.toolview`（keyed，keyDomain `open`，wire 工具名做键）：可为 `rust_*` 工具做专属卡片；当前 `rust_*` 名字未被占用。

**明确不碰的高风险槽**：`root`、`sidebar`（shadows-shipped-ui）、`main`（keyed，已被 `conversation` 占用，替换等于接管整个主面板）、`conversation.chat.node`（ChatNodeKind 固定键）。

注册方式（两层都要）：

```js
// client.js：注入 slots 服务，然后按插槽名注册
window.__ModuleLoader__.load({
  id: 'dsh-rust-exec',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register({ name: 'settings.plugins.tab', id: 'rust-exec', order: 20, label: () => '…' }, Panel))
      },
    }
  },
})
```

## 2. 探测方法（升级后先跑这三条，别猜）

1. **宿主侧枚举插槽**（只读）：
   `cordis_inspect_query({ platform: 'host', provider: 'Slot', method: 'listSubTrees' })` 或 `Slots.listSubTree`，看 `settings.plugins.tab` / `conversation.input.dock` 是否还在、`kind` 是 list 还是 single、是否已有 occupant（`Kb/all`、`dsh-market` 之类）。
2. **注册参数 schema**：同一 provider 上的 `describe` 类方法（或 `inspect`）给出 registration 字段；`label` 允许 `string | () => string`，用 thunk 才能跟随语言切换。
3. **客户端侧验证**：`node tools/panel_render_test.mjs`（面板）、`node tools/projection_render_test.mjs`（投影卡片 + 徽标）。两者都用 jsdom 真实挂载 `client.js`，桩掉 `window.__ModuleLoader__`，断言两次注册都发生、各状态渲染正确——**这是改 ABI 后的回归闸门**。

## 3. 我们代码里的降级行为（关键）

- 两个 `ctx.slots.inject` 各包一层 `try/catch`，任一插槽不存在或参数校验失败 ⇒ 该注册静默跳过，**另一个照常注册**，页面其余部分不受影响（`packages/dsh-rust-exec/client.js` 的 `apply()`）。
- 徽标在 `GET /api/dsh-rust-exec/metrics` 不可用时 `return null`（不渲染空壳、不占位、不报错）。
- 面板在 metrics 拿不到时保留旧数据并显示降级提示；轮询失败不清空、不抛错到 React 边界。
- `package.json` 的 `dsh.client.inject` 只声明 `@deepseek-ai/dsh-client-ui-slots` 与 `@deepseek-ai/dsh-client-locale` 两个公共包；未用 `immediately: true`，因此面板不要求早于 shell 加载。

## 4. 已知时间点上的事实（便于对比升级前后）

- 已打开的页面**不会**热插新客户端模块：`client.js` 在页面加载时由 `clientModules` 拉取，装/改插件后需刷新一次才生效。
- 宿主侧 `cordis_inspect` 的 `Tool.listTools` 可确认 10 个 `rust_*` 工具在线；`Settings.plugins.tab` 的 occupant 列表可确认面板是否挂上。
- 当前面板/徽标均为"只读叠加"，不持有会话状态、不接管对话区滚动容器；因此即使插槽内部实现变化，最坏结果是叠加物消失，不会破坏对话渲染。
