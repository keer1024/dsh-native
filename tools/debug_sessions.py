import sys, os, json, glob, collections
sys.path.insert(0, r"C:\Users\keer_\Documents\deepseek-harness\default-workspace\_tools\pyzstd")
import zstandard as zstd
ROOT = r"C:\Users\keer_\.dsh\sessions"
files = glob.glob(os.path.join(ROOT, "*", "*", "session*.jsonl.zstd"))
for p in files:
    with open(p, "rb") as fh:
        with zstd.ZstdDecompressor().stream_reader(fh, read_across_frames=True) as rd:
            raw = rd.read()
    recs = []
    for l in raw.decode("utf-8", "replace").split("\n"):
        if l.strip():
            try: recs.append(json.loads(l))
            except Exception: pass
    c = collections.Counter(r.get("type") for r in recs)
    times = [r.get("time") for r in recs if isinstance(r.get("time"), (int, float))]
    print(os.path.basename(os.path.dirname(p))[:24], "n=", len(recs), "tmin=", min(times) if times else None, "tmax=", max(times) if times else None)
    print("   tc=", c.get("tool/call"), "tr=", c.get("tool/result"), "types=", dict(list(c.items())[:6]))
    tc = [r for r in recs if r.get("type") == "tool/call"]
    if tc:
        print("   sample tool/call data:", json.dumps(tc[0].get("data"))[:200])
    tr = [r for r in recs if r.get("type") == "tool/result"]
    if tr:
        print("   sample tool/result keys:", sorted((tr[0].get("data") or {}).keys()))
    if not times:
        print("   NO time field; record0=", json.dumps(recs[0])[:300])
