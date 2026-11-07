import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releasePlan, versionBumps } from './release.mjs'

test('versionBumps: the first commit carrying each new plugin version, oldest first', () => {
  const history = [
    { sha: 'a1', date: '2026-11-06T10:00:00+02:00', version: '0.1.0' },
    { sha: 'a2', date: '2026-11-06T11:00:00+02:00', version: '0.1.0' },
    { sha: 'a3', date: '2026-11-06T12:00:00+02:00', version: '0.2.0' },
    { sha: 'a4', date: '2026-11-06T13:00:00+02:00', version: undefined },
    { sha: 'a5', date: '2026-11-06T14:00:00+02:00', version: '0.2.1' },
  ]
  assert.deepEqual(versionBumps(history), [
    { version: '0.1.0', sha: 'a1', date: '2026-11-06T10:00:00+02:00' },
    { version: '0.2.0', sha: 'a3', date: '2026-11-06T12:00:00+02:00' },
    { version: '0.2.1', sha: 'a5', date: '2026-11-06T14:00:00+02:00' },
  ])
})

test('releasePlan: every bump without a v<version> tag, each with the bump before it as its start', () => {
  const bumps = [
    { version: '0.1.0', sha: 'a1', date: 'd1' },
    { version: '0.2.0', sha: 'a3', date: 'd3' },
    { version: '0.2.1', sha: 'a5', date: 'd5' },
  ]
  assert.deepEqual(releasePlan(bumps, new Set(['v0.1.0'])), [
    { version: '0.2.0', sha: 'a3', date: 'd3', from: 'a1' },
    { version: '0.2.1', sha: 'a5', date: 'd5', from: 'a3' },
  ])
  assert.deepEqual(releasePlan(bumps, new Set(['v0.1.0', 'v0.2.0', 'v0.2.1'])), [])
  // The very first version starts at the beginning of history.
  assert.deepEqual(releasePlan(bumps.slice(0, 1), new Set()), [
    { version: '0.1.0', sha: 'a1', date: 'd1', from: null },
  ])
})
