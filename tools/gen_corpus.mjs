// Generates a disposable benchmark corpus for the dsh-native vs native-tools
// comparison.  Layout (≈150 files, ~2400-line big file):
//
//   .bench-corpus/
//     src/core/config.mjs      ← task target: EXPORTED `RETRIES` + resolveConfigPath()
//     src/core/big.mjs         ← 2400-line file (read cost / payload demo)
//     src/mod000.mjs … mod149.mjs  ← noise: many `RETRIES_HINT` comments + exports
//     smoke.mjs                ← verifier: `node smoke.mjs` prints SMOKE_OK when RETRIES===5
//
// usage: node tools/gen_corpus.mjs [targetDir]
//        (default: C:\Users\keer_\.dsh\profiles\desktop\.bench-corpus)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2] ?? 'C:\\Users\\keer_\\.dsh\\profiles\\desktop\\.bench-corpus';

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, 'src', 'core'), { recursive: true });

const core = `// config resolution — the file the simulated task edits.
export const RETRIES = 3;
export const TIMEOUT_MS = 30_000;

export function resolveConfigPath(base) {
  if (!base) return process.cwd();
  const trimmed = base.replace(/[\\\\/]+$/, '');
  return \`\${trimmed}/config.json\`;
}

export function timeoutFor(attempt) {
  return Math.min(TIMEOUT_MS, 1_000 * 2 ** attempt);
}
`;
writeFileSync(join(target, 'src', 'core', 'config.mjs'), core);

const big = [];
big.push('// big.mjs — generated for read-cost comparison; every 20 lines starts a function.');
for (let i = 1; big.length < 2400; i++) {
  big.push(`export function bigStep${String(i).padStart(4, '0')}(input: number): number {`);
  big.push('  // accumulate a deterministic rolling value so the body is not trivial');
  big.push(`  let acc = input ^ ${i * 2654435761 % 100000};`);
  for (let k = 0; k < 15; k++) {
    big.push(`  acc = (acc * ${31 + k} + ${(i * 101 + k) % 97}) & 0x7fffffff;`);
  }
  big.push('  return acc;');
  big.push('}');
  big.push('');
}
writeFileSync(join(target, 'src', 'core', 'big.mjs'), big.slice(0, 2400).join('\n'));

for (let i = 0; i < 150; i++) {
  const n = String(i).padStart(3, '0');
  const lines = [
    `// module ${n} — noise file for the search benchmark`,
    `// RETRIES_HINT: the real knob lives in src/core/config.mjs`,
    '',
    `export const MODULE_ID_${n} = ${i};`,
    '',
    `export function compute${n}(a: number, b: number): number {`,
    `  const RETRIES_HINT = ${i % 7};`,
    '  let acc = a ^ b;',
    '  for (let k = 0; k < 8; k++) {',
    `    acc = (acc * ${17 + (i % 11)} + RETRIES_HINT) & 0x7fffffff;`,
    '  }',
    '  return acc;',
    '}',
    '',
    `export function describe${n}(): string {`,
    `  return "module-${n}";`,
    '}',
    '',
  ];
  writeFileSync(join(target, 'src', `mod${n}.mjs`), lines.join('\n'));
}

writeFileSync(
  join(target, 'smoke.mjs'),
  `// verifier for the simulated task
import { RETRIES, resolveConfigPath } from './src/core/config.mjs';

const path = resolveConfigPath('C:/tmp/app/');
if (RETRIES !== 5) {
  console.error('FAIL RETRIES=' + RETRIES + ' (want 5)');
  process.exit(1);
}
if (path !== 'C:/tmp/app/config.json') {
  console.error('FAIL resolveConfigPath=' + path);
  process.exit(1);
}
console.log('SMOKE_OK RETRIES=' + RETRIES + ' path=' + path);
`,
);

console.log(`corpus written to ${target}`);
