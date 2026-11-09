import { expect, test } from 'claude-code/testing'
import type { SessionFile, Task } from './model'
import {
  addDismissals,
  applyAgentUpdate,
  applyUpdate,
  cancelTasks,
  capNewest,
  DEAD_AFTER_MS,
  dismissTasks,
  displayWidth,
  endAgent,
  endDeadSession,
  formatClock,
  formatTime,
  isBlank,
  isClosed,
  matchesTask,
  mergeScan,
  mergeSidecar,
  needsLivenessCheck,
  newSession,
  parseSessionFile,
  parseSidecar,
  pruneDone,
  reopenAgent,
  sortTasks,
  splitMatches,
  syncAgents,
  timeLeft,
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
    'tasks[2]: status must be one of todo, doing, blocked, done, skipped, failed',
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
    'tasks[0].steps[2]: status must be one of todo, doing, blocked, done, skipped, failed',
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

test('splitMatches cuts a text around every case-insensitive hit of the query; blank = one plain part', () => {
  expect(splitMatches('Fix the Panel filter panel', 'panel')).toEqual([
    { text: 'Fix the ', hit: false },
    { text: 'Panel', hit: true },
    { text: ' filter ', hit: false },
    { text: 'panel', hit: true },
  ])
  expect(splitMatches('abc', '  ')).toEqual([{ text: 'abc', hit: false }])
  expect(splitMatches('abc', 'x')).toEqual([{ text: 'abc', hit: false }])
  expect(splitMatches('aaa', 'aa')).toEqual([
    { text: 'aa', hit: true },
    { text: 'a', hit: false },
  ])
})

test('applyAgentUpdate upserts one agent entry from a patch, never touching the session tasks', () => {
  const at = iso(T0)
  let file = applyAgentUpdate(
    fresh(),
    { id: 'a1', label: 'Lane A' },
    { now: 'x', tasks: [{ title: 's1' }], eta: 3 },
    at,
  ).file
  expect(file.agents?.[0]).toMatchObject({
    id: 'a1',
    label: 'Lane A',
    now: 'x',
    etaMin: 3,
    endedAt: null,
    startedAt: at,
  })
  file = applyAgentUpdate(
    file,
    { id: 'a1', label: 'Lane A' },
    { tasks: [{ id: 't1', status: 'done' }] },
    iso(T0 + 1000),
  ).file
  expect(file.agents?.[0]?.tasks[0]?.status).toBe('done')
  expect(file.agents?.[0]?.now).toBe('x')
  expect(file.tasks).toEqual([])
})

test('syncAgents lists a running subagent that never reports, and finishes one the list says ended', () => {
  const at = iso(T0)
  const listed = [
    { id: 'r1', description: ' Audit: authz ', status: 'running' },
    { id: 'd1', description: 'Already done', status: 'completed' },
  ]
  let file = syncAgents(fresh(), listed, at)
  expect(file.agents).toEqual([
    {
      id: 'r1',
      label: 'Audit: authz',
      now: null,
      tasks: [],
      seq: 0,
      startedAt: at,
      updatedAt: at,
      endedAt: null,
    },
  ])
  // Nothing new: the same object back, so the caller skips the write.
  expect(syncAgents(file, listed, iso(T0 + 1000))).toBe(file)
  file = syncAgents(file, [{ id: 'r1', description: 'Audit: authz', status: 'failed' }], iso(T0 + 2000))
  expect(file.agents?.[0]?.endedAt).toBe(iso(T0 + 2000))
  // An entry the agent fed itself keeps its steps; one the list no longer names stays as it is.
  let own = applyAgentUpdate(fresh(), { id: 'a1', label: 'Lane' }, { tasks: [{ title: 's' }] }, at).file
  own = syncAgents(own, [{ id: 'a1', description: 'Lane', status: 'idle' }], at)
  expect(own.agents?.[0]?.tasks).toHaveLength(1)
  expect(syncAgents(own, [], at)).toBe(own)
  expect(syncAgents(fresh(), [{ id: 'x', description: '', status: 'pending' }], at).agents?.[0]?.label).toBe(
    'x',
  )
})

test("mergeScan: a save that landed during a scan keeps its newer copy over the scan's older read", () => {
  const at = iso(T0)
  const old = newSession({ id: 's', project: 'p', cwd: '/w/p' }, at)
  const saved = applyUpdate(old, { now: 'newer' }, iso(T0 + 1000)).file
  const before = { s: { mtimeMs: 1, file: old } }
  const current = { s: { mtimeMs: 2, file: saved } }
  // The scan listed the folder before the save: it read mtime 1 and the old file.
  const scanned = {
    s: { mtimeMs: 1, file: old, sidecar: { mtimeMs: 5, entries: [], pipelines: [], cancelled: ['t9'] } },
  }
  const merged = mergeScan(before, current, scanned)
  expect(merged.s?.file.now).toBe('newer')
  expect(merged.s?.mtimeMs).toBe(2)
  // The scan's sidecar is fresher than anything the save knew: it rides along.
  expect(merged.s?.sidecar?.cancelled).toEqual(['t9'])
})

test('mergeScan: unchanged entries take the scan; a newer file on disk beats a stale store copy', () => {
  const a = newSession({ id: 'a', project: 'p', cwd: '/w/p' }, iso(T0))
  const b = newSession({ id: 'b', project: 'q', cwd: '/w/q' }, iso(T0))
  const bNew = applyUpdate(b, { now: 'from disk' }, iso(T0 + 2000)).file
  const bSaved = applyUpdate(b, { now: 'saved' }, iso(T0 + 1000)).file
  const before = { a: { mtimeMs: 1, file: a }, b: { mtimeMs: 1, file: b } }
  const current = { a: before.a, b: { mtimeMs: 2, file: bSaved } }
  const scanned = { a: { mtimeMs: 3, file: a }, b: { mtimeMs: 4, file: bNew } }
  const merged = mergeScan(before, current, scanned)
  expect(merged.a?.mtimeMs).toBe(3)
  expect(merged.b?.file.now).toBe('from disk')
})

test('mergeScan: a session first saved during the scan is kept; one the scan no longer lists goes', () => {
  const fresh = newSession({ id: 'n', project: 'p', cwd: '/w/p' }, iso(T0))
  const gone = newSession({ id: 'g', project: 'p', cwd: '/w/p' }, iso(T0))
  const before = { g: { mtimeMs: 1, file: gone } }
  const current = { g: before.g, n: { mtimeMs: 7, file: fresh } }
  const merged = mergeScan(before, current, {})
  expect(Object.keys(merged)).toEqual(['n'])
})

test('capNewest keeps the newest few in the list order and counts the older rest', () => {
  const items = [
    { id: 'a', at: iso(T0 + 1000) },
    { id: 'b', at: iso(T0 + 5000) },
    { id: 'c', at: iso(T0) },
    { id: 'd', at: iso(T0 + 3000) },
  ]
  const r = capNewest(items, 2, x => x.at)
  expect(r.shown.map(x => x.id)).toEqual(['b', 'd'])
  expect(r.older).toBe(2)
  // At or under the limit: everything, nothing folded.
  expect(capNewest(items, 4, x => x.at)).toEqual({ shown: items, older: 0 })
  // A missing stamp counts as oldest.
  expect(capNewest([{ id: 'x', at: null }, ...items], 1, x => x.at).shown.map(x => x.id)).toEqual(['b'])
})

test('a live session on this machine, idle long enough, gets a liveness check — nothing else does', () => {
  const at = '2026-11-09T10:00:00.000Z'
  const base = newSession({ id: 's-other', project: 'p', cwd: '/w' }, at)
  const mine = { ...base, session: { ...base.session, pid: 4242, host: 'mini' } }
  const idle = Date.parse(at) + DEAD_AFTER_MS
  expect(needsLivenessCheck(mine, 's-me', 'mini', idle)).toBe(true)
  // Not idle long enough, this session itself, another machine, no pid, already ended: no check.
  expect(needsLivenessCheck(mine, 's-me', 'mini', idle - 1)).toBe(false)
  expect(needsLivenessCheck(mine, 's-other', 'mini', idle)).toBe(false)
  expect(needsLivenessCheck(mine, 's-me', 'laptop', idle)).toBe(false)
  expect(needsLivenessCheck(base, 's-me', 'mini', idle)).toBe(false)
  expect(needsLivenessCheck(endDeadSession(mine), 's-me', 'mini', idle)).toBe(false)
  // A dead one ends as of its last write.
  expect(endDeadSession(mine).session.endedAt).toBe(mine.updatedAt)
})

test("time left: the agent's guess until a step finishes (marked), then the measured pace", () => {
  const start = '2026-11-09T10:00:00.000Z'
  const at = (min: number) => new Date(Date.parse(start) + min * 60_000).toISOString()
  const todo = { status: 'todo' as const }
  // Nothing finished yet: its own guess, shown as one.
  expect(timeLeft([todo, todo], start, 120)).toEqual({ min: 120, guess: true })
  expect(timeLeft([todo], start, undefined)).toBeUndefined()
  // Two steps done in 2 and 4 minutes (median 3), three open: ~9 min — the 120-minute guess is gone.
  const done = (min: number) => ({ status: 'done' as const, doneAt: at(min) })
  expect(timeLeft([done(2), done(6), todo, todo, todo], start, 120)).toEqual({ min: 9, guess: false })
  // Median, not mean: one slow step does not swing it (1, 1, 20 → median 1).
  expect(timeLeft([done(1), done(2), done(22), todo], start, 5)).toEqual({ min: 1, guess: false })
  // All closed: nothing left to estimate.
  expect(timeLeft([done(1)], start, 5)).toBeUndefined()
})

test('a closed step keeps the time it closed; a step closing now is stamped now', () => {
  const t0 = '2026-11-09T10:00:00.000Z'
  const t1 = '2026-11-09T10:05:00.000Z'
  const base = newSession({ id: 's', project: 'p', cwd: '/w' }, t0)
  const first = applyUpdate(
    base,
    { tasks: [{ title: 'A', steps: [{ title: 'one', status: 'done' }, { title: 'two' }] }] },
    t0,
  ).file
  expect(first.tasks[0]?.steps?.[0]?.doneAt).toBe(t0)
  expect(first.tasks[0]?.steps?.[1]?.doneAt).toBeUndefined()
  const second = applyUpdate(
    first,
    {
      tasks: [
        {
          id: 't1',
          steps: [
            { title: 'one', status: 'done' },
            { title: 'two', status: 'done' },
          ],
        },
      ],
    },
    t1,
  ).file
  expect(second.tasks[0]?.steps?.map(s => s.doneAt)).toEqual([t0, t1])
})

test('failed is a status a report may set — closed, with its reason; unfinished is never accepted from a report', () => {
  const at = iso(T0)
  const r = applyUpdate(
    fresh(),
    {
      tasks: [
        { title: 'Full-width pane', status: 'failed', note: 'the API cannot place a pane' },
        {
          title: 'Steps',
          steps: [
            { title: 'tried', status: 'failed', note: ' no runner ' },
            { title: 'left', status: 'skipped' },
          ],
        },
        { title: 'Sneaky', status: 'unfinished' },
      ],
    },
    at,
  )
  expect(r.errors).toEqual(['tasks[2]: status must be one of todo, doing, blocked, done, skipped, failed'])
  const [failed, withSteps] = r.file.tasks
  expect(failed?.status).toBe('failed')
  expect(failed?.note).toBe('the API cannot place a pane')
  expect(failed?.doneAt).toBe(at)
  // A step keeps its own reason, trimmed; a step without one has none.
  expect(withSteps?.steps).toEqual([
    { title: 'tried', status: 'failed', note: 'no runner', doneAt: at },
    { title: 'left', status: 'skipped', doneAt: at },
  ])
  for (const s of ['done', 'skipped', 'failed', 'unfinished'] as const) expect(isClosed(s)).toBe(true)
  for (const s of ['todo', 'doing', 'blocked'] as const) expect(isClosed(s)).toBe(false)
})

test('a session file keeps the plugin-set unfinished status; sorting by status puts failed before done', () => {
  const file = {
    ...fresh(),
    tasks: (['unfinished', 'done', 'failed', 'blocked'] as const).map(status =>
      task({ id: status[0], status }),
    ),
  }
  expect(parseSessionFile(JSON.stringify(file))?.tasks.map(t => t.status)).toEqual([
    'unfinished',
    'done',
    'failed',
    'blocked',
  ])
  expect(sortTasks(file.tasks, 'status').map(t => t.id)).toEqual(['b', 'f', 'd', 'u'])
})

test('an agent that stops for good leaves its open steps unfinished; a pause or a resume does not', () => {
  const at = iso(T0)
  let file = applyAgentUpdate(
    fresh(),
    { id: 'a1', label: 'Lane' },
    {
      tasks: [
        { title: 'one', status: 'done' },
        { title: 'two', status: 'doing' },
        { title: 'three', status: 'todo' },
      ],
    },
    at,
  ).file
  const statuses = (f: SessionFile) => f.agents?.[0]?.tasks.map(t => t.status)
  // Waiting on its own background work: nothing changes but the waiting mark.
  const paused = endAgent(file, 'a1', iso(T0 + 1000), true)
  expect(statuses(paused)).toEqual(['done', 'doing', 'todo'])
  expect(paused.agents?.[0]?.endedAt).toBeNull()
  // Stopped for good: ended, its `doing` step unfinished (a todo stays todo — it never started).
  file = endAgent(file, 'a1', iso(T0 + 2000))
  expect(file.agents?.[0]?.endedAt).toBe(iso(T0 + 2000))
  expect(statuses(file)).toEqual(['done', 'unfinished', 'todo'])
  // Resumed: running again, the unfinished step back to doing.
  file = reopenAgent(file, 'a1', iso(T0 + 3000))
  expect(file.agents?.[0]?.endedAt).toBeNull()
  expect(statuses(file)).toEqual(['done', 'doing', 'todo'])
  // The list sync ending a never-resumed agent does the same.
  const synced = syncAgents(
    applyAgentUpdate(fresh(), { id: 'a2', label: 'L2' }, { tasks: [{ title: 'x', status: 'doing' }] }, at)
      .file,
    [{ id: 'a2', description: 'L2', status: 'completed' }],
    iso(T0 + 4000),
  )
  expect(synced.agents?.[0]?.tasks[0]?.status).toBe('unfinished')
})

test('displayWidth counts terminal cells: wide CJK and emoji 2, marks and joiners 0', () => {
  expect(displayWidth('abc')).toBe(3)
  expect(displayWidth('日本')).toBe(4)
  expect(displayWidth('ok ✅')).toBe(5)
  expect(displayWidth('é')).toBe(1) // e + combining acute
  expect(displayWidth('👩‍💻')).toBe(4) // two pictographs, the joiner counts 0
  expect(displayWidth('')).toBe(0)
})
