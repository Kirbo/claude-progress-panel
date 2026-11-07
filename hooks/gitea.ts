// Gitea / Forgejo Actions runs, read through the user's own `tea api` (the login whose URL is on the
// pipeline's host). Gitea's API mirrors GitHub's (status + conclusion, `{ jobs }`); Forgejo's has
// its own names (commit_sha, prettyref, started/stopped, a nanosecond duration, a plain job list).
// Both answer on /repos/{owner}/{repo}/actions/runs[/{id}[/jobs]] (swagger, 2026-11-07).

import type { JobState, PipelineJob } from '../types'
import { ghState, json, parseGhJobs, seconds, str } from './github'
import type { PipelineHead } from './pipelines'

/** Forgejo's run/job status → the pane's state (anything unknown reads as queued). */
export function forgejoState(status: string): JobState {
  switch (status) {
    case 'success':
      return 'success'
    case 'failure':
      return 'failed'
    case 'cancelled':
      return 'canceled'
    case 'skipped':
      return 'skipped'
    case 'running':
      return 'running'
    case 'blocked':
      return 'manual'
    default:
      return 'queued'
  }
}

// Forgejo writes an unset time as Go's zero time.
const time = (v: unknown): string | undefined => {
  const s = str(v)
  return s && !s.startsWith('0001-') ? s : undefined
}

/** One run (`…/actions/runs/<id>`) or the newest of a list (`…/actions/runs?head_sha=`), either forge. */
export function parseGiteaRun(text: string): PipelineHead | undefined {
  const raw = json(text) as Record<string, unknown> | undefined
  const r = (raw && Array.isArray(raw.workflow_runs) ? raw.workflow_runs[0] : raw) as
    | Record<string, unknown>
    | undefined
  if (!r || typeof r !== 'object' || typeof r.id !== 'number' || typeof r.status !== 'string')
    return undefined
  const isForgejo = 'commit_sha' in r || 'prettyref' in r
  const state = isForgejo ? forgejoState(r.status) : ghState(r.status, str(r.conclusion))
  const startedAt = time(isForgejo ? r.started : r.started_at)
  const finishedAt = isForgejo ? time(r.stopped) : r.status === 'completed' ? time(r.completed_at) : undefined
  const durationS =
    isForgejo && typeof r.duration === 'number' && r.duration > 0
      ? r.duration / 1e9
      : !isForgejo && finishedAt
        ? seconds(startedAt, finishedAt)
        : undefined
  const ref = str(isForgejo ? r.prettyref : r.head_branch)
  const sha = str(isForgejo ? r.commit_sha : r.head_sha)
  const source = str(isForgejo ? (r.trigger_event ?? r.event) : r.event)
  return {
    id: r.id,
    state,
    ...(ref ? { ref } : {}),
    ...(sha ? { sha } : {}),
    ...(str(r.html_url) ? { url: r.html_url as string } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { pipelineFinishedAt: finishedAt } : {}),
    ...(durationS !== undefined ? { durationS } : {}),
    ...(source ? { source } : {}),
  }
}

/** A run's jobs, in job order: Gitea's `{ jobs }` (GitHub-shaped) or Forgejo's plain list. */
export function parseGiteaJobs(text: string): PipelineJob[] | undefined {
  const raw = json(text)
  if (!Array.isArray(raw)) return parseGhJobs(text)
  const id = (j: Record<string, unknown>) => (typeof j.id === 'number' ? j.id : 0)
  return raw
    .filter(
      (j): j is Record<string, unknown> =>
        typeof j === 'object' && j !== null && typeof j.name === 'string' && typeof j.status === 'string',
    )
    .sort((a, b) => id(a) - id(b))
    .map(j => ({
      name: j.name as string,
      stage: '',
      state: forgejoState(j.status as string),
      // Forgejo's job list carries no times (only a single job's steps do).
      durationS: null,
      ...(str(j.html_url) ? { url: j.html_url as string } : {}),
    }))
}

/** `tea login list --output json` → the login whose URL is on `host`. */
export function teaLoginFor(text: string, host: string): string | undefined {
  const raw = json(text)
  if (!Array.isArray(raw)) return undefined
  const want = host.toLowerCase()
  for (const l of raw as Record<string, unknown>[]) {
    const url = str(l?.url)
      ?.replace(/^[a-z]+:\/\//i, '')
      .replace(/\/+$/, '')
      .toLowerCase()
    if (url === want && str(l.name)) return l.name as string
  }
  return undefined
}
