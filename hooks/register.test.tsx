import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import type { SessionFile } from './model'
import { applyUpdate, newSession } from './model'
import { resolveProgressDir } from './paths'

type On = Parameters<TestBody>[1]
type $Test = Parameters<TestBody>[0]

const T0 = Date.UTC(2026, 10, 6, 20, 0, 0)
const HOUR = 3_600_000
const DIR = '/home/me/.claude/progress'
const TOOL = 'mcp__progress-panel__progress_update'

const PANE = {
  plugin: 'progress-panel',
  component: 'Pane',
  requestId: 'progress',
  props: {
    title: 'Progress',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

type Disk = {
  files: Map<string, { text: string; mtimeMs: number }>
  removed: string[]
  tick: number
  /** When set, listing the folder fails (an unreadable or vanished store). */
  listFails?: boolean
}

function makeDisk(): Disk {
  return { files: new Map(), removed: [], tick: 1 }
}

function put(disk: Disk, path: string, value: unknown) {
  disk.tick += 1
  disk.files.set(path, { text: JSON.stringify(value), mtimeMs: disk.tick })
}

function read(disk: Disk, path: string): SessionFile {
  const file = disk.files.get(path)
  if (!file) throw new Error(`no file ${path}`)
  return JSON.parse(file.text) as SessionFile
}

// Stands in for the engine: one session (s-me) in repo /w/app, a mocked clock, a tiny disk.
function engine(on: On, disk: Disk, opts: { env?: Record<string, string>; id?: string } = {}) {
  const clock = mock.clock(on, { now: T0 })
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  mock.env(on, opts.env ?? { HOME: '/home/me' })
  let id = opts.id ?? 's-me'
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: id }))
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: '/w/app/sub' }))
  on('session.repo', () => ({ value: { root: '/w/app', remote: null } }) as never)
  on('tool.call', () => ({ result: {} }))
  on('fs.list', (_, e) => {
    if (disk.listFails) return { deny: `EACCES: ${e.path}` }
    const prefix = `${e.path}/`
    if (![...disk.files.keys()].some(p => p.startsWith(prefix))) return { deny: `ENOENT: ${e.path}` }
    return {
      value: [...disk.files.entries()]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, f]) => ({
          name: p.slice(prefix.length),
          kind: 'file',
          size: f.text.length,
          mtimeMs: f.mtimeMs,
          isLink: false,
        })),
    }
  })
  on('fs.stat', (_, e) => {
    const f = disk.files.get(e.path)
    return f
      ? { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
      : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', (_, e) => {
    const f = disk.files.get(e.path)
    return f ? { value: f.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.write', (_, e) => {
    disk.tick += 1
    disk.files.set(e.path, { text: e.text, mtimeMs: disk.tick })
    return { value: undefined }
  })
  const runs: string[][] = []
  const gitlab = new Map<string, unknown>()
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'glab') {
      // `glab api <path>`: answered from the fake GitLab (or a CLI failure when the path is unknown).
      const body = gitlab.get(e.argv[2] as string)
      return {
        value:
          body === undefined
            ? { exitCode: 1, stdout: '', stderr: 'glab: 404 Not Found' }
            : { exitCode: 0, stdout: JSON.stringify(body), stderr: '' },
      } as never
    }
    const target = e.argv[e.argv.length - 1] as string
    disk.removed.push(target)
    disk.files.delete(target)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  return {
    clock,
    gitlab,
    runs,
    store,
    status,
    toasts,
    switchId(next: string) {
      id = next
    },
  }
}

function sidecar(disk: Disk, id: string): { id: string; doneAt: string | null }[] {
  const file = disk.files.get(`${DIR}/${id}.dismissed.json`)
  return file ? (JSON.parse(file.text) as { entries: { id: string; doneAt: string | null }[] }).entries : []
}

async function start($: $Test) {
  await $.session.start({ cwd: '/w/app/sub', surface: 'terminal', isInteractive: true })
}

async function update($: $Test, input: Record<string, unknown>) {
  return $.tool.call({ tool: TOOL, ...input } as never)
}

function other(
  id: string,
  project: string,
  at: number,
  patch: Parameters<typeof applyUpdate>[1],
): SessionFile {
  const iso = new Date(at).toISOString()
  return applyUpdate(newSession({ id, project, cwd: `/w/${project}` }, iso), patch, iso).file
}

async function pane($: $Test) {
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

async function texts(ui: Awaited<ReturnType<typeof pane>>): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
}

test('resolveProgressDir: the option wins, ~ expands, else <config dir>/progress', () => {
  expect(resolveProgressDir('/abs/dir/', { home: '/h' })).toBe('/abs/dir')
  expect(resolveProgressDir('~/p', { home: '/h' })).toBe('/h/p')
  expect(resolveProgressDir('', { home: '/h' })).toBe('/h/.claude/progress')
  expect(resolveProgressDir('', { home: '/h', configDir: '/cfg/' })).toBe('/cfg/progress')
  expect(resolveProgressDir('  ', { home: 'C:\\Users\\me' })).toBe('C:\\Users\\me/.claude/progress')
  expect(resolveProgressDir('', {})).toBeUndefined()
})

test('a session registers its tool and writes its own file, named after its repo', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)

  const file = read(disk, `${DIR}/s-me.json`)
  expect(file.session).toMatchObject({ id: 's-me', project: 'app', cwd: '/w/app/sub', endedAt: null })
  expect(file.tasks).toEqual([])
})

test('progress_update patches the file and answers with the task list', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)

  const answer = await update($, {
    now: 'Writing tests',
    needsYou: ['Pick a name'],
    tasks: [
      { title: 'Design', status: 'done' },
      { title: 'Build', status: 'doing', note: 'half way' },
    ],
  })
  expect(answer).toMatchObject({ result: expect.stringContaining('t2 doing Build') })

  const file = read(disk, `${DIR}/s-me.json`)
  expect(file.now).toBe('Writing tests')
  expect(file.tasks.map(t => [t.id, t.status, t.doneAt !== null])).toEqual([
    ['t1', 'done', true],
    ['t2', 'doing', false],
  ])

  const bad = await update($, { tasks: [{ id: 't9', status: 'done' }] })
  expect(bad).toMatchObject({ result: expect.stringContaining('tasks[0]: no task t9') })
})

test('every session shows: newest update, needs-you from all, one now line each, groups', async ($, on) => {
  const disk = makeDisk()
  put(
    disk,
    `${DIR}/s-other.json`,
    other('s-other', 'site', T0 - HOUR, {
      now: 'Deploying',
      needsYou: ['Approve the deploy'],
      tasks: [{ title: 'Deploy', status: 'blocked', note: 'waits for approval' }],
    }),
  )
  const world = engine(on, disk)
  await start($)
  await update($, {
    now: 'Writing tests',
    needsYou: ['Push OK'],
    tasks: [{ title: 'Build', status: 'doing' }],
  })

  const ui = await pane($)
  const lines = await texts(ui)
  expect(lines).toContain('⚠ Needs you (2)')
  expect(lines).toContain('• app: Push OK')
  expect(lines).toContain('• site: Approve the deploy')
  expect(lines.indexOf('app · Writing tests')).toBeLessThan(lines.indexOf('site · Deploying'))
  expect(lines).toContain('✗ Deploy')
  expect(lines).toContain('waits for approval')
  expect(lines).toContain('● Build')
  expect(lines[0]).toMatch(/^updated \d\d:\d\d · app · checked \d\d:\d\d:\d\d$/)
  expect(world.status.at(-1)).toBe('⚠ 2 need you')
  expect(await ui.find({ type: 'Button', key: 'group:s-me' })).toBeTruthy()
  await ui.unmount()
})

test('another session changing its file shows after the next 2 s tick, with a toast for new asks', async ($, on) => {
  const disk = makeDisk()
  put(disk, `${DIR}/s-other.json`, other('s-other', 'site', T0, { now: 'Idle' }))
  const world = engine(on, disk)
  await start($)

  put(disk, `${DIR}/s-other.json`, other('s-other', 'site', T0, { now: 'Busy', needsYou: ['Answer me'] }))
  let ui = await pane($)
  expect(await texts(ui)).toContain('site · Idle')
  await ui.unmount()

  await world.clock.advance(2000)
  ui = await pane($)
  expect(await texts(ui)).toContain('site · Busy')
  expect(world.toasts).toEqual(['site needs you: Answer me'])
  await ui.unmount()

  await world.clock.advance(2000)
  expect(world.toasts).toHaveLength(1)
})

test('Done folds, shows done times; ✕ / Clear all go to the sidecar and stay gone', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, {
    tasks: [
      { title: 'Alpha', status: 'done' },
      { title: 'Beta', status: 'done' },
      { title: 'Gamma', status: 'doing' },
    ],
  })
  const own = disk.files.get(`${DIR}/s-me.json`)?.text

  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /Alpha/ })).toBeUndefined()
  await ui.press({ key: 'done:s-me' })
  const alpha = await ui.find({ type: 'Text', text: /^✓ Alpha/ })
  expect(alpha?.text).toMatch(/^✓ Alpha {2}\d\d:\d\d$/)

  await ui.press({ key: 'dismiss:s-me:t1' })
  expect(await ui.find({ type: 'Text', text: /Alpha/ })).toBeUndefined()
  // The pane never writes a session's own file: the dismissal lands in the sidecar.
  expect(disk.files.get(`${DIR}/s-me.json`)?.text).toBe(own)
  expect(sidecar(disk, 's-me').map(d => d.id)).toEqual(['t1'])

  // The owner merges the sidecar on its next write; a re-sent done copy stays gone.
  await update($, { tasks: [{ id: 't1', title: 'Alpha', status: 'done' }] })
  expect(read(disk, `${DIR}/s-me.json`).tasks.map(t => t.id)).toEqual(['t2', 't3'])
  expect(read(disk, `${DIR}/s-me.json`).dismissed).toEqual(['t1'])

  await ui.press({ key: 'clear:s-me' })
  expect(sidecar(disk, 's-me').map(d => d.id)).toEqual(['t1', 't2'])
  expect(await ui.find({ type: 'Button', key: 'done:s-me' })).toBeUndefined()
  await update($, { now: 'later' })
  expect(read(disk, `${DIR}/s-me.json`).tasks.map(t => t.id)).toEqual(['t3'])
  await ui.unmount()
})

test("✕ on another session's task never writes that session's file", async ($, on) => {
  const disk = makeDisk()
  put(
    disk,
    `${DIR}/s-other.json`,
    other('s-other', 'site', T0, { tasks: [{ title: 'Shipped', status: 'done' }] }),
  )
  const before = disk.files.get(`${DIR}/s-other.json`)?.text
  engine(on, disk)
  await start($)

  const ui = await pane($)
  await ui.press({ key: 'done:s-other' })
  await ui.press({ key: 'dismiss:s-other:t1' })
  expect(disk.files.get(`${DIR}/s-other.json`)?.text).toBe(before)
  expect(sidecar(disk, 's-other').map(d => d.id)).toEqual(['t1'])
  expect(await ui.find({ type: 'Text', text: /Shipped/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'done:s-other' })).toBeUndefined()
  await ui.unmount()
})

test('a dismissed task that is reopened and finished again shows again', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { tasks: [{ title: 'Flaky', status: 'done' }] })
  const ui = await pane($)
  await ui.press({ key: 'done:s-me' })
  await ui.press({ key: 'dismiss:s-me:t1' })
  await ui.unmount()

  await world.clock.advance(60_000)
  await update($, { tasks: [{ id: 't1', title: 'Flaky', status: 'doing' }] })
  await world.clock.advance(60_000)
  await update($, { tasks: [{ id: 't1', status: 'done' }] })

  // The Done fold stays open from before (fold state is the pane's, not the mount's).
  const again = await pane($)
  expect(await again.find({ type: 'Text', text: /^✓ Flaky/ })).toBeTruthy()
  await again.unmount()
})

test('a half-written file keeps the last good state: no flicker, no repeated toast', async ($, on) => {
  const disk = makeDisk()
  put(disk, `${DIR}/s-other.json`, other('s-other', 'site', T0, { now: 'Deploying', needsYou: ['Approve'] }))
  const world = engine(on, disk)
  await start($)
  await world.clock.advance(2000)
  expect(world.toasts).toEqual([])

  disk.tick += 1
  disk.files.set(`${DIR}/s-other.json`, { text: '{ "version": 2, "sess', mtimeMs: disk.tick })
  await world.clock.advance(2000)
  let ui = await pane($)
  expect(await texts(ui)).toContain('site · Deploying')
  await ui.unmount()

  put(disk, `${DIR}/s-other.json`, other('s-other', 'site', T0, { now: 'Deployed', needsYou: ['Approve'] }))
  await world.clock.advance(2000)
  ui = await pane($)
  expect(await texts(ui)).toContain('site · Deployed')
  await ui.unmount()
  expect(world.toasts).toEqual([])
})

test('a group folds and unfolds; ended sessions start folded and dimmed', async ($, on) => {
  const disk = makeDisk()
  const ended = other('s-old', 'old', T0 - HOUR, { tasks: [{ title: 'Legacy', status: 'doing' }] })
  ended.session.endedAt = new Date(T0 - HOUR / 2).toISOString()
  put(disk, `${DIR}/s-old.json`, ended)
  engine(on, disk)
  await start($)
  await update($, { tasks: [{ title: 'Mine', status: 'doing' }] })

  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /Legacy/ })).toBeUndefined()
  const header = await ui.find({ type: 'Button', key: 'group:s-old' })
  expect(header?.text).toMatch(/^▸ old · ended \d\d:\d\d · 1 open · 0 done$/)
  await ui.press({ key: 'group:s-old' })
  expect(await ui.find({ type: 'Text', text: /Legacy/ })).toBeTruthy()

  await ui.press({ key: 'group:s-me' })
  expect(await ui.find({ type: 'Text', text: /Mine/ })).toBeUndefined()
  await ui.unmount()
})

test('session.end stamps endedAt; /clear moves on to a fresh file under the new id', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await $.session.end({ reason: 'clear' } as never)
  expect(read(disk, `${DIR}/s-me.json`).session.endedAt).not.toBeNull()

  world.switchId('s-next')
  await update($, { now: 'after clear' })
  expect(read(disk, `${DIR}/s-next.json`)).toMatchObject({ now: 'after clear', session: { endedAt: null } })
})

test(
  'retention: done tasks auto-clear after the set hours; old ended sessions are deleted',
  { options: { autoClearDoneHours: '1', keepEndedSessionsDays: '1' } },
  async ($, on) => {
    const disk = makeDisk()
    const gone = other('s-gone', 'gone', T0 - 3 * 24 * HOUR, {})
    gone.session.endedAt = new Date(T0 - 2 * 24 * HOUR).toISOString()
    put(disk, `${DIR}/s-gone.json`, gone)
    const world = engine(on, disk)
    await start($)
    await update($, {
      tasks: [
        { title: 'Quick', status: 'done' },
        { title: 'Long', status: 'doing' },
      ],
    })

    await world.clock.advance(2000)
    expect(disk.removed).toEqual([`${DIR}/s-gone.json`, `${DIR}/s-gone.dismissed.json`])
    expect(read(disk, `${DIR}/s-me.json`).tasks).toHaveLength(2)

    await world.clock.advance(HOUR)
    expect(read(disk, `${DIR}/s-me.json`).tasks.map(t => t.title)).toEqual(['Long'])
  },
)

test('the sort Button cycles status → title → created → done and remembers it', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, {
    tasks: [
      { title: 'b-task', status: 'todo' },
      { title: 'a-task', status: 'doing' },
    ],
  })

  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'sort' }))?.text).toBe('Sort: status')
  let lines = await texts(ui)
  expect(lines.indexOf('● a-task')).toBeLessThan(lines.indexOf('○ b-task'))

  await ui.press({ key: 'sort' })
  expect((await ui.find({ type: 'Button', key: 'sort' }))?.text).toBe('Sort: title')
  await ui.press({ key: 'sort' })
  expect((await ui.find({ type: 'Button', key: 'sort' }))?.text).toBe('Sort: created')
  lines = await texts(ui)
  expect(lines.indexOf('○ b-task')).toBeLessThan(lines.indexOf('● a-task'))
  expect(world.store.get('sortTasksBy')).toBe('created')
  await ui.unmount()
})

test('CLAUDE_CONFIG_DIR moves the store', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk, { env: { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' } })
  await start($)
  expect(disk.files.has('/cfg/progress/s-me.json')).toBe(true)
})

test('the progressDir option names the folder', { options: { progressDir: '~/status' } }, async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  expect(disk.files.has('/home/me/status/s-me.json')).toBe(true)
})

test('an unreadable file in the folder is skipped, not fatal', async ($, on) => {
  const disk = makeDisk()
  disk.files.set(`${DIR}/broken.json`, { text: '{ nope', mtimeMs: 1 })
  disk.files.set(`${DIR}/notes.txt`, { text: 'x', mtimeMs: 1 })
  engine(on, disk)
  await start($)
  const ui = await pane($)
  expect(await ui.find({ type: 'Button', key: 'group:s-me' })).toBeTruthy()
  await ui.unmount()
})

test('/progress reopens the pane', async ($, on) => {
  engine(on, makeDisk())
  await start($)
  const answer = await $.command.run({
    command: 'progress',
    args: '',
    origin: { kind: 'sdk' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(answer).toMatchObject({ text: 'Progress pane opened.' })
})

test('an ended session can be forgotten with its ✕; Windows deletes with del', async ($, on) => {
  const disk = makeDisk()
  const ended = other('s-old', 'old', T0 - HOUR, {})
  ended.session.endedAt = new Date(T0 - HOUR / 2).toISOString()
  put(disk, '/Users/me/.claude/progress/s-old.json', ended)
  const world = engine(on, disk, { env: { USERPROFILE: '/Users/me', OS: 'Windows_NT' } })
  await start($)

  put(disk, '/Users/me/.claude/progress/s-old.dismissed.json', {
    version: 1,
    sessionId: 's-old',
    entries: [],
  })
  const ui = await pane($)
  await ui.press({ key: 'forget:s-old' })
  expect(world.runs.slice(-2)).toEqual([
    ['cmd', '/c', 'del', '/q', '\\Users\\me\\.claude\\progress\\s-old.json'],
    ['cmd', '/c', 'del', '/q', '\\Users\\me\\.claude\\progress\\s-old.dismissed.json'],
  ])
  expect(await ui.find({ type: 'Button', key: 'group:s-old' })).toBeUndefined()
  await ui.unmount()
})

test('my own asks never toast; skipped tasks list under Done with a dash', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { needsYou: ['Mine'], tasks: [{ title: 'Dropped', status: 'skipped' }] })
  await world.clock.advance(2000)
  expect(world.toasts).toEqual([])
  expect(world.status.at(-1)).toBe('⚠ 1 need you')

  await update($, { needsYou: [] })
  expect(world.status.at(-1)).toBeUndefined()

  const ui = await pane($)
  await ui.press({ key: 'done:s-me' })
  expect((await ui.find({ type: 'Text', text: /Dropped/ }))?.text).toMatch(/^– Dropped {2}\d\d:\d\d$/)
  await ui.unmount()
})

test('with no home directory the pane says so instead of failing', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk, { env: {} })
  await start($)
  const answer = await update($, { now: 'x' })
  expect(answer).toMatchObject({ result: expect.stringContaining('no progress folder') })
  const ui = await pane($)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No session has reported progress yet.')
  await ui.unmount()
})

test('the header says when the pane last checked, and flags a check that stopped', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { now: 'x' })
  const clock = (ms: number) => {
    const d = new Date(ms)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
  }

  let ui = await pane($)
  expect((await texts(ui))[0]).toMatch(new RegExp(`· checked ${clock(T0)}$`))
  await ui.unmount()

  await world.clock.advance(4000)
  ui = await pane($)
  expect((await texts(ui))[0]).toMatch(new RegExp(`· checked ${clock(T0 + 4000)}$`))
  await ui.unmount()

  disk.listFails = true
  await world.clock.advance(12_000)
  ui = await pane($)
  const header = await ui.find({ type: 'Text', text: /checked/ })
  expect(header?.text).toMatch(new RegExp(`· checked ${clock(T0 + 4000)} \\(stale\\)$`))
  await ui.unmount()
})

const PIPE = 'projects/g%2Fapp/pipelines/42'

function jobsOf(...states: [string, string][]): unknown[] {
  return states.map(([name, status], i) => ({
    name,
    stage: 'build',
    status,
    duration: status === 'running' ? null : 10 + i,
  }))
}

test('a watched pipeline shows live: progress bar, counts and every job', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, {
    id: 42,
    status: 'running',
    ref: 'main',
    web_url: 'https://gitlab.example/g/app/-/pipelines/42',
  })
  world.gitlab.set(
    `${PIPE}/jobs?per_page=100`,
    jobsOf(['lint', 'success'], ['test', 'running'], ['build', 'pending'], ['docs', 'skipped']),
  )
  await start($)

  const answer = await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })
  expect(answer).toMatchObject({ result: expect.stringContaining('watching g/app#42') })

  // Folded (the default, running or not): the header and the counts line only.
  const ui = await pane($)
  let lines = await texts(ui)
  expect((await ui.find({ type: 'Button', key: 'pipelines' }))?.text).toBe(
    '▾ Pipelines  1 watching · 0 succeeded · 0 failed',
  )
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe(
    '▸ app #42 · main · running  ████░░░░ 2/4',
  )
  expect(lines).toContain('1 running · 1 queued · 1 skipped · 1 passed · 0 failed')
  expect(lines).not.toContain('✓ lint   10s')

  // Unfolded: the jobs under their stage, names padded so the times line up.
  await ui.press({ key: 'pipe:s-me:g/app#42' })
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe(
    '▾ app #42 · main · running  ████░░░░ 2/4',
  )
  lines = await texts(ui)
  expect(lines).toContain('1 running · 1 queued · 1 skipped · 1 passed · 0 failed')
  expect(lines).toContain('build')
  expect(lines).toContain('✓ lint   10s')
  expect(lines).toContain('● test')
  expect(lines).toContain('○ build')
  expect(lines).toContain('– docs   13s')
  await ui.unmount()
})

test('the session polls its unfinished pipelines every 15 s and stops once they finish', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })
  const calls = () => world.runs.filter(r => r[0] === 'glab').length
  expect(calls()).toBe(2)

  world.gitlab.set(PIPE, { id: 42, status: 'failed', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'failed']))
  await world.clock.advance(15_000)
  expect(calls()).toBe(4)
  const p = read(disk, `${DIR}/s-me.json`).pipelines?.[0]
  expect(p).toMatchObject({ state: 'failed', jobs: [{ name: 'lint', state: 'failed' }] })
  expect(p?.finishedAt).toBeTruthy()

  await world.clock.advance(60_000)
  expect(calls()).toBe(4)

  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe(
    '▸ app #42 · main · failed  ████████ 1/1',
  )
  await ui.unmount()
})

test('a pipeline watched by commit is found once GitLab has it', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { watch: [{ project: 'g/app', sha: 'abc123', label: 'app main' }] })
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({ key: 'g/app@abc123', id: null })

  world.gitlab.set('projects/g%2Fapp/pipelines?sha=abc123&per_page=1', [
    { id: 42, status: 'pending', ref: 'main' },
  ])
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'pending']))
  await world.clock.advance(15_000)
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({
    id: 42,
    state: 'queued',
    label: 'app main',
  })
})

test('a glab failure shows on the pipeline instead of breaking the pane', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, { watch: [{ project: 'g/none', pipeline: 9 }] })
  const ui = await pane($)
  expect(await texts(ui)).toContain('glab: 404 Not Found')
  await ui.unmount()
})

test("another session's pipelines show read-only and are never polled here; ✕ hides a finished one", async ($, on) => {
  const disk = makeDisk()
  const theirs = other('s-other', 'site', T0, {})
  theirs.pipelines = [
    {
      key: 'g/site#7',
      project: 'g/site',
      id: 7,
      label: 'site',
      state: 'success',
      ref: 'main',
      jobs: [{ name: 'deploy', stage: 'deploy', state: 'success', durationS: 61 }],
      addedAt: new Date(T0).toISOString(),
      checkedAt: new Date(T0).toISOString(),
      finishedAt: new Date(T0).toISOString(),
    },
  ]
  put(disk, `${DIR}/s-other.json`, theirs)
  const before = disk.files.get(`${DIR}/s-other.json`)?.text
  const world = engine(on, disk)
  await start($)
  await world.clock.advance(30_000)
  expect(world.runs.filter(r => r[0] === 'glab')).toEqual([])

  // Every pipeline succeeded: the section starts folded to its summary.
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'pipelines' }))?.text).toBe(
    '▸ Pipelines  0 watching · 1 succeeded · 0 failed',
  )
  expect(await ui.find({ type: 'Button', key: 'pipe:s-other:g/site#7' })).toBeUndefined()
  await ui.press({ key: 'pipelines' })
  expect((await ui.find({ type: 'Button', key: 'pipe:s-other:g/site#7' }))?.text).toBe(
    '▸ site #7 · main · success  ████████ 1/1',
  )
  await ui.press({ key: 'unpipe:s-other:g/site#7' })
  expect(await ui.find({ type: 'Button', key: 'pipe:s-other:g/site#7' })).toBeUndefined()
  expect(disk.files.get(`${DIR}/s-other.json`)?.text).toBe(before)
  expect(sidecar(disk, 's-other').map(d => d.id)).toEqual(['pipeline:g/site#7'])
  await ui.unmount()
})

test('the Pipelines section folds itself once every pipeline succeeded, and opens on news', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })

  let ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'pipelines' }))?.text).toBe(
    '▾ Pipelines  1 watching · 0 succeeded · 0 failed',
  )
  expect(await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' })).toBeTruthy()
  await ui.unmount()

  world.gitlab.set(PIPE, { id: 42, status: 'success', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'success']))
  await world.clock.advance(15_000)
  ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'pipelines' }))?.text).toBe(
    '▸ Pipelines  0 watching · 1 succeeded · 0 failed',
  )
  expect(await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' })).toBeUndefined()

  // The person's own unfold holds while nothing changes…
  await ui.press({ key: 'pipelines' })
  expect(await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' })).toBeTruthy()
  await ui.press({ key: 'pipelines' })
  expect(await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' })).toBeUndefined()
  await ui.unmount()

  // …and news (a new pipeline running) opens the section again.
  world.gitlab.set('projects/g%2Fapp/pipelines/43', { id: 43, status: 'running', ref: 'next' })
  world.gitlab.set('projects/g%2Fapp/pipelines/43/jobs?per_page=100', jobsOf(['lint', 'running']))
  await update($, { watch: [{ project: 'g/app', pipeline: 43 }] })
  ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'pipelines' }))?.text).toBe(
    '▾ Pipelines  1 watching · 1 succeeded · 0 failed',
  )
  await ui.unmount()
})

test('a failed pipeline keeps the Pipelines section open', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'failed', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'failed']))
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'pipelines' }))?.text).toBe(
    '▾ Pipelines  0 watching · 0 succeeded · 1 failed',
  )
  expect(await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' })).toBeTruthy()
  await ui.unmount()
})

test("the pipeline line ends with its duration: live while running, GitLab's once finished", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, {
    id: 42,
    status: 'running',
    ref: 'main',
    started_at: new Date(T0 - 65_000).toISOString(),
  })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })

  let ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe(
    '▸ app #42 · main · running  ░░░░░░░░ 0/1 · 1m05s',
  )
  await ui.unmount()

  world.gitlab.set(PIPE, {
    id: 42,
    status: 'success',
    ref: 'main',
    started_at: new Date(T0 - 65_000).toISOString(),
    finished_at: new Date(T0 + 10_000).toISOString(),
    duration: 70,
  })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'success']))
  await world.clock.advance(15_000)
  ui = await pane($)
  await ui.press({ key: 'pipelines' })
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe(
    '▸ app #42 · main · success  ████████ 1/1 · 1m10s',
  )
  await ui.unmount()
})

test('rows with an action are full-width, the action pushed to the right edge', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, {
    tasks: [
      { title: 'Alpha', status: 'done' },
      { title: 'Beta', status: 'done' },
    ],
  })
  const ui = await pane($)
  await ui.press({ key: 'done:s-me' })
  const spread = (await ui.findAll({ type: 'Box' })).filter(b => b.props.justifyContent === 'space-between')
  // the session header row, the Done row (Clear all) and one row per done task (✕)
  expect(spread.length).toBe(4)
  await ui.unmount()
})

function finishedPipeline(key: string, id: number, startedMs: number, finishedMs: number, state = 'success') {
  return {
    key,
    project: key.split('#')[0] as string,
    id,
    label: (key.split('#')[0] as string).split('/').pop() as string,
    state,
    ref: 'main',
    jobs: [{ name: 'job', stage: 'build', state, durationS: 10 }],
    addedAt: new Date(startedMs).toISOString(),
    checkedAt: new Date(finishedMs).toISOString(),
    startedAt: new Date(startedMs).toISOString(),
    pipelineFinishedAt: new Date(finishedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    durationS: (finishedMs - startedMs) / 1000,
  }
}

test('pipelines: newest first; a success is one line; successes older than 1 h fold into Finished', async ($, on) => {
  const disk = makeDisk()
  const theirs = other('s-other', 'site', T0, {})
  theirs.pipelines = [
    finishedPipeline('g/old#1', 1, T0 - 3 * HOUR, T0 - 2 * HOUR) as never,
    finishedPipeline('g/new#3', 3, T0 - 20 * 60_000, T0 - 10 * 60_000) as never,
    finishedPipeline('g/bad#2', 2, T0 - 4 * HOUR, T0 - 3 * HOUR, 'failed') as never,
  ]
  put(disk, `${DIR}/s-other.json`, theirs)
  engine(on, disk)
  await start($)

  const ui = await pane($)
  // A failure keeps the section open.
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.key)
  const order = buttons.filter(k => k?.startsWith('pipe:'))
  // Newest first; the old success is not in the main list.
  expect(order).toEqual(['pipe:s-other:g/new#3', 'pipe:s-other:g/bad#2'])
  // A success is one line: no counts line under it; the failure keeps its counts line.
  const lines = await texts(ui)
  expect(lines.filter(l => /running · .* passed · /.test(l)).length).toBe(1)
  expect((await ui.find({ type: 'Button', key: 'pipelines-finished' }))?.text).toBe('▸ Finished (1)')

  await ui.press({ key: 'pipelines-finished' })
  expect((await ui.find({ type: 'Button', key: 'pipelines-finished' }))?.text).toBe('▾ Finished (1)')
  expect(await ui.find({ type: 'Button', key: 'pipe:s-other:g/old#1' })).toBeTruthy()
  await ui.unmount()
})

test('the ✕ hitbox is wider than the glyph', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, { tasks: [{ title: 'Alpha', status: 'done' }] })
  const ui = await pane($)
  await ui.press({ key: 'done:s-me' })
  const x = await ui.find({ type: 'Button', key: 'dismiss:s-me:t1' })
  expect(x?.text?.trim()).toBe('✕')
  expect((x?.text ?? '').length).toBeGreaterThanOrEqual(5)
  await ui.unmount()
})
