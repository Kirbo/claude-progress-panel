// The forges, through the person's own CLIs (`glab`, `gh`, `tea`, a custom command): one pipeline's
// refresh, the polls that keep watched pipelines current, and cancelling one.

import type { EngineInterface, PluginOptions } from 'claude-code'
import { markNoPipeline } from './cimemory'
import { commandArgv, parseCommandStatus } from './command'
import type { Run } from './commit'
import {
  aggregateRuns,
  anyRunPath,
  isCommitWatch,
  jobsPath,
  parseRun,
  parseRunJobs,
  parseRuns,
  runPath,
  runsOnRef,
  runsPath,
} from './commit'
import { apiHost } from './forges'
import { teaLoginFor } from './gitea'
import { ghEstimateSamples, parseGhJobs } from './github'
import { t } from './i18n'
import type { SessionFile } from './model'
import { settleLinkedTasks } from './model'
import type { Pipeline, PipelineHead, PipelineJob } from './pipelines'
import {
  bounded,
  cleanText,
  estimateFrom,
  isFinished,
  isFullSha,
  isOrphaned,
  jobEstimatesFrom,
  NO_PIPELINE_HINT_MS,
  NO_PIPELINE_STOP_MS,
  oneLine,
  overlayPipelines,
  parseCommitSha,
  parseJobs,
  parsePipeline,
  parseSampleIds,
  shouldPoll,
  stillWaiting,
  WATCH_MAX_MS,
} from './pipelines'
import { notifiesFinish } from './settings'
import {
  ESTIMATE_TTL_MS,
  ORPHAN_AFTER_MS,
  ORPHAN_LEASE_KEY,
  ORPHAN_LEASE_MS,
  optionString,
  pendingNotes,
  readSessions,
  self,
} from './state'
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
  if (!p.sha || isFullSha(p.sha) || p.provider === 'gitea' || p.provider === 'command') return undefined
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

// One forge API read through the person's own CLI: `glab` (GitLab), `gh` (GitHub) or `tea` (Gitea /
// Forgejo, the login on the pipeline's host).
export async function forgeGet(
  $: EngineInterface,
  p: Pipeline,
  path: string,
): Promise<{ text?: string; error?: string }> {
  const host = apiHost(p)
  if (p.provider !== 'gitea') return cliApi($, p.provider === 'github' ? 'gh' : 'glab', path, host)
  if (!host) return { error: 'tea: the pipeline has no host' }
  return teaApi($, host, path)
}

function unreadable(p: Pipeline): string {
  if (p.provider === 'github') return 'gh: unreadable workflow run'
  return p.provider === 'gitea' ? 'tea: unreadable workflow run' : 'glab: unreadable pipeline'
}

// How long a run like this one took before (GitLab and GitHub; none for a finished run, or one
// whose branch is not known).
export async function estimateOf(
  $: EngineInterface,
  p: Pipeline,
  run: Run,
  at: string,
): Promise<Estimates | undefined> {
  if (!run.ref || isFinished(run.state) || p.provider === 'gitea') return undefined
  if (p.provider !== 'github')
    return estimateFor($, apiHost(p), p.project, run.ref, run.source, run.id, Date.parse(at))
  if (run.workflowId === undefined) return undefined
  return ghEstimateFor($, apiHost(p), p.project, run.workflowId, run.ref, run.source, run.id, Date.parse(at))
}

// One pipeline / run watched by its id: its head and its jobs.
export async function refreshRun($: EngineInterface, p: Pipeline, id: number, at: string): Promise<Pipeline> {
  const head = await forgeGet($, p, runPath(p, id))
  const parsed = head.text === undefined ? undefined : parseRun(p.provider, head.text)
  if (!parsed) return { ...p, checkedAt: at, error: head.error ?? unreadable(p) }
  const estimate = p.estimateS == null ? await estimateOf($, p, parsed, at) : undefined
  const jobsText = await forgeGet($, p, jobsPath(p, parsed.id))
  const jobs: PipelineJob[] =
    (jobsText.text === undefined ? undefined : parseRunJobs(p.provider, jobsText.text)) ?? p.jobs
  return merged(p, parsed, parsed.id, estimate, jobs, jobsText.error, at)
}

const RUN_JOBS_KEPT = 200

// The jobs of one run of a watch by commit. A finished run keeps its jobs: read once more when it
// finishes, then answered from memory for as long as it stays in that state.
export async function runJobs(
  $: EngineInterface,
  p: Pipeline,
  run: Run,
): Promise<{ jobs: PipelineJob[]; error?: string }> {
  const key = `${p.key}#${run.id}`
  const kept = self.runJobs.get(key)
  if (kept && kept.state === run.state && isFinished(run.state)) return { jobs: kept.jobs }
  const answer = await forgeGet($, p, jobsPath(p, run.id))
  const jobs = answer.text === undefined ? undefined : parseRunJobs(p.provider, answer.text)
  if (!jobs) return { jobs: kept?.jobs ?? [], error: answer.error ?? unreadable(p) }
  self.runJobs.delete(key)
  self.runJobs.set(key, { state: run.state, jobs })
  // The oldest entries go first (a Map keeps insertion order).
  for (const old of self.runJobs.keys()) {
    if (self.runJobs.size <= RUN_JOBS_KEPT) break
    self.runJobs.delete(old)
  }
  return { jobs }
}

// A watch by commit: EVERY pipeline / run the forge has for that commit (on the watched ref), read
// as one. A push can start several — one per GitHub workflow, a branch and a merge-request pipeline
// on GitLab — and the newest alone says nothing about the rest: a fast lint run going green is not
// the commit's CI passing. The row is unfinished while any run is, and takes the worst outcome
// only once all are complete.
export async function refreshCommit($: EngineInterface, p: Pipeline, at: string): Promise<Pipeline> {
  const listed = await forgeGet($, p, runsPath(p))
  const all = listed.text === undefined ? undefined : parseRuns(p.provider, listed.text)
  if (!all) return { ...p, checkedAt: at, error: listed.error ?? unreadable(p) }
  const runs = runsOnRef(all, p.watchRef)
  if (runs.length === 0) {
    // None by this commit yet (a fresh push) — or an abbreviated sha, which no forge's filter
    // matches: resolved to the whole id once and asked again; else wait quietly, then say so.
    const full = all.length === 0 ? await fullSha($, p) : undefined
    if (full) return refreshCommit($, { ...p, sha: full }, at)
    return stillWaiting(p, at, noneYet(p))
  }
  let estimate: Estimates | undefined
  if (p.estimateS == null)
    for (const run of runs) {
      const one = await estimateOf($, p, run, at)
      if (!one) continue
      // The runs go side by side: the row takes as long as its longest.
      const s = one.s === null ? (estimate?.s ?? null) : Math.max(one.s, estimate?.s ?? 0)
      estimate = { s, jobs: { ...estimate?.jobs, ...one.jobs } }
    }
  const parts: { run: Run; jobs: PipelineJob[] }[] = []
  let jobsError: string | undefined
  for (const run of runs) {
    const read = await runJobs($, p, run)
    jobsError = jobsError ?? read.error
    parts.push({ run, jobs: read.jobs })
  }
  const { head, jobs, runs: several } = aggregateRuns(parts)
  if (!head) return { ...p, checkedAt: at, error: unreadable(p) }
  // What belongs to ONE run (its own duration, trigger, workflow) is no fact of several.
  const { runs: _r, durationS: _d, source: _s, workflowId: _w, ...shared } = p
  const { runs: _one, ...single } = p
  const fresh = merged(several ? shared : single, head, head.id, estimate, jobs, jobsError, at)
  return several ? { ...fresh, runs: several } : fresh
}

// Whether a project has ever run any pipeline / workflow run at all (one small call): false only
// when the forge answers with an empty list; undefined when it cannot say (a CLI error, a custom
// command's CI).
export async function projectRuns($: EngineInterface, p: Pipeline): Promise<boolean | undefined> {
  if (p.provider === 'command') return undefined
  const answer = await forgeGet($, p, anyRunPath(p))
  const runs = answer.text === undefined ? undefined : parseRuns(p.provider, answer.text)
  return runs === undefined ? undefined : runs.length > 0
}

// Fetches one pipeline's head and jobs: a watch by commit as every run of that commit, one by id as
// that run, a custom command's as its command prints it.
export async function refreshPipeline(
  $: EngineInterface,
  options: PluginOptions,
  p: Pipeline,
  at: string,
): Promise<Pipeline> {
  if (p.provider === 'command') return refreshCommandRun($, options, p, at)
  if (isCommitWatch(p)) return refreshCommit($, p, at)
  if (p.id === null) return { ...p, checkedAt: at, error: unreadable(p) }
  return refreshRun($, p, p.id, at)
}

// One pipeline's check, held to the bounds of a watch (`bounded`): what it says on its row when
// the plugin stops polling it.
export async function checked(
  $: EngineInterface,
  options: PluginOptions,
  p: Pipeline,
  at: string,
): Promise<Pipeline> {
  return bounded(p, await refreshPipeline($, options, p, at), Date.parse(at), {
    errors: (error, fails) => t('pipe.stopped.errors', { fails, error: oneLine(error) }),
    nopipeline: () =>
      t('pipe.stopped.nopipeline', {
        sha: (p.sha ?? '').slice(0, 12),
        minutes: NO_PIPELINE_STOP_MS / 60_000,
      }),
    age: () => t('pipe.stopped.age', { hours: WATCH_MAX_MS / 3_600_000 }),
  })
}

// The session's own pipelines that are due a check (`shouldPoll`), refreshed and saved. `onlyNew`:
// just the ones never checked yet — a round's second look, for a watch added while it ran.
export async function pollPipelines(
  $: EngineInterface,
  options: PluginOptions,
  onlyNew = false,
): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const at = await nowIso($)
  // Unfinished ones, and a failed / canceled one for a while after it ended (a retry restarts it).
  const unfinished = ((await ownFile($, dir)).pipelines ?? []).filter(
    p => shouldPoll(p, Date.parse(at)) && (!onlyNew || p.checkedAt === null),
  )
  if (unfinished.length === 0) return
  // The forge calls take seconds and run outside the lock; only their results are written, onto the
  // file as it is by then (a task, a watch or an unwatch sent meanwhile stays).
  const fresh: Pipeline[] = []
  for (const p of unfinished) fresh.push(await checked($, options, p, at))
  // A watch the plugin just stopped polling: the agent is told once — a task linked to it no
  // longer closes by itself. (The reason can quote a CLI's own words: cleaned like any outside text.)
  for (const p of fresh)
    if (p.stopped && !unfinished.find(u => u.key === p.key)?.stopped)
      pendingNotes.push(t('notice.watchStopped', { key: p.key, why: cleanText(p.error, 300) }))
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
  // A PUSHED commit that got no pipeline (the 10-minute hint, as it first shows): one commit proves
  // nothing — CI on `main` only, a path filter, `[skip ci]` — so the forge is asked, once, whether
  // the project has ever run anything. Only a project without a single pipeline is remembered as
  // running none, so its next pushes are not watched for nothing. Never from a watch the agent
  // sent: a wrong sha there says nothing about the repo.
  const none: Pipeline[] = []
  for (const p of fresh) {
    if (!p.pushed || !p.noPipeline || unfinished.find(u => u.key === p.key)?.noPipeline) continue
    if ((await projectRuns($, p)) === false) none.push(p)
  }
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

// Whether THIS pane is the one that polls orphans now: it holds the lease in the plugin's store
// (taking it when it is free or has run out), so the panes of a machine never each spawn the same
// CLI calls for a session that ended. The store has no compare-and-set: two panes asking in the
// same instant can both take it for one round; the read-back settles who keeps it.
export async function holdsOrphanLease($: EngineInterface, me: string, nowMs: number): Promise<boolean> {
  const read = async () =>
    (await $.store.get(ORPHAN_LEASE_KEY)) as { id?: unknown; untilMs?: unknown } | undefined
  const lease = await read()
  const until = typeof lease?.untilMs === 'number' ? lease.untilMs : 0
  // Another pane's lease holds while it has time left (and never longer than a lease can be).
  if (lease && lease.id !== me && nowMs < until && until - nowMs <= ORPHAN_LEASE_MS) return false
  await $.store.set(ORPHAN_LEASE_KEY, { id: me, untilMs: nowMs + ORPHAN_LEASE_MS })
  return (await read())?.id === me
}

// Other sessions' unfinished pipelines they stopped polling (ended, or killed without ending):
// refreshed by ONE pane (`holdsOrphanLease`) under the same bounds as a session's own, the copies
// written to that session's sidecar — never to its own file.
export async function pollOrphans($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const me = await $.session.id()
  const nowMs = await $.clock.now()
  const due: { id: string; watched: Pipeline[]; orphans: Pipeline[] }[] = []
  for (const [id, known] of Object.entries(await readSessions($))) {
    if (id === me) continue
    const watched = known.file.pipelines ?? []
    const list = overlayPipelines(watched, known.sidecar?.pipelines ?? [])
    const orphans = list.filter(p => isOrphaned(p, nowMs, ORPHAN_AFTER_MS) && shouldPoll(p, nowMs))
    if (orphans.length > 0) due.push({ id, watched, orphans })
  }
  if (due.length === 0 || !(await holdsOrphanLease($, me, nowMs))) return
  for (const { id, watched, orphans } of due) {
    const at = new Date(nowMs).toISOString()
    const fresh: Pipeline[] = []
    for (const p of orphans) fresh.push(await checked($, options, p, at))
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

// One round: this session's own pipelines (and once more whatever was added while it ran), then
// the orphans.
export async function pollRound($: EngineInterface, options: PluginOptions): Promise<void> {
  await pollPipelines($, options)
  while (self.pollWanted) {
    self.pollWanted = false
    await pollPipelines($, options, true)
  }
  await pollOrphans($, options)
}

// The one polling path: a round at a time. A call that finds a round still running does nothing
// (single-flight: a slow forge never stacks rounds) — unless a watch was just added (`pollSoon`):
// then the running round looks once more, at what is new, before it ends.
export async function pollAll($: EngineInterface, options: PluginOptions): Promise<void> {
  if (self.polling) return
  self.polling = true
  try {
    await pollRound($, options)
  } finally {
    self.polling = false
  }
}

// A watch was just added: its first check starts now, on the one polling path and detached — the
// tool's answer (or the push's result) never waits for a forge, and no second round runs beside
// the timer's.
export function pollSoon($: EngineInterface, options: PluginOptions): void {
  self.pollWanted = self.polling
  pollAll($, options).catch(() => undefined)
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
  // A row of several runs stops each one that is still going.
  const ids = p.runs ? p.runs.filter(r => !isFinished(r.state)).map(r => r.id) : [p.id as number]
  let cancelError: string | undefined
  let error: string | undefined
  for (const id of ids) {
    const base = runPath(p, id)
    const cancelled = await forgeCall($, p, 'POST', `${base}/cancel`)
    if (cancelled.error) {
      cancelError = cancelled.error
      error = t('pipe.cancelFailed', { error: oneLine(cancelled.error) })
      break
    }
    if (self.settings.runningPipelineX !== 'delete') continue
    const deleted = await forgeCall($, p, 'DELETE', base)
    if (deleted.error) {
      error = /\b403\b|forbidden/i.test(deleted.error)
        ? t('pipe.deleteRefused', { error: oneLine(deleted.error) })
        : t('pipe.deleteFailed', { error: oneLine(deleted.error) })
      break
    }
  }
  const at = await nowIso($)
  const dir = await progressDir($, options)
  if (!dir) return
  if (error) {
    const marked = {
      ...p,
      checkedAt: at,
      error,
      ...(cancelError ? {} : { state: 'canceled' as const, finishedAt: at }),
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
