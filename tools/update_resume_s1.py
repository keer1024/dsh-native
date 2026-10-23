import io, sys

p = r'C:\Users\keer_\Documents\deepseek-harness\default-workspace\docs\rust-exec-plugin\RESUME.md'
s = io.open(p, encoding='utf-8').read()

old_s1 = """### S1 P2.5 治理收尾（先补语义，再压测）

设计见 `CONCURRENCY_AND_METRICS.md` §2.3；代码里**只有** lane 池 + `maxQueueDepth`/`queueTimeoutMs`，以下 5 项未实现：

1. `maxWorkers` 多进程池 + 空闲回收（`idleReapMs`）+ 热应用（C6：4→2 后新会话落 2 个 worker）。
2. 每会话 `maxInFlightPerSession` + 公平轮转队列（现在是全局 FIFO，大会话能饿死小会话）。
3. `maxShells` 闸门（= `maxWorkers × 2`）。
4. `rssSoftLimitMb` / `cpuSoftLimitPct` **软限动作**：现在只采样不动作；超限应先丢索引（可懒重建）→ 再拒新索引构建 → 再压 `maxIndexThreads`，**exec/fs 永不限**。
5. 空闲 lane 5 min 回收 + `lanes` 计数回落可见。

验收：C5（曲线 vs psapi 偏差 ≤5%）、C6（改配置热生效）+ 回归跑 `tools/concurrency_test.mjs`（现有 10 项必须仍全绿）。"""

new_s1 = """### S1 P2.5 治理收尾 —— ✅ 已完成（2026-10-20 12:30，`tools/pool_test.mjs` 10/10）

落地：`WorkerPool` 多进程池（会话亲和 + 轮转 + 热扩缩/退休）、每会话 `maxInFlightPerSession` + 公平轮转（阻塞会话保持队首，不被饿死）、池级 `maxShells` 排队上限、RSS/CPU 软限动作（先丢索引 → 再暂停构建，**exec/fs 永不限**）、空闲 worker 回收（15 s 巡检，`idleReapMs` 默认 300 s）、`index.pause|resume|drop` RPC。

验收：C5 采样偏差 0.08%、C6a 扩容到 2、C6b 热缩 2→1、C6c 空闲回收、C7 小会话 3/4、C8 `WORKER_BUSY` rejected=7、S1 丢索引 439→0、S2 暂停/恢复、S3 暂停期 exec 正常；回归 `node tools/concurrency_test.mjs 4` 10/10；`GET|POST /api/dsh-rust-exec/config` 热生效（非法值 400）。数字见 `RESULTS.md` §8.5。"""

reps = [
    ('# RESUME — Rust 业务执行插件（2026-10-20 09:10 状态；剩余计划已排序，12:00 起执行）',
     '# RESUME — Rust 业务执行插件（2026-10-20 12:35 状态；S1 已完成，正在做 S2）'),
    ('| S1 | P2.5 治理收尾 | 3–4 h | 无 | C5/C6 过 |',
     '| S1 | P2.5 治理收尾 | 3–4 h | 无 | ✅ 10/10（2026-10-20 12:30） |'),
    (old_s1, new_s1),
]
for a, b in reps:
    if a not in s:
        print('MISS:', a[:50]); sys.exit(1)
    s = s.replace(a, b, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
