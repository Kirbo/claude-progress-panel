// GitHub Actions runs a session watches: the pure parts (GitHub's answers → the pane's states and
// heads). The session's own timer fetches them through the user's `gh` (register.tsx). Field names
// verified against the real API on 2026-11-07 (docs/design/MULTI-SESSION.md "GitHub Actions").

import type { JobState, PipelineJob } from '../types'
import type { PipelineHead } from './pipelines'

/** GitHub splits a run's (or job's) state into `status` and, once completed, `conclusion`. */
export function ghState(status: string, conclusion: string | null | undefined): JobState {
  if (status === 'in_progress') return 'running'
  if (status === 'waiting') return 'manual'
  if (status !== 'completed') return 'queued'
  switch (conclusion) {
    case 'success':
    case 'neutral':
      return 'success'
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed'
    case 'cancelled':
    case 'stale':
      return 'canceled'
    case 'skipped':
      return 'skipped'
    case 'action_required':
      return 'manual'
    default:
      return 'queued'
  }
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Seconds between two ISO stamps; undefined when either is missing or unreadable. */
function seconds(from: unknown, to: unknown): number | undefined {
  const a = typeof from === 'string' ? Date.parse(from) : Number.NaN
  const b = typeof to === 'string' ? Date.parse(to) : Number.NaN
  return Number.isNaN(a) || Number.isNaN(b) ? undefined : Math.max(0, Math.round((b - a) / 1000))
}

export type GhRunHead = PipelineHead & { workflowId?: number }

/** `gh api repos/<o>/<r>/actions/runs/<id>` (a run) or `…/actions/runs?head_sha=` (a list, newest first). */
export function parseGhRun(text: string): GhRunHead | undefined {
  const raw = json(text) as Record<string, unknown> | undefined
  const r = (raw && Array.isArray(raw.workflow_runs) ? raw.workflow_runs[0] : raw) as
    | Record<string, unknown>
    | undefined
  if (!r || typeof r !== 'object' || typeof r.id !== 'number' || typeof r.status !== 'string')
    return undefined
  const state = ghState(r.status, str(r.conclusion))
  const done = r.status === 'completed'
  // A run has no duration of its own: updated_at − run_started_at (= the timing endpoint's).
  const durationS = done ? seconds(r.run_started_at, r.updated_at) : undefined
  return {
    id: r.id,
    state,
    ...(str(r.head_branch) ? { ref: r.head_branch as string } : {}),
    ...(str(r.head_sha) ? { sha: r.head_sha as string } : {}),
    ...(str(r.html_url) ? { url: r.html_url as string } : {}),
    ...(str(r.run_started_at) ? { startedAt: r.run_started_at as string } : {}),
    ...(done && str(r.updated_at) ? { pipelineFinishedAt: r.updated_at as string } : {}),
    ...(durationS !== undefined ? { durationS } : {}),
    ...(str(r.event) ? { source: r.event as string } : {}),
    ...(typeof r.workflow_id === 'number' ? { workflowId: r.workflow_id } : {}),
  }
}

/**
 * `gh api …/actions/runs/<id>/jobs` → the jobs in start order (by job id). GitHub has no stages:
 * every job's `stage` is empty and the pane lists them flat.
 */
export function parseGhJobs(text: string): PipelineJob[] | undefined {
  const raw = json(text) as Record<string, unknown> | undefined
  if (!raw || !Array.isArray(raw.jobs)) return undefined
  const id = (j: Record<string, unknown>) => (typeof j.id === 'number' ? j.id : 0)
  return (raw.jobs as unknown[])
    .filter(
      (j): j is Record<string, unknown> =>
        typeof j === 'object' && j !== null && typeof j.name === 'string' && typeof j.status === 'string',
    )
    .sort((a, b) => id(a) - id(b))
    .map(j => {
      const started = j.status === 'in_progress' || j.status === 'completed'
      const durationS = j.status === 'completed' ? seconds(j.started_at, j.completed_at) : undefined
      return {
        name: j.name as string,
        stage: '',
        state: ghState(j.status as string, str(j.conclusion)),
        durationS: durationS ?? null,
        ...(started && str(j.started_at) ? { startedAt: j.started_at as string } : {}),
        ...(str(j.html_url) ? { url: j.html_url as string } : {}),
      }
    })
}

/**
 * Up to 5 earlier runs from `…/actions/workflows/<id>/runs?status=success&branch=&event=`, never
 * `exceptId`, each with its duration read from the list itself (no detail call, unlike GitLab).
 */
export function ghEstimateSamples(text: string, exceptId: number): { id: number; durationS: number }[] {
  const raw = json(text) as Record<string, unknown> | undefined
  if (!raw || !Array.isArray(raw.workflow_runs)) return []
  const out: { id: number; durationS: number }[] = []
  for (const r of raw.workflow_runs as Record<string, unknown>[]) {
    if (out.length >= 5) break
    if (typeof r?.id !== 'number' || r.id === exceptId) continue
    const d = seconds(r.run_started_at, r.updated_at)
    if (d !== undefined && d > 0) out.push({ id: r.id, durationS: d })
  }
  return out
}
