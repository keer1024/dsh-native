// reset_corpus.mjs — put the benchmark corpus back to RETRIES = 3 between reps.
// Called with an absolute path so both stacks (native pwsh, dsh-native exec) run the
// exact same reset work; using it avoids fighting PowerShell's native-argument quoting.
import { readFileSync, writeFileSync } from 'node:fs'

const target = process.argv[2]
if (!target) {
  console.error('usage: node tools/reset_corpus.mjs <path/to/config.mjs>')
  process.exit(2)
}
const before = readFileSync(target, 'utf8')
const after = before.replace('RETRIES = 5;', 'RETRIES = 3;')
if (after !== before) writeFileSync(target, after)
const ok = readFileSync(target, 'utf8').includes('RETRIES = 3;')
console.log(ok ? 'RESET_OK' : 'RESET_FAILED')
process.exit(ok ? 0 : 1)
