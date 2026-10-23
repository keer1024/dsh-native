# Context composition + LLM wait across all session logs.
import sys, os, json, glob, collections
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

def blocks_bytes(container):
    if not isinstance(container, dict):
        return 0
    n = 0
    for b in container.get("content") or []:
        if isinstance(b, dict):
            n += len(b.get("text") or b.get("arguments") or b.get("input") and json.dumps(b["input"]) or "")
    return n

buckets = collections.Counter()
counts = collections.Counter()
llm_wait = 0.0
steps = 0
for p in sorted(glob.glob(os.path.join(ROOT, "*", "*", "session*.jsonl.zstd"))):
    recs = load(p)
    step_start = {}
    for r in recs:
        ty, d, t = r.get("type"), r.get("data") or {}, r.get("time")
        if ty == "step/start":
            step_start[(d.get("turn"), d.get("step"))] = t
        elif ty == "assistant/message":
            key = (d.get("turn"), d.get("step"))
            if key in step_start and t:
                llm_wait += t - step_start[key]
                steps += 1
            m = d.get("message") or {}
            for b in m.get("content") or []:
                if isinstance(b, dict):
                    if b.get("type") == "reasoning":
                        buckets["assistant reasoning"] += len(b.get("text") or "")
                    elif b.get("type") == "text":
                        buckets["assistant text"] += len(b.get("text") or "")
                    elif b.get("type") == "tool-call":
                        buckets["assistant tool-call args"] += len(b.get("arguments") or "")
                        counts["tool-calls"] += 1
        elif ty == "tool/result":
            m = d.get("message") or {}
            n = blocks_bytes(m)
            buckets["tool results (returned to model)"] += n
            counts["tool-results"] += 1
            if n > 20000:
                buckets["  of which single results >20k chars"] += n
        elif ty in ("system/message", "developer/message"):
            buckets["system/developer prompt"] += blocks_bytes(d.get("message") or d)
        elif ty == "user/message":
            buckets["user messages"] += blocks_bytes(d)

tot = sum(v for k, v in buckets.items() if not k.startswith("  "))
print(f"LLM wait attributed over {steps} steps: {llm_wait/1000:.1f}s  (mean {llm_wait/max(steps,1):.0f}ms/step)")
print(f"tool-calls={counts['tool-calls']} tool-results={counts['tool-results']}")
print("\n=== context payload composition (chars) ===")
for k, v in buckets.most_common():
    pct = 100 * v / max(tot, 1)
    print(f"  {k:42s} {v:>10,}  {pct:5.1f}%")
print(f"  {'TOTAL':42s} {tot:>10,}")
print(f"\nrough token estimate (chars/3.5): {tot/3.5:,.0f} tokens of non-system payload")
