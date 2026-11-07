#!/usr/bin/env node
// Pre-commit step: Biome over the staged files — fix what it can, re-stage what it fixed, refuse
// the commit when anything is left. Called by .githooks/pre-commit before the audit sealing.
//
// A file that is only partly staged (it also has unstaged changes) is fixed in the working tree
// but NOT re-staged: `git add` would sweep its unstaged lines into the commit. If its staged
// content still fails the check, the commit is refused and the message says to stage it.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const QUIET = ['--no-errors-on-unmatched', '--files-ignore-unknown=true']

function gitNames(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' })
  if (r.status !== 0) return null
  return r.stdout.split('\n').filter(Boolean)
}

export const defaultDeps = {
  staged: () => gitNames(['diff', '--cached', '--name-only', '--diff-filter=ACMR']),
  unstaged: () => gitNames(['diff', '--name-only']) ?? [],
  biome: args => spawnSync('biome', args, { stdio: 'inherit' }).status ?? 1,
  add: files => spawnSync('git', ['add', '--', ...files], { stdio: 'inherit' }),
  log: msg => console.error(msg),
}

export function lintStaged(deps = defaultDeps) {
  const staged = deps.staged()
  if (staged === null) {
    deps.log('pre-commit: git could not list the staged files — refusing the commit')
    return 1
  }
  if (staged.length === 0) return 0
  const partial = new Set(deps.unstaged())

  deps.biome(['check', '--write', '--staged', ...QUIET])
  const whole = staged.filter(f => !partial.has(f))
  if (whole.length > 0) deps.add(whole)

  if (deps.biome(['check', '--staged', ...QUIET]) !== 0) {
    const half = staged.filter(f => partial.has(f))
    deps.log(
      'pre-commit: Biome found problems it cannot fix (above) — fix them and commit again' +
        (half.length > 0 ? `; partly staged files were fixed but not re-staged: ${half.join(', ')}` : ''),
    )
    return 1
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(lintStaged())
