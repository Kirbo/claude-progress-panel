import { expect, test } from 'claude-code/testing'

import {
  CI_MEMORY_TTL_MS,
  ciFiles,
  markNoPipeline,
  parseCiMemory,
  remembered,
  repoKey,
  withVerdict,
} from './cimemory'

const T = 1_800_000_000_000

test('a verdict holds while the CI files are the same and it is younger than the TTL', () => {
  const key = repoKey('/w/app', undefined)
  const files = ciFiles({ gitlab: false, github: false, gitea: false }, false)
  const memory = withVerdict(parseCiMemory(undefined), key, { ci: 'none', files, checkedAtMs: T })
  expect(remembered(memory, key, files, T + 1000)?.ci).toBe('none')
  // A CI file appeared: judge again.
  expect(
    remembered(memory, key, ciFiles({ gitlab: true, github: false, gitea: false }, false), T),
  ).toBeUndefined()
  // Too old: judge again.
  expect(remembered(memory, key, files, T + CI_MEMORY_TTL_MS)).toBeUndefined()
  // Another remote of the same repo (a mirror) is its own entry.
  expect(remembered(memory, repoKey('/w/app', 'mirror'), files, T)).toBeUndefined()
  expect(remembered(withVerdict(memory, key, undefined), key, files, T)).toBeUndefined()
})

test('a commit that never got a pipeline marks every repo pushing to that project', () => {
  const files = ciFiles({ gitlab: true, github: false, gitea: false }, false)
  const memory = withVerdict(parseCiMemory(undefined), 'a|', {
    ci: 'yes',
    files,
    host: 'gitlab.com',
    project: 'team/app',
    checkedAtMs: T,
  })
  const marked = markNoPipeline(memory, 'gitlab.com', 'team/app', T + 5)
  expect(marked.repos['a|']).toMatchObject({ ci: 'nopipeline', checkedAtMs: T + 5 })
  // Another project, or another host: unchanged (the same object).
  expect(markNoPipeline(memory, 'gitlab.com', 'team/other', T)).toBe(memory)
  expect(markNoPipeline(memory, 'git.example.com', 'team/app', T)).toBe(memory)
})

test('an unreadable or foreign memory file reads as empty', () => {
  expect(parseCiMemory('{nope').repos).toEqual({})
  expect(parseCiMemory('{"version":2,"repos":{}}').repos).toEqual({})
  expect(
    parseCiMemory('{"version":1,"repos":{"k":{"ci":"none","files":"----","checkedAtMs":1}}}').repos.k?.ci,
  ).toBe('none')
})
