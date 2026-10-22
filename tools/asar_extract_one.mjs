// Extract one file from an .asar by path regex: node tools/asar_extract_one.mjs <asar> <pathRegex> <outFile>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const [, , asarPath, pathRe, outFile] = process.argv
const fd = readFileSync(asarPath)
const jsonLen = fd.readUInt32LE(12)
const header = JSON.parse(fd.subarray(16, 16 + jsonLen).toString('utf8'))
const base = 16 + fd.readUInt32LE(4)
const re = new RegExp(pathRe)
let found = null
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name
    if (entry.files) { walk(entry, p); continue }
    if (!found && re.test(p)) found = { p, entry }
  }
}
walk(header, '')
if (!found) { console.error('no match'); process.exit(1) }
const { offset, size } = found.entry
mkdirSync(path.dirname(outFile), { recursive: true })
writeFileSync(outFile, fd.subarray(base + Number(offset), base + Number(offset) + Number(size)))
console.log(`${found.p} -> ${outFile} (${size} bytes)`)
