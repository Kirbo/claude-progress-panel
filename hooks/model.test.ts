import { expect, test } from 'claude-code/testing'
import type { SessionFile, Task } from './model'
import {
  addDismissals,
  applyUpdate,
  dismissTasks,
  formatClock,
  formatTime,
  isBlank,
  mergeSidecar,
  newSession,
  parseSessionFile,
  parseSidecar,
  pruneDone,
  sortTasks,
  visibleTasks,
} from './model'

const T0 = Date.UTC(2026, 10, 6, 20, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = 3_600_000

function fresh(): SessionFile {
  return newSession({ id: 's1', project: 'demo', cwd: '/w/demo' }, iso(T0))
}

function task(over: Partial<Task>): Task {
  return {
    id: 't1',
    title: 'Task',
    status: 'todo',
    createdAt: iso(T0),
    updatedAt: iso(T0),
    doneAt: null,
    ...over,
  }
}

test('applyUpdate: now and needsYou replace, new tasks get ids and stamps', () => {
  const { file, errors } = applyUpdate(
    fresh(),
    {
      now: 'working',
      needsYou: ['a decision'],
      tasks: [{ title: 'One' }, { title: 'Two', status: 'doing' }],
    },
    iso(T0 + 1000),
  )
  expect(errors).toEqual([])
  expect(file.now).toBe('working')
  expect(file.needsYou).toEqual(['a decision'])
  expect(file.tasks.map(t => [t.id, t.title, t.status])).toEqual([
    ['t1', 'One', 'todo'],
    ['t2', 'Two', 'doing'],
  ])
  expect(file.tasks[0]?.createdAt).toBe(iso(T0 + 1000))
  expect(file.updatedAt).toBe(iso(T0 + 1000))
})

test('applyUpdate: upsert by id or exact title; doneAt set on done and cleared on reopen', () => {
  let { file } = applyUpdate(fresh(), { tasks: [{ title: 'One' }] }, iso(T0))
  ;({ file } = applyUpdate(file, { tasks: [{ id: 't1', status: 'done', note: 'shipped' }] }, iso(T0 + HOUR)))
  expect(file.tasks[0]).toMatchObject({ status: 'done', note: 'shipped', doneAt: iso(T0 + HOUR) })
  ;({ file } = applyUpdate(file, { tasks: [{ title: 'One', status: 'doing' }] }, iso(T0 + 2 * HOUR)))
  expect(file.tasks).toHaveLength(1)
  expect(file.tasks[0]).toMatchObject({ status: 'doing', doneAt: null, createdAt: iso(T0) })
})

test('applyUpdate: an unchanged done task keeps its doneAt', () => {
  let { file } = applyUpdate(fresh(), { tasks: [{ title: 'One', status: 'done' }] }, iso(T0))
  ;({ file } = applyUpdate(file, { tasks: [{ id: 't1', status: 'done', note: 'later' }] }, iso(T0 + HOUR)))
  expect(file.tasks[0]?.doneAt).toBe(iso(T0))
})

test('applyUpdate: remove, unknown ids and bad input are reported, not fatal', () => {
  let { file } = applyUpdate(fresh(), { tasks: [{ title: 'One' }, { title: 'Two' }] }, iso(T0))
  const out = applyUpdate(
    file,
    {
      remove: ['t1', 'nope'],
      tasks: [{ id: 't9', status: 'done' }, { note: 'no title' }, { title: 'X', status: 'odd' }],
    },
    iso(T0),
  )
  file = out.file
  expect(file.tasks.map(t => t.id)).toEqual(['t2'])
  expect(out.errors).toEqual([
    'remove: no task nope',
    'tasks[0]: no task t9 (give a title to create one)',
    'tasks[1]: a new task needs a title',
    'tasks[2]: status must be one of todo, doing, blocked, done, skipped',
  ])
})

test('ids never repeat, even after a removal', () => {
  let { file } = applyUpdate(fresh(), { tasks: [{ title: 'One' }, { title: 'Two' }] }, iso(T0))
  ;({ file } = applyUpdate(file, { remove: ['t2'] }, iso(T0)))
  ;({ file } = applyUpdate(file, { tasks: [{ title: 'Three' }] }, iso(T0)))
  expect(file.tasks.map(t => t.id)).toEqual(['t1', 't3'])
})

test('a dismissed done task stays gone until it is reopened', () => {
  let { file } = applyUpdate(fresh(), { tasks: [{ title: 'One', status: 'done' }] }, iso(T0))
  file = dismissTasks(file, ['t1'])
  expect(file.tasks).toEqual([])
  ;({ file } = applyUpdate(file, { tasks: [{ id: 't1', title: 'One', status: 'done' }] }, iso(T0)))
  expect(file.tasks).toEqual([])
  ;({ file } = applyUpdate(file, { tasks: [{ id: 't1', title: 'One', status: 'doing' }] }, iso(T0)))
  expect(file.tasks.map(t => t.status)).toEqual(['doing'])
  expect(file.dismissed).toEqual([])
})

test('sidecar dismissals hide only the completion they name; the owner merges them', () => {
  const file = {
    ...fresh(),
    tasks: [
      task({ id: 't1', status: 'done', doneAt: iso(T0) }),
      task({ id: 't2', status: 'done', doneAt: iso(T0 + HOUR) }),
      task({ id: 't3', status: 'doing' }),
    ],
  }
  const entries = addDismissals([], [file.tasks[0] as Task, file.tasks[1] as Task])
  expect(addDismissals(entries, [file.tasks[0] as Task])).toEqual(entries)

  const stale = [{ id: 't2', doneAt: iso(T0) }, ...entries.slice(0, 1)]
  expect(visibleTasks(file, stale).map(t => t.id)).toEqual(['t2', 't3'])
  expect(visibleTasks(file, [{ id: 't3', doneAt: null }]).map(t => t.id)).toEqual(['t1', 't2', 't3'])

  const merged = mergeSidecar(file, stale)
  expect(merged.tasks.map(t => t.id)).toEqual(['t2', 't3'])
  expect(merged.dismissed).toEqual(['t1'])
  expect(mergeSidecar(file, [])).toBe(file)
})

test('parseSidecar accepts a v1 sidecar, drops bad entries, refuses anything else', () => {
  const ok = { version: 1, sessionId: 's1', entries: [{ id: 't1', doneAt: iso(T0) }, { id: 5 }, null] }
  expect(parseSidecar(JSON.stringify(ok))?.entries).toEqual([{ id: 't1', doneAt: iso(T0) }])
  expect(parseSidecar('{ nope')).toBeUndefined()
  expect(parseSidecar(JSON.stringify({ version: 2, sessionId: 's1', entries: [] }))).toBeUndefined()
  expect(parseSidecar('null')).toBeUndefined()
})

test("parseSidecar reads the panes' refreshed pipelines, keeping only well-formed ones", () => {
  const pipe = {
    key: 'g/a#1',
    project: 'g/a',
    id: 1,
    label: 'a',
    state: 'success',
    jobs: [],
    addedAt: iso(T0),
    checkedAt: iso(T0),
  }
  const text = JSON.stringify({
    version: 1,
    sessionId: 's1',
    entries: [],
    pipelines: [pipe, { key: 2 }, null],
  })
  expect(parseSidecar(text)?.pipelines).toEqual([pipe])
  // A sidecar from before 0.11.1 has no pipelines: none, not an error.
  expect(parseSidecar(JSON.stringify({ version: 1, sessionId: 's1', entries: [] }))?.pipelines).toEqual([])
  expect(
    parseSidecar(JSON.stringify({ version: 1, sessionId: 's1', entries: [], pipelines: 'x' }))?.pipelines,
  ).toEqual([])
})

test('pruneDone removes done tasks older than the limit; 0 hours never prunes', () => {
  const file = {
    ...fresh(),
    tasks: [
      task({ id: 't1', status: 'done', doneAt: iso(T0) }),
      task({ id: 't2', status: 'done', doneAt: iso(T0 + 5 * HOUR) }),
      task({ id: 't3', status: 'doing' }),
    ],
  }
  expect(pruneDone(file, 0, T0 + 100 * HOUR)).toBe(file)
  expect(pruneDone(file, 6, T0 + 7 * HOUR).tasks.map(t => t.id)).toEqual(['t2', 't3'])
  expect(pruneDone(file, 6, T0 + HOUR)).toBe(file)
})

test('sortTasks orders by status, title, created or done', () => {
  const tasks = [
    task({ id: 'a', title: 'beta', status: 'todo', createdAt: iso(T0 + 3) }),
    task({ id: 'b', title: 'Alpha', status: 'doing', createdAt: iso(T0 + 2) }),
    task({ id: 'c', title: 'gamma', status: 'blocked', createdAt: iso(T0 + 1) }),
  ]
  expect(sortTasks(tasks, 'status').map(t => t.id)).toEqual(['c', 'b', 'a'])
  expect(sortTasks(tasks, 'title').map(t => t.id)).toEqual(['b', 'a', 'c'])
  expect(sortTasks(tasks, 'created').map(t => t.id)).toEqual(['c', 'b', 'a'])
  const done = [
    task({ id: 'x', status: 'done', doneAt: iso(T0 + 1) }),
    task({ id: 'y', status: 'done', doneAt: iso(T0 + 9) }),
  ]
  expect(sortTasks(done, 'done').map(t => t.id)).toEqual(['y', 'x'])
  expect(sortTasks(done, 'status').map(t => t.id)).toEqual(['y', 'x'])
})

test('parseSessionFile accepts a v2 file and refuses anything else', () => {
  const file = fresh()
  expect(parseSessionFile(JSON.stringify(file))).toEqual(file)
  expect(parseSessionFile('{ nope')).toBeUndefined()
  expect(parseSessionFile(JSON.stringify({ version: 1, now: 'x' }))).toBeUndefined()
  expect(parseSessionFile(JSON.stringify({ ...file, tasks: 'x' }))).toBeUndefined()
  const loose = parseSessionFile(JSON.stringify({ ...file, needsYou: undefined, dismissed: undefined }))
  expect(loose?.needsYou).toEqual([])
  expect(loose?.dismissed).toEqual([])
})

test('formatTime: HH:MM today, date and time otherwise', () => {
  const at = new Date(2026, 10, 6, 9, 5).getTime()
  expect(formatTime(new Date(at).toISOString(), at + HOUR)).toBe('09:05')
  expect(formatTime(new Date(at).toISOString(), at + 30 * HOUR)).toBe('2026-11-06 09:05')
  expect(formatTime('garbage', at)).toBe('')
})

test('formatClock: local HH:MM:SS', () => {
  expect(formatClock(new Date(2026, 10, 6, 9, 5, 7).getTime())).toBe('09:05:07')
})

test('isBlank: nothing reported — no tasks, now, asks or pipelines; any one of them is something', () => {
  const blank = fresh()
  expect(isBlank(blank)).toBe(true)
  expect(isBlank({ ...blank, now: '' })).toBe(true)
  expect(isBlank({ ...blank, dismissed: ['t1'], seq: 1 })).toBe(true)
  expect(isBlank({ ...blank, now: 'Reading' })).toBe(false)
  expect(isBlank({ ...blank, needsYou: ['Pick'] })).toBe(false)
  expect(isBlank({ ...blank, tasks: [task({})] })).toBe(false)
  const pipelines = [{ key: 'g/p#1' }] as unknown as SessionFile['pipelines']
  expect(isBlank({ ...blank, pipelines })).toBe(false)
})
