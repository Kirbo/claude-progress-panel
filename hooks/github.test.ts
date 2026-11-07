import { expect, test } from 'claude-code/testing'

import { ghEstimateSamples, ghState, parseGhJobs, parseGhRun } from './github'

// Shapes copied from the real API (`gh api repos/Kirbo/switchboard-ha/actions/runs?per_page=1` and
// `…/actions/runs/<id>/jobs`, 2026-11-07), trimmed to the fields the pane reads. A run carries no
// duration of its own: `updated_at − run_started_at` equals the `…/timing` endpoint's
// `run_duration_ms` (52 s for this run), so no extra call is needed.
const RUN = {
  id: 42328151166,
  name: 'Validate',
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  head_sha: '8e6b5df3a1b2c3d4e5f60718293a4b5c6d7e8f90',
  event: 'push',
  workflow_id: 295608991,
  run_attempt: 1,
  run_started_at: '2026-11-07T02:13:34Z',
  created_at: '2026-11-07T02:13:34Z',
  updated_at: '2026-11-07T02:14:26Z',
  html_url: 'https://github.com/Kirbo/switchboard-ha/actions/runs/42328151166',
}

const JOB = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id,
  run_id: RUN.id,
  workflow_name: 'Validate',
  head_branch: 'main',
  name,
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-07T02:13:34Z',
  started_at: '2026-11-07T02:13:37Z',
  completed_at: '2026-11-07T02:14:14Z',
  html_url: `https://github.com/Kirbo/switchboard-ha/actions/runs/${RUN.id}/job/${id}`,
  ...over,
})

test('ghState folds status + conclusion into the pane states', () => {
  expect(
    [
      ['queued', null],
      ['requested', null],
      ['pending', null],
      ['waiting', null],
      ['in_progress', null],
    ].map(([s, c]) => ghState(s as string, c)),
  ).toEqual(['queued', 'queued', 'queued', 'manual', 'running'])
  expect(
    [
      'success',
      'neutral',
      'failure',
      'timed_out',
      'startup_failure',
      'cancelled',
      'stale',
      'skipped',
      'action_required',
      null,
    ].map(c => ghState('completed', c)),
  ).toEqual([
    'success',
    'success',
    'failed',
    'failed',
    'failed',
    'canceled',
    'canceled',
    'skipped',
    'manual',
    'queued',
  ])
})

test('parseGhRun reads one run, or the newest of a runs list (by commit)', () => {
  expect(parseGhRun(JSON.stringify(RUN))).toEqual({
    id: RUN.id,
    state: 'success',
    ref: 'main',
    sha: RUN.head_sha,
    url: RUN.html_url,
    startedAt: '2026-11-07T02:13:34Z',
    pipelineFinishedAt: '2026-11-07T02:14:26Z',
    durationS: 52,
    source: 'push',
    workflowId: 295608991,
  })
  // A running run: no finish, no duration yet.
  const running = parseGhRun(JSON.stringify({ ...RUN, status: 'in_progress', conclusion: null }))
  expect(running?.state).toBe('running')
  expect(running?.durationS).toBeUndefined()
  expect(running?.pipelineFinishedAt).toBeUndefined()
  // `actions/runs?head_sha=` answers `{ total_count, workflow_runs: [...] }`, newest first.
  expect(
    parseGhRun(
      JSON.stringify({
        total_count: 2,
        workflow_runs: [
          { ...RUN, id: 2 },
          { ...RUN, id: 1 },
        ],
      }),
    )?.id,
  ).toBe(2)
  expect(parseGhRun(JSON.stringify({ total_count: 0, workflow_runs: [] }))).toBeUndefined()
  expect(parseGhRun('{ nope')).toBeUndefined()
  expect(parseGhRun(JSON.stringify({ message: 'Not Found' }))).toBeUndefined()
})

test('parseGhJobs: start order, real durations, running jobs keep their start, flat (no stages)', () => {
  const jobs = parseGhJobs(
    JSON.stringify({
      total_count: 3,
      jobs: [
        JOB(3, 'Release', {
          status: 'queued',
          conclusion: null,
          started_at: '2026-11-07T02:14:18Z',
          completed_at: null,
        }),
        JOB(1, 'Tests'),
        JOB(2, 'Lint', {
          status: 'in_progress',
          conclusion: null,
          started_at: '2026-11-07T02:13:40Z',
          completed_at: null,
        }),
      ],
    }),
  )
  expect(jobs).toEqual([
    {
      name: 'Tests',
      stage: '',
      state: 'success',
      durationS: 37,
      startedAt: '2026-11-07T02:13:37Z',
      url: 'https://github.com/Kirbo/switchboard-ha/actions/runs/42328151166/job/1',
    },
    {
      name: 'Lint',
      stage: '',
      state: 'running',
      durationS: null,
      startedAt: '2026-11-07T02:13:40Z',
      url: 'https://github.com/Kirbo/switchboard-ha/actions/runs/42328151166/job/2',
    },
    // A queued job's started_at is not a start: it is left out.
    {
      name: 'Release',
      stage: '',
      state: 'queued',
      durationS: null,
      url: 'https://github.com/Kirbo/switchboard-ha/actions/runs/42328151166/job/3',
    },
  ])
  expect(parseGhJobs('[]')).toBeUndefined()
  expect(parseGhJobs('{ nope')).toBeUndefined()
})

test('estimate samples: up to 5 earlier successful runs, durations from the list itself', () => {
  const list = {
    total_count: 7,
    workflow_runs: [
      RUN,
      { ...RUN, id: 2, run_started_at: '2026-11-06T15:32:50Z', updated_at: '2026-11-06T15:33:44Z' },
      { ...RUN, id: 3, run_started_at: '2026-11-05T18:21:06Z', updated_at: '2026-11-05T18:22:07Z' },
      { ...RUN, id: 4, run_started_at: 'garbage' },
      { ...RUN, id: 5 },
      { ...RUN, id: 6 },
      { ...RUN, id: 7 },
    ],
  }
  // The run itself never counts; an unreadable one is skipped; at most 5.
  expect(ghEstimateSamples(JSON.stringify(list), RUN.id)).toEqual([
    { id: 2, durationS: 54 },
    { id: 3, durationS: 61 },
    { id: 5, durationS: 52 },
    { id: 6, durationS: 52 },
    { id: 7, durationS: 52 },
  ])
  expect(ghEstimateSamples('{ nope', 1)).toEqual([])
})
