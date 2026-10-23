# Decode every session log, measure zstd decode time, dump raw JSONL for Node-side measurement.
import sys, os, json, glob, time
sys.path.insert(0, r"C:\Users\keer_\Documents\deepseek-harness\default-workspace\_tools\pyzstd")
import zstandard as zstd

ROOT = r"C:\Users\keer_\.dsh\sessions"
OUT = r"C:\Users\keer_\Documents\deepseek-harness\default-workspace\_bench\raw"
os.makedirs(OUT, exist_ok=True)

rows = []
for p in sorted(glob.glob(os.path.join(ROOT, "*", "*", "session*.jsonl.zstd"))):
    sid = os.path.basename(os.path.dirname(p))
    comp = os.path.getsize(p)
    t0 = time.perf_counter()
    with open(p, "rb") as fh:
        # count frames too (magic scan on compressed bytes)
        blob = fh.read()
        frames = blob.count(b"\x28\xb5\x2f\xfd")
        with zstd.ZstdDecompressor().stream_reader(__import__("io").BytesIO(blob), read_across_frames=True) as rd:
            raw = rd.read()
    dec_ms = (time.perf_counter() - t0) * 1000
    dst = os.path.join(OUT, sid + ".jsonl")
    with open(dst, "wb") as fh:
        fh.write(raw)
    lines = sum(1 for l in raw.decode("utf-8", "replace").split("\n") if l.strip())
    rows.append((sid, comp, len(raw), frames, lines, dec_ms, dst))

print(f"{'session':40s} {'compKB':>8s} {'rawKB':>8s} {'frames':>7s} {'records':>8s} {'decode_ms':>10s} {'MB/s':>7s}")
for sid, comp, rawlen, frames, lines, dec_ms, _ in sorted(rows, key=lambda r: -r[2]):
    mbs = (rawlen / 1048576) / max(dec_ms / 1000, 1e-6)
    print(f"{sid:40s} {comp/1024:8.0f} {rawlen/1024:8.0f} {frames:7d} {lines:8d} {dec_ms:10.1f} {mbs:7.1f}")
print("\nRAW_DIR=" + OUT)
