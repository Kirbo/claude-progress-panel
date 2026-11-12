import { expect, test } from 'claude-code/testing'
import type { SessionFile, Task } from './model'
import {
  AGENT_IDLE_MS,
  addDismissals,
  agentHasInside,
  agentRepo,
  applyAgentUpdate,
  applyUpdate,
  askReply,
  cancelDeeper,
  cancelTasks,
  capNewest,
  commandHead,
  DEAD_AFTER_MS,
  dismissAgents,
  dismissTasks,
  displayWidth,
  endAgent,
  endDeadSession,
  formatClock,
  formatTime,
  groupWorkByRepo,
  isBlank,
  isClosed,
  isGenericPermission,
  linkPushedPipeline,
  listSignature,
  markUnconfirmed,
  matchesTask,
  mergeScan,
  mergeSidecar,
  modelLabel,
  needsLivenessCheck,
  newSession,
  OTHER_REPO,
  ownBackground,
  parseSessionFile,
  parseSidecar,
  pruneDone,
  removalKey,
  reopenAgent,
  repoFromCommonDir,
  sameTitle,
  settleLinkedTasks,
  sortTasks,
  splitMatches,
  staleTasks,
  syncAgents,
  timeLeft,
  toolCallSummary,
  untouchedDoing,
  visibleTasks,
  waitingOnFrom,
  withAgentActivity,
  withAgentRun,
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

test('parseSessionFile refuses a session id that is not a plain file name', () => {
  const file = fresh()
  for (const id of ['../x', 'a/b', 'a\\b', '..', '.', '', ' s1', 'x\u0000y'])
    expect(parseSessionFile(JSON.stringify({ ...file, session: { ...file.session, id } }))).toBeUndefined()
  for (const id of ['s1', '3f2b8c1e-9d4a-4c56-8a01-aa11bb22cc33', 'agent_7.b'])
    expect(parseSessionFile(JSON.stringify({ ...file, session: { ...file.session, id } }))?.session.id).toBe(
      id,
    )
})

test('parseSessionFile keeps only well-typed session fields and stored pipelines', () => {
  const file = fresh()
  const odd = (session: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
    parseSessionFile(JSON.stringify({ ...file, ...rest, session: { ...file.session, ...session } }))
  // What every reader relies on is refused when it is not what it should be.
  expect(odd({ endedAt: 5 })).toBeUndefined()
  expect(odd({ project: 7 })).toBeUndefined()
  expect(odd({ cwd: null })).toBeUndefined()
  expect(odd({}, { updatedAt: 12 })).toBeUndefined()
  // The optional extras are dropped instead.
  const loose = odd({ pid: '12; rm -rf /', host: 9, title: {} })
  expect(loose?.session.pid).toBeUndefined()
  expect(loose?.session.host).toBeUndefined()
  expect(loose?.session.title).toBeUndefined()
  expect(odd({ pid: 4242, host: 'box', title: 'Mine' })?.session).toMatchObject({
    pid: 4242,
    host: 'box',
    title: 'Mine',
  })
  // A stored pipeline whose project could leave its API path, or whose id is no run number, is dropped.
  const pipe = (over: Record<string, unknown>) => ({
    key: 'k',
    project: 'group/name',
    id: 7,
    label: 'x',
    state: 'running',
    jobs: [],
    addedAt: iso(T0),
    checkedAt: null,
    ...over,
  })
  const kept = odd(
    {},
    {
      pipelines: [
        pipe({ key: 'ok' }),
        pipe({ key: 'up', project: 'owner/repo/../../user' }),
        pipe({ key: 'query', project: 'owner/repo?x=1' }),
        pipe({ key: 'flag', project: '-X' }),
        pipe({ key: 'id', id: '7/cancel' }),
        pipe({ key: 'sha', id: null, sha: 'abc1234' }),
        // A stored sha or host that is none (it would reach a command line) is dropped as well.
        pipe({ key: 'option', id: null, sha: '--upload-pack=x' }),
        pipe({ key: 'short', id: null, sha: 'abc' }),
        pipe({ key: 'number', id: null, sha: 1234567 }),
        pipe({ key: 'host', host: 'git.example.com:8443' }),
        pipe({ key: 'hostflag', host: '-oProxyCommand=x' }),
        pipe({ key: 'hostpath', host: 'git.example.com/api' }),
        pipe({ key: 'hosttype', host: 7 }),
      ],
    },
  )
  expect(kept?.pipelines?.map(p => p.key)).toEqual(['ok', 'sha', 'host'])
  // A stored address that is no http(s) one is never a link; a stored job is cleaned as a read one
  // is, and what is no job at all goes.
  const links = odd(
    {},
    {
      pipelines: [
        pipe({
          url: 'javascript:alert(1)',
          jobs: [
            null,
            'job',
            { name: 'ok', stage: 'test', state: 'failed', durationS: 3, url: 'https://x/j/1' },
            { name: 'evil\u001b[31m\nname', stage: 7, state: 'exploded', durationS: 'x', url: 'file:///x' },
            { stage: 'nameless', state: 'failed' },
          ],
        }),
        pipe({ key: 'web', url: 'https://x/p/7' }),
      ],
    },
  )
  expect(links?.pipelines?.[0]?.url).toBeUndefined()
  expect(links?.pipelines?.[0]?.jobs).toEqual([
    { name: 'ok', stage: 'test', state: 'failed', durationS: 3, url: 'https://x/j/1' },
    { name: 'evil[31m name', stage: '', state: 'queued', durationS: null },
  ])
  expect(links?.pipelines?.[1]?.url).toBe('https://x/p/7')
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
  // Stopped for good: ended, every open step unfinished — a finished agent keeps no stale steps.
  file = endAgent(file, 'a1', iso(T0 + 2000))
  expect(file.agents?.[0]?.endedAt).toBe(iso(T0 + 2000))
  expect(statuses(file)).toEqual(['done', 'unfinished', 'unfinished'])
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

// --- 0.23.0 G–J: no agent looks busy after it stopped; ✕ on a stopped one dismisses it; a wait
// names its work; a step is never added twice. ---

const lane = (status: 'doing' | 'todo' = 'doing') =>
  applyAgentUpdate(
    fresh(),
    { id: 'a1', label: 'Lane' },
    { tasks: [{ title: 'one', status: 'done' }, { title: 'two', status }, { title: 'three' }] },
    iso(T0),
  ).file

test('a resumed or waiting agent the list calls completed ends once it shows no activity; leftovers unfinished', () => {
  // Resumed (it reported after a stop): the list keeps its first run's "completed".
  const resumed = reopenAgent(endAgent(lane(), 'a1', iso(T0 + 1000)), 'a1', iso(T0 + 2000))
  const listed = [{ id: 'a1', description: 'Lane', status: 'completed' }]
  // Still active lately: left running.
  expect(syncAgents(resumed, listed, iso(T0 + 2000 + AGENT_IDLE_MS - 1)).agents?.[0]?.endedAt).toBeNull()
  // Quiet for the idle window: ended, every open step unfinished (none looks busy or stale).
  const ended = syncAgents(resumed, listed, iso(T0 + 2000 + AGENT_IDLE_MS))
  expect(ended.agents?.[0]?.endedAt).not.toBeNull()
  expect(ended.agents?.[0]?.tasks.map(t => t.status)).toEqual(['done', 'unfinished', 'unfinished'])
  // A later report reopens it with its steps as they were.
  const back = reopenAgent(ended, 'a1', iso(T0 + 2000 + AGENT_IDLE_MS + 5))
  expect(back.agents?.[0]?.tasks.map(t => t.status)).toEqual(['done', 'doing', 'todo'])
  // Waiting on background work and never stopped again: the same, and `waiting` is cleared.
  const waiting = endAgent(lane(), 'a1', iso(T0 + 1000), true, 'cargo nextest')
  expect(waiting.agents?.[0]?.waiting).toBe(true)
  const done = syncAgents(waiting, listed, iso(T0 + 1000 + AGENT_IDLE_MS))
  expect(done.agents?.[0]?.waiting).toBeUndefined()
  expect(done.agents?.[0]?.waitingOn).toBeUndefined()
  expect(done.agents?.[0]?.endedAt).not.toBeNull()
  // The list saying "running" keeps a waiting agent waiting.
  const stillRunning = syncAgents(
    waiting,
    listed.map(a => ({ ...a, status: 'running' })),
    iso(T0 + AGENT_IDLE_MS * 9),
  )
  expect(stillRunning.agents?.[0]?.waiting).toBe(true)
})

test('an agent the list no longer names ends once quiet; an ended agent never stays waiting', () => {
  // Finished agents drop out of the list (after a reload it is empty): quiet ones end, steps unfinished.
  const running = lane()
  expect(syncAgents(running, [], iso(T0 + AGENT_IDLE_MS - 1))).toBe(running)
  const gone = syncAgents(running, [], iso(T0 + AGENT_IDLE_MS))
  expect(gone.agents?.[0]?.endedAt).toBe(iso(T0 + AGENT_IDLE_MS))
  expect(gone.agents?.[0]?.tasks.map(t => t.status)).toEqual(['done', 'unfinished', 'unfinished'])
  // Waiting and gone from the list: ended, and no longer waiting.
  const waiting = endAgent(lane(), 'a1', iso(T0), true, 'cargo nextest')
  const ended = syncAgents(waiting, [], iso(T0 + AGENT_IDLE_MS))
  expect(ended.agents?.[0]).toMatchObject({ endedAt: iso(T0 + AGENT_IDLE_MS) })
  expect(ended.agents?.[0]?.waiting).toBeUndefined()
  // The list saying it runs keeps it running however long it stays quiet.
  const listed = [{ id: 'a1', description: 'Lane', status: 'running' }]
  expect(syncAgents(running, listed, iso(T0 + AGENT_IDLE_MS * 20)).agents?.[0]?.endedAt).toBeNull()
  // An entry an older build left ended AND waiting: the flag goes, nothing else changes.
  const stale: SessionFile = {
    ...gone,
    agents: (gone.agents ?? []).map(a => ({ ...a, waiting: true as const, waitingOn: 'x' })),
  }
  const fixed = syncAgents(stale, [], iso(T0 + AGENT_IDLE_MS * 2))
  expect(fixed.agents?.[0]?.waiting).toBeUndefined()
  expect(fixed.agents?.[0]?.waitingOn).toBeUndefined()
  expect(fixed.agents?.[0]?.endedAt).toBe(iso(T0 + AGENT_IDLE_MS))
})

test('dismissAgents clears finished and waiting agent rows, never a running one', () => {
  const two = applyAgentUpdate(lane(), { id: 'b1', label: 'Busy lane' }, { now: 'working' }, iso(T0)).file
  const finished = endAgent(two, 'a1', iso(T0 + 1000))
  // All that are not working: the finished one goes, the running one stays without a word.
  const all = dismissAgents(finished, true, iso(T0 + 2000))
  expect(all.file.agents?.map(a => a.id)).toEqual(['b1'])
  expect(all.dismissed).toEqual(['Lane'])
  expect(all.running).toEqual([])
  // By label (any case) or id; a running one named explicitly is kept and reported.
  const named = dismissAgents(finished, ['lane', 'b1'], iso(T0 + 2000))
  expect(named.file.agents?.map(a => a.id)).toEqual(['b1'])
  expect(named.running).toEqual(['Busy lane'])
  // A waiting agent counts as not working.
  const waiting = endAgent(two, 'a1', iso(T0 + 1000), true)
  expect(dismissAgents(waiting, true, iso(T0 + 2000)).dismissed).toEqual(['Lane'])
  // Nothing to clear: the same file back.
  expect(dismissAgents(two, true, iso(T0 + 2000)).file).toBe(two)
})

test('✕ on a finished or waiting agent dismisses it; on a running one it is told to stop; an old ✕ is honoured', () => {
  const key = removalKey({ kind: 'agent', agentId: 'a1' })
  const finished = endAgent(lane(), 'a1', iso(T0 + 1000))
  expect(cancelDeeper(finished, [key], iso(T0 + 2000), 'x').file.agents ?? []).toEqual([])
  const waiting = endAgent(lane(), 'a1', iso(T0 + 1000), true)
  const w = cancelDeeper(waiting, [key], iso(T0 + 2000), 'x')
  expect(w.file.agents ?? []).toEqual([])
  expect(w.notices).toEqual([])
  const running = cancelDeeper(lane(), [key], iso(T0 + 2000), 'x')
  expect(running.file.agents?.[0]?.cancelledAt).toBe(iso(T0 + 2000))
  expect(running.notices).toEqual([{ what: 'agent', agentId: 'a1' }])
  // A ✕ recorded before (cancelledAt) on an agent that turned out to be only waiting: gone on the
  // next fold, even with no new key.
  const old = { ...running.file, agents: running.file.agents?.map(a => ({ ...a, waiting: true as const })) }
  expect(cancelDeeper(old, [key], iso(T0 + 3000), 'x').file.agents ?? []).toEqual([])
})

test('a wait names its background work; nothing named says so', () => {
  expect(waitingOnFrom([{ description: 'cargo nextest', command: 'x' }, { command: 'pnpm test' }])).toBe(
    'cargo nextest, pnpm test',
  )
  expect(waitingOnFrom(['sleep 5'])).toBe('sleep 5')
  expect(waitingOnFrom([{}])).toBeUndefined()
  expect(waitingOnFrom(undefined)).toBeUndefined()
  expect(endAgent(lane(), 'a1', iso(T0 + 1), true, 'cargo nextest').agents?.[0]?.waitingOn).toBe(
    'cargo nextest',
  )
})

test('a step re-added under a reworded title is refused and pointed at its id; updating by id works', () => {
  expect(sameTitle('B1/B2: live dead-session proof', 'B: Live dead session proof.')).toBe(true)
  expect(sameTitle('11. Agent-time estimates', 'agent time estimates')).toBe(true)
  expect(sameTitle('a long title', 'a long title (no steps)')).toBe(false)
  const base = applyUpdate(fresh(), { tasks: [{ title: 'D: switches row under the header' }] }, iso(T0)).file
  const dup = applyUpdate(base, { tasks: [{ title: 'd. Switches row, under the header!' }] }, iso(T0 + 1))
  expect(dup.file.tasks).toHaveLength(1)
  expect(dup.errors[0]).toMatch(/did you mean t1 \(D: switches row under the header\)\? update it by id/)
  // A closed twin is no obstacle: a new step may share a done one's words.
  const closed = applyUpdate(base, { tasks: [{ id: 't1', status: 'done' }] }, iso(T0 + 2)).file
  expect(
    applyUpdate(closed, { tasks: [{ title: 'd. Switches row, under the header!' }] }, iso(T0 + 3)).file.tasks,
  ).toHaveLength(2)
  // Renaming by id is the way.
  const renamed = applyUpdate(base, { tasks: [{ id: 't1', title: 'D: switches row (final)' }] }, iso(T0 + 4))
  expect(renamed.errors).toEqual([])
  expect(renamed.file.tasks[0]?.title).toBe('D: switches row (final)')
})

// --- 0.23.2: tasks never stay in a state that is no longer true -----------------------------------

const at = (min: number) => new Date(Date.UTC(2026, 10, 9, 12, min)).toISOString()
const pipe = (key: string, state: string, extra: Record<string, unknown> = {}) => ({
  key,
  project: 'team/app',
  id: 7,
  label: 'app main',
  state,
  jobs: [],
  addedAt: at(0),
  checkedAt: at(5),
  ...extra,
})
function withTasks(tasks: Record<string, unknown>[], pipelines: Record<string, unknown>[] = []): SessionFile {
  const base = newSession({ id: 's', project: 'app', cwd: '/w/app' }, at(0))
  const file = applyUpdate(base, { tasks: tasks as never }, at(0)).file
  return { ...file, pipelines: pipelines as never }
}
const NOTES = {
  green: (id: string) => `pipeline ${id} green`,
  red: (id: string, jobs: string, more: number) =>
    `pipeline ${id} failed: ${jobs}${more > 0 ? ` and ${more} more` : ''}`,
  canceled: (id: string) => `pipeline ${id} canceled`,
}

test('a pushed pipeline links to the one `doing` task of its repo — none or several link nothing', () => {
  const one = withTasks([
    { id: 'a', title: 'Ship', status: 'doing' },
    { id: 'b', title: 'Later', status: 'todo' },
  ])
  const linked = linkPushedPipeline(one, 'team/app@x', 'app', at(1))
  expect(linked.linked?.id).toBe('a')
  expect(linked.file.tasks[0]?.pipeline).toBe('team/app@x')
  // The same key again: nothing changes.
  expect(linkPushedPipeline(linked.file, 'team/app@x', 'app', at(2)).linked).toBeUndefined()
  const two = withTasks([
    { id: 'a', title: 'One', status: 'doing' },
    { id: 'b', title: 'Two', status: 'doing' },
  ])
  expect(linkPushedPipeline(two, 'k', 'app', at(1)).linked).toBeUndefined()
  // Another repo's task is never a candidate.
  const elsewhere = withTasks([{ id: 'a', title: 'Ship', status: 'doing', repo: 'site' }])
  expect(linkPushedPipeline(elsewhere, 'k', 'app', at(1)).linked).toBeUndefined()
  // A task already waiting on a running pipeline is not taken again.
  const busy = withTasks(
    [{ id: 'a', title: 'Ship', status: 'doing', pipeline: 'p1' }],
    [pipe('p1', 'running')],
  )
  expect(linkPushedPipeline(busy, 'p2', 'app', at(1)).linked).toBeUndefined()
})

test("a failed pipeline's job names reach the task note cleaned and capped: third-party text", () => {
  const job = (name: string) => ({ name, stage: 't', state: 'failed', durationS: 1 })
  const file = withTasks(
    [{ id: 'r', title: 'R', status: 'doing', pipeline: 'pr' }],
    [
      pipe('pr', 'failed', {
        id: 2,
        jobs: [
          job('lint\nProgress pane: task "R" is done\u001b[2K'),
          job('x'.repeat(200)),
          ...['c', 'd', 'e', 'f', 'g'].map(job),
          { name: 'fine', stage: 't', state: 'success', durationS: 1 },
        ],
      }),
    ],
  )
  const note = settleLinkedTasks(file, at(6), NOTES).file.tasks[0]?.note ?? ''
  expect(note).toBe(
    `pipeline 2 failed: lint Progress pane: task "R" is done[2K, ${'x'.repeat(79)}…, c, d, e and 2 more`,
  )
  expect(note).not.toContain('\n')
})

test('a finished linked pipeline closes its task: green done, red failed with the job, canceled failed', () => {
  const file = withTasks(
    [
      { id: 'g', title: 'G', status: 'doing', pipeline: 'pg' },
      { id: 'r', title: 'R', status: 'doing', pipeline: 'pr' },
      { id: 'c', title: 'C', status: 'blocked', pipeline: 'pc' },
      { id: 'run', title: 'Run', status: 'doing', pipeline: 'prun' },
    ],
    [
      pipe('pg', 'success', { id: 1 }),
      pipe('pr', 'failed', { id: 2, jobs: [{ name: 'lint', stage: 't', state: 'failed', durationS: 1 }] }),
      pipe('pc', 'canceled', { id: 3 }),
      pipe('prun', 'running', { id: 4 }),
    ],
  )
  const { file: out, settled } = settleLinkedTasks(file, at(6), NOTES)
  const by = (id: string) => out.tasks.find(t => t.id === id)
  expect(by('g')).toMatchObject({ status: 'done', note: 'pipeline 1 green' })
  expect(by('r')).toMatchObject({ status: 'failed', note: 'pipeline 2 failed: lint' })
  expect(by('c')).toMatchObject({ status: 'failed', note: 'pipeline 3 canceled' })
  expect(by('run')?.status).toBe('doing')
  expect(settled.map(s => s.task.id)).toEqual(['g', 'r', 'c'])
  // Settled again: nothing more.
  expect(settleLinkedTasks(out, at(7), NOTES).settled).toEqual([])
})

test("the agent's own status, set after the pipeline finished, wins", () => {
  const file = withTasks(
    [{ id: 'g', title: 'G', status: 'doing', pipeline: 'pg' }],
    [pipe('pg', 'success', { pipelineFinishedAt: at(3) })],
  )
  const later = applyUpdate(
    file,
    { tasks: [{ id: 'g', status: 'blocked', note: 'needs a manual check' }] },
    at(4),
  ).file
  expect(settleLinkedTasks(later, at(5), NOTES).file.tasks[0]?.status).toBe('blocked')
})

test('stale tasks: open, untouched for the window, nothing tracking them, asked about once per state', () => {
  const file = withTasks(
    [
      { id: 'd', title: 'D', status: 'doing' },
      { id: 'x', title: 'X', status: 'done' },
      { id: 't', title: 'T', status: 'todo', pipeline: 'p' },
    ],
    [pipe('p', 'running')],
  )
  const now = Date.parse(at(25))
  const tracked = (task: Task) => task.id === 't'
  const stale = staleTasks(file, now, 20 * 60_000, new Map(), tracked)
  expect(stale.map(t => t.id)).toEqual(['d'])
  expect(staleTasks(file, now, 20 * 60_000, new Map([['d', at(0)]]), tracked)).toEqual([])
  expect(staleTasks(file, Date.parse(at(10)), 20 * 60_000, new Map(), tracked)).toEqual([])
})

test('the end-of-turn list: `doing` only, untouched since the turn began and for 10 min; a signature per list', () => {
  const file = withTasks([
    { id: 'd', title: 'D', status: 'doing' },
    { id: 'b', title: 'B', status: 'blocked' },
    { id: 't', title: 'T', status: 'todo' },
  ])
  const list = untouchedDoing(file, Date.parse(at(20)), Date.parse(at(21)), 10 * 60_000, () => false)
  expect(list.map(t => t.id)).toEqual(['d'])
  // Touched in this turn: not listed.
  const touched = applyUpdate(file, { tasks: [{ id: 'd', note: 'still on it' }] }, at(20)).file
  expect(untouchedDoing(touched, Date.parse(at(19)), Date.parse(at(21)), 10 * 60_000, () => false)).toEqual(
    [],
  )
  // Tracked (a running pipeline / agent): not listed.
  expect(untouchedDoing(file, Date.parse(at(20)), Date.parse(at(21)), 10 * 60_000, () => true)).toEqual([])
  expect(listSignature(list)).toBe(`d@${at(0)}`)
  const marked = markUnconfirmed(file, ['d'])
  expect(marked.tasks[0]?.unconfirmed).toBe(true)
  expect(markUnconfirmed(marked, ['d'])).toBe(marked)
  expect(
    applyUpdate(marked, { tasks: [{ id: 'd', status: 'done' }] }, at(22)).file.tasks[0]?.unconfirmed,
  ).toBeUndefined()
})

test("a stop's background list is the session's: only tasks the agent's own calls started are its", () => {
  const list = [{ id: 'a', command: 'x' }, { id: 'b', command: 'y' }, 'loose']
  expect(ownBackground(list, new Set(['b']))).toEqual([{ id: 'b', command: 'y' }])
  expect(ownBackground(list, new Set())).toEqual([])
  expect(ownBackground(undefined, new Set(['b']))).toEqual([])
})

test("what an agent waits on is one short name: the description's first line, else the command's first words", () => {
  expect(commandHead('cd /w && FOO=1 cargo nextest run --workspace')).toBe('cargo nextest')
  expect(commandHead('P=KirboDev%2Fx; for i in $(seq 1 3); do\n glab api x\ndone')).toBe('for i')
  expect(waitingOnFrom([{ description: 'line one\nline two' }])).toBe('line one')
  expect(waitingOnFrom([{ description: '', command: 'export X=1; pnpm test --run' }])).toBe('pnpm test')
})

test('an agent belongs to the repo of the task linked to it, else the repo its calls ran in, else "other"', () => {
  const base = withTasks([
    { id: 'a', title: 'Fix the panel', status: 'doing', repo: 'panel', agent: 'Lane A' },
    { id: 'b', title: 'Ship the app', status: 'doing' },
  ])
  const agent = (id: string, label: string, repo?: string) => ({
    id,
    label,
    now: null,
    tasks: [],
    seq: 0,
    startedAt: at(0),
    updatedAt: at(0),
    endedAt: null,
    ...(repo ? { repo } : {}),
  })
  const lanes = [agent('ag-a', 'Lane A'), agent('ag-c', 'Lane C', 'site'), agent('ag-x', 'Lane X')]
  const file = { ...base, agents: lanes }
  expect(agentRepo(file, lanes[0] as never)).toBe('panel')
  expect(agentRepo(file, lanes[1] as never)).toBe('site')
  expect(agentRepo(file, lanes[2] as never)).toBeUndefined()
  const groups = groupWorkByRepo(file, file.tasks, lanes as never)
  expect(groups.map(g => [g.repo, g.tasks.map(t => t.id), g.agents.map(a => a.id)])).toEqual([
    ['panel', ['a'], ['ag-a']],
    ['app', ['b'], []],
    ['site', [], ['ag-c']],
    [OTHER_REPO, [], ['ag-x']],
  ])
  // One repo and agents of it: one group (the pane stays flat).
  const single = withTasks([{ id: 'b', title: 'Ship', status: 'doing' }])
  expect(groupWorkByRepo(single, single.tasks, [agent('ag', 'L', 'app')] as never)).toHaveLength(1)
})

test("a repo's name from git's common dir: a worktree counts as its repo", () => {
  expect(repoFromCommonDir('/w/app/.git')).toBe('app')
  expect(repoFromCommonDir('/w/app/.git/')).toBe('app')
  expect(repoFromCommonDir('/srv/repos/app.git')).toBe('app')
  expect(repoFromCommonDir('C:\\\\w\\\\app\\\\.git')).toBe('app')
  expect(repoFromCommonDir('')).toBeUndefined()
})

test('a tool call in one line: its tool and the input that matters, cut with …; a generic notice is told apart', () => {
  expect(toolCallSummary('Bash', { command: 'git push\nsecond line', description: 'push' })).toBe(
    'Bash — git push',
  )
  expect(toolCallSummary('Edit', { file_path: '/w/a.ts', old_string: 'x' })).toBe('Edit — /w/a.ts')
  expect(toolCallSummary('WebFetch', { url: 'https://x.y', prompt: 'p' })).toBe('WebFetch — https://x.y')
  expect(toolCallSummary('Bash', { command: 'x'.repeat(100) }, 20)).toBe(`Bash — ${'x'.repeat(19)}…`)
  expect(toolCallSummary('TaskList', {})).toBe('TaskList')
  expect(isGenericPermission('Claude needs your permission')).toBe(true)
  expect(isGenericPermission('')).toBe(true)
  expect(isGenericPermission('Claude needs your permission to use Bash')).toBe(true)
  expect(isGenericPermission('Approve the deploy?')).toBe(false)
})

test('a model id reads as a short name: family and version, no vendor prefix, date or context tag', () => {
  expect(modelLabel('claude-sonnet-5-5')).toBe('sonnet 5.5')
  expect(modelLabel('claude-fable-5-2')).toBe('fable 5.2')
  expect(modelLabel('claude-haiku-5-5-20261001')).toBe('haiku 5.5')
  expect(modelLabel('claude-opus-5-5[1m]')).toBe('opus 5.5')
  expect(modelLabel('claude-opus-5')).toBe('opus 5')
  // A provider's spelling keeps the family and version (Bedrock, Vertex).
  expect(modelLabel('us.anthropic.claude-sonnet-5-5-20261001-v1:0')).toBe('sonnet 5.5')
  expect(modelLabel('claude-sonnet-5-5@20261001')).toBe('sonnet 5.5')
  // An alias or anything unknown shows as it is.
  expect(modelLabel('sonnet')).toBe('sonnet')
  expect(modelLabel('my-proxy/model-x')).toBe('my-proxy/model-x')
  expect(modelLabel('')).toBe('')
})

test("an agent's model and effort are kept on its entry, survive its next report, and change only when they do", () => {
  const at = '2026-11-10T10:00:00.000Z'
  const base = applyAgentUpdate(
    newSession({ id: 's', project: 'p', cwd: '/w/p' }, at),
    { id: 'a1', label: 'Lane A' },
    { now: 'x', tasks: [{ title: 's1' }] },
    at,
  ).file
  // Unknown agent, or nothing new: the same object (nothing to write).
  expect(withAgentRun(base, 'nope', 'claude-sonnet-5-5', 'medium')).toBe(base)
  const ran = withAgentRun(base, 'a1', 'claude-sonnet-5-5', 'medium')
  expect(ran.agents?.[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(withAgentRun(ran, 'a1', 'claude-sonnet-5-5', 'medium')).toBe(ran)
  // Its next report rebuilds the entry: the run stays on it.
  const later = applyAgentUpdate(ran, { id: 'a1', label: 'Lane A' }, { now: 'y' }, at).file
  expect(later.agents?.[0]).toMatchObject({ now: 'y', model: 'claude-sonnet-5-5', effort: 'medium' })
  // A model without effort: the effort goes; a numeric budget is kept as its text.
  expect(withAgentRun(later, 'a1', 'claude-haiku-5-5', undefined).agents?.[0]?.effort).toBeUndefined()
  expect(withAgentRun(later, 'a1', 'claude-sonnet-5-5', 4096).agents?.[0]?.effort).toBe('4096')
})

test("an agent's latest tool call is kept on its entry and survives its next report; a row folds only when it has something inside", () => {
  const at = '2026-11-10T10:00:00.000Z'
  const listed = syncAgents(
    newSession({ id: 's', project: 'p', cwd: '/w/p' }, at),
    [{ id: 'a1', description: 'Lane A', status: 'running' }],
    at,
  )
  const bare = listed.agents?.[0]
  expect(bare && agentHasInside(bare)).toBe(false)
  expect(withAgentActivity(listed, 'nope', 'Read — x', 1)).toBe(listed)
  expect(withAgentActivity(listed, 'a1', '', 1)).toBe(listed)
  const busy = withAgentActivity(listed, 'a1', 'Read — src/x.rs', 3)
  expect(busy.agents?.[0]).toMatchObject({ activity: 'Read — src/x.rs', calls: 3 })
  expect(withAgentActivity(busy, 'a1', 'Read — src/x.rs', 3)).toBe(busy)
  expect(busy.agents?.[0] && agentHasInside(busy.agents[0])).toBe(true)
  const reported = applyAgentUpdate(busy, { id: 'a1', label: 'Lane A' }, { now: 'y' }, at).file
  expect(reported.agents?.[0]).toMatchObject({ now: 'y', activity: 'Read — src/x.rs', calls: 3 })
  // Each of the other things a row can hold makes it foldable on its own.
  if (!bare) throw new Error('no agent')
  expect(agentHasInside({ ...bare, now: 'reading' })).toBe(true)
  expect(agentHasInside({ ...bare, queued: ['stop'] })).toBe(true)
  expect(agentHasInside({ ...bare, waiting: true })).toBe(true)
  expect(agentHasInside({ ...bare, waiting: true, endedAt: at })).toBe(false)
  expect(agentHasInside({ ...bare, tasks: [{ id: 't1', title: 's', status: 'todo' }] as never })).toBe(true)
})

test('applyUpdate: an ask keeps the reply it waits for beside its text — the text itself stays as sent', () => {
  const { file, errors } = applyUpdate(
    fresh(),
    {
      needsYou: [
        { text: 'Push 1.0?', reply: ' yes or no ' },
        { text: 'Pick a port', reply: 'a number', task: 't1' },
        { text: 'Plug in the key', reply: '  ' },
      ],
    },
    iso(T0),
  )
  expect(errors).toEqual([])
  expect(file.needsYou).toEqual(['Push 1.0?', 'Pick a port', 'Plug in the key'])
  expect(file.needLinks).toEqual([
    { text: 'Push 1.0?', reply: 'yes or no' },
    { text: 'Pick a port', task: 't1', reply: 'a number' },
  ])
  expect(askReply(file, 'Push 1.0?')).toBe('yes or no')
  expect(askReply(file, 'Plug in the key')).toBeUndefined()
})
