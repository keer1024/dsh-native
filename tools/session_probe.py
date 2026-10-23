# Session log probe: decode multi-frame zstd JSONL, histogram record types, dump trimmed samples.
import sys, json, io
sys.path.insert(0, r"C:\Users\keer_\Documents\deepseek-harness\default-workspace\_tools\pyzstd")
import zstandard as zstd

path = sys.argv[1]
cctx = zstd.ZstdDecompressor()
with open(path, "rb") as fh:
    with cctx.stream_reader(fh, read_across_frames=True) as rd:
        raw = rd.read()
text = raw.decode("utf-8", errors="replace")
lines = [l for l in text.split("\n") if l.strip()]
print(f"bytes={len(raw)} lines={len(lines)}")

hist, samples, keys = {}, {}, {}
for l in lines:
    try:
        o = json.loads(l)
    except Exception:
        hist["PARSE_FAIL"] = hist.get("PARSE_FAIL", 0) + 1
        continue
    t = o.get("type") or o.get("kind") or "NO_TYPE"
    hist[t] = hist.get(t, 0) + 1
    samples.setdefault(t, l[:800])
    k = ",".join(sorted(o.keys()))
    keys[k] = keys.get(k, 0) + 1

print("--- type histogram ---")
for k, v in sorted(hist.items(), key=lambda x: -x[1]):
    print(f"{v:7d}  {k}")
print("--- key sets ---")
for k, v in sorted(keys.items(), key=lambda x: -x[1])[:20]:
    print(f"{v:7d}  {k}")
print("--- samples ---")
for k, v in samples.items():
    print("### " + k + "\n" + v)
