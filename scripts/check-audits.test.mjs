import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ARMOR, auditProblems } from './check-audits.mjs'

const cfg = {
  recipients: '.age-recipients',
  rules: [{ name: 'audit', root: 'docs/audits', include: ['**/*'], exclude: ['README.md', 'fixed/*.md'] }],
}
const run = (files, localOpen = []) =>
  auditProblems(cfg, Object.keys(files), p => files[p] ?? null, localOpen)
const blob = `${ARMOR}\nabc\n-----END AGE ENCRYPTED FILE-----\n`
const fixed = '# AUDIT\n\n## CPP-0001 - a thing\n**Fixed:** 2026-11-06\n'

test('a clean register passes', () => {
  assert.deepEqual(
    run({
      'docs/audits/README.md': 'Next free ID: CPP-0003',
      'docs/audits/fixed/AUDIT-2026-11-06.md': fixed,
      'docs/audits/open/AUDIT-2026-11-06.md.age': blob,
      'hooks/register.tsx': '// fixes CPP-0001',
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
  const files = { 'docs/audits/fixed/AUDIT-2026-11-06.md': fixed, 'CLAUDE.md': 'CPP-0001 and CPP-0002' }
  const p = run(files)
  assert.equal(p.length, 1)
  assert.match(p[0], /CLAUDE\.md: names CPP-0002/)
})

test('fixed/ rejects bad names and unfinished status', () => {
  const p = run({ 'docs/audits/fixed/notes.md': '**Status:** partial' })
  assert.equal(p.length, 2)
})

test('an id in both a local open report and fixed/ fails', () => {
  const p = run({ 'docs/audits/fixed/AUDIT-2026-11-06.md': fixed }, ['## CPP-0001 - dup'])
  assert.match(p[0], /both in a local open report/)
})
