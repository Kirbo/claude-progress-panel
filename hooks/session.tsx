// What this session does between its hooks: the folder scan, the tool's updates, its subagents,
// its switches, the automatic Needs-you items, watching pushes, the doctor, and the pane's presses.

import type { EngineInterface, PluginOptions } from 'claude-code'
import type { Loaded, PipelineProvider } from '../types'
import { ciFiles, remembered, repoKey, withVerdict } from './cimemory'
import type { Check } from './doctor'
import { classifyCliError, classifyGitError, formatChecks } from './doctor'
import { fields } from './events'
import { ghApi, glabApi, pollPipelines, runCli, teaApi } from './forge'
import { forgeMatches, parseRemote } from './forges'
import { deleteFile, processAlive } from './host'
import { t, tn } from './i18n'
import type { SessionFile, Task, UpdateInput } from './model'
import {
  agentHasTask,
  applyAgentUpdate,
  applyUpdate,
  autoLinkTarget,
  dismissAgents,
  dropReplacedAutoTasks,
  endDeadSession,
  isBlank,
  isClosed,
  isGenericPermission,
  isSessionId,
  linkedAgent,
  linkPushedPipeline,
  listSignature,
  markUnconfirmed,
  mergeScan,
  needsLivenessCheck,
  noticeTool,
  parseSessionFile,
  parseSidecar,
  pickedUp,
  pruneDone,
  queueForAgent,
  reopenAgent,
  repoFromCommonDir,
  staleTasks,
  syncAgents,
  timeLeft,
  toolCallSummary,
  trackedByPipeline,
  untouchedDoing,
  withAgentActivity,
  withAgentRun,
  withAutoTask,
} from './model'
import { baseName } from './paths'
import type { WatchInput } from './pipelines'
import { applyWatch, oneLine } from './pipelines'
import { ciProvider, parsePushes, pushedRef, resolvePath } from './push'
import { NUMBER_DEFAULTS } from './settings'
import {
  ACTIVITY_EVERY_MS,
  agentActivityAt,
  agentBackground,
  agentCalls,
  agentRepoAsked,
  agentRunNoted,
  DAY_MS,
  finishedLinks,
  isOn,
  livenessAskedAt,
  optionNumber,
  optionString,
  PANE,
  pendingCall,
  pendingNotes,
  promptFed,
  RELEASE_CHECK_MS,
  RELEASE_KEY,
  readSessions,
  ruleText,
  SIDECAR,
  SUBAGENT_RULE,
  self,
  staleTold,
  subagentRuleSent,
  switches,
  TOOL_ID,
  takeFinishedLinks,
  takeRemovalNotice,
  toldNoCi,
  updateChecked,
  updateFolds,
  updateReleasing,
  updateSessions,
} from './state'
import type { Sidecar } from './store'
import {
  exclusive,
  forgetSession,
  hasReported,
  nowIso,
  ownFile,
  progressDir,
  readCiMemory,
  readOwnPlain,
  save,
  updateCiMemory,
} from './store'
import type { Feature } from './toggles'
import { FEATURES, netChange, withToggle } from './toggles'
import { latestReleaseUrl, parseLatestRelease } from './update'

export function noteAgentBackground(e: unknown): void {
  const call = fields(e)
  const task = fields(call.tool_response).backgroundTaskId
  if (typeof call.agent_id !== 'string' || !call.agent_id || typeof task !== 'string' || !task) return
  const set = agentBackground.get(call.agent_id) ?? new Set<string>()
  set.add(task)
  agentBackground.set(call.agent_id, set)
}

export const TASK_STALE_AFTER_MS = 20 * 60_000

export const UNTOUCHED_AFTER_MS = 10 * 60_000

// Something live tracks the task: its pipeline still runs, or its linked agent is still at work.
export function isTracked(file: SessionFile, task: Task): boolean {
  if (trackedByPipeline(file, task)) return true
  const agent = task.agent ? linkedAgent(file, task) : undefined
  return agent !== undefined && agent.endedAt === null
}

export const minutesSince = (iso: string, nowMs: number) =>
  Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000))

// The person's prompt: a turn begins. Each open task untouched for 20 min, nothing tracking it, is
// asked about once in its current state — never again until it changes.
export async function staleNudges($: EngineInterface, options: PluginOptions): Promise<string[]> {
  self.turnStartMs = await $.clock.now()
  if (!isOn(options, 'reporting') || !isOn(options, 'tasks')) return []
  const dir = await progressDir($, options)
  if (!dir) return []
  const own = await ownFile($, dir)
  const stale = staleTasks(own, self.turnStartMs, TASK_STALE_AFTER_MS, staleTold, task =>
    isTracked(own, task),
  )
  return stale.map(task => {
    staleTold.set(task.id, task.updatedAt)
    return t('stale.nudge', {
      id: task.id,
      task: task.title,
      status: task.status,
      min: minutesSince(task.updatedAt, self.turnStartMs ?? 0),
    })
  })
}

// The end of the turn: a `doing` task untouched this turn (and for 10 min), nothing tracking it,
// stops the turn ONCE with the list — the agent updates each to its true state. The same list never
// stops twice (a second stop passes and the tasks are marked unconfirmed in the pane), so it can
// never loop.
export async function endOfTurnCheck(
  $: EngineInterface,
  options: PluginOptions,
  e: unknown,
): Promise<string | undefined> {
  if (self.turnStartMs === undefined || !isOn(options, 'reporting') || !isOn(options, 'tasks'))
    return undefined
  const dir = await progressDir($, options)
  if (!dir) return undefined
  const own = await ownFile($, dir)
  const nowMs = await $.clock.now()
  const list = untouchedDoing(own, self.turnStartMs, nowMs, UNTOUCHED_AFTER_MS, task => isTracked(own, task))
  if (list.length === 0) {
    self.lastBlocked = ''
    return undefined
  }
  const signature = listSignature(list)
  const again = fields(e).stop_hook_active === true
  if (again || signature === self.lastBlocked) {
    await exclusive(async () => {
      const file = await ownFile($, dir)
      const marked = markUnconfirmed(
        file,
        list.map(task => task.id),
      )
      if (marked !== file) await save($, dir, marked)
    })
    return undefined
  }
  self.lastBlocked = signature
  return t('stop.untouched', {
    list: list
      .map(task =>
        t('stop.untouchedLine', { id: task.id, task: task.title, min: minutesSince(task.updatedAt, nowMs) }),
      )
      .join('\n'),
  })
}

/** The net switch change owed to the agent, as notes; the told state moves to now. */
export function takeToggleNotes(): string[] {
  if (!self.toldSwitches || !self.togglesOptions) return []
  const { rule, notes } = netChange(self.toldSwitches, switches(self.togglesOptions))
  const options = self.togglesOptions
  self.toldSwitches = undefined
  if (rule) {
    self.ruleSent = true
    return [ruleText(options)]
  }
  return notes.map(k => t(k))
}

export function withPendingNotes<R extends { additionalContext?: string[] }>(result: R): R {
  pendingNotes.push(...takeToggleNotes())
  if (pendingNotes.length === 0) return result
  const notes = pendingNotes.splice(0)
  return { ...result, additionalContext: [...(result.additionalContext ?? []), ...notes] }
}

// The pane's open request: its id and title, plus the size the settings ask for — the sidebar's
// width beside a fullscreen transcript and the block's height above the prompt. Requests, not grants:
// Claude Code caps the width (45 % of the terminal) and a size the person dragged to wins. 0 = ask
// for none (Claude Code's own default).
export function paneArgs(options: PluginOptions): {
  id: string
  title: string
  columns?: number
  rows?: number
} {
  const columns = optionNumber(options, 'paneColumns', NUMBER_DEFAULTS.paneColumns)
  const rows = optionNumber(options, 'paneRows', NUMBER_DEFAULTS.paneRows)
  return {
    id: PANE,
    title: t('pane.title'),
    ...(columns > 0 ? { columns } : {}),
    ...(rows > 0 ? { rows } : {}),
  }
}

export async function ownManifest(
  $: EngineInterface,
): Promise<{ version: string; repository: string; defaults: Record<string, string> }> {
  if (!self.manifest) {
    const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => undefined)
    let raw: { version?: unknown; repository?: unknown; userConfig?: unknown } = {}
    try {
      raw = text === undefined ? {} : JSON.parse(text)
    } catch {
      raw = {}
    }
    // Each setting's built-in default (the Settings view draws a changed one bold).
    const defaults: Record<string, string> = {}
    if (typeof raw.userConfig === 'object' && raw.userConfig !== null)
      for (const [field, spec] of Object.entries(raw.userConfig as Record<string, { default?: unknown }>))
        defaults[field] = spec?.default === undefined ? '' : String(spec.default)
    self.manifest = {
      version: typeof raw.version === 'string' ? raw.version : '',
      repository: typeof raw.repository === 'string' ? raw.repository : '',
      defaults,
    }
  }
  return self.manifest
}

// The newest release: the shared answer when it is under 6 h old, else one look at GitLab (a
// failure keeps the last answer). Never with nonessential traffic turned off.
export async function checkRelease($: EngineInterface): Promise<void> {
  type Cached = { version: string; url: string; checkedAtMs: number }
  const cached = (await $.store.get(RELEASE_KEY)) as Cached | undefined
  const known =
    cached && typeof cached.version === 'string' ? { version: cached.version, url: cached.url } : null
  if (!self.settings.updateCheck || (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))) {
    await updateReleasing($, () => known)
    return
  }
  const nowMs = await $.clock.now()
  if (cached && nowMs - cached.checkedAtMs < RELEASE_CHECK_MS) {
    await updateReleasing($, () => known)
    return
  }
  const url = latestReleaseUrl((await ownManifest($)).repository)
  const answer = url ? await $.http.fetch(url).catch(() => undefined) : undefined
  const latest = answer?.ok ? parseLatestRelease(answer.text) : undefined
  if (latest) await $.store.set(RELEASE_KEY, { ...latest, checkedAtMs: nowMs } satisfies Cached)
  await updateReleasing($, () => latest ?? known)
}

/** One line for a progress_update call in the transcript: its `now`, how many tasks, watches. */
export function callSummary(input: ToolInput | undefined): string {
  const parts = [
    input?.now ?? '',
    input?.tasks?.length ? tn('call.tasks', input.tasks.length) : '',
    input?.watch?.length ? tn('call.watching', input.watch.length) : '',
    input?.needsYou?.length ? tn('call.asks', input.needsYou.length) : '',
  ].filter(Boolean)
  return t('call.summary', { what: parts.length ? parts.join(' · ') : t('call.updated') })
}

/** How the pane names a session: Claude Code's name for it, else its repo / folder. */
export function cutText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

export function sessionName(file: SessionFile): string {
  return file.session.title || file.session.project
}

export function liveNeeds(all: Loaded): { project: string; item: string; key: string }[] {
  return Object.values(all)
    .filter(s => s.file.session.endedAt === null)
    .sort((a, b) => Date.parse(b.file.updatedAt) - Date.parse(a.file.updatedAt))
    .flatMap(s =>
      [...s.file.needsYou, ...(s.file.autoNeeds ?? []).map(a => a.text)].map(item => ({
        project: sessionName(s.file),
        item,
        key: `${s.file.session.id}\u0000${item}`,
      })),
    )
}

// The status line, and a toast for each ask another session raised since the last look.
export async function announce($: EngineInterface, all: Loaded, me: string): Promise<void> {
  const needs = liveNeeds(all)
  // The status line names the ask itself (cut with "…"), never only a count.
  const first = needs[0]
  await $.ui.status(
    first
      ? t(needs.length === 1 ? 'status.needsYouOne' : 'status.needsYouMany', {
          count: needs.length,
          project: first.project,
          item: cutText(first.item, 60),
        })
      : undefined,
  )
  if (self.seenNeeds) {
    for (const n of needs) {
      if (!self.seenNeeds.has(n.key) && !n.key.startsWith(`${me}\u0000`) && self.settings.toastNeedsYou) {
        const text = t('toast.needsYou', { project: n.project, item: n.item })
        await $.ui.toast(text)
        if (self.settings.bell) await $.ui.notify(text, { title: t('pane.title') }).catch(() => undefined)
      }
    }
  }
  self.seenNeeds = new Set(needs.map(n => n.key))
}

export async function tick($: EngineInterface, options: PluginOptions): Promise<void> {
  if (self.scanning) return
  self.scanning = true
  try {
    await scan($, options)
  } finally {
    self.scanning = false
  }
}

export const LIVENESS_EVERY_MS = 60_000

// One refresh: list the folder, read what changed, apply retention, update the status line.
export async function scan($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  if (isOn(options, 'agents')) await syncOwnAgents($, dir)
  const entries = await $.fs.list(dir).catch(() => undefined)
  // A failed listing keeps what the pane knows; its `checked` stamp then ages into "stale".
  if (!entries) return
  const before = await readSessions($)
  const next: Loaded = {}
  const sidecars: Record<string, { mtimeMs: number } & Sidecar> = {}
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.name.endsWith(SIDECAR)) {
      const id = entry.name.slice(0, -SIDECAR.length)
      if (!isSessionId(id)) continue
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
    if (!isSessionId(id)) continue
    const known = before[id]
    if (known && known.mtimeMs === entry.mtimeMs) {
      next[id] = { mtimeMs: known.mtimeMs, file: known.file }
      continue
    }
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
    const file = text === undefined ? undefined : parseSessionFile(text)
    // Unreadable (e.g. caught mid-write): keep the last good copy, so the group neither flickers nor
    // re-announces its asks; the old mtime makes the next tick read it again.
    // A session's file is named by its id. One that names another id is not that session's file:
    // it is never shown, and nothing is written or deleted through the id it claims.
    if (file && file.session.id !== id) continue
    if (file) next[id] = { mtimeMs: entry.mtimeMs, file }
    else if (known) next[id] = { mtimeMs: known.mtimeMs, file: known.file }
  }
  for (const [id, sidecar] of Object.entries(sidecars)) {
    const known = next[id]
    if (known) next[id] = { ...known, sidecar }
  }
  await updateSessions($, current => mergeScan(before, current, next))

  const nowMs = await $.clock.now()
  const me = await $.session.id()
  const doneHours = optionNumber(options, 'autoClearDoneHours', NUMBER_DEFAULTS.autoClearDoneHours)
  const keepDays = optionNumber(options, 'keepEndedSessionsDays', NUMBER_DEFAULTS.keepEndedSessionsDays)
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
    if (ended === null) {
      // A session on this machine whose process is gone without `session.end` (a closed terminal,
      // a kill): ended as of its last write. Asked at most once a minute per session.
      if (!needsLivenessCheck(file, me, self.ownProcess?.host, nowMs)) continue
      const id = file.session.id
      if (nowMs - (livenessAskedAt.get(id) ?? 0) < LIVENESS_EVERY_MS) continue
      livenessAskedAt.set(id, nowMs)
      if ((await processAlive($, file.session.pid as number)) === false)
        await save($, dir, endDeadSession(file))
      continue
    }
    const pruned = pruneDone(file, doneHours, nowMs)
    if (pruned !== file) await save($, dir, pruned)
  }
  await announce($, await readSessions($), me)
  await updateChecked($, () => nowMs)
}

export function summarize(file: SessionFile, errors: readonly string[]): string {
  const lines = [t('tool.saved', { count: file.tasks.length })]
  for (const task of file.tasks) lines.push(`${task.id} ${task.status} ${task.title}`)
  if (errors.length > 0) lines.push(t('tool.problems'), ...errors)
  return lines.join('\n')
}

export type ToolInput = UpdateInput & {
  watch?: WatchInput[]
  unwatch?: string[]
  clearAgents?: boolean
  dismissAgents?: string[]
}

export async function runUpdate(
  $: EngineInterface,
  options: PluginOptions,
  input: ToolInput,
): Promise<string> {
  let agentClearing: { dismissed: string[]; running: string[] } = { dismissed: [], running: [] }
  const dir = await progressDir($, options)
  if (!dir) return t('tool.noDir')
  const at = await nowIso($)
  // A watch of the session's own repo takes its host from the `origin` remote.
  const remote = input.watch?.length
    ? parseRemote((await $.session.repo().catch(() => null))?.remote)
    : undefined
  const { updated, watched, file } = await exclusive(async () => {
    const applied = applyUpdate(await ownFile($, dir), input, at)
    // Agent rows the coordinator clears (as the pane's ✕ does): never a running one.
    const cleared =
      input.clearAgents || input.dismissAgents?.length
        ? dismissAgents(applied.file, input.clearAgents ? true : (input.dismissAgents ?? []), at)
        : { file: applied.file, dismissed: [], running: [] }
    agentClearing = cleared
    // A task of its own linked to an agent replaces the plugin's stand-in for it.
    const updated = { ...applied, file: dropReplacedAutoTasks(cleared.file) }
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
  await announce($, await readSessions($), file.session.id)
  const added = watched.list.filter(p => !(updated.file.pipelines ?? []).some(old => old.key === p.key))
  if (added.length > 0) await pollPipelines($, options)
  const notice = [takeRemovalNotice(), ...takeFinishedLinks()].filter(Boolean).join('\n')
  const clearedLines = [
    agentClearing.dismissed.length
      ? t('tool.agentsCleared', { list: agentClearing.dismissed.join(', ') })
      : '',
    agentClearing.running.length
      ? t('tool.agentsStillRunning', { list: agentClearing.running.join(', ') })
      : '',
  ].filter(Boolean)
  const agents = [...clearedLines, agentsLine(file)].filter(Boolean).join('\n') || undefined
  const text = `${notice ? `${notice}\n` : ''}${summarize(file, [...updated.errors, ...watched.errors])}${agents ? `\n${agents}` : ''}`
  return added.length > 0
    ? `${text}\n${t('tool.watching', { keys: added.map(p => p.key).join(', ') })}`
    : text
}

// A subagent's progress_update: upserted into its entry, labelled by its Agent call's description.
export async function runAgentUpdate(
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
    const r = applyAgentUpdate(pickedUp(await ownFile($, dir), id), { id, label }, input, at)
    // Still on no task of the session: a stand-in task, linked to it (done stays the coordinator's).
    const file =
      isOn(options, 'tasks') && !agentHasTask(r.file, { id, label })
        ? withAutoTask(r.file, label, at)
        : r.file
    await save($, dir, file)
    return { errors: r.errors, entry: file.agents?.find(a => a.id === id) }
  })
  const steps = entry ? entry.tasks : []
  const done = steps.filter(x => isClosed(x.status)).length
  return [t('tool.agentSaved', { done, total: steps.length }), ...errors].join('\n')
}

// This session's subagents into its own file, so one that never reports (no progress tool, e.g. a
// read-only reviewer) still shows under Agents while it runs. Written only when something changed.
export async function syncOwnAgents($: EngineInterface, dir: string): Promise<void> {
  // A failed list call is no answer (nothing ends on it); an EMPTY list is one — after a reload, or
  // once every agent finished, and the agents still marked running end once idle (`syncAgents`).
  const listed = await $.agent.list().catch(() => null)
  if (listed === null) return
  const at = await nowIso($)
  await exclusive(async () => {
    const own = await ownFile($, dir)
    const synced = syncAgents(own, listed, at)
    if (synced !== own) await save($, dir, synced)
  })
}

// One line per running subagent for the coordinator's answer: label, steps, estimate.
export function agentsLine(file: SessionFile): string | undefined {
  const running = (file.agents ?? []).filter(a => a.endedAt === null)
  if (running.length === 0) return undefined
  const parts = running.map(a => {
    const done = a.tasks.filter(x => isClosed(x.status)).length
    const steps = a.tasks.length > 0 ? ` ${done}/${a.tasks.length}` : ''
    const left = timeLeft(a.tasks, a.startedAt, a.etaMin)
    const eta = left ? t(left.guess ? 'agent.etaGuess' : 'agent.eta', { min: left.min }) : ''
    return `${a.label}${steps}${eta}`
  })
  return t('tool.agents', { list: parts.join('; ') })
}

// A background step nobody awaits (a timer tick, the startup lookups): one that fails — or outlives
// its session, its state gone — is dropped; the next tick tries again. Never an unhandled rejection.
export function detached(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

// With a prompt: the reporting rule itself, once, when no composed system prompt carried it (see
// `ruleComposed`); then, while this session has reported nothing yet, a one-line reminder — so a
// session the plugin joined mid-way starts reporting without being told to. Short and steady, and
// gone with the first report.
export async function withReportingNudge<R extends { additionalContext?: string[] }>(
  $: EngineInterface,
  options: PluginOptions,
  result: R,
): Promise<R> {
  if (!isOn(options, 'reporting')) return result
  const notes: string[] = []
  if (!self.ruleComposed && !self.ruleSent) {
    // A session seen from its start: the prompt composed for its first request carries the rule —
    // sending it here too would hand it over twice. Once only; `takeDeferredRule` is the safety net.
    if (self.freshStart && !self.ruleDeferred) self.ruleDeferred = true
    else {
      self.ruleSent = true
      notes.push(ruleText(options))
    }
  }
  if (notes.length === 0 && !(await hasReported($, options))) notes.push(t('prompt.nudge'))
  return notes.length
    ? { ...result, additionalContext: [...(result.additionalContext ?? []), ...notes] }
    : result
}

// The subagent rule rides the Agent call's own prompt, so a subagent knows it before its first step
// (a short one, its calls batched in one turn, used to finish before a later note reached it). Not
// a fork (it inherits this session's context, rule included), not a prompt that already holds it,
// not while reporting or agents are off.
export function feedAgentPrompt(
  options: PluginOptions,
  e: { prompt?: unknown; description?: unknown; subagent_type?: unknown },
): string | undefined {
  if (!isOn(options, 'agents') || e.subagent_type === 'fork') return undefined
  if (typeof e.prompt !== 'string') return undefined
  const rule = t(SUBAGENT_RULE[self.settings.effort])
  if (e.prompt.includes(rule)) return undefined
  if (typeof e.description === 'string' && e.description) promptFed.add(e.description)
  return `${e.prompt}\n\n${rule}`
}

// A subagent's tool call: an entry that ended (or waits) is running again — a resumed agent. A plain
// read first, so the common case (it runs) writes nothing.
export async function reopenIfActive(
  $: EngineInterface,
  options: PluginOptions,
  agentId: string,
): Promise<void> {
  const plain = await readOwnPlain($, options)
  if (plain === 'nowhere') return
  const entry = plain?.agents?.find(a => a.id === agentId)
  if (!entry || (entry.endedAt === null && !entry.waiting && !entry.queued?.length)) return
  const dir = await progressDir($, options)
  if (!dir) return
  const at = await nowIso($)
  await exclusive(async () => {
    const own = await ownFile($, dir)
    const next = pickedUp(reopenAgent(own, agentId, at), agentId)
    if (next !== own) await save($, dir, next)
  })
}

// A subagent's model request (`turn.step`): what it actually runs on — the model the engine resolved
// for it (its own, its type's, the session's subagent default or the parent's) and the effort asked
// for — goes on its entry, so the pane can say it. Only a change is written; an agent with no entry
// yet (it starts before the list scan or its first report adds it) is noted at a later step.
export async function noteAgentRun($: EngineInterface, options: PluginOptions, e: unknown): Promise<void> {
  if (!isOn(options, 'agents')) return
  const step = fields(e)
  const id = step.agentId
  const model = step.model
  if (typeof id !== 'string' || !id || typeof model !== 'string' || !model) return
  const effort = typeof step.effort === 'string' || typeof step.effort === 'number' ? step.effort : undefined
  const sig = `${model}|${effort ?? ''}`
  if (agentRunNoted.get(id) === sig) return
  const plain = await readOwnPlain($, options)
  if (plain === 'nowhere' || !plain?.agents?.some(a => a.id === id)) return
  const dir = await progressDir($, options)
  if (!dir) return
  await exclusive(async () => {
    const own = await ownFile($, dir)
    const next = withAgentRun(own, id, model, effort)
    if (next !== own) await save($, dir, next)
    if (next.agents?.some(a => a.id === id)) agentRunNoted.set(id, sig)
  })
}

// A subagent's tool call (PostToolUse): its latest call, in one line, and its running count go on its
// entry — the second level of a row whose agent reports no steps of its own (an agent type without
// the progress tool, or one that has not reported yet). Every call is counted; the entry is written
// at most every ACTIVITY_EVERY_MS per agent. The agent's own progress reports are not "activity".
export async function noteAgentActivity(
  $: EngineInterface,
  options: PluginOptions,
  e: unknown,
): Promise<void> {
  if (!isOn(options, 'agents')) return
  const call = fields(e)
  const id = call.agent_id
  const tool = call.tool_name
  if (typeof id !== 'string' || !id || typeof tool !== 'string' || !tool || tool === TOOL_ID) return
  const calls = (agentCalls.get(id) ?? 0) + 1
  agentCalls.set(id, calls)
  const now = await $.clock.now()
  const last = agentActivityAt.get(id)
  if (last !== undefined && now - last < ACTIVITY_EVERY_MS) return
  const plain = await readOwnPlain($, options)
  if (plain === 'nowhere' || !plain?.agents?.some(a => a.id === id)) return
  const dir = await progressDir($, options)
  if (!dir) return
  const input = call.tool_input
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const what = toolCallSummary(tool, args, 60)
  agentActivityAt.set(id, now)
  await exclusive(async () => {
    const own = await ownFile($, dir)
    const next = withAgentActivity(own, id, what, calls)
    if (next !== own) await save($, dir, next)
  })
}

export async function noteAgentRepo($: EngineInterface, options: PluginOptions, e: unknown): Promise<void> {
  const call = fields(e)
  const id = call.agent_id
  if (typeof id !== 'string' || !id || typeof call.cwd !== 'string' || !call.cwd) return
  if (agentRepoAsked.has(id)) return
  agentRepoAsked.add(id)
  const dir = await progressDir($, options)
  if (!dir) return
  const common = (
    await runCli($, ['git', '-C', call.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).text
  const repo = common ? repoFromCommonDir(common) : undefined
  if (!repo) return
  await exclusive(async () => {
    const own = await ownFile($, dir)
    const agent = own.agents?.find(a => a.id === id)
    if (!agent || agent.repo === repo) return
    await save($, dir, {
      ...own,
      agents: (own.agents ?? []).map(a => (a.id === id ? { ...a, repo } : a)),
    })
  })
}

// A main-loop SendMessage to one of this session's agents: its summary (or the message's first line)
// queued on the agent's entry. Another session or a teammate is not this pane's to show.
export async function queueMessage($: EngineInterface, options: PluginOptions, e: unknown): Promise<void> {
  const call = fields(e)
  if (call.agentId || typeof call.to !== 'string' || !isOn(options, 'agents')) return
  const text = oneLine(
    typeof call.summary === 'string' && call.summary.trim()
      ? call.summary
      : typeof call.message === 'string'
        ? call.message
        : '',
  )
  if (!text) return
  const dir = await progressDir($, options)
  if (!dir) return
  const at = await nowIso($)
  await exclusive(async () => {
    const own = await ownFile($, dir)
    const queued = queueForAgent(own, call.to as string, text, at)
    if (queued !== own) await save($, dir, queued)
  })
}

// An Agent call whose description names exactly one open `doing` task (none linked yet): that task
// is linked to it, so the pane shows the agent's progress there. Ambiguous → nothing.
export async function autoLink(
  $: EngineInterface,
  options: PluginOptions,
  description: unknown,
): Promise<void> {
  if (typeof description !== 'string' || !isOn(options, 'agents') || !isOn(options, 'tasks')) return
  const dir = await progressDir($, options)
  if (!dir) return
  await exclusive(async () => {
    const own = await ownFile($, dir)
    if (agentHasTask(own, { id: '', label: description })) return
    const task = autoLinkTarget(own, description)
    if (!task) {
      // Working on no task of the session: the coordinator is told once to link the one it serves.
      finishedLinks.push(t('notice.agentUnlinked', { agent: description }))
      return
    }
    await save($, dir, {
      ...own,
      tasks: own.tasks.map(x => (x.id === task.id ? { ...x, agent: description } : x)),
    })
  })
}

// A subagent's system prompt never carries the reporting rule (`prompt.compose` builds only the
// session's): SubagentStart hands it the subagent part of the rule as it starts and, where that
// event never fired (an engine without it), its FIRST tool call's result carries it — once per
// agent, and never to one that already reported.
export async function withSubagentRule<R extends { additionalContext?: string[] }>(
  $: EngineInterface,
  options: PluginOptions,
  agentId: string,
  result: R,
): Promise<R> {
  if (subagentRuleSent.has(agentId) || !isOn(options, 'agents')) return result
  subagentRuleSent.add(agentId)
  // Its prompt already carried the rule (the Agent call was fed it): no second copy.
  if (promptFed.size > 0) {
    const listed = await $.agent.list().catch(() => [])
    const description = listed.find(a => a.id === agentId)?.description
    if (description && promptFed.has(description)) return result
  }
  const own = await readOwnPlain($, options)
  if (own === 'nowhere') return result
  const entry = own?.agents?.find(a => a.id === agentId)
  if (entry && (entry.now || entry.tasks.length > 0)) return result
  return {
    ...result,
    additionalContext: [...(result.additionalContext ?? []), t(SUBAGENT_RULE[self.settings.effort])],
  }
}

// A `git push` the agent ran (main loop or subagent) watches the pipeline it starts, without the
// agent asking: the repo's CI read off its files, the forge host and project off the pushed remote,
// the sha off the pushed ref. Only a push that landed: a failed call, a dry run or a delete watches
// nothing, and a branch whose remote-tracking ref is not the pushed sha (rejected) neither. The
// watch goes through the same `applyWatch` as the tool's, so one the agent also sends is the same
// key — never a second row.
export async function watchPushes(
  $: EngineInterface,
  options: PluginOptions,
  e: unknown,
  notes: string[],
): Promise<string[]> {
  const call = fields(e)
  const command = fields(call.tool_input).command
  if (call.tool_name !== 'Bash' || typeof command !== 'string') return []
  const response = fields(call.tool_response)
  if (response.interrupted === true) return []
  for (const code of [response.exitCode, response.returnCode])
    if (typeof code === 'number' && code !== 0) return []
  const pushes = parsePushes(command)
  if (pushes.length === 0) return []
  const dir = await progressDir($, options)
  if (!dir) return []
  const base = typeof call.cwd === 'string' && call.cwd ? call.cwd : await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? undefined
  const watches: (WatchInput & { repo: string })[] = []
  for (const push of pushes)
    watches.push(...(await pushWatches($, options, resolvePath(base, push.dir, home), push, notes)))
  if (watches.length === 0) return []
  const at = await nowIso($)
  const { added, file } = await exclusive(async () => {
    const own = await ownFile($, dir)
    const before = own.pipelines ?? []
    const watched = applyWatch(before, watches, [], at)
    const added = watched.list.filter(p => !before.some(old => old.key === p.key))
    let file: SessionFile = { ...own, pipelines: watched.list }
    // Each new pipeline links itself to the one `doing` task of its repo: that task now closes when
    // the pipeline does (never kept open by hand to wait for CI).
    if (isOn(options, 'tasks'))
      for (const p of added) {
        const repo = watches.find(w => w.sha === p.sha && w.project === p.project)?.repo
        if (!repo) continue
        const linked = linkPushedPipeline(file, p.key, repo, at)
        file = linked.file
        if (linked.linked) notes.push(t('push.linkedTask', { task: linked.linked.title, key: p.key }))
      }
    if (added.length > 0) await save($, dir, file)
    return { added, file }
  })
  if (added.length === 0) return []
  await announce($, await readSessions($), file.session.id)
  await pollPipelines($, options)
  return added.map(p => p.key)
}

// The CI a repository runs, read off its files (else the person's custom command, else none) —
// the one detection the auto-watch and `/progress doctor` share.
export async function repoCi(
  $: EngineInterface,
  options: PluginOptions,
  root: string,
): Promise<PipelineProvider | undefined> {
  return (await repoCiFiles($, options, root)).provider
}

// The repo's CI files (stats and one listing per kind — cheap enough for every push) and the CI
// they name, plus the files as one string the CI memory compares.
export async function repoCiFiles(
  $: EngineInterface,
  options: PluginOptions,
  root: string,
): Promise<{ provider: PipelineProvider | undefined; files: string }> {
  const has = async (path: string) =>
    (await $.fs.stat(`${root}/${path}`).catch(() => undefined)) !== undefined
  const workflows = async (path: string) =>
    ((await $.fs.list(`${root}/${path}`).catch(() => undefined)) ?? []).some(f => /\.ya?ml$/i.test(f.name))
  const found = {
    gitlab: await has('.gitlab-ci.yml'),
    github: await workflows('.github/workflows'),
    gitea: (await workflows('.gitea/workflows')) || (await workflows('.forgejo/workflows')),
  }
  const hasCommand = optionString(options, 'ciCommand').trim() !== ''
  return { provider: ciProvider(found, hasCommand), files: ciFiles(found, hasCommand) }
}

// One of this session's switches set (or, with `undefined`, reset to its default): kept in its own
// file (a reload or a resume keeps it), and the agent told once — a note for what changed, the whole
// rule when reporting comes back on.
export async function setToggle(
  $: EngineInterface,
  options: PluginOptions,
  feature: Feature,
  value: boolean | undefined,
): Promise<void> {
  const before = switches(options)
  self.sessionToggles = withToggle(self.sessionToggles, feature, value)
  const after = switches(options)
  const dir = await progressDir($, options)
  if (dir)
    await exclusive(async () => {
      const own = await ownFile($, dir)
      await save($, dir, { ...own, toggles: self.sessionToggles })
    })
  if (before[feature] === after[feature]) return
  // What the agent was told is the state before the first change since its last hand-over: the
  // note is worked out then, from the NET change (`netChange`), never one per press.
  self.toldSwitches ??= before
  self.togglesOptions = options
  if (feature === 'reporting' && after.reporting) void $.ui.open(paneArgs(options))
}

export function notePendingCall(e: unknown): { loop: string; token: object } | undefined {
  const call = e as Record<string, unknown> & { tool?: unknown; tool_use_id?: unknown; agentId?: unknown }
  if (typeof call.tool !== 'string') return undefined
  const loop = typeof call.agentId === 'string' ? call.agentId : ''
  const { tool, tool_use_id, agentId: _a, ...args } = call
  const token = {}
  pendingCall.set(loop, {
    token,
    ...(typeof tool_use_id === 'string' ? { toolUseId: tool_use_id } : {}),
    what: toolCallSummary(tool, args),
  })
  return { loop, token }
}

// The call that `key` noted ended: forgotten, unless a later call of that loop replaced it.
export function endPendingCallOf(key: { loop: string; token: object }): void {
  if (pendingCall.get(key.loop)?.token === key.token) pendingCall.delete(key.loop)
}

export function endPendingCall(e: unknown): void {
  const call = fields(e)
  const loop = typeof call.agent_id === 'string' ? call.agent_id : ''
  const pending = pendingCall.get(loop)
  if (pending && (!pending.toolUseId || pending.toolUseId === call.tool_use_id)) pendingCall.delete(loop)
}

export async function raiseAutoNeed($: EngineInterface, options: PluginOptions, e: unknown): Promise<void> {
  const n = fields(e)
  const kind =
    n.notification_type === 'permission_prompt'
      ? 'permission'
      : n.notification_type === 'idle_prompt'
        ? 'idle'
        : undefined
  if (!kind || !isOn(options, 'reporting')) return
  if (optionString(options, kind === 'permission' ? 'autoNeedsPermission' : 'autoNeedsIdle') === 'off') return
  const dir = await progressDir($, options)
  if (!dir) return
  const agentId = typeof n.agent_id === 'string' && n.agent_id ? n.agent_id : undefined
  const message = oneLine(typeof n.message === 'string' ? n.message : '')
  let text = t('auto.idle')
  // What the permission is for: the plugin's own record of the loop's pending call when Claude
  // Code's message is the generic one.
  const pending = pendingCall.get(agentId ?? '')
  // Never bare: the pending call's tool and input; else the tool the notice names; else Claude
  // Code's own words when they say more than the generic line; else where to look.
  const what =
    kind !== 'permission'
      ? undefined
      : pending && isGenericPermission(message)
        ? pending.what
        : isGenericPermission(message)
          ? noticeTool(message)
          : message
  if (kind === 'permission') {
    const agent = agentId
      ? ((await $.agent.list().catch(() => [])).find(a => a.id === agentId)?.description ?? agentId)
      : undefined
    const session = sessionName(await ownFile($, dir))
    text = !what
      ? t('auto.permissionUnknown', { session, agent: agent ? t('auto.agentSuffix', { agent }) : '' })
      : agent
        ? t('auto.permissionAgent', { agent, message: what })
        : t('auto.permission', { message: what })
  }
  const at = await nowIso($)
  await exclusive(async () => {
    const own = await ownFile($, dir)
    // The main loop's wait belongs to its one `doing` task (several or none: the Needs-you line only).
    const doing = agentId ? [] : own.tasks.filter(x => x.status === 'doing')
    const taskId = doing.length === 1 ? doing[0]?.id : undefined
    const rest = (own.autoNeeds ?? []).filter(a => !(a.kind === kind && a.agentId === agentId))
    await save($, dir, {
      ...own,
      autoNeeds: [
        ...rest,
        {
          kind,
          text,
          at,
          ...(agentId ? { agentId } : {}),
          ...(what ? { what } : {}),
          ...(taskId ? { taskId } : {}),
        },
      ],
    })
  })
  await announce($, await readSessions($), await $.session.id())
}

// The wait ended: the automatic items it raised go (`which` picks them); the agent's never.
export async function clearAutoNeeds(
  $: EngineInterface,
  options: PluginOptions,
  which: (a: NonNullable<SessionFile['autoNeeds']>[number]) => boolean,
): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  // A plain read first: most tool calls clear nothing, and must not write.
  const plain = await readOwnPlain($, options)
  if (plain === 'nowhere' || !plain?.autoNeeds?.some(which)) return
  await exclusive(async () => {
    const own = await ownFile($, dir)
    const kept = (own.autoNeeds ?? []).filter(a => !which(a))
    if (kept.length !== (own.autoNeeds ?? []).length) await save($, dir, { ...own, autoNeeds: kept })
  })
  await announce($, await readSessions($), await $.session.id())
}

// The permission was answered (the tool ran, failed or was denied): that loop's item goes.
export async function permissionAnswered(
  $: EngineInterface,
  options: PluginOptions,
  e: unknown,
): Promise<void> {
  endPendingCall(e)
  const agentId = fields(e).agent_id
  const id = typeof agentId === 'string' && agentId ? agentId : undefined
  await clearAutoNeeds($, options, a => a.kind === 'permission' && a.agentId === id).catch(() => undefined)
}

// `/progress pipelines recheck` (and `/progress doctor`): forget what is remembered about this repo's
// CI, so its next push is judged afresh.
export async function forgetCiVerdicts($: EngineInterface, options: PluginOptions): Promise<string> {
  const dir = await progressDir($, options)
  const root = (
    await runCli($, ['git', '-C', await $.session.cwd(), 'rev-parse', '--show-toplevel'])
  ).text?.trim()
  if (!dir || !root) return t('ciMemory.noRepo')
  await updateCiMemory($, dir, m => {
    const keys = Object.keys(m.repos).filter(k => k.startsWith(`${root}|`))
    return keys.length === 0 ? m : keys.reduce((acc, k) => withVerdict(acc, k, undefined), m)
  })
  return t('ciMemory.forgotten', { repo: baseName(root) })
}

// `/progress status`: each switch for this session, and whether it is its own or the default.
export function toggleStatus(options: PluginOptions): string {
  const eff = switches(options)
  const list = FEATURES.map(f =>
    t('toggle.statusItem', {
      feature: t(`toggle.feature.${f}`),
      state: t(eff[f] ? 'toggle.on' : 'toggle.off'),
      source: t(typeof self.sessionToggles?.[f] === 'boolean' ? 'toggle.overridden' : 'toggle.default'),
    }),
  ).join(', ')
  return t('toggle.status', { list })
}

// `/progress doctor`: one line per check, each failed one with its fix. Cheap and read-only: one
// probe file in the progress folder, one API call through the forge's own CLI (installed, logged in
// for the host AND able to read this project — a token scoped to other projects fails exactly
// there), one `git ls-remote` (the SSH host key, the credentials).
export async function doctor($: EngineInterface, options: PluginOptions): Promise<string> {
  const checks: Check[] = []
  checks.push({ state: 'ok', label: t('doctor.version'), detail: (await ownManifest($)).version || '?' })
  checks.push(
    self.ruleComposed
      ? { state: 'ok', label: t('doctor.rule'), detail: t('doctor.rule.composed') }
      : self.ruleSent
        ? { state: 'ok', label: t('doctor.rule'), detail: t('doctor.rule.sent') }
        : {
            state: 'fail',
            label: t('doctor.rule'),
            detail: t('doctor.rule.missing'),
            fix: t('doctor.rule.fix'),
          },
  )
  checks.push(
    self.ownProcess
      ? { state: 'ok', label: t('doctor.process'), detail: t('doctor.process.ok', self.ownProcess) }
      : { state: 'skip', label: t('doctor.process'), detail: t('doctor.process.none') },
  )
  const dir = await progressDir($, options)
  if (!dir) {
    checks.push({
      state: 'fail',
      label: t('doctor.folder'),
      detail: t('doctor.folder.none'),
      fix: t('doctor.folder.noneFix'),
    })
  } else {
    const probe = `${dir}/.doctor-${await $.session.id()}`
    const wrote = await $.fs.write(probe, 'ok').then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    if (wrote === undefined) await deleteFile($, probe)
    checks.push(
      wrote === undefined
        ? { state: 'ok', label: t('doctor.folder'), detail: dir }
        : {
            state: 'fail',
            label: t('doctor.folder'),
            detail: t('doctor.folder.unwritable', { dir, error: oneLine(wrote) }),
            fix: t('doctor.folder.unwritableFix'),
          },
    )
  }
  const where = await $.session.cwd()
  const root = (await runCli($, ['git', '-C', where, 'rev-parse', '--show-toplevel'])).text?.trim()
  if (!root) {
    checks.push({ state: 'skip', label: t('doctor.ci'), detail: t('doctor.ci.noRepo') })
    return `${t('doctor.title')}\n${formatChecks(checks)}`
  }
  const repo = baseName(root)
  // A doctor run judges this repo's CI afresh: what was remembered is forgotten.
  await forgetCiVerdicts($, options)
  const provider = await repoCi($, options, root)
  checks.push(
    provider
      ? { state: 'ok', label: t('doctor.ci'), detail: t('doctor.ci.found', { kind: provider, repo }) }
      : { state: 'skip', label: t('doctor.ci'), detail: t('doctor.ci.none', { repo }) },
  )
  const remoteUrl = (await runCli($, ['git', '-C', root, 'remote', 'get-url', 'origin'])).text?.trim()
  const remote = parseRemote(remoteUrl)
  if (provider === 'command')
    checks.push({ state: 'skip', label: t('doctor.cli'), detail: t('doctor.cli.custom') })
  else if (provider && !remote)
    checks.push({ state: 'skip', label: t('doctor.cli'), detail: t('doctor.cli.noRemote') })
  else if (provider && remote) checks.push(await forgeCheck($, provider, remote.host, remote.path))
  if (remoteUrl) checks.push(await gitCheck($, root, remoteUrl, remote?.host ?? remoteUrl))
  return `${t('doctor.title')}\n${formatChecks(checks)}`
}

// The forge CLI for this repo's CI: one read of its project (GitLab project, GitHub repo, Gitea repo).
export async function forgeCheck(
  $: EngineInterface,
  provider: PipelineProvider,
  host: string,
  project: string,
): Promise<Check> {
  const label = t('doctor.cli')
  const cli = provider === 'github' ? 'gh' : provider === 'gitea' ? 'tea' : 'glab'
  const ran =
    provider === 'github'
      ? await ghApi($, `repos/${project}`, host)
      : provider === 'gitea'
        ? await teaApi($, host, `/repos/${project}`)
        : await glabApi($, `projects/${encodeURIComponent(project)}`, host)
  const vars = { cli, host, project }
  if (ran.error === undefined) return { state: 'ok', label, detail: t('doctor.cli.ok', vars) }
  const error = oneLine(ran.error)
  const login =
    cli === 'gh'
      ? `gh auth login --hostname ${host}`
      : cli === 'tea'
        ? `tea login add --url https://${host}`
        : `glab auth login --hostname ${host}`
  switch (classifyCliError(error)) {
    case 'missing':
      return {
        state: 'fail',
        label,
        detail: t('doctor.cli.missing', vars),
        fix: t('doctor.cli.missingFix', vars),
      }
    case 'auth':
      return {
        state: 'fail',
        label,
        detail: t('doctor.cli.auth', { ...vars, error }),
        fix: t('doctor.cli.authFix', { login }),
      }
    case 'access':
      return {
        state: 'fail',
        label,
        detail: t('doctor.cli.access', { ...vars, error }),
        fix: t('doctor.cli.accessFix', vars),
      }
    default:
      return { state: 'fail', label, detail: t('doctor.cli.other', { ...vars, error }) }
  }
}

// Whether git itself reaches the remote (an untrusted SSH host key or missing credentials stop a push).
export async function gitCheck(
  $: EngineInterface,
  root: string,
  remote: string,
  host: string,
): Promise<Check> {
  const label = t('doctor.git')
  // Its whole stderr: git's last line ("Could not read from remote repository") hides the cause.
  const ran = await $.process
    .run(['git', '-C', root, 'ls-remote', '--exit-code', 'origin', 'HEAD'])
    .catch((err: unknown) => ({
      exitCode: 127,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }))
  if (ran.exitCode === 0) return { state: 'ok', label, detail: t('doctor.git.ok', { remote }) }
  const error = oneLine(ran.stderr) || `git exited ${ran.exitCode}`
  switch (classifyGitError(ran.stderr)) {
    case 'hostkey':
      return {
        state: 'fail',
        label,
        detail: t('doctor.git.hostkey', { remote }),
        fix: t('doctor.git.hostkeyFix', { host }),
      }
    case 'auth':
      return {
        state: 'fail',
        label,
        detail: t('doctor.git.auth', { remote }),
        fix: t('doctor.git.authFix', { host }),
      }
    default:
      return { state: 'fail', label, detail: t('doctor.git.other', { remote, error }) }
  }
}

// The watches one push asks for: each pushed branch head (or tag) by sha, on the repo's CI.
export async function pushWatches(
  $: EngineInterface,
  options: PluginOptions,
  where: string,
  push: ReturnType<typeof parsePushes>[number],
  notes: string[],
): Promise<(WatchInput & { repo: string })[]> {
  const git = async (...args: string[]) =>
    (await runCli($, ['git', '-C', where, ...args])).text?.trim() || undefined
  const root = await git('rev-parse', '--show-toplevel')
  if (!root) return []
  const dir = await progressDir($, options)
  const nowMs = await $.clock.now()
  const { provider, files } = await repoCiFiles($, options, root)
  const key = repoKey(root, push.remote)
  const memory = dir ? await readCiMemory($, dir) : undefined
  const known = memory ? remembered(memory, key, files, nowMs) : undefined
  const noCi = async (ci: 'none' | 'nopipeline', where?: { host: string; path: string }) => {
    if (dir && !known)
      await updateCiMemory($, dir, m =>
        withVerdict(m, key, {
          ci,
          files,
          checkedAtMs: nowMs,
          ...(where ? { host: where.host, project: where.path } : {}),
        }),
      )
    if (!toldNoCi.has(key)) {
      toldNoCi.add(key)
      notes.push(t('push.noCi', { repo: baseName(root) }))
    }
    return []
  }
  // Known to run no CI (no files, a mirror, or no pipeline ever came): nothing more to find out.
  if (known && known.ci !== 'yes') return noCi(known.ci)
  if (!provider) return noCi('none')
  // The remote: the one the push named (a name or a URL), else the branch's upstream's, else origin.
  const upstream = push.remote
    ? undefined
    : await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  const remoteName = push.remote ?? upstream?.split('/')[0] ?? 'origin'
  const isUrl = /[:/]/.test(remoteName)
  const url = isUrl ? remoteName : await git('remote', 'get-url', remoteName)
  const remote = parseRemote(url)
  if (provider !== 'command' && !remote) return []
  // A mirror on another kind of forge runs none of this repo's CI.
  if (remote && !forgeMatches(provider, remote.host)) return noCi('none', remote)
  if (dir && !known)
    await updateCiMemory($, dir, m =>
      withVerdict(m, key, {
        ci: 'yes',
        files,
        checkedAtMs: nowMs,
        ...(remote ? { host: remote.host, project: remote.path } : {}),
      }),
    )
  const repo = baseName(root)
  const specs = push.refs.length > 0 ? push.refs : push.tags && !push.all ? [] : ['HEAD']
  const out: (WatchInput & { repo: string })[] = []
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
      repo,
    })
  }
  return out
}

export function withPushNote<R extends { additionalContext?: string[] }>(
  keys: string[],
  result: R,
  notes: string[],
): R {
  const lines = [...(keys.length > 0 ? [t('push.watched', { keys: keys.join(', ') })] : []), ...notes]
  if (lines.length === 0) return result
  return { ...result, additionalContext: [...(result.additionalContext ?? []), ...lines] }
}

export function withRemovalNotice<R extends { additionalContext?: string[] }>(result: R): R {
  const note = takeRemovalNotice()
  return note ? { ...result, additionalContext: [...(result.additionalContext ?? []), note] } : result
}

export async function markEnded($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  await exclusive(async () => {
    const file = await ownFile($, dir)
    // Nothing to look back on: the session leaves no file (nor sidecar) behind.
    if (isBlank(file)) return forgetSession($, options, file.session.id)
    await save($, dir, { ...file, session: { ...file.session, endedAt: await nowIso($) } })
  })
}

export async function toggle($: EngineInterface, key: string, isOpenNow: boolean): Promise<void> {
  await updateFolds($, all => ({ ...all, [key]: !isOpenNow }))
}

/** The rule a new session's first prompt left to its system prompt, when none carried it by the
 *  main loop's first tool call: handed over there, once. */
export function takeDeferredRule(options: PluginOptions): string[] {
  if (!self.ruleDeferred || self.ruleComposed || self.ruleSent || !isOn(options, 'reporting')) return []
  self.ruleSent = true
  return [ruleText(options)]
}
