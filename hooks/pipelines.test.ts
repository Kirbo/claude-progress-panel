import { expect, test } from 'claude-code/testing'

import type { Pipeline, PipelineJob } from './pipelines'
import {
  applyWatch,
  estimateFrom,
  formatDuration,
  formatEstimate,
  isFinished,
  jobCounts,
  jobEstimatesFrom,
  jobState,
  parseJobs,
  parsePipeline,
  parseSampleIds,
  pipelineDuration,
  progressBar,
  stageGroups,
  visiblePipelines,
} from './pipelines'

const T0 = Date.UTC(2026, 10, 6, 20, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

function job(name: string, state: PipelineJob['state'], durationS: number | null = null): PipelineJob {
  return { name, stage: 'build', state, durationS }
}

test('jobState folds GitLab statuses into queued / running / done states', () => {
  expect(['created', 'pending', 'waiting_for_resource', 'preparing', 'scheduled'].map(jobState)).toEqual([
    'queued',
    'queued',
    'queued',
    'queued',
    'queued',
  ])
  expect(
    ['running', 'success', 'failed', 'canceled', 'canceling', 'skipped', 'manual', 'odd'].map(jobState),
  ).toEqual(['running', 'success', 'failed', 'canceled', 'canceled', 'skipped', 'manual', 'queued'])
  expect(
    isFinished('success') && isFinished('failed') && isFinished('canceled') && isFinished('skipped'),
  ).toBe(true)
  expect(isFinished('running') || isFinished('queued') || isFinished('manual')).toBe(false)
})

test('jobCounts: finished / total and one count per state', () => {
  const jobs = [
    job('a', 'running'),
    job('b', 'running'),
    job('c', 'queued'),
    job('d', 'skipped'),
    job('e', 'success'),
    job('f', 'success'),
    job('g', 'failed'),
    job('h', 'manual'),
  ]
  expect(jobCounts(jobs)).toEqual({
    total: 8,
    finished: 4,
    running: 2,
    queued: 1,
    skipped: 1,
    success: 2,
    failed: 1,
    canceled: 0,
    manual: 1,
  })
})

test('stageGroups keeps pipeline order and groups each stage once', () => {
  const groups = stageGroups([
    { name: 'img', stage: 'images', state: 'success', durationS: 1 },
    { name: 'check', stage: 'verify', state: 'queued', durationS: null },
    { name: 'img2', stage: 'images', state: 'running', durationS: null },
  ])
  expect(groups.map(g => [g.stage, g.jobs.map(j => j.name)])).toEqual([
    ['images', ['img', 'img2']],
    ['verify', ['check']],
  ])
})

test("pipelineDuration: running counts from the start, finished uses GitLab's duration", () => {
  const started = '2026-11-06T20:00:00.000Z'
  const base: Pipeline = {
    key: 'g/a#1',
    project: 'g/a',
    id: 1,
    label: 'a',
    state: 'running',
    jobs: [],
    addedAt: started,
    checkedAt: started,
  }
  expect(pipelineDuration(base, Date.parse(started) + 125_000)).toBeNull()
  expect(pipelineDuration({ ...base, startedAt: started }, Date.parse(started) + 125_000)).toBe(125)
  expect(pipelineDuration({ ...base, state: 'success', startedAt: started, durationS: 393 }, 0)).toBe(393)
  expect(
    pipelineDuration(
      { ...base, state: 'failed', startedAt: started, pipelineFinishedAt: '2026-11-06T20:01:00.000Z' },
      0,
    ),
  ).toBe(60)
})

test('progressBar fills by finished share; formatDuration reads like a timer', () => {
  expect(progressBar(4, 8, 8)).toBe('████░░░░')
  expect(progressBar(0, 0, 4)).toBe('░░░░')
  expect(progressBar(9, 8, 4)).toBe('████')
  expect(formatDuration(26)).toBe('26s')
  expect(formatDuration(393.4)).toBe('6m33s')
  expect(formatDuration(3720)).toBe('1h02m')
  expect(formatDuration(null)).toBe('')
})

test('parsePipeline / parseJobs read glab api output and refuse anything else', () => {
  const p = parsePipeline(
    JSON.stringify({ id: 42, status: 'running', ref: 'main', sha: 'abc1234def', web_url: 'https://x/p/42' }),
  )
  expect(p).toEqual({ id: 42, state: 'running', ref: 'main', sha: 'abc1234def', url: 'https://x/p/42' })
  expect(
    parsePipeline(
      JSON.stringify({
        id: 43,
        status: 'success',
        started_at: '2026-11-06T20:00:00.000Z',
        finished_at: '2026-11-06T20:06:40.000Z',
        duration: 393,
      }),
    ),
  ).toEqual({
    id: 43,
    state: 'success',
    startedAt: '2026-11-06T20:00:00.000Z',
    pipelineFinishedAt: '2026-11-06T20:06:40.000Z',
    durationS: 393,
  })
  expect(parsePipeline('[]')).toBeUndefined()
  expect(parsePipeline('{ nope')).toBeUndefined()
  // `pipelines?sha=` answers a list: the newest first.
  expect(
    parsePipeline(JSON.stringify([{ id: 7, status: 'success', ref: 'next', sha: 's', web_url: 'u' }]))?.id,
  ).toBe(7)

  // GitLab lists jobs newest first; the pane wants pipeline order (oldest id first).
  const jobs = parseJobs(
    JSON.stringify([
      { id: 12, name: 'a', stage: 'test', status: 'pending', duration: null },
      { id: 11, name: 'b', stage: 'build', status: 'success', duration: 12.5 },
      { bad: true },
    ]),
  )
  expect(jobs).toEqual([
    { name: 'b', stage: 'build', state: 'success', durationS: 12.5 },
    { name: 'a', stage: 'test', state: 'queued', durationS: null },
  ])
  expect(parseJobs('{}')).toBeUndefined()
})

test('applyWatch adds each pipeline once, by id or by commit, and unwatch removes it', () => {
  let list: Pipeline[] = []
  let errors: string[]
  ;({ list, errors } = applyWatch(
    list,
    [
      { project: 'g/app', pipeline: 42 },
      { project: 'g/app', pipeline: 42 },
      { project: 'g/lib', sha: 'abc1234def', label: 'lib' },
      { project: '', pipeline: 1 },
      { project: 'g/x' },
    ],
    [],
    iso(T0),
  ))
  expect(list.map(p => [p.key, p.label, p.id, p.state])).toEqual([
    ['g/app#42', 'app', 42, 'unknown'],
    ['g/lib@abc1234def', 'lib', null, 'unknown'],
  ])
  expect(errors).toEqual([
    'watch[3]: a pipeline needs a project (group/name)',
    'watch[4]: give a pipeline id or a commit sha',
  ])
  ;({ list, errors } = applyWatch(list, [], ['g/app#42', 'nope'], iso(T0)))
  expect(list.map(p => p.key)).toEqual(['g/lib@abc1234def'])
  expect(errors).toEqual(['unwatch: no pipeline nope'])
})

test('visiblePipelines hides a pipeline the person dismissed, for that same finish', () => {
  const done: Pipeline = {
    key: 'g/app#42',
    project: 'g/app',
    id: 42,
    label: 'app',
    state: 'success',
    jobs: [],
    addedAt: iso(T0),
    checkedAt: iso(T0),
    finishedAt: iso(T0 + 1000),
  }
  expect(visiblePipelines([done], [{ id: 'pipeline:g/app#42', doneAt: iso(T0 + 1000) }])).toEqual([])
  expect(visiblePipelines([done], [{ id: 'pipeline:g/app#42', doneAt: iso(T0) }])).toEqual([done])
})

test('the estimate: the average of the samples, formatted with ~', () => {
  expect(estimateFrom([1800, 2400, 2100, 2000, 1700])).toBe(2000)
  expect(estimateFrom([])).toBeNull()
  expect(formatEstimate(45)).toBe('~45s')
  expect(formatEstimate(1985)).toBe('~33m')
  expect(formatEstimate(3900)).toBe('~1h05m')
})

test('job estimates: each job name averaged over the similar runs where it succeeded', () => {
  // GitLab's list has no duration: up to 5 ids, never this pipeline's own.
  expect(
    parseSampleIds(
      JSON.stringify([{ id: 9 }, { id: 8 }, { id: 7 }, { id: 6 }, { id: 5 }, { id: 4 }, { id: 3 }]),
      9,
    ),
  ).toEqual([8, 7, 6, 5, 4])
  expect(parseSampleIds('{ nope', 1)).toEqual([])
  const runA = [
    { name: 'lint', stage: 'test', state: 'success', durationS: 100 },
    { name: 'build', stage: 'build', state: 'success', durationS: 500 },
  ] as const
  const runB = [
    { name: 'lint', stage: 'test', state: 'success', durationS: 140 },
    { name: 'build', stage: 'build', state: 'failed', durationS: 30 },
    { name: 'deploy', stage: 'deploy', state: 'skipped', durationS: null },
  ] as const
  expect(jobEstimatesFrom([[...runA], [...runB]] as never)).toEqual({ lint: 120, build: 500 })
  expect(jobEstimatesFrom([])).toEqual({})
  expect(
    parseJobs(
      JSON.stringify([
        {
          id: 1,
          name: 'a',
          stage: 's',
          status: 'running',
          duration: null,
          started_at: '2026-11-06T20:00:00.000Z',
        },
      ]),
    ),
  ).toEqual([
    { name: 'a', stage: 's', state: 'running', durationS: null, startedAt: '2026-11-06T20:00:00.000Z' },
  ])
})
