// CI pipelines a session watches: the pure parts (GitLab answers → states, counts, the bar). The
// session's own timer fetches them through `glab` (register.tsx).

import type { Dismissal, JobState, Pipeline, PipelineJob } from '../types'
import { baseName } from './paths'

export type { JobState, Pipeline, PipelineJob }

export type WatchInput = { project?: string; pipeline?: number; sha?: string; label?: string }

const QUEUED = new Set(['created', 'pending', 'waiting_for_resource', 'preparing', 'scheduled'])

/** GitLab's job/pipeline status → the pane's state (anything unknown reads as queued). */
export function jobState(status: string): JobState {
  if (QUEUED.has(status)) return 'queued'
  if (status === 'canceling') return 'canceled'
  if (['running', 'success', 'failed', 'canceled', 'skipped', 'manual'].includes(status))
    return status as JobState
  return 'queued'
}

export function isFinished(state: JobState | 'unknown'): boolean {
  return state === 'success' || state === 'failed' || state === 'canceled' || state === 'skipped'
}

export type JobCounts = { total: number; finished: number } & Record<JobState, number>

export function jobCounts(jobs: readonly PipelineJob[]): JobCounts {
  const counts: JobCounts = {
    total: jobs.length,
    finished: 0,
    running: 0,
    queued: 0,
    skipped: 0,
    success: 0,
    failed: 0,
    canceled: 0,
    manual: 0,
  }
  for (const j of jobs) {
    counts[j.state] += 1
    if (isFinished(j.state)) counts.finished += 1
  }
  return counts
}

export function progressBar(finished: number, total: number, width = 8): string {
  const filled = total > 0 ? Math.min(width, Math.round((finished / total) * width)) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const pad = (n: number) => String(n).padStart(2, '0')

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return ''
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`
  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export type PipelineHead = {
  id: number
  state: JobState
  ref?: string
  sha?: string
  url?: string
  startedAt?: string
  pipelineFinishedAt?: string
  durationS?: number
  source?: string
}

/** `glab api …/pipelines/<id>` (an object) or `…/pipelines?sha=` (a list, newest first). */
export function parsePipeline(text: string): PipelineHead | undefined {
  const raw = json(text)
  const p = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object' || typeof p.id !== 'number' || typeof p.status !== 'string')
    return undefined
  return {
    id: p.id,
    state: jobState(p.status),
    ...(typeof p.ref === 'string' ? { ref: p.ref } : {}),
    ...(typeof p.sha === 'string' ? { sha: p.sha } : {}),
    ...(typeof p.web_url === 'string' ? { url: p.web_url } : {}),
    ...(typeof p.started_at === 'string' ? { startedAt: p.started_at } : {}),
    ...(typeof p.finished_at === 'string' ? { pipelineFinishedAt: p.finished_at } : {}),
    ...(typeof p.duration === 'number' ? { durationS: p.duration } : {}),
    ...(typeof p.source === 'string' ? { source: p.source } : {}),
  }
}

/** Durations (s) of up to 5 earlier pipelines from a `pipelines?status=success` list, skipping `exceptId`. */
export function parseDurations(text: string, exceptId: number): number[] {
  const raw = json(text)
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (p): p is { id: number; duration: number } =>
        typeof p === 'object' &&
        p !== null &&
        p.id !== exceptId &&
        typeof p.duration === 'number' &&
        p.duration > 0,
    )
    .slice(0, 5)
    .map(p => p.duration)
}

/** The estimate: the average of the samples, rounded to seconds; null without any. */
export function estimateFrom(durations: readonly number[]): number | null {
  if (durations.length === 0) return null
  return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
}

/** `~45s`, `~33m`, `~1h05m` — an estimate reads coarser than a measured duration. */
export function formatEstimate(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `~${s}s`
  if (s < 3600) return `~${Math.round(s / 60)}m`
  return `~${Math.floor(s / 3600)}h${pad(Math.round((s % 3600) / 60))}m`
}

/**
 * How long the pipeline has run, in seconds: while running, from its start to now (ticks live);
 * once finished, GitLab's own `duration` (what its UI shows), else finish − start. Null before it
 * has started.
 */
export function pipelineDuration(p: Pipeline, nowMs: number): number | null {
  const started = p.startedAt ? Date.parse(p.startedAt) : Number.NaN
  if (isFinished(p.state)) {
    if (typeof p.durationS === 'number') return p.durationS
    const ended = p.pipelineFinishedAt ? Date.parse(p.pipelineFinishedAt) : Number.NaN
    return Number.isNaN(started) || Number.isNaN(ended) ? null : Math.max(0, (ended - started) / 1000)
  }
  return Number.isNaN(started) ? null : Math.max(0, (nowMs - started) / 1000)
}

/**
 * `glab api …/pipelines/<id>/jobs` → the jobs in pipeline order. GitLab lists them newest first, so
 * they are sorted by job id, oldest first (retried attempts are not listed by GitLab).
 */
export function parseJobs(text: string): PipelineJob[] | undefined {
  const raw = json(text)
  if (!Array.isArray(raw)) return undefined
  const id = (j: Record<string, unknown>) => (typeof j.id === 'number' ? j.id : 0)
  return raw
    .filter(
      (j): j is Record<string, unknown> =>
        typeof j === 'object' && j !== null && typeof j.name === 'string' && typeof j.status === 'string',
    )
    .sort((a, b) => id(a) - id(b))
    .map(j => ({
      name: j.name as string,
      stage: typeof j.stage === 'string' ? j.stage : '',
      state: jobState(j.status as string),
      durationS: typeof j.duration === 'number' ? j.duration : null,
    }))
}

/** Adds watched pipelines (each key once) and removes unwatched ones; problems are listed, not thrown. */
export function applyWatch(
  list: readonly Pipeline[],
  watch: readonly WatchInput[],
  unwatch: readonly string[],
  nowIso: string,
): { list: Pipeline[]; errors: string[] } {
  const errors: string[] = []
  let next = [...list]
  for (const key of unwatch) {
    if (next.some(p => p.key === key)) next = next.filter(p => p.key !== key)
    else errors.push(`unwatch: no pipeline ${key}`)
  }
  watch.forEach((w, i) => {
    const project = (w.project ?? '').trim()
    if (!project) {
      errors.push(`watch[${i}]: a pipeline needs a project (group/name)`)
      return
    }
    const id = typeof w.pipeline === 'number' && w.pipeline > 0 ? w.pipeline : null
    const sha = w.sha?.trim()
    if (id === null && !sha) {
      errors.push(`watch[${i}]: give a pipeline id or a commit sha`)
      return
    }
    const key = id !== null ? `${project}#${id}` : `${project}@${sha}`
    if (next.some(p => p.key === key)) return
    next.push({
      key,
      project,
      id,
      ...(sha ? { sha } : {}),
      label: w.label?.trim() || baseName(project),
      state: 'unknown',
      jobs: [],
      addedAt: nowIso,
      checkedAt: null,
    })
  })
  return { list: next, errors }
}

/** The pipelines a pane shows: minus finished ones a sidecar entry dismissed for that same finish. */
export function visiblePipelines(list: readonly Pipeline[], entries: readonly Dismissal[]): Pipeline[] {
  return list.filter(
    p =>
      !entries.some(
        d => d.id === `pipeline:${p.key}` && p.finishedAt !== undefined && d.doneAt === p.finishedAt,
      ),
  )
}

/** The jobs grouped by stage, stages in the order they first appear (pipeline order). */
export function stageGroups(jobs: readonly PipelineJob[]): { stage: string; jobs: PipelineJob[] }[] {
  const groups: { stage: string; jobs: PipelineJob[] }[] = []
  for (const j of jobs) {
    const group = groups.find(g => g.stage === j.stage)
    if (group) group.jobs.push(j)
    else groups.push({ stage: j.stage, jobs: [j] })
  }
  return groups
}
