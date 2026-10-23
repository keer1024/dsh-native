# DSH session telemetry: where does wall time actually go?
# Decodes every session log (multi-frame zstd JSONL), pairs tool/call→tool/result,
# and attributes wall time to LLM wait, tool execution, and local/framework overhead.
import sys, os, json, glob, statistics as st
sys.path.insert(0, r"C:\Users\keer_\Documents\deepseek-harness\default-workspace\_tools\pyzstd")
import zstandard as zstd

ROOT = r"C:\Users\keer_\.dsh\sessions"
files = glob.glob(os.path.join(ROOT, "*", "*", "session*.jsonl.zstd"))

def load(p):
    with open(p, "rb") as fh:
        with zstd.ZstdDecompressor().stream_reader(fh, read_across_frames=True) as rd:
            raw = rd.read()
    recs = []
    for l in raw.decode("utf-8", "replace").split("\n"):
        if l.strip():
            try:
                recs.append(json.loads(l))
            except Exception:
                pass
    recs.sort(key=lambda r: r.get("seq", 0))
    return recs, len(raw)

all_tools = {}     # name -> list of durations ms
tot = dict(llm=0, tool=0, local=0, wall=0, steps=0, turns=0, toolcalls=0)
per_session = []
msg_keys = set()

for p in files:
    recs, nbytes = load(p)
    if not recs:
        continue
    t0 = recs[0].get("time") or recs[0].get("createdAt")
    t1 = recs[-1].get("time") or t0
    pend = {}
    for r in recs:
        d = r.get("data") or {}
        if r.get("type") == "tool/call":
            pend[d.get("callId")] = (d.get("name"), r["time"])
        elif r.get("type") == "tool/result":
            m = d.get("message") or {}
            cid = d.get("toolCallId") or (m.get("toolCallId") if isinstance(m, dict) else None) \
                or ((m.get("source") or {}).get("callId") if isinstance(m, dict) else None)
            if cid in pend:
                name, tstart = pend.pop(cid)
                dur = r["time"] - tstart
                all_tools.setdefault(name, []).append(dur)
                tot["tool"] += dur
                tot["toolcalls"] += 1
        elif r.get("type") == "assistant/message":
            m = d.get("message") or {}
            if isinstance(m, dict):
                msg_keys.update(m.keys())

    # step-level attribution
    steps = [r for r in recs if r.get("type") == "step/start"]
    ends = [r for r in recs if r.get("type") == "step/end"]
    for s, e in zip(steps, ends):
        tot["steps"] += 1
        tot["llm"] += 0  # filled below
    # LLM wait: step/start -> first assistant/message in that step
    by_step = {}
    for r in recs:
        d = r.get("data") or {}
        if "turn" in d and "step" in d:
            by_step.setdefault((d["turn"], d["step"]), []).append(r)
    for key, rs in by_step.items():
        rs.sort(key=lambda r: r["time"])
        tstart = rs[0]["time"]
        am = [r for r in rs if r.get("type") == "assistant/message"]
        if am:
            tot["llm"] += am[0]["time"] - tstart
            last_tr = [r for r in rs if r.get("type") == "tool/result"]
            end = [r for r in rs if r.get("type") == "step/end"]
            if end:
                anchor = last_tr[-1]["time"] if last_tr else am[0]["time"]
                tot["local"] += end[0]["time"] - anchor
    turns = [r for r in recs if r.get("type") == "turn/start"]
    tot["turns"] += len(turns)
    wall = t1 - t0
    tot["wall"] += wall
    per_session.append((os.path.basename(os.path.dirname(p))[:20], round(wall / 1000), len(recs), round(nbytes / 1024)))

print(f"files={len(files)} decoded={len(per_session)}")
print("--- per session: id | wall_s | records | raw_KB ---")
for row in sorted(per_session, key=lambda x: -x[1])[:10]:
    print(f"  {row[0]:22s} {row[1]:7d}s {row[2]:6d} {row[3]:7d}KB")

print(f"\n--- TOTALS over {tot['turns']} turns / {tot['steps']} steps / {tot['toolcalls']} tool calls ---")
secs = {k: tot[k] / 1000 for k in ("llm", "tool", "local", "wall")}
print(f"  wall(record span) : {secs['wall']:9.1f}s")
print(f"  LLM wait (step->assistant msg): {secs['llm']:9.1f}s  {100*secs['llm']/max(secs['wall'],1):5.1f}% of span")
print(f"  tool execution (call->result): {secs['tool']:9.1f}s  {100*secs['tool']/max(secs['wall'],1):5.1f}% of span")
print(f"  local/framework (last result->step end): {secs['local']:9.1f}s  {100*secs['local']/max(secs['wall'],1):5.1f}% of span")
print(f"  per tool call: mean {tot['tool']/max(tot['toolcalls'],1):.0f}ms")

print("\n--- tool time by tool name ---")
rows = [(n, len(v), sum(v), st.median(v), max(v)) for n, v in all_tools.items()]
for n, c, s, med, mx in sorted(rows, key=lambda x: -x[2]):
    print(f"  {n:26s} n={c:4d} total={s/1000:8.2f}s mean={s/c:7.1f}ms median={med:7.1f}ms max={mx:8.1f}ms")

# --- persistent-shell headroom: wall time a warm shell would give back ---
step_total = 0.0
for p in files:
    recs, _ = load(p)
    starts = {}
    for r in recs:
        d = r.get("data") or {}
        if r.get("type") == "step/start":
            starts[(d.get("turn"), d.get("step"))] = r.get("time")
        elif r.get("type") == "step/end":
            k = (d.get("turn"), d.get("step"))
            if k in starts and r.get("time"):
                span = r["time"] - starts[k]
                if 0 < span < 3_600_000:
                    step_total += span
pwsh = all_tools.get("pwsh") or []
print("\n--- persistent-shell headroom ---")
print(f"  step wall total (clean spans): {step_total/1000:8.1f}s")
for spawn_ms in (1300, 1400, 3000, 3700):
    floor = sum(min(d, spawn_ms) for d in pwsh) - len(pwsh) * 6
    share = floor / max(step_total, 1)
    print(f"  spawn floor {spawn_ms:4d}ms: replaceable {floor/1000:7.1f}s "
          f"= {100*share:4.1f}% of step time => end-to-end {1/(1-share):.3f}x")
print("\nassistant/message keys:", sorted(msg_keys))
