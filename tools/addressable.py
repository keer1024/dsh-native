# Addressable share, deduplicated by callId (the two copied sessions share records).
# Denominator uses the established ratio tool_time/step_time = 0.71 measured by telemetry.py.
import sys, os, glob, json
sys.path.insert(0, r"C:\Users\keer_\Documents\deepseek-harness\default-workspace\_tools\pyzstd")
import zstandard as zstd
ROOT = r"C:\Users\keer_\.dsh\sessions"
WARM_S = 0.006
TOOL_SHARE = 0.71

seen = set()
calls = []
for p in sorted(glob.glob(os.path.join(ROOT, "*", "*", "session*.jsonl.zstd"))):
    with open(p, "rb") as fh:
        with zstd.ZstdDecompressor().stream_reader(fh, read_across_frames=True) as rd:
            recs = [json.loads(l) for l in rd.read().decode("utf-8", "replace").split("\n") if l.strip()]
    recs.sort(key=lambda r: r.get("seq", 0))
    pend = {}
    for r in recs:
        ty, d, t = r.get("type"), r.get("data") or {}, r.get("time")
        if ty == "tool/call":
            pend[d.get("callId")] = (d.get("name"), t)
        elif ty == "tool/result":
            m = d.get("message") or {}
            cid = d.get("toolCallId") or m.get("toolCallId") or ((m.get("source") or {}).get("callId"))
            if cid in pend and t:
                name, t0 = pend.pop(cid)
                if cid in seen or not t0:
                    continue
                seen.add(cid)
                calls.append((name, (t - t0) / 1000.0))

pwsh = sorted(d for n, d in calls if n == "pwsh")
tool_total = sum(d for _, d in calls)
step_total = tool_total / TOOL_SHARE
print(f"unique tool calls={len(calls)}  all-tool total={tool_total:.0f}s  implied step total={step_total:.0f}s")
print(f"pwsh calls={len(pwsh)} total={sum(pwsh):.0f}s ({100*sum(pwsh)/step_total:.1f}% of step total)")
print()
for spawn in (1.3, 1.5, 3.7):
    floor = sum(min(d, spawn) for d in pwsh)
    saved = floor - len(pwsh) * WARM_S
    print(f"spawn={spawn:4.1f}s -> replaced {floor:7.1f}s of pwsh time; saved {saved:7.1f}s "
          f"= {100*saved/step_total:4.1f}% of step total  => end-to-end {1/(1-saved/step_total):.3f}x")
print()
buckets = ((0, 0.5), (0.5, 1.5), (1.5, 3), (3, 6), (6, 12), (12, 30), (30, 1e9))
for lo, hi in buckets:
    n = sum(1 for d in pwsh if lo <= d < hi)
    print(f"  {lo:>5.1f}s..{hi:<7.0f}s : {n:4d} calls ({100*n/max(len(pwsh),1):5.1f}%)")
