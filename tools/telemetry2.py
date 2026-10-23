# DSH turn-level attribution + context composition.
# 1) Wall time per turn split into LLM wait / tool exec / framework overhead.
# 2) Shell-spawn floor attribution for pwsh calls (measured cold start ~3.7s on this box).
# 3) Byte composition of the request context by message role (proxy for token cost / LLM time).
import sys, os, json, glob, collections, statistics as st
sys.path.insert(0, r"C:\Users\keer_\Documents\deepseek-harness\default-workspace\_tools\pyzstd")
import zstandard as zstd

ROOT = r"C:\Users\keer_\.dsh\sessions"
SPAWN_FLOOR_MS = 3700.0
HUMAN_TOOLS = {"ask_user_question", "load_workspace_dependencies", "job_output", "subagent", "subagent_fork", "workflow"}

def load(p):
    with open(p, "rb") as fh:
        with zstd.ZstdDecompressor().stream_reader(fh, read_across_frames=True) as rd:
            raw = rd.read()
    recs = [json.loads(l) for l in raw.decode("utf-8", "replace").split("\n") if l.strip()]
    recs.sort(key=lambda r: r.get("seq", 0))
    return recs, len(raw)

def callid_of_result(d):
    m = d.get("message") or {}
    return d.get("toolCallId") or (m.get("toolCallId") if isinstance(m, dict) else None) \
        or (((m.get("source") or {}).get("callId")) if isinstance(m, dict) else None)

grand = collections.Counter()
tool_dur = collections.defaultdict(list)
role_bytes = collections.Counter()
biggest = []

for p in sorted(glob.glob(os.path.join(ROOT, "*", "*", "session*.jsonl.zstd"))):
    recs, nbytes = load(p)
    sid = os.path.basename(os.path.dirname(p))[:24]
    pend = {}
    # turn spans
    tstart = {}
    wall = 0
    llm = tool = 0
    for r in recs:
        ty, d, t = r.get("type"), r.get("data") or {}, r.get("time")
        if ty == "turn/start":
            tstart[d.get("turn")] = t
        elif ty == "turn/end":
            if d.get("turn") in tstart and t:
                wall += t - tstart.pop(d["turn"])
        elif ty == "tool/call":
            pend[d.get("callId")] = (d.get("name"), t)
        elif ty == "tool/result":
            cid = callid_of_result(d)
            if cid in pend:
                name, t0 = pend.pop(cid)
                dur = (t or t0) - t0
                tool_dur[name].append(dur)
                tool += dur
        elif ty == "assistant/message":
            m = d.get("message") or {}
            llm += max(0, t - (tstart.get(d.get("turn"), t)))
            for b in m.get("content", []):
                if isinstance(b, dict):
                    role_bytes["assistant/" + b.get("type", "?")] += len(b.get("text") or b.get("arguments") or "")
        elif ty in ("user/message", "system/message", "developer/message"):
            m = d if ty != "user/message" else d
            for b in (m.get("content") or []):
                if isinstance(b, dict):
                    role_bytes[ty + "/" + b.get("type", "?")] += len(b.get("text") or "")
        if ty == "tool/result" and isinstance(d.get("message"), dict):
            for b in d["message"].get("content", []):
                if isinstance(b, dict):
                    n = len(b.get("text") or "")
                    if n > 5000:
                        biggest.append((n, d["message"].get("toolCallId", "?"), sid))
    grand["wall"] += wall
    grand["tool"] += tool
    print(f"{sid:26s} turns_wall={wall/1000:8.1f}s  tool={tool/1000:8.1f}s  records={len(recs)}")

print("\n=== tool time: spawn-attributable share ===")
tot_tool = sum(sum(v) for v in tool_dur.values())
spawn = sum(min(d, SPAWN_FLOOR_MS) for v in tool_dur.values() for d in v)
print(f"total tool exec {tot_tool/1000:.1f}s; lower-bound spawn floor inside it: {spawn/1000:.1f}s ({100*spawn/tot_tool:.1f}%)")
n_pwsh = len(tool_dur.get("pwsh", []))
if n_pwsh:
    print(f"pwsh calls={n_pwsh} total={sum(tool_dur['pwsh'])/1000:.1f}s  min={min(tool_dur['pwsh']):.0f}ms median={st.median(tool_dur['pwsh']):.0f}ms")
    capped = sum(min(d, SPAWN_FLOOR_MS) for d in tool_dur["pwsh"])
    print(f"pwsh respawn floor (min(dur,3.7s)) = {capped/1000:.1f}s -> {100*capped/sum(tool_dur['pwsh']):.1f}% of pwsh time")
    print(f"if every pwsh call became an in-process op costing 20ms -> saves {(capped-20*n_pwsh)/1000:.1f}s")

print("\n=== context byte composition (proxy for token/LLM cost) ===")
tot_b = sum(role_bytes.values())
for k, v in role_bytes.most_common(12):
    print(f"  {k:28s} {v/1048576:8.2f} MB  {100*v/max(tot_b,1):5.1f}%")
print(f"  {'TOTAL':28s} {tot_b/1048576:8.2f} MB")
print("\n=== largest tool results ===")
for n, cid, sid in sorted(biggest, reverse=True)[:6]:
    print(f"  {n:>9,} chars  {cid}  {sid}")
