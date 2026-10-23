# Validate the LLM-wait measurement: does wait scale with output size? What is the per-step budget?
import sys, os, json, glob, statistics as st
sys.path.insert(0, r"C:\Users\keer_\Documents\deepseek-harness\default-workspace\_tools\pyzstd")
import zstandard as zstd
ROOT = r"C:\Users\keer_\.dsh\sessions"

def load(p):
    with open(p, "rb") as fh:
        with zstd.ZstdDecompressor().stream_reader(fh, read_across_frames=True) as rd:
            raw = rd.read()
    recs = [json.loads(l) for l in raw.decode("utf-8", "replace").split("\n") if l.strip()]
    recs.sort(key=lambda r: r.get("seq", 0))
    return recs

waits, outputs, step_totals, tool_totals = [], [], [], []
for p in sorted(glob.glob(os.path.join(ROOT, "*", "*", "session*.jsonl.zstd"))):
    recs = load(p)
    starts, ends = {}, {}
    for r in recs:
        ty, d, t = r.get("type"), r.get("data") or {}, r.get("time")
        k = (d.get("turn"), d.get("step"))
        if ty == "step/start": starts[k] = t
        elif ty == "step/end": ends[k] = t
        elif ty == "assistant/message" and k in starts and t:
            m = d.get("message") or {}
            n = sum(len(b.get("text") or "") + len(b.get("arguments") or "") for b in (m.get("content") or []) if isinstance(b, dict))
            waits.append(t - starts[k]); outputs.append(n)
    for k, t0 in starts.items():
        if k in ends: step_totals.append(ends[k] - t0)

print(f"steps={len(waits)}")
if waits:
    ws = sorted(waits)
    print(f"LLM wait ms: mean={st.mean(ws):.0f} p50={ws[len(ws)//2]:.0f} p90={ws[int(len(ws)*0.9)]:.0f} max={ws[-1]:.0f}")
    print(f"step total ms: mean={st.mean(step_totals):.0f} p50={st.median(step_totals):.0f} max={max(step_totals):.0f} sum={sum(step_totals)/1000:.0f}s")
# correlation between output size and wait (only steps where both known)
pairs = [(w, o) for w, o in zip(waits, outputs)]
big = [w for w, o in pairs if o > 3000]
small = [w for w, o in pairs if o < 500]
print(f"steps with output>3000 chars: n={len(big)} mean_wait={st.mean(big) if big else 0:.0f}ms")
print(f"steps with output< 500 chars: n={len(small)} mean_wait={st.mean(small) if small else 0:.0f}ms")
