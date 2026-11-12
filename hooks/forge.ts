// The forges, through the person's own CLIs (`glab`, `gh`, `tea`, a custom command): one pipeline's
// refresh, the polls that keep watched pipelines current, and cancelling one.

import type { EngineInterface, PluginOptions } from 'claude-code'
import { markNoPipeline } from './cimemory'
import { commandArgv, parseCommandStatus } from './command'
import { apiHost } from './forges'
import { parseGiteaJobs, parseGiteaRun, teaLoginFor } from './gitea'
import { ghEstimateSamples, parseGhJobs, parseGhRun } from './github'
import { t } from './i18n'
import type { SessionFile } from './model'
import { settleLinkedTasks } from './model'
import type { Pipeline, PipelineHead, PipelineJob } from './pipelines'
import {
  estimateFrom,
  isFinished,
  isFullSha,
  isOrphaned,
  jobEstimatesFrom,
  NO_PIPELINE_HINT_MS,
  oneLine,
  overlayPipelines,
  parseCommitSha,
  parseJobs,
  parsePipeline,
  parseSampleIds,
  shouldPoll,
  stillWaiting,
} from './pipelines'
import { notifiesFinish } from './settings'
import { ESTIMATE_TTL_MS, ORPHAN_AFTER_MS, optionString, pendingNotes, readSessions, self } from './state'
import { exclusive, nowIso, ownFile, progressDir, save, updateCiMemory, writeSidecar } from './store'

export const TEA_LOGINS_TTL_MS = 60_000

export async function teaApi(
  $: EngineInterface,
  host: string,
  path: string,
): Promise<{ text?: string; error?: string }> {
  const nowMs = await $.clock.now()
  if (!self.teaLogins || nowMs - self.teaLogins.atMs > TEA_LOGINS_TTL_MS) {
    const listed = await runCli($, ['tea', 'login', 'list', '--output', 'json'])
    if (listed.text === undefined) return listed
    self.teaLogins = { atMs: nowMs, text: listed.text }
  }
  const login = teaLoginFor(self.teaLogins.text, host)
  if (!login) return { error: `tea: no login for ${host} (tea login add)` }
  return runCli($, ['tea', 'api', '--login', login, path])
}

// One Gitea / Forgejo Actions run's head and jobs (found by commit first, when only the sha is known).
export async function refreshGiteaRun($: EngineInterface, p: Pipeline, at: string): Promise<Pipeline> {
  const host = apiHost(p)
  if (!host) return { ...p, checkedAt: at, error: 'tea: the pipeline has no host' }
  const runs = `/repos/${p.project}/actions/runs`
  const head =
    p.id === null
      ? await teaApi($, host, `${runs}?head_sha=${encodeURIComponent(p.sha ?? '')}&limit=1`)
      : await teaApi($, host, `${runs}/${p.id}`)
  const parsed = head.text === undefined ? undefined : parseGiteaRun(head.text)
  if (!parsed && p.id === null && !head.error) return { ...p, checkedAt: at }
  if (!parsed) return { ...p, checkedAt: at, error: head.error ?? 'tea: unreadable workflow run' }
  const jobsText = await teaApi($, host, `${runs}/${parsed.id}/jobs`)
  const jobs: PipelineJob[] =
    (jobsText.text === undefined ? undefined : parseGiteaJobs(jobsText.text)) ?? p.jobs
  return merged(p, parsed, parsed.id, undefined, jobs, jobsText.error, at)
}

// A pipeline of a CI the plugin has no adapter for: the person's own command (the `ciCommand`
// setting — never the tool's input) prints its status as JSON.
export async function refreshCommandRun(
  $: EngineInterface,
  options: PluginOptions,
  p: Pipeline,
  at: string,
): Promise<Pipeline> {
  const template = optionString(options, 'ciCommand')
  if (!template.trim()) return { ...p, checkedAt: at, error: t('pipe.noCommand') }
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const argv = commandArgv(template, { project: p.project, id: p.id, sha: p.sha, host: p.host, home })
  const ran = await runCli($, argv)
  const parsed = ran.text === undefined ? undefined : parseCommandStatus(ran.text)
  if (parsed === null) return { ...p, checkedAt: at }
  if (!parsed) return { ...p, checkedAt: at, error: ran.error ?? `${argv[0]}: not the documented JSON` }
  return merged(
    p,
    parsed.head,
    parsed.head.id,
    undefined,
    parsed.jobs.length ? parsed.jobs : p.jobs,
    undefined,
    at,
  )
}

// One CLI call: its output, or its error as one short line — from stderr only: stdout is the API's
// answer (a whole jobs list once stood in for the error), never a message.
export async function runCli($: EngineInterface, argv: string[]): Promise<{ text?: string; error?: string }> {
  const ran = await $.process.run(argv).catch((err: unknown) => ({
    exitCode: 127,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
  }))
  if (ran.exitCode === 0) return { text: ran.stdout }
  return { error: oneLine(ran.stderr) || `${argv[0]} exited ${ran.exitCode}` }
}

// One `<cli> api [--hostname <host>] <path>` (`glab` for GitLab, `gh` for GitHub): the JSON text,
// or the CLI's error as one line. The host is always named when known, so the answer never depends
// on the repo the command happens to run in.
export async function cliApi(
  $: EngineInterface,
  cli: 'glab' | 'gh',
  path: string,
  host: string | undefined,
): Promise<{ text?: string; error?: string }> {
  return runCli($, host ? [cli, 'api', '--hostname', host, path] : [cli, 'api', path])
}

export function glabApi($: EngineInterface, path: string, host: string | undefined) {
  return cliApi($, 'glab', path, host)
}

export function ghApi($: EngineInterface, path: string, host: string | undefined) {
  return cliApi($, 'gh', path, host)
}

export type CachedEstimate = { atMs: number; s: number | null; jobs?: Record<string, number> }

export type Estimates = { s: number | null; jobs: Record<string, number> }

// The average duration of earlier successful runs of the same project, ref and source, and per job
// name: from the store when fetched within ESTIMATE_TTL_MS, else one `glab api` list call plus one
// jobs call per sample run (at most 5), cached afterwards.
export async function estimateFor(
  $: EngineInterface,
  host: string | undefined,
  project: string,
  ref: string,
  source: string | undefined,
  exceptId: number,
  nowMs: number,
): Promise<Estimates> {
  // `estimate2:` — 0.8.0 read durations from the list (GitLab has none there) and cached nulls.
  const key = `estimate2:${host && host !== 'gitlab.com' ? `${host}/` : ''}${project}@${ref}:${source ?? '*'}`
  const cached = (await $.store.get(key)) as CachedEstimate | undefined
  if (cached && typeof cached.atMs === 'number' && nowMs - cached.atMs < ESTIMATE_TTL_MS)
    return { s: cached.s ?? null, jobs: cached.jobs ?? {} }
  const list = await glabApi(
    $,
    `projects/${encodeURIComponent(project)}/pipelines?ref=${encodeURIComponent(ref)}&status=success${
      source ? `&source=${encodeURIComponent(source)}` : ''
    }&per_page=6`,
    host,
  )
  if (list.text === undefined) return { s: null, jobs: {} }
  const durations: number[] = []
  const runs: PipelineJob[][] = []
  for (const id of parseSampleIds(list.text, exceptId)) {
    const head = await glabApi($, `projects/${encodeURIComponent(project)}/pipelines/${id}`, host)
    const d = head.text === undefined ? undefined : parsePipeline(head.text)?.durationS
    if (typeof d === 'number' && d > 0) durations.push(d)
    const jobs = await glabApi(
      $,
      `projects/${encodeURIComponent(project)}/pipelines/${id}/jobs?per_page=100`,
      host,
    )
    const parsed = jobs.text === undefined ? undefined : parseJobs(jobs.text)
    if (parsed) runs.push(parsed)
  }
  const s = estimateFrom(durations)
  const jobEstimates = jobEstimatesFrom(runs)
  await $.store.set(key, { atMs: nowMs, s, jobs: jobEstimates } satisfies CachedEstimate)
  return { s, jobs: jobEstimates }
}

// GitHub: the average duration of up to 5 earlier successful runs of the same workflow, branch
// and event (read from the runs list itself — GitHub lists updated_at and run_started_at), and per
// job name from those runs' jobs; cached like GitLab's.
export async function ghEstimateFor(
  $: EngineInterface,
  host: string | undefined,
  project: string,
  workflowId: number,
  ref: string,
  event: string | undefined,
  exceptId: number,
  nowMs: number,
): Promise<Estimates> {
  const key = `estimate-gh:${host && host !== 'github.com' ? `${host}/` : ''}${project}@${workflowId}:${ref}:${event ?? '*'}`
  const cached = (await $.store.get(key)) as CachedEstimate | undefined
  if (cached && typeof cached.atMs === 'number' && nowMs - cached.atMs < ESTIMATE_TTL_MS)
    return { s: cached.s ?? null, jobs: cached.jobs ?? {} }
  const list = await ghApi(
    $,
    `repos/${project}/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(ref)}${
      event ? `&event=${encodeURIComponent(event)}` : ''
    }&status=success&per_page=6`,
    host,
  )
  if (list.text === undefined) return { s: null, jobs: {} }
  const samples = ghEstimateSamples(list.text, exceptId)
  const runs: PipelineJob[][] = []
  for (const { id } of samples) {
    const jobs = await ghApi($, `repos/${project}/actions/runs/${id}/jobs?per_page=100`, host)
    const parsed = jobs.text === undefined ? undefined : parseGhJobs(jobs.text)
    if (parsed) runs.push(parsed)
  }
  const s = estimateFrom(samples.map(x => x.durationS))
  const jobEstimates = jobEstimatesFrom(runs)
  await $.store.set(key, { atMs: nowMs, s, jobs: jobEstimates } satisfies CachedEstimate)
  return { s, jobs: jobEstimates }
}

// One GitHub Actions run's head and jobs (finding the newest run of the commit first, when only the
// sha is known) — the same Pipeline shape as GitLab's.
export async function refreshGithubRun($: EngineInterface, p: Pipeline, at: string): Promise<Pipeline> {
  const head =
    p.id === null
      ? await ghApi(
          $,
          `repos/${p.project}/actions/runs?head_sha=${encodeURIComponent(p.sha ?? '')}&per_page=1`,
          apiHost(p),
        )
      : await ghApi($, `repos/${p.project}/actions/runs/${p.id}`, apiHost(p))
  const parsed = head.text === undefined ? undefined : parseGhRun(head.text)
  // As GitLab's (refreshPipeline): an abbreviated sha resolved once, else wait, then say so.
  if (!parsed && p.id === null && !head.error) {
    const full = await fullSha($, p)
    if (full) return refreshGithubRun($, { ...p, sha: full }, at)
    return stillWaiting(p, at, noneYet(p))
  }
  if (!parsed) return { ...p, checkedAt: at, error: head.error ?? 'gh: unreadable workflow run' }
  const id = parsed.id
  const estimate =
    p.estimateS == null && parsed.ref && parsed.workflowId !== undefined && !isFinished(parsed.state)
      ? await ghEstimateFor(
          $,
          apiHost(p),
          p.project,
          parsed.workflowId,
          parsed.ref,
          parsed.source,
          id,
          Date.parse(at),
        )
      : undefined
  const jobsText = await ghApi($, `repos/${p.project}/actions/runs/${id}/jobs?per_page=100`, apiHost(p))
  const jobs: PipelineJob[] = (jobsText.text === undefined ? undefined : parseGhJobs(jobsText.text)) ?? p.jobs
  return merged(p, parsed, id, estimate, jobs, jobsText.error, at)
}

// The refreshed pipeline: the head's fields over the stored ones (an old error cleared).
export function merged(
  p: Pipeline,
  parsed: PipelineHead & { workflowId?: number },
  id: number,
  estimate: Estimates | undefined,
  jobs: PipelineJob[],
  jobsError: string | undefined,
  at: string,
): Pipeline {
  const { error: _cleared, noPipeline: _found, ...kept } = p
  // Back to running (a retry of a failed or canceled pipeline): its old finish times go, so it reads
  // as live again and its fold resets with the new run.
  const { finishedAt: _f, pipelineFinishedAt: _g, ...live } = kept
  const rest = isFinished(parsed.state) ? kept : live
  return {
    ...rest,
    id,
    state: parsed.state,
    ...(parsed.ref ? { ref: parsed.ref } : {}),
    ...(parsed.url ? { url: parsed.url } : {}),
    ...(parsed.startedAt ? { startedAt: parsed.startedAt } : {}),
    ...(parsed.pipelineFinishedAt ? { pipelineFinishedAt: parsed.pipelineFinishedAt } : {}),
    ...(parsed.durationS !== undefined ? { durationS: parsed.durationS } : {}),
    ...(parsed.source ? { source: parsed.source } : {}),
    ...(parsed.workflowId !== undefined ? { workflowId: parsed.workflowId } : {}),
    ...(estimate !== undefined ? { estimateS: estimate.s, jobEstimates: estimate.jobs } : {}),
    jobs,
    checkedAt: at,
    ...(isFinished(parsed.state) && !p.finishedAt ? { finishedAt: at } : {}),
    ...(jobsError ? { error: jobsError } : {}),
  }
}

// The whole commit id behind a watch's abbreviated sha (GitLab / GitHub commit API), or undefined:
// already whole, not found, or the forge could not say — the watch then simply keeps waiting.
export async function fullSha($: EngineInterface, p: Pipeline): Promise<string | undefined> {
  if (!p.sha || isFullSha(p.sha)) return undefined
  const sha = encodeURIComponent(p.sha)
  const answer =
    p.provider === 'github'
      ? await ghApi($, `repos/${p.project}/commits/${sha}`, apiHost(p))
      : await glabApi($, `projects/${encodeURIComponent(p.project)}/repository/commits/${sha}`, apiHost(p))
  const full = answer.text === undefined ? undefined : parseCommitSha(answer.text)
  return full && full !== p.sha ? full : undefined
}

export function noneYet(p: Pipeline): string {
  return t('pipe.noneYet', { sha: (p.sha ?? '').slice(0, 12), minutes: NO_PIPELINE_HINT_MS / 60_000 })
}

// Fetches one pipeline's head and jobs (finding it by commit first, when only the sha is known).
export async function refreshPipeline(
  $: EngineInterface,
  options: PluginOptions,
  p: Pipeline,
  at: string,
): Promise<Pipeline> {
  if (p.provider === 'command') return refreshCommandRun($, options, p, at)
  if (p.provider === 'github') return refreshGithubRun($, p, at)
  if (p.provider === 'gitea') return refreshGiteaRun($, p, at)
  const project = encodeURIComponent(p.project)
  // By commit, GitLab's list answer already carries the newest pipeline's status: no second call.
  const head =
    p.id === null
      ? await glabApi(
          $,
          `projects/${project}/pipelines?sha=${encodeURIComponent(p.sha ?? '')}&per_page=1`,
          apiHost(p),
        )
      : await glabApi($, `projects/${project}/pipelines/${p.id}`, apiHost(p))
  const parsed = head.text === undefined ? undefined : parsePipeline(head.text)
  // None by this commit yet (a fresh push) — or an abbreviated sha, which GitLab's filter never
  // matches: resolved to the whole id once and asked again; else wait quietly, then say so.
  if (!parsed && p.id === null && !head.error) {
    const full = await fullSha($, p)
    if (full) return refreshPipeline($, options, { ...p, sha: full }, at)
    return stillWaiting(p, at, noneYet(p))
  }
  if (!parsed) return { ...p, checkedAt: at, error: head.error ?? 'glab: unreadable pipeline' }
  const id = parsed.id
  const estimate =
    p.estimateS == null && parsed.ref && !isFinished(parsed.state)
      ? await estimateFor($, apiHost(p), p.project, parsed.ref, parsed.source, id, Date.parse(at))
      : undefined
  const jobsText = await glabApi($, `projects/${project}/pipelines/${id}/jobs?per_page=100`, apiHost(p))
  const jobs: PipelineJob[] = (jobsText.text === undefined ? undefined : parseJobs(jobsText.text)) ?? p.jobs
  return merged(p, parsed, id, estimate, jobs, jobsText.error, at)
}

// The session's own unfinished pipelines, refreshed and saved (only when something moved).
export async function pollPipelines($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const at = await nowIso($)
  // Unfinished ones, and a failed / canceled one for a while after it ended (a retry restarts it).
  const unfinished = ((await ownFile($, dir)).pipelines ?? []).filter(p => shouldPoll(p, Date.parse(at)))
  if (unfinished.length === 0) return
  // The forge calls take seconds and run outside the lock; only their results are written, onto the
  // file as it is by then (a task, a watch or an unwatch sent meanwhile stays).
  const fresh: Pipeline[] = []
  for (const p of unfinished) fresh.push(await refreshPipeline($, options, p, at))
  // A pipeline that finished in this round: a toast (and the person's own notification) by setting.
  for (const p of fresh) {
    const before = unfinished.find(u => u.key === p.key)
    if (
      !before ||
      isFinished(before.state) ||
      !isFinished(p.state) ||
      !notifiesFinish(self.settings.pipelineNotify, p.state)
    )
      continue
    const text = t('toast.pipelineFinished', { label: p.label ?? p.key, state: p.state })
    await $.ui.toast(text)
    if (self.settings.bell) await $.ui.notify(text, { title: t('pane.title') }).catch(() => undefined)
  }
  // A watched commit that never got a pipeline (the 10-minute hint): its repo runs no CI on that
  // forge — remembered, so its next pushes are not watched for nothing.
  const none = fresh.filter(p => p.id === null && p.noPipeline)
  if (none.length > 0)
    await updateCiMemory($, dir, m =>
      none.reduce((acc, p) => markNoPipeline(acc, apiHost(p), p.project, Date.parse(at)), m),
    )
  await exclusive(async () => {
    const file = await ownFile($, dir)
    const pipelines = (file.pipelines ?? []).map(p => fresh.find(f => f.key === p.key) ?? p)
    await save($, dir, settleTasks({ ...file, pipelines }, at))
  })
}

// Tasks waiting on a pipeline that finished close by themselves; the main loop is told once.
export function settleTasks(file: SessionFile, at: string): SessionFile {
  const { file: next, settled } = settleLinkedTasks(file, at, {
    green: id => t('task.pipelineGreen', { id }),
    red: (id, jobs, more) =>
      more > 0 ? t('task.pipelineRedMore', { id, jobs, more }) : t('task.pipelineRed', { id, jobs }),
    canceled: id => t('task.pipelineCanceled', { id }),
  })
  for (const s of settled)
    pendingNotes.push(
      t(s.outcome === 'done' ? 'notice.taskPipelineDone' : 'notice.taskPipelineFailed', {
        task: s.task.title,
        note: s.task.note ?? '',
      }),
    )
  return next
}

// Other sessions' unfinished pipelines they stopped polling (ended, or killed without ending):
// refreshed here, the copies written to that session's sidecar — never to its own file.
export async function pollOrphans($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const me = await $.session.id()
  const nowMs = await $.clock.now()
  for (const [id, known] of Object.entries(await readSessions($))) {
    if (id === me) continue
    const watched = known.file.pipelines ?? []
    const list = overlayPipelines(watched, known.sidecar?.pipelines ?? [])
    const orphans = list.filter(p => isOrphaned(p, nowMs, ORPHAN_AFTER_MS))
    if (orphans.length === 0) continue
    const at = new Date(nowMs).toISOString()
    const fresh: Pipeline[] = []
    for (const p of orphans) fresh.push(await refreshPipeline($, options, p, at))
    await writeSidecar($, dir, id, sidecar => ({
      ...sidecar,
      // The fresh copies replace older ones; copies of pipelines the session no longer watches go.
      pipelines: [
        ...sidecar.pipelines.filter(
          p => watched.some(w => w.key === p.key) && !fresh.some(f => f.key === p.key),
        ),
        ...fresh,
      ],
    }))
  }
}

export async function pollAll($: EngineInterface, options: PluginOptions): Promise<void> {
  if (self.polling) return
  self.polling = true
  try {
    await pollPipelines($, options)
    await pollOrphans($, options)
  } finally {
    self.polling = false
  }
}

// What a running pipeline's ✕ can do on its forge, through the person's own CLI: GitLab and GitHub
// cancel (and delete); Gitea / Forgejo and a custom command have no verbs for it here, so no ✕.
export function cancellable(p: Pipeline): boolean {
  return p.id !== null && (p.provider === undefined || p.provider === 'gitlab' || p.provider === 'github')
}

// One forge API call with a method, through glab / gh (their `-X`).
export async function forgeCall(
  $: EngineInterface,
  p: Pipeline,
  method: 'POST' | 'DELETE',
  path: string,
): Promise<{ text?: string; error?: string }> {
  const cli = p.provider === 'github' ? 'gh' : 'glab'
  const host = apiHost(p)
  return runCli($, [cli, 'api', '-X', method, ...(host ? ['--hostname', host] : []), path])
}

// ✕ on a running pipeline, second press: cancel it, then (by setting) delete it from the CI. Success
// removes its row (dismissed as finished); a refused delete keeps it cancelled and says why; a
// failed cancel shows its error on the row.
export async function cancelPipeline(
  $: EngineInterface,
  options: PluginOptions,
  sessionId: string,
  p: Pipeline,
): Promise<void> {
  const github = p.provider === 'github'
  const base = github
    ? `repos/${p.project}/actions/runs/${p.id}`
    : `projects/${encodeURIComponent(p.project)}/pipelines/${p.id}`
  const cancelled = await forgeCall($, p, 'POST', `${base}/cancel`)
  const at = await nowIso($)
  let error = cancelled.error ? t('pipe.cancelFailed', { error: oneLine(cancelled.error) }) : undefined
  if (!error && self.settings.runningPipelineX === 'delete') {
    const deleted = await forgeCall($, p, 'DELETE', base)
    if (deleted.error)
      error = /\b403\b|forbidden/i.test(deleted.error)
        ? t('pipe.deleteRefused', { error: oneLine(deleted.error) })
        : t('pipe.deleteFailed', { error: oneLine(deleted.error) })
  }
  const dir = await progressDir($, options)
  if (!dir) return
  if (error) {
    const marked = {
      ...p,
      checkedAt: at,
      error,
      ...(cancelled.error ? {} : { state: 'canceled' as const, finishedAt: at }),
    }
    if (sessionId === (await $.session.id()))
      await exclusive(async () => {
        const own = await ownFile($, dir)
        await save($, dir, {
          ...own,
          pipelines: (own.pipelines ?? []).map(x => (x.key === p.key ? marked : x)),
        })
      })
    else
      await writeSidecar($, dir, sessionId, s => ({
        ...s,
        pipelines: [...s.pipelines.filter(x => x.key !== p.key), marked],
      }))
    return
  }
  // Gone from the CI (or cancelled): gone from the pane — this session's own row is unwatched,
  // another session's dismissed through its sidecar.
  if (sessionId === (await $.session.id()))
    await exclusive(async () => {
      const own = await ownFile($, dir)
      await save($, dir, { ...own, pipelines: (own.pipelines ?? []).filter(x => x.key !== p.key) })
    })
  else
    await writeSidecar($, dir, sessionId, s => ({
      ...s,
      pipelines: [
        ...s.pipelines.filter(x => x.key !== p.key),
        { ...p, state: 'canceled', finishedAt: at, checkedAt: at },
      ],
      entries: [...s.entries, { id: `pipeline:${p.key}`, doneAt: at }],
    }))
}
