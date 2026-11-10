import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ARMOR, auditProblems, hooksProblem } from './check-audits.mjs'

// Register ids are built at run time: the guard scans this file too, and a literal id here would
// read as a published open finding.
const ID = n => `CPP-${String(n).padStart(4, '0')}`

const cfg = {
  recipients: '.age-recipients',
  rules: [{ name: 'audit', root: 'docs/audits', include: ['**/*'], exclude: ['README.md', 'fixed/*.md'] }],
}
const run = (files, localOpen = []) =>
  auditProblems(cfg, Object.keys(files), p => files[p] ?? null, localOpen)
const blob = `${ARMOR}\nabc\n-----END AGE ENCRYPTED FILE-----\n`
const fixed = `# AUDIT\n\n## ${ID(1)} - a thing\n**Fixed:** 2026-11-06\n`

test('a clean register passes', () => {
  assert.deepEqual(
    run({
      'docs/audits/README.md': `Next free ID: ${ID(3)}`,
      'docs/audits/fixed/AUDIT-2026-11-06.md': fixed,
      'docs/audits/open/AUDIT-2026-11-06.md.age': blob,
      'hooks/register.tsx': `// fixes ${ID(1)}`,
    }),
    [],
  )
})

test('tracked plaintext under open/ fails', () => {
  const p = run({ 'docs/audits/open/AUDIT-2026-11-06.md': '# draft' })
  assert.equal(p.length, 1)
  assert.match(p[0], /tracked in plaintext/)
})

test('a blob without the armor header fails', () => {
  const p = run({ 'docs/audits/open/AUDIT-2026-11-06.md.age': 'plain text' })
  assert.match(p[0], /not an armored age blob/)
})

test('an open id in a public file fails, a fixed one passes', () => {
  const files = { 'docs/audits/fixed/AUDIT-2026-11-06.md': fixed, 'CLAUDE.md': `${ID(1)} and ${ID(2)}` }
  const p = run(files)
  assert.equal(p.length, 1)
  assert.match(p[0], new RegExp(`CLAUDE\\.md: names ${ID(2)}`))
})

test('fixed/ rejects bad names and unfinished status', () => {
  const p = run({ 'docs/audits/fixed/notes.md': '**Status:** partial' })
  assert.equal(p.length, 2)
})

test('an id in both a local open report and fixed/ fails', () => {
  const p = run({ 'docs/audits/fixed/AUDIT-2026-11-06.md': fixed }, [`## ${ID(1)} - dup`])
  assert.match(p[0], /both in a local open report/)
})

test("a clone whose git hooks are not this repo's is told how to set them — never in CI", () => {
  assert.equal(hooksProblem('.githooks', false), null)
  assert.equal(hooksProblem('.githooks/', false), null)
  for (const path of ['', '.git/hooks', '/elsewhere/hooks'])
    assert.match(hooksProblem(path, false), /git config core\.hooksPath \.githooks/)
  // CI checks out a fresh clone and commits nothing: its hooks do not matter.
  assert.equal(hooksProblem('', true), null)
})
