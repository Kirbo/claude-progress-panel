import { expect, test } from 'claude-code/testing'

import { forgejoState, parseGiteaJobs, parseGiteaRun, teaLoginFor } from './gitea'

// Shapes from the servers' own swagger (gitea.com 1.25: ActionWorkflowRun / ActionWorkflowJob,
// GitHub-like; codeberg.org Forgejo 17: ActionRun / ActionRunJob), checked 2026-11-07.
const giteaRun = {
  id: 31,
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  head_sha: 'abc123',
  html_url: 'https://git.example.com/team/app/actions/runs/31',
  event: 'push',
  started_at: '2026-11-07T10:00:00Z',
  completed_at: '2026-11-07T10:03:30Z',
  updated_at: '2026-11-07T10:03:31Z',
}
const forgejoRun = {
  id: 77,
  status: 'running',
  commit_sha: 'def456',
  prettyref: 'main',
  html_url: 'https://codeberg.org/team/app/actions/runs/5',
  trigger_event: 'push',
  started: '2026-11-07T10:00:00Z',
  stopped: '0001-01-01T00:00:00Z',
  duration: 0,
}

test('parseGiteaRun reads a Gitea run (GitHub-shaped) — alone or as the newest of a list', () => {
  const head = {
    id: 31,
    state: 'success',
    ref: 'main',
    sha: 'abc123',
    url: 'https://git.example.com/team/app/actions/runs/31',
    startedAt: '2026-11-07T10:00:00Z',
    pipelineFinishedAt: '2026-11-07T10:03:30Z',
    durationS: 210,
    source: 'push',
  }
  expect(parseGiteaRun(JSON.stringify(giteaRun))).toEqual(head)
  expect(parseGiteaRun(JSON.stringify({ total_count: 1, workflow_runs: [giteaRun] }))).toEqual(head)
  expect(parseGiteaRun(JSON.stringify({ total_count: 0, workflow_runs: [] }))).toBeUndefined()
  expect(parseGiteaRun('nope')).toBeUndefined()
})

test('parseGiteaRun reads a Forgejo run: its own names, nanosecond duration, a zero time is none', () => {
  expect(parseGiteaRun(JSON.stringify({ total_count: 1, workflow_runs: [forgejoRun] }))).toEqual({
    id: 77,
    state: 'running',
    ref: 'main',
    sha: 'def456',
    url: 'https://codeberg.org/team/app/actions/runs/5',
    startedAt: '2026-11-07T10:00:00Z',
    source: 'push',
  })
  const done = { ...forgejoRun, status: 'failure', stopped: '2026-11-07T10:01:00Z', duration: 60_000_000_000 }
  expect(parseGiteaRun(JSON.stringify(done))).toMatchObject({
    state: 'failed',
    pipelineFinishedAt: '2026-11-07T10:01:00Z',
    durationS: 60,
  })
})

test('forgejoState folds Forgejo statuses into the pane states', () => {
  expect(
    ['success', 'failure', 'cancelled', 'skipped', 'waiting', 'running', 'blocked', 'unknown', 'odd'].map(
      forgejoState,
    ),
  ).toEqual(['success', 'failed', 'canceled', 'skipped', 'queued', 'running', 'manual', 'queued', 'queued'])
})

test("parseGiteaJobs reads Gitea's { jobs } and Forgejo's plain list, in job order", () => {
  const gitea = {
    total_count: 2,
    jobs: [
      { id: 2, name: 'test', status: 'in_progress', started_at: '2026-11-07T10:01:00Z', html_url: 'u2' },
      {
        id: 1,
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-11-07T10:00:00Z',
        completed_at: '2026-11-07T10:00:20Z',
      },
    ],
  }
  expect(parseGiteaJobs(JSON.stringify(gitea))).toEqual([
    { name: 'lint', stage: '', state: 'success', durationS: 20, startedAt: '2026-11-07T10:00:00Z' },
    {
      name: 'test',
      stage: '',
      state: 'running',
      durationS: null,
      startedAt: '2026-11-07T10:01:00Z',
      url: 'u2',
    },
  ])
  const forgejo = [
    { id: 9, name: 'build', status: 'running', html_url: 'u9' },
    { id: 8, name: 'setup', status: 'success' },
  ]
  expect(parseGiteaJobs(JSON.stringify(forgejo))).toEqual([
    { name: 'setup', stage: '', state: 'success', durationS: null },
    { name: 'build', stage: '', state: 'running', durationS: null, url: 'u9' },
  ])
  expect(parseGiteaJobs('{}')).toBeUndefined()
})

test('teaLoginFor picks the tea login whose URL is on the host', () => {
  const logins = JSON.stringify([
    {
      name: 'work',
      url: 'https://git.example.com',
      ssh_host: 'git.example.com',
      user: 'me',
      default: 'false',
    },
    { name: 'cb', url: 'https://codeberg.org/', ssh_host: '', user: 'me', default: 'true' },
  ])
  expect(teaLoginFor(logins, 'codeberg.org')).toBe('cb')
  expect(teaLoginFor(logins, 'GIT.example.com')).toBe('work')
  expect(teaLoginFor(logins, 'gitea.com')).toBeUndefined()
  expect(teaLoginFor('not json', 'codeberg.org')).toBeUndefined()
})
