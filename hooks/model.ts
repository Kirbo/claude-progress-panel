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

export type { Dismissal, SessionFile, SessionInfo, SidecarFile, Status, Task }

export const STATUSES = ['todo', 'doing', 'blocked', 'done', 'skipped'] as const satisfies readonly Status[]

// `plan` first: the default, the order the session lists its tasks in — the order it will do them.
export const SORTS = ['plan', 'status', 'title', 'created', 'done'] as const
export type SortBy = (typeof SORTS)[number]

export type StepInput = { title?: string; status?: string }
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
}
export type UpdateInput = {
  now?: string
  needsYou?: string[]
  tasks?: TaskInput[]
  remove?: string[]
  /** Task ids (or exact titles) in the order the session will do them; the rest keep theirs after. */
  order?: string[]
  /** A subagent's estimate of the minutes it still needs. */
  eta?: number
}

export function isClosed(status: Status): boolean {
  return status === 'done' || status === 'skipped'
}

function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
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
    const { detail: _d, steps: _s, repo: _r, ...kept } = old
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
      ...(input.needsYou !== undefined ? { needsYou: [...input.needsYou] } : {}),
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

/** The well-formed pipelines of a stored list (a session file's, or a sidecar's refreshed copies). */
function asPipelines(value: unknown): Pipeline[] {
  return (Array.isArray(value) ? value : []).filter(
    (p): p is Pipeline =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as Pipeline).key === 'string' &&
      typeof (p as Pipeline).project === 'string' &&
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

const STATUS_ORDER: Record<Status, number> = { blocked: 0, doing: 1, todo: 2, done: 3, skipped: 4 }
const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0)

/**
 * A session's tasks by repo, each repo where its first task stands (`repo` absent = `own`); one
 * group when they all share one repo.
 */
export function groupByRepo(tasks: readonly Task[], own: string): { repo: string; tasks: Task[] }[] {
  const groups: { repo: string; tasks: Task[] }[] = []
  for (const task of tasks) {
    const repo = task.repo || own
    const group = groups.find(g => g.repo === repo)
    if (group) group.tasks.push(task)
    else groups.push({ repo, tasks: [task] })
  }
  return groups
}

/** A task's detail and steps after a patch: given ones replace, '' / [] clear, absent ones stay. */
function extras(
  old: Pick<Task, 'detail' | 'steps' | 'repo'>,
  patch: TaskInput,
  i: number,
  errors: string[],
  nowIso: string,
): Pick<Task, 'detail' | 'steps' | 'repo'> {
  const detail = patch.detail !== undefined ? patch.detail : old.detail
  const repo = patch.repo !== undefined ? patch.repo.trim() : old.repo
  let steps = old.steps
  if (patch.steps !== undefined) {
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
        steps.push({ title, status, ...(doneAt ? { doneAt } : {}) })
      }
    }
  }
  return {
    ...(detail ? { detail } : {}),
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...(repo ? { repo } : {}),
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
    now: old?.now ?? null,
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
    ...(eta !== undefined ? { etaMin: eta } : {}),
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

/**
 * The session's subagents folded into its entries, so one that never reports (an agent without the
 * progress tool, e.g. a read-only reviewer) still shows under Agents while it runs: a running one not
 * yet known gets an entry labelled by its description, a known one the list says ended is finished.
 * An agent the list no longer names is left as it is (SubagentStop finishes it). Unchanged when
 * nothing differs, so the caller can skip the write.
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
    } else if (ended && known.endedAt === null) {
      agents = agents.map(x => (x.id === a.id ? { ...x, endedAt: nowIso, updatedAt: nowIso } : x))
      changed = true
    }
  }
  return changed ? { ...file, agents, updatedAt: nowIso } : file
}

/** The subagent that stopped, marked finished (unchanged when it is unknown or already finished). */
export function endAgent(file: SessionFile, id: string, nowIso: string): SessionFile {
  const agent = file.agents?.find(a => a.id === id)
  if (!agent || agent.endedAt !== null) return file
  return {
    ...file,
    agents: (file.agents ?? []).map(a => (a.id === id ? { ...a, endedAt: nowIso, updatedAt: nowIso } : a)),
    updatedAt: nowIso,
  }
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
  if (f.version !== 2 || typeof session?.id !== 'string' || !Array.isArray(f.tasks)) return undefined
  const needsYou = asStrings(f.needsYou)
  const dismissed = asStrings(f.dismissed)
  if (!needsYou || !dismissed) return undefined
  const tasks = (f.tasks as unknown[]).filter(
    (t): t is Task =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as Task).id === 'string' &&
      typeof (t as Task).title === 'string' &&
      isStatus((t as Task).status),
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
      if (!agent || agent.endedAt !== null) continue
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
  if (done.length === 0) return { file, notices }
  return {
    file: { ...file, tasks, agents, cancelled: [...already, ...done], updatedAt: nowIso },
    notices,
  }
}
