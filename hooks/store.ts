// The progress folder: this session's own file and every session's sidecar, read and written
// through `$.fs` — the only place a session file or a sidecar is written.

import type { EngineInterface, PluginOptions } from 'claude-code'
import type { CiMemory } from './cimemory'
import { CI_MEMORY_FILE, parseCiMemory } from './cimemory'
import { deleteFile } from './host'
import { t } from './i18n'
import type { Dismissal, SessionFile, SidecarFile } from './model'
import {
  addDismissals,
  cancelDeeper,
  cancelTasks,
  crossLinks,
  isBlank,
  mergeSidecar,
  newSession,
  parseSessionFile,
  parseSidecar,
  removalKey,
} from './model'
import { baseName, resolveProgressDir } from './paths'
import type { Pipeline } from './pipelines'
import { overlayPipelines, visiblePipelines } from './pipelines'
import {
  firstFold,
  OWN_UNREADABLE_MS,
  optionString,
  pendingAgentNotices,
  pendingNotes,
  pendingRemovals,
  SIDECAR,
  self,
  sidecarChains,
  updateSessions,
} from './state'

export function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = self.ownChain.then(work, work)
  self.ownChain = run.catch(() => undefined)
  return run
}

export async function progressDir($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  // The environment wins over the setting: a demo or test session points at its own folder
  // without moving every other session's (the setting is per user).
  const override = (await $.env.get('PROGRESS_PANEL_DIR')) ?? ''
  return resolveProgressDir(override.trim() || optionString(options, 'progressDir'), { home, configDir })
}

export async function nowIso($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

// Writes a session file whole and records what was written, so the pane redraws at once. Only a
// session writes its own live file (an ended one, whose session is gone, is pruned by any pane).
export async function save($: EngineInterface, dir: string, file: SessionFile): Promise<void> {
  const path = `${dir}/${file.session.id}.json`
  await $.fs.write(path, `${JSON.stringify(file, null, 2)}\n`)
  const stat = await $.fs.stat(path).catch(() => undefined)
  await updateSessions($, all => ({
    ...all,
    [file.session.id]: { ...all[file.session.id], mtimeMs: stat?.mtimeMs ?? 0, file },
  }))
}

export type Sidecar = { entries: Dismissal[]; pipelines: Pipeline[]; cancelled: string[] }

export async function readSidecar($: EngineInterface, dir: string, id: string): Promise<Sidecar> {
  const text = await $.fs.read(`${dir}/${id}${SIDECAR}`).catch(() => undefined)
  const parsed = text === undefined ? undefined : parseSidecar(text)
  return {
    entries: parsed?.entries ?? [],
    pipelines: parsed?.pipelines ?? [],
    cancelled: parsed?.cancelled ?? [],
  }
}

export const SIDECAR_RETRIES = 3

export async function writeSidecar(
  $: EngineInterface,
  dir: string,
  id: string,
  change: (sidecar: Sidecar) => Sidecar,
): Promise<void> {
  const run = (sidecarChains.get(id) ?? Promise.resolve()).then(() => changeSidecar($, dir, id, change))
  sidecarChains.set(
    id,
    run.catch(() => undefined),
  )
  return run
}

export async function changeSidecar(
  $: EngineInterface,
  dir: string,
  id: string,
  change: (sidecar: Sidecar) => Sidecar,
): Promise<void> {
  const path = `${dir}/${id}${SIDECAR}`
  const stamp = async () => (await $.fs.stat(path).catch(() => undefined))?.mtimeMs
  let next: Sidecar
  let tries = 0
  let moved: boolean
  do {
    const seen = await stamp()
    next = change(await readSidecar($, dir, id))
    moved = (await stamp()) !== seen
    tries += 1
  } while (moved && tries < SIDECAR_RETRIES)
  const file: SidecarFile = {
    version: 1,
    sessionId: id,
    entries: next.entries,
    ...(next.pipelines.length > 0 ? { pipelines: next.pipelines } : {}),
    ...(next.cancelled.length > 0 ? { cancelled: next.cancelled } : {}),
  }
  await $.fs.write(path, `${JSON.stringify(file, null, 2)}\n`)
  const stat = await $.fs.stat(path).catch(() => undefined)
  await updateSessions($, all => {
    const known = all[id]
    if (!known) return all
    return { ...all, [id]: { ...known, sidecar: { mtimeMs: stat?.mtimeMs ?? 0, ...next } } }
  })
}

/** This session's own file is there but cannot be read as one right now: nothing may be saved from
 *  a stand-in for it. */
export class OwnFileUnreadable extends Error {}

// A file that is there but does not read as a session file was caught mid-write (or its read failed):
// taking it for "no file" saved a blank session over everything it held. Only a file that is not
// there is a new session. One that stays unreadable — the same content OWN_UNREADABLE_MS after it
// was first seen so — is damaged for good: then the session does start over (it could never report
// again otherwise).
export async function refuseUnreadable(
  $: EngineInterface,
  path: string,
  id: string,
  text: string | undefined,
): Promise<void> {
  const isThere = text !== undefined || (await $.fs.stat(path).catch(() => undefined)) !== undefined
  if (!isThere) {
    self.ownUnreadable = undefined
    return
  }
  const nowMs = await $.clock.now()
  const seen = self.ownUnreadable
  const held = text ?? ''
  if (!seen || seen.id !== id || seen.text !== held) {
    self.ownUnreadable = { id, text: held, sinceMs: nowMs }
    throw new OwnFileUnreadable(path)
  }
  if (nowMs - seen.sinceMs < OWN_UNREADABLE_MS) throw new OwnFileUnreadable(path)
}

// This session's file as it is on disk now, with the panes' dismissals folded in; a fresh one when
// there is none (first write, or after /clear). Throws `OwnFileUnreadable` when the file is there
// but unreadable (`refuseUnreadable`): the caller's change is not made, and nothing is written.
export async function ownFile($: EngineInterface, dir: string): Promise<SessionFile> {
  const id = await $.session.id()
  const path = `${dir}/${id}.json`
  const text = await $.fs.read(path).catch(() => undefined)
  const existing = text === undefined ? undefined : parseSessionFile(text)
  if (!existing) await refuseUnreadable($, path, id, text)
  if (existing) {
    self.ownUnreadable = undefined
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
    for (const task of folded.removed)
      if (firstFold(`${id}:task:${task.id}`)) pendingRemovals.set(task.id, task.title)
    // A removed task's running agent stops too: its whole work, as if its own ✕ was pressed.
    const before = crossLinks(folded.file, folded.removed, [])
    const keys = [
      ...sidecar.cancelled,
      ...before.stop.map(s => removalKey({ kind: 'agent', agentId: s.agentId })),
    ]
    for (const s of before.stop)
      if (firstFold(`${id}:stop:${s.agentId}:${s.task}`))
        pendingNotes.push(t('notice.linkedAgentStopped', { task: s.task, agent: s.agent }))
    // The deeper removals: steps, a subagent's tasks, a whole subagent — each told to its own loop.
    const deeper = cancelDeeper(folded.file, keys, await nowIso($), t('task.removedNote'))
    // A stopped agent (or its last step gone) leaves its linked task without a worker: the
    // coordinator decides — the task is not skipped. (A task the person removed is not orphaned.)
    for (const o of crossLinks(deeper.file, [], deeper.notices).orphaned)
      if (!before.stop.some(s => s.task === o.task) && firstFold(`${id}:orphan:${JSON.stringify(o)}`))
        pendingNotes.push(t('notice.taskUnassigned', o))
    for (const n of deeper.notices) {
      if (!firstFold(`${id}:deeper:${JSON.stringify(n)}`)) continue
      const text =
        n.what === 'step'
          ? t('notice.stepRemoved', { step: n.step, task: n.task })
          : n.what === 'agentTask'
            ? t('notice.agentTaskRemoved', { task: n.task })
            : t('notice.agentCancelled')
      if (n.agentId) pendingAgentNotices.set(n.agentId, [...(pendingAgentNotices.get(n.agentId) ?? []), text])
      else pendingNotes.push(text)
    }
    return withProcess(deeper.file)
  }
  const cwd = await $.session.cwd()
  const repo = await $.session.repo().catch(() => null)
  return withProcess(
    withTitle(newSession({ id, project: baseName(repo?.root ?? cwd), cwd }, await nowIso($))),
  )
}

export function withProcess(file: SessionFile): SessionFile {
  if (!self.ownProcess) return file
  const s = file.session
  // A session another pane marked dead that is writing again was not dead: it is live once more.
  if (s.pid === self.ownProcess.pid && s.host === self.ownProcess.host && s.endedAt === null) return file
  return { ...file, session: { ...s, ...self.ownProcess, endedAt: null } }
}

export function withTitle(file: SessionFile): SessionFile {
  return self.sessionTitle && file.session.title !== self.sessionTitle
    ? { ...file, session: { ...file.session, title: self.sessionTitle } }
    : file
}

// A title the classic events carried: remembered, and written at once when the session has a file
// (one that reported nothing still writes nothing).
export async function noteTitle($: EngineInterface, options: PluginOptions, title: unknown): Promise<void> {
  if (typeof title !== 'string' || !title.trim() || title.trim() === self.sessionTitle) return
  self.sessionTitle = title.trim()
  const dir = await progressDir($, options)
  if (!dir) return
  await exclusive(async () => {
    const own = await ownFile($, dir)
    if (!isBlank(own)) await save($, dir, own)
  })
}

// A press (✕ / Clear all) on any session's rows: the completions go to that session's sidecar, never
// to its own file, so a pane can't race the session writing its status. Read fresh, union, write.
export async function dismiss(
  $: EngineInterface,
  options: PluginOptions,
  id: string,
  tasks: readonly Dismissal[],
): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir || tasks.length === 0) return
  await writeSidecar($, dir, id, sidecar => ({ ...sidecar, entries: addDismissals(sidecar.entries, tasks) }))
}

export async function forgetSession($: EngineInterface, options: PluginOptions, id: string): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  await deleteFile($, `${dir}/${id}.json`)
  await deleteFile($, `${dir}/${id}${SIDECAR}`)
  await updateSessions($, all => {
    const { [id]: _gone, ...rest } = all
    return rest
  })
}

// The session this process now runs (after a `/clear` or a resume in place) may have a file of its
// own already — a resumed one does: its switches apply again. A plain read; nothing is written.
export async function adoptSession($: EngineInterface, options: PluginOptions): Promise<void> {
  const own = await readOwnPlain($, options)
  self.sessionToggles = own === 'nowhere' ? undefined : own?.toggles
}

// Whether this session's own file holds anything yet — a plain read, nothing folded or queued.
export async function hasReported($: EngineInterface, options: PluginOptions): Promise<boolean> {
  const own = await readOwnPlain($, options)
  if (own === 'nowhere') return true // nowhere to report to: nothing to remind of
  return own !== undefined && !isBlank(own)
}

// This session's file as it is on disk (`undefined` before its first write), or 'nowhere' when no
// progress folder resolves — a plain read, nothing folded or queued.
export async function readOwnPlain(
  $: EngineInterface,
  options: PluginOptions,
): Promise<SessionFile | undefined | 'nowhere'> {
  const dir = await progressDir($, options)
  if (!dir) return 'nowhere'
  const text = await $.fs.read(`${dir}/${await $.session.id()}.json`).catch(() => undefined)
  return text === undefined ? undefined : parseSessionFile(text)
}

export async function readCiMemory($: EngineInterface, dir: string): Promise<CiMemory> {
  return parseCiMemory(await $.fs.read(`${dir}/${CI_MEMORY_FILE}`).catch(() => undefined))
}

// Read, change, write — the file is tiny and shared by the machine's sessions.
export async function updateCiMemory(
  $: EngineInterface,
  dir: string,
  change: (m: CiMemory) => CiMemory,
): Promise<void> {
  const before = await readCiMemory($, dir)
  const after = change(before)
  if (after !== before) await $.fs.write(`${dir}/${CI_MEMORY_FILE}`, `${JSON.stringify(after, null, 2)}\n`)
}
