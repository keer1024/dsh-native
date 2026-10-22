// Minimal read-only asar reader: node tools/asar.mjs list|extract <asar> [filterRegex] [outDir]
import fs from 'node:fs';
import path from 'node:path';

const [, , cmd, asarPath, filterArg, outDirArg] = process.argv;
const filter = filterArg ? new RegExp(filterArg) : null;

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const pickleSize = head.readUInt32LE(4);
const jsonLen = pickleSize - 8;
const buf = Buffer.alloc(jsonLen);
fs.readSync(fd, buf, 0, jsonLen, 16);
const header = JSON.parse(buf.toString('utf8'));

const entries = [];
(function walk(node, prefix) {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + k;
    if (v.files) walk(v, p);
    else entries.push({ path: p, size: v.size, offset: Number(v.offset) });
  }
})(header, '');

if (cmd === 'list') {
  for (const e of entries) if (!filter || filter.test(e.path)) console.log(e.path + '|' + e.size);
} else if (cmd === 'extract') {
  for (const e of entries) {
    if (filter && !filter.test(e.path)) continue;
    const dest = path.join(outDirArg, e.path.replace(/^\//, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const b = Buffer.alloc(e.size);
    if (e.size > 0) fs.readSync(fd, b, 0, e.size, 16 + jsonLen + e.offset);
    fs.writeFileSync(dest, b);
  }
  console.log('extracted ' + entries.filter((e) => !filter || filter.test(e.path)).length + ' files');
} else if (cmd === 'read') {
  for (const e of entries) {
    if (filter && filter.test(e.path)) {
      const b = Buffer.alloc(e.size);
      if (e.size > 0) fs.readSync(fd, b, 0, e.size, 16 + jsonLen + e.offset);
      process.stdout.write(b);
    }
  }
}
fs.closeSync(fd);
