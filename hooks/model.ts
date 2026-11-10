// The session file and every pure operation on it — no I/O here (see store.ts for that).

import type {
  AgentEntry,
  Dismissal,
  Loaded,
  Pipeline,
  SessionFile,
  SessionInfo,
  SidecarFile,
  Status,
  Step,
  Task,
} from '../types'
import { isSafeProject } from './pipelines'

export type { Dismissal, SessionFile, SessionInfo, SidecarFile, Status, Task }

/** The statuses a report may set. `unfinished` is the plugin's own (an agent stopped with the step
 *  open), so it is read back from a file but never accepted from a report. */
export const STATUSES = [
  'todo',
  'doing',
  'blocked',
  'done',
  'skipped',
  'failed',
] as const satisfies readonly Status[]
const STORED_STATUSES: readonly Status[] = [...STATUSES, 'unfinished']

// `plan` first: the default, the order the session lists its tasks in — the order it will do them.
export const SORTS = ['plan', 'status', 'title', 'created', 'done'] as const
export type SortBy = (typeof SORTS)[number]

export type StepInput = { title?: string; status?: string; note?: string }
export type TaskInput = {
  id?: string
  title?: string
  status?: string
  note?: string
  /** A longer description; '' clears it. */
  detail?: string
  /** The repo the task belongs to (its name); '' clears it. */
  repo?: string
  /** Subtasks, replacing the task's whole list; [] clears it. */
  steps?: StepInput[]
  /** The subagent working on it (its Agent call's description or id); '' clears it. */
  agent?: string
  /** The pipeline it waits on (a watch key); '' clears it. Closes the task when it finishes. */
  pipeline?: string
}
/** One ask: its text alone, or with the task (id) or agent (label / id) it belongs to. */
export type NeedInput = string | { text?: string; task?: string; agent?: string }
export type UpdateInput = {
  now?: string
  needsYou?: NeedInput[]
  tasks?: TaskInput[]
  remove?: string[]
  /** Task ids (or exact titles) in the order the session will do them; the rest keep theirs after. */
  order?: string[]
  /** A subagent's estimate of the minutes it still needs. */
  eta?: number
}

/** Closed = no more work will happen on it: done, skipped, failed or left unfinished. */
export function isClosed(status: Status): boolean {
  return status === 'done' || status === 'skipped' || status === 'failed' || status === 'unfinished'
}

function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

function isStoredStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STORED_STATUSES as readonly string[]).includes(value)
}

export function newSession(info: Omit<SessionInfo, 'startedAt' | 'endedAt'>, nowIso: string): SessionFile {
  return {
    version: 2,
    session: { ...info, startedAt: nowIso, endedAt: null },
    needsYou: [],
    updatedAt: nowIso,
    tasks: [],
    dismissed: [],
    seq: 0,
    pipelines: [],
  }
}

// The highest `t<n>` among the counter, the ids in use and the dismissed ones.
function highestSeq(seq: number, ids: readonly string[]): number {
  let max = seq
  for (const id of ids) {
    const n = /^t(\d+)$/.exec(id)?.[1]
    if (n) max = Math.max(max, Number(n))
  }
  return max
}

/** Applies a progress_update patch. Problems are collected per entry; the rest still applies. */
export function applyUpdate(
  file: SessionFile,
  input: UpdateInput,
  nowIso: string,
): { file: SessionFile; errors: string[] } {
  const errors: string[] = []
  let tasks = [...file.tasks]
  let dismissed = [...file.dismissed]
  let seq = highestSeq(file.seq, [...tasks.map(t => t.id), ...dismissed])

  for (const id of input.remove ?? []) {
    if (tasks.some(t => t.id === id)) tasks = tasks.filter(t => t.id !== id)
    else errors.push(`remove: no task ${id}`)
  }

  ;(input.tasks ?? []).forEach((patch, i) => {
    if (patch.status !== undefined && !isStatus(patch.status)) {
      errors.push(`tasks[${i}]: status must be one of ${STATUSES.join(', ')}`)
      return
    }
    const status = patch.status as Status | undefined
    const at = tasks.findIndex(t => (patch.id ? t.id === patch.id : t.title === patch.title))
    const wasDismissed = patch.id !== undefined && dismissed.includes(patch.id)
    // The person removed it in a pane: it stays skipped — a new id or title is a new task.
    const found = tasks[at]
    if (found && (file.cancelled ?? []).includes(found.id)) {
      errors.push(
        `tasks[${i}]: ${found.id} was removed in the Progress pane and stays skipped (a new title makes a new task)`,
      )
      return
    }

    if (at < 0 && wasDismissed) {
      // The person removed it: a done copy stays gone, reopening brings it back.
      if (status === undefined || isClosed(status)) return
      dismissed = dismissed.filter(id => id !== patch.id)
    } else if (at < 0 && patch.id && !patch.title) {
      errors.push(`tasks[${i}]: no task ${patch.id} (give a title to create one)`)
      return
    }

    if (at < 0) {
      if (!patch.title) {
        errors.push(`tasks[${i}]: a new task needs a title`)
        return
      }
      // An open task with nearly the same title is that task re-added under a new name: refused,
      // pointed at the id to update — a list never carries the same step twice.
      const twin = patch.id
        ? undefined
        : tasks.find(t => !isClosed(t.status) && sameTitle(t.title, patch.title ?? ''))
      if (twin) {
        errors.push(
          `tasks[${i}]: did you mean ${twin.id} (${twin.title})? update it by id — rename it by sending a new title with that id`,
        )
        return
      }
      const created = status ?? 'todo'
      const id = patch.id ?? `t${seq + 1}`
      seq = highestSeq(seq, [id])
      tasks.push({
        id,
        title: patch.title,
        status: created,
        ...(patch.note ? { note: patch.note } : {}),
        ...extras({}, patch, i, errors, nowIso),
        createdAt: nowIso,
        updatedAt: nowIso,
        doneAt: isClosed(created) ? nowIso : null,
      })
      return
    }

    const old = tasks[at] as Task
    const next = status ?? old.status
    const doneAt = isClosed(next) ? (isClosed(old.status) ? old.doneAt : nowIso) : null
    const { detail: _d, steps: _s, repo: _r, agent: _a, pipeline: _p, unconfirmed: _u, ...kept } = old
    tasks[at] = {
      ...kept,
      ...extras(old, patch, i, errors, nowIso),
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      status: next,
      updatedAt: nowIso,
      doneAt,
    }
  })

  if (input.order) tasks = reorder(tasks, input.order, errors)

  return {
    file: {
      ...file,
      ...(input.now !== undefined ? { now: input.now } : {}),
      ...(input.needsYou !== undefined ? needsFrom(input.needsYou, errors) : {}),
      tasks,
      dismissed,
      seq,
      updatedAt: nowIso,
    },
    errors,
  }
}

/** The person's ✕: the tasks go, and their ids are remembered so a re-sent done copy stays gone. */
export function dismissTasks(file: SessionFile, ids: readonly string[]): SessionFile {
  const gone = file.tasks.filter(t => ids.includes(t.id)).map(t => t.id)
  if (gone.length === 0) return file
  return {
    ...file,
    tasks: file.tasks.filter(t => !gone.includes(t.id)),
    dismissed: [...file.dismissed, ...gone.filter(id => !file.dismissed.includes(id))],
  }
}

function isDismissedBy(task: Task, entries: readonly Dismissal[]): boolean {
  return isClosed(task.status) && entries.some(d => d.id === task.id && d.doneAt === task.doneAt)
}

/** The tasks a pane shows: the file's, minus closed ones a sidecar entry names for that same completion. */
export function visibleTasks(
  file: SessionFile,
  entries: readonly Dismissal[],
  cancelled: readonly string[] = [],
): Task[] {
  // An open task a pane removed hides at once, before its session folds the removal in.
  return file.tasks.filter(
    task => !isDismissedBy(task, entries) && !(cancelled.includes(task.id) && !isClosed(task.status)),
  )
}

/**
 * The owner folds the panes' removals into its own file: each named task that is still open and was
 * never removed before becomes `skipped` with `note` (so it shows under Done), and its id joins
 * `cancelled` so a stale sidecar entry never removes it again once the session re-opens it.
 */
export function cancelTasks(
  file: SessionFile,
  ids: readonly string[],
  nowIso: string,
  note: string,
): { file: SessionFile; removed: Task[] } {
  const already = new Set(file.cancelled ?? [])
  const removed = file.tasks.filter(t => ids.includes(t.id) && !already.has(t.id) && !isClosed(t.status))
  if (removed.length === 0) return { file, removed }
  const gone = new Set(removed.map(t => t.id))
  return {
    file: {
      ...file,
      tasks: file.tasks.map(t =>
        gone.has(t.id) ? { ...t, status: 'skipped' as const, note, updatedAt: nowIso, doneAt: nowIso } : t,
      ),
      cancelled: [...already, ...gone],
      updatedAt: nowIso,
    },
    removed,
  }
}

/** The owner folds its sidecar into its own file: the named completions become ordinary dismissals. */
export function mergeSidecar(file: SessionFile, entries: readonly Dismissal[]): SessionFile {
  return dismissTasks(
    file,
    file.tasks.filter(task => isDismissedBy(task, entries)).map(task => task.id),
  )
}

/** The entries for these tasks' current completions, added to a sidecar's (each id + doneAt once). */
export function addDismissals(entries: readonly Dismissal[], tasks: readonly Dismissal[]): Dismissal[] {
  const next = [...entries]
  for (const task of tasks) {
    if (!next.some(d => d.id === task.id && d.doneAt === task.doneAt))
      next.push({ id: task.id, doneAt: task.doneAt })
  }
  return next
}

/** A sidecar file, or undefined for anything else. */
export function parseSidecar(text: string): SidecarFile | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  const f = raw as Partial<SidecarFile> | null
  if (f?.version !== 1 || typeof f.sessionId !== 'string' || !Array.isArray(f.entries)) return undefined
  const entries = f.entries.filter(
    (d): d is Dismissal =>
      typeof d === 'object' &&
      d !== null &&
      typeof d.id === 'string' &&
      (d.doneAt === null || typeof d.doneAt === 'string'),
  )
  return {
    version: 1,
    sessionId: f.sessionId,
    entries,
    pipelines: asPipelines(f.pipelines),
    cancelled: (Array.isArray(f.cancelled) ? f.cancelled : []).filter(
      (id): id is string => typeof id === 'string',
    ),
  }
}

// A stored pipeline's id: not known yet, or a run number — it is written into the forge's API path.
const isRunId = (id: unknown): boolean =>
  id === null || (typeof id === 'number' && Number.isInteger(id) && id > 0)

/** The well-formed pipelines of a stored list (a session file's, or a sidecar's refreshed copies). */
function asPipelines(value: unknown): Pipeline[] {
  return (Array.isArray(value) ? value : []).filter(
    (p): p is Pipeline =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as Pipeline).key === 'string' &&
      typeof (p as Pipeline).project === 'string' &&
      isSafeProject((p as Pipeline).project, (p as Pipeline).provider) &&
      isRunId((p as Pipeline).id) &&
      Array.isArray((p as Pipeline).jobs),
  )
}

/** Nothing reported: no task, no "now", no ask, no pipeline — a session like this is never stored or shown. */
export function isBlank(file: SessionFile): boolean {
  return (
    file.tasks.length === 0 &&
    !file.now &&
    file.needsYou.length === 0 &&
    (file.autoNeeds ?? []).length === 0 &&
    (file.pipelines ?? []).length === 0 &&
    (file.agents ?? []).length === 0
  )
}

/** Auto-clear: done tasks finished more than `hours` ago go (0 = never). Same object when nothing goes. */
export function pruneDone(file: SessionFile, hours: number, nowMs: number): SessionFile {
  if (hours <= 0) return file
  const cutoff = nowMs - hours * 3_600_000
  const old = file.tasks.filter(t => isClosed(t.status) && t.doneAt !== null && Date.parse(t.doneAt) < cutoff)
  return old.length === 0
    ? file
    : dismissTasks(
        file,
        old.map(t => t.id),
      )
}

const STATUS_ORDER: Record<Status, number> = {
  blocked: 0,
  doing: 1,
  todo: 2,
  failed: 3,
  done: 4,
  skipped: 5,
  unfinished: 6,
}
const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0)

/** A task's detail and steps after a patch: given ones replace, '' / [] clear, absent ones stay. */
function extras(
  old: Pick<Task, 'detail' | 'steps' | 'repo' | 'agent' | 'pipeline'>,
  patch: TaskInput,
  i: number,
  errors: string[],
  nowIso: string,
): Pick<Task, 'detail' | 'steps' | 'repo' | 'agent' | 'pipeline'> {
  const detail = patch.detail !== undefined ? patch.detail : old.detail
  const pipeline = patch.pipeline !== undefined ? patch.pipeline.trim() : old.pipeline
  const agent = patch.agent !== undefined ? patch.agent.trim() : old.agent
  const repo = patch.repo !== undefined ? patch.repo.trim() : old.repo
  let steps = old.steps
  // A task linked to an agent shows that agent's own steps: copies sent here are dropped, said once.
  if (patch.steps !== undefined && agent) {
    errors.push(
      `tasks[${i}]: linked to agent "${agent}" — its steps come from the agent; send this task only its status and note`,
    )
  } else if (patch.steps !== undefined) {
    steps = [] as Step[]
    for (const [j, step] of patch.steps.entries()) {
      const title = typeof step?.title === 'string' ? step.title.trim() : ''
      if (!title) {
        errors.push(`tasks[${i}].steps[${j}]: a step needs a title`)
      } else if (step.status !== undefined && !isStatus(step.status)) {
        errors.push(`tasks[${i}].steps[${j}]: status must be one of ${STATUSES.join(', ')}`)
      } else {
        const before = old.steps?.find(s => s.title === title)
        // A step the person removed in a pane stays removed, whatever a later report says.
        if (before?.removedByUser) {
          steps.push(before)
          continue
        }
        const status = (step.status as Status | undefined) ?? 'todo'
        // When it closed: kept from the step of that title already closed, else now — the pace a
        // time-left estimate is calibrated on (stepless steps from before 0.23.0 have none).
        const doneAt = isClosed(status)
          ? before && isClosed(before.status)
            ? before.doneAt
            : nowIso
          : undefined
        const note = typeof step.note === 'string' ? step.note.trim() : ''
        steps.push({ title, status, ...(note ? { note } : {}), ...(doneAt ? { doneAt } : {}) })
      }
    }
  }
  return {
    ...(detail ? { detail } : {}),
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...(repo ? { repo } : {}),
    ...(agent ? { agent } : {}),
    ...(pipeline ? { pipeline } : {}),
  }
}

/** Whether a task's text holds the query (case-insensitive: title, note, detail, step titles); a blank query matches all. */
export function matchesTask(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [task.title, task.note ?? '', task.detail ?? '', ...(task.steps ?? []).map(s => s.title)].some(
    text => text.toLowerCase().includes(q),
  )
}

/** A text cut around every case-insensitive hit of `query` (for highlighting); blank query = one plain part. */
export function splitMatches(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase()
  if (!q) return [{ text, hit: false }]
  const parts: { text: string; hit: boolean }[] = []
  const lower = text.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false })
    parts.push({ text: text.slice(at, at + q.length), hit: true })
    from = at + q.length
  }
  if (from < text.length || parts.length === 0) parts.push({ text: text.slice(from), hit: false })
  return parts
}

/** How many of a task's steps are closed, of how many. */
export function stepCounts(task: Pick<Task, 'steps'>): { closed: number; total: number } {
  // A step the person removed is counted out: it will not be done.
  const steps = (task.steps ?? []).filter(s => !s.removedByUser)
  return { closed: steps.filter(s => isClosed(s.status)).length, total: steps.length }
}

/** A subagent's progress patch, upserted into its entry under the session — never the session's tasks. */
export function applyAgentUpdate(
  file: SessionFile,
  who: { id: string; label: string },
  input: UpdateInput,
  nowIso: string,
): { file: SessionFile; errors: string[] } {
  const agents = file.agents ?? []
  const old = agents.find(a => a.id === who.id)
  // The agent's own list runs through the one task logic (ids, statuses, order), on a scratch file.
  const scratch: SessionFile = {
    ...file,
    now: old?.now ?? undefined,
    tasks: old?.tasks ?? [],
    seq: old?.seq ?? 0,
    dismissed: [],
    needsYou: [],
    // The agent's own removed tasks (its ids are its own: t1… collides with the session's).
    cancelled: old?.cancelled ?? [],
  }
  const r = applyUpdate(
    scratch,
    { now: input.now, tasks: input.tasks, remove: input.remove, order: input.order },
    nowIso,
  )
  const eta =
    typeof input.eta === 'number' && Number.isFinite(input.eta) && input.eta >= 0
      ? Math.round(input.eta)
      : old?.etaMin
  const entry: AgentEntry = {
    id: who.id,
    label: who.label,
    now: r.file.now ?? null,
    tasks: r.file.tasks,
    seq: r.file.seq,
    ...(old?.cancelled?.length ? { cancelled: old.cancelled } : {}),
    ...(old?.cancelledAt ? { cancelledAt: old.cancelledAt } : {}),
    // A report from an agent marked ended means it was resumed: the list sync must not end it again.
    ...(old && (old.endedAt !== null || old.resumedAt)
      ? { resumedAt: old.endedAt !== null ? nowIso : old.resumedAt }
      : {}),
    ...(eta !== undefined ? { etaMin: eta } : {}),
    // What it runs on is the engine's word (`withAgentRun`), not the report's: kept across reports.
    ...(old?.model ? { model: old.model } : {}),
    ...(old?.effort ? { effort: old.effort } : {}),
    ...(old?.activity ? { activity: old.activity } : {}),
    ...(old?.calls ? { calls: old.calls } : {}),
    startedAt: old?.startedAt ?? nowIso,
    updatedAt: nowIso,
    endedAt: null,
  }
  return {
    file: {
      ...file,
      agents: old ? agents.map(a => (a.id === who.id ? entry : a)) : [...agents, entry],
      updatedAt: nowIso,
    },
    errors: r.errors,
  }
}

/** A subagent as the session lists it (`$.agent.list()`): its id, the Agent call's words, its state. */
export type ListedAgent = { id: string; description: string; status: string }

const AGENT_ENDED = new Set(['completed', 'failed', 'killed'])

/** A resumed or waiting agent the list calls ended is ended after this long without activity. */
export const AGENT_IDLE_MS = 3 * 60_000

function idle(a: AgentEntry, nowIso: string): boolean {
  return Date.parse(nowIso) - Date.parse(a.updatedAt) >= AGENT_IDLE_MS
}

/** The agent's entry with its latest tool call (one line) and how many calls it has made: what an
 *  agent that reports no steps is on. The same file when the agent has no entry or nothing changed. */
export function withAgentActivity(
  file: SessionFile,
  id: string,
  activity: string,
  calls: number,
): SessionFile {
  const known = file.agents?.find(a => a.id === id)
  if (!known || !activity || (known.activity === activity && known.calls === calls)) return file
  return {
    ...file,
    agents: (file.agents ?? []).map(a => (a.id === id ? { ...a, activity, calls } : a)),
  }
}

/** Whether an agent's row has anything to unfold: a waiting line, what it said it is doing, its
 *  latest tool call, messages queued for it, or steps. A row with nothing inside never folds. */
export function agentHasInside(a: AgentEntry): boolean {
  return (
    (a.waiting === true && a.endedAt === null) ||
    !!a.now ||
    !!a.activity ||
    (a.queued?.length ?? 0) > 0 ||
    a.tasks.length > 0
  )
}

/** A model id as an agent's row shows it: the family and its version, without the vendor prefix, a
 *  provider's wrapping, the release date or a context tag (`claude-sonnet-5-5-20261001[1m]` →
 *  `sonnet 5.5`). An alias or an id of another shape shows as it is. */
export function modelLabel(id: string): string {
  const m = /(?:^|[./:])claude-([a-z]+)((?:-\d{1,2})+)(?=$|[-@[:])/.exec(id.trim())
  if (!m) return id.trim()
  return `${m[1]} ${(m[2] ?? '').slice(1).split('-').join('.')}`
}

/** The agent's entry with what its latest model request ran on (`turn.step`: the model the engine
 *  resolved, the effort it asked for). The same file when the agent has no entry yet or nothing
 *  changed, so the caller writes only a change. */
export function withAgentRun(
  file: SessionFile,
  id: string,
  model: string,
  effort: string | number | undefined,
): SessionFile {
  const known = file.agents?.find(a => a.id === id)
  const level = effort === undefined ? undefined : String(effort)
  if (!known || !model || (known.model === model && known.effort === level)) return file
  const { effort: _was, ...rest } = known
  const next = { ...rest, model, ...(level ? { effort: level } : {}) }
  return { ...file, agents: (file.agents ?? []).map(a => (a.id === id ? next : a)) }
}

/**
 * The session's subagents folded into its entries, so one that never reports (an agent without the
 * progress tool, e.g. a read-only reviewer) still shows under Agents while it runs: a running one not
 * yet known gets an entry labelled by its description, a known one the list says ended is finished.
 * An agent the list does not name at all (finished agents drop out of it — after a reload the list
 * is empty) is finished too once it showed no activity for AGENT_IDLE_MS; one the list says runs is
 * never ended. An ended agent never keeps `waiting`. Unchanged when nothing differs, so the caller
 * can skip the write. `listed` must be the engine's real answer — a failed list call is no answer.
 */
export function syncAgents(file: SessionFile, listed: readonly ListedAgent[], nowIso: string): SessionFile {
  let agents = file.agents ?? []
  let changed = false
  for (const a of listed) {
    const known = agents.find(x => x.id === a.id)
    const ended = AGENT_ENDED.has(a.status)
    if (!known) {
      if (ended) continue
      agents = [
        ...agents,
        {
          id: a.id,
          label: a.description.trim() || a.id.slice(0, 8),
          now: null,
          tasks: [],
          seq: 0,
          startedAt: nowIso,
          updatedAt: nowIso,
          endedAt: null,
        },
      ]
      changed = true
    } else if (
      ended &&
      known.endedAt === null &&
      (!(known.resumedAt || known.waiting) || idle(known, nowIso))
    ) {
      // The list is the truth for "still working". A resumed agent keeps its first run's
      // "completed" there while it runs again, and a waiting one may never get another
      // SubagentStop — so those end once they also showed no activity for AGENT_IDLE_MS (a later
      // report or tool call reopens them: `reopenAgent`).
      agents = agents.map(x => (x.id === a.id ? stopped(x, nowIso) : x))
      changed = true
    } else if (!ended && known.endedAt !== null) {
      // The list says it runs again (resumed): back among the running.
      agents = agents.map(x => (x.id === a.id ? reopened(x, nowIso) : x))
      changed = true
    }
  }
  const named = new Set(listed.map(a => a.id))
  agents = agents.map(x => {
    // Gone from the list and quiet: it stopped (its SubagentStop may never come — a resumed or
    // waiting agent, or a reload in between).
    if (x.endedAt === null && !named.has(x.id) && idle(x, nowIso)) {
      changed = true
      return stopped(x, nowIso)
    }
    // Ended but still marked waiting (an older build left it so): an ended agent never waits.
    if (x.endedAt !== null && x.waiting) {
      changed = true
      return withoutWaiting(x)
    }
    return x
  })
  return changed ? { ...file, agents, updatedAt: nowIso } : file
}

/**
 * The coordinator clears agent rows from its own entry, as the pane's ✕ does: `which` = true for
 * every agent that is not working (ended, or only waiting), or the ids / labels to clear. A running
 * one is never removed — it is named in `running`. `dismissed` / `running` hold labels.
 */
export function dismissAgents(
  file: SessionFile,
  which: true | readonly string[],
  nowIso: string,
): { file: SessionFile; dismissed: string[]; running: string[] } {
  const agents = file.agents ?? []
  const wanted = (a: AgentEntry) =>
    which === true || which.some(w => w === a.id || w.trim().toLowerCase() === a.label.trim().toLowerCase())
  const dismissed: string[] = []
  const running: string[] = []
  const kept = agents.filter(a => {
    if (!wanted(a)) return true
    if (a.endedAt !== null || a.waiting) {
      dismissed.push(a.label)
      return false
    }
    // Named explicitly but still working: kept, and said so (clear-all skips it silently).
    if (which !== true) running.push(a.label)
    return true
  })
  if (dismissed.length === 0) return { file, dismissed, running }
  return { file: { ...file, agents: kept, updatedAt: nowIso }, dismissed, running }
}

/**
 * The subagent that stopped: finished — or, when it still has background work running, `waiting`
 * (it resumes on its own). Unchanged when it is unknown or already finished.
 */
export function endAgent(
  file: SessionFile,
  id: string,
  nowIso: string,
  waiting = false,
  waitingOn?: string,
): SessionFile {
  const agent = file.agents?.find(a => a.id === id)
  if (!agent || agent.endedAt !== null) return file
  if (waiting && agent.waiting && agent.waitingOn === waitingOn) return file
  const next = waiting
    ? { ...agent, waiting: true as const, ...(waitingOn ? { waitingOn } : {}), updatedAt: nowIso }
    : stopped(agent, nowIso)
  return { ...file, agents: (file.agents ?? []).map(a => (a.id === id ? next : a)), updatedAt: nowIso }
}

function withoutWaiting(a: AgentEntry): AgentEntry {
  const { waiting: _w, waitingOn: _o, ...rest } = a
  return rest
}

/** What a SubagentStop's `background_tasks` says the agent waits on: their descriptions (or
 *  commands), joined; undefined when the event names nothing. */
export function waitingOnFrom(background: unknown): string | undefined {
  if (!Array.isArray(background)) return undefined
  // One short name per task: its description, else the command's first words — never a whole
  // command (a multi-line script made one row a screenful, 2026-11-09). The pane cuts the line to its
  // width with "…".
  const names = background
    .map(b => {
      if (typeof b === 'string') return firstLine(b)
      if (b && typeof b === 'object') {
        const o = b as Record<string, unknown>
        if (typeof o.description === 'string' && o.description.trim()) return firstLine(o.description)
        if (typeof o.command === 'string' && o.command.trim()) return commandHead(o.command)
        for (const k of ['name', 'id'])
          if (typeof o[k] === 'string' && (o[k] as string).trim()) return firstLine(o[k] as string)
      }
      return ''
    })
    .filter(Boolean)
  return names.length ? names.join(', ') : undefined
}

function firstLine(text: string): string {
  return (text.trim().split(/\r?\n/)[0] ?? '').trim()
}

/** A shell command's first words: its program and first argument, past any `VAR=…` assignments,
 *  `cd …&&` and `;`-chained setup — enough to say what it is ("cargo nextest", "glab ci"). */
export function commandHead(command: string): string {
  const parts = firstLine(command)
    .split(/&&|;|\|\|/)
    .map(p => p.trim())
    .filter(Boolean)
  // Setup is `cd …`, `export …`, `set …`, `source …` / `. …`, or only VAR=value assignments.
  const isSetup = (p: string) =>
    /^(cd|export|set|source|\.)(\s|$)/.test(p) || /^([A-Za-z_][A-Za-z0-9_]*=\S*\s*)+$/.test(p)
  const main = parts.find(p => !isSetup(p)) ?? parts[0] ?? ''
  const words = main.split(/\s+/).filter(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  return words.slice(0, 2).join(' ')
}

/** The background tasks a stopping subagent left running that are ITS OWN: the event lists the whole
 *  session's, with no owner (its BackgroundTaskSummary has none), so only the ids its own tool calls
 *  started count (`owned`, from their results' `backgroundTaskId`). */
export function ownBackground(background: unknown, owned: ReadonlySet<string>): unknown[] {
  if (!Array.isArray(background) || owned.size === 0) return []
  return background.filter(
    b =>
      b &&
      typeof b === 'object' &&
      typeof (b as { id?: unknown }).id === 'string' &&
      owned.has((b as { id: string }).id),
  )
}

/** The agent stopped for good: ended, not waiting, and every step it left open (`todo`, `doing`,
 *  `blocked`) is `unfinished` — a finished agent never looks busy or keeps stale steps. */
function stopped(a: AgentEntry, nowIso: string): AgentEntry {
  return {
    ...withoutWaiting(a),
    endedAt: nowIso,
    updatedAt: nowIso,
    tasks: a.tasks.map(t =>
      isClosed(t.status) || t.status === 'unfinished'
        ? t
        : {
            ...t,
            status: 'unfinished' as const,
            before: t.status as 'todo' | 'doing' | 'blocked',
            updatedAt: nowIso,
          },
    ),
  }
}

/** Back among the running: the steps its stop left `unfinished` are `doing` again. */
function reopened(a: AgentEntry, nowIso: string): AgentEntry {
  return {
    ...withoutWaiting(a),
    endedAt: null,
    resumedAt: nowIso,
    updatedAt: nowIso,
    tasks: a.tasks.map(t => {
      if (t.status !== 'unfinished') return t
      const { before, ...rest } = t
      return { ...rest, status: before ?? ('doing' as const), updatedAt: nowIso }
    }),
  }
}

/**
 * The agent is active again (its own report or tool call): an ended or waiting entry is back among
 * the running, its steps kept. Same object when it already runs or is unknown.
 */
export function reopenAgent(file: SessionFile, id: string, nowIso: string): SessionFile {
  const agent = file.agents?.find(a => a.id === id)
  if (!agent || (agent.endedAt === null && !agent.waiting)) return file
  return {
    ...file,
    agents: (file.agents ?? []).map(a => (a.id === id ? reopened(a, nowIso) : a)),
    updatedAt: nowIso,
  }
}

/** A title folded for the duplicate check: case, punctuation and a leading "N." / "A1:" / "B." label. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\s*(?:\d+|[a-z]\d*)(?:\/[a-z]?\d*)*\s*[.:)]\s*/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Two titles name the same step: equal once folded ("B1/B2: live proof" = "B: Live proof."). */
export function sameTitle(a: string, b: string): boolean {
  const x = titleKey(a)
  return x !== '' && x === titleKey(b)
}

/** The named tasks (id or exact title) first, in that order; every other keeps its place after them. */
function reorder(tasks: Task[], order: readonly string[], errors: string[]): Task[] {
  const named: Task[] = []
  for (const name of order) {
    const task = tasks.find(t => t.id === name) ?? tasks.find(t => t.title === name)
    if (!task) errors.push(`order: no task ${name}`)
    else if (!named.includes(task)) named.push(task)
  }
  return [...named, ...tasks.filter(t => !named.includes(t))]
}

export function sortTasks(tasks: readonly Task[], by: SortBy): Task[] {
  const list = [...tasks]
  const newestDone = (a: Task, b: Task) => time(b.doneAt) - time(a.doneAt)
  switch (by) {
    case 'plan':
      return list
    case 'title':
      return list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
    case 'created':
      return list.sort((a, b) => time(a.createdAt) - time(b.createdAt))
    case 'done':
      return list.sort((a, b) => newestDone(a, b) || time(a.createdAt) - time(b.createdAt))
    default:
      return list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || newestDone(a, b))
  }
}

function asStrings(value: unknown): string[] | undefined {
  if (value === undefined) return []
  return Array.isArray(value) && value.every(v => typeof v === 'string') ? value : undefined
}

/**
 * A session's id is its file's name (`<id>.json`) and is written into paths: a plain name only —
 * letters, digits, `.`, `_`, `-`, starting with a letter or digit — never a separator or `..`.
 */
export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..')
}

// The session block of a stored file: what every reader relies on must be what it should be (else
// the file is refused); an optional extra of the wrong type is dropped.
function asSessionInfo(raw: Record<string, unknown> | undefined): SessionInfo | undefined {
  if (!raw || !isSessionId(raw.id)) return undefined
  if (typeof raw.project !== 'string' || typeof raw.cwd !== 'string') return undefined
  if (typeof raw.startedAt !== 'string') return undefined
  if (raw.endedAt !== null && typeof raw.endedAt !== 'string') return undefined
  return {
    id: raw.id,
    project: raw.project,
    cwd: raw.cwd,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 1 ? { pid: raw.pid } : {}),
    ...(typeof raw.host === 'string' ? { host: raw.host } : {}),
  }
}

/** A v2 session file, or undefined for anything else (another version, broken JSON, wrong shapes). */
export function parseSessionFile(text: string): SessionFile | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const f = raw as Record<string, unknown>
  const session = f.session as Record<string, unknown> | undefined
  if (f.version !== 2 || !isSessionId(session?.id) || !Array.isArray(f.tasks)) return undefined
  const info = asSessionInfo(session)
  if (!info || typeof f.updatedAt !== 'string') return undefined
  const needsYou = asStrings(f.needsYou)
  const dismissed = asStrings(f.dismissed)
  if (!needsYou || !dismissed) return undefined
  const tasks = (f.tasks as unknown[]).filter(
    (t): t is Task =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as Task).id === 'string' &&
      typeof (t as Task).title === 'string' &&
      isStoredStatus((t as Task).status),
  )
  const seq = typeof f.seq === 'number' && Number.isFinite(f.seq) ? f.seq : 0
  const pipelines = asPipelines(f.pipelines)
  const cancelled = (Array.isArray(f.cancelled) ? f.cancelled : []).filter(
    (id): id is string => typeof id === 'string',
  )
  const agents = (Array.isArray(f.agents) ? f.agents : []).filter(
    (a): a is AgentEntry =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as AgentEntry).id === 'string' &&
      Array.isArray((a as AgentEntry).tasks),
  )
  return {
    ...(f as unknown as SessionFile),
    session: info,
    needsYou,
    dismissed,
    tasks,
    seq,
    pipelines,
    ...(cancelled.length > 0 ? { cancelled } : {}),
    ...(agents.length > 0 ? { agents } : {}),
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** How times read: 24-hour, 12-hour, or as the system's locale says. */
export type ClockStyle = '24h' | '12h' | 'system'

// Whether the system's locale reads time in 12 hours (Intl), else 24.
function systemIs12h(): boolean {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === true
  } catch {
    return false
  }
}

function hourOf(d: Date, clock: ClockStyle): { h: string; suffix: string } {
  const twelve = clock === '12h' || (clock === 'system' && systemIs12h())
  if (!twelve) return { h: pad(d.getHours()), suffix: '' }
  const h = d.getHours() % 12 || 12
  return { h: String(h), suffix: d.getHours() < 12 ? ' am' : ' pm' }
}

/** Local `HH:MM:SS` (or `h:MM:SS pm`) of a time in milliseconds. */
export function formatClock(ms: number, clock: ClockStyle = '24h'): string {
  const d = new Date(ms)
  const { h, suffix } = hourOf(d, clock)
  return `${h}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${suffix}`
}

/** Local `HH:MM` for today, `YYYY-MM-DD HH:MM` otherwise; '' for an unreadable time. */
export function formatTime(iso: string, nowMs: number, clock: ClockStyle = '24h'): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  const now = new Date(nowMs)
  const { h, suffix } = hourOf(d, clock)
  const hm = `${h}:${pad(d.getMinutes())}${suffix}`
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? hm : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/**
 * A scan's result folded into the store as it is NOW, not as it was when the scan began: the scan
 * read `before`, then listed and read files across several awaits, and a session's own save (a
 * progress_update answer, a SubagentStop) may have landed in between. Writing the scan's map
 * wholesale put that session's older copy back over its newer one — the pane showed the past
 * until the next tick read the file again, and overlapping ticks could land out of order. An entry
 * the store changed during the scan keeps the store's copy (with the scan's fresher sidecar).
 */
export function mergeScan(before: Loaded, current: Loaded, scanned: Loaded): Loaded {
  const merged: Loaded = { ...scanned }
  for (const [id, now] of Object.entries(current)) {
    if (now === before[id]) continue
    const seen = scanned[id]
    if (seen && seen.mtimeMs > now.mtimeMs) continue
    merged[id] = seen?.sidecar ? { ...now, sidecar: seen.sidecar } : now
  }
  return merged
}

/** How many finished tasks / agents an open Done lists before folding the rest behind "N older". */
export const DONE_SHOWN = 10
export const AGENTS_SHOWN = 5

/**
 * The `limit` newest items of `list` (by `stamp`, an ISO time), kept in the list's own order, and
 * how many older ones fold away. A session's history grows all day — 70 finished tasks and 59
 * finished agents by one evening — and an open Done that long pushed the Now line and the open
 * tasks out of a 20-row pane, which then looked frozen. Bounded, the live part always fits.
 */
export function capNewest<T>(
  list: readonly T[],
  limit: number,
  stamp: (item: T) => string | null | undefined,
): { shown: T[]; older: number } {
  if (list.length <= limit) return { shown: [...list], older: 0 }
  const keep = new Set(
    [...list]
      .sort((a, b) => (Date.parse(stamp(b) ?? '') || 0) - (Date.parse(stamp(a) ?? '') || 0))
      .slice(0, limit),
  )
  return { shown: list.filter(item => keep.has(item)), older: list.length - limit }
}

/** A live session idle this long, whose process is gone, is one that died without `session.end`. */
export const DEAD_AFTER_MS = 10 * 60_000

/**
 * Whether another session's file is worth a liveness check: live, written by a process on THIS
 * machine (a pid means nothing elsewhere), not this session, and idle for DEAD_AFTER_MS.
 */
export function needsLivenessCheck(
  file: SessionFile,
  me: string,
  host: string | undefined,
  nowMs: number,
): boolean {
  const s = file.session
  if (s.endedAt !== null || s.id === me || typeof s.pid !== 'number' || !host || s.host !== host) return false
  return nowMs - (Date.parse(file.updatedAt) || 0) >= DEAD_AFTER_MS
}

/** A session whose process died: ended as of its last write (when it last did anything). */
export function endDeadSession(file: SessionFile): SessionFile {
  return { ...file, session: { ...file.session, endedAt: file.updatedAt } }
}

/**
 * Time left for a list of steps, in minutes: once at least one step has finished, the observed pace —
 * the median of the finished steps' durations (each from the previous finish, the first from
 * `startedAt`) × the steps still open; before that, the agent's own guess, marked as one. Undefined
 * when nothing is open or nothing is known.
 */
export function timeLeft(
  steps: readonly { status: Status; doneAt?: string | null }[],
  startedAt: string,
  guessMin: number | undefined,
): { min: number; guess: boolean } | undefined {
  const open = steps.filter(s => !isClosed(s.status)).length
  if (open === 0) return undefined
  const finished = steps
    .map(s => (isClosed(s.status) && s.doneAt ? Date.parse(s.doneAt) : Number.NaN))
    .filter(ms => Number.isFinite(ms))
    .sort((a, b) => a - b)
  if (finished.length > 0) {
    let prev = Date.parse(startedAt)
    const durations = finished.map(ms => {
      const d = Math.max(0, ms - prev)
      prev = ms
      return d
    })
    durations.sort((a, b) => a - b)
    const mid = Math.floor(durations.length / 2)
    const median =
      durations.length % 2 === 1
        ? (durations[mid] as number)
        : ((durations[mid - 1] as number) + (durations[mid] as number)) / 2
    return { min: Math.max(1, Math.round((median * open) / 60_000)), guess: false }
  }
  return typeof guessMin === 'number' ? { min: guessMin, guess: true } : undefined
}

/** A removal a pane asked for, decoded from its sidecar entry. */
export type Removal =
  | { kind: 'task'; taskId: string }
  | { kind: 'step'; taskId: string; step: string }
  | { kind: 'agentTask'; agentId: string; taskId: string }
  | { kind: 'agent'; agentId: string }

/** The sidecar's `cancelled` entry for a removal (a plain task id stays a plain id). */
export function removalKey(r: Removal): string {
  switch (r.kind) {
    case 'task':
      return r.taskId
    case 'step':
      return `step:${r.taskId}:${r.step}`
    case 'agentTask':
      return `agent:${r.agentId}:${r.taskId}`
    case 'agent':
      return `agentall:${r.agentId}`
  }
}

export function parseRemoval(key: string): Removal {
  const [kind, a = '', ...rest] = key.split(':')
  if (kind === 'step' && rest.length > 0) return { kind: 'step', taskId: a, step: rest.join(':') }
  if (kind === 'agent' && rest.length > 0) return { kind: 'agentTask', agentId: a, taskId: rest.join(':') }
  if (kind === 'agentall') return { kind: 'agent', agentId: [a, ...rest].join(':') }
  return { kind: 'task', taskId: key }
}

/** Who a removal's notice goes to: the main loop, or the subagent it belongs to. */
export type RemovalNotice = { agentId?: string } & (
  | { what: 'step'; task: string; step: string }
  | { what: 'agentTask'; task: string }
  | { what: 'agent' }
)

/**
 * The owner folds the deeper removals (steps, a subagent's tasks, a whole subagent) into its file,
 * each once (its key joins `cancelled`): a step → `skipped` + `removedByUser` (counted out of n/m),
 * a subagent's task → skipped in ITS list, a whole subagent → every open task of it skipped and
 * `cancelledAt` set. The notices say whom to tell. Plain task ids are `cancelTasks`'.
 */
export function cancelDeeper(
  file: SessionFile,
  keys: readonly string[],
  nowIso: string,
  note: string,
): { file: SessionFile; notices: RemovalNotice[] } {
  const already = new Set(file.cancelled ?? [])
  const notices: RemovalNotice[] = []
  let tasks = file.tasks
  let agents = file.agents ?? []
  const done: string[] = []
  const skip = <T extends { status: Status }>(x: T): T => ({
    ...x,
    status: 'skipped',
    note,
    updatedAt: nowIso,
    doneAt: nowIso,
  })
  for (const key of keys) {
    if (already.has(key)) continue
    const r = parseRemoval(key)
    if (r.kind === 'task') continue
    if (r.kind === 'step') {
      const task = tasks.find(t => t.id === r.taskId)
      const step = task?.steps?.find(s => s.title === r.step && !isClosed(s.status))
      if (!task || !step) continue
      tasks = tasks.map(t =>
        t.id === task.id
          ? {
              ...t,
              steps: (t.steps ?? []).map(s =>
                s === step
                  ? { ...s, status: 'skipped' as const, removedByUser: true as const, doneAt: nowIso }
                  : s,
              ),
              updatedAt: nowIso,
            }
          : t,
      )
      notices.push({ what: 'step', task: task.title, step: step.title })
    } else if (r.kind === 'agentTask') {
      const agent = agents.find(a => a.id === r.agentId)
      const task = agent?.tasks.find(t => t.id === r.taskId && !isClosed(t.status))
      if (!agent || !task) continue
      agents = agents.map(a =>
        a.id === agent.id
          ? {
              ...a,
              tasks: a.tasks.map(t => (t === task ? skip(t) : t)),
              cancelled: [...(a.cancelled ?? []), task.id],
              updatedAt: nowIso,
            }
          : a,
      )
      notices.push({ what: 'agentTask', agentId: agent.id, task: task.title })
    } else {
      const agent = agents.find(a => a.id === r.agentId)
      if (!agent) continue
      // Not working (finished, or only waiting): ✕ dismisses it from every pane — nothing to stop.
      if (agent.endedAt !== null || agent.waiting) {
        agents = agents.filter(a => a.id !== agent.id)
        done.push(key)
        continue
      }
      agents = agents.map(a =>
        a.id === agent.id
          ? {
              ...a,
              tasks: a.tasks.map(t => (isClosed(t.status) ? t : skip(t))),
              cancelled: [...(a.cancelled ?? []), ...a.tasks.filter(t => !isClosed(t.status)).map(t => t.id)],
              cancelledAt: nowIso,
              updatedAt: nowIso,
            }
          : a,
      )
      notices.push({ what: 'agent', agentId: agent.id })
    }
    done.push(key)
  }
  // A ✕ recorded on an agent that turned out not to be working (it waited, or stopped since):
  // the person's intent was to get rid of it — dismissed.
  const pruned = agents.filter(a => !(a.cancelledAt && (a.endedAt !== null || a.waiting)))
  if (pruned.length !== agents.length) {
    agents = pruned
    if (done.length === 0) return { file: { ...file, agents, updatedAt: nowIso }, notices }
  }
  if (done.length === 0) return { file, notices }
  return {
    file: { ...file, tasks, agents, cancelled: [...already, ...done], updatedAt: nowIso },
    notices,
  }
}

/** The agent entry a task is linked to: by id, else by its label (the Agent call's description). */
export function linkedAgent(file: SessionFile, task: Pick<Task, 'agent'>): AgentEntry | undefined {
  const name = task.agent?.trim()
  if (!name) return undefined
  const agents = file.agents ?? []
  return agents.find(a => a.id === name) ?? agents.find(a => a.label === name)
}

/**
 * The coordinator's open `doing` task an Agent call's description names — only when exactly one
 * does (and none is linked yet): an unambiguous auto-link.
 */
export function autoLinkTarget(file: SessionFile, description: string): Task | undefined {
  const d = description.trim().toLowerCase()
  if (!d) return undefined
  const hits = file.tasks.filter(
    t =>
      t.status === 'doing' &&
      !t.agent &&
      (t.title.toLowerCase().includes(d) || d.includes(t.title.toLowerCase())),
  )
  return hits.length === 1 ? hits[0] : undefined
}

/** Whether an open task of the session is linked to this agent (by id or label). */
export function agentHasTask(file: SessionFile, agent: { id: string; label: string }): boolean {
  return file.tasks.some(
    t => !isClosed(t.status) && !!t.agent && (t.agent === agent.id || t.agent === agent.label),
  )
}

/** A task the plugin makes for an agent that works on none: `↳ <label>`, doing, linked to it. */
export function withAutoTask(file: SessionFile, label: string, nowIso: string): SessionFile {
  const seq = file.seq + 1
  return {
    ...file,
    seq,
    tasks: [
      ...file.tasks,
      {
        id: `t${seq}`,
        title: `↳ ${label}`,
        status: 'doing',
        agent: label,
        auto: true,
        createdAt: nowIso,
        updatedAt: nowIso,
        doneAt: null,
      },
    ],
    updatedAt: nowIso,
  }
}

/** Auto tasks whose agent the coordinator linked a task of its own to are no longer needed. */
export function dropReplacedAutoTasks(file: SessionFile): SessionFile {
  const linked = new Set(file.tasks.filter(t => !t.auto && t.agent).map(t => t.agent as string))
  const kept = file.tasks.filter(t => !(t.auto && t.agent && linked.has(t.agent)))
  return kept.length === file.tasks.length ? file : { ...file, tasks: kept }
}

/** A coordinator's SendMessage to a known agent (by id or label): queued on its entry until it picks
 *  it up. Same object when no agent matches. */
export function queueForAgent(file: SessionFile, to: string, text: string, nowIso: string): SessionFile {
  const agents = file.agents ?? []
  const agent = agents.find(a => a.id === to) ?? agents.find(a => a.label === to)
  if (!agent || !text.trim()) return file
  return {
    ...file,
    agents: agents.map(a =>
      a === agent ? { ...a, queued: [...(a.queued ?? []), text.trim()], updatedAt: nowIso } : a,
    ),
    updatedAt: nowIso,
  }
}

/** The agent acted (its report or tool call): what was queued for it is picked up. */
export function pickedUp(file: SessionFile, id: string): SessionFile {
  const agents = file.agents ?? []
  if (!agents.some(a => a.id === id && a.queued?.length)) return file
  return {
    ...file,
    agents: agents.map(a => {
      if (a.id !== id) return a
      const { queued: _q, ...rest } = a
      return rest
    }),
  }
}

/**
 * Removals across the task ↔ agent link: a removed session task whose linked agent still runs stops
 * that agent too (its whole work, as the agent ✕ does) — `stop` names them; a stopped agent, or one
 * whose last open step was removed, leaves its linked open session tasks without a worker —
 * `orphaned` names them for the coordinator (they are NOT skipped: the coordinator decides).
 */
export function crossLinks(
  file: SessionFile,
  removedTasks: readonly Task[],
  notices: readonly RemovalNotice[],
): { stop: { agentId: string; task: string; agent: string }[]; orphaned: { task: string; agent: string }[] } {
  const stop: { agentId: string; task: string; agent: string }[] = []
  for (const task of removedTasks) {
    const agent = linkedAgent(file, task)
    if (agent && agent.endedAt === null && !agent.cancelledAt)
      stop.push({ agentId: agent.id, task: task.title, agent: agent.label })
  }
  const orphaned: { task: string; agent: string }[] = []
  for (const n of notices) {
    if (!n.agentId || (n.what !== 'agent' && n.what !== 'agentTask')) continue
    const agent = file.agents?.find(a => a.id === n.agentId)
    if (!agent) continue
    const workLeft = agent.tasks.some(x => !isClosed(x.status))
    if (n.what === 'agentTask' && workLeft) continue // one of its steps: the agent's own business
    for (const task of file.tasks)
      if (
        !isClosed(task.status) &&
        linkedAgent(file, task)?.id === agent.id &&
        !orphaned.some(o => o.task === task.title)
      )
        orphaned.push({ task: task.title, agent: agent.label })
  }
  return { stop, orphaned }
}

/**
 * The cells `text` takes in a terminal: wide East-Asian and emoji characters 2, combining marks and
 * joiners 0, the rest 1 — to tell whether a title will be cut. (The engine does the cutting itself;
 * this only decides whether to show the whole title beneath an unfolded row.)
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (/\p{Mark}/u.test(ch) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue
    width += isWide(cp) || /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1
  }
  return width
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions B+
  )
}

// --- Tasks never stay in a state that is no longer true (0.23.2) ---------------------------------

const OPEN: readonly Status[] = ['todo', 'doing', 'blocked']
const PIPELINE_DONE = new Set(['success', 'failed', 'canceled'])

/** The pipeline a task waits on, when the session still watches it. */
export function taskPipeline(file: SessionFile, task: Task): Pipeline | undefined {
  return task.pipeline ? (file.pipelines ?? []).find(p => p.key === task.pipeline) : undefined
}

/** Whether something live tracks an open task: a linked pipeline still running. (A linked agent is
 *  the caller's to judge — it knows which agents run.) */
export function trackedByPipeline(file: SessionFile, task: Task): boolean {
  const p = taskPipeline(file, task)
  return p !== undefined && !PIPELINE_DONE.has(p.state)
}

/**
 * A push's pipeline links itself to the one task it closes: the session's single open `doing`
 * task of that repo (its `repo`, or the session's own project when it names none) that waits on no
 * running pipeline yet. None or several → no link (never a guess).
 */
export function linkPushedPipeline(
  file: SessionFile,
  key: string,
  repo: string,
  nowIso: string,
): { file: SessionFile; linked?: Task } {
  if (file.tasks.some(t => t.pipeline === key)) return { file }
  const ownRepo = file.session.project
  const candidates = file.tasks.filter(
    t => t.status === 'doing' && (t.repo ?? ownRepo) === repo && !trackedByPipeline(file, t),
  )
  if (candidates.length !== 1) return { file }
  const target = candidates[0] as Task
  const linked: Task = { ...target, pipeline: key, updatedAt: nowIso }
  return {
    file: { ...file, tasks: file.tasks.map(t => (t.id === target.id ? linked : t)), updatedAt: nowIso },
    linked,
  }
}

export type Settled = { task: Task; outcome: 'done' | 'failed'; pipeline: Pipeline }

/**
 * Open tasks whose linked pipeline finished close by themselves: green → `done` ("pipeline <id>
 * green"), red or canceled → `failed` (the failing jobs named). A status the agent set AFTER the
 * pipeline finished wins — the task is left as the agent put it.
 */
export function settleLinkedTasks(
  file: SessionFile,
  nowIso: string,
  notes: {
    green: (id: string) => string
    red: (id: string, jobs: string) => string
    canceled: (id: string) => string
  },
): { file: SessionFile; settled: Settled[] } {
  const settled: Settled[] = []
  const tasks = file.tasks.map(task => {
    if (!OPEN.includes(task.status)) return task
    const p = taskPipeline(file, task)
    if (!p || !PIPELINE_DONE.has(p.state)) return task
    const finished = Date.parse(p.pipelineFinishedAt ?? p.finishedAt ?? p.checkedAt ?? nowIso)
    if (Number.isFinite(finished) && Date.parse(task.updatedAt) > finished) return task
    const id = p.id !== null ? String(p.id) : p.key
    const green = p.state === 'success'
    const failedJobs = p.jobs.filter(j => j.state === 'failed').map(j => j.name)
    const note = green
      ? notes.green(id)
      : p.state === 'canceled'
        ? notes.canceled(id)
        : notes.red(id, failedJobs.join(', ') || '?')
    const { unconfirmed: _u, ...rest } = task
    const next: Task = { ...rest, status: green ? 'done' : 'failed', note, updatedAt: nowIso, doneAt: nowIso }
    settled.push({ task: next, outcome: green ? 'done' : 'failed', pipeline: p })
    return next
  })
  if (settled.length === 0) return { file, settled }
  return { file: { ...file, tasks, updatedAt: nowIso }, settled }
}

/** Open tasks not updated for `minAgeMs`, nothing live tracking them, not already asked about in
 *  this state (`told`: task id → the `updatedAt` it was asked about). */
export function staleTasks(
  file: SessionFile,
  nowMs: number,
  minAgeMs: number,
  told: ReadonlyMap<string, string>,
  tracked: (task: Task) => boolean,
): Task[] {
  return file.tasks.filter(
    t =>
      OPEN.includes(t.status) &&
      nowMs - Date.parse(t.updatedAt) >= minAgeMs &&
      told.get(t.id) !== t.updatedAt &&
      !tracked(t),
  )
}

/** The end-of-turn check's list: `doing` tasks (they claim active work) not updated since the turn
 *  began and for at least `minAgeMs`, nothing live tracking them. `todo` has not started and
 *  `blocked` carries its reason: those get the staleness nudge, never a blocked stop. */
export function untouchedDoing(
  file: SessionFile,
  turnStartMs: number,
  nowMs: number,
  minAgeMs: number,
  tracked: (task: Task) => boolean,
): Task[] {
  return file.tasks.filter(t => {
    const at = Date.parse(t.updatedAt)
    return t.status === 'doing' && at < turnStartMs && nowMs - at >= minAgeMs && !tracked(t)
  })
}

/** A turn ended past the check with these still untouched: marked until their next update. */
export function markUnconfirmed(file: SessionFile, ids: readonly string[]): SessionFile {
  if (!file.tasks.some(t => ids.includes(t.id) && !t.unconfirmed)) return file
  return {
    ...file,
    tasks: file.tasks.map(t => (ids.includes(t.id) ? { ...t, unconfirmed: true as const } : t)),
  }
}

/** One signature per list (ids and the state they were seen in): the same list never blocks twice. */
export function listSignature(tasks: readonly Task[]): string {
  return tasks
    .map(t => `${t.id}@${t.updatedAt}`)
    .sort()
    .join('|')
}

// --- Agents under their repo (0.23.2) -------------------------------------------------------------

/** The group an agent whose repo cannot be told lands in (never mixed into a real repo's). */
export const OTHER_REPO = '\u0000other'

/** The repo an agent works on: the repo of the session task linked to it, else the one its tool
 *  calls ran in (`agent.repo`, recorded from their cwd — a worktree's is the repo it belongs to),
 *  else none. */
export function agentRepo(file: SessionFile, agent: AgentEntry): string | undefined {
  const task = file.tasks.find(t => t.agent && linkedAgent(file, t)?.id === agent.id)
  if (task) return task.repo || file.session.project
  return agent.repo || undefined
}

/**
 * Open tasks and running agents together, grouped by repo — the layout a session with work in more
 * than one repo gets (each repo: its tasks, then its agents). An agent with no repo goes to
 * `OTHER_REPO`. Groups in first-seen order: tasks' repos first, then agents' own.
 */
export function groupWorkByRepo(
  file: SessionFile,
  tasks: readonly Task[],
  agents: readonly AgentEntry[],
): { repo: string; tasks: Task[]; agents: AgentEntry[] }[] {
  const groups: { repo: string; tasks: Task[]; agents: AgentEntry[] }[] = []
  const at = (repo: string) => {
    let g = groups.find(x => x.repo === repo)
    if (!g) {
      g = { repo, tasks: [], agents: [] }
      groups.push(g)
    }
    return g
  }
  for (const task of tasks) at(task.repo || file.session.project).tasks.push(task)
  for (const agent of agents) at(agentRepo(file, agent) ?? OTHER_REPO).agents.push(agent)
  return groups
}

/** A repo's folder name from `git rev-parse --git-common-dir` (absolute): `/w/app/.git` → `app`; a
 *  bare repo's own folder (`/srv/app.git` → `app`). A worktree's common dir is its repo's. */
export function repoFromCommonDir(commonDir: string): string | undefined {
  const parts = commonDir
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
  const last = parts.at(-1)
  if (!last) return undefined
  if (last === '.git') return parts.at(-2)
  return last.replace(/\.git$/, '') || undefined
}

// --- What a wait is about (0.23.2) ------------------------------------------------------------------

const GENERIC_PERMISSION = /^claude needs your permission\b/i

/** One line naming a tool call: its tool and the input that matters — Bash's command, a file tool's
 *  path, a fetch's URL, else the first string argument — cut with "…" past `max` characters. */
export function toolCallSummary(tool: string, args: Record<string, unknown>, max = 80): string {
  const pick = ['command', 'file_path', 'path', 'url', 'pattern', 'description', 'prompt']
    .map(k => args[k])
    .find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const any = pick ?? Object.values(args).find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const line = (any ?? '').trim().split(/\r?\n/)[0] ?? ''
  const cut = line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
  return cut ? `${tool} — ${cut}` : tool
}

/** A permission prompt's message is the generic one ("Claude needs your permission…"): the plugin's
 *  own record of the call says what it is about instead. */
export function isGenericPermission(message: string): boolean {
  return message.trim() === '' || GENERIC_PERMISSION.test(message.trim())
}

/** The automatic Needs-you item a task, an agent or an agent's step is waiting under: the main
 *  loop's names its task (`taskId`); a subagent's its agent — that agent's row, its `doing` step and
 *  the session task linked to it. */
export function waitFor(
  file: SessionFile,
  target: { taskId?: string; agentId?: string; task?: Task },
): NonNullable<SessionFile['autoNeeds']>[number] | undefined {
  const needs = file.autoNeeds ?? []
  if (target.agentId) return needs.find(n => n.agentId === target.agentId)
  if (target.task) {
    const linked = target.task.agent ? linkedAgent(file, target.task) : undefined
    return needs.find(n => (n.taskId && n.taskId === target.task?.id) || (linked && n.agentId === linked.id))
  }
  return target.taskId ? needs.find(n => n.taskId === target.taskId) : undefined
}

/** The asks a report sends: their texts (`needsYou`, what every reader shows) and, for the ones that
 *  name a task or an agent, the links (`needLinks`). A blank ask is refused. */
function needsFrom(
  items: readonly NeedInput[],
  errors: string[],
): { needsYou: string[]; needLinks?: NonNullable<SessionFile['needLinks']> } {
  const needsYou: string[] = []
  const needLinks: NonNullable<SessionFile['needLinks']> = []
  items.forEach((item, i) => {
    const text = (typeof item === 'string' ? item : (item?.text ?? '')).trim()
    if (!text) {
      errors.push(`needsYou[${i}]: an ask needs its text`)
      return
    }
    needsYou.push(text)
    if (typeof item === 'object' && item && (item.task?.trim() || item.agent?.trim()))
      needLinks.push({
        text,
        ...(item.task?.trim() ? { task: item.task.trim() } : {}),
        ...(item.agent?.trim() ? { agent: item.agent.trim() } : {}),
      })
  })
  return { needsYou, ...(needLinks.length > 0 ? { needLinks } : { needLinks: [] }) }
}

/** What a task, an agent or an agent's step waits on the person for — an automatic wait (a
 *  permission prompt, a question) or an ask the agent linked to it — as its reason, or none. */
export function attentionFor(
  file: SessionFile,
  target: { task?: Task; agent?: AgentEntry },
  reasons: { permission: (what: string) => string; reply: () => string },
): string | undefined {
  const auto = target.agent
    ? waitFor(file, { agentId: target.agent.id })
    : target.task
      ? waitFor(file, { task: target.task })
      : undefined
  if (auto) return auto.kind === 'permission' ? reasons.permission(auto.what ?? '') : reasons.reply()
  const agent = target.agent ?? (target.task?.agent ? linkedAgent(file, target.task) : undefined)
  const link = (file.needLinks ?? []).find(
    l =>
      file.needsYou.includes(l.text) &&
      ((target.task && l.task === target.task.id) ||
        (agent && l.agent !== undefined && (l.agent === agent.label || l.agent === agent.id))),
  )
  return link?.text
}

/** The tool a generic permission notice names ("…to use Bash"), if any. */
export function noticeTool(message: string): string | undefined {
  return /to use ([\w.:-]+)/i.exec(message)?.[1]
}
