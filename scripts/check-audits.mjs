#!/usr/bin/env node
// CI guard for the audit register (docs/audits/README.md). Static, needs no key:
//   1. git tracks no sealed plaintext (anything .sealed.json seals, e.g. docs/audits/open/*.md);
//   2. every tracked .age blob starts with the age armor header;
//   3. fixed/ holds only AUDIT-YYYY-MM-DD.md files, none marked open/partial;
//   4. no tracked public file names a CPP-NNNN id that is not a `## CPP-NNNN` heading in fixed/*.md
//      (docs/audits/README.md is exempt: it carries the index and the next free id);
//   5. no id of a locally present open plaintext appears in fixed/;
//   6. outside CI, this clone runs the repo's git hooks (core.hooksPath = .githooks).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BLOB_EXT, loadConfig, ruleFor } from './seal.mjs'

export const ARMOR = '-----BEGIN AGE ENCRYPTED FILE-----'
const ID = /\bCPP-\d{4,}\b/g
const HEADING = /^## (CPP-\d{4,})\b/gm
const README = 'docs/audits/README.md'
const FIXED = 'docs/audits/fixed'
const OPEN = 'docs/audits/open'

const ids = (re, text) => new Set([...text.matchAll(re)].map(m => m[1] ?? m[0]))

/**
 * `tracked`: repo-relative tracked paths. `read(path)` -> text or null (missing, or binary).
 * `localOpen`: texts of open plaintext reports present on this machine (empty in CI).
 */
export function auditProblems(cfg, tracked, read, localOpen = []) {
  const problems = []
  for (const t of tracked) {
    if (t.endsWith(BLOB_EXT)) {
      if (!read(t)?.startsWith(ARMOR)) problems.push(`${t}: not an armored age blob (missing "${ARMOR}")`)
    } else if (ruleFor(cfg, t)) {
      problems.push(`${t} is tracked in plaintext: sealed material may only be committed as ${t}${BLOB_EXT}`)
    }
  }
  const fixedIds = new Set()
  for (const t of tracked.filter(p => p.startsWith(`${FIXED}/`) && p.endsWith('.md'))) {
    const name = t.slice(FIXED.length + 1)
    if (!/^AUDIT-\d{4}-\d{2}-\d{2}(-\d+)?\.md$/.test(name))
      problems.push(`${t}: audit files are named AUDIT-YYYY-MM-DD.md (or -2, -3 for a same-day pass)`)
    const text = read(t) ?? ''
    const bad = text.match(/\*\*Status:\*\*\s*(open|partial|blocked|carried)|partially fixed|\(partial\)/i)
    if (bad) problems.push(`${t}: carries "${bad[0]}": an unfinished finding stays in open/ (sealed)`)
    for (const id of ids(HEADING, text)) fixedIds.add(id)
  }
  for (const t of tracked) {
    if (t === README || t.endsWith(BLOB_EXT)) continue
    for (const id of ids(ID, read(t) ?? ''))
      if (!fixedIds.has(id))
        problems.push(`${t}: names ${id}, which is not a fixed finding (open ids stay sealed)`)
  }
  for (const text of localOpen)
    for (const id of ids(HEADING, text))
      if (fixedIds.has(id)) problems.push(`${id} is both in a local open report and in fixed/`)
  return problems
}

/**
 * The pre-commit hook seals edited findings and lints staged files; without it an edit to a sealed
 * report is invisible to git. `hooksPath`: this clone's `core.hooksPath` ('' when unset).
 */
export function hooksProblem(hooksPath, isCi) {
  if (isCi || hooksPath.replace(/\/+$/, '') === '.githooks') return null
  return "this clone does not run the repo's git hooks (sealing, lint): run `git config core.hooksPath .githooks`"
}

function main(root) {
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  if (git.status !== 0) throw new Error(`git ls-files failed: ${git.stderr}`)
  const tracked = git.stdout.split('\0').filter(p => p && existsSync(resolve(root, p)))
  const read = p => {
    try {
      return readFileSync(resolve(root, p), 'utf8')
    } catch {
      return null
    }
  }
  const openDir = resolve(root, OPEN)
  const localOpen = existsSync(openDir)
    ? readdirSync(openDir)
        .filter(f => f.endsWith('.md'))
        .map(f => read(`${OPEN}/${f}`) ?? '')
    : []
  const problems = auditProblems(loadConfig(root), tracked, read, localOpen)
  const hooks = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' })
  const unhooked = hooksProblem((hooks.stdout ?? '').trim(), Boolean(process.env.CI))
  if (unhooked) problems.push(unhooked)
  for (const p of problems) console.error(`check-audits: ${p}`)
  if (problems.length === 0) console.log('check-audits: ok')
  return problems.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
