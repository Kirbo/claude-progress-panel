import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Folds, Loaded, SortChoice } from '../types'
import { commandArgv, parseCommandStatus } from './command'
import { apiHost, parseRemote } from './forges'
import { parseGiteaJobs, parseGiteaRun, teaLoginFor } from './gitea'
import { ghEstimateSamples, parseGhJobs, parseGhRun } from './github'
import { t, tn } from './i18n'
import type { Dismissal, SessionFile, SidecarFile, SortBy, Task, UpdateInput } from './model'
import {
  AGENTS_SHOWN,
  addDismissals,
  applyAgentUpdate,
  applyUpdate,
  cancelTasks,
  capNewest,
  DONE_SHOWN,
  endAgent,
  formatClock,
  formatTime,
  groupByRepo,
  isBlank,
  isClosed,
  matchesTask,
  mergeScan,
  mergeSidecar,
  newSession,
  parseSessionFile,
  parseSidecar,
  pruneDone,
  SORTS,
  sortTasks,
  splitMatches,
  stepCounts,
  syncAgents,
  visibleTasks,
} from './model'
import { baseName, resolveProgressDir } from './paths'
import type { JobState, Pipeline, PipelineHead, PipelineJob, WatchInput } from './pipelines'
import {
  applyWatch,
  estimateFrom,
  formatDuration,
  formatEstimate,
  isFinished,
  isFullSha,
  isOrphaned,
  jobCounts,
  jobEstimatesFrom,
  NO_PIPELINE_HINT_MS,
  oneLine,
  overlayPipelines,
  parseCommitSha,
  parseJobs,
  parsePipeline,
  parseSampleIds,
  pipelineDuration,
  progressBar,
  shouldPoll,
  shownError,
  stageGroups,
  stillWaiting,
  visiblePipelines,
} from './pipelines'
import { ciProvider, parsePushes, pushedRef, resolvePath } from './push'
import { isNewer, latestReleaseUrl, parseLatestRelease } from './update'

const PANE = 'progress'
const TOOL = 'progress_update'
const TOOL_ID = `mcp__progress-panel__${TOOL}`
const REPORTING_SECTION = 'progress-panel:reporting'
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
// Once the watching session has not checked an unfinished pipeline for this long (it ended, or was
// killed without ending), any pane polls it instead, writing to that session's sidecar.
const ORPHAN_AFTER_MS = 4 * PIPELINE_POLL_MS
// A pipeline that succeeded longer ago than this moves into the folded "Finished" list.
const ARCHIVE_AFTER_MS = 3_600_000
// Similar-run estimates are cached in the plugin's store this long, per project + ref + source.
const ESTIMATE_TTL_MS = 24 * 3_600_000
const FINISHED_KEY = 'pipelines-finished'
// `-2` (0.14.0): `plan` became the default, so a choice remembered from before starts over once.
const SORT_KEY = 'sortTasksBy-2'

const sessions = atom({ plugin: 'progress-panel', key: 'sessions' } as const, {} as Loaded, {
  shape: 'sessions-3',
})
const SIDECAR = '.dismissed.json'
const folds = atom({ plugin: 'progress-panel', key: 'folds' } as const, {} as Folds, { shape: 'folds-1' })
// The newest release of the plugin (from the shared store or a check), drawn in the pane's corner.
const releasing = atom(
  { plugin: 'progress-panel', key: 'release' } as const,
  null as { version: string; url: string } | null,
  { shape: 'release-1' },
)
// The version this copy runs, read from its own manifest once.
let manifest: { version: string; repository: string } | undefined
// GitLab cannot push its releases to a local plugin, so the newest one is looked up — at most every
// 6 h across every session on the machine (the answer is shared in the plugin's store).
// poll-exception: no push from GitLab to a local plugin
const RELEASE_CHECK_MS = 6 * 3_600_000
const RELEASE_KEY = 'latest-release'

// The text the person typed into the Filter beside Sessions: tasks without it are hidden.
const filtering = atom({ plugin: 'progress-panel', key: 'filter' } as const, '', { shape: 'filter-1' })
// When the last successful folder listing finished, so the header can show the pane is live.
const checked = atom({ plugin: 'progress-panel', key: 'checked' } as const, 0, { shape: 'checked-1' })
// The order the pane draws in, mirrored from $.store (kept per user across sessions) so a change redraws.
const sorting = atom({ plugin: 'progress-panel', key: 'sort' } as const, '' as SortChoice, {
  shape: 'sort-1',
})

// Needs-you items already announced, so a toast fires once per new item (module-local: a reload
// starts quiet again, seeded on its first scan).
let seenNeeds: Set<string> | undefined

// Every read-modify-write of this session's own file runs one at a time: a timer's poll and a tool
// call interleave at each await, and the later save would put a stale copy over the other's change.
let ownChain: Promise<unknown> = Promise.resolve()

// Tasks the person removed with ✕ that this session's agent has not been told about yet (id → title):
// the next main-loop tool call, prompt or progress_update answer carries the note, once.
const pendingRemovals = new Map<string, string>()

function takeRemovalNotice(): string | undefined {
  if (pendingRemovals.size === 0) return undefined
  const list = [...pendingRemovals].map(([id, title]) => `${id} "${title}"`).join(', ')
  pendingRemovals.clear()
  return t('notice.removed', { list })
}

// The name Claude Code gives this session (`/rename`, a resumed session's title), as the classic
// SessionStart / UserPromptSubmit events last carried it; the plugin API has no call for it.
let sessionTitle: string | undefined

// Whether this module put the reporting rule into a composed system prompt, and whether it has
// handed it to the agent another way. A plugin installed, reloaded (`/reload-plugins`) or resumed
// mid-session is not asked to compose until the session's prompt is rebuilt, so the rule it relies
// on never reaches that agent — which then never reports. The next prompt carries it instead.
let ruleComposed = false
let ruleSent = false
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = ownChain.then(work, work)
  ownChain = run.catch(() => undefined)
  return run
}

/** A pointer over a pipeline or job row lights the whole row (a theme key: dim on dark and light
 *  themes alike), so the ↗ at its right edge is visibly that row's. */
const ROW_HOVER = { backgroundColor: 'subtle' } as const

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
// A pipeline's own state on its row: a live one in the running / queued colour behind its mark and
// in bold, a finished one dimmed but for the outcome's colour (2026-11-08: "it's too easy now not to
// notice a new running pipeline").
const PIPE_STATE_COLOR: Partial<Record<JobState | 'unknown', string>> = {
  running: 'yellow',
  queued: 'cyan',
  success: 'green',
  failed: 'red',
  manual: 'magenta',
}
const PIPE_LIVE_MARK: Partial<Record<JobState | 'unknown', string>> = {
  running: '● ',
  queued: '○ ',
  unknown: '○ ',
}
// Always shown, even at 0 (the rest only when present): the line reads the same way every time.
const ALWAYS_COUNTED = new Set<JobState>(['running', 'queued', 'skipped', 'success', 'failed'])

const MARK: Record<string, { sign: string; color?: string }> = {
  // Blocked = waiting (usually on the person): the Needs-you mark and colour, never a failure's ✗.
  blocked: { sign: '⚠', color: 'magenta' },
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
          repo: {
            type: 'string',
            description:
              'The repo this task belongs to (its name), when the session works in more than one; the pane groups tasks by it. "" clears.',
          },
          detail: {
            type: 'string',
            description: 'A longer description, shown when the person unfolds the task; "" clears it.',
          },
          steps: {
            type: 'array',
            description:
              'Subtasks, replacing the whole list (send it all each time; [] clears). The task shows how many are done (n/m).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done', 'skipped'] },
              },
              required: ['title'],
            },
          },
        },
      },
    },
    remove: { type: 'array', items: { type: 'string' } },
    eta: {
      type: 'number',
      description:
        'A subagent only: the minutes you expect the rest of your job to take, re-estimated each call.',
    },
    order: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Task ids (or exact titles) in the order you will do them; the pane lists them so. The rest keep their order after them.',
    },
    watch: {
      type: 'array',
      description:
        'CI pipelines to follow live in the pane: GitLab CI pipelines (the default) or GitHub Actions workflow runs (provider "github"). A git push run through Bash is watched automatically; watch a run by id, another repo\'s pipeline or a push made elsewhere.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['project'],
        properties: {
          provider: {
            type: 'string',
            enum: ['gitlab', 'github'],
            description: 'gitlab (default) or github (GitHub Actions)',
          },
          project: { type: 'string', description: 'GitLab group/name (full path) or GitHub owner/repo' },
          pipeline: { type: 'integer', description: 'GitLab pipeline id (GitHub: same as run)' },
          run: { type: 'integer', description: 'GitHub Actions workflow run id' },
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

// The pane's open request: its id and title, plus the size the settings ask for — the sidebar's
// width beside a fullscreen transcript and the block's height above the prompt. Requests, not grants:
// Claude Code caps the width (45 % of the terminal) and a size the person dragged to wins. 0 = ask
// for none (Claude Code's own default).
function paneArgs(options: PluginOptions): { id: string; title: string; columns?: number; rows?: number } {
  const columns = optionNumber(options, 'paneColumns', 84)
  const rows = optionNumber(options, 'paneRows', 20)
  return {
    id: PANE,
    title: t('pane.title'),
    ...(columns > 0 ? { columns } : {}),
    ...(rows > 0 ? { rows } : {}),
  }
}

function optionString(options: PluginOptions, name: string): string {
  const raw = options[name]
  return typeof raw === 'string' ? raw : ''
}

async function progressDir($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  // The environment wins over the setting: a demo or test session points at its own folder
  // without moving every other session's (the setting is per user).
  const override = (await $.env.get('PROGRESS_PANEL_DIR')) ?? ''
  return resolveProgressDir(override.trim() || optionString(options, 'progressDir'), { home, configDir })
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

type Sidecar = { entries: Dismissal[]; pipelines: Pipeline[]; cancelled: string[] }

async function readSidecar($: EngineInterface, dir: string, id: string): Promise<Sidecar> {
  const text = await $.fs.read(`${dir}/${id}${SIDECAR}`).catch(() => undefined)
  const parsed = text === undefined ? undefined : parseSidecar(text)
  return {
    entries: parsed?.entries ?? [],
    pipelines: parsed?.pipelines ?? [],
    cancelled: parsed?.cancelled ?? [],
  }
}

// A pane's change to a session's sidecar: read fresh, change, write whole, so a ✕ and a pipeline
// refresh never drop each other's part.
async function writeSidecar(
  $: EngineInterface,
  dir: string,
  id: string,
  change: (sidecar: Sidecar) => Sidecar,
): Promise<void> {
  const next = change(await readSidecar($, dir, id))
  const file: SidecarFile = {
    version: 1,
    sessionId: id,
    entries: next.entries,
    ...(next.pipelines.length > 0 ? { pipelines: next.pipelines } : {}),
    ...(next.cancelled.length > 0 ? { cancelled: next.cancelled } : {}),
  }
  const path = `${dir}/${id}${SIDECAR}`
  await $.fs.write(path, `${JSON.stringify(file, null, 2)}\n`)
  const stat = await $.fs.stat(path).catch(() => undefined)
  await update($, sessions, all => {
    const known = all[id]
    if (!known) return all
    return { ...all, [id]: { ...known, sidecar: { mtimeMs: stat?.mtimeMs ?? 0, ...next } } }
  })
}

// This session's file as it is on disk now, with the panes' dismissals folded in; a fresh one when
// there is none (first write, or after /clear).
async function ownFile($: EngineInterface, dir: string): Promise<SessionFile> {
  const id = await $.session.id()
  const text = await $.fs.read(`${dir}/${id}.json`).catch(() => undefined)
  const existing = text === undefined ? undefined : parseSessionFile(text)
  if (existing) {
    const sidecar = await readSidecar($, dir, id)
    const merged = withTitle(mergeSidecar(existing, sidecar.entries))
    const pipelines = overlayPipelines(merged.pipelines ?? [], sidecar.pipelines)
    // Tasks the person removed with ✕: skipped here, and the agent told on its next step.
    const folded = cancelTasks(
      { ...merged, pipelines: visiblePipelines(pipelines, sidecar.entries) },
      sidecar.cancelled,
      await nowIso($),
      t('task.removedNote'),
    )
    for (const task of folded.removed) pendingRemovals.set(task.id, task.title)
    return folded.file
  }
  const cwd = await $.session.cwd()
  const repo = await $.session.repo().catch(() => null)
  return withTitle(newSession({ id, project: baseName(repo?.root ?? cwd), cwd }, await nowIso($)))
}

function withTitle(file: SessionFile): SessionFile {
  return sessionTitle && file.session.title !== sessionTitle
    ? { ...file, session: { ...file.session, title: sessionTitle } }
    : file
}

// A title the classic events carried: remembered, and written at once when the session has a file
// (one that reported nothing still writes nothing).
async function noteTitle($: EngineInterface, options: PluginOptions, title: unknown): Promise<void> {
  if (typeof title !== 'string' || !title.trim() || title.trim() === sessionTitle) return
  sessionTitle = title.trim()
  const dir = await progressDir($, options)
  if (!dir) return
  await exclusive(async () => {
    const own = await ownFile($, dir)
    if (!isBlank(own)) await save($, dir, own)
  })
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
  await writeSidecar($, dir, id, sidecar => ({ ...sidecar, entries: addDismissals(sidecar.entries, tasks) }))
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

async function ownManifest($: EngineInterface): Promise<{ version: string; repository: string }> {
  if (!manifest) {
    const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => undefined)
    let raw: { version?: unknown; repository?: unknown } = {}
    try {
      raw = text === undefined ? {} : JSON.parse(text)
    } catch {
      raw = {}
    }
    manifest = {
      version: typeof raw.version === 'string' ? raw.version : '',
      repository: typeof raw.repository === 'string' ? raw.repository : '',
    }
  }
  return manifest
}

// The newest release: the shared answer when it is under 6 h old, else one look at GitLab (a
// failure keeps the last answer). Never with nonessential traffic turned off.
async function checkRelease($: EngineInterface): Promise<void> {
  type Cached = { version: string; url: string; checkedAtMs: number }
  const cached = (await $.store.get(RELEASE_KEY)) as Cached | undefined
  const known =
    cached && typeof cached.version === 'string' ? { version: cached.version, url: cached.url } : null
  if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return update($, releasing, () => known)
  const nowMs = await $.clock.now()
  if (cached && nowMs - cached.checkedAtMs < RELEASE_CHECK_MS) return update($, releasing, () => known)
  const url = latestReleaseUrl((await ownManifest($)).repository)
  const answer = url ? await $.http.fetch(url).catch(() => undefined) : undefined
  const latest = answer?.ok ? parseLatestRelease(answer.text) : undefined
  if (latest) await $.store.set(RELEASE_KEY, { ...latest, checkedAtMs: nowMs } satisfies Cached)
  await update($, releasing, () => latest ?? known)
}

/** One line for a progress_update call in the transcript: its `now`, how many tasks, watches. */
function callSummary(input: ToolInput | undefined): string {
  const parts = [
    input?.now ?? '',
    input?.tasks?.length ? tn('call.tasks', input.tasks.length) : '',
    input?.watch?.length ? tn('call.watching', input.watch.length) : '',
    input?.needsYou?.length ? tn('call.asks', input.needsYou.length) : '',
  ].filter(Boolean)
  return t('call.summary', { what: parts.length ? parts.join(' · ') : t('call.updated') })
}

/** How the pane names a session: Claude Code's name for it, else its repo / folder. */
function sessionName(file: SessionFile): string {
  return file.session.title || file.session.project
}

function liveNeeds(all: Loaded): { project: string; item: string; key: string }[] {
  return Object.values(all)
    .filter(s => s.file.session.endedAt === null)
    .sort((a, b) => Date.parse(b.file.updatedAt) - Date.parse(a.file.updatedAt))
    .flatMap(s =>
      s.file.needsYou.map(item => ({
        project: sessionName(s.file),
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

// The 2 s refresh is single-flight: a tick that finds the previous scan still running skips, so
// slow disks never stack scans that then land out of order.
let scanning = false
async function tick($: EngineInterface, options: PluginOptions): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    await scan($, options)
  } finally {
    scanning = false
  }
}

// One refresh: list the folder, read what changed, apply retention, update the status line.
async function scan($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  await syncOwnAgents($, dir)
  const entries = await $.fs.list(dir).catch(() => undefined)
  // A failed listing keeps what the pane knows; its `checked` stamp then ages into "stale".
  if (!entries) return
  const before = await read($, sessions)
  const next: Loaded = {}
  const sidecars: Record<string, { mtimeMs: number } & Sidecar> = {}
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
      if (parsed)
        sidecars[id] = {
          mtimeMs: entry.mtimeMs,
          entries: parsed.entries,
          pipelines: parsed.pipelines ?? [],
          cancelled: parsed.cancelled ?? [],
        }
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
  await update($, sessions, current => mergeScan(before, current, next))

  const nowMs = await $.clock.now()
  const me = await $.session.id()
  const doneHours = optionNumber(options, 'autoClearDoneHours', 0)
  const keepDays = optionNumber(options, 'keepEndedSessionsDays', 7)
  for (const { file } of Object.values(next)) {
    const ended = file.session.endedAt
    const expired = keepDays > 0 && ended !== null && Date.parse(ended) < nowMs - keepDays * DAY_MS
    // An ended session with nothing in it (left by an older version, or auto-cleared empty) goes too.
    if (ended !== null && (expired || isBlank(file))) {
      await forgetSession($, options, file.session.id)
      continue
    }
    // Only the owner prunes a live session's file (fresh, under the lock); an ended one is anyone's.
    if (file.session.id === me) {
      await exclusive(async () => {
        const own = await ownFile($, dir)
        const pruned = pruneDone(own, doneHours, nowMs)
        // The fold of a removal changed it too: save, so the pane shows it skipped.
        const folded = (own.cancelled?.length ?? 0) !== (file.cancelled?.length ?? 0)
        if (pruned !== own || folded) await save($, dir, pruned)
      })
      continue
    }
    if (ended === null) continue
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
  // A watch of the session's own repo takes its host from the `origin` remote.
  const remote = input.watch?.length
    ? parseRemote((await $.session.repo().catch(() => null))?.remote)
    : undefined
  const { updated, watched, file } = await exclusive(async () => {
    const updated = applyUpdate(await ownFile($, dir), input, at)
    const watched = applyWatch(
      updated.file.pipelines ?? [],
      input.watch ?? [],
      input.unwatch ?? [],
      at,
      remote,
    )
    const file = { ...updated.file, pipelines: watched.list }
    await save($, dir, file)
    return { updated, watched, file }
  })
  await announce($, await read($, sessions), file.session.id)
  const added = watched.list.filter(p => !(updated.file.pipelines ?? []).some(old => old.key === p.key))
  if (added.length > 0) await pollPipelines($, options)
  const notice = takeRemovalNotice()
  const agents = agentsLine(file)
  const text = `${notice ? `${notice}\n` : ''}${summarize(file, [...updated.errors, ...watched.errors])}${agents ? `\n${agents}` : ''}`
  return added.length > 0
    ? `${text}\n${t('tool.watching', { keys: added.map(p => p.key).join(', ') })}`
    : text
}

// tea's logins (`tea login list --output json`), read at most once a minute: each Gitea / Forgejo
// call names the login whose URL is on the pipeline's host.
let teaLogins: { atMs: number; text: string } | undefined
const TEA_LOGINS_TTL_MS = 60_000

async function teaApi(
  $: EngineInterface,
  host: string,
  path: string,
): Promise<{ text?: string; error?: string }> {
  const nowMs = await $.clock.now()
  if (!teaLogins || nowMs - teaLogins.atMs > TEA_LOGINS_TTL_MS) {
    const listed = await runCli($, ['tea', 'login', 'list', '--output', 'json'])
    if (listed.text === undefined) return listed
    teaLogins = { atMs: nowMs, text: listed.text }
  }
  const login = teaLoginFor(teaLogins.text, host)
  if (!login) return { error: `tea: no login for ${host} (tea login add)` }
  return runCli($, ['tea', 'api', '--login', login, path])
}

// One Gitea / Forgejo Actions run's head and jobs (found by commit first, when only the sha is known).
async function refreshGiteaRun($: EngineInterface, p: Pipeline, at: string): Promise<Pipeline> {
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
async function refreshCommandRun(
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

// A subagent's progress_update: upserted into its entry, labelled by its Agent call's description.
async function runAgentUpdate(
  $: EngineInterface,
  options: PluginOptions,
  id: string,
  input: ToolInput,
): Promise<string> {
  const dir = await progressDir($, options)
  if (!dir) return t('tool.noDir')
  const listed = await $.agent.list().catch(() => [])
  const label =
    listed.find(a => a.id === id)?.description?.trim() || t('agent.fallbackLabel', { id: id.slice(0, 8) })
  const at = await nowIso($)
  const { errors, entry } = await exclusive(async () => {
    const r = applyAgentUpdate(await ownFile($, dir), { id, label }, input, at)
    await save($, dir, r.file)
    return { errors: r.errors, entry: r.file.agents?.find(a => a.id === id) }
  })
  const steps = entry ? entry.tasks : []
  const done = steps.filter(x => isClosed(x.status)).length
  return [t('tool.agentSaved', { done, total: steps.length }), ...errors].join('\n')
}

// This session's subagents into its own file, so one that never reports (no progress tool, e.g. a
// read-only reviewer) still shows under Agents while it runs. Written only when something changed.
async function syncOwnAgents($: EngineInterface, dir: string): Promise<void> {
  const listed = await $.agent.list().catch(() => [])
  if (listed.length === 0) return
  const at = await nowIso($)
  await exclusive(async () => {
    const own = await ownFile($, dir)
    const synced = syncAgents(own, listed, at)
    if (synced !== own) await save($, dir, synced)
  })
}

// One line per running subagent for the coordinator's answer: label, steps, estimate.
function agentsLine(file: SessionFile): string | undefined {
  const running = (file.agents ?? []).filter(a => a.endedAt === null)
  if (running.length === 0) return undefined
  const parts = running.map(a => {
    const done = a.tasks.filter(x => isClosed(x.status)).length
    const steps = a.tasks.length > 0 ? ` ${done}/${a.tasks.length}` : ''
    const eta = typeof a.etaMin === 'number' ? t('agent.eta', { min: a.etaMin }) : ''
    return `${a.label}${steps}${eta}`
  })
  return t('tool.agents', { list: parts.join('; ') })
}

// One CLI call: its output, or its error as one short line — from stderr only: stdout is the API's
// answer (a whole jobs list once stood in for the error), never a message.
async function runCli($: EngineInterface, argv: string[]): Promise<{ text?: string; error?: string }> {
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
async function cliApi(
  $: EngineInterface,
  cli: 'glab' | 'gh',
  path: string,
  host: string | undefined,
): Promise<{ text?: string; error?: string }> {
  return runCli($, host ? [cli, 'api', '--hostname', host, path] : [cli, 'api', path])
}

const glabApi = ($: EngineInterface, path: string, host: string | undefined) => cliApi($, 'glab', path, host)
const ghApi = ($: EngineInterface, path: string, host: string | undefined) => cliApi($, 'gh', path, host)

type CachedEstimate = { atMs: number; s: number | null; jobs?: Record<string, number> }
type Estimates = { s: number | null; jobs: Record<string, number> }

// The average duration of earlier successful runs of the same project, ref and source, and per job
// name: from the store when fetched within ESTIMATE_TTL_MS, else one `glab api` list call plus one
// jobs call per sample run (at most 5), cached afterwards.
async function estimateFor(
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
async function ghEstimateFor(
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
async function refreshGithubRun($: EngineInterface, p: Pipeline, at: string): Promise<Pipeline> {
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
function merged(
  p: Pipeline,
  parsed: PipelineHead & { workflowId?: number },
  id: number,
  estimate: Estimates | undefined,
  jobs: PipelineJob[],
  jobsError: string | undefined,
  at: string,
): Pipeline {
  const { error: _cleared, ...kept } = p
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
async function fullSha($: EngineInterface, p: Pipeline): Promise<string | undefined> {
  if (!p.sha || isFullSha(p.sha)) return undefined
  const sha = encodeURIComponent(p.sha)
  const answer =
    p.provider === 'github'
      ? await ghApi($, `repos/${p.project}/commits/${sha}`, apiHost(p))
      : await glabApi($, `projects/${encodeURIComponent(p.project)}/repository/commits/${sha}`, apiHost(p))
  const full = answer.text === undefined ? undefined : parseCommitSha(answer.text)
  return full && full !== p.sha ? full : undefined
}

function noneYet(p: Pipeline): string {
  return t('pipe.noneYet', { sha: (p.sha ?? '').slice(0, 12), minutes: NO_PIPELINE_HINT_MS / 60_000 })
}

// Fetches one pipeline's head and jobs (finding it by commit first, when only the sha is known).
async function refreshPipeline(
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
async function pollPipelines($: EngineInterface, options: PluginOptions): Promise<void> {
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
  await exclusive(async () => {
    const file = await ownFile($, dir)
    const pipelines = (file.pipelines ?? []).map(p => fresh.find(f => f.key === p.key) ?? p)
    await save($, dir, { ...file, pipelines })
  })
}

// Other sessions' unfinished pipelines they stopped polling (ended, or killed without ending):
// refreshed here, the copies written to that session's sidecar — never to its own file.
async function pollOrphans($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const me = await $.session.id()
  const nowMs = await $.clock.now()
  for (const [id, known] of Object.entries(await read($, sessions))) {
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

// The session's own pipelines first, then the ones other sessions left behind.
async function pollAll($: EngineInterface, options: PluginOptions): Promise<void> {
  await pollPipelines($, options)
  await pollOrphans($, options)
}

// A background step nobody awaits (a timer tick, the startup lookups): one that fails — or outlives
// its session, its state gone — is dropped; the next tick tries again. Never an unhandled rejection.
function detached(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

// With a prompt: the reporting rule itself, once, when no composed system prompt carried it (see
// `ruleComposed`); then, while this session has reported nothing yet, a one-line reminder — so a
// session the plugin joined mid-way starts reporting without being told to. Short and steady, and
// gone with the first report.
async function withReportingNudge<R extends { additionalContext?: string[] }>(
  $: EngineInterface,
  options: PluginOptions,
  result: R,
): Promise<R> {
  const notes: string[] = []
  if (!ruleComposed && !ruleSent) {
    ruleSent = true
    notes.push(t('prompt.reporting'))
  }
  if (notes.length === 0 && !(await hasReported($, options))) notes.push(t('prompt.nudge'))
  return notes.length
    ? { ...result, additionalContext: [...(result.additionalContext ?? []), ...notes] }
    : result
}

// Whether this session's own file holds anything yet — a plain read, nothing folded or queued.
async function hasReported($: EngineInterface, options: PluginOptions): Promise<boolean> {
  const own = await readOwnPlain($, options)
  if (own === 'nowhere') return true // nowhere to report to: nothing to remind of
  return own !== undefined && !isBlank(own)
}

// This session's file as it is on disk (`undefined` before its first write), or 'nowhere' when no
// progress folder resolves — a plain read, nothing folded or queued.
async function readOwnPlain(
  $: EngineInterface,
  options: PluginOptions,
): Promise<SessionFile | undefined | 'nowhere'> {
  const dir = await progressDir($, options)
  if (!dir) return 'nowhere'
  const text = await $.fs.read(`${dir}/${await $.session.id()}.json`).catch(() => undefined)
  return text === undefined ? undefined : parseSessionFile(text)
}

// Subagents told the reporting rule (once each, process-wide).
const subagentRuleSent = new Set<string>()

// A subagent's system prompt never carries the reporting rule (`prompt.compose` builds only the
// session's): SubagentStart hands it the subagent part of the rule as it starts and, where that
// event never fired (an engine without it), its FIRST tool call's result carries it — once per
// agent, and never to one that already reported.
async function withSubagentRule<R extends { additionalContext?: string[] }>(
  $: EngineInterface,
  options: PluginOptions,
  agentId: string,
  result: R,
): Promise<R> {
  if (subagentRuleSent.has(agentId)) return result
  subagentRuleSent.add(agentId)
  const own = await readOwnPlain($, options)
  if (own === 'nowhere') return result
  const entry = own?.agents?.find(a => a.id === agentId)
  if (entry && (entry.now || entry.tasks.length > 0)) return result
  return { ...result, additionalContext: [...(result.additionalContext ?? []), t('prompt.subagent')] }
}

// A `git push` the agent ran (main loop or subagent) watches the pipeline it starts, without the
// agent asking: the repo's CI read off its files, the forge host and project off the pushed remote,
// the sha off the pushed ref. Only a push that landed: a failed call, a dry run or a delete watches
// nothing, and a branch whose remote-tracking ref is not the pushed sha (rejected) neither. The
// watch goes through the same `applyWatch` as the tool's, so one the agent also sends is the same
// key — never a second row.
async function watchPushes($: EngineInterface, options: PluginOptions, e: unknown): Promise<string[]> {
  const call = e as {
    tool_name?: unknown
    tool_input?: { command?: unknown }
    tool_response?: { interrupted?: unknown; exitCode?: unknown; returnCode?: unknown }
    cwd?: unknown
  }
  if (call.tool_name !== 'Bash' || typeof call.tool_input?.command !== 'string') return []
  const response = call.tool_response ?? {}
  if (response.interrupted === true) return []
  for (const code of [response.exitCode, response.returnCode])
    if (typeof code === 'number' && code !== 0) return []
  const pushes = parsePushes(call.tool_input.command)
  if (pushes.length === 0) return []
  const dir = await progressDir($, options)
  if (!dir) return []
  const base = typeof call.cwd === 'string' && call.cwd ? call.cwd : await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? undefined
  const watches: WatchInput[] = []
  for (const push of pushes)
    watches.push(...(await pushWatches($, options, resolvePath(base, push.dir, home), push)))
  if (watches.length === 0) return []
  const at = await nowIso($)
  const { added, file } = await exclusive(async () => {
    const own = await ownFile($, dir)
    const before = own.pipelines ?? []
    const watched = applyWatch(before, watches, [], at)
    const added = watched.list.filter(p => !before.some(old => old.key === p.key))
    const file = { ...own, pipelines: watched.list }
    if (added.length > 0) await save($, dir, file)
    return { added, file }
  })
  if (added.length === 0) return []
  await announce($, await read($, sessions), file.session.id)
  await pollPipelines($, options)
  return added.map(p => p.key)
}

// The watches one push asks for: each pushed branch head (or tag) by sha, on the repo's CI.
async function pushWatches(
  $: EngineInterface,
  options: PluginOptions,
  where: string,
  push: ReturnType<typeof parsePushes>[number],
): Promise<WatchInput[]> {
  const git = async (...args: string[]) =>
    (await runCli($, ['git', '-C', where, ...args])).text?.trim() || undefined
  const root = await git('rev-parse', '--show-toplevel')
  if (!root) return []
  const has = async (path: string) =>
    (await $.fs.stat(`${root}/${path}`).catch(() => undefined)) !== undefined
  const workflows = async (path: string) =>
    ((await $.fs.list(`${root}/${path}`).catch(() => undefined)) ?? []).some(f => /\.ya?ml$/i.test(f.name))
  const provider = ciProvider(
    {
      gitlab: await has('.gitlab-ci.yml'),
      github: await workflows('.github/workflows'),
      gitea: (await workflows('.gitea/workflows')) || (await workflows('.forgejo/workflows')),
    },
    optionString(options, 'ciCommand').trim() !== '',
  )
  if (!provider) return []
  // The remote: the one the push named (a name or a URL), else the branch's upstream's, else origin.
  const upstream = push.remote
    ? undefined
    : await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  const remoteName = push.remote ?? upstream?.split('/')[0] ?? 'origin'
  const isUrl = /[:/]/.test(remoteName)
  const url = isUrl ? remoteName : await git('remote', 'get-url', remoteName)
  const remote = parseRemote(url)
  if (provider !== 'command' && !remote) return []
  const repo = baseName(root)
  const specs = push.refs.length > 0 ? push.refs : push.tags && !push.all ? [] : ['HEAD']
  const out: WatchInput[] = []
  for (const spec of specs) {
    const ref = pushedRef(spec)
    if (!ref) continue
    const sha = await git('rev-parse', '--verify', '--quiet', `${ref.src}^{commit}`)
    if (!sha) continue
    const name =
      ref.src === 'HEAD' && ref.name === 'HEAD' ? await git('rev-parse', '--abbrev-ref', 'HEAD') : ref.name
    // A rejected branch push leaves the remote-tracking ref where it was: nothing landed to watch.
    if (!ref.tag && !isUrl && name) {
      const tracking = await git('rev-parse', '--verify', '--quiet', `refs/remotes/${remoteName}/${name}`)
      if (tracking && tracking !== sha) continue
    }
    out.push({
      provider,
      project: remote?.path ?? repo,
      sha,
      ...(provider !== 'command' && remote ? { host: remote.host } : {}),
      label: name ? `${repo} ${name}` : repo,
    })
  }
  return out
}

function withPushNote<R extends { additionalContext?: string[] }>(keys: string[], result: R): R {
  if (keys.length === 0) return result
  return {
    ...result,
    additionalContext: [...(result.additionalContext ?? []), t('push.watched', { keys: keys.join(', ') })],
  }
}

function withRemovalNotice<R extends { additionalContext?: string[] }>(result: R): R {
  const note = takeRemovalNotice()
  return note ? { ...result, additionalContext: [...(result.additionalContext ?? []), note] } : result
}

// A ✕ on an open task: the removal goes to that session's sidecar (its own file keeps one writer);
// the session folds it in and tells its agent.
async function cancelTask(
  $: EngineInterface,
  options: PluginOptions,
  id: string,
  taskId: string,
): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  await writeSidecar($, dir, id, sidecar =>
    sidecar.cancelled.includes(taskId) ? sidecar : { ...sidecar, cancelled: [...sidecar.cancelled, taskId] },
  )
}

async function markEnded($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  await exclusive(async () => {
    const file = await ownFile($, dir)
    // Nothing to look back on: the session leaves no file (nor sidecar) behind.
    if (isBlank(file)) return forgetSession($, options, file.session.id)
    await save($, dir, { ...file, session: { ...file.session, endedAt: await nowIso($) } })
  })
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
    'plan'
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

// Sessions with something in them: this session first, then live sessions by newest update, then ended ones by when they ended.
function orderSessions(all: Loaded, me: string): SessionFile[] {
  return Object.values(all)
    .map(s => s.file)
    .filter(f => !isBlank(f))
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
    // A session's file is created by its first report, never blank (a session that reports
    // nothing leaves nothing behind); a resumed session's existing file is kept as it is.
    const dir = await progressDir($, options)
    if (dir)
      await exclusive(async () => {
        const own = await ownFile($, dir)
        if (!isBlank(own)) await save($, dir, own)
      })
    await scan($, options)
    $.clock.every(REFRESH_MS, () => detached(tick($, options)))
    $.clock.every(PIPELINE_POLL_MS, () => detached(pollAll($, options)))
    detached(ownManifest($))
    detached(checkRelease($))
    $.clock.every(3_600_000, () => detached(checkRelease($)))
    void $.ui.open(paneArgs(options))
    return next(e)
  })

  // The reporting rule rides every session's system prompt, so no session waits to be told to use the
  // pane. Only where the tool is offered (nothing to report through otherwise), and never in a
  // teammate's render of its lead's prompt (the lead reports). Steady text: the prompt cache keeps it.
  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL_ID) || e.traits.includes('teammate')) return composed
    ruleComposed = true
    return {
      sections: [
        ...composed.sections,
        { id: REPORTING_SECTION, text: t('prompt.reporting'), scope: 'session' },
      ],
    }
  })

  // The session's name (the plugin API has none): SessionStart carries a resumed session's title,
  // UserPromptSubmit the current one, so a `/rename` shows from the next prompt on.
  // A compaction keeps the system prompt but summarises the conversation: a rule that only rode a
  // prompt (`ruleSent`, the plugin joined mid-way) can be summarised away, so the session's own
  // compaction (SessionStart `compact`, never a subagent's) hands it over again.
  on('classic.SessionStart', async ($, e, next) => {
    const start = e as { session_title?: unknown; source?: unknown; agent_id?: unknown }
    await noteTitle($, options, start.session_title)
    const result = await next(e)
    if (start.source !== 'compact' || start.agent_id || ruleComposed) return result
    ruleSent = true
    return { ...result, additionalContext: [...(result.additionalContext ?? []), t('prompt.reporting')] }
  })
  // A subagent starts: the subagent part of the rule, once (its tool calls then carry none).
  on('classic.SubagentStart', async ($, e, next) => {
    const result = await next(e)
    const id = (e as { agent_id?: unknown }).agent_id
    return typeof id === 'string' && id ? withSubagentRule($, options, id, result) : result
  }).catch(() => undefined) // a failure here never holds a subagent up: the hook counts as absent
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteTitle($, options, (e as { session_title?: unknown }).session_title)
    return withReportingNudge($, options, withRemovalNotice(await next(e)))
  })
  // After every main-loop tool call: a task the person removed reaches the agent at its next step
  // (a subagent's calls never take the note — it is the coordinator's).
  // A subagent stopped: its entry is marked finished — it folds under Agents and stays (nothing is
  // cleaned up automatically).
  on('classic.SubagentStop', async ($, e, next) => {
    const id = (e as { agent_id?: unknown }).agent_id
    const dir = await progressDir($, options)
    if (typeof id === 'string' && dir) {
      const at = await nowIso($)
      await exclusive(async () => {
        const own = await ownFile($, dir)
        const ended = endAgent(own, id, at)
        if (ended !== own) await save($, dir, ended)
      })
    }
    return next(e)
  })
  // A subagent's first call instead carries the reporting rule it never got (`withSubagentRule`).
  on('classic.PostToolUse', async ($, e, next) => {
    const pushed = await watchPushes($, options, e).catch(() => [] as string[])
    const result = withPushNote(pushed, await next(e))
    const agentId = (e as { agent_id?: unknown }).agent_id
    if (typeof agentId === 'string' && agentId) return withSubagentRule($, options, agentId, result)
    return agentId ? result : withRemovalNotice(result)
  })

  on('session.end', async ($, e, next) => {
    await markEnded($, options)
    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    await scan($, options)
    await $.ui.open(paneArgs(options))
    return { text: t('command.opened') }
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    // One entry per session, kept by its main loop: a subagent's report would mix into it.
    // A subagent's report goes to ITS entry under the session (its steps, what it is on, its
    // estimate) — never the session's own tasks, which its coordinator keeps.
    const agentId = (e as { agentId?: unknown }).agentId
    if (typeof agentId === 'string' && agentId)
      return { result: await runAgentUpdate($, options, agentId, e as unknown as ToolInput) }
    const input = e as unknown as ToolInput
    const text = await runUpdate($, options, {
      now: input.now,
      needsYou: input.needsYou,
      tasks: input.tasks,
      remove: input.remove,
      order: input.order,
      eta: input.eta,
      watch: input.watch,
      unwatch: input.unwatch,
    })
    return { result: text }
  }).catch(() => ({ result: t('tool.failed') }))

  // The transcript: a progress_update call is bookkeeping, not work — one quiet line instead of its
  // whole input and the task list it answered (ctrl+o, an error or an interrupt draw it in full).
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = e.props
    if (row.tool !== TOOL_ID || row.isExpanded || row.isErrored || row.isInterrupted) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{callSummary(row.input as ToolInput | undefined)}</Text>
  })
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const result = e.props
    if (result.tool !== TOOL_ID || result.isExpanded || result.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Link } = $.ui.resolve(e)
    const all = await read($, sessions)
    const folded = await read($, folds)
    const lastCheck = await read($, checked)
    const me = await $.session.id()
    const nowMs = await $.clock.now()
    const by = await sortBy($, options)
    const query = await read($, filtering)
    const filteringNow = query.trim() !== ''
    // The filter's hits, inverted (readable on dark and light themes); the text as is without a filter.
    const hl = (text: string) =>
      filteringNow
        ? splitMatches(text, query).map(part => (part.hit ? <Text inverse>{part.text}</Text> : part.text))
        : text
    // A catalog line holding a title: only the title's hits are highlighted, the rest stays as is.
    const hlTitle = (line: string, title: string) => {
      const at = line.indexOf(title)
      if (!filteringNow || at < 0) return line
      return [line.slice(0, at), ...[hl(title)].flat(), line.slice(at + title.length)]
    }
    const release = await read($, releasing)
    const version = (await ownManifest($)).version
    const ordered = orderSessions(all, me)
    const live = ordered.filter(f => f.session.endedAt === null)
    const needs = liveNeeds(all)
    const newest = [...ordered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]

    if (!newest) return <Text dimColor>{t('pane.empty')}</Text>

    // Every session's pipelines, newest first, minus the finished ones dismissed with ✕.
    const startedMs = (p: Pipeline) => Date.parse(p.startedAt ?? p.addedAt) || 0
    const pipelineRows = ordered
      .flatMap(f =>
        visiblePipelines(
          overlayPipelines(f.pipelines ?? [], all[f.session.id]?.sidecar?.pipelines ?? []),
          all[f.session.id]?.sidecar?.entries ?? [],
        ).map(pipeline => ({
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
    const sectionParts = {
      fold: isSectionOpen ? '▾' : '▸',
      watching: states.filter(st => !isFinished(st)).length,
      succeeded: states.filter(st => st === 'success').length,
      failed: states.filter(st => st === 'failed').length,
      rest: stoppedOther > 0 ? t('pane.pipelinesCanceled', { n: stoppedOther }) : '',
    }
    const sectionLabel = t('pane.pipelines', sectionParts)

    // A ↗ that opens a GitLab page in the browser: the surface's own hyperlink (OSC 8 on the
    // terminal), so the click is the terminal's — nothing opens unless the person clicks it.
    const openLink = (url: string | undefined) =>
      url ? (
        <Text dimColor>
          <Link href={url} label={t('pipe.open')} />
        </Text>
      ) : null

    const pipelineBlock = (sessionId: string, p: Pipeline) => {
      const key = `pipe:${sessionId}:${p.key}`
      const finished = isFinished(p.state)
      // Folded by default (compact): header + counts; a press opens the stage/job tree. The choice is
      // kept per run state: unfolded while running, a pipeline folds again once it finishes (it
      // would otherwise reopen unfolded when a new pipeline opens the section).
      const foldKey = finished ? `${key}@${p.finishedAt ?? 'finished'}` : key
      const isOpen = folded[foldKey] ?? false
      const counts = jobCounts(p.jobs)
      const label = t('pipe.header', {
        fold: isOpen ? '▾' : '▸',
        label: p.label,
        id: p.id ?? '?',
        ref: p.ref ? t('pipe.ref', { ref: p.ref }) : '',
      })
      // The state, bar, counts and times sit on the right, beside ↗ / ✕.
      const status = t('pipe.status', {
        state: t(`pipe.state.${p.state}`),
        // The bar only while it runs: a finished pipeline's counts say it all.
        bar: finished ? '' : `${progressBar(counts.finished, counts.total)} `,
        finished: counts.finished,
        total: counts.total,
        duration: ((d: number | null) => {
          if (d === null) return ''
          // While it runs, the elapsed time beside the similar-run estimate: "4m53s / ~33m".
          if (!finished && typeof p.estimateS === 'number')
            return t('pipe.durationEstimate', { d: formatDuration(d), e: formatEstimate(p.estimateS) })
          return t('pipe.duration', { d: formatDuration(d) })
        })(pipelineDuration(p, nowMs)),
        // When it finished, like a done task's time: GitLab's own, else when this pane saw it end.
        ended: ((at: string | undefined) => {
          const when = finished && at ? formatTime(at, nowMs) : ''
          return when ? t('pipe.ended', { when }) : ''
        })(p.pipelineFinishedAt ?? p.finishedAt),
      })
      const countParts = COUNT_ORDER.filter(s => ALWAYS_COUNTED.has(s) || counts[s] > 0)
      // Names padded to the widest in this pipeline, so the times line up in a column.
      const width = Math.max(0, ...p.jobs.map(j => j.name.length))
      return (
        <Box flexDirection="column">
          <Box
            key={`row:${key}`}
            flexDirection="row"
            justifyContent="space-between"
            gap={2}
            hover={ROW_HOVER}
          >
            <Button key={key} label={label} plain onPress={() => void toggle($, foldKey, isOpen)}>
              {finished ? null : (
                <Text color={PIPE_STATE_COLOR[p.state] ?? 'cyan'}>{PIPE_LIVE_MARK[p.state] ?? '● '}</Text>
              )}
              <Text bold={!finished} dimColor={finished}>
                {label}
              </Text>
            </Button>
            <Box flexDirection="row">
              <Button
                key={`pipestate:${key}`}
                label={status}
                plain
                onPress={() => void toggle($, foldKey, isOpen)}
              >
                <Text
                  color={PIPE_STATE_COLOR[p.state]}
                  bold={!finished || p.state === 'failed'}
                  dimColor={p.state === 'canceled' || p.state === 'skipped'}
                >
                  {status}
                </Text>
              </Button>
              {openLink(p.url)}
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
          </Box>
          <Box flexDirection="column" paddingLeft={INDENT * 2}>
            {p.error && shownError(p.error) ? <Text color="red">{shownError(p.error)}</Text> : null}
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
                    {/* GitHub runs have no stages: their jobs list flat, without a heading. */}
                    {group.stage ? <Text dimColor>{group.stage}</Text> : null}
                    <Box flexDirection="column" paddingLeft={group.stage ? INDENT : 0}>
                      {group.jobs.map(j => {
                        const jm = JOB_MARK[j.state]
                        const est = p.jobEstimates?.[j.name]
                        const elapsed =
                          j.state === 'running' && j.startedAt
                            ? Math.max(0, (nowMs - Date.parse(j.startedAt)) / 1000)
                            : null
                        // Finished: the real time. Running: elapsed / ~estimate. Queued: ~estimate.
                        const duration = isFinished(j.state)
                          ? formatDuration(j.durationS)
                          : elapsed !== null && est !== undefined
                            ? `${formatDuration(elapsed)} / ${formatEstimate(est)}`
                            : elapsed !== null
                              ? formatDuration(elapsed)
                              : est !== undefined
                                ? formatEstimate(est)
                                : ''
                        const line = (
                          <Text color={jm.color} hover={{ underline: true }}>
                            {t(duration ? 'pipe.jobTimed' : 'pipe.job', {
                              glyph: jm.sign,
                              name: duration ? j.name.padEnd(width) : j.name,
                              duration,
                            })}
                          </Text>
                        )
                        // Every job row is its own hover scope: the row lights and its text
                        // underlines, so the ↗ at the right edge reads as that row's.
                        return (
                          <Box
                            key={`row:${key}:${group.stage}:${j.name}`}
                            flexDirection="row"
                            justifyContent="space-between"
                            gap={2}
                            hover={ROW_HOVER}
                          >
                            {line}
                            {openLink(j.url)}
                          </Box>
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

    const taskRow = (sessionId: string, task: Task) => {
      const mark = MARK[task.status] ?? { sign: '?' }
      const note = task.note ? (
        <Box paddingLeft={INDENT}>
          <Text dimColor>{hl(task.note)}</Text>
        </Box>
      ) : null
      // Nothing more to show: one plain line.
      // ✕ removes an open task of a live session: it will not be done.
      const live = all[sessionId]?.file.session.endedAt === null
      const remove = live ? (
        <Button
          key={`cancel:${sessionId}:${task.id}`}
          label={t('pane.cancel')}
          plain
          dimColor
          onPress={() => void cancelTask($, options, sessionId, task.id)}
        />
      ) : null
      if (!task.detail && !task.steps?.length)
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" gap={2}>
              <Text color={mark.color} bold>
                {`${mark.sign} `}
                {hl(task.title)}
              </Text>
              {remove}
            </Box>
            {note}
          </Box>
        )
      // Details or subtasks: the title folds them, its steps counted on the right like a pipeline's jobs.
      const key = `task:${sessionId}:${task.id}`
      // While filtering, a hit inside the detail or the steps unfolds the task, so it shows.
      const hitInside = filteringNow && matchesTask({ ...task, title: '', note: undefined }, query)
      // A task in progress with steps starts open, so what it is on shows without a click; the
      // person's own fold wins, and once it is no longer `doing` it folds back by default.
      const inProgress = task.status === 'doing' && (task.steps?.length ?? 0) > 0
      const isOpen = folded[key] ?? (hitInside || inProgress)
      const steps = stepCounts(task)
      return (
        <Box flexDirection="column">
          <Box
            key={`row:${key}`}
            flexDirection="row"
            justifyContent="space-between"
            gap={2}
            hover={ROW_HOVER}
          >
            <Box flexDirection="row" gap={1}>
              <Text color={mark.color} bold>
                {mark.sign}
              </Text>
              {/* A Button label cannot be styled: while filtering, the title moves beside the fold
                  arrow as text, so its hit can be highlighted. */}
              <Button
                key={key}
                label={
                  filteringNow
                    ? t('pane.foldGlyph', { fold: isOpen ? '▾' : '▸' })
                    : t('pane.taskFold', { fold: isOpen ? '▾' : '▸', title: task.title })
                }
                plain
                onPress={() => void toggle($, key, isOpen)}
              />
              {filteringNow ? <Text>{hl(task.title)}</Text> : null}
            </Box>
            <Box flexDirection="row">
              {steps.total > 0 ? (
                <Text dimColor>
                  {t('pane.taskSteps', {
                    bar: progressBar(steps.closed, steps.total),
                    closed: steps.closed,
                    total: steps.total,
                  })}
                </Text>
              ) : null}
              {remove}
            </Box>
          </Box>
          {note}
          {isOpen ? (
            <Box flexDirection="column" paddingLeft={INDENT * 2}>
              {task.detail ? <Text dimColor>{hl(task.detail)}</Text> : null}
              {(task.steps ?? []).map(step => {
                const m = MARK[step.status] ?? { sign: '?' }
                return (
                  <Text color={m.color}>
                    {`${m.sign} `}
                    {hl(step.title)}
                  </Text>
                )
              })}
            </Box>
          ) : null}
        </Box>
      )
    }

    const doneRow = (sessionId: string, task: Task) => (
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text dimColor>
          {hlTitle(
            t(task.status === 'done' ? 'pane.doneItem' : 'pane.skippedItem', {
              title: task.title,
              when: formatTime(task.doneAt ?? task.updatedAt, nowMs),
            }),
            task.title,
          )}
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

    // The session's subagents: the running ones in their own section, each folding open to its steps
    // (status + note — a step's own estimate) beside its progress, run time and estimate; the finished
    // ones in a second section, folded by default.
    const agentsBlock = (file: SessionFile) => {
      const agents = file.agents ?? []
      const id = file.session.id
      const running = agents.filter(a => a.endedAt === null)
      if (running.length === 0) return null
      const runKey = `agents:${id}`
      const runOpen = folded[runKey] ?? true
      const agentRow = (a: (typeof agents)[number]) => {
        const key = `agent:${id}:${a.id}`
        const isOpen = folded[key] ?? true
        const closed = a.tasks.filter(x => isClosed(x.status)).length
        const steps =
          a.tasks.length > 0
            ? t('pane.agentSteps', {
                bar: progressBar(closed, a.tasks.length),
                done: closed,
                total: a.tasks.length,
              })
            : ''
        const ranS = Math.max(0, (nowMs - Date.parse(a.startedAt)) / 1000)
        const elapsed = Number.isFinite(ranS) ? t('pane.agentElapsed', { d: formatDuration(ranS) }) : ''
        const eta = typeof a.etaMin === 'number' ? t('pane.agentEta', { min: a.etaMin }) : ''
        return (
          <Box flexDirection="column">
            <Box
              key={`row:${key}`}
              flexDirection="row"
              justifyContent="space-between"
              gap={2}
              hover={ROW_HOVER}
            >
              <Button
                key={key}
                label={t('pane.agentFold', { fold: isOpen ? '▾' : '▸', label: a.label })}
                plain
                onPress={() => void toggle($, key, isOpen)}
              />
              <Text dimColor>{`${steps}${elapsed}${eta}`.replace(/^ · /, '')}</Text>
            </Box>
            {isOpen ? (
              <Box flexDirection="column" paddingLeft={INDENT}>
                {a.now ? <Text dimColor>{a.now}</Text> : null}
                {a.tasks.map(step => {
                  const m = MARK[step.status] ?? { sign: '?' }
                  return (
                    <Box flexDirection="column">
                      <Text color={m.color}>{`${m.sign} ${step.title}`}</Text>
                      {step.note ? (
                        <Box paddingLeft={INDENT}>
                          <Text dimColor>{step.note}</Text>
                        </Box>
                      ) : null}
                    </Box>
                  )
                })}
              </Box>
            ) : null}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Button
            key={runKey}
            label={t('pane.agents', { fold: runOpen ? '▾' : '▸', running: running.length })}
            plain
            onPress={() => void toggle($, runKey, runOpen)}
          />
          {runOpen ? (
            <Box flexDirection="column" paddingLeft={INDENT}>
              {running.map(agentRow)}
            </Box>
          ) : null}
        </Box>
      )
    }

    // A session's finished subagents, under its Done: one folded "Agents" heading after the done tasks.
    const finishedAgentsBlock = (file: SessionFile) => {
      const id = file.session.id
      const finished = (file.agents ?? []).filter(a => a.endedAt !== null)
      if (finished.length === 0) return null
      const key = `doneagents:${id}`
      const isOpen = folded[key] ?? false
      const olderKey = `agentsolder:${id}`
      const isOlderOpen = folded[olderKey] ?? false
      const capped = capNewest(finished, AGENTS_SHOWN, a => a.endedAt ?? a.updatedAt)
      const listed = isOlderOpen ? finished : capped.shown
      return (
        <Box flexDirection="column">
          <Button
            key={key}
            label={t('pane.agentsFinished', { fold: isOpen ? '▾' : '▸', count: finished.length })}
            plain
            dimColor
            onPress={() => void toggle($, key, isOpen)}
          />
          {isOpen ? (
            <Box flexDirection="column" paddingLeft={INDENT}>
              {listed.map(a => (
                <Text dimColor>
                  {t('pane.agentFinished', {
                    label: a.label,
                    when: formatTime(a.endedAt ?? a.updatedAt, nowMs),
                  })}
                </Text>
              ))}
              {capped.older > 0 ? (
                <Button
                  key={olderKey}
                  label={t('pane.olderDone', { fold: isOlderOpen ? '▾' : '▸', count: capped.older })}
                  plain
                  dimColor
                  onPress={() => void toggle($, olderKey, isOlderOpen)}
                />
              ) : null}
            </Box>
          ) : null}
        </Box>
      )
    }

    const group = (file: SessionFile) => {
      const id = file.session.id
      const ended = file.session.endedAt
      const shown = visibleTasks(
        file,
        all[id]?.sidecar?.entries ?? [],
        all[id]?.sidecar?.cancelled ?? [],
      ).filter(x => matchesTask(x, query))
      const open = sortTasks(
        shown.filter(x => !isClosed(x.status)),
        by,
      )
      const done = sortTasks(
        shown.filter(x => isClosed(x.status)),
        by === 'status' || by === 'plan' ? 'done' : by,
      )
      // Tasks of several repos group by repo (in plan order, open and done alike).
      // Each list groups by repo on its own, and only once its tasks span more than one repo: open
      // tasks in one repo stay flat even when Done holds another.
      const repos = groupByRepo(
        sortTasks(
          shown.filter(x => !isClosed(x.status)),
          by === 'status' ? 'plan' : by,
        ),
        file.session.project,
      )
      // An open Done lists the newest DONE_SHOWN; the rest fold behind "N older" (capNewest).
      const doneOlderKey = `doneolder:${id}`
      const isDoneOlderOpen = folded[doneOlderKey] ?? false
      const doneCapped = capNewest(done, DONE_SHOWN, x => x.doneAt ?? x.updatedAt)
      const doneListed = isDoneOlderOpen ? done : doneCapped.shown
      const doneRepos = groupByRepo(doneListed, file.session.project)
      const finishedCount = (file.agents ?? []).filter(a => a.endedAt !== null).length
      const groupKey = `group:${id}`
      const doneKey = `done:${id}`
      const isOpen = folded[groupKey] ?? ended === null
      const isDoneOpen = folded[doneKey] ?? false
      const name = id === me ? t('pane.thisSession', { project: sessionName(file) }) : sessionName(file)
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
              {repos.length > 1
                ? repos.map(({ repo, tasks }) => {
                    const repoKey = `repo:${id}:${repo}`
                    const isRepoOpen = folded[repoKey] ?? true
                    const openHere = sortTasks(
                      tasks.filter(x => !isClosed(x.status)),
                      by,
                    )
                    if (openHere.length === 0) return null
                    return (
                      <Box flexDirection="column">
                        <Button
                          key={repoKey}
                          label={t('pane.repoGroup', {
                            fold: isRepoOpen ? '▾' : '▸',
                            repo,
                            open: openHere.length,
                          })}
                          plain
                          onPress={() => void toggle($, repoKey, isRepoOpen)}
                        />
                        {isRepoOpen ? (
                          <Box flexDirection="column" paddingLeft={INDENT}>
                            {openHere.map(task => taskRow(id, task))}
                          </Box>
                        ) : null}
                      </Box>
                    )
                  })
                : open.map(task => taskRow(id, task))}
              {agentsBlock(file)}
              {done.length + finishedCount > 0 ? (
                <Box flexDirection="row" justifyContent="space-between" gap={2}>
                  <Button
                    key={doneKey}
                    label={t('pane.doneSection', {
                      fold: isDoneOpen ? '▾' : '▸',
                      count: done.length + finishedCount,
                    })}
                    plain
                    dimColor
                    onPress={() => void toggle($, doneKey, isDoneOpen)}
                  />
                  {/* Only while Done is open: nothing is cleared that the person cannot see. */}
                  {isDoneOpen && done.length > 0 ? (
                    <Button
                      key={`clear:${id}`}
                      label={t('pane.clearAll')}
                      plain
                      dimColor
                      onPress={() => void dismiss($, options, id, done)}
                    />
                  ) : null}
                </Box>
              ) : null}
              {isDoneOpen ? (
                <Box flexDirection="column" paddingLeft={INDENT}>
                  {doneRepos.length > 1
                    ? doneRepos.map(({ repo, tasks }) => {
                        const repoKey = `donerepo:${id}:${repo}`
                        const isRepoOpen = folded[repoKey] ?? true
                        return (
                          <Box flexDirection="column">
                            <Button
                              key={repoKey}
                              label={t('pane.repoDoneGroup', {
                                fold: isRepoOpen ? '▾' : '▸',
                                repo,
                                done: tasks.length,
                              })}
                              plain
                              dimColor
                              onPress={() => void toggle($, repoKey, isRepoOpen)}
                            />
                            {isRepoOpen ? (
                              <Box flexDirection="column" paddingLeft={INDENT}>
                                {tasks.map(task => doneRow(id, task))}
                              </Box>
                            ) : null}
                          </Box>
                        )
                      })
                    : doneListed.map(task => doneRow(id, task))}
                  {doneCapped.older > 0 ? (
                    <Button
                      key={doneOlderKey}
                      label={t('pane.olderDone', {
                        fold: isDoneOlderOpen ? '▾' : '▸',
                        count: doneCapped.older,
                      })}
                      plain
                      dimColor
                      onPress={() => void toggle($, doneOlderKey, isDoneOlderOpen)}
                    />
                  ) : null}
                  {finishedAgentsBlock(file)}
                </Box>
              ) : null}
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text dimColor>
            {`${t('pane.updated', { when: formatTime(newest.updatedAt, nowMs), project: sessionName(newest) })} · `}
            {nowMs - lastCheck > STALE_AFTER_MS ? (
              <Text color="yellow">{t('pane.checkedStale', { when: formatClock(lastCheck) })}</Text>
            ) : (
              t('pane.checked', { when: formatClock(lastCheck) })
            )}
          </Text>
          {/* The corner: this copy's version, and a newer release with a link to its notes. */}
          <Box flexDirection="row" gap={1}>
            {release && version && isNewer(release.version, version) ? (
              <Box flexDirection="row">
                <Text color="yellow">{t('pane.newerVersion', { version: release.version })}</Text>
                {openLink(release.url)}
              </Box>
            ) : null}
            {version ? <Text dimColor>{t('pane.version', { version })}</Text> : null}
          </Box>
        </Box>
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
                  <Text>{t('pane.nowItem', { project: sessionName(f), now: f.now ?? '' })}</Text>
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
            >
              <Text>{t('pane.pipelinesTitle', sectionParts)}</Text>
              {/* What is running now stands out, even with the section folded. */}
              <Text color={sectionParts.watching > 0 ? 'yellow' : undefined} bold={sectionParts.watching > 0}>
                {t('pane.pipelinesWatching', sectionParts)}
              </Text>
              <Text>{t('pane.pipelinesTally', sectionParts)}</Text>
            </Button>
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
          <Input
            key="filter"
            placeholder={t('pane.filter')}
            value={query}
            onInput={value => void update($, filtering, () => value)}
            onSubmit={value => void update($, filtering, () => value)}
          />
          <Button
            key="sort"
            label={t('pane.sort', { by: t(`sort.${by}`) })}
            plain
            dimColor
            onPress={() => void cycleSort($, options)}
          />
        </Box>
        <Box flexDirection="column" paddingLeft={INDENT}>
          {/* While filtering, a session with no matching task steps aside. */}
          {ordered
            .filter(
              f =>
                !query.trim() ||
                visibleTasks(
                  f,
                  all[f.session.id]?.sidecar?.entries ?? [],
                  all[f.session.id]?.sidecar?.cancelled ?? [],
                ).some(x => matchesTask(x, query)),
            )
            .map(group)}
        </Box>
      </Box>
    )
  })
}
