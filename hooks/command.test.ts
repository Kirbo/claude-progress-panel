import { expect, test } from 'claude-code/testing'

import { commandArgv, parseCommandStatus } from './command'

test('commandArgv: whitespace-split, ~ expanded, each placeholder filled inside its own argument', () => {
  expect(
    commandArgv('~/bin/ci-status --job {project} {id}  sha={sha} {host}', {
      project: 'jenkins/nightly',
      id: 12,
      sha: undefined,
      host: undefined,
      home: '/home/me',
    }),
  ).toEqual(['/home/me/bin/ci-status', '--job', 'jenkins/nightly', '12', 'sha=', ''])
  // A value never splits into more arguments, whatever it holds.
  expect(commandArgv('st {project}', { project: 'a b;c', id: null, sha: 'x', home: '/h' })).toEqual([
    'st',
    'a b;c',
  ])
  expect(commandArgv('   ', { project: 'p', id: 1, home: '/h' })).toEqual([])
  // A value is never an option of the command: one that starts with "-" is left out.
  expect(
    commandArgv('st {project} {sha} --host={host} {host}', {
      project: '--exec=x',
      id: 1,
      sha: '-rf',
      host: '-h',
      home: '/h',
    }),
  ).toEqual(['st', '', '', '--host=', ''])
})

test('parseCommandStatus: the documented JSON → a pipeline head and jobs; {} = not there yet', () => {
  const out = {
    id: 12,
    state: 'running',
    url: 'https://ci.example.com/job/nightly/12',
    ref: 'main',
    startedAt: '2026-11-07T10:00:00Z',
    jobs: [
      { name: 'build', stage: 'build', state: 'success', durationS: 30 },
      { name: 'test', state: 'running', url: 'https://ci.example.com/job/nightly/12/test' },
      { name: 'bad', state: 'exploded' },
      { state: 'success' },
    ],
  }
  expect(parseCommandStatus(JSON.stringify(out))).toEqual({
    head: {
      id: 12,
      state: 'running',
      url: 'https://ci.example.com/job/nightly/12',
      ref: 'main',
      startedAt: '2026-11-07T10:00:00Z',
    },
    jobs: [
      { name: 'build', stage: 'build', state: 'success', durationS: 30 },
      {
        name: 'test',
        stage: '',
        state: 'running',
        durationS: null,
        url: 'https://ci.example.com/job/nightly/12/test',
      },
      { name: 'bad', stage: '', state: 'queued', durationS: null },
    ],
  })
  const done = parseCommandStatus(
    JSON.stringify({ id: 3, state: 'failed', finishedAt: '2026-11-07T10:05:00Z', durationS: 300 }),
  )
  expect(done?.head).toMatchObject({
    state: 'failed',
    pipelineFinishedAt: '2026-11-07T10:05:00Z',
    durationS: 300,
  })
  expect(done?.jobs).toEqual([])
  expect(parseCommandStatus('{}')).toBeNull()
  expect(parseCommandStatus('')).toBeNull()
  expect(parseCommandStatus('not json')).toBeUndefined()
  expect(parseCommandStatus(JSON.stringify({ state: 'running' }))).toBeUndefined()
})
