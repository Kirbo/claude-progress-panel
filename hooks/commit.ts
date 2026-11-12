// A watch by commit: every pipeline / workflow run a forge has for that commit (on the watched
// ref), read as ONE pipeline — the pure parts (API paths, list answers, the aggregate). One push
// can start several: GitHub runs one per workflow, GitLab a branch and a merge-request pipeline.

import type { JobState, Pipeline, PipelineJob, PipelineProvider, PipelineRun } from '../types'
import { parseGiteaJobs, parseGiteaRun } from './gitea'
import { json, parseGhJobs, parseGhRun } from './github'
import type { PipelineHead } from './pipelines'
import { isFinished, parseJobs, parsePipeline } from './pipelines'

/** One pipeline / run of a commit: its head, plus what names it among the others. */
export type Run = PipelineHead & { workflowId?: number; name?: string }

type Forge = Exclude<PipelineProvider, 'command'>

const forge = (p: Pick<Pipeline, 'provider'>): Forge =>
  p.provider === 'github' || p.provider === 'gitea' ? p.provider : 'gitlab'

/** Whether a stored pipeline is a watch by commit (its key names the commit, not a run id). */
export function isCommitWatch(p: Pick<Pipeline, 'key' | 'provider' | 'sha'>): boolean {
  return p.provider !== 'command' && p.sha !== undefined && p.key.includes('@')
}

/** The API path that lists a commit's pipelines / runs, newest first. */
export function runsPath(p: Pick<Pipeline, 'provider' | 'project' | 'sha'>): string {
  const sha = encodeURIComponent(p.sha ?? '')
  switch (forge(p)) {
    case 'github':
      return `repos/${p.project}/actions/runs?head_sha=${sha}&per_page=100`
    case 'gitea':
      return `/repos/${p.project}/actions/runs?head_sha=${sha}&limit=50`
    default:
      return `projects/${encodeURIComponent(p.project)}/pipelines?sha=${sha}&per_page=100`
  }
}

/** The API path that answers whether the project has ever run any pipeline at all (one entry). */
export function anyRunPath(p: Pick<Pipeline, 'provider' | 'project'>): string {
  switch (forge(p)) {
    case 'github':
      return `repos/${p.project}/actions/runs?per_page=1`
    case 'gitea':
      return `/repos/${p.project}/actions/runs?limit=1`
    default:
      return `projects/${encodeURIComponent(p.project)}/pipelines?per_page=1`
  }
}

/** One pipeline / run by id, and its jobs. */
export function runPath(p: Pick<Pipeline, 'provider' | 'project'>, id: number): string {
  switch (forge(p)) {
    case 'github':
      return `repos/${p.project}/actions/runs/${id}`
    case 'gitea':
      return `/repos/${p.project}/actions/runs/${id}`
    default:
      return `projects/${encodeURIComponent(p.project)}/pipelines/${id}`
  }
}

export function jobsPath(p: Pick<Pipeline, 'provider' | 'project'>, id: number): string {
  return forge(p) === 'gitea' ? `${runPath(p, id)}/jobs` : `${runPath(p, id)}/jobs?per_page=100`
}

const named = (raw: unknown, key: string): string | undefined => {
  const v = (raw as Record<string, unknown> | null)?.[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** One run by id (`runPath`'s answer). */
export function parseRun(provider: PipelineProvider | undefined, text: string): Run | undefined {
  const kind = forge({ provider })
  return kind === 'github' ? parseGhRun(text) : kind === 'gitea' ? parseGiteaRun(text) : parsePipeline(text)
}

/**
 * A list answer (`runsPath`'s, `anyRunPath`'s) → every pipeline / run in it, newest first; []
 * when the forge has none, undefined when the answer is not a list at all.
 */
export function parseRuns(provider: PipelineProvider | undefined, text: string): Run[] | undefined {
  const kind = forge({ provider })
  const raw = json(text)
  const list = kind === 'gitlab' ? raw : (raw as Record<string, unknown> | undefined)?.workflow_runs
  if (!Array.isArray(list)) return undefined
  const runs: Run[] = []
  for (const item of list) {
    const one = JSON.stringify(item)
    const head =
      kind === 'github' ? parseGhRun(one) : kind === 'gitea' ? parseGiteaRun(one) : parsePipeline(one)
    if (!head) continue
    // What tells it from the commit's other runs: the workflow's (pipeline's) own name.
    const name = named(item, 'name') ?? named(item, 'display_title') ?? named(item, 'title')
    runs.push({ ...head, ...(name ? { name: name.slice(0, 60) } : {}) })
  }
  return runs
}

export function parseRunJobs(
  provider: PipelineProvider | undefined,
  text: string,
): PipelineJob[] | undefined {
  const kind = forge({ provider })
  return kind === 'github' ? parseGhJobs(text) : kind === 'gitea' ? parseGiteaJobs(text) : parseJobs(text)
}

/**
 * The runs that belong to a watched ref. A commit pushed to a second branch (a fast-forward of
 * `main` to `next`, a tag on it) gets pipelines of its own there, so a watch of one ref leaves out
 * the runs another branch or tag started. A run whose ref is no plain branch or tag name (GitLab's
 * `refs/merge-requests/…`, a pull request's `#12`) or is unknown belongs to every watch of its commit.
 */
export function runsOnRef(runs: readonly Run[], ref: string | undefined): Run[] {
  if (!ref) return [...runs]
  return runs.filter(r => {
    if (!r.ref) return true
    const plain = r.ref.replace(/^refs\/(heads|tags)\//, '')
    if (plain.startsWith('refs/') || plain.startsWith('#')) return true
    return plain === ref
  })
}

/**
 * Several runs read as one state: unfinished while any of them is (running once one runs or some
 * already finished, else queued, else waiting on a manual step); only when ALL are complete the
 * worst outcome — failed, then canceled, then success (skipped when every one was).
 */
export function aggregateState(states: readonly JobState[]): JobState | 'unknown' {
  if (states.length === 0) return 'unknown'
  const open = states.filter(s => !isFinished(s))
  if (open.length > 0) {
    if (open.includes('running')) return 'running'
    if (open.includes('queued')) return open.length < states.length ? 'running' : 'queued'
    return 'manual'
  }
  for (const worst of ['failed', 'canceled', 'success'] as const) if (states.includes(worst)) return worst
  return 'skipped'
}

/**
 * What each run is called among the others: its workflow's name; two of the same name are told
 * apart by their trigger ("CI (push)", "CI (pull_request)"), and what is still the same, or has no
 * name, by its id.
 */
export function runLabels(runs: readonly Run[]): string[] {
  const count = (labels: (string | undefined)[], label: string | undefined) =>
    labels.filter(l => l === label).length
  const names = runs.map(r => r.name)
  const first = runs.map(r =>
    r.name && count(names, r.name) === 1
      ? r.name
      : r.name && r.source
        ? `${r.name} (${r.source})`
        : undefined,
  )
  return runs.map((r, i) => {
    const label = first[i]
    if (label && count(first, label) === 1) return label
    return [r.name ?? r.source, `#${r.id}`].filter(Boolean).join(' ')
  })
}

/** The run a row of several shows as its own (id, link): the one that failed it, else the newest. */
export function leadRun(runs: readonly Run[], state: JobState | 'unknown'): Run | undefined {
  return (
    (state === 'failed' || state === 'canceled' ? runs.find(r => r.state === state) : undefined) ?? runs[0]
  )
}

const earliest = (times: (string | undefined)[]): string | undefined =>
  times.filter((x): x is string => typeof x === 'string').sort((a, b) => Date.parse(a) - Date.parse(b))[0]

/**
 * A commit's runs and their jobs as one pipeline head and one job list. One run reads exactly as a
 * pipeline watched by id; several are one row whose jobs carry their run's label as (part of) the
 * stage, whose clock runs from the first start to the last finish.
 */
export function aggregateRuns(parts: readonly { run: Run; jobs: readonly PipelineJob[] }[]): {
  head: (Run & { state: JobState }) | undefined
  jobs: PipelineJob[]
  runs: PipelineRun[] | undefined
} {
  const runs = parts.map(p => p.run)
  const only = runs.length === 1 ? runs[0] : undefined
  if (only) return { head: only, jobs: [...(parts[0]?.jobs ?? [])], runs: undefined }
  const state = aggregateState(runs.map(r => r.state))
  const lead = leadRun(runs, state)
  if (!lead || state === 'unknown') return { head: undefined, jobs: [], runs: undefined }
  const labels = runLabels(runs)
  const done = runs.every(r => isFinished(r.state))
  const startedAt = earliest(runs.map(r => r.startedAt))
  const finishedAt = done
    ? runs
        .map(r => r.pipelineFinishedAt)
        .filter((x): x is string => typeof x === 'string')
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
    : undefined
  return {
    head: {
      id: lead.id,
      state,
      ...(lead.ref ? { ref: lead.ref } : {}),
      ...(lead.url ? { url: lead.url } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { pipelineFinishedAt: finishedAt } : {}),
    },
    jobs: parts.flatMap((p, i) =>
      p.jobs.map(j => ({ ...j, stage: [labels[i], j.stage].filter(Boolean).join(' · ') })),
    ),
    runs: runs.map((r, i) => ({
      id: r.id,
      state: r.state,
      name: labels[i] as string,
      ...(r.url ? { url: r.url } : {}),
    })),
  }
}
