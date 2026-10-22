// asar_grep.mjs — search text content inside an .asar archive without extracting it.
// usage: node tools/asar_grep.mjs <asar> <pathRegex> <contentRegex> [maxHits]
import { readFileSync } from 'node:fs';

const [, , asarPath, pathRe, contentRe, maxHitsArg] = process.argv;
const maxHits = Number(maxHitsArg ?? 60);
const fd = readFileSync(asarPath);
if (fd.readUInt32LE(0) !== 4) throw new Error('not an asar (bad header size)');
const jsonLen = fd.readUInt32LE(12);
const headerJson = fd.subarray(16, 16 + jsonLen).toString('utf8');
let header;
try { header = JSON.parse(headerJson); } catch { header = JSON.parse(headerJson.slice(0, headerJson.lastIndexOf('}') + 1)); }
const baseOffset = 16 + fd.readUInt32LE(4);

const re = new RegExp(pathRe);
const cre = new RegExp(contentRe, 'i');
const hits = [];
let files = 0;
let bytes = 0;

function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix + '/' + name;
    if (entry.files) { walk(entry, p); continue; }
    if (!re.test(p)) continue;
    const { offset, size } = entry;
    const buf = fd.subarray(baseOffset + Number(offset), baseOffset + Number(offset) + Number(size));
    files++;
    bytes += Number(size);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (cre.test(lines[i])) {
        hits.push(p + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 400));
        if (hits.length >= maxHits) return;
      }
    }
  }
}
walk(header, '');
console.log(`scanned ${files} files (${(bytes / 1048576).toFixed(1)} MB), ${hits.length} hit(s)`);
for (const h of hits) console.log(h);
