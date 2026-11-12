// CI pipelines a session watches: the pure parts (GitLab answers → states, counts, the bar). The
// session's own timer fetches them through `glab` (register.tsx).

import type { Dismissal, JobState, Pipeline, PipelineJob, PipelineProvider } from '../types'
import type { Remote } from './forges'
import { defaultHost, isHostName, watchHost } from './forges'
import { baseName } from './paths'

export type { JobState, Pipeline, PipelineJob, PipelineProvider }

export type WatchInput = {
  provider?: PipelineProvider
  project?: string
  pipeline?: number
  /** GitHub: the workflow run id (`pipeline` is accepted too). */
  run?: number
  sha?: string
  label?: string
  /** The forge's host (self-hosted GitLab, GitHub Enterprise, Gitea/Forgejo); default: the
   *  session's remote host when the watch is that repo, else the forge's public host. */
  host?: string
}

export const PROVIDERS: readonly PipelineProvider[] = ['gitlab', 'github', 'gitea', 'command']
const KEY_PREFIX: Record<PipelineProvider, string> = {
  gitlab: '',
  github: 'gh:',
  gitea: 'gt:',
  command: 'ci:',
}

/**
 * A watched pipeline's key: GitLab's `project#id` / `project@sha`; GitHub's, Gitea's and a custom
 * command's with a `gh:` / `gt:` / `ci:` prefix; a host other than the forge's public one leads
 * the project (`git.example.com/team/app#7`).
 */
export function pipelineKey(provider: PipelineProvider, project: string, ref: string, host?: string): string {
  const where = host && host !== defaultHost(provider) ? `${host}/` : ''
  return `${KEY_PREFIX[provider]}${where}${project}${ref}`
}

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

const ERROR_MAX = 200

/**
 * A CLI's message as one short line: its last non-empty line, clipped to 200 characters ('' when
 * there is none). Never fed a forge CLI's stdout — that is the API's answer, not a message.
 */
export function oneLine(text: string): string {
  const line =
    text
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line
}

/**
 * A pipeline's stored error as the pane draws it: one short line — or nothing when it is an API
 * answer (JSON), which 0.21.1 and earlier stored as the error of a CLI that failed with a quiet
 * stderr; a finished pipeline is never polled again, so that value would otherwise stay.
 */
export function shownError(stored: string): string {
  return /^\s*[[{]/.test(stored) ? '' : oneLine(stored)
}

/** A job's name / a stage's, as kept: one line of at most this many characters. */
export const JOB_NAME_MAX = 80
export const STAGE_NAME_MAX = 60
const URL_MAX = 2000

// Control characters (C0, DEL, C1) and format characters (the bidi controls, the zero-width ones,
// the byte-order mark): what could break a line apart, hide text or reorder it.
const UNSAFE = /[\p{Cc}\p{Cf}]/gu
// Everything that ends or splits a line reads as one space.
const LINE_BREAKS = /[\r\n\t\p{Zl}\p{Zp}]+/gu

/**
 * Text a forge (or a custom command, or a stored file) supplied — a job's name, a stage — as the
 * plugin keeps it: one line, without control, bidi or zero-width characters, at most `max` long.
 * Such text is third-party: it is shown in the pane and can reach an agent inside a plugin note.
 */
export function cleanText(text: unknown, max: number): string {
  if (typeof text !== 'string') return ''
  const line = text.replace(LINE_BREAKS, ' ').replace(UNSAFE, '').replace(/ {2,}/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** An address the pane may turn into a link: an absolute http(s) URL, nothing else. */
export function httpUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length > URL_MAX) return undefined
  return /^https?:\/\/[^\s\p{Cc}]+$/iu.test(url) ? url : undefined
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
    ...(httpUrl(p.web_url) ? { url: p.web_url as string } : {}),
    ...(typeof p.started_at === 'string' ? { startedAt: p.started_at } : {}),
    ...(typeof p.finished_at === 'string' ? { pipelineFinishedAt: p.finished_at } : {}),
    ...(typeof p.duration === 'number' ? { durationS: p.duration } : {}),
    ...(typeof p.source === 'string' ? { source: p.source } : {}),
  }
}

/**
 * The ids of up to 5 earlier pipelines from a `pipelines?status=success` list, never `exceptId`.
 * GitLab's list carries no duration: each sample's details (`pipelines/<id>`) give it.
 */
export function parseSampleIds(text: string, exceptId: number): number[] {
  const raw = json(text)
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (p): p is { id: number } =>
        typeof p === 'object' && p !== null && typeof p.id === 'number' && p.id !== exceptId,
    )
    .slice(0, 5)
    .map(p => p.id)
}

/** Per job name, the average duration over the runs in which that job succeeded. */
export function jobEstimatesFrom(runs: readonly (readonly PipelineJob[])[]): Record<string, number> {
  const samples: Record<string, number[]> = {}
  for (const run of runs)
    for (const j of run)
      if (j.state === 'success' && typeof j.durationS === 'number' && j.durationS > 0)
        samples[j.name] = [...(samples[j.name] ?? []), j.durationS]
  return Object.fromEntries(Object.entries(samples).map(([name, xs]) => [name, estimateFrom(xs) as number]))
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
      name: cleanText(j.name, JOB_NAME_MAX),
      stage: cleanText(j.stage, STAGE_NAME_MAX),
      state: jobState(j.status as string),
      durationS: typeof j.duration === 'number' ? j.duration : null,
      ...(typeof j.started_at === 'string' ? { startedAt: j.started_at } : {}),
      ...(httpUrl(j.web_url) ? { url: j.web_url as string } : {}),
    }))
}

/** Adds watched pipelines (each key once) and removes unwatched ones; problems are listed, not thrown. */
export function applyWatch(
  list: readonly Pipeline[],
  watch: readonly WatchInput[],
  unwatch: readonly string[],
  nowIso: string,
  remote?: Remote,
): { list: Pipeline[]; errors: string[] } {
  const errors: string[] = []
  let next = [...list]
  for (const key of unwatch) {
    if (next.some(p => p.key === key)) next = next.filter(p => p.key !== key)
    else errors.push(`unwatch: no pipeline ${key}`)
  }
  watch.forEach((w, i) => {
    const provider = w.provider ?? 'gitlab'
    if (!PROVIDERS.includes(provider)) {
      errors.push(`watch[${i}]: unknown provider ${String(provider)} (gitlab, github, gitea or command)`)
      return
    }
    const project = (w.project ?? '').trim()
    if (!project) {
      errors.push(
        `watch[${i}]: a pipeline needs a project (${provider === 'gitlab' ? 'group/name' : provider === 'command' ? 'a name your command knows' : 'owner/repo'})`,
      )
      return
    }
    // A custom command gets the project as an argument: never one that reads as an option.
    if (project.startsWith('-')) {
      errors.push(`watch[${i}]: a project may not start with "-"`)
      return
    }
    if (!isSafeProject(project, provider)) {
      errors.push(
        `watch[${i}]: ${project} is not a project path (${provider === 'gitlab' ? 'group/name' : 'owner/repo'})`,
      )
      return
    }
    const isRun = provider === 'github' || provider === 'gitea'
    const given = isRun ? (w.run ?? w.pipeline) : w.pipeline
    const id = typeof given === 'number' && given > 0 ? given : null
    const sha = w.sha?.trim()
    if (id === null && !sha) {
      errors.push(`watch[${i}]: give a ${isRun ? 'run' : 'pipeline'} id or a commit sha`)
      return
    }
    // A sha is stored and fills a custom command's `{sha}`; a host is a CLI's `--hostname`: neither
    // is ever anything but what its name says.
    if (sha && !isCommitSha(sha)) {
      errors.push(`watch[${i}]: ${quoted(sha)} is not a commit sha (7 to 64 hex digits)`)
      return
    }
    const host = provider === 'command' ? undefined : watchHost(w.host, project, remote)
    if (host && !isHostName(host)) {
      errors.push(`watch[${i}]: ${quoted(host)} is not a host name (like git.example.com)`)
      return
    }
    if (provider === 'gitea' && !host) {
      errors.push(
        `watch[${i}]: a Gitea/Forgejo pipeline needs a host (or watch it from a session in that repo)`,
      )
      return
    }
    const key = pipelineKey(provider, project, id !== null ? `#${id}` : `@${sha}`, host)
    if (next.some(p => p.key === key)) return
    next.push({
      key,
      ...(provider !== 'gitlab' ? { provider } : {}),
      ...(host ? { host } : {}),
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
  // A finished one hides for that finish; one hidden while it ran (`doneAt: null`, 0.23.2) stays hidden.
  return list.filter(
    p =>
      !entries.some(
        d =>
          d.id === `pipeline:${p.key}` &&
          (d.doneAt === null || (p.finishedAt !== undefined && d.doneAt === p.finishedAt)),
      ),
  )
}

/**
 * The owner's list with the panes' refreshed copies laid over it: per key, a copy checked later
 * than the owner's entry wins. Copies of keys the owner no longer watches are dropped.
 */
export function overlayPipelines(list: Pipeline[], refreshed: readonly Pipeline[]): Pipeline[] {
  if (refreshed.length === 0) return list
  const checkedMs = (p: Pipeline) =>
    p.checkedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(p.checkedAt)
  return list.map(p => {
    const copy = refreshed.find(r => r.key === p.key)
    return copy && copy.checkedAt !== null && checkedMs(copy) > checkedMs(p) ? copy : p
  })
}

/**
 * Unfinished and not checked for longer than `limitMs` (one never checked: since it was added) —
 * the session watching it stopped polling, so any pane picks it up.
 */
export function isOrphaned(p: Pipeline, nowMs: number, limitMs: number): boolean {
  if (isFinished(p.state)) return false
  return nowMs - Date.parse(p.checkedAt ?? p.addedAt) > limitMs
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

/**
 * Whether a watched project may be used as it is. A forge's project becomes part of an API path
 * (`repos/<project>/actions/runs/…`), so it is a plain `owner/name` path: no empty, `.` or `..`
 * segment, and only what a forge allows in a path (letters, digits, `.`, `_`, `-`). A custom command's
 * project is its script's own name for the job — one argument, never one that reads as an option.
 */
export function isSafeProject(project: string, provider: PipelineProvider | undefined): boolean {
  if (!project || project.startsWith('-')) return false
  if (provider === 'command') return true
  if (!/^[A-Za-z0-9._/-]+$/.test(project)) return false
  return project.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

// A refused value as its error quotes it: clipped, so an answer never carries a long one back.
function quoted(value: string): string {
  return JSON.stringify(value.length > 48 ? `${value.slice(0, 47)}…` : value)
}

/** A commit id as a watch may name it: 7 to 64 hex digits (abbreviated, SHA-1 or SHA-256) — never
 *  anything a command line could read as an option. */
export function isCommitSha(sha: unknown): sha is string {
  return typeof sha === 'string' && /^[0-9a-f]{7,64}$/i.test(sha)
}

/** A whole commit id (SHA-1's 40 or SHA-256's 64 hex digits) — what every forge's by-commit
 *  pipeline / run filter matches; an abbreviated one finds nothing. */
export function isFullSha(sha: string | undefined): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha ?? '')
}

/** The full commit id in a forge's commit answer (GitLab `id`, GitHub `sha`), if whole. */
export function parseCommitSha(text: string): string | undefined {
  const raw = json(text) as Record<string, unknown> | undefined
  const sha = raw && typeof raw === 'object' ? (raw.sha ?? raw.id) : undefined
  return typeof sha === 'string' && isFullSha(sha) ? sha : undefined
}

/** How long a by-commit watch waits quietly for its pipeline before saying it has found none. */
export const NO_PIPELINE_HINT_MS = 10 * 60_000

/**
 * A by-commit watch that found no pipeline this round: checked, any earlier error dropped (it was
 * about a call that has since answered), and — once it has waited NO_PIPELINE_HINT_MS — the
 * `noPipeline` flag and a note (`hint`, shown on the row)
 * instead of an endless "unknown 0/0" (2026-11-08: a watch by an abbreviated sha waited forever).
 */
export function stillWaiting(p: Pipeline, at: string, hint: string): Pipeline {
  const { error: _dropped, ...rest } = p
  const waited = Date.parse(at) - Date.parse(p.addedAt)
  return waited > NO_PIPELINE_HINT_MS
    ? { ...rest, checkedAt: at, error: hint, noPipeline: true }
    : { ...rest, checkedAt: at }
}

/** How long a failed or canceled pipeline is still re-checked after it finished — a retry turns it
 *  back into a running one — and how often (2026-11-08: a retried pipeline stayed "failed" in the
 *  pane while its retry ran and passed). */
export const RETRY_WATCH_MS = 2 * 3_600_000
export const RETRY_CHECK_MS = 60_000

/** Whether a poll round asks the forge about `p` now: every unfinished pipeline; a failed or
 *  canceled one within RETRY_WATCH_MS of finishing, at most every RETRY_CHECK_MS. */
export function shouldPoll(p: Pipeline, nowMs: number): boolean {
  if (!isFinished(p.state)) return true
  if (p.state !== 'failed' && p.state !== 'canceled') return false
  const ended = Date.parse(p.finishedAt ?? '') || 0
  const checked = Date.parse(p.checkedAt ?? '') || 0
  return nowMs - ended < RETRY_WATCH_MS && nowMs - checked >= RETRY_CHECK_MS
}
