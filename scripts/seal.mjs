#!/usr/bin/env node
// Sealed files: material committed ONLY as age ciphertext (`<path>.age`) while its plaintext stays on
// disk, gitignored. This repo is PUBLIC and the open audit findings are not fixed yet, so their
// plaintext must never reach git. What is sealed, and to whom, is `.sealed.json` (rules) +
// `.age-recipients` (public keys). Zero npm dependencies: runs from the git hook before anything is
// installed. Ported from Switchboard's scripts/seal.mjs, reduced to what a one-rule repo needs.
//
//   seal [--all]     encrypt every plaintext edited since it was last sealed/unsealed (all with
//                    --all). Needs NO key: age is public-key, so writing a report never waits.
//   unseal           decrypt every blob that changed since its plaintext was last synced, unless
//                    the plaintext was edited too (a conflict: kept, reported, never overwritten).
//   verify           every blob decrypts (round trip), nothing written.
//   status           what is edited / unsealed / changed / conflicting. No key.
//   hook-pre-commit  refuse staged sealed plaintext; seal edited plaintext and stage the blobs.
//
// "Edited" and "changed" are decided by CONTENT, recorded per clone in `.git/sealed-state.json`
// (path -> sha256 of the plaintext and of the blob at the last sync), never by mtime.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONFIG_FILE = '.sealed.json'
export const BLOB_EXT = '.age'
export const KEYCHAIN_SERVICE = 'claude-progress-panel'
export const KEYCHAIN_ACCOUNT = 'age-identity'

const sha256 = buf => createHash('sha256').update(buf).digest('hex')
const posix = p => p.split('\\').join('/')

/** Read and validate `.sealed.json`. A rule: { name, root, include: [glob], exclude: [glob] }. */
export function loadConfig(root) {
  const raw = JSON.parse(readFileSync(resolve(root, CONFIG_FILE), 'utf8'))
  const globs = v => Array.isArray(v) && v.length > 0 && v.every(g => typeof g === 'string')
  if (typeof raw.recipients !== 'string' || !Array.isArray(raw.rules) || raw.rules.length === 0)
    throw new Error(`${CONFIG_FILE}: needs "recipients" (a file) and at least one rule`)
  const rules = raw.rules.map(r => {
    if (typeof r.root !== 'string' || !globs(r.include) || (r.exclude !== undefined && !globs(r.exclude)))
      throw new Error(`${CONFIG_FILE}: rule ${JSON.stringify(r.name)} needs "root" and "include" (globs)`)
    return {
      name: r.name ?? r.root,
      root: posix(r.root).replace(/\/+$/, ''),
      include: r.include,
      exclude: r.exclude ?? [],
    }
  })
  return { recipients: raw.recipients, rules }
}

/** Swap each segment's leading dot for a character no glob contains, so `*` / `**` match dotfiles
 *  like .gitignore's own `*` does (matchesGlob alone skips them: `open/.draft` would escape). */
const dotsAsNames = rel =>
  rel
    .split('/')
    .map(s => (s.startsWith('.') ? `\u0000${s.slice(1)}` : s))
    .join('/')

/** The rule that seals repo-relative `path`, or null. A blob path is never itself sealed. */
export function ruleFor(cfg, path) {
  const p = posix(path)
  if (p.endsWith(BLOB_EXT)) return null
  for (const r of cfg.rules) {
    if (!p.startsWith(`${r.root}/`)) continue
    const rel = dotsAsNames(p.slice(r.root.length + 1))
    const hit = globs => globs.some(g => matchesGlob(rel, g))
    if (hit(r.include) && !hit(r.exclude)) return r
  }
  return null
}

const walk = (root, dir) => {
  if (!existsSync(resolve(root, dir))) return []
  return readdirSync(resolve(root, dir), { recursive: true })
    .map(f => `${dir}/${posix(String(f))}`)
    .filter(p => statSync(resolve(root, p)).isFile())
}

const allFiles = (root, cfg) => [...new Set(cfg.rules.flatMap(r => walk(root, r.root)))]

/** Every sealed plaintext on disk, sorted. */
export const plainFiles = (root, cfg) =>
  allFiles(root, cfg)
    .filter(p => ruleFor(cfg, p))
    .sort()

/** Every blob on disk whose plaintext path is sealed, sorted. */
export const blobFiles = (root, cfg) =>
  allFiles(root, cfg)
    .filter(p => p.endsWith(BLOB_EXT) && ruleFor(cfg, p.slice(0, -BLOB_EXT.length)))
    .sort()

export function readState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}
export const writeState = (file, state) =>
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })

/**
 * Classify every sealed path:
 *   ok        plaintext and blob are what was last synced
 *   unsealed  plaintext with no blob (never sealed): seal it
 *   edited    plaintext changed since the last sync: seal it
 *   changed   blob changed (or plaintext absent): unseal it
 *   conflict  both changed: resolve by hand, never overwritten
 */
export function classify(root, cfg, state) {
  const out = []
  const plains = new Set(plainFiles(root, cfg))
  const blobs = new Set(blobFiles(root, cfg).map(b => b.slice(0, -BLOB_EXT.length)))
  for (const path of [...new Set([...plains, ...blobs])].sort()) {
    if (!blobs.has(path)) {
      out.push({ path, state: 'unsealed' })
      continue
    }
    if (!plains.has(path)) {
      out.push({ path, state: 'changed' })
      continue
    }
    const plainAbs = resolve(root, path)
    const blobAbs = resolve(root, path + BLOB_EXT)
    const s = state[path]
    let edited
    let changed
    if (s) {
      edited = sha256(readFileSync(plainAbs)) !== s.plain
      changed = sha256(readFileSync(blobAbs)) !== s.blob
    } else {
      // No record yet: one-time mtime fallback, a plaintext newer than its blob was edited.
      edited = statSync(plainAbs).mtimeMs > statSync(blobAbs).mtimeMs
      changed = !edited
    }
    const st = edited && changed ? 'conflict' : edited ? 'edited' : changed ? 'changed' : 'ok'
    out.push(s ? { path, state: st } : { path, state: st, guess: true })
  }
  return out
}

const writePrivate = (abs, buf) => {
  const tmp = `${abs}.tmp-${process.pid}`
  writeFileSync(tmp, buf, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, abs)
}

/** Seal what needs it (everything with `all`). Returns the sealed paths. */
export function seal(root, cfg, deps, { all = false } = {}) {
  const state = deps.readState()
  const entries = classify(root, cfg, state)
  const wanted = all ? ['ok', 'edited', 'unsealed', 'conflict'] : ['edited', 'unsealed']
  if (!all)
    for (const e of entries.filter(x => x.state === 'conflict'))
      deps.log(`conflict ${e.path}: edited here AND changed upstream; sealing would discard upstream`)
  const todo = entries.filter(e => wanted.includes(e.state)).map(e => e.path)
  for (const path of todo) {
    deps.age.encrypt(resolve(root, cfg.recipients), resolve(root, path), resolve(root, path + BLOB_EXT))
    state[path] = {
      plain: sha256(readFileSync(resolve(root, path))),
      blob: sha256(readFileSync(resolve(root, path + BLOB_EXT))),
    }
    deps.log(`sealed   ${path} -> ${path}${BLOB_EXT}`)
  }
  deps.writeState(state)
  return todo
}

/** Unseal changed blobs; conflicts are kept. `identity` is the private key text. */
export function unseal(root, cfg, deps, identity) {
  const state = deps.readState()
  const res = { unsealed: [], conflicts: [] }
  for (const e of classify(root, cfg, state)) {
    const plainAbs = resolve(root, e.path)
    if (e.state === 'changed') {
      const blob = readFileSync(resolve(root, e.path + BLOB_EXT))
      const plain = deps.age.decrypt(blob, identity)
      state[e.path] = { plain: sha256(plain), blob: sha256(blob) }
      // A first sync (no record) whose plaintext already matches only records the state.
      if (e.guess && existsSync(plainAbs) && readFileSync(plainAbs).equals(plain)) continue
      writePrivate(plainAbs, plain)
      res.unsealed.push(e.path)
      deps.log(`unsealed ${e.path}`)
    } else if (e.state === 'conflict') {
      res.conflicts.push(e.path)
      deps.log(`KEPT     ${e.path}: edited here and changed upstream; seal or discard it by hand`)
    }
  }
  deps.writeState(state)
  return res
}

/** Decrypt every blob in memory. Returns the paths that failed. */
export function verify(root, cfg, deps, identity) {
  const failed = []
  for (const b of blobFiles(root, cfg)) {
    try {
      deps.age.decrypt(readFileSync(resolve(root, b)), identity)
    } catch (err) {
      failed.push(b)
      deps.log(`FAILED   ${b}: ${err.message}`)
    }
  }
  return failed
}

/** Staged paths that would publish sealed plaintext, the pre-commit refusal. */
export const stagedPlaintext = (cfg, staged) => staged.filter(p => ruleFor(cfg, p))

// -- the real tools -----------------------------------------------------------------------------

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts })
  if (r.error)
    throw new Error(
      `${cmd}: ${r.error.code === 'ENOENT' ? 'not found on PATH (mise install)' : r.error.message}`,
    )
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${String(r.stderr).trim()}`)
  return r.stdout
}

/** age through its CLI. The identity goes in on stdin; ciphertext is the only thing on disk. */
export const ageCli = {
  encrypt(recipientsFile, plain, blob) {
    run('age', [
      '--encrypt',
      '--armor',
      '--recipients-file',
      recipientsFile,
      '--output',
      `${blob}.tmp`,
      plain,
    ])
    renameSync(`${blob}.tmp`, blob)
  },
  decrypt(blob, identity) {
    const dir = mkdtempSync(join(tmpdir(), 'cpp-seal-'))
    try {
      const f = join(dir, 'blob.age')
      writeFileSync(f, blob)
      return run('age', ['--decrypt', '--identity', '-', f], { input: identity })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
}

/** The private key, or null: AGE_IDENTITY, AGE_IDENTITY_FILE (FNOX_AGE_KEY[_FILE] work too), else
 *  the OS keychain item (libsecret on Linux, Keychain on macOS). Never printed, never on disk. */
export function findIdentity(env = process.env, keychain = readKeychain) {
  const direct = env.AGE_IDENTITY || env.FNOX_AGE_KEY
  if (direct) return direct
  const file = env.AGE_IDENTITY_FILE || env.FNOX_AGE_KEY_FILE
  if (file) return readFileSync(file, 'utf8')
  return keychain()
}

function readKeychain() {
  const cmds = {
    linux: ['secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT]],
    darwin: ['security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']],
  }
  const c = cmds[process.platform]
  if (!c) return null
  try {
    return String(run(c[0], c[1])).trim() || null
  } catch {
    return null
  }
}

const lines = out => (out === null ? null : String(out).split('\n').filter(Boolean))

export function gitDeps(root, log = m => console.error(m)) {
  const git = args => {
    const r = spawnSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    return r.status === 0 ? r.stdout : null
  }
  const stateFile = resolve(
    root,
    String(git(['rev-parse', '--git-path', 'sealed-state.json']) ?? '.git/sealed-state.json').trim(),
  )
  return {
    log,
    age: ageCli,
    readState: () => readState(stateFile),
    writeState: s => writeState(stateFile, s),
    // --no-renames: a `git mv fixed/X.md open/X.md` is an add of open/X.md, not a droppable R entry.
    staged: () => lines(git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMRT'])),
    add: paths => paths.length && git(['add', '--', ...paths]),
  }
}

const NO_KEY =
  'no key: set AGE_IDENTITY_FILE, or store the identity in the OS keychain (docs/audits/README.md)'

/** The CLI. Returns the exit code; `deps` / `identity` are injectable for the tests. */
export function main(
  argv,
  { root = process.cwd(), deps = gitDeps(root), identity = () => findIdentity() } = {},
) {
  const cfg = loadConfig(root)
  const [cmd, flag] = argv
  switch (cmd) {
    case 'seal': {
      const done = seal(root, cfg, deps, { all: flag === '--all' })
      deps.log(
        done.length === 0
          ? 'Everything is sealed.'
          : 'Commit the .age blobs; the plaintext stays on disk, gitignored.',
      )
      return 0
    }
    case 'unseal':
    case 'verify': {
      const id = identity()
      if (!id) {
        deps.log(`seal: ${NO_KEY}`)
        return 1
      }
      if (cmd === 'verify') {
        const failed = verify(root, cfg, deps, id)
        if (failed.length === 0) deps.log('Round trip OK: every blob decrypts.')
        return failed.length ? 1 : 0
      }
      return unseal(root, cfg, deps, id).conflicts.length ? 1 : 0
    }
    case 'status': {
      const entries = classify(root, cfg, deps.readState())
      for (const e of entries) deps.log(`${e.state.padEnd(9)}${e.path}`)
      return entries.some(e => !['ok', 'changed'].includes(e.state)) ? 1 : 0
    }
    case 'hook-pre-commit': {
      const staged = deps.staged()
      if (staged === null) {
        // Fail closed: an empty list from a failed git would let any staged plaintext through.
        deps.log('seal: could not list the staged files (git diff --cached failed), commit aborted.')
        return 1
      }
      const leaked = stagedPlaintext(cfg, staged)
      if (leaked.length) {
        deps.log('seal: REFUSING to commit sealed material in plaintext:')
        for (const p of leaked) deps.log(`  ${p}`)
        deps.log('seal: unstage it (git restore --staged <file>); only its .age blob may be committed.')
        return 1
      }
      try {
        const done = seal(root, cfg, deps)
        deps.add(done.map(p => p + BLOB_EXT))
        for (const p of done) deps.log(`seal: staged ${p}${BLOB_EXT}`)
      } catch (err) {
        deps.log(`seal: sealing FAILED (${err.message}), commit aborted so the change is not silently lost.`)
        return 1
      }
      return 0
    }
    default:
      deps.log('usage: seal.mjs seal [--all] | unseal | verify | status | hook-pre-commit')
      return 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  process.exitCode = main(process.argv.slice(2), { root, deps: gitDeps(root) })
}
