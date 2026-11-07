import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Folds, Loaded, SortChoice } from '../types'
import { t } from './i18n'
import type { Dismissal, SessionFile, SidecarFile, SortBy, Task, UpdateInput } from './model'
import {
  addDismissals,
  applyUpdate,
  formatClock,
  formatTime,
  isClosed,
  mergeSidecar,
  newSession,
  parseSessionFile,
  parseSidecar,
  pruneDone,
  SORTS,
  sortTasks,
  visibleTasks,
} from './model'
import { baseName, resolveProgressDir } from './paths'
import type { JobState, Pipeline, PipelineJob, WatchInput } from './pipelines'
import {
  applyWatch,
  estimateFrom,
  formatDuration,
  formatEstimate,
  isFinished,
  jobCounts,
  parseDurations,
  parseJobs,
  parsePipeline,
  pipelineDuration,
  progressBar,
  stageGroups,
  visiblePipelines,
} from './pipelines'

const PANE = 'progress'
const TOOL = 'progress_update'
const TOOL_ID = `mcp__progress-panel__${TOOL}`
// No file-watch API exists for plugins, so other sessions' files are noticed by listing the
// folder on this timer (a file is read only when its mtime moved). Own writes redraw at once.
const REFRESH_MS = 2000
// A check older than this many refresh periods is shown as stale (the timer or the folder failed).
const STALE_AFTER_MS = 5 * REFRESH_MS
const DAY_MS = 24 * 3_600_000
// GitLab cannot push pipeline status to a local plugin (webhooks need a reachable server; its live
// updates need a browser websocket session), so the session that watches a pipeline polls it
// through the user's own `glab` — only while it is unfinished, and only that session.
const PIPELINE_POLL_MS = 15_000
// A pipeline that succeeded longer ago than this moves into the folded "Finished" list.
const ARCHIVE_AFTER_MS = 3_600_000
// Similar-run estimates are cached in the plugin's store this long, per project + ref + source.
const ESTIMATE_TTL_MS = 24 * 3_600_000
const FINISHED_KEY = 'pipelines-finished'
const SORT_KEY = 'sortTasksBy'

const sessions = atom({ plugin: 'progress-panel', key: 'sessions' } as const, {} as Loaded, {
  shape: 'sessions-2',
})
const SIDECAR = '.dismissed.json'
const folds = atom({ plugin: 'progress-panel', key: 'folds' } as const, {} as Folds, { shape: 'folds-1' })
// When the last successful folder listing finished, so the header can show the pane is live.
const checked = atom({ plugin: 'progress-panel', key: 'checked' } as const, 0, { shape: 'checked-1' })
// The order the pane draws in, mirrored from $.store (kept per user across sessions) so a change redraws.
const sorting = atom({ plugin: 'progress-panel', key: 'sort' } as const, '' as SortChoice, {
  shape: 'sort-1',
})

// Needs-you items already announced, so a toast fires once per new item (module-local: a reload
// starts quiet again, seeded on its first scan).
let seenNeeds: Set<string> | undefined

const JOB_MARK: Record<JobState | 'unknown', { sign: string; color?: string }> = {
  success: { sign: '✓', color: 'green' },
  failed: { sign: '✗', color: 'red' },
  running: { sign: '●', color: 'yellow' },
  queued: { sign: '○' },
  skipped: { sign: '–' },
  canceled: { sign: '×' },
  manual: { sign: '»' },
  unknown: { sign: '?' },
}
// One indent step (columns) per level: section → item → details → jobs. Rows with an action (✕,
// Clear all) are full-width, the label left and the action on the pane's right edge.
const INDENT = 2
const COUNT_ORDER: JobState[] = ['running', 'queued', 'skipped', 'success', 'failed', 'canceled', 'manual']
const COUNT_COLOR: Partial<Record<JobState, string>> = { running: 'yellow', success: 'green', failed: 'red' }
// Always shown, even at 0 (the rest only when present): the line reads the same way every time.
const ALWAYS_COUNTED = new Set<JobState>(['running', 'queued', 'skipped', 'success', 'failed'])

const MARK: Record<string, { sign: string; color?: string }> = {
  blocked: { sign: '✗', color: 'red' },
  doing: { sign: '●', color: 'yellow' },
  todo: { sign: '○' },
  done: { sign: '✓', color: 'green' },
  skipped: { sign: '–' },
}

const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    now: { type: 'string', description: 'One line: what you are doing now and what comes next.' },
    needsYou: {
      type: 'array',
      items: { type: 'string' },
      description: 'Everything only the user can do or decide right now; [] clears it.',
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done', 'skipped'] },
          note: { type: 'string' },
        },
      },
    },
    remove: { type: 'array', items: { type: 'string' } },
    watch: {
      type: 'array',
      description: 'GitLab CI pipelines to follow live in the pane.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['project'],
        properties: {
          project: { type: 'string', description: 'group/name (full path)' },
          pipeline: { type: 'integer', description: 'pipeline id' },
          sha: { type: 'string', description: 'commit sha, when the id is not known yet' },
          label: { type: 'string', description: 'short name shown in the pane' },
        },
      },
    },
    unwatch: { type: 'array', items: { type: 'string' }, description: 'pipeline keys to stop showing' },
  },
}

function optionNumber(options: PluginOptions, name: string, fallback: number): number {
  const raw = options[name]
  if (raw === undefined || raw === '') return fallback
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function optionString(options: PluginOptions, name: string): string {
  const raw = options[name]
  return typeof raw === 'string' ? raw : ''
}

async function progressDir($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  return resolveProgressDir(optionString(options, 'progressDir'), { home, configDir })
}

async function nowIso($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

// Writes a session file whole and records what was written, so the pane redraws at once. Only a
// session writes its own live file (an ended one, whose session is gone, is pruned by any pane).
async function save($: EngineInterface, dir: string, file: SessionFile): Promise<void> {
  const path = `${dir}/${file.session.id}.json`
  await $.fs.write(path, `${JSON.stringify(file, null, 2)}\n`)
  const stat = await $.fs.stat(path).catch(() => undefined)
  await update($, sessions, all => ({
    ...all,
    [file.session.id]: { ...all[file.session.id], mtimeMs: stat?.mtimeMs ?? 0, file },
  }))
}

async function readSidecar($: EngineInterface, dir: string, id: string): Promise<Dismissal[]> {
  const text = await $.fs.read(`${dir}/${id}${SIDECAR}`).catch(() => undefined)
  return (text === undefined ? undefined : parseSidecar(text))?.entries ?? []
}

// This session's file as it is on disk now, with the panes' dismissals folded in; a fresh one when
// there is none (first write, or after /clear).
async function ownFile($: EngineInterface, dir: string): Promise<SessionFile> {
  const id = await $.session.id()
  const text = await $.fs.read(`${dir}/${id}.json`).catch(() => undefined)
  const existing = text === undefined ? undefined : parseSessionFile(text)
  if (existing) {
    const entries = await readSidecar($, dir, id)
    const merged = mergeSidecar(existing, entries)
    return { ...merged, pipelines: visiblePipelines(merged.pipelines ?? [], entries) }
  }
  const cwd = await $.session.cwd()
  const repo = await $.session.repo().catch(() => null)
  return newSession({ id, project: baseName(repo?.root ?? cwd), cwd }, await nowIso($))
}

// A press (✕ / Clear all) on any session's rows: the completions go to that session's sidecar, never
// to its own file, so a pane can't race the session writing its status. Read fresh, union, write.
async function dismiss(
  $: EngineInterface,
  options: PluginOptions,
  id: string,
  tasks: readonly Dismissal[],
): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir || tasks.length === 0) return
  const sidecar: SidecarFile = {
    version: 1,
    sessionId: id,
    entries: addDismissals(await readSidecar($, dir, id), tasks),
  }
  const path = `${dir}/${id}${SIDECAR}`
  await $.fs.write(path, `${JSON.stringify(sidecar, null, 2)}\n`)
  const stat = await $.fs.stat(path).catch(() => undefined)
  await update($, sessions, all => {
    const known = all[id]
    if (!known) return all
    return { ...all, [id]: { ...known, sidecar: { mtimeMs: stat?.mtimeMs ?? 0, entries: sidecar.entries } } }
  })
}

// The plugin API has no file delete: the platform's own command removes the file.
async function deleteFile($: EngineInterface, path: string): Promise<void> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows ? ['cmd', '/c', 'del', '/q', path.replace(/\//g, '\\')] : ['rm', '-f', path]
  await $.process.run(argv).catch(() => undefined)
}

async function forgetSession($: EngineInterface, options: PluginOptions, id: string): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  await deleteFile($, `${dir}/${id}.json`)
  await deleteFile($, `${dir}/${id}${SIDECAR}`)
  await update($, sessions, all => {
    const { [id]: _gone, ...rest } = all
    return rest
  })
}

function liveNeeds(all: Loaded): { project: string; item: string; key: string }[] {
  return Object.values(all)
    .filter(s => s.file.session.endedAt === null)
    .sort((a, b) => Date.parse(b.file.updatedAt) - Date.parse(a.file.updatedAt))
    .flatMap(s =>
      s.file.needsYou.map(item => ({
        project: s.file.session.project,
        item,
        key: `${s.file.session.id}\u0000${item}`,
      })),
    )
}

// The status line, and a toast for each ask another session raised since the last look.
async function announce($: EngineInterface, all: Loaded, me: string): Promise<void> {
  const needs = liveNeeds(all)
  await $.ui.status(needs.length > 0 ? t('status.needsYou', { count: needs.length }) : undefined)
  if (seenNeeds) {
    for (const n of needs) {
      if (!seenNeeds.has(n.key) && !n.key.startsWith(`${me}\u0000`)) {
        await $.ui.toast(t('toast.needsYou', { project: n.project, item: n.item }))
      }
    }
  }
  seenNeeds = new Set(needs.map(n => n.key))
}

// One refresh: list the folder, read what changed, apply retention, update the status line.
async function scan($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const entries = await $.fs.list(dir).catch(() => undefined)
  // A failed listing keeps what the pane knows; its `checked` stamp then ages into "stale".
  if (!entries) return
  const before = await read($, sessions)
  const next: Loaded = {}
  const sidecars: Record<string, { mtimeMs: number; entries: Dismissal[] }> = {}
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.name.endsWith(SIDECAR)) {
      const id = entry.name.slice(0, -SIDECAR.length)
      const known = before[id]?.sidecar
      if (known && known.mtimeMs === entry.mtimeMs) {
        sidecars[id] = known
        continue
      }
      const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
      const parsed = text === undefined ? undefined : parseSidecar(text)
      // Unreadable (e.g. caught mid-write): keep the last good copy; its old mtime retries next tick.
      if (parsed) sidecars[id] = { mtimeMs: entry.mtimeMs, entries: parsed.entries }
      else if (known) sidecars[id] = known
      continue
    }
    const id = entry.name.slice(0, -'.json'.length)
    const known = before[id]
    if (known && known.mtimeMs === entry.mtimeMs) {
      next[id] = { mtimeMs: known.mtimeMs, file: known.file }
      continue
    }
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
    const file = text === undefined ? undefined : parseSessionFile(text)
    // Unreadable (e.g. caught mid-write): keep the last good copy, so the group neither flickers nor
    // re-announces its asks; the old mtime makes the next tick read it again.
    if (file) next[file.session.id] = { mtimeMs: entry.mtimeMs, file }
    else if (known) next[id] = { mtimeMs: known.mtimeMs, file: known.file }
  }
  for (const [id, sidecar] of Object.entries(sidecars)) {
    const known = next[id]
    if (known) next[id] = { ...known, sidecar }
  }
  await update($, sessions, () => next)

  const nowMs = await $.clock.now()
  const me = await $.session.id()
  const doneHours = optionNumber(options, 'autoClearDoneHours', 0)
  const keepDays = optionNumber(options, 'keepEndedSessionsDays', 7)
  for (const { file } of Object.values(next)) {
    const ended = file.session.endedAt
    if (ended !== null && keepDays > 0 && Date.parse(ended) < nowMs - keepDays * DAY_MS) {
      await forgetSession($, options, file.session.id)
      continue
    }
    // Only the owner prunes a live session's file; an ended one is anyone's to prune.
    if (file.session.id !== me && ended === null) continue
    const pruned = pruneDone(file, doneHours, nowMs)
    if (pruned !== file) await save($, dir, pruned)
  }
  await announce($, await read($, sessions), me)
  await update($, checked, () => nowMs)
}

function summarize(file: SessionFile, errors: readonly string[]): string {
  const lines = [t('tool.saved', { count: file.tasks.length })]
  for (const task of file.tasks) lines.push(`${task.id} ${task.status} ${task.title}`)
  if (errors.length > 0) lines.push(t('tool.problems'), ...errors)
  return lines.join('\n')
}

type ToolInput = UpdateInput & { watch?: WatchInput[]; unwatch?: string[] }

async function runUpdate($: EngineInterface, options: PluginOptions, input: ToolInput): Promise<string> {
  const dir = await progressDir($, options)
  if (!dir) return t('tool.noDir')
  const at = await nowIso($)
  const updated = applyUpdate(await ownFile($, dir), input, at)
  const watched = applyWatch(updated.file.pipelines ?? [], input.watch ?? [], input.unwatch ?? [], at)
  const file = { ...updated.file, pipelines: watched.list }
  await save($, dir, file)
  await announce($, await read($, sessions), file.session.id)
  const added = watched.list.filter(p => !(updated.file.pipelines ?? []).some(old => old.key === p.key))
  if (added.length > 0) await pollPipelines($, options)
  const text = summarize(file, [...updated.errors, ...watched.errors])
  return added.length > 0
    ? `${text}\n${t('tool.watching', { keys: added.map(p => p.key).join(', ') })}`
    : text
}

// One `glab api <path>`: the parsed JSON text, or the CLI's error as one line.
async function glabApi($: EngineInterface, path: string): Promise<{ text?: string; error?: string }> {
  const ran = await $.process.run(['glab', 'api', path]).catch((err: unknown) => ({
    exitCode: 127,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
  }))
  if (ran.exitCode === 0) return { text: ran.stdout }
  const line = (ran.stderr || ran.stdout).trim().split('\n').pop() ?? ''
  return { error: line || `glab exited ${ran.exitCode}` }
}

type CachedEstimate = { atMs: number; s: number | null }

// The average duration of earlier successful runs of the same project, ref and source: from the
// store when fetched within ESTIMATE_TTL_MS, else one `glab api` list call (cached afterwards).
async function estimateFor(
  $: EngineInterface,
  project: string,
  ref: string,
  source: string | undefined,
  exceptId: number,
  nowMs: number,
): Promise<number | null> {
  const key = `estimate:${project}@${ref}:${source ?? '*'}`
  const cached = (await $.store.get(key)) as CachedEstimate | undefined
  if (cached && typeof cached.atMs === 'number' && nowMs - cached.atMs < ESTIMATE_TTL_MS)
    return cached.s ?? null
  const list = await glabApi(
    $,
    `projects/${encodeURIComponent(project)}/pipelines?ref=${encodeURIComponent(ref)}&status=success${
      source ? `&source=${encodeURIComponent(source)}` : ''
    }&per_page=6`,
  )
  if (list.text === undefined) return null
  const s = estimateFrom(parseDurations(list.text, exceptId))
  await $.store.set(key, { atMs: nowMs, s } satisfies CachedEstimate)
  return s
}

// Fetches one pipeline's head and jobs (finding it by commit first, when only the sha is known).
async function refreshPipeline($: EngineInterface, p: Pipeline, at: string): Promise<Pipeline> {
  const project = encodeURIComponent(p.project)
  // By commit, GitLab's list answer already carries the newest pipeline's status: no second call.
  const head =
    p.id === null
      ? await glabApi($, `projects/${project}/pipelines?sha=${encodeURIComponent(p.sha ?? '')}&per_page=1`)
      : await glabApi($, `projects/${project}/pipelines/${p.id}`)
  const parsed = head.text === undefined ? undefined : parsePipeline(head.text)
  // Not created yet (a fresh push): no error, try again next round.
  if (!parsed && p.id === null && !head.error) return { ...p, checkedAt: at }
  if (!parsed) return { ...p, checkedAt: at, error: head.error ?? 'glab: unreadable pipeline' }
  const id = parsed.id
  const estimate =
    p.estimateS === undefined && parsed.ref
      ? await estimateFor($, p.project, parsed.ref, parsed.source, id, Date.parse(at))
      : p.estimateS
  const jobsText = await glabApi($, `projects/${project}/pipelines/${id}/jobs?per_page=100`)
  const jobs: PipelineJob[] = (jobsText.text === undefined ? undefined : parseJobs(jobsText.text)) ?? p.jobs
  const { error: _cleared, ...rest } = p
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
    ...(estimate !== undefined ? { estimateS: estimate } : {}),
    jobs,
    checkedAt: at,
    ...(isFinished(parsed.state) && !p.finishedAt ? { finishedAt: at } : {}),
    ...(jobsText.error ? { error: jobsText.error } : {}),
  }
}

// The session's own unfinished pipelines, refreshed and saved (only when something moved).
async function pollPipelines($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const file = await ownFile($, dir)
  const list = file.pipelines ?? []
  if (!list.some(p => !isFinished(p.state))) return
  const at = await nowIso($)
  const next: Pipeline[] = []
  for (const p of list) next.push(isFinished(p.state) ? p : await refreshPipeline($, p, at))
  await save($, dir, { ...file, pipelines: next })
}

async function markEnded($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const file = await ownFile($, dir)
  await save($, dir, { ...file, session: { ...file.session, endedAt: await nowIso($) } })
}

function asSort(value: unknown): SortBy | undefined {
  return typeof value === 'string' && (SORTS as readonly string[]).includes(value)
    ? (value as SortBy)
    : undefined
}

async function sortBy($: EngineInterface, options: PluginOptions): Promise<SortBy> {
  return (
    asSort(await read($, sorting)) ??
    asSort(await $.store.get(SORT_KEY)) ??
    asSort(optionString(options, 'sortTasksBy')) ??
    'status'
  )
}

async function cycleSort($: EngineInterface, options: PluginOptions): Promise<void> {
  const current = await sortBy($, options)
  const next = SORTS[(SORTS.indexOf(current) + 1) % SORTS.length] as SortBy
  await $.store.set(SORT_KEY, next)
  await update($, sorting, () => next)
}

async function toggle($: EngineInterface, key: string, isOpenNow: boolean): Promise<void> {
  await update($, folds, all => ({ ...all, [key]: !isOpenNow }))
}

// The Pipelines section's fold is keyed by the pipelines' current states (`pipelines@<signature>`):
// the person's choice holds until a state changes, then the default (open unless every pipeline
// succeeded) applies again. Older signatures are dropped so the fold state does not pile up.
async function toggleSection($: EngineInterface, key: string, isOpenNow: boolean): Promise<void> {
  await update($, folds, all => {
    const kept = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith('pipelines@')))
    return { ...kept, [key]: !isOpenNow }
  })
}

function lastActivity(file: SessionFile): number {
  return Date.parse(file.session.endedAt ?? file.updatedAt) || 0
}

// This session first, then live sessions by newest update, then ended ones by when they ended.
function orderSessions(all: Loaded, me: string): SessionFile[] {
  return Object.values(all)
    .map(s => s.file)
    .sort((a, b) => {
      if (a.session.id === me) return -1
      if (b.session.id === me) return 1
      const aEnded = a.session.endedAt !== null
      const bEnded = b.session.endedAt !== null
      if (aEnded !== bEnded) return aEnded ? 1 : -1
      return lastActivity(b) - lastActivity(a)
    })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'progress', description: t('command.description') })
    await $.tool.register({
      name: TOOL,
      description: t('tool.description'),
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    const dir = await progressDir($, options)
    if (dir) await save($, dir, await ownFile($, dir))
    await scan($, options)
    $.clock.every(REFRESH_MS, () => void scan($, options))
    $.clock.every(PIPELINE_POLL_MS, () => void pollPipelines($, options))
    void $.ui.open({ id: PANE, title: t('pane.title') })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await markEnded($, options)
    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    await scan($, options)
    await $.ui.open({ id: PANE, title: t('pane.title') })
    return { text: t('command.opened') }
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    const input = e as unknown as ToolInput
    const text = await runUpdate($, options, {
      now: input.now,
      needsYou: input.needsYou,
      tasks: input.tasks,
      remove: input.remove,
      watch: input.watch,
      unwatch: input.unwatch,
    })
    return { result: text }
  }).catch(() => ({ result: t('tool.failed') }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, sessions)
    const folded = await read($, folds)
    const lastCheck = await read($, checked)
    const me = await $.session.id()
    const nowMs = await $.clock.now()
    const by = await sortBy($, options)
    const ordered = orderSessions(all, me)
    const live = ordered.filter(f => f.session.endedAt === null)
    const needs = liveNeeds(all)
    const newest = [...ordered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]

    if (!newest) return <Text dimColor>{t('pane.empty')}</Text>

    // Every session's pipelines, newest first, minus the finished ones dismissed with ✕.
    const startedMs = (p: Pipeline) => Date.parse(p.startedAt ?? p.addedAt) || 0
    const pipelineRows = ordered
      .flatMap(f =>
        visiblePipelines(f.pipelines ?? [], all[f.session.id]?.sidecar?.entries ?? []).map(pipeline => ({
          sessionId: f.session.id,
          pipeline,
        })),
      )
      .sort((a, b) => startedMs(b.pipeline) - startedMs(a.pipeline))
    // Successes older than an hour step aside into the folded "Finished" list.
    const isArchived = (p: Pipeline) => {
      const ended = Date.parse(p.pipelineFinishedAt ?? p.finishedAt ?? '')
      return p.state === 'success' && !Number.isNaN(ended) && ended < nowMs - ARCHIVE_AFTER_MS
    }
    const currentRows = pipelineRows.filter(r => !isArchived(r.pipeline))
    const archivedRows = pipelineRows.filter(r => isArchived(r.pipeline))
    const isFinishedOpen = folded[FINISHED_KEY] ?? false

    const states = pipelineRows.map(r => r.pipeline.state)
    const allSucceeded = states.length > 0 && states.every(st => st === 'success')
    const sectionKey = `pipelines@${pipelineRows
      .map(r => `${r.sessionId}:${r.pipeline.key}=${r.pipeline.state}`)
      .sort()
      .join('|')}`
    const isSectionOpen = folded[sectionKey] ?? !allSucceeded
    const stoppedOther = states.filter(st => st === 'canceled' || st === 'skipped').length
    const sectionLabel = t('pane.pipelines', {
      fold: isSectionOpen ? '▾' : '▸',
      watching: states.filter(st => !isFinished(st)).length,
      succeeded: states.filter(st => st === 'success').length,
      failed: states.filter(st => st === 'failed').length,
      rest: stoppedOther > 0 ? t('pane.pipelinesCanceled', { n: stoppedOther }) : '',
    })

    const pipelineBlock = (sessionId: string, p: Pipeline) => {
      const key = `pipe:${sessionId}:${p.key}`
      const finished = isFinished(p.state)
      // Folded by default (compact): header + counts; a press opens the stage/job tree.
      const isOpen = folded[key] ?? false
      const counts = jobCounts(p.jobs)
      const label = t('pipe.header', {
        fold: isOpen ? '▾' : '▸',
        label: p.label,
        id: p.id ?? '?',
        ref: p.ref ? t('pipe.ref', { ref: p.ref }) : '',
        state: t(`pipe.state.${p.state}`),
        bar: progressBar(counts.finished, counts.total),
        finished: counts.finished,
        total: counts.total,
        duration: ((d: number | null) => {
          if (d === null) return ''
          // While it runs, the elapsed time beside the similar-run estimate: "4m53s / ~33m".
          if (!finished && typeof p.estimateS === 'number')
            return t('pipe.durationEstimate', { d: formatDuration(d), e: formatEstimate(p.estimateS) })
          return t('pipe.duration', { d: formatDuration(d) })
        })(pipelineDuration(p, nowMs)),
      })
      const countParts = COUNT_ORDER.filter(s => ALWAYS_COUNTED.has(s) || counts[s] > 0)
      // Names padded to the widest in this pipeline, so the times line up in a column.
      const width = Math.max(0, ...p.jobs.map(j => j.name.length))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Button key={key} label={label} plain onPress={() => void toggle($, key, isOpen)} />
            {finished && p.finishedAt ? (
              <Button
                key={`unpipe:${sessionId}:${p.key}`}
                label={t('pipe.dismiss')}
                plain
                dimColor
                onPress={() =>
                  void dismiss($, options, sessionId, [
                    { id: `pipeline:${p.key}`, doneAt: p.finishedAt ?? null },
                  ])
                }
              />
            ) : null}
          </Box>
          <Box flexDirection="column" paddingLeft={INDENT * 2}>
            {p.error ? <Text color="red">{p.error}</Text> : null}
            {/* A success folds to its one header line; anything else keeps its counts line. */}
            {counts.total > 0 && (isOpen || p.state !== 'success') ? (
              <Text>
                {countParts.flatMap((state, i) => [
                  i > 0 ? <Text dimColor>{' · '}</Text> : null,
                  <Text
                    color={counts[state] > 0 ? COUNT_COLOR[state] : undefined}
                    dimColor={counts[state] === 0}
                  >
                    {t(`pipe.count.${state}`, { n: counts[state] })}
                  </Text>,
                ])}
              </Text>
            ) : null}
            {isOpen
              ? stageGroups(p.jobs).map(group => (
                  <Box flexDirection="column">
                    <Text dimColor>{group.stage}</Text>
                    <Box flexDirection="column" paddingLeft={INDENT}>
                      {group.jobs.map(j => {
                        const jm = JOB_MARK[j.state]
                        const duration = isFinished(j.state) ? formatDuration(j.durationS) : ''
                        return (
                          <Text color={jm.color}>
                            {t(duration ? 'pipe.jobTimed' : 'pipe.job', {
                              glyph: jm.sign,
                              name: duration ? j.name.padEnd(width) : j.name,
                              duration,
                            })}
                          </Text>
                        )
                      })}
                    </Box>
                  </Box>
                ))
              : null}
          </Box>
        </Box>
      )
    }

    const taskRow = (task: Task) => {
      const mark = MARK[task.status] ?? { sign: '?' }
      return (
        <Box flexDirection="column">
          <Text color={mark.color} bold>
            {`${mark.sign} ${task.title}`}
          </Text>
          {task.note ? (
            <Box paddingLeft={INDENT}>
              <Text dimColor>{task.note}</Text>
            </Box>
          ) : null}
        </Box>
      )
    }

    const doneRow = (sessionId: string, task: Task) => (
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text dimColor>
          {t(task.status === 'done' ? 'pane.doneItem' : 'pane.skippedItem', {
            title: task.title,
            when: formatTime(task.doneAt ?? task.updatedAt, nowMs),
          })}
        </Text>
        <Button
          key={`dismiss:${sessionId}:${task.id}`}
          label={t('pane.dismiss')}
          plain
          dimColor
          onPress={() => void dismiss($, options, sessionId, [task])}
        />
      </Box>
    )

    const group = (file: SessionFile) => {
      const id = file.session.id
      const ended = file.session.endedAt
      const shown = visibleTasks(file, all[id]?.sidecar?.entries ?? [])
      const open = sortTasks(
        shown.filter(x => !isClosed(x.status)),
        by,
      )
      const done = sortTasks(
        shown.filter(x => isClosed(x.status)),
        by === 'status' ? 'done' : by,
      )
      const groupKey = `group:${id}`
      const doneKey = `done:${id}`
      const isOpen = folded[groupKey] ?? ended === null
      const isDoneOpen = folded[doneKey] ?? false
      const name = id === me ? t('pane.thisSession', { project: file.session.project }) : file.session.project
      const label = t(ended === null ? 'pane.groupLive' : 'pane.groupEnded', {
        fold: isOpen ? '▾' : '▸',
        name,
        when: formatTime(ended ?? file.updatedAt, nowMs),
        open: open.length,
        done: done.length,
      })
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Button
              key={groupKey}
              label={label}
              plain
              dimColor={ended !== null}
              onPress={() => void toggle($, groupKey, isOpen)}
            />
            {ended !== null ? (
              <Button
                key={`forget:${id}`}
                label={t('pane.forget')}
                plain
                dimColor
                onPress={() => void forgetSession($, options, id)}
              />
            ) : null}
          </Box>
          {isOpen ? (
            <Box flexDirection="column" paddingLeft={INDENT}>
              {open.map(taskRow)}
              {done.length > 0 ? (
                <Box flexDirection="row" justifyContent="space-between" gap={2}>
                  <Button
                    key={doneKey}
                    label={t('pane.doneSection', { fold: isDoneOpen ? '▾' : '▸', count: done.length })}
                    plain
                    dimColor
                    onPress={() => void toggle($, doneKey, isDoneOpen)}
                  />
                  <Button
                    key={`clear:${id}`}
                    label={t('pane.clearAll')}
                    plain
                    dimColor
                    onPress={() => void dismiss($, options, id, done)}
                  />
                </Box>
              ) : null}
              {isDoneOpen ? (
                <Box flexDirection="column" paddingLeft={INDENT}>
                  {done.map(task => doneRow(id, task))}
                </Box>
              ) : null}
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {`${t('pane.updated', { when: formatTime(newest.updatedAt, nowMs), project: newest.session.project })} · `}
          {nowMs - lastCheck > STALE_AFTER_MS ? (
            <Text color="yellow">{t('pane.checkedStale', { when: formatClock(lastCheck) })}</Text>
          ) : (
            t('pane.checked', { when: formatClock(lastCheck) })
          )}
        </Text>
        {needs.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold inverse color="magenta">
              {t('pane.needsYou', { count: needs.length })}
            </Text>
            <Box flexDirection="column" paddingLeft={INDENT}>
              {needs.map(n => (
                <Text bold color="magenta">
                  {t('pane.needsYouItem', { project: n.project, item: n.item })}
                </Text>
              ))}
            </Box>
          </Box>
        ) : null}
        {live.some(f => f.now) ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{t('pane.now')}</Text>
            <Box flexDirection="column" paddingLeft={INDENT}>
              {live
                .filter(f => f.now)
                .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
                .map(f => (
                  <Text>{t('pane.nowItem', { project: f.session.project, now: f.now ?? '' })}</Text>
                ))}
            </Box>
          </Box>
        ) : null}
        {pipelineRows.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Button
              key="pipelines"
              label={sectionLabel}
              plain
              onPress={() => void toggleSection($, sectionKey, isSectionOpen)}
            />
            {isSectionOpen ? (
              <Box flexDirection="column" paddingLeft={INDENT}>
                {currentRows.map(({ sessionId, pipeline }) => pipelineBlock(sessionId, pipeline))}
                {archivedRows.length > 0 ? (
                  <Button
                    key={FINISHED_KEY}
                    label={t('pane.pipelinesFinished', {
                      fold: isFinishedOpen ? '▾' : '▸',
                      count: archivedRows.length,
                    })}
                    plain
                    dimColor
                    onPress={() => void toggle($, FINISHED_KEY, isFinishedOpen)}
                  />
                ) : null}
                {archivedRows.length > 0 && isFinishedOpen ? (
                  <Box flexDirection="column" paddingLeft={INDENT}>
                    {archivedRows.map(({ sessionId, pipeline }) => pipelineBlock(sessionId, pipeline))}
                  </Box>
                ) : null}
              </Box>
            ) : null}
          </Box>
        ) : null}
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Text bold>{t('pane.sessions')}</Text>
          <Button
            key="sort"
            label={t('pane.sort', { by: t(`sort.${by}`) })}
            plain
            dimColor
            onPress={() => void cycleSort($, options)}
          />
        </Box>
        <Box flexDirection="column" paddingLeft={INDENT}>
          {ordered.map(group)}
        </Box>
      </Box>
    )
  })
}
