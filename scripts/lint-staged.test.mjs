import assert from 'node:assert/strict'
import { test } from 'node:test'

import { lintStaged } from './lint-staged.mjs'

// A fake git + Biome: records every call, answers from the given state.
function fake({ staged = ['a.ts'], unstaged = [], fixable = true } = {}) {
  const calls = []
  let fixed = false
  return {
    calls,
    deps: {
      staged: () => staged,
      unstaged: () => unstaged,
      biome: args => {
        calls.push(['biome', ...args])
        if (args.includes('--write')) {
          fixed = fixable
          return 1
        }
        return fixed ? 0 : 1
      },
      add: files => calls.push(['add', ...files]),
      log: () => {},
    },
  }
}

test('nothing staged: Biome does not run', () => {
  const f = fake({ staged: [] })
  assert.equal(lintStaged(f.deps), 0)
  assert.deepEqual(f.calls, [])
})

test('fixable problems are fixed, the fixed files re-staged, and the commit goes on', () => {
  const f = fake({ staged: ['a.ts', 'b.json'] })
  assert.equal(lintStaged(f.deps), 0)
  assert.deepEqual(f.calls[0].slice(0, 4), ['biome', 'check', '--write', '--staged'])
  assert.deepEqual(f.calls[1], ['add', 'a.ts', 'b.json'])
  assert.deepEqual(f.calls[2].slice(0, 3), ['biome', 'check', '--staged'])
})

test('a partly staged file is never re-staged (its unstaged lines must stay out)', () => {
  const f = fake({ staged: ['a.ts', 'b.ts'], unstaged: ['b.ts'] })
  assert.equal(lintStaged(f.deps), 0)
  assert.deepEqual(
    f.calls.find(c => c[0] === 'add'),
    ['add', 'a.ts'],
  )
})

test('problems Biome cannot fix refuse the commit', () => {
  const f = fake({ fixable: false })
  assert.equal(lintStaged(f.deps), 1)
})

test('fails closed when git cannot list the staged files', () => {
  const f = fake({ staged: null })
  assert.equal(lintStaged(f.deps), 1)
  assert.deepEqual(f.calls, [])
})
