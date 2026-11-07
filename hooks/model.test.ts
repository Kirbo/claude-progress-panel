import { expect, test } from 'claude-code/testing'
import type { SessionFile, Task } from './model'
import {
  addDismissals,
  applyUpdate,
  cancelTasks,
  dismissTasks,
  formatClock,
  formatTime,
  isBlank,
  matchesTask,
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
  // The plan: the order the session lists them in (the order it will do them).
  expect(sortTasks(tasks, 'plan').map(t => t.id)).toEqual(['a', 'b', 'c'])
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

test("applyUpdate's `order` puts the named tasks first, in that order; the rest keep theirs after", () => {
  const at = iso(T0)
  let file = applyUpdate(
    fresh(),
    { tasks: [{ title: 'one' }, { title: 'two' }, { title: 'three' }, { title: 'four' }] },
    at,
  ).file
  expect(file.tasks.map(t => t.id)).toEqual(['t1', 't2', 't3', 't4'])
  // By id or exact title; new tasks in the same call can be placed too.
  const r = applyUpdate(file, { tasks: [{ title: 'zero' }], order: ['t3', 'zero', 't1', 'nope'] }, at)
  file = r.file
  expect(file.tasks.map(t => t.title)).toEqual(['three', 'zero', 'one', 'two', 'four'])
  expect(r.errors).toEqual(['order: no task nope'])
  // Listed twice: the first place counts.
  expect(applyUpdate(file, { order: ['t2', 't2'] }, at).file.tasks.map(t => t.id)).toEqual([
    't2',
    't3',
    't5',
    't1',
    't4',
  ])
})

test('applyUpdate: a task takes a longer detail and subtasks (steps), each patch replacing them', () => {
  const at = iso(T0)
  let r = applyUpdate(
    fresh(),
    {
      tasks: [
        {
          title: 'Ship it',
          detail: 'Push, then watch CI.\nInstall afterwards.',
          steps: [{ title: 'push', status: 'done' }, { title: 'CI' }],
        },
      ],
    },
    at,
  )
  expect(r.errors).toEqual([])
  expect(r.file.tasks[0]).toMatchObject({
    detail: 'Push, then watch CI.\nInstall afterwards.',
    steps: [
      { title: 'push', status: 'done' },
      { title: 'CI', status: 'todo' },
    ],
  })
  // A later patch replaces the steps whole; '' / [] clear them; bad steps are reported.
  r = applyUpdate(
    r.file,
    {
      tasks: [
        {
          id: 't1',
          steps: [{ title: 'CI', status: 'doing' }, { title: '' }, { title: 'x', status: 'nope' }],
        },
      ],
    },
    at,
  )
  expect(r.file.tasks[0]?.steps).toEqual([{ title: 'CI', status: 'doing' }])
  expect(r.errors).toEqual([
    'tasks[0].steps[1]: a step needs a title',
    'tasks[0].steps[2]: status must be one of todo, doing, blocked, done, skipped',
  ])
  r = applyUpdate(r.file, { tasks: [{ id: 't1', detail: '', steps: [] }] }, at)
  expect(r.file.tasks[0]?.detail).toBeUndefined()
  expect(r.file.tasks[0]?.steps).toBeUndefined()
})

test('matchesTask: case-insensitive over title, note, detail and step titles; blank matches all', () => {
  const t = task({
    id: 'a',
    title: 'Ship',
    note: 'after CI',
    detail: 'Tag v1',
    steps: [{ title: 'Push', status: 'done' }],
  })
  for (const q of ['ship', 'ci', 'TAG', 'push', '', '  ']) expect(matchesTask(t, q)).toBe(true)
  expect(matchesTask(t, 'deploy')).toBe(false)
})

test('applyUpdate: a task takes the repo it belongs to; "" clears it', () => {
  const at = iso(T0)
  let file = applyUpdate(fresh(), { tasks: [{ title: 'x', repo: ' claude-progress-panel ' }] }, at).file
  expect(file.tasks[0]?.repo).toBe('claude-progress-panel')
  file = applyUpdate(file, { tasks: [{ id: 't1', repo: '' }] }, at).file
  expect(file.tasks[0]?.repo).toBeUndefined()
})

test('cancelTasks: open tasks the person removed become skipped, noted, and are never cancelled twice', () => {
  const at = iso(T0)
  const file = applyUpdate(
    fresh(),
    { tasks: [{ title: 'one' }, { title: 'two', status: 'doing' }, { title: 'done one', status: 'done' }] },
    at,
  ).file
  const r = cancelTasks(file, ['t1', 't2', 't3', 'nope'], iso(T0 + 1000), 'removed in the pane')
  expect(r.removed.map(t => t.id)).toEqual(['t1', 't2'])
  expect(r.file.tasks.map(t => [t.id, t.status, t.note])).toEqual([
    ['t1', 'skipped', 'removed in the pane'],
    ['t2', 'skipped', 'removed in the pane'],
    ['t3', 'done', undefined],
  ])
  expect(r.file.tasks[0]?.doneAt).toBe(iso(T0 + 1000))
  expect(r.file.cancelled).toEqual(['t1', 't2'])
  // Re-opened by the session after it was told: a stale sidecar entry never cancels it again.
  const reopened = applyUpdate(r.file, { tasks: [{ id: 't1', status: 'doing' }] }, at).file
  const again = cancelTasks(reopened, ['t1'], at, 'x')
  expect(again.removed).toEqual([])
  expect(again.file).toBe(reopened)
})

test('visibleTasks hides an open task a pane removed, before its session has folded it in', () => {
  const at = iso(T0)
  const file = applyUpdate(fresh(), { tasks: [{ title: 'one' }, { title: 'two' }] }, at).file
  expect(visibleTasks(file, [], ['t1']).map(t => t.id)).toEqual(['t2'])
  expect(visibleTasks(file, []).map(t => t.id)).toEqual(['t1', 't2'])
})

test('parseSidecar and parseSessionFile read the removals (strings only)', () => {
  const side = parseSidecar(
    JSON.stringify({ version: 1, sessionId: 's1', entries: [], cancelled: ['t1', 2, 't3'] }),
  )
  expect(side?.cancelled).toEqual(['t1', 't3'])
  expect(parseSidecar(JSON.stringify({ version: 1, sessionId: 's1', entries: [] }))?.cancelled).toEqual([])
  const file = parseSessionFile(JSON.stringify({ ...fresh(), cancelled: ['t2'] }))
  expect(file?.cancelled).toEqual(['t2'])
})
