import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import type { SessionFile } from './model'
import { applyUpdate, formatTime, newSession } from './model'
import { resolveProgressDir } from './paths'
import type { Pipeline } from './pipelines'

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
function engine(
  on: On,
  disk: Disk,
  opts: { env?: Record<string, string>; id?: string; remote?: string | null } = {},
) {
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
  on('session.repo', () => ({ value: { root: '/w/app', remote: opts.remote ?? null } }) as never)
  on('tool.call', () => ({ result: {} }))
  // The engine beneath the classic hooks the plugin reads (they answer nothing of their own).
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('classic.SessionStart', () => ({}) as never)
  // The engine's own system prompt, beneath the plugin's hook.
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
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
  const github = new Map<string, unknown>()
  // While set, every forge call waits on it: a slow network the test releases by hand.
  const net: { hold?: Promise<void>; onHeld?: () => void } = {}
  on('process.run', async (_, e) => {
    runs.push([...e.argv])
    if (net.hold && (e.argv[0] === 'glab' || e.argv[0] === 'gh')) {
      net.onHeld?.()
      await net.hold
    }
    // `<cli> api [--hostname <host>] <path>`: answered by `<host> <path>`, else by `<path>` alone.
    const path = e.argv[e.argv.length - 1] as string
    const host = e.argv[2] === '--hostname' ? (e.argv[3] as string) : undefined
    const answer = (forge: Map<string, unknown>) => forge.get(`${host} ${path}`) ?? forge.get(path)
    if (e.argv[0] === 'gh') {
      // `gh api <path>`: answered from the fake GitHub (or the CLI's 404 when the path is unknown).
      const body = answer(github)
      return {
        value:
          body === undefined
            ? { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
            : { exitCode: 0, stdout: JSON.stringify(body), stderr: '' },
      } as never
    }
    if (e.argv[0] === 'glab') {
      // `glab api <path>`: answered from the fake GitLab (or a CLI failure when the path is unknown).
      const body = answer(gitlab)
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
    github,
    net,
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

// A pipeline's line as read across the row: the header button (left), then its status button
// (right-aligned beside ↗ / ✕).
async function pipeLine(ui: Awaited<ReturnType<typeof pane>>, key: string): Promise<string | undefined> {
  const header = (await ui.find({ type: 'Button', key }))?.text
  const status = (await ui.find({ type: 'Button', key: `pipestate:${key}` }))?.text
  return header === undefined ? undefined : `${header} · ${status}`
}

async function texts(ui: Awaited<ReturnType<typeof pane>>): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
}

test("every session's system prompt tells it to keep its entry current — only where the tool is offered", async ($, on) => {
  engine(on, makeDisk())
  await start($)
  const ids = (r: { sections: readonly { id: string }[] }) => r.sections.map(x => x.id)
  // What the engine resolves before it renders a prompt.
  const compose = (tools: string[], traits: ('teammate' | 'skills')[] = ['skills']) =>
    $.prompt.compose({
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: ['terminal'],
      tools,
      outputStyle: null,
      traits,
    })

  const offered = await compose(['Bash', TOOL])
  expect(ids(offered)).toEqual(['intro', 'progress-panel:reporting'])
  const section = offered.sections[1]
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain(TOOL)
  // The rule itself: the task list first, statuses as they move, the asks, every push watched.
  expect(section?.text).toMatch(/first tool call/i)
  expect(section?.text).toContain('needsYou')
  expect(section?.text).toContain('watch')

  // No tool (not offered to this thread): nothing to report through, no section.
  expect(ids(await compose(['Bash']))).toEqual(['intro'])
  // A teammate renders its lead's prompt: its lead's session reports, not a second copy.
  expect(ids(await compose([TOOL], ['teammate']))).toEqual(['intro'])
})

test('resolveProgressDir: the option wins, ~ expands, else <config dir>/progress', () => {
  expect(resolveProgressDir('/abs/dir/', { home: '/h' })).toBe('/abs/dir')
  expect(resolveProgressDir('~/p', { home: '/h' })).toBe('/h/p')
  expect(resolveProgressDir('', { home: '/h' })).toBe('/h/.claude/progress')
  expect(resolveProgressDir('', { home: '/h', configDir: '/cfg/' })).toBe('/cfg/progress')
  expect(resolveProgressDir('  ', { home: 'C:\\Users\\me' })).toBe('C:\\Users\\me/.claude/progress')
  expect(resolveProgressDir('', {})).toBeUndefined()
})

test('a session is shown by the name Claude Code gives it, and follows a rename', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, { now: 'testing', needsYou: ['an OK'] })
  let ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'group:s-me' }))?.text).toMatch(/^▾ app \(this session\)/)
  await ui.unmount()

  // `/rename` reaches the plugin with the next prompt (UserPromptSubmit carries the title).
  await $.classic.UserPromptSubmit({ prompt: 'go on', session_title: 'Switchboard + Panel' } as never)
  expect(read(disk, `${DIR}/s-me.json`).session).toMatchObject({
    project: 'app',
    title: 'Switchboard + Panel',
  })
  ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'group:s-me' }))?.text).toMatch(
    /^▾ Switchboard \+ Panel \(this session\)/,
  )
  const lines = await texts(ui)
  expect(lines).toContain('Switchboard + Panel · testing')
  expect(lines).toContain('• Switchboard + Panel: an OK')
  await ui.unmount()

  // A prompt without a title (an unnamed session) keeps the one it has.
  await $.classic.UserPromptSubmit({ prompt: 'more' } as never)
  expect(read(disk, `${DIR}/s-me.json`).session.title).toBe('Switchboard + Panel')
})

test('a resumed session takes its name from SessionStart; one that reported nothing still writes nothing', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_title: 'Named' } as never)
  expect(disk.files.has(`${DIR}/s-me.json`)).toBe(false)
  await update($, { now: 'x' })
  expect(read(disk, `${DIR}/s-me.json`).session.title).toBe('Named')
})

test('a session writes its own file, named after its repo, on its first report — not before', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  expect(disk.files.has(`${DIR}/s-me.json`)).toBe(false)

  await update($, { now: 'Reading' })
  const file = read(disk, `${DIR}/s-me.json`)
  expect(file.session).toMatchObject({ id: 's-me', project: 'app', cwd: '/w/app/sub', endedAt: null })
  expect(file.tasks).toEqual([])
})

test('a session that reported nothing leaves nothing behind; one emptied before its end is deleted', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await $.session.end({ reason: 'clear' } as never)
  expect([...disk.files.keys()]).toEqual([])

  world.switchId('s-next')
  await update($, { tasks: [{ title: 'Try', status: 'doing' }] })
  await update($, { remove: ['t1'] })
  expect(disk.files.has(`${DIR}/s-next.json`)).toBe(true)
  await $.session.end({ reason: 'exit' } as never)
  expect(disk.files.has(`${DIR}/s-next.json`)).toBe(false)
  expect(disk.removed).toContain(`${DIR}/s-next.dismissed.json`)
})

test('blank sessions never show: an ended one is deleted by any pane, a live one is skipped', async ($, on) => {
  const disk = makeDisk()
  const ended = other('s-ended', 'ended', T0 - HOUR, {})
  ended.session.endedAt = new Date(T0 - HOUR / 2).toISOString()
  put(disk, `${DIR}/s-ended.json`, ended)
  put(disk, `${DIR}/s-idle.json`, other('s-idle', 'idle', T0 - HOUR, {}))
  put(disk, `${DIR}/s-busy.json`, other('s-busy', 'busy', T0 - HOUR, { now: 'Working' }))
  engine(on, disk)
  await start($)

  expect(disk.removed).toEqual([`${DIR}/s-ended.json`, `${DIR}/s-ended.dismissed.json`])
  expect(disk.files.has(`${DIR}/s-idle.json`)).toBe(true)
  const ui = await pane($)
  expect(await ui.find({ type: 'Button', key: 'group:s-idle' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'group:s-me' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'group:s-busy' })).toBeTruthy()
  await ui.unmount()
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
  // Clear all shows only while Done is open: nothing is cleared that the person cannot see.
  expect(await ui.find({ type: 'Button', key: 'clear:s-me' })).toBeUndefined()
  await ui.press({ key: 'done:s-me' })
  expect(await ui.find({ type: 'Button', key: 'clear:s-me' })).toBeTruthy()
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
  await update($, { now: 'before clear' })
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
    const gone = other('s-gone', 'gone', T0 - 3 * 24 * HOUR, { now: 'Was here' })
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
  await update($, { now: 'x' })
  expect(disk.files.has('/cfg/progress/s-me.json')).toBe(true)
})

test('the progressDir option names the folder', { options: { progressDir: '~/status' } }, async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, { now: 'x' })
  expect(disk.files.has('/home/me/status/s-me.json')).toBe(true)
})

test('an unreadable file in the folder is skipped, not fatal', async ($, on) => {
  const disk = makeDisk()
  disk.files.set(`${DIR}/broken.json`, { text: '{ nope', mtimeMs: 1 })
  disk.files.set(`${DIR}/notes.txt`, { text: 'x', mtimeMs: 1 })
  engine(on, disk)
  await start($)
  await update($, { now: 'x' })
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
  const ended = other('s-old', 'old', T0 - HOUR, { now: 'Was here' })
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
  await world.clock.advance(2000)
  const clock = (ms: number) => {
    const d = new Date(ms)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
  }

  let ui = await pane($)
  expect((await texts(ui))[0]).toMatch(new RegExp(`· checked ${clock(T0 + 2000)}$`))
  await ui.unmount()

  await world.clock.advance(4000)
  ui = await pane($)
  expect((await texts(ui))[0]).toMatch(new RegExp(`· checked ${clock(T0 + 6000)}$`))
  await ui.unmount()

  disk.listFails = true
  await world.clock.advance(12_000)
  ui = await pane($)
  const header = await ui.find({ type: 'Text', text: /checked/ })
  expect(header?.text).toMatch(new RegExp(`· checked ${clock(T0 + 6000)} \\(stale\\)$`))
  await ui.unmount()
})

const PIPE = 'projects/g%2Fapp/pipelines/42'

function jobsOf(...states: [string, string][]): unknown[] {
  return states.map(([name, status], i) => ({
    id: 100 + i,
    name,
    stage: 'build',
    status,
    duration: status === 'running' ? null : 10 + i,
    web_url: `https://gitlab.example/g/app/-/jobs/${100 + i}`,
  }))
}

test("a pipeline's status sits on the right, beside ↗ / ✕, and folds the pipeline too", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main', web_url: 'https://gitlab.example/p/42' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })
  const ui = await pane($)
  const row = (await ui.findAll({ type: 'Box' })).find(b => b.props.key === 'row:pipe:s-me:g/app#42')
  expect(row?.props.justifyContent).toBe('space-between')
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe('▸ app #42 · main')
  expect((await ui.find({ type: 'Button', key: 'pipestate:pipe:s-me:g/app#42' }))?.text).toBe(
    'running  ░░░░░░░░ 0/1',
  )
  await ui.press({ key: 'pipestate:pipe:s-me:g/app#42' })
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe('▾ app #42 · main')
  await ui.unmount()
})

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
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe('▸ app #42 · main · running  ████░░░░ 2/4')
  expect(lines).toContain('1 running · 1 queued · 1 skipped · 1 passed · 0 failed')
  expect(lines).not.toContain('✓ lint   10s')

  // Unfolded: the jobs under their stage, names padded so the times line up.
  await ui.press({ key: 'pipe:s-me:g/app#42' })
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe('▾ app #42 · main · running  ████░░░░ 2/4')
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
  // The pipeline + jobs reads (the one similar-runs lookup for the estimate is not a poll).
  const calls = () =>
    world.runs.filter(r => r[0] === 'glab' && !(r[r.length - 1] ?? '').includes('status=success')).length
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
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe(
    `▸ app #42 · main · failed  ████████ 1/1 · ${formatTime(isoAt(T0 + 15_000), T0 + 75_000)}`,
  )
  await ui.unmount()
})

test('an update sent while the session polls its pipeline is never overwritten by the poll', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  await start($)
  await update($, {
    tasks: [{ title: 'ship it', status: 'doing' }],
    watch: [{ project: 'g/app', pipeline: 42 }],
  })

  // The poll reads the file, then waits on GitLab; the person's update lands meanwhile.
  world.gitlab.set(PIPE, { id: 42, status: 'success', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'success']))
  let release = () => {}
  world.net.hold = new Promise<void>(r => {
    release = r
  })
  const held = new Promise<void>(r => {
    world.net.onHeld = r
  })
  const polling = world.clock.advance(15_000)
  await held
  await update($, { tasks: [{ id: 't1', status: 'done' }], now: 'shipped' })
  release()
  world.net.hold = undefined
  await polling

  const file = read(disk, `${DIR}/s-me.json`)
  expect(file.tasks[0]).toMatchObject({ id: 't1', status: 'done' })
  expect(file.now).toBe('shipped')
  expect(file.pipelines?.[0]).toMatchObject({ key: 'g/app#42', state: 'success' })
})

test("every forge call names its host: the remote's for the session's own repo, else the public one", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk, { remote: 'git@git.example.com:team/app.git' })
  const own = 'projects/team%2Fapp/pipelines/7'
  world.gitlab.set(`git.example.com ${own}`, { id: 7, status: 'running', ref: 'main' })
  world.gitlab.set(`git.example.com ${own}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  world.github.set('ghe.example.com repos/o/r/actions/runs/9', {
    id: 9,
    status: 'in_progress',
    head_branch: 'main',
  })
  world.github.set('ghe.example.com repos/o/r/actions/runs/9/jobs?per_page=100', { jobs: [] })
  await start($)
  await update($, {
    watch: [
      { project: 'team/app', pipeline: 7 },
      { provider: 'github', project: 'o/r', run: 9, host: 'ghe.example.com' },
      { project: 'g/app', pipeline: 42 },
    ],
  })
  const heads = world.runs.filter(r => /pipelines\/(7|42)$|runs\/9$/.test(r[r.length - 1] ?? ''))
  expect(heads).toEqual([
    ['glab', 'api', '--hostname', 'git.example.com', own],
    ['gh', 'api', '--hostname', 'ghe.example.com', 'repos/o/r/actions/runs/9'],
    ['glab', 'api', '--hostname', 'gitlab.com', 'projects/g%2Fapp/pipelines/42'],
  ])
  const keys = read(disk, `${DIR}/s-me.json`).pipelines?.map(p => [p.key, p.state])
  expect(keys).toEqual([
    ['git.example.com/team/app#7', 'running'],
    ['gh:ghe.example.com/o/r#9', 'running'],
    ['g/app#42', 'unknown'],
  ])
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

test("another session's finished pipelines show read-only and are never polled here; ✕ hides one", async ($, on) => {
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
  expect(await pipeLine(ui, 'pipe:s-other:g/site#7')).toBe(
    `▸ site #7 · main · success  ████████ 1/1 · ${formatTime(isoAt(T0), T0)}`,
  )
  await ui.press({ key: 'unpipe:s-other:g/site#7' })
  expect(await ui.find({ type: 'Button', key: 'pipe:s-other:g/site#7' })).toBeUndefined()
  expect(disk.files.get(`${DIR}/s-other.json`)?.text).toBe(before)
  expect(sidecar(disk, 's-other').map(d => d.id)).toEqual(['pipeline:g/site#7'])
  await ui.unmount()
})

const SITE = 'projects/g%2Fsite/pipelines/7'
const isoAt = (ms: number) => new Date(ms).toISOString()

function sitePipe(over: Partial<Pipeline> = {}): Pipeline {
  return {
    key: 'g/site#7',
    project: 'g/site',
    id: 7,
    label: 'site',
    state: 'running',
    ref: 'main',
    jobs: [{ name: 'deploy', stage: 'build', state: 'running', durationS: null }],
    addedAt: isoAt(T0 - HOUR),
    checkedAt: isoAt(T0 - HOUR),
    startedAt: isoAt(T0 - HOUR),
    ...over,
  }
}

function sidecarFile(disk: Disk, id: string): { entries: { id: string }[]; pipelines?: Pipeline[] } {
  const file = disk.files.get(`${DIR}/${id}.dismissed.json`)
  if (!file) throw new Error(`no sidecar for ${id}`)
  return JSON.parse(file.text)
}

const glabCalls = (runs: string[][], path: string) =>
  runs.filter(r => r[0] === 'glab' && r[r.length - 1] === path).length

test("a stopped session's unfinished pipeline is refreshed by any pane, into its sidecar", async ($, on) => {
  const disk = makeDisk()
  const theirs = other('s-other', 'site', T0 - HOUR, {})
  theirs.session.endedAt = isoAt(T0 - HOUR)
  theirs.pipelines = [sitePipe()]
  put(disk, `${DIR}/s-other.json`, theirs)
  const before = disk.files.get(`${DIR}/s-other.json`)?.text
  const world = engine(on, disk)
  world.gitlab.set(SITE, { id: 7, status: 'success', ref: 'main', duration: 69 })
  world.gitlab.set(`${SITE}/jobs?per_page=100`, jobsOf(['deploy', 'success']))
  await start($)
  await world.clock.advance(15_000)

  // Its file keeps its one writer; the refreshed copy goes to the sidecar.
  expect(disk.files.get(`${DIR}/s-other.json`)?.text).toBe(before)
  expect(sidecarFile(disk, 's-other').pipelines?.[0]).toMatchObject({
    key: 'g/site#7',
    state: 'success',
    durationS: 69,
    jobs: [{ name: 'deploy', state: 'success' }],
  })
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'pipelines' }))?.text).toBe(
    '▸ Pipelines  0 watching · 1 succeeded · 0 failed',
  )
  await ui.press({ key: 'pipelines' })
  expect(await pipeLine(ui, 'pipe:s-other:g/site#7')).toBe(
    `▸ site #7 · main · success  ████████ 1/1 · 1m09s · ${formatTime(isoAt(T0 + 15_000), T0 + 15_000)}`,
  )

  // Finished: nobody polls it again.
  const polled = glabCalls(world.runs, SITE)
  await world.clock.advance(60_000)
  expect(glabCalls(world.runs, SITE)).toBe(polled)

  // ✕ on the refreshed copy hides it and keeps the copy beside the dismissal.
  await ui.press({ key: 'unpipe:s-other:g/site#7' })
  expect(await ui.find({ type: 'Button', key: 'pipe:s-other:g/site#7' })).toBeUndefined()
  expect(sidecarFile(disk, 's-other')).toMatchObject({
    entries: [{ id: 'pipeline:g/site#7' }],
    pipelines: [{ key: 'g/site#7', state: 'success' }],
  })
  await ui.unmount()
})

test("a live session's pipeline is left to its owner until its checks stop for 1 min", async ($, on) => {
  const disk = makeDisk()
  const theirs = other('s-other', 'site', T0, {})
  theirs.pipelines = [sitePipe({ checkedAt: isoAt(T0) })]
  put(disk, `${DIR}/s-other.json`, theirs)
  const world = engine(on, disk)
  world.gitlab.set(SITE, { id: 7, status: 'running', ref: 'main' })
  world.gitlab.set(`${SITE}/jobs?per_page=100`, jobsOf(['deploy', 'running']))
  await start($)
  await world.clock.advance(60_000)
  expect(glabCalls(world.runs, SITE)).toBe(0)
  expect(disk.files.has(`${DIR}/s-other.dismissed.json`)).toBe(false)

  // Its owner went quiet (killed without ending): this pane takes over.
  await world.clock.advance(15_000)
  expect(glabCalls(world.runs, SITE)).toBe(1)
  expect(sidecarFile(disk, 's-other').pipelines?.[0]).toMatchObject({
    state: 'running',
    checkedAt: isoAt(T0 + 75_000),
  })
  // Its own check is fresh again: no second poll until it ages out.
  await world.clock.advance(15_000)
  expect(glabCalls(world.runs, SITE)).toBe(1)
})

test("the owner folds the panes' refreshes into its own file and stops polling a finished one", async ($, on) => {
  const disk = makeDisk()
  const mine = other('s-me', 'app', T0 - HOUR, { now: 'waiting' })
  const watchedPipe = sitePipe({ key: 'g/app#42', project: 'g/app', id: 42, label: 'app' })
  mine.pipelines = [watchedPipe]
  put(disk, `${DIR}/s-me.json`, mine)
  const done = {
    ...watchedPipe,
    state: 'success' as const,
    checkedAt: isoAt(T0 - 1000),
    finishedAt: isoAt(T0 - 1000),
  }
  put(disk, `${DIR}/s-me.dismissed.json`, { version: 1, sessionId: 's-me', entries: [], pipelines: [done] })
  const world = engine(on, disk)
  await start($)
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({ key: 'g/app#42', state: 'success' })
  await world.clock.advance(30_000)
  expect(glabCalls(world.runs, PIPE)).toBe(0)
})

test("a finished pipeline's line ends with when it finished: GitLab's time, else when it was seen", async ($, on) => {
  const disk = makeDisk()
  const theirs = other('s-other', 'site', T0, {})
  const ok = [{ name: 'deploy', stage: 'build', state: 'success' as const, durationS: 5 }]
  theirs.pipelines = [
    sitePipe({
      jobs: ok,
      state: 'success',
      checkedAt: isoAt(T0),
      pipelineFinishedAt: isoAt(T0 - 1_800_000),
      finishedAt: isoAt(T0),
    }),
    // GitLab gave no finish time: when the pane saw it finish; another day carries the date.
    sitePipe({
      key: 'g/site#8',
      id: 8,
      state: 'failed',
      checkedAt: isoAt(T0),
      finishedAt: isoAt(T0 - 30 * HOUR),
    }),
    sitePipe({ key: 'g/site#9', id: 9, checkedAt: isoAt(T0) }),
  ]
  put(disk, `${DIR}/s-other.json`, theirs)
  engine(on, disk)
  await start($)
  const ui = await pane($)
  const line = async (n: number) => await pipeLine(ui, `pipe:s-other:g/site#${n}`)
  expect(await line(7)).toMatch(new RegExp(` · ${formatTime(isoAt(T0 - 1_800_000), T0)}$`))
  expect(formatTime(isoAt(T0 - 30 * HOUR), T0)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/)
  expect(await line(8)).toMatch(new RegExp(` · ${formatTime(isoAt(T0 - 30 * HOUR), T0)}$`))
  // Still running: the live elapsed time ends the line, no finish time.
  expect(await line(9)).toBe('▸ site #9 · main · running  ░░░░░░░░ 0/1 · 1h00m')
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
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe('▸ app #42 · main · running  ░░░░░░░░ 0/1 · 1m05s')
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
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe(
    `▸ app #42 · main · success  ████████ 1/1 · 1m10s · ${formatTime(isoAt(T0 + 10_000), T0 + 15_000)}`,
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

test('a running pipeline shows elapsed / estimate, the estimate fetched once and cached 24 h', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  const started = new Date(T0 - 293_000).toISOString()
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main', source: 'push', started_at: started })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  // Like GitLab: the list has no duration — each sample's details do.
  world.gitlab.set('projects/g%2Fapp/pipelines?ref=main&status=success&source=push&per_page=6', [
    { id: 41, status: 'success' },
    { id: 40, status: 'success' },
  ])
  world.gitlab.set('projects/g%2Fapp/pipelines/41', { id: 41, status: 'success', duration: 1900 })
  world.gitlab.set('projects/g%2Fapp/pipelines/40', { id: 40, status: 'success', duration: 2060 })
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })

  const ui = await pane($)
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe(
    '▸ app #42 · main · running  ░░░░░░░░ 0/1 · 4m53s / ~33m',
  )
  await ui.unmount()
  const listCalls = () =>
    world.runs.filter(r => r[0] === 'glab' && (r[r.length - 1] ?? '').includes('status=success')).length
  expect(listCalls()).toBe(1)

  // A later poll, and a second pipeline of the same kind, reuse the estimate.
  await world.clock.advance(15_000)
  world.gitlab.set('projects/g%2Fapp/pipelines/43', {
    id: 43,
    status: 'running',
    ref: 'main',
    source: 'push',
    started_at: started,
  })
  world.gitlab.set('projects/g%2Fapp/pipelines/43/jobs?per_page=100', jobsOf(['lint', 'running']))
  await update($, { watch: [{ project: 'g/app', pipeline: 43 }] })
  expect(listCalls()).toBe(1)

  // Once the cached estimate is older than 24 h, the next new pipeline asks again.
  const key = 'estimate2:g/app@main:push'
  world.store.set(key, { ...(world.store.get(key) as object), atMs: T0 - 25 * HOUR })
  world.gitlab.set('projects/g%2Fapp/pipelines/44', {
    id: 44,
    status: 'running',
    ref: 'main',
    source: 'push',
    started_at: started,
  })
  world.gitlab.set('projects/g%2Fapp/pipelines/44/jobs?per_page=100', jobsOf(['lint', 'running']))
  await update($, { watch: [{ project: 'g/app', pipeline: 44 }] })
  expect(listCalls()).toBe(2)
})

test('with no similar history the line shows the elapsed time only', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, {
    id: 42,
    status: 'running',
    ref: 'main',
    source: 'push',
    started_at: new Date(T0 - 65_000).toISOString(),
  })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  world.gitlab.set('projects/g%2Fapp/pipelines?ref=main&status=success&source=push&per_page=6', [])
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })
  const ui = await pane($)
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe('▸ app #42 · main · running  ░░░░░░░░ 0/1 · 1m05s')
  await ui.unmount()
})

test('unfolded jobs show elapsed / estimate while running and ~estimate while queued', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  const at = (ms: number) => new Date(ms).toISOString()
  world.gitlab.set(PIPE, {
    id: 42,
    status: 'running',
    ref: 'main',
    source: 'push',
    started_at: at(T0 - 65_000),
  })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, [
    { id: 3, name: 'build', stage: 'build', status: 'pending', duration: null },
    { id: 2, name: 'lint', stage: 'test', status: 'running', duration: null, started_at: at(T0 - 65_000) },
    { id: 1, name: 'setup', stage: 'test', status: 'success', duration: 12 },
  ])
  world.gitlab.set('projects/g%2Fapp/pipelines?ref=main&status=success&source=push&per_page=6', [
    { id: 41, status: 'success' },
    { id: 40, status: 'success' },
  ])
  world.gitlab.set('projects/g%2Fapp/pipelines/41', { id: 41, status: 'success', duration: 700 })
  world.gitlab.set('projects/g%2Fapp/pipelines/40', { id: 40, status: 'success', duration: 760 })
  world.gitlab.set('projects/g%2Fapp/pipelines/41/jobs?per_page=100', [
    { id: 13, name: 'build', stage: 'build', status: 'success', duration: 540 },
    { id: 12, name: 'lint', stage: 'test', status: 'success', duration: 110 },
  ])
  world.gitlab.set('projects/g%2Fapp/pipelines/40/jobs?per_page=100', [
    { id: 11, name: 'build', stage: 'build', status: 'success', duration: 660 },
    { id: 10, name: 'lint', stage: 'test', status: 'success', duration: 130 },
  ])
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })

  const ui = await pane($)
  await ui.press({ key: 'pipe:s-me:g/app#42' })
  const lines = await texts(ui)
  expect(lines).toContain('✓ setup  12s')
  expect(lines).toContain('● lint   1m05s / ~2m')
  expect(lines).toContain('○ build  ~10m')
  await ui.unmount()
})

test('a pipeline left without an estimate gets one once similar runs exist (the cache aged out)', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  const list = 'projects/g%2Fapp/pipelines?ref=main&status=success&source=push&per_page=6'
  world.gitlab.set(PIPE, {
    id: 42,
    status: 'running',
    ref: 'main',
    source: 'push',
    started_at: new Date(T0 - 60_000).toISOString(),
  })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  world.gitlab.set(list, [])
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]?.estimateS).toBeNull()

  world.gitlab.set(list, [{ id: 41, status: 'success' }])
  world.gitlab.set('projects/g%2Fapp/pipelines/41', { id: 41, status: 'success', duration: 1980 })
  const key = 'estimate2:g/app@main:push'
  world.store.set(key, { ...(world.store.get(key) as object), atMs: T0 - 25 * HOUR })
  await world.clock.advance(15_000)
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]?.estimateS).toBe(1980)
})

test('a pipeline and each unfolded job carry a ↗ link to GitLab, on the right edge', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, {
    id: 42,
    status: 'running',
    ref: 'main',
    web_url: 'https://gitlab.example/g/app/-/pipelines/42',
  })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'success'], ['test', 'running']))
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })

  const ui = await pane($)
  const hrefs = async () => (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
  // Folded: the pipeline's own link only, beside its header.
  expect(await hrefs()).toEqual(['https://gitlab.example/g/app/-/pipelines/42'])
  const link = await ui.find({ type: 'Link' })
  expect(link?.props.label).toBe(' ↗ ')

  // Unfolded: one per job too, the job rows spread so the link sits at the right edge.
  await ui.press({ key: 'pipe:s-me:g/app#42' })
  expect(await hrefs()).toEqual([
    'https://gitlab.example/g/app/-/pipelines/42',
    'https://gitlab.example/g/app/-/jobs/100',
    'https://gitlab.example/g/app/-/jobs/101',
  ])
  // The job lines read as before: the link is a sibling, not part of the job's text.
  expect(await texts(ui)).toContain('✓ lint  10s')
  // Each row is its own hover scope (a keyed Box, unique among its siblings): the pointer lights
  // the whole row, so the ↗ at its right edge reads as that row's. (The test kit hands a tree's
  // props without the surface-only `hover` styles, so the scopes are what is pinned here.)
  const rows = (await ui.findAll({ type: 'Box' })).filter(b => String(b.props.key ?? '').startsWith('row:'))
  expect(rows.map(b => b.props.key)).toEqual([
    'row:pipe:s-me:g/app#42',
    'row:pipe:s-me:g/app#42:build:lint',
    'row:pipe:s-me:g/app#42:build:test',
  ])
  await ui.unmount()
})

test('a pipeline or job GitLab gave no address draws no link', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, [{ id: 1, name: 'lint', stage: 'build', status: 'running' }])
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })
  const ui = await pane($)
  await ui.press({ key: 'pipe:s-me:g/app#42' })
  expect(await ui.findAll({ type: 'Link' })).toEqual([])
  expect(await texts(ui)).toContain('● lint')
  await ui.unmount()
})

test('a GitHub Actions run shows like a pipeline: found by commit, flat jobs, ↗ links, estimate', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  const REPO = 'repos/Kirbo/ha'
  const started = new Date(T0 - 30_000).toISOString()
  const run = {
    id: 900,
    name: 'Validate',
    status: 'in_progress',
    conclusion: null,
    head_branch: 'main',
    head_sha: 'abc123',
    event: 'push',
    workflow_id: 77,
    run_started_at: started,
    updated_at: started,
    html_url: 'https://github.com/Kirbo/ha/actions/runs/900',
  }
  world.github.set(`${REPO}/actions/runs?head_sha=abc123&per_page=1`, {
    total_count: 1,
    workflow_runs: [run],
  })
  world.github.set(`${REPO}/actions/runs/900`, run)
  world.github.set(`${REPO}/actions/runs/900/jobs?per_page=100`, {
    total_count: 2,
    jobs: [
      {
        id: 2,
        name: 'Lint',
        status: 'in_progress',
        conclusion: null,
        started_at: started,
        completed_at: null,
        html_url: 'https://github.com/Kirbo/ha/actions/runs/900/job/2',
      },
      {
        id: 1,
        name: 'Tests',
        status: 'completed',
        conclusion: 'success',
        started_at: started,
        completed_at: new Date(T0 - 10_000).toISOString(),
        html_url: 'https://github.com/Kirbo/ha/actions/runs/900/job/1',
      },
    ],
  })
  // Similar runs: the same workflow, branch and event, successful — durations from the list.
  world.github.set(`${REPO}/actions/workflows/77/runs?branch=main&event=push&status=success&per_page=6`, {
    total_count: 2,
    workflow_runs: [
      {
        ...run,
        id: 899,
        status: 'completed',
        conclusion: 'success',
        run_started_at: started,
        updated_at: new Date(T0 + 30_000).toISOString(),
      },
      {
        ...run,
        id: 898,
        status: 'completed',
        conclusion: 'success',
        run_started_at: started,
        updated_at: new Date(T0 + 90_000).toISOString(),
      },
    ],
  })
  world.github.set(`${REPO}/actions/runs/899/jobs?per_page=100`, { total_count: 0, jobs: [] })
  world.github.set(`${REPO}/actions/runs/898/jobs?per_page=100`, { total_count: 0, jobs: [] })
  await start($)
  await update($, { watch: [{ provider: 'github', project: 'Kirbo/ha', sha: 'abc123' }] })

  const saved = read(disk, `${DIR}/s-me.json`).pipelines?.[0]
  expect(saved?.key).toBe('gh:Kirbo/ha@abc123')
  expect(saved?.provider).toBe('github')
  expect(saved?.id).toBe(900)
  expect(saved?.state).toBe('running')
  expect(saved?.estimateS).toBe(90)
  // Only `gh` was asked — never `glab` for a GitHub run.
  expect(world.runs.some(r => r[0] === 'glab')).toBe(false)

  const ui = await pane($)
  expect(await pipeLine(ui, 'pipe:s-me:gh:Kirbo/ha@abc123')).toBe(
    '▸ ha #900 · main · running  ████░░░░ 1/2 · 30s / ~2m',
  )
  await ui.press({ key: 'pipe:s-me:gh:Kirbo/ha@abc123' })
  const hrefs = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
  expect(hrefs).toEqual([
    'https://github.com/Kirbo/ha/actions/runs/900',
    'https://github.com/Kirbo/ha/actions/runs/900/job/1',
    'https://github.com/Kirbo/ha/actions/runs/900/job/2',
  ])
  // Flat: no empty stage heading between the counts and the jobs.
  expect(await texts(ui)).not.toContain('')
  await ui.unmount()
})
