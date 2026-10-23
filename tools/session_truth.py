# Independent ground truth for the multi-frame zstd session log: real frame boundaries
# from python-zstandard's decompressobj().unused_data, plus per-frame byte/line counts.
# usage: python tools/session_truth.py <session.jsonl.zstd>
import sys, json, os
sys.path.insert(0, r"C:\Users\keer_\Documents\deepseek-harness\default-workspace\_tools\pyzstd")
import zstandard as zstd

path = sys.argv[1]
data = open(path, "rb").read()
dctx = zstd.ZstdDecompressor()

frames = []
pos = 0
total_bytes = 0
total_lines = 0
while pos < len(data):
    dobj = dctx.decompressobj()
    out = dobj.decompress(data[pos:])
    used = len(data) - pos - len(dobj.unused_data)
    if used <= 0:
        # trailing garbage
        print(f"STOP at {pos}: used={used} remaining={len(data)-pos}")
        break
    n = len(out)
    lines = out.count(b"\n")
    frames.append({"start": pos, "end": pos + used, "bytes": n, "lines": lines})
    total_bytes += n
    total_lines += lines
    pos += used

print(f"compressed={len(data)} B frames={len(frames)} decoded={total_bytes} B lines={total_lines}")
print("first 5 frames:", " | ".join(f"{f['start']}-{f['end']}:{f['bytes']}" for f in frames[:5]))
sizes = sorted(f["bytes"] for f in frames)
print(f"zero-byte frames={sum(1 for f in frames if f['bytes'] == 0)} median={sizes[len(sizes)//2]} max={sizes[-1]}")
os.makedirs("_bench", exist_ok=True)
json.dump(frames, open("_bench/frames_python.json", "w"))
print("wrote _bench/frames_python.json")
