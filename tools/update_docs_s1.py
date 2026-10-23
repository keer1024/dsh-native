import io, sys

p = r'C:\Users\keer_\Documents\deepseek-harness\default-workspace\docs\rust-exec-plugin\ANALYSIS_AND_PLAN.md'
s = io.open(p, encoding='utf-8').read()

reps = [
    ('### 6.1 执行状态（2026-10-19 更新）', '### 6.1 执行状态（2026-10-20 12:30 更新）'),
    ('详见 `RESULTS.md` §9。限制：worker 仍单进程（多进程 `maxWorkers` 未启用）、冷启动 N lane ≈ N×3 s |',
     '详见 `RESULTS.md` §8。限制：冷启动 N lane ≈ N×3 s |'),
    ('| **P3 会话投影** |',
     '| **S1 P2.5 治理收尾** | ✅ 完成并验收 **10/10**（2026-10-20 12:30） | `tools/pool_test.mjs`：C5 采样偏差 0.08%、C6a 负载扩容到 2、C6b 热缩 2→1、C6c 空闲 worker 回收、C7 小会话不被饿死（3/4 完成）、C8 超队 `WORKER_BUSY` rejected=7、S1 软限丢索引 439→0、S2 暂停/恢复构建、S3 暂停期间 exec 不受限。新增 `WorkerPool`/`maxInFlightPerSession`/公平轮转/`index.pause|resume|drop`/空闲 lane 回收；`GET|POST /api/dsh-rust-exec/config` 热生效（非法值 400）。详见 `RESULTS.md` §8.5 |\n| **P3 会话投影** |'),
    ('| **S1** | P2.5 治理收尾', '| **S1** ✅ 已完成（2026-10-20 12:30） | P2.5 治理收尾'),
    ('合计 17–26 h。S4 是唯一可能因"收益偏体验 + 与 DSH 版本耦合"而主动砍掉的项。',
     '当前进度：S1 ✅ 完成（2026-10-20 12:30，10/10）。剩余 S2–S5 估 13–21 h。S4 是唯一可能因"收益偏体验 + 与 DSH 版本耦合"而主动砍掉的项。'),
]
for a, b in reps:
    if a not in s:
        print('MISS:', a[:50])
        sys.exit(1)
    s = s.replace(a, b, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
