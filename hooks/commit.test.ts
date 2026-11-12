import { expect, test } from 'claude-code/testing'

import type { Run } from './commit'
import {
  aggregateRuns,
  aggregateState,
  anyRunPath,
  isCommitWatch,
  jobsPath,
  parseRuns,
  runLabels,
  runPath,
  runsOnRef,
  runsPath,
} from './commit'

const SHA = 'a'.repeat(40)

test('aggregateState: unfinished while any run is; only when all are complete, the worst outcome', () => {
  expect(aggregateState([])).toBe('unknown')
  expect(aggregateState(['success'])).toBe('success')
  // A fast green run never speaks for the ones still going — or not started.
  expect(aggregateState(['success', 'running'])).toBe('running')
  expect(aggregateState(['success', 'queued'])).toBe('running')
  expect(aggregateState(['queued', 'queued'])).toBe('queued')
  expect(aggregateState(['failed', 'running'])).toBe('running')
  expect(aggregateState(['success', 'manual'])).toBe('manual')
  expect(aggregateState(['manual', 'queued'])).toBe('queued')
  // All complete: failed beats canceled beats success; skipped only when nothing ran.
  expect(aggregateState(['success', 'failed', 'canceled'])).toBe('failed')
  expect(aggregateState(['success', 'canceled', 'skipped'])).toBe('canceled')
  expect(aggregateState(['success', 'skipped'])).toBe('success')
  expect(aggregateState(['skipped', 'skipped'])).toBe('skipped')
})

test('the API paths of a watch by commit, per forge', () => {
  const gl = { project: 'g/app', sha: SHA }
  const gh = { provider: 'github' as const, project: 'o/r', sha: SHA }
  const gt = { provider: 'gitea' as const, project: 'o/r', sha: SHA }
  expect(runsPath(gl)).toBe(`projects/g%2Fapp/pipelines?sha=${SHA}&per_page=100`)
  expect(runsPath(gh)).toBe(`repos/o/r/actions/runs?head_sha=${SHA}&per_page=100`)
  expect(runsPath(gt)).toBe(`/repos/o/r/actions/runs?head_sha=${SHA}&limit=50`)
  expect([anyRunPath(gl), anyRunPath(gh), anyRunPath(gt)]).toEqual([
    'projects/g%2Fapp/pipelines?per_page=1',
    'repos/o/r/actions/runs?per_page=1',
    '/repos/o/r/actions/runs?limit=1',
  ])
  expect([runPath(gl, 7), runPath(gh, 7), runPath(gt, 7)]).toEqual([
    'projects/g%2Fapp/pipelines/7',
    'repos/o/r/actions/runs/7',
    '/repos/o/r/actions/runs/7',
  ])
  expect([jobsPath(gl, 7), jobsPath(gh, 7), jobsPath(gt, 7)]).toEqual([
    'projects/g%2Fapp/pipelines/7/jobs?per_page=100',
    'repos/o/r/actions/runs/7/jobs?per_page=100',
    '/repos/o/r/actions/runs/7/jobs',
  ])
})

test('isCommitWatch: a key that names the commit — never a run id, never a custom command', () => {
  expect(isCommitWatch({ key: `g/app@${SHA}`, sha: SHA })).toBe(true)
  expect(isCommitWatch({ key: `g/app@${SHA}:main`, sha: SHA })).toBe(true)
  expect(isCommitWatch({ key: 'g/app#7', sha: SHA })).toBe(false)
  expect(isCommitWatch({ key: 'g/app#7' })).toBe(false)
  expect(isCommitWatch({ key: `ci:job@${SHA}`, provider: 'command', sha: SHA })).toBe(false)
})

test('parseRuns: every pipeline / run of a list, newest first; [] for none, undefined for no list', () => {
  expect(
    parseRuns(
      undefined,
      JSON.stringify([
        { id: 52, status: 'running', ref: 'refs/merge-requests/3/head', source: 'merge_request_event' },
        { id: 51, status: 'success', ref: 'next', source: 'push', name: 'Build' },
        { nope: true },
      ]),
    ),
  ).toEqual([
    { id: 52, state: 'running', ref: 'refs/merge-requests/3/head', source: 'merge_request_event' },
    { id: 51, state: 'success', ref: 'next', source: 'push', name: 'Build' },
  ])
  expect(parseRuns('gitlab', '[]')).toEqual([])
  expect(parseRuns('gitlab', '{"message":"404"}')).toBeUndefined()
  const gh = parseRuns(
    'github',
    JSON.stringify({
      total_count: 2,
      workflow_runs: [
        { id: 2, name: 'CI', status: 'in_progress', conclusion: null, head_branch: 'main', event: 'push' },
        {
          id: 1,
          name: 'Lint',
          status: 'completed',
          conclusion: 'success',
          head_branch: 'main',
          event: 'push',
        },
      ],
    }),
  )
  expect(gh?.map(r => [r.id, r.name, r.state, r.ref])).toEqual([
    [2, 'CI', 'running', 'main'],
    [1, 'Lint', 'success', 'main'],
  ])
  expect(parseRuns('github', '{"total_count":0,"workflow_runs":[]}')).toEqual([])
  expect(parseRuns('github', '[]')).toBeUndefined()
  // Forgejo's list is Gitea-shaped, its runs its own.
  expect(
    parseRuns(
      'gitea',
      JSON.stringify({
        workflow_runs: [{ id: 9, status: 'running', commit_sha: SHA, prettyref: 'main', title: 'fix' }],
      }),
    ),
  ).toEqual([{ id: 9, state: 'running', ref: 'main', sha: SHA, name: 'fix' }])
})

const run = (id: number, state: Run['state'], extra: Partial<Run> = {}): Run => ({ id, state, ...extra })

test('runsOnRef: a watch of one ref leaves out what another branch or tag started', () => {
  const runs = [
    run(4, 'running', { ref: 'main' }),
    run(3, 'success', { ref: 'next' }),
    run(2, 'success', { ref: 'refs/merge-requests/7/head' }),
    run(1, 'success'),
    run(5, 'success', { ref: 'refs/heads/next' }),
    run(6, 'success', { ref: 'refs/tags/v1.0.0' }),
    run(7, 'success', { ref: '#12' }),
  ]
  expect(runsOnRef(runs, undefined).map(r => r.id)).toEqual([4, 3, 2, 1, 5, 6, 7])
  expect(runsOnRef(runs, 'next').map(r => r.id)).toEqual([3, 2, 1, 5, 7])
  expect(runsOnRef(runs, 'main').map(r => r.id)).toEqual([4, 2, 1, 7])
  expect(runsOnRef(runs, 'v1.0.0').map(r => r.id)).toEqual([2, 1, 6, 7])
})

test('runLabels: the workflow name; the trigger when two share it; the id when nothing else tells', () => {
  expect(
    runLabels([
      run(1, 'success', { name: 'Lint', source: 'push' }),
      run(2, 'success', { name: 'CI', source: 'push' }),
      run(3, 'success', { name: 'CI', source: 'pull_request' }),
      run(4, 'success', { source: 'push' }),
      run(5, 'success'),
    ]),
  ).toEqual(['Lint', 'CI (push)', 'CI (pull_request)', 'push #4', '#5'])
  expect(
    runLabels([
      run(1, 'success', { name: 'CI', source: 'push' }),
      run(2, 'failed', { name: 'CI', source: 'push' }),
    ]),
  ).toEqual(['CI #1', 'CI #2'])
})

test('aggregateRuns: one run reads as itself; several are one head and one job list', () => {
  const job = (name: string, state: Run['state'], stage = '') => ({ name, stage, state, durationS: 1 })
  const single = aggregateRuns([
    { run: run(7, 'running', { ref: 'main', url: 'https://x/7' }), jobs: [job('a', 'running', 'test')] },
  ])
  expect(single).toEqual({
    head: { id: 7, state: 'running', ref: 'main', url: 'https://x/7' },
    jobs: [job('a', 'running', 'test')],
    runs: undefined,
  })
  const parts = [
    {
      run: run(9, 'success', {
        name: 'Lint',
        ref: 'main',
        url: 'https://x/9',
        startedAt: '2026-11-06T20:00:10Z',
        pipelineFinishedAt: '2026-11-06T20:00:40Z',
      }),
      jobs: [job('eslint', 'success')],
    },
    {
      run: run(8, 'failed', {
        name: 'CI',
        ref: 'main',
        url: 'https://x/8',
        startedAt: '2026-11-06T20:00:05Z',
        pipelineFinishedAt: '2026-11-06T20:03:00Z',
      }),
      jobs: [job('unit', 'failed', 'test'), job('build', 'success', 'build')],
    },
  ]
  const many = aggregateRuns(parts)
  // The row is the failing run's (its id and link), over the whole span.
  expect(many.head).toEqual({
    id: 8,
    state: 'failed',
    ref: 'main',
    url: 'https://x/8',
    startedAt: '2026-11-06T20:00:05Z',
    pipelineFinishedAt: '2026-11-06T20:03:00Z',
  })
  expect(many.jobs.map(j => [j.stage, j.name, j.state])).toEqual([
    ['Lint', 'eslint', 'success'],
    ['CI · test', 'unit', 'failed'],
    ['CI · build', 'build', 'success'],
  ])
  expect(many.runs).toEqual([
    { id: 9, state: 'success', name: 'Lint', url: 'https://x/9' },
    { id: 8, state: 'failed', name: 'CI', url: 'https://x/8' },
  ])
  // Still going: no finish time yet, and the newest run leads.
  const [lint, ci] = parts as [(typeof parts)[0], (typeof parts)[0]]
  const going = aggregateRuns([{ ...lint, run: { ...lint.run, state: 'running' } }, ci])
  expect(going.head).toMatchObject({ id: 9, state: 'running' })
  expect(going.head?.pipelineFinishedAt).toBeUndefined()
})
