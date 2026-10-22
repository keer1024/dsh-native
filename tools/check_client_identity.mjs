#!/usr/bin/env node
// Client identity guard for the dsh-native bundle.
//
// Why this exists: the host keys client-graph rows by package.json "name" but the
// browser registers factories by the bundle's `load({ id })`. When the package was
// renamed dsh-rust-exec -> dsh-native the id stayed stale, so the host re-served the
// bundle, the second execution threw `client-modules: duplicate factory registration
// for "dsh-rust-exec"`, and web boot failed with `1 entry did not activate`
// (crash-2026-10-21T05-54-22-705Z-web-boot.log). This check fails fast on that
// class of mismatch instead of discovering it during a restart.
//
// Usage:
//   node tools/check_client_identity.mjs                     # package + desktop profile
//   node tools/check_client_identity.mjs --package <dir>
//   node tools/check_client_identity.mjs --profile <dir>
//   node tools/check_client_identity.mjs --no-profile
//
// Exit 0 = every check passed, 1 = at least one mismatch.

import { readFileSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const has = (name) => args.includes(name)

const pkgDir = resolve(flag('--package') ?? join(scriptDir, '..', 'packages', 'dsh-rust-exec'))
const dshHome = process.env.DSH_HOME ?? process.env.DSH_HOME_DIR ?? join(homedir(), '.dsh')
const profileDir = has('--no-profile')
  ? undefined
  : resolve(flag('--profile') ?? join(dshHome, 'profiles', 'desktop'))

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  if (!ok && detail) results.at(-1).detail = detail
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

// ---------------------------------------------------------------- package identity
let pkg
try {
  pkg = readJson(join(pkgDir, 'package.json'))
  check(true, `package.json readable (${pkg.name}@${pkg.version})`)
} catch (error) {
  console.error(`FATAL cannot read ${join(pkgDir, 'package.json')}: ${error.message}`)
  process.exit(1)
}

const name = pkg.name
const clientFile = join(pkgDir, 'client.js')
const clientSource = existsSync(clientFile) ? readFileSync(clientFile, 'utf8') : ''
const declaresClient = Boolean(pkg.dsh?.client)

check(
  declaresClient === existsSync(clientFile),
  'dsh.client declared iff client.js exists',
  declaresClient ? 'package.json declares dsh.client but client.js is missing'
    : 'client.js exists but package.json has no dsh.client block',
)

const loads = [...clientSource.matchAll(/__ModuleLoader__\.load\s*\(/g)].length
check(loads === 1, 'client.js calls __ModuleLoader__.load exactly once', `found ${loads} call(s)`)

const idMatch = clientSource.match(/__ModuleLoader__\.load\s*\(\s*\{\s*id:\s*'([^']+)'/)
const registrationId = idMatch?.[1]
check(Boolean(registrationId), 'client.js declares a literal registration id')
check(
  registrationId === name,
  `registration id matches package name (${name})`,
  `registration id is ${JSON.stringify(registrationId)} but package.json name is ${JSON.stringify(name)} — the host re-serves the bundle and web boot fails with "duplicate factory registration"`,
)

// The bundle must not require itself (that would also re-execute it).
const requires = [...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
check(!requires.includes(name), 'client.js does not require itself', `requires ${name}`)

// ---------------------------------------------------------------- bundle patch
const patchFile = join(pkgDir, pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml')
if (existsSync(patchFile)) {
  const patch = readFileSync(patchFile, 'utf8')
  const names = [...patch.matchAll(/^\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/gm)].map((m) => m[1])
  check(names.length > 0, 'bundle patch declares a plugin name')
  check(
    names.every((entry) => entry === name),
    'bundle patch name matches package name',
    `patch names: ${names.join(', ')}`,
  )
  const ids = [...patch.matchAll(/^\s*-\s*id:\s*['"]?([^'"\s#]+)['"]?\s*$/gm)].map((m) => m[1])
  check(
    ids.every((entry) => entry === name),
    'bundle patch id matches package name',
    `patch ids: ${ids.join(', ')}`,
  )
} else {
  check(false, 'bundle patch exists', `missing ${patchFile}`)
}

// ---------------------------------------------------------------- shipped files
for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'bin/dsh-rust-worker.exe']) {
  check(existsSync(join(pkgDir, entry)), `ships ${entry}`)
}
const filesField = Array.isArray(pkg.files) ? pkg.files : []
for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'bin/dsh-rust-worker.exe']) {
  check(filesField.includes(entry), `files[] lists ${entry}`)
}

// ---------------------------------------------------------------- profile wiring
if (profileDir) {
  const profilePkgFile = join(profileDir, 'package.json')
  if (!existsSync(profilePkgFile)) {
    check(false, `profile package.json exists (${profilePkgFile})`)
  } else {
    const profile = readJson(profilePkgFile)
    const bundles = profile.dsh?.profile?.bundles ?? []
    check(bundles.includes(name), `profile bundles include ${name}`, `bundles: ${bundles.join(', ') || '(empty)'}`)
    check(
      Boolean(profile.dependencies?.[name]),
      `profile dependencies include ${name}`,
      'bundle listed without a dependency entry (bundle is not mounted)',
    )

    // A renamed package can leave the old link behind; both ids then resolve to
    // the same directory, which makes the client graph ambiguous.
    const modulesDir = join(profileDir, 'node_modules')
    if (existsSync(modulesDir)) {
      let selfReal
      try {
        selfReal = realpathSync.native(pkgDir).toLowerCase()
      } catch {
        selfReal = resolve(pkgDir).toLowerCase()
      }
      const dupes = []
      for (const entry of readdirSync(modulesDir)) {
        if (entry === name || entry.startsWith('.')) continue
        const candidate = join(modulesDir, entry)
        if (!existsSync(join(candidate, 'package.json'))) continue
        let real
        try {
          real = realpathSync.native(candidate).toLowerCase()
        } catch {
          continue
        }
        if (real === selfReal) dupes.push(entry)
      }
      check(
        dupes.length === 0,
        'no stale node_modules alias points at this package',
        `aliases: ${dupes.join(', ')} — remove them so only "${name}" is resolvable`,
      )
    }
  }
}

// ---------------------------------------------------------------- report
let failed = 0
for (const result of results) {
  if (result.ok) {
    console.log(`  ok   ${result.label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${result.label}`)
    if (result.detail) console.log(`       ${result.detail}`)
  }
}
const scope = profileDir ? `${pkgDir} + profile ${profileDir}` : pkgDir
console.log(`\n${results.length - failed}/${results.length} checks passed (${scope})`)
process.exit(failed === 0 ? 0 : 1)
