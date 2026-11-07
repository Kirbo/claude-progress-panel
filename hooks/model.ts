// The session file and every pure operation on it — no I/O here (see store.ts for that).

import type { Dismissal, Pipeline, SessionFile, SessionInfo, SidecarFile, Status, Step, Task } from '../types'

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
        ...extras({}, patch, i, errors),
        createdAt: nowIso,
        updatedAt: nowIso,
        doneAt: isClosed(created) ? nowIso : null,
      })
      return
    }

    const old = tasks[at] as Task
    const next = status ?? old.status
    const doneAt = isClosed(next) ? (isClosed(old.status) ? old.doneAt : nowIso) : null
    const { detail: _d, steps: _s, ...kept } = old
    tasks[at] = {
      ...kept,
      ...extras(old, patch, i, errors),
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
export function visibleTasks(file: SessionFile, entries: readonly Dismissal[]): Task[] {
  return file.tasks.filter(task => !isDismissedBy(task, entries))
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
  return { version: 1, sessionId: f.sessionId, entries, pipelines: asPipelines(f.pipelines) }
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
    file.tasks.length === 0 && !file.now && file.needsYou.length === 0 && (file.pipelines ?? []).length === 0
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

/** A task's detail and steps after a patch: given ones replace, '' / [] clear, absent ones stay. */
function extras(
  old: Pick<Task, 'detail' | 'steps'>,
  patch: TaskInput,
  i: number,
  errors: string[],
): Pick<Task, 'detail' | 'steps'> {
  const detail = patch.detail !== undefined ? patch.detail : old.detail
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
        steps.push({ title, status: (step.status as Status | undefined) ?? 'todo' })
      }
    }
  }
  return { ...(detail ? { detail } : {}), ...(steps && steps.length > 0 ? { steps } : {}) }
}

/** How many of a task's steps are closed, of how many. */
export function stepCounts(task: Pick<Task, 'steps'>): { closed: number; total: number } {
  const steps = task.steps ?? []
  return { closed: steps.filter(s => isClosed(s.status)).length, total: steps.length }
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
  return { ...(f as unknown as SessionFile), needsYou, dismissed, tasks, seq, pipelines }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local `HH:MM:SS` of a time in milliseconds. */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Local `HH:MM` for today, `YYYY-MM-DD HH:MM` otherwise; '' for an unreadable time. */
export function formatTime(iso: string, nowMs: number): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  const now = new Date(nowMs)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? hm : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}
