import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { en } from '../locales/en'
import { STILL_RUNS, WHO_AM_I } from './host'
import type { SessionFile } from './model'
import { applyUpdate, formatTime, newSession, REMOVAL_DUE_MS, stepCounts, UNDO_MS } from './model'
import { resolveProgressDir } from './paths'
import type { Pipeline } from './pipelines'
import { INPUT_SCHEMA, schemaProblems } from './schema'

type On = Parameters<TestBody>[1]
const TOOL_DESCRIPTION = en['tool.description']
const SUBAGENT_RULE_TEXT = en['prompt.subagent']
type $Test = Parameters<TestBody>[0]

const T0 = Date.UTC(2026, 10, 6, 20, 0, 0)
const PANEL_REPO = 'https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel'
const LATEST =
  'https://gitlab.com/api/v4/projects/KirboDev%2Fagentic-coding%2Fclaude-progress-panel/releases?per_page=1'
const HOUR = 3_600_000
const DIR = '/home/me/.claude/progress'
const TOOL = 'mcp__progress-panel__progress_update'
// A removal in a pane is acted on by its session only once it can no longer be taken back: this
// long after the press (the window, then the session's next scan).
const UNDO_OVER = REMOVAL_DUE_MS + 2100

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
  /** A path whose reads fail while it is still there (an I/O error, a lock). */
  readFails?: string
  /** Runs once right after the next read of this path: another process writing in between. */
  afterRead?: { path: string; run: () => void }
}

// The disk's key for a path as the engine hands it to an `fs.*` hook. On Windows the engine
// normalizes a path before the hooks see it (backslashes, the drive), so the plugin's
// `/home/me/.claude/progress/s-me.json` arrives as `C:\\home\\me\\.claude\\…` there: one canonical
// key keeps every test exercising the same plugin code on Linux, macOS and Windows alike.
function diskKey(path: string): string {
  return path.replace(/^[A-Za-z]:(?=[\\/])/, '').replace(/\\/g, '/')
}

function makeDisk(): Disk {
  return { files: new Map(), removed: [], tick: 1 }
}

function put(disk: Disk, path: string, value: unknown) {
  disk.tick += 1
  disk.files.set(path, { text: JSON.stringify(value), mtimeMs: disk.tick })
}

// A file's raw text, as another writer left it (half a file, damaged JSON).
function putText(disk: Disk, path: string, text: string) {
  disk.tick += 1
  disk.files.set(path, { text, mtimeMs: disk.tick })
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
  // Every pane open, as asked (the sizes it requests included).
  const opened: Record<string, unknown>[] = []
  on('ui.open', (_, e) => {
    opened.push({ ...(e as unknown as Record<string, unknown>) })
    return { value: { isPlaced: true } }
  })
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
  on('classic.PostToolUse', () => ({}) as never)
  on('classic.SubagentStop', () => ({}) as never)
  on('classic.SubagentStart', () => ({}) as never)
  on('classic.Notification', () => ({}) as never)
  on('classic.PostToolUseFailure', () => ({}) as never)
  on('classic.PermissionDenied', () => ({}) as never)
  on('classic.Stop', () => ({}) as never)
  // A model request's bottom: the engine's own send (the plugin only reads what it names).
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }
  } as never)
  // The session's subagents, as $.agent.list() answers (their Agent call's description).
  const agents: { id: string; description: string; type: string; status: string }[] = []
  on('agent.list', () => ({ value: agents }) as never)
  // The engine's own system prompt, beneath the plugin's hook.
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  on('fs.list', (_, e) => {
    if (disk.listFails) return { deny: `EACCES: ${e.path}` }
    const prefix = `${diskKey(e.path)}/`
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
    const f = disk.files.get(diskKey(e.path))
    return f
      ? { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
      : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', (_, e) => {
    if (disk.readFails === diskKey(e.path)) return { deny: `EIO: ${e.path}` }
    const f = disk.files.get(diskKey(e.path))
    if (!f && diskKey(e.path).endsWith('/.claude-plugin/plugin.json'))
      return {
        value: JSON.stringify({
          name: 'progress-panel',
          version: '0.14.0',
          repository: PANEL_REPO,
          // The defaults the Settings view compares against (a changed value is drawn bold).
          userConfig: {
            palette: { default: 'default' },
            bell: { default: 'off' },
            autoStart: { default: 'on' },
            pipelinesDefault: { default: 'on' },
          },
        }),
      }
    const between = disk.afterRead
    if (between && between.path === diskKey(e.path)) {
      disk.afterRead = undefined
      between.run()
    }
    return f ? { value: f.text } : { deny: `ENOENT: ${e.path}` }
  })
  // The web, as the plugin's $.http.fetch reaches it: answers by URL (else a 404), every fetch recorded.
  const web = new Map<string, unknown>()
  const fetched: string[] = []
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    const body = web.get(e.url)
    return {
      value:
        body === undefined
          ? { status: 404, ok: false, headers: {}, text: '{"message":"404 Not Found"}' }
          : { status: 200, ok: true, headers: {}, text: JSON.stringify(body) },
    } as never
  })
  on('fs.write', (_, e) => {
    disk.tick += 1
    disk.files.set(diskKey(e.path), { text: e.text, mtimeMs: disk.tick })
    return { value: undefined }
  })
  const runs: string[][] = []
  const gitlab = new Map<string, unknown>()
  const github = new Map<string, unknown>()
  // tea: its logins, and API answers by `<login> <path>`.
  const tea: { logins: unknown[]; api: Map<string, unknown> } = { logins: [], api: new Map() }
  // Any other program (a custom CI command): its stdout by the whole argv joined with spaces.
  const programs = new Map<string, string>()
  // A forge CLI call that fails as given, by its API path (before any forge answer).
  const failures = new Map<string, { exitCode: number; stdout: string; stderr: string }>()
  // While set, every forge call waits on it: a slow network the test releases by hand.
  const net: { hold?: Promise<void>; onHeld?: () => void } = {}
  on('process.run', async (_, e) => {
    runs.push([...e.argv])
    const failure = failures.get(e.argv[e.argv.length - 1] as string)
    if (failure) return { value: failure } as never
    if (net.hold && (e.argv[0] === 'glab' || e.argv[0] === 'gh')) {
      net.onHeld?.()
      await net.hold
    }
    // `<cli> api [--hostname <host>] <path>`: answered by `<host> <path>`, else by `<path>` alone.
    const path = e.argv[e.argv.length - 1] as string
    const host = e.argv[2] === '--hostname' ? (e.argv[3] as string) : undefined
    const answer = (forge: Map<string, unknown>) => forge.get(`${host} ${path}`) ?? forge.get(path)
    if (e.argv[0] === 'tea') {
      if (e.argv[1] === 'login')
        return { value: { exitCode: 0, stdout: JSON.stringify(tea.logins), stderr: '' } } as never
      const body = tea.api.get(`${e.argv[3]} ${path}`)
      return {
        value:
          body === undefined
            ? { exitCode: 1, stdout: '', stderr: 'Error: 404 Not Found' }
            : { exitCode: 0, stdout: JSON.stringify(body), stderr: '' },
      } as never
    }
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
    if (e.argv[0] !== 'rm' && e.argv[0] !== 'cmd') {
      const out = programs.get(e.argv.join(' '))
      return {
        value:
          out === undefined
            ? { exitCode: 2, stdout: '', stderr: 'no such job' }
            : { exitCode: 0, stdout: out, stderr: '' },
      } as never
    }
    const target = e.argv[e.argv.length - 1] as string
    disk.removed.push(target)
    disk.files.delete(diskKey(target))
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  return {
    clock,
    gitlab,
    github,
    tea,
    agents,
    opened,
    programs,
    failures,
    net,
    web,
    fetched,
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

// A tool call as the harness makes it: the input is checked against the tool's own schema first, so
// a test can never send what a real agent's call would be refused for.
async function update($: $Test, input: Record<string, unknown>) {
  const problems = schemaProblems(INPUT_SCHEMA, input)
  if (problems.length > 0) throw new Error(`not the tool's input schema: ${problems.join('; ')}`)
  return $.tool.call({ tool: TOOL, ...input } as never)
}

// A new watch's first check is detached from the tool's answer (and from a push's result): the
// answer never waits for a forge. A test that reads the pipeline right after watching it lets that
// check run first — `settle()` moves no time, it only lets what is under way finish.
async function watch($: $Test, world: ReturnType<typeof engine>, input: Record<string, unknown>) {
  const answer = await update($, input)
  await world.clock.settle()
  return answer
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

async function pane($: $Test, bodyColumns = 80) {
  return $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })
}

// A pipeline's line as read across the row: the header button (left), then its status button
// (right-aligned beside ↗ / ✕).
async function pipeLine(ui: Awaited<ReturnType<typeof pane>>, key: string): Promise<string | undefined> {
  const header = (await ui.find({ type: 'Button', key }))?.text
  const status = (await ui.find({ type: 'Button', key: `pipestate:${key}` }))?.text
  return header === undefined ? undefined : `${header} · ${status}`
}

// The Text whose whole text is `text` (find() matches a prefix: the pipeline's "● " mark and the
// switches' "● tasks on" would be one).
async function exactText(ui: Awaited<ReturnType<typeof pane>>, text: string) {
  return (await ui.findAll({ type: 'Text' })).find(x => x.text === text)
}

async function texts(ui: {
  findAll(query: { type: 'Text' }): Promise<readonly { text?: string }[]>
}): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
}

// A session's header line: a Button only while its group has something under it (a task, an agent,
// Done, an undo line); with nothing it is one plain line with no arrow.
async function groupHeader(ui: Awaited<ReturnType<typeof pane>>, id: string, plain: RegExp) {
  expect(await ui.find({ type: 'Button', key: `group:${id}` })).toBeUndefined()
  const line = (await texts(ui)).find(l => plain.test(l))
  expect(line).toBeDefined()
  expect(line).not.toMatch(/^[▾▸]/)
  return line
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
  expect(section?.text).toContain('`order`')
  expect(section?.text).toContain('watch')

  // No tool (not offered to this thread): nothing to report through, no section.
  expect(ids(await compose(['Bash']))).toEqual(['intro'])
  // A teammate renders its lead's prompt: its lead's session reports, not a second copy.
  expect(ids(await compose([TOOL], ['teammate']))).toEqual(['intro'])
})

test('the transcript draws a progress_update call as one quiet line, in full only on ctrl+o', async ($, on) => {
  engine(on, makeDisk())
  // The engine's own rows, beneath the plugin's hook.
  on('ui.render', ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine row</Text>
  })
  await start($)
  const row = (props: Record<string, unknown>) =>
    $.ui.mount({
      plugin: 'progress-panel',
      surface: 'terminal',
      component: 'ToolUse',
      requestId: 'tu1',
      props: {
        tool_use_id: 'tu1',
        tool: TOOL,
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
        isExpanded: false,
        output: 'Saved. 2 task(s):\n…',
        ...props,
      },
    } as never)
  let ui = await row({
    input: {
      now: 'Gitea done. Now: the CI command',
      tasks: [
        { id: 'a', status: 'done' },
        { id: 'b', status: 'doing' },
      ],
    },
  })
  expect(await texts(ui)).toEqual(['◦ Progress · Gitea done. Now: the CI command · 2 tasks'])
  await ui.unmount()
  ui = await row({ input: { watch: [{ project: 'g/app', sha: 'abc1234' }] } })
  expect(await texts(ui)).toEqual(['◦ Progress · watching 1 pipeline'])
  await ui.unmount()
  // ctrl+o (expanded) and errors draw the engine's own row.
  ui = await row({ input: { now: 'x' }, isExpanded: true })
  expect(await texts(ui)).toEqual(['engine row'])
  await ui.unmount()

  // Its result block draws nothing unless expanded or errored.
  const result = await $.ui.mount({
    plugin: 'progress-panel',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'tu1',
    props: {
      tool_use_id: 'tu1',
      tool: TOOL,
      output: 'Saved. 2 task(s)',
      isErrored: false,
      isExpanded: false,
    },
  } as never)
  expect(await texts(result)).toEqual([])
  await result.unmount()
})

test("the pane's corner shows its version, and a newer release with a link to its notes", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.web.set(LATEST, [
    { tag_name: 'v0.14.0', _links: { self: 'https://gitlab.com/p/-/releases/v0.14.0' } },
  ])
  await start($)
  await update($, { now: 'x' })
  let ui = await pane($)
  expect(await ui.find({ type: 'Text', text: 'v0.14.0' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /available/ })).toBeUndefined()
  await ui.unmount()
  expect(world.fetched).toEqual([LATEST])
  expect(world.store.get('latest-release')).toMatchObject({ version: '0.14.0', checkedAtMs: T0 })
  ui = await pane($)
  await ui.unmount()
  expect(world.fetched).toHaveLength(1)
})

test('a check older than 6 h (shared by every session) is made again; a newer release links its notes', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.store.set('latest-release', { version: '0.14.0', url: 'u', checkedAtMs: T0 - 7 * HOUR })
  world.web.set(LATEST, [
    { tag_name: 'v0.15.0', _links: { self: 'https://gitlab.com/p/-/releases/v0.15.0' } },
  ])
  await start($)
  await update($, { now: 'x' })
  expect(world.fetched).toEqual([LATEST])
  const ui = await pane($)
  expect((await ui.find({ type: 'Text', text: /available/ }))?.text).toBe('v0.15.0 available')
  const links = await ui.findAll({ type: 'Link' })
  expect(links.some(l => l.props.href === 'https://gitlab.com/p/-/releases/v0.15.0')).toBe(true)
  await ui.unmount()
})

test('a fresh shared check is reused; a failed one keeps the last answer', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.store.set('latest-release', { version: '0.15.0', url: 'u15', checkedAtMs: T0 - HOUR })
  await start($)
  expect(world.fetched).toEqual([])
  world.store.set('latest-release', { version: '0.15.0', url: 'u15', checkedAtMs: T0 - 7 * HOUR })
  // The shared answer went stale: the next check asks the web (a new session's start runs one —
  // no hour of 2 s ticks, which cost real seconds and timed out on a loaded machine).
  await start($)
  await world.clock.advance(0)
  // The web answers 404: the old answer stays, so the pane still offers 0.15.0.
  expect(world.fetched).toEqual([LATEST])
  await update($, { now: 'x' })
  const ui = await pane($)
  expect((await ui.find({ type: 'Text', text: /available/ }))?.text).toBe('v0.15.0 available')
  await ui.unmount()
})

test('no update check when nonessential traffic is off; the version still shows', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk, { env: { HOME: '/home/me', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  await start($)
  await update($, { now: 'x' })
  expect(world.fetched).toEqual([])
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: 'v0.14.0' })).toBeTruthy()
  await ui.unmount()
})

test("✕ on an open task removes it from every pane, recorded in its session's sidecar", async ($, on) => {
  const disk = makeDisk()
  put(
    disk,
    `${DIR}/s-other.json`,
    other('s-other', 'site', T0, { tasks: [{ title: 'Deploy docs' }, { title: 'Tag release' }] }),
  )
  const before = disk.files.get(`${DIR}/s-other.json`)?.text
  engine(on, disk)
  await start($)
  const ui = await pane($)
  expect(await texts(ui)).toContain('○ Deploy docs')
  await ui.press({ key: 'cancel:s-other:t1' })
  const lines = await texts(ui)
  expect(lines).not.toContain('○ Deploy docs')
  expect(lines).toContain('○ Tag release')
  // The pane never writes the session's own file: the removal waits in its sidecar.
  expect(disk.files.get(`${DIR}/s-other.json`)?.text).toBe(before)
  expect(JSON.parse(disk.files.get(`${DIR}/s-other.dismissed.json`)?.text ?? '{}').cancelled).toEqual(['t1'])
  await ui.unmount()
})

test("two changes to one session's sidecar never drop each other: in this pane, or from another", async ($, on) => {
  const disk = makeDisk()
  put(
    disk,
    `${DIR}/s-other.json`,
    other('s-other', 'site', T0, {
      tasks: [{ title: 'Deploy docs' }, { title: 'Tag release' }, { title: 'Announce' }],
    }),
  )
  engine(on, disk)
  await start($)
  const ui = await pane($)
  const cancelled = () =>
    (JSON.parse(disk.files.get(`${DIR}/s-other.dismissed.json`)?.text ?? '{}').cancelled ?? []) as string[]

  // Two presses under way at once in this pane: each reads the sidecar before the other wrote it.
  await Promise.all([ui.press({ key: 'cancel:s-other:t1' }), ui.press({ key: 'cancel:s-other:t2' })])
  expect(cancelled().sort()).toEqual(['t1', 't2'])

  // Another pane (another process) writes between this pane's read and its write.
  disk.afterRead = {
    path: `${DIR}/s-other.dismissed.json`,
    run: () =>
      put(disk, `${DIR}/s-other.dismissed.json`, {
        version: 1,
        sessionId: 's-other',
        entries: [{ id: 'pipeline:x', doneAt: null }],
        cancelled: ['t1', 't2'],
      }),
  }
  await ui.press({ key: 'cancel:s-other:t3' })
  expect(cancelled().sort()).toEqual(['t1', 't2', 't3'])
  expect(sidecar(disk, 's-other')).toEqual([{ id: 'pipeline:x', doneAt: null }])
  await ui.unmount()
})

test('the owning session marks a removed task skipped and tells its agent once, on the main loop only', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { tasks: [{ title: 'Write the docs' }, { title: 'Push' }] })
  const ui = await pane($)
  await ui.press({ key: 'cancel:s-me:t1' })
  await ui.unmount()
  await world.clock.advance(UNDO_OVER)
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]).toMatchObject({
    id: 't1',
    status: 'skipped',
    note: 'removed in the Progress pane',
  })

  // A subagent's tool call is not where the note goes: the main loop's next one is.
  const sub = await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'x1',
    agent_id: 'sub-removal',
  } as never)
  expect(((sub as { additionalContext?: string[] }).additionalContext ?? []).join(' ')).not.toContain(
    'Write the docs',
  )
  const main = await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'x2',
  } as never)
  const note = ((main as { additionalContext?: string[] }).additionalContext ?? []).join(' ')
  expect(note).toContain('t1 "Write the docs"')
  expect(note).toMatch(/do not/i)
  const later = await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'x3',
  } as never)
  expect((later as { additionalContext?: string[] }).additionalContext ?? []).toEqual([])
})

test('a removal reaches the agent with the next prompt too, or in the next progress_update answer', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { tasks: [{ title: 'Alpha' }, { title: 'Beta' }] })
  put(disk, `${DIR}/s-me.dismissed.json`, { version: 1, sessionId: 's-me', entries: [], cancelled: ['t1'] })
  await world.clock.advance(2000)
  const prompt = await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)
  expect(((prompt as { additionalContext?: string[] }).additionalContext ?? []).join(' ')).toContain(
    't1 "Alpha"',
  )

  put(disk, `${DIR}/s-me.dismissed.json`, {
    version: 1,
    sessionId: 's-me',
    entries: [],
    cancelled: ['t1', 't2'],
  })
  await world.clock.advance(2000)
  const answer = await update($, { now: 'still going' })
  expect(JSON.stringify(answer)).toContain('t2 \\"Beta\\"')
})

const mainCall = async ($: $Test, id: string, agentId?: string) =>
  (
    (
      (await $.classic.PostToolUse({
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
        tool_use_id: id,
        ...(agentId ? { agent_id: agentId } : {}),
      } as never)) as { additionalContext?: string[] }
    ).additionalContext ?? []
  ).join(' ')

test('a removal the agent was not told about yet is kept in the file: a reload in between loses no notice', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-o', description: 'Lane O', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, {
    tasks: [{ title: 'Alpha' }, { title: 'Beta', steps: [{ title: 'one' }, { title: 'two' }] }],
  })
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-o',
    now: 'w',
    tasks: [{ title: 'mine' }, { title: 'more' }],
  } as never)
  put(disk, `${DIR}/s-me.dismissed.json`, {
    version: 1,
    sessionId: 's-me',
    entries: [],
    cancelled: ['t1', 'step:t2:one', 'agent:sub-o:t1'],
  })
  // The refresh folds the removals in and saves them — with what each loop is still owed.
  await world.clock.advance(2100)
  const folded = read(disk, `${DIR}/s-me.json`)
  expect(folded.cancelled).toEqual(['t1', 'step:t2:one', 'agent:sub-o:t1'])
  expect(folded.owed).toEqual([
    { removed: { id: 't1', title: 'Alpha' } },
    { text: expect.stringContaining('step "one" of "Beta" was removed') },
    { agentId: 'sub-o', text: expect.stringContaining('your step "mine" was removed') },
  ])
  // Each is handed to its own loop once, and leaves the file as it is.
  expect(await mainCall($, 's1', 'sub-o')).toContain('your step "mine" was removed')
  expect(read(disk, `${DIR}/s-me.json`).owed).toHaveLength(2)
  const told = await mainCall($, 'm1')
  expect(told).toContain('t1 "Alpha"')
  expect(told).toContain('step "one" of "Beta" was removed')
  expect(read(disk, `${DIR}/s-me.json`).owed).toBeUndefined()
  expect(await mainCall($, 'm2')).toBe('')
  expect(await mainCall($, 's2', 'sub-o')).toBe('')
})

test('a session that starts with a notice still owed in its file (the module was reloaded) hands it over', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  // As the copy before the reload left it: the removal folded in and saved, the agent not told yet.
  const before = other('s-me', 'app', T0, { now: 'n', tasks: [{ title: 'Alpha', status: 'skipped' }] })
  put(disk, `${DIR}/s-me.json`, {
    ...before,
    cancelled: ['t1'],
    owed: [
      { removed: { id: 't1', title: 'Alpha' } },
      { agentId: 'sub-gone', text: 'for an agent that is gone' },
      'junk',
    ],
  })
  await start($)
  expect(await mainCall($, 'm1')).toContain('t1 "Alpha"')
  // …and what was owed to an agent that no longer runs goes with it.
  expect(read(disk, `${DIR}/s-me.json`).owed).toBeUndefined()
  expect(await mainCall($, 'm2')).toBe('')
})

test('a removal read before the session saved its fold is still told only once', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { tasks: [{ title: 'Alpha' }, { title: 'Beta' }] })
  // The ✕ lands and the person's prompt comes before the next refresh: the prompt's own look at the
  // file folds the removal in without saving it.
  put(disk, `${DIR}/s-me.dismissed.json`, { version: 1, sessionId: 's-me', entries: [], cancelled: ['t1'] })
  const prompt = await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)
  expect(((prompt as { additionalContext?: string[] }).additionalContext ?? []).join(' ')).toContain(
    't1 "Alpha"',
  )
  // The refresh folds it again, and saves: nothing more to tell.
  await world.clock.advance(2000)
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]).toMatchObject({ id: 't1', status: 'skipped' })
  const later = await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'x1',
  } as never)
  expect(((later as { additionalContext?: string[] }).additionalContext ?? []).join(' ')).not.toContain(
    'Alpha',
  )
})

test("a subagent's progress lands under its coordinator's session, never among the session's tasks", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({
    id: 'sub-1',
    description: 'Lane A: scopes',
    type: 'general-purpose',
    status: 'running',
  })
  await start($)
  await update($, { tasks: [{ title: 'Coordinate the lanes', status: 'doing' }] })
  const answer = await $.tool.call({
    tool: TOOL,
    agentId: 'sub-1',
    now: 'Writing the section table',
    tasks: [
      { title: 'read', status: 'done' },
      { title: 'table', status: 'done' },
      { title: 'authz', status: 'done' },
      { title: 'tests', note: '~5 min' },
    ],
    eta: 5,
  } as never)
  // The answer confirms, counts and names the steps this call set, each with its id (its prompt says
  // to update a step by id) — what to report and how often is in its prompt, said once.
  expect(answer).toEqual({
    result: [
      "Saved under your coordinator's session (3/4 steps done); this call set:",
      't1 done read',
      't2 done table',
      't3 done authz',
      't4 todo tests',
    ].join('\n'),
  })
  // A later call is answered with what IT changed — never the whole list again with every report.
  const next = await $.tool.call({
    tool: TOOL,
    agentId: 'sub-1',
    tasks: [{ id: 't4', status: 'doing' }],
  } as never)
  expect(next).toEqual({
    result: "Saved under your coordinator's session (3/4 steps done); this call set:\nt4 doing tests",
  })
  // …and one that changes no step with the count alone.
  const quiet = await $.tool.call({ tool: TOOL, agentId: 'sub-1', now: 'Writing the tests' } as never)
  expect(quiet).toEqual({ result: "Saved under your coordinator's session (3/4 steps done)." })
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-1',
    now: 'Writing the section table',
    tasks: [{ id: 't4', status: 'todo' }],
  } as never)
  const file = read(disk, `${DIR}/s-me.json`)
  // Its steps never become the session's tasks; on no task of the coordinator's, it gets a stand-in.
  expect(file.tasks.map(t => t.title)).toEqual(['Coordinate the lanes', '↳ Lane A: scopes'])
  expect(file.tasks.flatMap(t => t.steps ?? [])).toEqual([])
  expect(file.agents?.[0]).toMatchObject({
    id: 'sub-1',
    label: 'Lane A: scopes',
    now: 'Writing the section table',
    etaMin: 5,
    endedAt: null,
  })
  expect(file.agents?.[0]?.tasks.map(t => t.status)).toEqual(['done', 'done', 'done', 'todo'])

  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'agents:s-me' }))?.text).toBe('▾ Agents  1 running')
  // A running agent opens to its steps — each with its status and note (a per-step estimate) — and
  // shows how long it has run beside its steps and estimate.
  expect((await ui.find({ type: 'Button', key: 'agent:s-me:sub-1' }))?.text).toBe('▾ Lane A: scopes')
  const lines = await texts(ui)
  expect(lines).toContain('██████░░ 3/4 · 0s · ~1 min left')
  expect(lines).toContain('Writing the section table')
  expect(lines).toContain('✓ read')
  expect(lines).toContain('○ tests')
  expect(lines).toContain('~5 min')
  // Folded, the agent keeps its one line and its steps go.
  await ui.press({ key: 'agent:s-me:sub-1' })
  expect((await ui.find({ type: 'Button', key: 'agent:s-me:sub-1' }))?.text).toBe('▸ Lane A: scopes')
  // (Its stand-in task shows the same steps — the agent's own — until it is folded too.)
  await ui.press({ key: 'task:s-me:t2' })
  expect(await texts(ui)).not.toContain('✓ read')
  await ui.unmount()

  // The coordinator's own next answer lists its running subagents.
  const mine = await update($, { now: 'waiting on lanes' })
  expect(JSON.stringify(mine)).toContain('Lane A: scopes 3/4, ~1 min left')
})

test("a subagent's row says which model and effort it runs on, as its own requests name them", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({
    id: 'sub-1',
    description: 'Lane A: scopes',
    type: 'general-purpose',
    status: 'running',
  })
  await start($)
  await update($, { tasks: [{ title: 'Coordinate the lanes', status: 'doing' }] })
  // One model request, read to its end as the engine reads it: its chunks, then its result.
  const step = async (agentId: string | undefined, model: string, effort?: string | number) => {
    const stream = $.turn.step({
      turnId: 't1',
      index: 0,
      model,
      messageCount: 1,
      ...(effort ? { effort } : {}),
      ...(agentId ? { agentId } : {}),
    } as never)
    const chunks: unknown[] = []
    for (;;) {
      const item = await stream.next()
      if (item.done) return { chunks, result: item.value }
      chunks.push(item.value)
    }
  }
  // An agent with no entry yet: nothing is written, and the request goes through whole.
  const passed = await step('sub-unknown', 'claude-sonnet-5-5', 'medium')
  expect(passed.chunks).toEqual([{ kind: 'text', index: 0, text: 'ok' }])
  expect(passed.result).toMatchObject({ turnId: 't1', index: 0, answer: 'ok' })
  await $.tool.call({ tool: TOOL, agentId: 'sub-1', now: 'Reading', tasks: [{ title: 'read' }] } as never)
  // The session's own requests are not an agent's.
  await step(undefined, 'claude-fable-5-2', 'high')
  expect(read(disk, `${DIR}/s-me.json`).agents?.map(a => [a.id, a.model])).toEqual([['sub-1', undefined]])
  // Its next request names what it runs on: kept on its entry.
  await step('sub-1', 'claude-sonnet-5-5', 'medium')
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]).toMatchObject({
    model: 'claude-sonnet-5-5',
    effort: 'medium',
  })
  const ui = await pane($)
  expect(await texts(ui)).toContain('sonnet 5.5 · medium · ░░░░░░░░ 0/1 · 0s')
  await ui.unmount()
  // The same again writes nothing; a change (another model, one without effort) replaces it; its
  // next report keeps it.
  const before = JSON.stringify(read(disk, `${DIR}/s-me.json`))
  await step('sub-1', 'claude-sonnet-5-5', 'medium')
  expect(JSON.stringify(read(disk, `${DIR}/s-me.json`))).toBe(before)
  await step('sub-1', 'claude-haiku-5-5-20261001')
  await $.tool.call({ tool: TOOL, agentId: 'sub-1', now: 'Writing' } as never)
  const entry = read(disk, `${DIR}/s-me.json`).agents?.[0]
  expect(entry?.model).toBe('claude-haiku-5-5-20261001')
  expect(entry?.effort).toBeUndefined()
  const again = await pane($)
  expect(await texts(again)).toContain('haiku 5.5 · ░░░░░░░░ 0/1 · 0s')
  await again.unmount()
})

test("a reload does not start a running subagent's call count over", async ($, on) => {
  // As the copy before the reload left it: the agent at work, 107 tool calls counted so far. The
  // count is this copy's memory only — a reloaded copy began again at 1, and the row's "107 tool
  // calls" dropped to "1 tool call" in front of the person.
  const disk = makeDisk()
  const at = new Date(T0 - 60_000).toISOString()
  put(disk, `${DIR}/s-me.json`, {
    ...newSession({ id: 's-me', project: 'app', cwd: '/w/app' }, at),
    now: 'coordinating',
    agents: [
      {
        id: 'rev-1',
        label: 'Audit: authz',
        now: null,
        tasks: [],
        seq: 0,
        activity: 'Read — a.rs',
        calls: 107,
        startedAt: at,
        updatedAt: at,
        endedAt: null,
      },
    ],
  })
  const world = engine(on, disk)
  world.agents.push({ id: 'rev-1', description: 'Audit: authz', type: 'security-auditor', status: 'running' })
  await start($)
  await $.classic.PostToolUse({
    tool_name: 'Grep',
    tool_input: { pattern: 'required_scope' },
    tool_response: {},
    tool_use_id: 'c1',
    agent_id: 'rev-1',
  } as never)
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]).toMatchObject({
    activity: 'Grep — required_scope',
    calls: 108,
  })
})

test('a subagent that never reports (no progress tool) still shows under Agents while it runs', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { now: 'coordinating the audit' })
  world.agents.push({ id: 'rev-1', description: 'Audit: authz', type: 'security-auditor', status: 'running' })
  await world.clock.advance(2100)
  expect(read(disk, `${DIR}/s-me.json`).agents?.map(a => [a.label, a.endedAt])).toEqual([
    ['Audit: authz', null],
  ])
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'agents:s-me' }))?.text).toBe('▾ Agents  1 running')
  // Nothing to unfold yet (no report, no tool call seen): a plain line, never a fold arrow.
  expect(await ui.find({ type: 'Button', key: 'agent:s-me:rev-1' })).toBeUndefined()
  expect(await texts(ui)).toContain('• Audit: authz')
  await ui.unmount()
  // Its tool calls give the row its second level: the latest one, and how many so far — written at
  // most every few seconds, every call counted.
  const call = (tool_name: string, tool_input: Record<string, unknown>, id: string) =>
    $.classic.PostToolUse({
      tool_name,
      tool_input,
      tool_response: {},
      tool_use_id: id,
      agent_id: 'rev-1',
    } as never)
  await call('Read', { file_path: 'src-tauri/src/mesh/authz.rs' }, 'c1')
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]).toMatchObject({
    activity: 'Read — src-tauri/src/mesh/authz.rs',
    calls: 1,
  })
  await call('Grep', { pattern: 'required_scope' }, 'c2')
  await call('Grep', { pattern: 'authed_peer' }, 'c3')
  // Inside the interval: counted, not written.
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]?.calls).toBe(1)
  await world.clock.advance(3100)
  await call('Bash', { command: 'git log --oneline -5' }, 'c4')
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]).toMatchObject({
    activity: 'Bash — git log --oneline -5',
    calls: 4,
  })
  // Its own progress reports are not activity.
  await $.classic.PostToolUse({
    tool_name: TOOL,
    tool_input: { now: 'x' },
    tool_response: {},
    tool_use_id: 'c5',
    agent_id: 'rev-1',
  } as never)
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]?.calls).toBe(4)
  const busy = await pane($)
  expect((await busy.find({ type: 'Button', key: 'agent:s-me:rev-1' }))?.text).toBe('▾ Audit: authz')
  expect(await texts(busy)).toContain('↳ Bash — git log --oneline -5 · 4 tool calls')
  // Folded, the line goes and the arrow turns.
  await busy.press({ key: 'agent:s-me:rev-1' })
  expect((await busy.find({ type: 'Button', key: 'agent:s-me:rev-1' }))?.text).toBe('▸ Audit: authz')
  expect(await texts(busy)).not.toContain('↳ Bash — git log --oneline -5 · 4 tool calls')
  await busy.unmount()
  // The list says it ended: finished on the next scan, even without a SubagentStop.
  world.agents[0] = { ...world.agents[0], status: 'completed' } as (typeof world.agents)[number]
  await world.clock.advance(2100)
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]?.endedAt).not.toBeNull()
})

test('an agent gone from an EMPTY list (after a reload) ends once quiet; clearAgents clears finished rows', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  // Seeded as the agents were — O(1): one scan, never minutes of simulated 2 s ticks (load-proof).
  const agent = (id: string, label: string, quietMin: number) => {
    const at = new Date(T0 - quietMin * 60_000).toISOString()
    return { id, label, now: null, tasks: [], seq: 0, startedAt: at, updatedAt: at, endedAt: null }
  }
  put(disk, `${DIR}/s-me.json`, {
    ...other('s-me', 'app', T0 - 10 * 60_000, { now: 'coordinating' }),
    agents: [agent('gone-1', 'Lane A', 4), agent('recent-1', 'Lane C', 1), agent('busy-1', 'Lane B', 30)],
  })
  // Lane A and C dropped out of the list (finished agents do; after a reload it is empty); B runs on.
  world.agents.push({ id: 'busy-1', description: 'Lane B', type: 'general-purpose', status: 'running' })
  await start($)
  await world.clock.advance(2100)
  const after = read(disk, `${DIR}/s-me.json`).agents ?? []
  // Quiet past the 3 min idle window: ended. Quiet for only 1 min: not yet.
  expect(after.find(a => a.id === 'gone-1')?.endedAt).not.toBeNull()
  expect(after.find(a => a.id === 'recent-1')?.endedAt).toBeNull()
  // Listed as running: never ended, however quiet.
  expect(after.find(a => a.id === 'busy-1')?.endedAt).toBeNull()
  // The coordinator clears the finished row; the running one stays, unnamed in a clear-all.
  const answer = String(((await update($, { clearAgents: true })) as { result?: unknown }).result ?? '')
  expect(answer).toContain('Cleared from the pane: Lane A')
  expect(read(disk, `${DIR}/s-me.json`).agents?.map(a => a.id)).toEqual(['recent-1', 'busy-1'])
  // Named explicitly while running: kept, and said so.
  const named = String(
    ((await update($, { dismissAgents: ['Lane B'] })) as { result?: unknown }).result ?? '',
  )
  expect(named).toContain('Not cleared — still working: Lane B')
  expect(read(disk, `${DIR}/s-me.json`).agents?.map(a => a.id)).toEqual(['recent-1', 'busy-1'])
})

test("a subagent's first tool call carries the reporting rule once; one that reported is never told", async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, { now: 'coordinating' })
  const call = async (agent: string | undefined, id: string) =>
    (
      (
        (await $.classic.PostToolUse({
          tool_name: 'Bash',
          tool_input: {},
          tool_response: {},
          tool_use_id: id,
          ...(agent ? { agent_id: agent } : {}),
        } as never)) as { additionalContext?: string[] }
      ).additionalContext ?? []
    ).join(' ')

  // Its system prompt never carried the rule: the first call's result does — once.
  const first = await call('sub-rule-1', 'y1')
  expect(first).toContain('you are a subagent')
  expect(first).toContain('progress_update')
  expect(await call('sub-rule-1', 'y2')).toBe('')

  // A subagent that already reported is not told again.
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-rule-2',
    now: 'reading',
    tasks: [{ title: 'read' }],
  } as never)
  expect(await call('sub-rule-2', 'y3')).toBe('')

  // The main loop never gets the subagent rule.
  expect(await call(undefined, 'y4')).not.toContain('you are a subagent')
})

test('a subagent that stops is marked finished and folded under Agents — and stays while auto-clear is off', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({
    id: 'sub-2',
    description: 'Lane B: the rest',
    type: 'general-purpose',
    status: 'running',
  })
  await start($)
  await update($, { now: 'coordinating' })
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-2',
    now: 'tests',
    tasks: [{ title: 'one', status: 'done' }],
  } as never)
  await $.classic.SubagentStop({
    agent_id: 'sub-2',
    agent_type: 'general-purpose',
    stop_hook_active: false,
    agent_transcript_path: '/t',
  } as never)
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]?.endedAt).toBe(new Date(T0).toISOString())
  const ui = await pane($)
  // A finished agent leaves the running section and moves under Done, in its own folded "Agents".
  expect(await ui.find({ type: 'Button', key: 'agents:s-me' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'done:s-me' }))?.text).toBe('▸ Done (1)')
  await ui.press({ key: 'done:s-me' })
  expect((await ui.find({ type: 'Button', key: 'doneagents:s-me' }))?.text).toBe('▸ Agents  1')
  await ui.press({ key: 'doneagents:s-me' })
  expect((await ui.find({ type: 'Button', key: 'doneagent:s-me:sub-2' }))?.text).toContain(
    '✓ Lane B: the rest  finished',
  )
  await ui.unmount()
  const mine = await update($, { now: 'still here' })
  // A finished agent leaves the coordinator's "Subagents:" line.
  expect(JSON.stringify(mine)).not.toContain('Subagents:')
  // An hour later — the file aged by hand, then ONE scan (an hour of 2 s ticks cost real seconds
  // and timed out on a loaded machine): still there.
  const aged = read(disk, `${DIR}/s-me.json`)
  put(disk, `${DIR}/s-me.json`, {
    ...aged,
    agents: aged.agents?.map(a => ({ ...a, endedAt: new Date(T0 - HOUR - 2000).toISOString() })),
  })
  await world.clock.advance(2100)
  expect(read(disk, `${DIR}/s-me.json`).agents?.map(a => a.label)).toEqual(['Lane B: the rest'])
})

test('skipped, failed and unfinished read differently — each with its reason beneath, also under a finished agent', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-9', description: 'Lane Z', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, {
    tasks: [
      {
        title: 'Ship it',
        status: 'doing',
        steps: [
          { title: 'push', status: 'done' },
          { title: 'Windows runner', status: 'failed', note: 'no runner for that platform' },
          { title: 'mirror', status: 'skipped', note: 'not needed any more' },
          { title: 'review', status: 'blocked', note: 'waiting for the user' },
        ],
      },
      { title: 'Full-width pane', status: 'failed', note: 'the API cannot place a pane' },
    ],
  })
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-9',
    now: 'items',
    tasks: [
      { title: '16. Reopen', status: 'done' },
      { title: '17. Full-width pane toggle', status: 'skipped', note: 'API: placement is read-only' },
      { title: '4. Dead sessions', status: 'doing' },
    ],
  } as never)
  await $.classic.SubagentStop({
    agent_id: 'sub-9',
    agent_type: 'general-purpose',
    stop_hook_active: false,
    agent_transcript_path: '/t',
  } as never)
  // The step it left `doing` is unfinished now: a finished agent never looks busy.
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]?.tasks.map(x => x.status)).toEqual([
    'done',
    'skipped',
    'unfinished',
  ])
  const ui = await pane($)
  let lines = await texts(ui)
  // The open task's steps: ✗ red failed, – dim skipped, ⚠ magenta blocked — each reason beneath.
  expect(lines).toContain('✗ Windows runner')
  expect(lines).toContain('no runner for that platform')
  expect(lines).toContain('– mirror')
  expect(lines).toContain('not needed any more')
  expect(lines).toContain('waiting for the user')
  expect((await ui.find({ type: 'Text', text: '✗ Windows runner' }))?.props.color).toBe('red')
  expect((await ui.find({ type: 'Text', text: '– mirror' }))?.props.dimColor).toBe(true)
  // The failed task sits under Done, red, its reason beneath.
  await ui.press({ key: 'done:s-me' })
  lines = await texts(ui)
  expect(lines.some(l => l.startsWith('✗ Full-width pane'))).toBe(true)
  expect(lines).toContain('the API cannot place a pane')
  const failedRow = (await ui.findAll({ type: 'Text' })).find(x =>
    (x.text ?? '').startsWith('✗ Full-width pane'),
  )
  expect(failedRow?.props.color).toBe('red')
  // The finished agent folds open to its steps: skipped with its reason, unfinished with the default.
  // (It served no task and ran no command the plugin saw: its repo is not known, so Done groups it
  // under "other", beside the session's own repo.)
  await ui.press({ key: 'doneagents:s-me:\u0000other' })
  await ui.press({ key: 'doneagent:s-me:sub-9' })
  lines = await texts(ui)
  expect(lines).toContain('– 17. Full-width pane toggle')
  expect(lines).toContain('API: placement is read-only')
  expect(lines).toContain('– 4. Dead sessions')
  expect(lines).toContain('agent stopped before finishing')
  // A finished agent's list is a record: no ✕ on its steps.
  expect(
    (await ui.findAll({ type: 'Button' })).some(b =>
      String(b.props.key ?? '').startsWith('cancel:s-me:agent:sub-9:'),
    ),
  ).toBe(false)
  await ui.unmount()
})

test("an agent the session doesn't list still reports, under its id", async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await $.tool.call({ tool: TOOL, agentId: 'abcdef123456', now: 'working' } as never)
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]).toMatchObject({
    id: 'abcdef123456',
    label: 'agent abcdef12',
  })
})

test('the pane asks for a sidebar width and an inline height — 84 columns and 20 rows by default', async ($, on) => {
  const world = engine(on, makeDisk())
  await start($)
  expect(world.opened.at(-1)).toMatchObject({ id: 'progress', columns: 84, rows: 20 })
  await $.command.run({ command: 'progress' } as never)
  expect(world.opened.at(-1)).toMatchObject({ id: 'progress', columns: 84, rows: 20 })
})

test(
  'the pane sizes follow the settings; 0 leaves the size to Claude Code',
  { options: { paneColumns: '110', paneRows: '0' } },
  async ($, on) => {
    const world = engine(on, makeDisk())
    await start($)
    const asked = world.opened.at(-1) ?? {}
    expect(asked.columns).toBe(110)
    expect('rows' in asked).toBe(false)
  },
)

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
  // A second open session: the only open one would not be named at all.
  put(disk, `${DIR}/s-other.json`, other('s-other', 'site', T0, { now: 'Idle' }))
  engine(on, disk)
  await start($)
  await update($, { now: 'testing', needsYou: ['an OK'] })
  let ui = await pane($)
  // Nothing under it (only a Now line and an ask): a plain line, no arrow.
  await groupHeader(ui, 's-me', /^app \(this session\) · /)
  await ui.unmount()

  // `/rename` reaches the plugin with the next prompt (UserPromptSubmit carries the title).
  await $.classic.UserPromptSubmit({ prompt: 'go on', session_title: 'Switchboard + Panel' } as never)
  expect(read(disk, `${DIR}/s-me.json`).session).toMatchObject({
    project: 'app',
    title: 'Switchboard + Panel',
  })
  ui = await pane($)
  await groupHeader(ui, 's-me', /^Switchboard \+ Panel \(this session\) · /)
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

test("a file that names another session's id is not a session: never shown, written or deleted through", async ($, on) => {
  const disk = makeDisk()
  // An ended, expired session under a file name that is not its id: retention would delete by the id.
  const stray = other('s-victim', 'stray', T0 - 30 * 24 * HOUR, { now: 'Was here' })
  stray.session.endedAt = new Date(T0 - 29 * 24 * HOUR).toISOString()
  put(disk, `${DIR}/s-stray.json`, stray)
  put(disk, `${DIR}/s-victim.json`, other('s-victim', 'victim', T0 - HOUR, { now: 'Working' }))
  // A live one with a dead process under another name: the liveness check would write by the id.
  const dead = other('s-busy', 'dead', T0 - HOUR, { now: 'Gone' })
  dead.session.pid = 4242
  dead.session.host = 'box'
  put(disk, `${DIR}/s-alias.json`, dead)
  const world = engine(on, disk)
  await start($)
  await world.clock.advance(2000)

  expect(disk.removed).toEqual([])
  expect(read(disk, `${DIR}/s-victim.json`).now).toBe('Working')
  expect(disk.files.has(`${DIR}/s-busy.json`)).toBe(false)
  const ui = await pane($)
  expect(await groupHeader(ui, 's-victim', /^victim · /)).toContain('victim')
  expect(await texts(ui)).not.toContain('Gone')
  await ui.unmount()
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
  await groupHeader(ui, 's-busy', /^busy · /)
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

test("the tool's answer lists the open tasks and the ones this call changed — the closed rest is a count", async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  const result = async (input: Record<string, unknown>) =>
    ((await update($, input)) as { result: string }).result.split('\n')
  // Created by this call: all listed, closed or not, so the agent has every id.
  expect(
    await result({
      tasks: [
        { title: 'Design', status: 'done' },
        { title: 'Build', status: 'doing' },
        { title: 'Verify' },
        { title: 'Old idea', status: 'skipped', note: 'not needed' },
      ],
    }),
  ).toEqual(['Saved. 4 tasks:', 't1 done Design', 't2 doing Build', 't3 todo Verify', 't4 skipped Old idea'])
  // A later call: the open ones, plus the one it closed; the tasks closed before are only counted.
  expect(await result({ tasks: [{ id: 't2', status: 'done', note: 'abc123' }] })).toEqual([
    'Saved. 2 tasks (open, or changed by this call); 2 closed ones are not listed:',
    't2 done Build',
    't3 todo Verify',
  ])
  // A call that touches no task still names the open ones (a resumed session finds its ids here).
  expect(await result({ now: 'Verifying' })).toEqual([
    'Saved. 1 task (open, or changed by this call); 3 closed ones are not listed:',
    't3 todo Verify',
  ])
  expect(await result({ tasks: [{ id: 't3', status: 'done' }] })).toEqual([
    'Saved. 1 task (open, or changed by this call); 3 closed ones are not listed:',
    't3 done Verify',
  ])
  expect(await result({ now: 'All done' })).toEqual(['Saved. No open task; 4 closed ones are not listed.'])
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
  // Blocked reads as "waiting on someone" — the Needs-you mark and colour — never as a failure.
  expect(lines).toContain('⚠ Deploy')
  expect((await ui.find({ type: 'Text', text: '⚠ Deploy' }))?.props.color).toBe('magenta')
  expect(lines).toContain('waits for approval')
  // Why it is blocked is what the person must read: never dimmed.
  expect((await exactText(ui, 'waits for approval'))?.props.dimColor).toBeFalsy()
  expect(lines).toContain('● Build')
  // No clock of the last check while the checks run: only a check that stopped is said.
  expect(lines[0]).toMatch(/^updated \d\d:\d\d · app$/)
  // The status line names the ask itself, never only a count.
  expect(world.status.at(-1)).toBe('⚠ 2 need you — app: Push OK')
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
  const world = engine(on, disk)
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
  expect(await ui.find({ type: 'Text', text: /^✓ Alpha/ })).toBeUndefined()
  // The pane never writes a session's own file: the dismissal lands in the sidecar.
  expect(disk.files.get(`${DIR}/s-me.json`)?.text).toBe(own)
  expect(sidecar(disk, 's-me').map(d => d.id)).toEqual(['t1'])

  // The owner merges the sidecar on its next write once the undo window is over; a re-sent done
  // copy stays gone.
  await world.clock.advance(UNDO_OVER)
  expect(await ui.find({ type: 'Text', text: /Alpha/ })).toBeUndefined()
  await update($, { tasks: [{ id: 't1', title: 'Alpha', status: 'done' }] })
  expect(read(disk, `${DIR}/s-me.json`).tasks.map(t => t.id)).toEqual(['t2', 't3'])
  expect(read(disk, `${DIR}/s-me.json`).dismissed).toEqual(['t1'])

  await ui.press({ key: 'clear:s-me' })
  expect(sidecar(disk, 's-me').map(d => d.id)).toEqual(['t1', 't2'])
  expect(await ui.find({ type: 'Button', key: 'done:s-me' })).toBeUndefined()
  await world.clock.advance(UNDO_OVER)
  await update($, { now: 'later' })
  expect(read(disk, `${DIR}/s-me.json`).tasks.map(t => t.id)).toEqual(['t3'])
  await ui.unmount()
})

test('an open Done lists its newest 10; the older rest folds behind "N older"', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  // 25 tasks finished a minute apart: Task 1 first, Task 25 last — seeded with those times (25
  // minutes of 2 s ticks cost real time and are a slow machine's timeout).
  const at = (i: number) => new Date(T0 - (26 - i) * 60_000).toISOString()
  let seeded = other('s-me', 'app', T0 - HOUR, {})
  seeded = {
    ...seeded,
    tasks: Array.from({ length: 25 }, (_, k) => ({
      id: `d${k + 1}`,
      title: `Task ${k + 1}`,
      status: 'done' as const,
      createdAt: at(k + 1),
      updatedAt: at(k + 1),
      doneAt: at(k + 1),
    })),
    seq: 25,
  }
  put(disk, `${DIR}/s-me.json`, seeded)
  await start($)
  await update($, { now: 'Working', tasks: [{ id: 'live', title: 'Live work', status: 'doing' }] })

  const ui = await pane($)
  await ui.press({ key: 'done:s-me' })
  expect(await ui.find({ type: 'Text', text: /^✓ Task 25 / })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^✓ Task 16 / })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^✓ Task 15 / })).toBeUndefined()
  const older = await ui.find({ type: 'Button', key: 'doneolder:s-me' })
  expect(older?.text).toBe('▸ 15 older')
  // The live part is still there above it.
  expect(await texts(ui)).toContain('Working')

  await ui.press({ key: 'doneolder:s-me' })
  expect(await ui.find({ type: 'Text', text: /^✓ Task 1 / })).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 'doneolder:s-me' }))?.text).toBe('▾ 15 older')
  await ui.unmount()
})

test('finished agents under Done list their newest 5; the older rest folds behind "N older"', async ($, on) => {
  const disk = makeDisk()
  const iso = (ms: number) => new Date(ms).toISOString()
  const file = other('s-me', 'app', T0, { now: 'Busy', tasks: [{ title: 'Work', status: 'doing' }] })
  file.agents = Array.from({ length: 7 }, (_, i) => ({
    id: `a${i + 1}`,
    label: `Lane ${i + 1}`,
    now: null,
    tasks: [],
    seq: 0,
    startedAt: iso(T0),
    updatedAt: iso(T0 + i * 60_000),
    endedAt: iso(T0 + i * 60_000),
  }))
  put(disk, `${DIR}/s-me.json`, file)
  engine(on, disk)
  await start($)

  const ui = await pane($)
  await ui.press({ key: 'done:s-me' })
  await ui.press({ key: 'doneagents:s-me' })
  const all = await texts(ui)
  expect(all.some(x => x.startsWith('✓ Lane 7 '))).toBe(true)
  expect(all.some(x => x.startsWith('✓ Lane 3 '))).toBe(true)
  expect(all.some(x => x.startsWith('✓ Lane 2 '))).toBe(false)
  expect((await ui.find({ type: 'Button', key: 'agentsolder:s-me' }))?.text).toBe('▸ 2 older')
  await ui.press({ key: 'agentsolder:s-me' })
  expect((await texts(ui)).some(x => x.startsWith('✓ Lane 1 '))).toBe(true)
  await ui.unmount()
})

// A session file holding finished subagents (and nothing else unless given).
function withFinishedAgents(id: string, labels: readonly string[], endedMs = T0): SessionFile {
  const at = new Date(endedMs).toISOString()
  return {
    ...other(id, 'app', endedMs, { now: 'coordinating' }),
    agents: labels.map((label, i) => ({
      id: `sub-${i + 1}`,
      label,
      now: null,
      tasks: [],
      seq: 0,
      startedAt: at,
      updatedAt: at,
      endedAt: at,
    })),
  }
}

test('a finished agent has a ✕: every pane hides it at once and its session drops the row', async ($, on) => {
  const disk = makeDisk()
  put(disk, `${DIR}/s-me.json`, withFinishedAgents('s-me', ['Lane A', 'Lane B']))
  const world = engine(on, disk)
  await start($)
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'done:s-me' }))?.text).toBe('▸ Done (2)')
  await ui.press({ key: 'done:s-me' })
  await ui.press({ key: 'doneagents:s-me' })
  await ui.press({ key: 'dismiss:s-me:agent:sub-1' })
  // Hidden at once (the sidecar names that completion), before the session folds it in.
  expect((await texts(ui)).some(x => x.startsWith('✓ Lane A '))).toBe(false)
  expect((await texts(ui)).some(x => x.startsWith('✓ Lane B '))).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'done:s-me' }))?.text).toBe('▾ Done (1)')
  expect(sidecar(disk, 's-me')).toEqual([
    { id: 'agent:sub-1', doneAt: new Date(T0).toISOString(), at: new Date(T0).toISOString() },
  ])
  // Its session drops the row from its own file once the undo window is over.
  await world.clock.advance(UNDO_OVER)
  expect(read(disk, `${DIR}/s-me.json`).agents?.map(a => a.label)).toEqual(['Lane B'])
  await ui.unmount()
})

test('Clear all clears the finished agents too — also when no task is done', async ($, on) => {
  const disk = makeDisk()
  put(disk, `${DIR}/s-me.json`, withFinishedAgents('s-me', ['Lane A', 'Lane B']))
  const world = engine(on, disk)
  await start($)
  await update($, { tasks: [{ title: 'Open one', status: 'doing' }] })
  const ui = await pane($)
  await ui.press({ key: 'done:s-me' })
  await ui.press({ key: 'clear:s-me' })
  expect(await ui.find({ type: 'Button', key: 'done:s-me' })).toBeUndefined()
  await world.clock.advance(UNDO_OVER)
  const file = read(disk, `${DIR}/s-me.json`)
  expect(file.agents ?? []).toEqual([])
  expect(file.tasks.map(x => x.title)).toEqual(['Open one'])
  await ui.unmount()
})

test("✕ on an ended session's finished agent hides it through the sidecar; its file is not written", async ($, on) => {
  const disk = makeDisk()
  const gone = withFinishedAgents('s-gone', ['Old lane'], T0 - HOUR)
  gone.session.endedAt = new Date(T0 - HOUR / 2).toISOString()
  put(disk, `${DIR}/s-gone.json`, gone)
  const before = disk.files.get(`${DIR}/s-gone.json`)?.text
  engine(on, disk)
  await start($)
  const ui = await pane($)
  await ui.press({ key: 'group:s-gone' })
  await ui.press({ key: 'done:s-gone' })
  await ui.press({ key: 'doneagents:s-gone' })
  await ui.press({ key: 'dismiss:s-gone:agent:sub-1' })
  expect((await texts(ui)).some(x => x.startsWith('✓ Old lane '))).toBe(false)
  expect(disk.files.get(`${DIR}/s-gone.json`)?.text).toBe(before)
  await ui.unmount()
})

test(
  'retention: finished agents auto-clear with the done tasks, after the set hours',
  { options: { autoClearDoneHours: '1' } },
  async ($, on) => {
    const disk = makeDisk()
    const file = withFinishedAgents('s-me', ['Old lane', 'Fresh lane'])
    const old = new Date(T0 - HOUR - 2000).toISOString()
    put(disk, `${DIR}/s-me.json`, {
      ...file,
      agents: file.agents?.map(a => (a.label === 'Old lane' ? { ...a, endedAt: old, updatedAt: old } : a)),
    })
    const world = engine(on, disk)
    await start($)
    await world.clock.advance(2100)
    expect(read(disk, `${DIR}/s-me.json`).agents?.map(a => a.label)).toEqual(['Fresh lane'])
  },
)

test("this session's own file caught unreadable is never taken for a new session: nothing is written over it", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { now: 'Working', tasks: [{ title: 'Keep me', status: 'doing' }] })
  const good = disk.files.get(`${DIR}/s-me.json`)?.text as string
  // Caught mid-write (another pane ending a session it took for dead, a slow disk): half a file.
  const half = good.slice(0, good.length / 2)
  putText(disk, `${DIR}/s-me.json`, half)
  const answer = JSON.stringify(await update($, { now: 'Next' }))
  expect(answer).toContain('could not be read')
  expect(answer).toContain('nothing was written')
  expect(disk.files.get(`${DIR}/s-me.json`)?.text).toBe(half)
  // The scans in between write nothing over it either, and the pane keeps the last good copy.
  await world.clock.advance(4100)
  expect(disk.files.get(`${DIR}/s-me.json`)?.text).toBe(half)
  // The write completes: the same update goes through, on top of everything that was there.
  putText(disk, `${DIR}/s-me.json`, good)
  await update($, { now: 'Next' })
  expect(read(disk, `${DIR}/s-me.json`)).toMatchObject({ now: 'Next', tasks: [{ title: 'Keep me' }] })
})

test('an own file that cannot be read at all (the read fails, the file is there) is not written over either', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, { now: 'Working', tasks: [{ title: 'Keep me', status: 'doing' }] })
  const good = disk.files.get(`${DIR}/s-me.json`)?.text as string
  disk.readFails = `${DIR}/s-me.json`
  expect(JSON.stringify(await update($, { now: 'Next' }))).toContain('could not be read')
  expect(disk.files.get(`${DIR}/s-me.json`)?.text).toBe(good)
  disk.readFails = undefined
  await update($, { now: 'Next' })
  expect(read(disk, `${DIR}/s-me.json`)).toMatchObject({ now: 'Next', tasks: [{ title: 'Keep me' }] })
})

test('an own file that stays unreadable is damaged, not in flight: after 10 s the session starts it over', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  put(disk, `${DIR}/s-me.json`, { version: 2, session: 'not a session' })
  // A session starts and ends beside a damaged file without failing.
  await start($)
  expect(JSON.stringify(await update($, { now: 'First' }))).toContain('could not be read')
  await world.clock.advance(11_000)
  await update($, { now: 'Second' })
  expect(read(disk, `${DIR}/s-me.json`)).toMatchObject({ now: 'Second', session: { id: 's-me' } })
  await $.session.end({ reason: 'exit' } as never)
  expect(read(disk, `${DIR}/s-me.json`).session.endedAt).not.toBeNull()
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
  expect(await ui.find({ type: 'Text', text: /^✓ Shipped/ })).toBeUndefined()
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

  // A later completion only needs another time stamp: a second, not a minute of 2 s ticks.
  await world.clock.advance(1000)
  await update($, { tasks: [{ id: 't1', title: 'Flaky', status: 'doing' }] })
  await world.clock.advance(1000)
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

    // An hour later — the file aged by hand, then ONE scan (not an hour of 2 s ticks).
    const aged = read(disk, `${DIR}/s-me.json`)
    const old = new Date(T0 - HOUR - 2000).toISOString()
    put(disk, `${DIR}/s-me.json`, {
      ...aged,
      tasks: aged.tasks.map(x => (x.status === 'done' ? { ...x, doneAt: old, updatedAt: old } : x)),
    })
    await world.clock.advance(2100)
    expect(read(disk, `${DIR}/s-me.json`).tasks.map(t => t.title)).toEqual(['Long'])
  },
)

test('a task in progress with steps starts open; the person can fold it; done, it folds back', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  const steps = [
    { title: 'push', status: 'done' as const },
    { title: 'CI', status: 'doing' as const },
  ]
  await update($, {
    tasks: [
      { id: 'run', title: 'Running', status: 'doing', steps },
      { id: 'plan', title: 'Planned', status: 'todo', steps },
    ],
  })
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'task:s-me:run' }))?.text).toBe('▾ Running')
  expect(await texts(ui)).toContain('● CI')
  // Not started yet: folded, as before.
  expect((await ui.find({ type: 'Button', key: 'task:s-me:plan' }))?.text).toBe('▸ Planned')

  await ui.press({ key: 'task:s-me:run' })
  expect((await ui.find({ type: 'Button', key: 'task:s-me:run' }))?.text).toBe('▸ Running')
  await ui.unmount()

  // A task that moves on to done folds back by default (in a pane where nobody folded it).
  await update($, { tasks: [{ id: 'run', title: 'Running', status: 'done', steps }] })
  const fresh = await pane($)
  await fresh.press({ key: 'done:s-me' })
  expect(await fresh.find({ type: 'Text', text: /^● CI/ })).toBeUndefined()
  await fresh.unmount()
})

test('a task with details or subtasks folds open beneath its title, which shows n/m of its steps', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, {
    tasks: [
      {
        title: 'Ship it',
        status: 'todo',
        detail: 'Push, then watch CI.',
        steps: [
          { title: 'push', status: 'done' },
          { title: 'CI', status: 'doing' },
        ],
      },
      { title: 'Plain one' },
    ],
  })
  const ui = await pane($)
  const key = 'task:s-me:t1'
  expect((await ui.find({ type: 'Button', key }))?.text).toBe('▸ Ship it')
  let lines = await texts(ui)
  expect(lines).toContain('○')
  expect(lines).toContain('████░░░░ 1/2')
  expect(lines).not.toContain('Push, then watch CI.')
  // A task with nothing more to show stays one plain line.
  expect(lines).toContain('○ Plain one')
  expect(await ui.find({ type: 'Button', key: 'task:s-me:t2' })).toBeUndefined()

  await ui.press({ key })
  expect((await ui.find({ type: 'Button', key }))?.text).toBe('▾ Ship it')
  lines = await texts(ui)
  expect(lines).toContain('Push, then watch CI.')
  expect(lines).toContain('✓ push')
  expect(lines).toContain('● CI')
  await ui.unmount()
})

test('the Filter beside Sessions keeps only the tasks whose text matches, open and done alike', async ($, on) => {
  const disk = makeDisk()
  put(disk, `${DIR}/s-other.json`, other('s-other', 'site', T0, { tasks: [{ title: 'Deploy docs' }] }))
  engine(on, disk)
  await start($)
  await update($, {
    tasks: [
      { title: 'Fix the panel filter', note: 'typing narrows' },
      { title: 'Write release notes', steps: [{ title: 'panel changes' }] },
      { title: 'Ship it', status: 'done' },
      { title: 'Panel docs', status: 'done' },
    ],
  })
  const ui = await pane($)
  expect((await ui.find({ type: 'Input', key: 'filter' }))?.props.placeholder).toBe('Filter tasks')
  await ui.press({ key: 'done:s-me' })

  // Case-insensitive, over title, note, detail and step titles.
  await ui.input({ key: 'filter', text: 'PANEL', kind: 'change' })
  let lines = await texts(ui)
  expect(lines).toContain('○ Fix the panel filter')
  // While filtering, a foldable title sits beside its arrow as text (a Button label cannot be
  // highlighted); its hit is in a step, so the task opened by itself.
  expect((await ui.find({ type: 'Button', key: 'task:s-me:t2' }))?.text).toBe('▾')
  expect(lines).toContain('Write release notes')
  expect(lines.some(l => l.startsWith('✓ Panel docs'))).toBe(true)
  expect(lines.some(l => l.startsWith('✓ Ship it'))).toBe(false)
  // A session with nothing matching steps aside while the filter is on.
  expect(await ui.find({ type: 'Button', key: 'group:s-other' })).toBeUndefined()

  await ui.input({ key: 'filter', text: '', kind: 'change' })
  lines = await texts(ui)
  expect(lines.some(l => l.startsWith('✓ Ship it'))).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'group:s-other' })).toBeTruthy()
  await ui.unmount()
})

test("a session's tasks group by repo once they span more than one; untagged ones are the session's own", async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, {
    tasks: [
      { title: 'Fix the race', repo: 'claude-progress-panel' },
      { title: 'Push next' },
      { title: 'Write the README', repo: 'claude-progress-panel' },
      { title: 'Ship 0.13', repo: 'claude-progress-panel', status: 'done' },
    ],
  })
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'repo:s-me:claude-progress-panel' }))?.text).toBe(
    '▾ claude-progress-panel  2 open',
  )
  expect((await ui.find({ type: 'Button', key: 'repo:s-me:app' }))?.text).toBe('▾ app  1 open')
  let lines = await texts(ui)
  // In plan order, each repo where its first task stands.
  expect(lines.indexOf('○ Fix the race')).toBeLessThan(lines.indexOf('○ Write the README'))
  expect(lines.indexOf('○ Write the README')).toBeLessThan(lines.indexOf('○ Push next'))
  await ui.press({ key: 'done:s-me' })
  // Done holds one repo only: no heading there, no prefix.
  expect((await texts(ui)).some(l => l.startsWith('✓ Ship 0.13'))).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'donerepo:s-me:claude-progress-panel' })).toBeUndefined()

  // A repo folds on its own.
  await ui.press({ key: 'repo:s-me:claude-progress-panel' })
  lines = await texts(ui)
  expect(lines).not.toContain('○ Fix the race')
  expect(lines).toContain('○ Push next')
  await ui.unmount()

  // One repo only: no sub-groups.
  await update($, { tasks: [{ id: 't2', repo: 'claude-progress-panel' }] })
  const one = await pane($)
  expect(await one.find({ type: 'Button', key: 'repo:s-me:claude-progress-panel' })).toBeUndefined()
  await one.unmount()
})

test('repo headings follow each list: open tasks in one repo stay flat; Done groups once it spans repos', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, {
    tasks: [
      { title: 'Open here', repo: 'claude-progress-panel' },
      { title: 'Also here', repo: 'claude-progress-panel' },
      { title: 'Shipped switchboard', repo: 'switchboard', status: 'done' },
      { title: 'Shipped panel', repo: 'claude-progress-panel', status: 'done' },
    ],
  })
  const ui = await pane($)
  // The open tasks work in one repo: no heading, tasks shown.
  expect(await ui.find({ type: 'Button', key: 'repo:s-me:claude-progress-panel' })).toBeUndefined()
  let lines = await texts(ui)
  expect(lines).toContain('○ Open here')
  // Done spans two repos: a heading per repo, open, each foldable on its own.
  await ui.press({ key: 'done:s-me' })
  expect((await ui.find({ type: 'Button', key: 'donerepo:s-me:switchboard' }))?.text).toBe(
    '▾ switchboard  1 done',
  )
  expect((await ui.find({ type: 'Button', key: 'donerepo:s-me:claude-progress-panel' }))?.text).toBe(
    '▾ claude-progress-panel  1 done',
  )
  lines = await texts(ui)
  expect(lines.some(l => l.startsWith('✓ Shipped switchboard'))).toBe(true)
  await ui.press({ key: 'donerepo:s-me:switchboard' })
  lines = await texts(ui)
  expect(lines.some(l => l.startsWith('✓ Shipped switchboard'))).toBe(false)
  expect(lines.some(l => l.startsWith('✓ Shipped panel'))).toBe(true)
  await ui.unmount()
})

test('while filtering, the matching part of each task is highlighted; a hit inside steps unfolds its task', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, {
    tasks: [
      { title: 'Fix the panel filter', note: 'panel notes' },
      { title: 'Release notes', steps: [{ title: 'panel changes' }, { title: 'tag' }] },
      { title: 'Panel docs', status: 'done' },
    ],
  })
  const ui = await pane($)
  await ui.press({ key: 'done:s-me' })
  await ui.input({ key: 'filter', text: 'PANEL', kind: 'change' })
  const hits = (await ui.findAll({ type: 'Text' })).filter(x => x.props.inverse === true).map(x => x.text)
  // The open title, its note, the step (its task unfolded by itself) and the done title.
  expect(hits).toEqual(['panel', 'panel', 'panel', 'Panel'])
  expect(await texts(ui)).toContain('○ tag')
  // No filter: no highlight, the task folded again.
  await ui.input({ key: 'filter', text: '', kind: 'change' })
  expect((await ui.findAll({ type: 'Text' })).some(x => x.props.inverse === true)).toBe(false)
  expect(await texts(ui)).not.toContain('○ tag')
  await ui.unmount()
})

test('the sort Button cycles plan → status → title → created → done and remembers it', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  // b first, a a second later: "created" then has an order of its own, apart from the plan's.
  await update($, { tasks: [{ title: 'b-task', status: 'todo' }] })
  await world.clock.advance(1000)
  await update($, { tasks: [{ title: 'a-task', status: 'doing' }] })

  let ui = await pane($)
  // The default: the plan, the order the session will do them (the order it listed them).
  expect((await ui.find({ type: 'Button', key: 'sort' }))?.text).toBe('Sort: plan')
  let lines = await texts(ui)
  expect(lines.indexOf('○ b-task')).toBeLessThan(lines.indexOf('● a-task'))
  const answer = await update($, { order: ['t2', 't1'] })
  expect(JSON.stringify(answer)).not.toContain('order:')
  expect(read(disk, `${DIR}/s-me.json`).tasks.map(t => t.id)).toEqual(['t2', 't1'])
  await ui.unmount()
  ui = await pane($)
  lines = await texts(ui)
  expect(lines.indexOf('● a-task')).toBeLessThan(lines.indexOf('○ b-task'))

  await ui.press({ key: 'sort' })
  expect((await ui.find({ type: 'Button', key: 'sort' }))?.text).toBe('Sort: status')
  lines = await texts(ui)
  expect(lines.indexOf('● a-task')).toBeLessThan(lines.indexOf('○ b-task'))

  await ui.press({ key: 'sort' })
  expect((await ui.find({ type: 'Button', key: 'sort' }))?.text).toBe('Sort: title')
  await ui.press({ key: 'sort' })
  expect((await ui.find({ type: 'Button', key: 'sort' }))?.text).toBe('Sort: created')
  lines = await texts(ui)
  expect(lines.indexOf('○ b-task')).toBeLessThan(lines.indexOf('● a-task'))
  expect(world.store.get('sortTasksBy-2')).toBe('created')
  await ui.unmount()
})

test(
  'PROGRESS_PANEL_DIR moves the store over the setting (a demo or test folder)',
  { options: { progressDir: '~/status' } },
  async ($, on) => {
    const disk = makeDisk()
    engine(on, disk, { env: { HOME: '/home/me', PROGRESS_PANEL_DIR: '~/demo/' } })
    await start($)
    await update($, { now: 'x' })
    expect(disk.files.has('/home/me/demo/s-me.json')).toBe(true)
  },
)

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
  await groupHeader(ui, 's-me', /^This session · /)
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

test('Windows never hands cmd a path it would read as more than a path: the file stays', async ($, on) => {
  // `cmd /c del <path>`: cmd reads the line again, so `&` in a profile folder's name ("R&D") would
  // end the `del` there and run the rest as a command of its own.
  const disk = makeDisk()
  const ended = other('s-old', 'old', T0 - HOUR, { now: 'Was here' })
  ended.session.endedAt = new Date(T0 - HOUR / 2).toISOString()
  put(disk, '/Users/R&D/.claude/progress/s-old.json', ended)
  const world = engine(on, disk, { env: { USERPROFILE: '/Users/R&D', OS: 'Windows_NT' } })
  await start($)

  const ui = await pane($)
  await ui.press({ key: 'forget:s-old' })
  expect(world.runs.filter(argv => argv[0] === 'cmd')).toEqual([])
  expect(disk.files.has('/Users/R&D/.claude/progress/s-old.json')).toBe(true)
  await ui.unmount()
})

test('my own asks never toast; skipped tasks list under Done with a dash', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { needsYou: ['Mine'], tasks: [{ title: 'Dropped', status: 'skipped' }] })
  await world.clock.advance(2000)
  expect(world.toasts).toEqual([])
  expect(world.status.at(-1)).toBe('⚠ Mine')

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
  // An empty pane still names its version, how to check the setup, and opens Settings.
  const lines = await texts(ui)
  expect(lines).toContain('v0.14.0')
  expect(lines.some(l => l.includes('/progress doctor'))).toBe(true)
  await ui.press({ key: 'settings:open' })
  expect(await texts(ui)).toContain('⚙ Settings')
  await ui.unmount()
})

test('the header says when the pane last checked only once the checks stopped', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { now: 'x' })
  await world.clock.advance(2000)
  const clock = (ms: number) => {
    const d = new Date(ms)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
  }

  // While the checks run, the header carries no clock of them (it ticked every two seconds and
  // told nothing).
  let ui = await pane($)
  expect((await texts(ui)).some(l => l.includes('checked'))).toBe(false)
  await ui.unmount()

  await world.clock.advance(4000)
  ui = await pane($)
  expect((await texts(ui)).some(l => l.includes('checked'))).toBe(false)
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
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe('● ▸ app #42 · main')
  expect((await ui.find({ type: 'Button', key: 'pipestate:pipe:s-me:g/app#42' }))?.text).toBe(
    'running  ░░░░░░░░ 0/1',
  )
  await ui.press({ key: 'pipestate:pipe:s-me:g/app#42' })
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe('● ▾ app #42 · main')
  await ui.unmount()
})

test('a running pipeline stands out — yellow mark, bold — and a finished one dims to its outcome colour', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['test', 'running']))
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })

  let ui = await pane($)
  expect((await exactText(ui, '● '))?.props.color).toBe('yellow')
  // The section's "watching" count lights up while anything runs.
  expect((await ui.find({ type: 'Text', text: '1 watching' }))?.props.color).toBe('yellow')
  expect((await ui.find({ type: 'Text', text: /^▸ app #42/ }))?.props.bold).toBe(true)
  const running = await ui.find({ type: 'Text', text: /^running/ })
  expect(running?.props.color).toBe('yellow')
  expect(running?.props.bold).toBe(true)
  await ui.unmount()

  world.gitlab.set(PIPE, { id: 42, status: 'failed', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['test', 'failed']))
  await world.clock.advance(15_000)
  ui = await pane($)
  expect(await exactText(ui, '● ')).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '0 watching' }))?.props.color).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^▸ app #42/ }))?.props.dimColor).toBe(true)
  const failed = await ui.find({ type: 'Text', text: /^failed/ })
  expect(failed?.props.color).toBe('red')
  expect(failed?.props.bold).toBe(true)
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
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe('● ▸ app #42 · main · running  ████░░░░ 2/4')
  expect(lines).toContain('1 running · 1 queued · 1 skipped · 1 passed · 0 failed')
  expect(lines).not.toContain('✓ lint   10s')

  // Unfolded: the jobs under their stage, names padded so the times line up.
  await ui.press({ key: 'pipe:s-me:g/app#42' })
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe('● ▾ app #42 · main · running  ████░░░░ 2/4')
  lines = await texts(ui)
  expect(lines).toContain('1 running · 1 queued · 1 skipped · 1 passed · 0 failed')
  expect(lines).toContain('build')
  expect(lines).toContain('✓ lint   10s')
  expect(lines).toContain('● test')
  expect(lines).toContain('○ build')
  expect(lines).toContain('– docs   13s')
  await ui.unmount()
})

test('a pipeline unfolded while it ran folds again once it finishes; a press opens it again', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })
  let ui = await pane($)
  await ui.press({ key: 'pipe:s-me:g/app#42' })
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe('● ▾ app #42 · main')
  await ui.unmount()

  world.gitlab.set(PIPE, { id: 42, status: 'success', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'success']))
  await world.clock.advance(15_000)
  ui = await pane($)
  await ui.press({ key: 'pipelines' })
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe('▸ app #42 · main')
  await ui.press({ key: 'pipe:s-me:g/app#42' })
  expect((await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' }))?.text).toBe('▾ app #42 · main')
  await ui.unmount()
})

test('the session polls an unfinished pipeline every 15 s; once failed, only once a minute (a retry)', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  await start($)
  await watch($, world, { watch: [{ project: 'g/app', pipeline: 42 }] })
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

  // Failed: no longer every 15 s, but once a minute for a while (a retry would restart it).
  await world.clock.advance(30_000)
  expect(calls()).toBe(4)
  await world.clock.advance(30_000)
  expect(calls()).toBe(6)

  const ui = await pane($)
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe(
    `▸ app #42 · main · failed  1/1 · ${formatTime(isoAt(T0 + 15_000), T0 + 75_000)}`,
  )
  await ui.unmount()
})

test('a CLI that keeps failing is asked less and less, then the watch stops and says why', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  // glab is not logged in: every call fails.
  world.failures.set(PIPE, {
    exitCode: 1,
    stdout: '',
    stderr: 'glab: 401 Unauthorized (run glab auth login)',
  })
  await start($)
  await update($, {
    watch: [{ project: 'g/app', pipeline: 42 }],
    tasks: [{ id: 'ship', title: 'Ship', status: 'doing', pipeline: 'g/app#42' }],
  })
  const calls = () => glabCalls(world.runs, PIPE)
  const row = () => read(disk, `${DIR}/s-me.json`).pipelines?.[0]
  await world.clock.settle()
  expect(calls()).toBe(1)
  expect(row()).toMatchObject({ fails: 1, error: 'glab: 401 Unauthorized (run glab auth login)' })
  // Not every 15 s any more: after 30 s, then 1 min later, then 2 min later.
  await world.clock.advance(15_000)
  expect(calls()).toBe(1)
  await world.clock.advance(15_000)
  expect(calls()).toBe(2)
  await world.clock.advance(45_000)
  expect(calls()).toBe(2)
  await world.clock.advance(15_000)
  expect(calls()).toBe(3)
  expect(row()).toMatchObject({ fails: 3 })
  expect(row()?.stopped).toBeUndefined()

  // Seven failures in, the next one due: the eighth ends the watch (seeded, not an hour of ticks).
  const file = read(disk, `${DIR}/s-me.json`)
  put(disk, `${DIR}/s-me.json`, {
    ...file,
    pipelines: (file.pipelines ?? []).map(p => ({ ...p, fails: 7, checkedAt: isoAt(T0 - 20 * 60_000) })),
  })
  await world.clock.advance(15_000)
  expect(row()).toMatchObject({
    stopped: 'errors',
    error:
      'stopped watching — 8 checks in a row failed: glab: 401 Unauthorized (run glab auth login). Watch it again once that is fixed.',
  })
  const stoppedAt = calls()
  await world.clock.advance(30 * 60_000)
  expect(calls()).toBe(stoppedAt)
  // The pane no longer counts it as watched, and its row says why.
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'pipelines' }))?.text).toBe(
    '▾ Pipelines  0 watching · 0 succeeded · 0 failed · 1 not watched',
  )
  expect(await exactText(ui, row()?.error ?? '?')).toBeTruthy()
  await ui.unmount()
  // The agent is told once: its task no longer closes by itself.
  const told = (await $.classic.UserPromptSubmit({ prompt: 'next' } as never)) as {
    additionalContext?: string[]
  }
  expect((told.additionalContext ?? []).join(' ')).toContain('pipeline g/app#42 is no longer watched')

  // Logged in again, and watched again: it starts over.
  world.failures.delete(PIPE)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  await watch($, world, { watch: [{ project: 'g/app', pipeline: 42 }] })
  expect(row()).toMatchObject({ state: 'running' })
  expect([row()?.stopped, row()?.fails, row()?.error]).toEqual([undefined, undefined, undefined])
})

test('a pipeline waiting on a manual job is asked every 5 minutes, not every 15 s', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'manual', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['deploy', 'manual']))
  await start($)
  await watch($, world, { watch: [{ project: 'g/app', pipeline: 42 }] })
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({ state: 'manual' })
  expect(glabCalls(world.runs, PIPE)).toBe(1)
  await world.clock.advance(4 * 60_000 + 45_000)
  expect(glabCalls(world.runs, PIPE)).toBe(1)
  // Someone pressed play meanwhile: the next look sees it, and it is polled as running again.
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  await world.clock.advance(15_000)
  expect(glabCalls(world.runs, PIPE)).toBe(2)
  await world.clock.advance(15_000)
  expect(glabCalls(world.runs, PIPE)).toBe(3)
})

test('a commit that never gets a pipeline is asked rarely, then given up after an hour', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  const sha = 'b'.repeat(40)
  const list = `projects/g%2Fapp/pipelines?sha=${sha}&per_page=100`
  world.gitlab.set(list, [])
  await watch($, world, { watch: [{ project: 'g/app', sha }] })
  ageWatches(disk, 11)
  await world.clock.advance(15_000)
  const row = () => read(disk, `${DIR}/s-me.json`).pipelines?.[0]
  expect(row()).toMatchObject({ noPipeline: true })
  // Past the hint it is parked: one look in the next five minutes, not twenty.
  const before = glabCalls(world.runs, list)
  await world.clock.advance(4 * 60_000 + 45_000)
  expect(glabCalls(world.runs, list)).toBe(before)
  await world.clock.advance(15_000)
  expect(glabCalls(world.runs, list)).toBe(before + 1)
  // An hour after it was added: stopped.
  ageWatches(disk, 61)
  await world.clock.advance(5 * 60_000)
  expect(row()).toMatchObject({
    stopped: 'nopipeline',
    error:
      'stopped watching — no pipeline for commit bbbbbbbbbbbb after 60 min. Watch it again if one is coming.',
  })
  const end = glabCalls(world.runs, list)
  await world.clock.advance(10 * 60_000)
  expect(glabCalls(world.runs, list)).toBe(end)
})

test("a watch's first check never holds the tool's answer, and joins the round already running", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  const OTHER = 'projects/g%2Fapp/pipelines/43'
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  world.gitlab.set(OTHER, { id: 43, status: 'failed', ref: 'main' })
  world.gitlab.set(`${OTHER}/jobs?per_page=100`, jobsOf(['lint', 'failed']))
  await start($)
  // GitLab does not answer: the tool's answer comes back all the same.
  let release = () => {}
  world.net.hold = new Promise<void>(r => {
    release = r
  })
  const answer = await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })
  expect(JSON.stringify(answer)).toContain('watching g/app#42')
  await world.clock.settle()
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({ state: 'unknown', checkedAt: null })
  // A second watch while that round still waits: no second round beside it.
  await update($, { watch: [{ project: 'g/app', pipeline: 43 }] })
  await world.clock.advance(15_000)
  expect(world.runs.filter(r => r[0] === 'glab')).toHaveLength(1)
  release()
  world.net.hold = undefined
  await world.clock.settle()
  // The one round did both: each pipeline read once, the finish toasted once.
  expect(glabCalls(world.runs, PIPE)).toBe(1)
  expect(glabCalls(world.runs, OTHER)).toBe(1)
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.map(p => p.state)).toEqual(['running', 'failed'])
  expect(world.toasts.filter(x => x.startsWith('Pipeline'))).toEqual(['Pipeline app failed'])
})

test(
  'what the agent is told about the refresh follows the setting, never a fixed number',
  { options: { pipelineRefreshSec: '30' } },
  async ($, on) => {
    const disk = makeDisk()
    const world = engine(on, disk)
    world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
    world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
    await start($)
    const answer = await watch($, world, { watch: [{ project: 'g/app', pipeline: 42 }] })
    expect(JSON.stringify(answer)).toContain('watching g/app#42 (refreshed every 30 s until they finish)')
    // And it is what happens: nothing at 15 s, the next check at 30 s.
    expect(glabCalls(world.runs, PIPE)).toBe(1)
    await world.clock.advance(15_000)
    expect(glabCalls(world.runs, PIPE)).toBe(1)
    await world.clock.advance(15_000)
    expect(glabCalls(world.runs, PIPE)).toBe(2)
  },
)

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

test('a poll still waiting on the forge is never joined by the next one', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  await start($)
  await update($, { watch: [{ project: 'g/app', pipeline: 42 }] })
  const before = world.runs.filter(argv => argv[0] === 'glab').length

  // GitLab answers slower than the refresh interval: two more rounds come due meanwhile.
  let release = () => {}
  world.net.hold = new Promise<void>(r => {
    release = r
  })
  let held = 0
  const first = new Promise<void>(r => {
    world.net.onHeld = () => {
      held += 1
      r()
    }
  })
  // The advance resolves once all three rounds came due and each got as far as it can: the first
  // waits on GitLab, the other two found it running and did nothing.
  const polling = world.clock.advance(45_000)
  await first
  await polling
  expect(held).toBe(1)
  release()
  world.net.hold = undefined
  await world.clock.settle()
  // The one round that ran: the pipeline and its jobs.
  expect(world.runs.filter(argv => argv[0] === 'glab').length - before).toBeGreaterThanOrEqual(2)
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({ state: 'running' })
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
  await watch($, world, {
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

test('a Gitea/Forgejo run is read through tea, with the login on its host', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.tea.logins = [{ name: 'cb', url: 'https://codeberg.org', ssh_host: '', user: 'me', default: 'true' }]
  const byCommit = '/repos/team/app/actions/runs?head_sha=abc1234&limit=50'
  world.tea.api.set(`cb ${byCommit}`, {
    total_count: 1,
    workflow_runs: [
      { id: 77, status: 'running', commit_sha: 'abc1234', prettyref: 'main', html_url: 'https://cb/u77' },
    ],
  })
  world.tea.api.set('cb /repos/team/app/actions/runs/77/jobs', [{ id: 1, name: 'build', status: 'running' }])
  await start($)
  await watch($, world, {
    watch: [
      { provider: 'gitea', project: 'team/app', sha: 'abc1234', host: 'codeberg.org' },
      { provider: 'gitea', project: 'team/app', run: 3, host: 'gitea.example.com' },
    ],
  })
  const [found, unknown] = read(disk, `${DIR}/s-me.json`).pipelines ?? []
  expect(found).toMatchObject({
    key: 'gt:codeberg.org/team/app@abc1234',
    id: 77,
    state: 'running',
    ref: 'main',
    url: 'https://cb/u77',
    jobs: [{ name: 'build', state: 'running' }],
  })
  expect(unknown?.error).toBe('tea: no login for gitea.example.com (tea login add)')
  expect(world.runs.filter(r => r[0] === 'tea')).toContainEqual(['tea', 'api', '--login', 'cb', byCommit])
  // The login list is read once, not per call.
  expect(world.runs.filter(r => r[0] === 'tea' && r[1] === 'login')).toHaveLength(1)
})

test(
  'any CI: the custom command from the settings prints the status; values never become extra arguments',
  { options: { ciCommand: '~/bin/ci-status {project} {id}' } },
  async ($, on) => {
    const disk = makeDisk()
    const world = engine(on, disk)
    world.programs.set(
      '/home/me/bin/ci-status jenkins/nightly 12',
      JSON.stringify({
        id: 12,
        state: 'running',
        url: 'https://ci/u12',
        jobs: [{ name: 'build', state: 'success' }],
      }),
    )
    await start($)
    await watch($, world, { watch: [{ provider: 'command', project: 'jenkins/nightly', pipeline: 12 }] })
    expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({
      key: 'ci:jenkins/nightly#12',
      state: 'running',
      url: 'https://ci/u12',
      jobs: [{ name: 'build', state: 'success' }],
    })
    expect(world.runs).toContainEqual(['/home/me/bin/ci-status', 'jenkins/nightly', '12'])
  },
)

test('a custom-command watch without the setting says what to set', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await watch($, world, { watch: [{ provider: 'command', project: 'jenkins/nightly', pipeline: 12 }] })
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]?.error).toBe(
    'no custom CI command set (plugin settings: Custom CI command)',
  )
})

test('a pipeline watched by commit is found once GitLab has it', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { watch: [{ project: 'g/app', sha: 'abc1234', label: 'app main' }] })
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({ key: 'g/app@abc1234', id: null })

  world.gitlab.set('projects/g%2Fapp/pipelines?sha=abc1234&per_page=100', [
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

test('a watch by an abbreviated sha is resolved to the whole commit id and finds its pipeline', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  const full = '70a2803ab1cc3b4c3b523884dab20e4dde71cd16'
  // GitLab's by-commit filter matches only the whole id: the short one lists nothing.
  world.gitlab.set('projects/g%2Fapp/pipelines?sha=70a2803&per_page=100', [])
  world.gitlab.set('projects/g%2Fapp/repository/commits/70a2803', { id: full, short_id: '70a2803' })
  world.gitlab.set(`projects/g%2Fapp/pipelines?sha=${full}&per_page=100`, [
    { id: 42, status: 'success', ref: 'main' },
  ])
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'success']))
  await watch($, world, { watch: [{ project: 'g/app', sha: '70a2803', label: 'app' }] })
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({
    key: 'g/app@70a2803',
    sha: full,
    id: 42,
    state: 'success',
  })
})

// Ages this session's watched pipelines as if they had been added `min` minutes ago — so a test of
// a time-based rule runs ONE refresh, never minutes of simulated 2 s ticks (load-proof).
function ageWatches(disk: Disk, min: number) {
  const file = read(disk, `${DIR}/s-me.json`)
  put(disk, `${DIR}/s-me.json`, {
    ...file,
    pipelines: (file.pipelines ?? []).map(p => ({
      ...p,
      addedAt: new Date(T0 - min * 60_000).toISOString(),
    })),
  })
}

test('a watch whose commit has no pipeline says so after 10 minutes instead of waiting silently', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  const full = 'b'.repeat(40)
  world.gitlab.set(`projects/g%2Fapp/pipelines?sha=${full}&per_page=100`, [])
  await update($, { watch: [{ project: 'g/app', sha: full, label: 'app' }] })
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]?.error).toBeUndefined()
  ageWatches(disk, 11)
  await world.clock.advance(16_000)
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]?.error).toMatch(
    /^no pipeline for commit bbbbbbbbbbbb after 10 min/,
  )
})

test('a failed pipeline that is retried shows running again, then its new outcome', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'failed', ref: 'main', finished_at: new Date(T0).toISOString() })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['check', 'failed']))
  await start($)
  await watch($, world, { watch: [{ project: 'g/app', pipeline: 42 }] })
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({ state: 'failed' })

  // Someone presses Retry: the job runs again.
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['check', 'running']))
  await world.clock.advance(60_000)
  const live = read(disk, `${DIR}/s-me.json`).pipelines?.[0]
  expect(live).toMatchObject({ state: 'running' })
  expect(live?.finishedAt).toBeUndefined()
  expect(live?.pipelineFinishedAt).toBeUndefined()

  world.gitlab.set(PIPE, { id: 42, status: 'success', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['check', 'success']))
  await world.clock.advance(15_000)
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({ state: 'success' })
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

test('a CLI that fails with its answer on stdout shows a short error, never the answer', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'failed', ref: 'main' })
  const body = JSON.stringify(jobsOf(['check', 'failed']))
  world.failures.set(`${PIPE}/jobs?per_page=100`, { exitCode: 1, stdout: body, stderr: '' })
  await start($)
  await watch($, world, { watch: [{ project: 'g/app', pipeline: 42 }] })
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]?.error).toBe('glab exited 1')
})

test('a long error stored earlier shows clipped to one short line', async ($, on) => {
  const disk = makeDisk()
  const theirs = other('s-other', 'site', T0, {})
  theirs.pipelines = [
    {
      key: 'g/site#7',
      project: 'g/site',
      id: 7,
      label: 'site',
      state: 'failed',
      ref: 'main',
      jobs: [{ name: 'deploy', stage: 'deploy', state: 'failed', durationS: 61 }],
      addedAt: new Date(T0).toISOString(),
      checkedAt: new Date(T0).toISOString(),
      finishedAt: new Date(T0).toISOString(),
      error: `glab: ${'x'.repeat(5000)}`,
    },
  ]
  put(disk, `${DIR}/s-other.json`, theirs)
  engine(on, disk)
  await start($)
  const ui = await pane($)
  const shown = (await texts(ui)).filter(line => line.includes('xxx'))
  expect(shown.length).toBe(1)
  expect(shown[0]?.length).toBeLessThan(250)
  await ui.unmount()
})

test('an API answer stored as an error by 0.21.1 and earlier shows no error line', async ($, on) => {
  const disk = makeDisk()
  const theirs = other('s-other', 'site', T0, {})
  theirs.pipelines = [
    {
      key: 'g/site#7',
      project: 'g/site',
      id: 7,
      label: 'site',
      state: 'failed',
      ref: 'main',
      jobs: [{ name: 'deploy', stage: 'deploy', state: 'failed', durationS: 61 }],
      addedAt: new Date(T0).toISOString(),
      checkedAt: new Date(T0).toISOString(),
      finishedAt: new Date(T0).toISOString(),
      error: JSON.stringify([{ id: 17843656780, status: 'canceled', stage: 'cleanup' }]),
    },
  ]
  put(disk, `${DIR}/s-other.json`, theirs)
  engine(on, disk)
  await start($)
  const ui = await pane($)
  expect((await texts(ui)).filter(line => line.includes('17843656780'))).toEqual([])
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
    `▸ site #7 · main · success  1/1 · ${formatTime(isoAt(T0), T0)}`,
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
    `▸ site #7 · main · success  1/1 · 1m09s · ${formatTime(isoAt(T0 + 15_000), T0 + 15_000)}`,
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

test("an ended session's pipeline is polled by ONE pane: the others leave it while that pane's lease holds", async ($, on) => {
  const disk = makeDisk()
  const theirs = other('s-other', 'site', T0 - HOUR, {})
  theirs.session.endedAt = isoAt(T0 - HOUR)
  theirs.pipelines = [sitePipe()]
  put(disk, `${DIR}/s-other.json`, theirs)
  const world = engine(on, disk)
  world.gitlab.set(SITE, { id: 7, status: 'running', ref: 'main' })
  world.gitlab.set(`${SITE}/jobs?per_page=100`, jobsOf(['deploy', 'running']))
  // Another pane on this machine polls orphans right now.
  world.store.set('orphan-poller', { id: 's-pane-2', untilMs: T0 + 100_000 })
  await start($)
  await world.clock.advance(90_000)
  expect(glabCalls(world.runs, SITE)).toBe(0)
  expect(world.store.get('orphan-poller')).toEqual({ id: 's-pane-2', untilMs: T0 + 100_000 })
  // That pane went away: its lease ran out, this one takes over — and keeps the lease while it polls.
  await world.clock.advance(15_000)
  expect(glabCalls(world.runs, SITE)).toBe(1)
  expect(world.store.get('orphan-poller')).toEqual({ id: 's-me', untilMs: T0 + 105_000 + 150_000 })
  // A lease no pane could have written (a clock that jumped) holds nobody off.
  world.store.set('orphan-poller', { id: 's-pane-2', untilMs: T0 + 99 * HOUR })
  await world.clock.advance(75_000)
  expect(glabCalls(world.runs, SITE)).toBe(2)
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
  expect(await line(9)).toBe('● ▸ site #9 · main · running  ░░░░░░░░ 0/1 · 1h00m')
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
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe('● ▸ app #42 · main · running  ░░░░░░░░ 0/1 · 1m05s')
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
    `▸ app #42 · main · success  1/1 · 1m10s · ${formatTime(isoAt(T0 + 10_000), T0 + 15_000)}`,
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
  // the pane header (its version in the corner), the session header row, the Done row (Clear all)
  // and one row per done task (✕)
  expect(spread.length).toBe(5)
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
    '● ▸ app #42 · main · running  ░░░░░░░░ 0/1 · 4m53s / ~33m',
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
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe('● ▸ app #42 · main · running  ░░░░░░░░ 0/1 · 1m05s')
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
  await watch($, world, { watch: [{ project: 'g/app', pipeline: 42 }] })
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
    head_sha: 'abc1234',
    event: 'push',
    workflow_id: 77,
    run_started_at: started,
    updated_at: started,
    html_url: 'https://github.com/Kirbo/ha/actions/runs/900',
  }
  world.github.set(`${REPO}/actions/runs?head_sha=abc1234&per_page=100`, {
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
  await watch($, world, { watch: [{ provider: 'github', project: 'Kirbo/ha', sha: 'abc1234' }] })

  const saved = read(disk, `${DIR}/s-me.json`).pipelines?.[0]
  expect(saved?.key).toBe('gh:Kirbo/ha@abc1234')
  expect(saved?.provider).toBe('github')
  expect(saved?.id).toBe(900)
  expect(saved?.state).toBe('running')
  expect(saved?.estimateS).toBe(90)
  // Only `gh` was asked — never `glab` for a GitHub run.
  expect(world.runs.some(r => r[0] === 'glab')).toBe(false)

  const ui = await pane($)
  expect(await pipeLine(ui, 'pipe:s-me:gh:Kirbo/ha@abc1234')).toBe(
    '● ▸ ha #900 · main · running  ████░░░░ 1/2 · 30s / ~2m',
  )
  await ui.press({ key: 'pipe:s-me:gh:Kirbo/ha@abc1234' })
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

test('a session the plugin joined mid-way gets the reporting rule with its next prompt, then one reminder — never one per prompt', async ($, on) => {
  engine(on, makeDisk())
  await start($)
  const context = async () =>
    ((await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)) as { additionalContext?: string[] })
      .additionalContext ?? []
  // No system prompt was composed since the plugin loaded (installed, reloaded or resumed mid-way):
  // the rule itself rides the first prompt, once.
  const first = (await context()).join('\n')
  expect(first).toContain('# Progress pane')
  expect(first).toMatch(/first tool call/i)
  // Then one one-line reminder, while the session has reported nothing…
  const second = await context()
  expect(second).toHaveLength(1)
  expect(second[0]).not.toContain('# Progress pane')
  expect(second[0]).toContain(TOOL)
  // …and no more: a session of plain questions and answers is not reminded with every prompt.
  expect(await context()).toEqual([])
  expect(await context()).toEqual([])
  await update($, { now: 'Fixing it', tasks: [{ title: 'Fix' }] })
  expect(await context()).toEqual([])
})

test('a session that reported before its second prompt gets no reminder at all', async ($, on) => {
  engine(on, makeDisk())
  await start($)
  const context = async () =>
    ((await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)) as { additionalContext?: string[] })
      .additionalContext ?? []
  expect((await context()).join('\n')).toContain('# Progress pane')
  await update($, { now: 'Fixing it', tasks: [{ title: 'Fix' }] })
  expect(await context()).toEqual([])
})

test("a new session's first prompt leaves the rule to its system prompt — it never gets both", async ($, on) => {
  engine(on, makeDisk())
  await start($)
  await $.classic.SessionStart({ source: 'startup' } as never)
  const context = (r: unknown) => ((r as { additionalContext?: string[] }).additionalContext ?? []).join('\n')
  const prompt = async () => context(await $.classic.UserPromptSubmit({ prompt: 'go on' } as never))
  const call = async (id: string) =>
    context(
      await $.classic.PostToolUse({
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
        tool_use_id: id,
      } as never),
    )
  // The tool is still connecting when the session starts, so the system prompt composed so far has
  // no rule; the one composed for the first request (the tool offered by then) carries it.
  expect(await prompt()).not.toContain('# Progress pane')
  const composed = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash', TOOL],
    outputStyle: null,
    traits: ['skills'],
  })
  expect(composed.sections.map(x => x.id)).toContain('progress-panel:reporting')
  expect(await call('x1')).not.toContain('# Progress pane')
  expect(await prompt()).not.toContain('# Progress pane')
})

test('a new session whose system prompt never carried the rule gets it with its first tool call, once', async ($, on) => {
  engine(on, makeDisk())
  await start($)
  await $.classic.SessionStart({ source: 'startup' } as never)
  const context = (r: unknown) => ((r as { additionalContext?: string[] }).additionalContext ?? []).join('\n')
  const call = async (id: string, agent?: string) =>
    context(
      await $.classic.PostToolUse({
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
        tool_use_id: id,
        ...(agent ? { agent_id: agent } : {}),
      } as never),
    )
  expect(context(await $.classic.UserPromptSubmit({ prompt: 'go on' } as never))).not.toContain(
    '# Progress pane',
  )
  // Nothing composed it by the first step of the main loop: the rule rides that step.
  expect(await call('x1')).toContain('# Progress pane')
  expect(await call('x2')).not.toContain('# Progress pane')
  expect(context(await $.classic.UserPromptSubmit({ prompt: 'and' } as never))).not.toContain(
    '# Progress pane',
  )
})

test('a compaction hands the rule again to a session that only had it from a prompt — never to a composed one', async ($, on) => {
  engine(on, makeDisk())
  await start($)
  const context = async (e: object) =>
    ((await $.classic.SessionStart(e as never)) as { additionalContext?: string[] }).additionalContext ?? []
  // The rule rode the first prompt (the plugin joined mid-way): a compaction may summarise it away.
  await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)
  const after = (await context({ source: 'compact' })).join('\n')
  expect(after).toContain('# Progress pane')
  // Any other start is not a compaction.
  expect(await context({ source: 'resume' })).toEqual([])
  // A subagent's own compaction is not the session's.
  expect(await context({ source: 'compact', agent_id: 'sub-c' })).toEqual([])
})

test('a composed system prompt survives a compaction: no copy of the rule rides it', async ($, on) => {
  engine(on, makeDisk())
  await start($)
  await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash', TOOL],
    outputStyle: null,
    traits: ['skills'],
  })
  const after = (await $.classic.SessionStart({ source: 'compact' } as never)) as {
    additionalContext?: string[]
  }
  expect(after.additionalContext ?? []).toEqual([])
})

test('a subagent is handed the reporting rule as it starts; its first tool call then carries no second copy', async ($, on) => {
  engine(on, makeDisk())
  await start($)
  const started = (await $.classic.SubagentStart({
    agent_id: 'sub-start',
    agent_type: 'general-purpose',
  } as never)) as { additionalContext?: string[] }
  expect((started.additionalContext ?? []).join(' ')).toContain('you are a subagent')
  const first = (await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'z1',
    agent_id: 'sub-start',
  } as never)) as { additionalContext?: string[] }
  expect((first.additionalContext ?? []).join(' ')).not.toContain('you are a subagent')
})

test('/progress doctor names what is wrong with the setup, with its fix — and all green once fixed', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  world.programs.set('git -C /w/app/sub rev-parse --show-toplevel', '/w/app\n')
  world.programs.set('git -C /w/app remote get-url origin', 'git@gitlab.com:group/app.git\n')
  // Today's two real failures: a token that sees only another project, an SSH host key not trusted.
  world.failures.set('projects/group%2Fapp', {
    exitCode: 1,
    stdout: '',
    stderr: 'glab: 404 Project Not Found',
  })
  world.failures.set('HEAD', {
    exitCode: 128,
    stdout: '',
    stderr: 'Host key verification failed.\nfatal: Could not read from remote repository.',
  })
  const doctor = async () =>
    ((await $.command.run({ command: 'progress', args: 'doctor' } as never)) as { text: string }).text
  const before = await doctor()
  expect(before).toContain('✓ Version: 0.14.0')
  expect(before).toContain('✗ Reporting rule: not delivered yet')
  expect(before).toContain('– Session process: not recorded')
  expect(before).toContain('✓ Progress folder:')
  expect(before).toContain('✓ CI: gitlab in app')
  expect(before).toContain('✗ Forge CLI: glab is logged in but cannot read group/app on gitlab.com')
  expect(before).toContain('→ log glab in with a token that can read group/app')
  expect(before).toContain(
    '✗ Git remote: git cannot reach git@gitlab.com:group/app.git: the SSH host key is not trusted',
  )
  // The probe file is gone again.
  expect([...disk.files.keys()].some(k => k.includes('.doctor-'))).toBe(false)

  world.failures.delete('projects/group%2Fapp')
  world.failures.delete('HEAD')
  world.gitlab.set('projects/group%2Fapp', { id: 1 })
  world.programs.set('git -C /w/app ls-remote --exit-code origin HEAD', 'abc\tHEAD\n')
  await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)
  const after = await doctor()
  expect(after).toContain('✓ Reporting rule: handed over with a prompt')
  expect(after).toContain('✓ Forge CLI: glab reads group/app on gitlab.com')
  expect(after).toContain('✓ Git remote: git reaches')
  expect(after).not.toContain('✗')
})

test('/progress doctor says what the plugin costs the agent: in every request, and handed over so far', async ($, on) => {
  engine(on, makeDisk())
  await start($)
  const doctor = async () =>
    ((await $.command.run({ command: 'progress', args: 'doctor' } as never)) as { text: string }).text
  const cost = (text: string) => text.split('\n').find(line => line.includes('Cost to the agent')) ?? ''
  // Before any prompt was composed: the tool and its schema ride every request; no rule yet.
  const tool = Math.round((JSON.stringify(INPUT_SCHEMA).length + TOOL_DESCRIPTION.length) / 4)
  expect(cost(await doctor())).toBe(
    `✓ Cost to the agent: about ${tool} tokens in every request (the tool and its schema ~${tool}, the reporting rule ~0); handed over since the plugin loaded: nothing yet — estimates, 4 characters to a token`,
  )
  const composed = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash', TOOL],
    outputStyle: null,
    traits: ['skills'],
  })
  const ruleText = composed.sections.find(x => x.id === 'progress-panel:reporting')?.text ?? ''
  const rule = Math.round(ruleText.length / 4)
  expect(rule).toBeGreaterThan(100)
  // Two answers, a note with a tool call's result, and the rule appended to an Agent call's prompt.
  const first = (await update($, { now: 'x', tasks: [{ title: 'Write the docs', status: 'doing' }] })) as {
    result: string
  }
  const second = (await update($, { tasks: [{ id: 't1', status: 'blocked' }] })) as { result: string }
  const answers = Math.round((first.result.length + second.result.length) / 4)
  const spawned = (await $.tool.call({
    tool: 'Agent',
    description: 'Lane A',
    prompt: 'Do the thing.',
    subagent_type: 'general-purpose',
  } as never)) as unknown
  expect(spawned).toBeDefined()
  const noted = (await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'x1',
  } as never)) as { additionalContext?: string[] }
  const notes = Math.round((noted.additionalContext ?? []).join('').length / 4)
  expect(notes).toBeGreaterThan(0)
  const prompts = Math.round(('\n\n'.length + SUBAGENT_RULE_TEXT.length) / 4)
  expect(cost(await doctor())).toBe(
    `✓ Cost to the agent: about ${tool + rule} tokens in every request (the tool and its schema ~${tool}, the reporting rule ~${rule}); handed over since the plugin loaded: about ${answers + notes + prompts} tokens (2 tool answers ~${answers}, notes ~${notes}, subagent prompts ~${prompts}) — estimates, 4 characters to a token`,
  )
})

test('/progress doctor outside a repository checks only what applies; a missing CLI says to install it', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  const doctor = async () =>
    ((await $.command.run({ command: 'progress', args: ' Doctor ' } as never)) as { text: string }).text
  expect(await doctor()).toContain('– CI: not in a git repository')
  world.programs.set('git -C /w/app/sub rev-parse --show-toplevel', '/w/app\n')
  world.programs.set('git -C /w/app remote get-url origin', 'https://github.com/owner/app.git\n')
  world.programs.set('git -C /w/app ls-remote --exit-code origin HEAD', 'abc\tHEAD\n')
  disk.files.set('/w/app/.github/workflows/ci.yml', { text: 'ci', mtimeMs: 1 })
  world.failures.set('repos/owner/app', { exitCode: 127, stdout: '', stderr: '' })
  const text = await doctor()
  expect(text).toContain('✓ CI: github in app')
  expect(text).toContain('✗ Forge CLI: gh is not installed or not on PATH')
  expect(text).toContain('→ install gh')
})

test('a session whose process died without ending is marked ended; a live one, another machine and this one are not', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.programs.set(`sh -c ${WHO_AM_I}`, '4000\nclaude\nMini.local\n777000\n')
  // 4343 and 4444 answer (alive, each with when it started); 4242 does not (gone).
  world.programs.set(`sh -c ${STILL_RUNS} sh 4343`, '500100\n')
  world.programs.set(`sh -c ${STILL_RUNS} sh 4444`, '900900\n')
  world.programs.set(`sh -c ${STILL_RUNS} sh 4545`, '\n')
  const idle = new Date(T0 - 11 * 60_000).toISOString()
  const other = (id: string, pid: number, host: string, pidStart?: string) => ({
    version: 2,
    session: {
      id,
      project: 'p',
      cwd: '/w',
      startedAt: idle,
      endedAt: null,
      pid,
      host,
      ...(pidStart ? { pidStart } : {}),
    },
    needsYou: [],
    updatedAt: idle,
    tasks: [{ id: 't1', title: 'x', status: 'doing', createdAt: idle, updatedAt: idle }],
    dismissed: [],
    seq: 1,
  })
  put(disk, `${DIR}/s-dead.json`, other('s-dead', 4242, 'mini.local'))
  put(disk, `${DIR}/s-live.json`, other('s-live', 4343, 'mini.local'))
  put(disk, `${DIR}/s-away.json`, other('s-away', 4242, 'laptop.local'))
  // The same pid, started when the file says: that process. Started at another time: the pid was
  // given to something else since (a reboot, a long day) — the session is gone.
  put(disk, `${DIR}/s-same.json`, other('s-same', 4343, 'mini.local', '500100'))
  put(disk, `${DIR}/s-reused.json`, other('s-reused', 4444, 'mini.local', '111111'))
  // Alive, but when it started cannot be told: never ended on a guess.
  put(disk, `${DIR}/s-untold.json`, other('s-untold', 4545, 'mini.local', '222222'))
  await start($)
  await update($, { now: 'here' })
  // This session's file names its own process, when that started, and its machine.
  expect(read(disk, `${DIR}/s-me.json`).session).toMatchObject({
    pid: 4000,
    host: 'mini.local',
    pidStart: '777000',
  })
  await world.clock.advance(2100)
  expect(read(disk, `${DIR}/s-dead.json`).session.endedAt).toBe(idle)
  expect(read(disk, `${DIR}/s-live.json`).session.endedAt).toBeNull()
  expect(read(disk, `${DIR}/s-away.json`).session.endedAt).toBeNull()
  expect(read(disk, `${DIR}/s-same.json`).session.endedAt).toBeNull()
  expect(read(disk, `${DIR}/s-reused.json`).session.endedAt).toBe(idle)
  expect(read(disk, `${DIR}/s-untold.json`).session.endedAt).toBeNull()

  // A session another pane wrongly marked ended is live again with its next write.
  const mine = read(disk, `${DIR}/s-me.json`)
  put(disk, `${DIR}/s-me.json`, { ...mine, session: { ...mine.session, endedAt: idle } })
  await update($, { now: 'still here' })
  expect(read(disk, `${DIR}/s-me.json`).session.endedAt).toBeNull()
})

test('a parent process that is not Claude Code records no pid — nothing is ever ended on a guess', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.programs.set(`sh -c ${WHO_AM_I}`, '4000\nsandbox-helper\nmini\n1\n')
  await start($)
  await update($, { now: 'here' })
  expect(read(disk, `${DIR}/s-me.json`).session.pid).toBeUndefined()
})

const ctx = (r: unknown) => ((r as { additionalContext?: string[] }).additionalContext ?? []).join('\n')
const cmd = async ($: $Test, args: string) =>
  ((await $.command.run({ command: 'progress', args } as never)) as { text: string }).text

test("after /clear the new entry starts over: the old session's switches, name and pending notes stay behind", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await $.classic.UserPromptSubmit({ prompt: 'go', session_title: 'Old name' } as never)
  await cmd($, 'tasks off')
  await update($, { now: 'before clear' })
  expect(read(disk, `${DIR}/s-me.json`)).toMatchObject({
    toggles: { tasks: false },
    session: { title: 'Old name' },
  })
  // /clear: the conversation ends, the process goes on under a new id — no session.start for it.
  await $.session.end({ reason: 'clear' } as never)
  world.switchId('s-next')
  const cleared = (await $.classic.SessionStart({ source: 'clear' } as never)) as {
    additionalContext?: string[]
  }
  // The switch change the old conversation was owed is not handed to the new one.
  expect((cleared.additionalContext ?? []).join(' ')).not.toContain('tasks are off')
  expect(await cmd($, 'status')).toContain('tasks on (default)')
  const answer = JSON.stringify(await update($, { now: 'after clear', tasks: [{ title: 'Fresh' }] }))
  expect(answer).not.toContain('Tasks are off')
  const next = read(disk, `${DIR}/s-next.json`)
  expect(next.toggles).toBeUndefined()
  expect(next.session.title).toBeUndefined()
  expect(next.tasks.map(x => x.title)).toEqual(['Fresh'])
  // Resumed in the same process, the first session's own switches apply again.
  await $.session.end({ reason: 'resume' } as never)
  world.switchId('s-me')
  await $.classic.SessionStart({ source: 'resume', session_title: 'Old name' } as never)
  expect(await cmd($, 'status')).toContain('tasks off (this session)')
})

test(
  'autoStart off: a new session stays dormant until /progress on — then the whole rule, once',
  { options: { autoStart: 'off' } },
  async ($, on) => {
    const disk = makeDisk()
    const world = engine(on, disk)
    await start($)
    // Dormant: the pane does not open by itself, no rule rides the prompt, the tool writes nothing.
    expect(world.opened).toHaveLength(0)
    expect(ctx(await $.classic.UserPromptSubmit({ prompt: 'go' } as never))).toBe('')
    expect(JSON.stringify(await update($, { now: 'x' }))).toContain('Reporting is off for this session')
    expect(disk.files.has(`${DIR}/s-me.json`)).toBe(false)
    expect(await cmd($, 'status')).toContain('reporting off (default)')

    expect(await cmd($, 'on')).toContain('reporting is on')
    expect(world.opened.length).toBeGreaterThan(0)
    const first = ctx(await $.classic.UserPromptSubmit({ prompt: 'go' } as never))
    expect(first).toContain('# Progress pane')
    expect(first.split('# Progress pane')).toHaveLength(2)
    expect(await cmd($, 'status')).toContain('reporting on (this session)')
    // Kept in the session's own file: a reload or resume reads it back.
    expect(read(disk, `${DIR}/s-me.json`).toggles).toEqual({ reporting: true })
  },
)

test('/progress off: one note, then nothing — no nudge, no removal note, the tool refuses', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, { now: 'working', tasks: [{ title: 'A' }] })
  await cmd($, 'off')
  expect(ctx(await $.classic.UserPromptSubmit({ prompt: 'go' } as never))).toContain(
    'reporting is off for this session',
  )
  expect(ctx(await $.classic.UserPromptSubmit({ prompt: 'go' } as never))).toBe('')
  expect(JSON.stringify(await update($, { now: 'more' }))).toContain('Reporting is off')
  // Its entry is kept, shown paused.
  expect(read(disk, `${DIR}/s-me.json`).now).toBe('working')
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'group:s-me' }))?.text).toContain('· paused')
  await ui.unmount()
})

test(
  'tasks off: progress_update keeps now and needsYou, drops tasks, and says so; the rule says now-only',
  { options: { tasksDefault: 'off' } },
  async ($, on) => {
    const disk = makeDisk()
    engine(on, disk)
    await start($)
    const answer = JSON.stringify(await update($, { now: 'n', needsYou: ['OK?'], tasks: [{ title: 'A' }] }))
    expect(answer).toContain('Tasks are off')
    const file = read(disk, `${DIR}/s-me.json`)
    expect(file.tasks).toEqual([])
    expect(file.needsYou).toEqual(['OK?'])
    const rule = ctx(await $.classic.UserPromptSubmit({ prompt: 'go' } as never))
    expect(rule).toContain('tasks are off')
    expect(rule).not.toContain('one task per unit of work')
  },
)

test('agents off: a subagent gets no rule and its report is refused; pipelines off: no watch, by hand or by push', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { now: 'coordinating' })
  await cmd($, 'agents off')
  const sub = (await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'q1',
    agent_id: 'sub-x',
  } as never)) as { additionalContext?: string[] }
  expect((sub.additionalContext ?? []).join(' ')).not.toContain('you are a subagent')
  expect(JSON.stringify(await $.tool.call({ tool: TOOL, agentId: 'sub-x', now: 'r' } as never))).toContain(
    'Agent reporting is off',
  )
  await cmd($, 'pipelines off')
  expect(JSON.stringify(await update($, { watch: [{ project: 'team/app', pipeline: 7 }] }))).toContain(
    'Pipelines are off',
  )
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git' })
  await bash($, 'git push')
  expect(read(disk, `${DIR}/s-me.json`).pipelines ?? []).toEqual([])
  expect(await cmd($, 'status')).toContain('agents off (this session)')
  expect(await cmd($, 'pipelines maybe')).toContain('Usage')
})

test("a switch is turned off in Settings; the pane's switches row shows while one is off and turns it back on", async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, { now: 'n', tasks: [{ title: 'Visible task' }] })
  const ui = await pane($)
  expect((await texts(ui)).join('\n')).toContain('Visible task')
  // Everything on: no switches row (it said nothing and took the pane's second line).
  expect(await ui.find({ type: 'Button', key: 'switch:tasks' })).toBeUndefined()
  await ui.press({ key: 'settings:open' })
  await ui.press({ key: 'setting:session:tasks' })
  await ui.press({ key: 'settings:back' })
  expect(read(disk, `${DIR}/s-me.json`).toggles).toEqual({ tasks: false })
  expect((await texts(ui)).join('\n')).not.toContain('Visible task')
  // One is off: the row is there, and turns it back on with one press — then goes again.
  await ui.press({ key: 'switch:tasks' })
  expect((await texts(ui)).join('\n')).toContain('Visible task')
  expect(await ui.find({ type: 'Button', key: 'switch:tasks' })).toBeUndefined()
  await ui.unmount()
})

test("an Agent call's prompt carries the subagent rule — once, not to a fork, not while agents are off", async ($, on) => {
  const prompts: string[] = []
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    prompts.push((e as { prompt: string }).prompt)
    return { result: {} } as never
  })
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-fed', description: 'Lane A', type: 'general-purpose', status: 'running' })
  await start($)
  const agent = (input: Record<string, unknown>) =>
    $.tool.call({ tool: 'Agent', description: 'Lane A', prompt: 'Do the thing.', ...input } as never)
  await agent({ subagent_type: 'general-purpose' })
  expect(prompts[0]).toContain('Do the thing.')
  expect(prompts[0]).toContain('you are a subagent')
  // A prompt that already holds it gains no second copy; a fork inherits this session's context.
  await agent({ prompt: prompts[0] })
  expect(prompts[1]?.split('you are a subagent')).toHaveLength(2)
  await agent({ subagent_type: 'fork' })
  expect(prompts[2]).toBe('Do the thing.')
  // The subagent its prompt fed gets no second copy at start or with its first tool call.
  const started = (await $.classic.SubagentStart({
    agent_id: 'sub-fed',
    agent_type: 'general-purpose',
  } as never)) as {
    additionalContext?: string[]
  }
  expect(started.additionalContext ?? []).toEqual([])
  await cmd($, 'agents off')
  await agent({ description: 'Lane B' })
  expect(prompts[3]).toBe('Do the thing.')
})

test('a subagent whose prompt carried the rule gets no second copy at start, even before the session lists it', async ($, on) => {
  const prompts: string[] = []
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    prompts.push((e as { prompt: string }).prompt)
    return { result: {} } as never
  })
  const world = engine(on, makeDisk())
  await start($)
  const startOf = async (id: string) =>
    (
      (await $.classic.SubagentStart({ agent_id: id, agent_type: 'general-purpose' } as never)) as {
        additionalContext?: string[]
      }
    ).additionalContext ?? []
  const firstCallOf = async (id: string) =>
    (
      (await $.classic.PostToolUse({
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
        tool_use_id: `u-${id}`,
        agent_id: id,
      } as never)) as { additionalContext?: string[] }
    ).additionalContext ?? []
  await $.tool.call({ tool: 'Agent', description: 'Lane A', prompt: 'Do the thing.' } as never)
  // It starts before `$.agent.list()` names it: who it is cannot be told yet — nothing is added.
  expect(await startOf('sub-late')).toEqual([])
  // By its first tool call the list has it, under the description whose prompt was fed: still none.
  world.agents.push({ id: 'sub-late', description: 'Lane A', type: 'general-purpose', status: 'running' })
  expect(await firstCallOf('sub-late')).toEqual([])
  expect(await firstCallOf('sub-late')).toEqual([])
  // One the list never names at all is taken for one of the fed ones: no copy with its first call.
  expect(await startOf('sub-ghost')).toEqual([])
  expect(await firstCallOf('sub-ghost')).toEqual([])
  // One started some other way (no Agent call of this session fed it), listed late: its first tool
  // call hands the rule over, once.
  expect(await startOf('sub-other')).toEqual([])
  world.agents.push({ id: 'sub-other', description: 'Spawned elsewhere', type: 'x', status: 'running' })
  expect((await firstCallOf('sub-other')).join(' ')).toContain('you are a subagent')
  expect(await firstCallOf('sub-other')).toEqual([])
  // …and one already listed under a description nothing fed gets it as it starts.
  world.agents.push({ id: 'sub-known', description: 'Also elsewhere', type: 'x', status: 'running' })
  expect((await startOf('sub-known')).join(' ')).toContain('you are a subagent')
  // A prompt that already held the rule counts as fed: its subagent gets no copy either.
  await $.tool.call({ tool: 'Agent', description: 'Lane H', prompt: prompts[0] } as never)
  expect(prompts[1]).toBe(prompts[0])
  world.agents.push({ id: 'sub-held', description: 'Lane H', type: 'general-purpose', status: 'running' })
  expect(await startOf('sub-held')).toEqual([])
})

const memoryOf = (disk: Disk) =>
  JSON.parse(disk.files.get(`${DIR}/ci-memory.v1`)?.text ?? '{"repos":{}}').repos

test('a repo without CI is remembered: told once, later pushes skip the work; a CI file appearing or the TTL judges it again', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  gitRepo(world, '/w/plain', { url: 'git@gitlab.com:team/plain.git' })
  const first = await bash($, 'git push', { cwd: '/w/plain' })
  expect(first).toContain('plain runs no CI')
  expect(memoryOf(disk)['/w/plain|']).toMatchObject({ ci: 'none', files: '----' })
  // Again: no note (told once), and no remote lookup at all.
  const lookups = () => world.runs.filter(r => r.includes('get-url')).length
  const before = lookups()
  expect(await bash($, 'git push', { cwd: '/w/plain' })).toBe('')
  expect(lookups()).toBe(before)
  // A CI file appears: judged again — and watched.
  ciFile(disk, '/w/plain/.gitlab-ci.yml')
  expect(await bash($, 'git push', { cwd: '/w/plain' })).toContain('watched automatically')
  expect(memoryOf(disk)['/w/plain|']).toMatchObject({ ci: 'yes', project: 'team/plain' })
  // A no-CI verdict past the TTL (7 days) is judged again: a fresh stamp.
  disk.files.delete('/w/plain/.gitlab-ci.yml')
  const old = T0 - 8 * 24 * 3_600_000
  put(disk, `${DIR}/ci-memory.v1`, {
    version: 1,
    repos: { '/w/plain|': { ci: 'none', files: '----', checkedAtMs: old } },
  })
  await bash($, 'git push', { cwd: '/w/plain' })
  expect(memoryOf(disk)['/w/plain|'].checkedAtMs).toBeGreaterThan(old)
})

test("another session's verdict is reused; a commit that never got a pipeline is remembered; recheck forgets", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git' })
  // Pushed and watched; then 10 minutes with no pipeline for that commit — and the forge says the
  // project has never run one (CI off there).
  world.gitlab.set(`projects/team%2Fapp/pipelines?sha=${'a'.repeat(40)}&per_page=100`, [])
  world.gitlab.set('projects/team%2Fapp/pipelines?per_page=1', [])
  expect(await bash($, 'git push')).toContain('watched automatically')
  ageWatches(disk, 11)
  await world.clock.advance(16_000)
  expect(memoryOf(disk)['/w/app|']).toMatchObject({ ci: 'nopipeline' })
  // The next push is not watched; the agent is told once.
  const next = await bash($, 'git push')
  expect(next).toContain('app runs no CI')
  expect(next).not.toContain('watched automatically')
  // Shared: a verdict another session wrote is read the same way (here: written straight to disk).
  put(disk, `${DIR}/ci-memory.v1`, {
    version: 1,
    repos: { '/w/other|': { ci: 'none', files: '----', checkedAtMs: T0 + 11 * 60_000 } },
  })
  gitRepo(world, '/w/other', { url: 'git@gitlab.com:team/other.git' })
  expect(await bash($, 'git push', { cwd: '/w/other' })).toContain('other runs no CI')
  // /progress pipelines recheck forgets this repo's verdict.
  world.programs.set('git -C /w/app/sub rev-parse --show-toplevel', '/w/app\n')
  expect(await cmd($, 'pipelines recheck')).toContain("Forgot what was remembered about app's CI")
  expect(memoryOf(disk)['/w/app|']).toBeUndefined()
})

test('one commit without a pipeline never marks a repo that runs CI as "no CI"', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git', branch: 'feature' })
  const sha = 'a'.repeat(40)
  // A feature-branch push that starts no pipeline (CI runs on main only, a path filter, [skip ci]):
  // none for this commit — but the project has pipelines.
  world.gitlab.set(`projects/team%2Fapp/pipelines?sha=${sha}&per_page=100`, [])
  world.gitlab.set('projects/team%2Fapp/pipelines?per_page=1', [{ id: 900, status: 'success', ref: 'main' }])
  expect(await bash($, 'git push')).toContain('watched automatically')
  ageWatches(disk, 11)
  await world.clock.advance(16_000)
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({ noPipeline: true })
  expect(memoryOf(disk)['/w/app|']).toMatchObject({ ci: 'yes' })
  // The forge was asked once whether the project runs anything — not again every round.
  const asked = () => glabCalls(world.runs, 'projects/team%2Fapp/pipelines?per_page=1')
  expect(asked()).toBe(1)
  await world.clock.advance(10 * 60_000)
  expect(asked()).toBe(1)
  // The next push is watched like any other.
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git', branch: 'main', sha: 'b'.repeat(40) })
  const next = await bash($, 'git push')
  expect(next).toContain('watched automatically')
  expect(next).not.toContain('runs no CI')
})

test('a `watch` the agent sent — a wrong sha, say — never decides that a repo runs no CI', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk, { remote: 'git@gitlab.com:team/app.git' })
  await start($)
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git' })
  // The repo is known to run CI (a push was judged), and its project lists no pipeline at all.
  put(disk, `${DIR}/ci-memory.v1`, {
    version: 1,
    repos: {
      '/w/app|': { ci: 'yes', files: 'L---', host: 'gitlab.com', project: 'team/app', checkedAtMs: T0 },
    },
  })
  const wrong = 'f'.repeat(40)
  world.gitlab.set(`projects/team%2Fapp/pipelines?sha=${wrong}&per_page=100`, [])
  world.gitlab.set('projects/team%2Fapp/pipelines?per_page=1', [])
  await update($, { watch: [{ project: 'team/app', sha: wrong }] })
  ageWatches(disk, 11)
  await world.clock.advance(16_000)
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]?.error).toMatch(/^no pipeline for commit ffffffffffff/)
  expect(memoryOf(disk)['/w/app|']).toMatchObject({ ci: 'yes' })
  expect(glabCalls(world.runs, 'projects/team%2Fapp/pipelines?per_page=1')).toBe(0)
})

test("Claude Code's waits become Needs-you items — and go as the wait ends; the agent's own stay", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-p', description: 'Lane B', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, { now: 'n', needsYou: ['Approve the push'] })
  const auto = () => (read(disk, `${DIR}/s-me.json`).autoNeeds ?? []).map(a => a.text)
  // A permission prompt: an item, toasted like any ask, in the status line.
  await $.classic.Notification({
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Bash',
  } as never)
  expect(auto()).toEqual(['Permission: Bash'])
  // A subagent's prompt names it.
  await $.classic.Notification({
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Write',
    agent_id: 'sub-p',
  } as never)
  expect(auto()).toContain('Permission: Write (agent: Lane B)')
  // The main loop's tool ran: its item goes; the subagent's stays until its own call.
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'p1',
  } as never)
  expect(auto()).toEqual(['Permission: Write (agent: Lane B)'])
  await $.classic.PermissionDenied({
    tool_name: 'Write',
    tool_input: {},
    tool_use_id: 'p2',
    reason: 'no',
    agent_id: 'sub-p',
  } as never)
  expect(auto()).toEqual([])
  // Idle: until the next prompt.
  await $.classic.Notification({
    notification_type: 'idle_prompt',
    message: 'Claude is waiting for your input',
  } as never)
  expect(auto()).toEqual(['Turn finished — waiting for your next message'])
  await $.classic.Stop({ stop_hook_active: false } as never)
  expect(auto()).toEqual(['Turn finished — waiting for your next message'])
  await $.classic.UserPromptSubmit({ prompt: 'yes' } as never)
  expect(auto()).toEqual([])
  // The agent's own ask was never touched.
  expect(read(disk, `${DIR}/s-me.json`).needsYou).toEqual(['Approve the push'])
})

test(
  'the automatic Needs-you kinds follow their settings',
  { options: { autoNeedsPermission: 'off' } },
  async ($, on) => {
    const disk = makeDisk()
    engine(on, disk)
    await start($)
    await $.classic.Notification({ notification_type: 'permission_prompt', message: 'x' } as never)
    expect(disk.files.has(`${DIR}/s-me.json`)).toBe(false)
    await $.classic.Notification({ notification_type: 'idle_prompt', message: 'y' } as never)
    expect(read(disk, `${DIR}/s-me.json`).autoNeeds?.map(a => a.kind)).toEqual(['idle'])
  },
)

test('✕ on a step: hidden at once, skipped and counted out, the main loop told — and a later report does not bring it back', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, {
    now: 'n',
    tasks: [{ title: 'A', status: 'doing', steps: [{ title: 'one' }, { title: 'two' }] }],
  })
  const ui = await pane($)
  await ui.press({ key: 'cancel:s-me:step:t1:two' })
  expect(await texts(ui)).not.toContain('○ two')
  await world.clock.advance(UNDO_OVER)
  const task = read(disk, `${DIR}/s-me.json`).tasks[0]
  expect(task?.steps?.find(x => x.title === 'two')).toMatchObject({ status: 'skipped', removedByUser: true })
  expect(stepCounts(task as never)).toEqual({ closed: 0, total: 1 })
  const told = await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'r1',
  } as never)
  expect(ctx(told)).toContain('step "two" of "A" was removed')
  // The agent re-sends the whole list: the removed step stays removed.
  await update($, {
    tasks: [
      {
        id: 't1',
        steps: [
          { title: 'one', status: 'done' },
          { title: 'two', status: 'doing' },
        ],
      },
    ],
  })
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]?.steps?.find(x => x.title === 'two')?.status).toBe('skipped')
  await ui.unmount()
})

test("✕ on a subagent's step or the whole subagent tells THAT subagent, not the main loop; a re-sent step stays skipped", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-r', description: 'Lane R', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, { now: 'coordinating' })
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-r',
    now: 'w',
    tasks: [{ title: 'read' }, { title: 'write' }],
  } as never)
  const ui = await pane($)
  await ui.press({ key: 'cancel:s-me:agent:sub-r:t2' })
  await world.clock.advance(UNDO_OVER)
  const agent = read(disk, `${DIR}/s-me.json`).agents?.[0]
  expect(agent?.tasks.find(x => x.id === 't2')?.status).toBe('skipped')
  const call = async (agentId?: string) =>
    ctx(
      await $.classic.PostToolUse({
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
        tool_use_id: `r-${agentId ?? 'main'}`,
        ...(agentId ? { agent_id: agentId } : {}),
      } as never),
    )
  expect(await call()).not.toContain('"write" was removed')
  expect(await call('sub-r')).toContain('your step "write" was removed')
  // Its re-sent step stays skipped.
  await $.tool.call({ tool: TOOL, agentId: 'sub-r', tasks: [{ id: 't2', status: 'doing' }] } as never)
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]?.tasks.find(x => x.id === 't2')?.status).toBe('skipped')
  // The whole subagent: told to stop and wrap up.
  await ui.press({ key: 'cancel:s-me:agentall:sub-r' })
  await world.clock.advance(UNDO_OVER)
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]?.cancelledAt).toBeTruthy()
  expect(await call('sub-r')).toContain('cancelled your work')
  await ui.unmount()
})

test('a task removed in a pane stays skipped when the agent upserts it again by id or title', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { tasks: [{ title: 'Alpha' }] })
  put(disk, `${DIR}/s-me.dismissed.json`, { version: 1, sessionId: 's-me', entries: [], cancelled: ['t1'] })
  await world.clock.advance(2100)
  const answer = JSON.stringify(await update($, { tasks: [{ title: 'Alpha', status: 'doing' }] }))
  expect(answer).toContain('removed in the Progress pane and stays skipped')
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]?.status).toBe('skipped')
})

test(
  "paneScope repo: the pane lists only the sessions in this session's repo",
  { options: { paneScope: 'repo' } },
  async ($, on) => {
    const disk = makeDisk()
    engine(on, disk)
    put(disk, `${DIR}/s-same.json`, other('s-same', 'app', T0, { now: 'same repo' }))
    put(disk, `${DIR}/s-else.json`, other('s-else', 'elsewhere', T0, { now: 'other repo' }))
    await start($)
    await update($, { now: 'mine' })
    const ui = await pane($)
    const shown = (await texts(ui)).join('\n')
    expect(shown).toContain('same repo')
    expect(shown).not.toContain('other repo')
    await ui.unmount()
  },
)

test('a watched pipeline that finishes failed is toasted (failures only, the default); a success is not', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk, { remote: 'git@gitlab.com:team/app.git' })
  await start($)
  world.gitlab.set('projects/team%2Fapp/pipelines/41', {
    id: 41,
    status: 'running',
    ref: 'main',
    web_url: 'u',
  })
  world.gitlab.set('projects/team%2Fapp/pipelines/41/jobs?per_page=100', [])
  world.gitlab.set('projects/team%2Fapp/pipelines/42', {
    id: 42,
    status: 'running',
    ref: 'main',
    web_url: 'u',
  })
  world.gitlab.set('projects/team%2Fapp/pipelines/42/jobs?per_page=100', [])
  await update($, {
    watch: [
      { project: 'team/app', pipeline: 41, label: 'red' },
      { project: 'team/app', pipeline: 42, label: 'green' },
    ],
  })
  world.gitlab.set('projects/team%2Fapp/pipelines/41', {
    id: 41,
    status: 'failed',
    ref: 'main',
    web_url: 'u',
  })
  world.gitlab.set('projects/team%2Fapp/pipelines/42', {
    id: 42,
    status: 'success',
    ref: 'main',
    web_url: 'u',
  })
  await world.clock.advance(15_100)
  expect(world.toasts).toContain('Pipeline red failed')
  expect(world.toasts.some(x => x.includes('green'))).toBe(false)
})

test("the Settings view: this session's switches with reset, defaults cycled or typed into the plugin's own config", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  const rows = [
    {
      key: 'progress-panel.palette',
      label: 'Colours',
      kind: 'choice',
      value: 'default',
      options: ['default', 'colorblind', 'none'],
      provider: { kind: 'plugin' },
    },
    {
      key: 'progress-panel.progressDir',
      label: 'Progress folder',
      kind: 'text',
      value: '',
      provider: { kind: 'plugin' },
    },
    {
      key: 'theme',
      label: 'Theme',
      kind: 'choice',
      value: 'dark',
      options: ['dark', 'light'],
      provider: { kind: 'engine' },
    },
  ]
  const sets: { key: string; value: unknown }[] = []
  on('config.list', () => ({ value: rows }) as never)
  on('config.set', (_, e) => {
    sets.push({ key: e.key, value: e.value })
    if (e.key === 'progress-panel.progressDir' && e.value === '/forbidden')
      return { deny: 'not allowed' } as never
    const row = rows.find(r => r.key === e.key)
    if (row) row.value = e.value as string
    return { value: e.value } as never
  })
  await start($)
  await update($, { now: 'n' })
  const ui = await pane($)
  await ui.press({ key: 'settings:open' })
  const shown = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label ?? b.text ?? ''))
  expect(shown).toContain('reporting: on (default)')
  expect(shown).toContain('Colours: default')
  // Only this plugin's rows.
  expect(shown.some(x => x.startsWith('Theme'))).toBe(false)
  // A switch of this session: changed, then reset to its default.
  await ui.press({ key: 'setting:session:pipelines' })
  expect((await ui.find({ type: 'Button', key: 'setting:session:pipelines' }))?.props.label).toBe(
    'pipelines: off (this session)',
  )
  await ui.press({ key: 'setting:reset:pipelines' })
  expect((await ui.find({ type: 'Button', key: 'setting:session:pipelines' }))?.props.label).toBe(
    'pipelines: on (default)',
  )
  // A choice cycles through its options, wrapping round.
  await ui.press({ key: 'setting:progress-panel.palette' })
  await ui.press({ key: 'setting:progress-panel.palette' })
  await ui.press({ key: 'setting:progress-panel.palette' })
  expect(sets.map(x => x.value)).toEqual(['colorblind', 'none', 'default'])
  // A text field: typed and submitted; a refusal is shown.
  await ui.input({ key: 'setting:input:progress-panel.progressDir', text: '~/status', kind: 'submit' })
  expect(sets.at(-1)).toEqual({ key: 'progress-panel.progressDir', value: '~/status' })
  await ui.input({ key: 'setting:input:progress-panel.progressDir', text: '/forbidden', kind: 'submit' })
  expect(world.toasts).toContain('Setting not changed: not allowed')
  await ui.press({ key: 'settings:back' })
  expect(await ui.find({ type: 'Button', key: 'settings:back' })).toBeUndefined()
  await ui.unmount()
  // /progress settings opens it too.
  expect(await cmd($, 'settings')).toContain('Settings opened')
})

test('a task linked to a subagent shows its live progress; its finish is told to the coordinator once, never marked done for it', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-l', description: 'Lane L', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, {
    now: 'coordinating',
    tasks: [{ title: 'Port the parser', status: 'doing', agent: 'Lane L' }],
  })
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-l',
    now: 'w',
    tasks: [{ title: 'a', status: 'done' }, { title: 'b' }],
  } as never)
  const ui = await pane($)
  expect((await texts(ui)).some(x => x.startsWith('● Lane L 1/2'))).toBe(true)
  await ui.unmount()
  // The agent stops: the coordinator is told — in its next answer, once — and the task stays open.
  await $.classic.SubagentStop({
    agent_id: 'sub-l',
    agent_type: 'general-purpose',
    stop_hook_active: false,
    agent_transcript_path: '/t',
  } as never)
  const answer = JSON.stringify(await update($, { now: 'checking' }))
  expect(answer).toContain('agent \\"Lane L\\" finished')
  expect(JSON.stringify(await update($, { now: 'still' }))).not.toContain('finished')
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]?.status).toBe('doing')
})

test('an Agent call auto-links the one doing task its description names — never an ambiguous one', async ($, on) => {
  on('tool.call', { tool: 'Agent' }, () => ({ result: {} }) as never)
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, {
    tasks: [
      { title: 'Lint fixes', status: 'doing' },
      { title: 'Docs pass', status: 'doing' },
      { title: 'Docs pass extra', status: 'doing' },
    ],
  })
  await $.tool.call({ tool: 'Agent', description: 'Lint fixes', prompt: 'p' } as never)
  await $.tool.call({ tool: 'Agent', description: 'Docs pass', prompt: 'p' } as never)
  const tasks = read(disk, `${DIR}/s-me.json`).tasks
  expect(tasks.find(x => x.title === 'Lint fixes')?.agent).toBe('Lint fixes')
  // "Docs pass" names two doing tasks: nothing linked.
  expect(tasks.filter(x => x.title.startsWith('Docs')).every(x => !x.agent)).toBe(true)
})

test('a subagent that stopped and was resumed is running again; one that only stopped stays finished', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-z', description: 'Lane Z', type: 'general-purpose', status: 'running' })
  world.agents.push({ id: 'sub-y', description: 'Lane Y', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, { now: 'coordinating' })
  const report = (agentId: string) =>
    $.tool.call({
      tool: TOOL,
      agentId,
      now: 'w',
      tasks: [{ title: 'one', status: 'done' }, { title: 'two' }],
    } as never)
  await report('sub-z')
  await report('sub-y')
  const stop = (agent_id: string, extra: object = {}) =>
    $.classic.SubagentStop({
      agent_id,
      agent_type: 'general-purpose',
      stop_hook_active: false,
      agent_transcript_path: '/t',
      ...extra,
    } as never)
  await stop('sub-z')
  await stop('sub-y')
  // The list keeps saying "completed" for both (a resumed run's old status).
  world.agents.splice(
    0,
    world.agents.length,
    { id: 'sub-z', description: 'Lane Z', type: 'general-purpose', status: 'completed' },
    { id: 'sub-y', description: 'Lane Y', type: 'general-purpose', status: 'completed' },
  )
  const entry = (id: string) => read(disk, `${DIR}/s-me.json`).agents?.find(a => a.id === id)
  // Z is resumed: its next report (or tool call) reopens it, steps kept — and the 2 s sync leaves it.
  await $.tool.call({ tool: TOOL, agentId: 'sub-z', now: 'resumed' } as never)
  expect(entry('sub-z')?.endedAt).toBeNull()
  expect(entry('sub-z')?.tasks).toHaveLength(2)
  await world.clock.advance(2100)
  expect(entry('sub-z')?.endedAt).toBeNull()
  // Y did nothing more: still finished.
  expect(entry('sub-y')?.endedAt).not.toBeNull()
  // A tool call alone reopens too; its next stop ends it again.
  await stop('sub-z')
  expect(entry('sub-z')?.endedAt).not.toBeNull()
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'z1',
    agent_id: 'sub-z',
  } as never)
  expect(entry('sub-z')?.endedAt).toBeNull()
  // The session's OTHER background work (the coordinator's watchers) listed at its stop: not its —
  // the agent ended, never "waiting" on someone else's commands.
  const watcher = {
    id: 'coord-1',
    type: 'shell',
    status: 'running',
    description: '',
    command: 'P=KirboDev%2Fx; for i in $(seq 1 120); do\n  glab api x\ndone',
  }
  await stop('sub-z', { background_tasks: [watcher] })
  expect(entry('sub-z')?.endedAt).not.toBeNull()
  expect(entry('sub-z')?.waiting).toBeUndefined()
  // Its OWN backgrounded command (its Bash call's result named the task): a stop waits on it.
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: { command: 'cargo nextest run', run_in_background: true },
    tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'own-1' },
    tool_use_id: 'z2',
    agent_id: 'sub-z',
  } as never)
  await stop('sub-z', {
    background_tasks: [
      watcher,
      {
        id: 'own-1',
        type: 'shell',
        status: 'running',
        description: '',
        command: 'cd /w && FOO=1 cargo nextest run --workspace',
      },
    ],
  })
  expect(entry('sub-z')).toMatchObject({ endedAt: null, waiting: true, waitingOn: 'cargo nextest' })
  const ui = await pane($)
  const lines = await texts(ui)
  expect(lines.some(x => x.includes('waiting on background work'))).toBe(true)
  // One short line: never the coordinator's command, never a whole script.
  const waitLine = lines.find(x => x.startsWith('waiting on:'))
  expect(waitLine).toBe('waiting on: cargo nextest (background)')
  expect(lines.some(x => x.includes('glab api') || x.includes('seq 1 120'))).toBe(false)
  expect((await ui.find({ type: 'Text', text: 'waiting on: cargo nextest (background)' }))?.props.wrap).toBe(
    'truncate-end',
  )
  await ui.unmount()
})

async function runningPipeline(world: ReturnType<typeof engine>, $: $Test, provider?: 'github') {
  if (provider === 'github') {
    world.github.set('repos/owner/app/actions/runs/77', {
      id: 77,
      status: 'in_progress',
      head_branch: 'main',
      html_url: 'u',
    })
    world.github.set('repos/owner/app/actions/runs/77/jobs?per_page=100', { jobs: [] })
    world.github.set('repos/owner/app/actions/runs/77/cancel', {})
    await update($, { watch: [{ provider: 'github', project: 'owner/app', run: 77 }] })
    return 'gh:owner/app#77'
  }
  world.gitlab.set('projects/team%2Fapp/pipelines/41', {
    id: 41,
    status: 'running',
    ref: 'main',
    web_url: 'u',
  })
  // One job: a pipeline with none to show is a plain line, and these tests press its row.
  world.gitlab.set('projects/team%2Fapp/pipelines/41/jobs?per_page=100', jobsOf(['lint', 'running']))
  world.gitlab.set('projects/team%2Fapp/pipelines/41/cancel', {})
  await update($, { watch: [{ project: 'team/app', pipeline: 41 }] })
  return 'team/app#41'
}

const calls = (world: ReturnType<typeof engine>, method: string) =>
  world.runs.filter(r => r.includes('-X') && r[r.indexOf('-X') + 1] === method).map(r => r[r.length - 1])

test('⊘ stop on a running pipeline: the first press only asks; the second cancels and deletes it, and the row goes', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  const key = await runningPipeline(world, $)
  const ui = await pane($)
  const x = `cancelpipe:s-me:${key}`
  await ui.press({ key: x })
  expect((await ui.find({ type: 'Button', key: x }))?.text).toBe(' ⊘ cancel + delete? ')
  expect(calls(world, 'POST')).toEqual([])
  // Too late: the confirm expired, the next press only asks again.
  await world.clock.advance(6000)
  await ui.press({ key: x })
  expect(calls(world, 'POST')).toEqual([])
  await ui.press({ key: x })
  expect(calls(world, 'POST')).toEqual(['projects/team%2Fapp/pipelines/41/cancel'])
  expect(calls(world, 'DELETE')).toEqual(['projects/team%2Fapp/pipelines/41'])
  expect(read(disk, `${DIR}/s-me.json`).pipelines ?? []).toEqual([])
  await ui.unmount()
})

test('a delete the forge refuses (403) keeps it cancelled and says so on its row; GitHub runs cancel and delete too', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  const key = await runningPipeline(world, $)
  world.failures.set('projects/team%2Fapp/pipelines/41', {
    exitCode: 1,
    stdout: '',
    stderr: 'glab: 403 Forbidden',
  })
  const ui = await pane($)
  await ui.press({ key: `cancelpipe:s-me:${key}` })
  await ui.press({ key: `cancelpipe:s-me:${key}` })
  const row = read(disk, `${DIR}/s-me.json`).pipelines?.[0]
  expect(row?.state).toBe('canceled')
  expect(row?.error).toContain('Cancelled, but not deleted (deleting needs the Maintainer/Owner role)')
  world.failures.delete('projects/team%2Fapp/pipelines/41')
  const gh = await runningPipeline(world, $, 'github')
  await ui.press({ key: `cancelpipe:s-me:${gh}` })
  await ui.press({ key: `cancelpipe:s-me:${gh}` })
  expect(calls(world, 'POST')).toContain('repos/owner/app/actions/runs/77/cancel')
  expect(calls(world, 'DELETE')).toContain('repos/owner/app/actions/runs/77')
  await ui.unmount()
})

test(
  'the ⊘ stop button setting (runningPipelineX) cancel: only cancels — the ✕ beside it stays a plain hide',
  { options: { runningPipelineX: 'cancel' } },
  async ($, on) => {
    const disk = makeDisk()
    const world = engine(on, disk)
    await start($)
    const key = await runningPipeline(world, $)
    const ui = await pane($)
    await ui.press({ key: `cancelpipe:s-me:${key}` })
    expect((await ui.find({ type: 'Button', key: `cancelpipe:s-me:${key}` }))?.text).toBe(' ⊘ cancel? ')
    expect((await ui.find({ type: 'Button', key: `hidepipe:s-me:${key}` }))?.text).toBe('  ✕  ')
    await ui.press({ key: `cancelpipe:s-me:${key}` })
    expect(calls(world, 'POST')).toEqual(['projects/team%2Fapp/pipelines/41/cancel'])
    expect(calls(world, 'DELETE')).toEqual([])
    await ui.unmount()
  },
)

test(
  'the ⊘ stop button setting off: no ⊘ on a running pipeline — its ✕ still hides it',
  { options: { runningPipelineX: 'off' } },
  async ($, on) => {
    const disk = makeDisk()
    const world = engine(on, disk)
    await start($)
    const key = await runningPipeline(world, $)
    const ui = await pane($)
    expect(await ui.find({ type: 'Button', key: `cancelpipe:s-me:${key}` })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: `hidepipe:s-me:${key}` })).toBeDefined()
    await ui.unmount()
  },
)

test('✕ on a running pipeline only hides it: no call reaches the CI, and it stops being watched', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  const key = await runningPipeline(world, $)
  const ui = await pane($)
  // The default (delete) setting: the ⊘ button is there, and red — but ✕ is a different button.
  expect((await ui.find({ type: 'Button', key: `cancelpipe:s-me:${key}` }))?.text).toBe(' ⊘ stop ')
  await ui.press({ key: `hidepipe:s-me:${key}` })
  // Gone from the pane at once…
  expect(await ui.find({ type: 'Button', key: `pipe:s-me:${key}` })).toBeUndefined()
  // …and no longer watched once the press can no longer be taken back.
  await world.clock.advance(UNDO_OVER)
  expect(calls(world, 'POST')).toEqual([])
  expect(calls(world, 'DELETE')).toEqual([])
  expect(read(disk, `${DIR}/s-me.json`).pipelines ?? []).toEqual([])
  // Watching it again later is a new watch: it shows.
  await watch($, world, { watch: [{ project: 'team/app', pipeline: 41 }] })
  expect(await ui.find({ type: 'Button', key: `pipe:s-me:${key}` })).toBeDefined()
  await world.clock.advance(2100)
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.map(p => p.key)).toEqual([key])
  await ui.unmount()
})

test("another session's running pipeline hidden with ✕ stays hidden in the panes, and its CI is untouched", async ($, on) => {
  const disk = makeDisk()
  const iso = new Date(T0).toISOString()
  put(disk, `${DIR}/s-other.json`, {
    ...other('s-other', 'site', T0, { now: 'pushing' }),
    pipelines: [
      {
        key: 'team/app#9',
        project: 'team/app',
        id: 9,
        label: 'app main',
        state: 'running',
        jobs: [],
        addedAt: iso,
        checkedAt: iso,
      },
    ],
  })
  const world = engine(on, disk)
  await start($)
  const ui = await pane($)
  await ui.press({ key: 'hidepipe:s-other:team/app#9' })
  expect(calls(world, 'POST')).toEqual([])
  // Named by that watch (when it was added), so the same pipeline watched again later shows.
  expect(sidecar(disk, 's-other')).toContainEqual({
    id: 'pipeline:team/app#9',
    doneAt: `added:${iso}`,
    at: iso,
  })
  expect(await ui.find({ type: 'Button', key: 'pipe:s-other:team/app#9' })).toBeUndefined()
  await ui.unmount()
})

test("a linked task's steps are its agent's: steps sent to it are dropped with a note, and the pane shows the agent's", async ($, on) => {
  const disk = makeDisk()
  engine(on, disk).agents.push({
    id: 'sub-d',
    description: 'Lane D',
    type: 'general-purpose',
    status: 'running',
  })
  await start($)
  await update($, { tasks: [{ title: 'Port it', status: 'doing', agent: 'Lane D' }] })
  const answer = JSON.stringify(await update($, { tasks: [{ id: 't1', steps: [{ title: 'copied' }] }] }))
  expect(answer).toContain('linked to agent')
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]?.steps).toBeUndefined()
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-d',
    now: 'w',
    tasks: [{ title: 'own step', status: 'done' }, { title: 'next' }],
  } as never)
  const ui = await pane($)
  expect((await ui.find({ type: 'Button', key: 'task:s-me:t1' }))?.text).toContain('Port it')
  await ui.press({ key: 'task:s-me:t1' })
  const shown = (await texts(ui)).join('\n')
  expect(shown).toContain('own step')
  expect(shown).not.toContain('copied')
  await ui.unmount()
})

test('an agent on no task: the coordinator is told, a stand-in task appears on its first report, a real link replaces it; never done for it', async ($, on) => {
  on('tool.call', { tool: 'Agent' }, () => ({ result: {} }) as never)
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-u', description: 'Lane U', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, { now: 'coordinating', tasks: [{ title: 'Unrelated', status: 'doing' }] })
  await $.tool.call({ tool: 'Agent', description: 'Lane U', prompt: 'p' } as never)
  expect(JSON.stringify(await update($, { now: 'n' }))).toContain('agent \\"Lane U\\" works on no task')
  await $.tool.call({ tool: TOOL, agentId: 'sub-u', now: 'w', tasks: [{ title: 'x' }] } as never)
  const stand = read(disk, `${DIR}/s-me.json`).tasks.find(x => x.auto)
  expect(stand).toMatchObject({ title: '↳ Lane U', status: 'doing', agent: 'Lane U' })
  // The coordinator links its own task: the stand-in goes.
  await update($, { tasks: [{ title: 'Real work', status: 'doing', agent: 'Lane U' }] })
  expect(read(disk, `${DIR}/s-me.json`).tasks.some(x => x.auto)).toBe(false)
})

const stopAgent = ($: $Test, id: string) =>
  $.classic.SubagentStop({
    agent_id: id,
    agent_type: 'general-purpose',
    stop_hook_active: false,
    agent_transcript_path: '/t',
  } as never)

test('a stand-in task lives only while its agent works: gone when the agent ends, and nobody is asked to close it', async ($, on) => {
  on('tool.call', { tool: 'Agent' }, () => ({ result: {} }) as never)
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-u', description: 'Lane U', type: 'general-purpose', status: 'running' })
  await start($)
  // A session with no task that could be the agent's: nothing to link, so no note about linking.
  await update($, { now: 'coordinating' })
  await $.tool.call({ tool: 'Agent', description: 'Lane U', prompt: 'p' } as never)
  expect(JSON.stringify(await update($, { now: 'n' }))).not.toContain('works on no task')
  await $.tool.call({ tool: TOOL, agentId: 'sub-u', now: 'w', tasks: [{ title: 'x' }] } as never)
  expect(read(disk, `${DIR}/s-me.json`).tasks.map(x => x.title)).toEqual(['↳ Lane U'])
  // While it runs, the stand-in is never what an end-of-turn check or a stale nudge asks about.
  await world.clock.advance(30 * 60_000)
  const prompted = (await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)) as {
    additionalContext?: string[]
  }
  expect((prompted.additionalContext ?? []).join('\n')).not.toContain('Lane U')
  // It stops: the stand-in goes with it (the agent itself is listed under Done → Agents), and the
  // coordinator is told nothing about a task it never made.
  await stopAgent($, 'sub-u')
  const after = read(disk, `${DIR}/s-me.json`)
  expect(after.tasks).toEqual([])
  expect(after.agents?.[0]?.endedAt).not.toBeNull()
  const answer = JSON.stringify(await update($, { now: 'next' }))
  expect(answer).not.toContain('Lane U')
  const stopped = (await $.classic.Stop({ stop_hook_active: false } as never)) as { block?: string }
  expect(stopped.block).toBeUndefined()
})

test('a stand-in left behind by an agent that already ended is cleared by the next scan', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  const at = new Date(T0).toISOString()
  const old = other('s-me', 'app', T0, { now: 'coordinating', tasks: [{ title: 'Mine', status: 'doing' }] })
  put(disk, `${DIR}/s-me.json`, {
    ...old,
    seq: 2,
    tasks: [
      ...old.tasks,
      {
        id: 't2',
        title: '↳ Lane X',
        status: 'doing',
        agent: 'Lane X',
        auto: true,
        createdAt: at,
        updatedAt: at,
        doneAt: null,
      },
    ],
    agents: [
      {
        id: 'sub-x',
        label: 'Lane X',
        now: null,
        tasks: [],
        seq: 0,
        startedAt: at,
        updatedAt: at,
        endedAt: at,
      },
    ],
  })
  await start($)
  await world.clock.advance(2100)
  expect(read(disk, `${DIR}/s-me.json`).tasks.map(x => x.title)).toEqual(['Mine'])
})

test('a message sent to a running agent shows on its row as queued until the agent picks it up', async ($, on) => {
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: {} }) as never)
  const disk = makeDisk()
  engine(on, disk).agents.push({
    id: 'sub-q',
    description: 'Lane Q',
    type: 'general-purpose',
    status: 'running',
  })
  await start($)
  await update($, { now: 'coordinating' })
  await $.tool.call({ tool: TOOL, agentId: 'sub-q', now: 'w', tasks: [{ title: 'a' }] } as never)
  await $.tool.call({
    tool: 'SendMessage',
    to: 'sub-q',
    summary: 'also fix the docs',
    message: 'long text',
  } as never)
  const entry = () => read(disk, `${DIR}/s-me.json`).agents?.find(a => a.id === 'sub-q')
  expect(entry()?.queued).toEqual(['also fix the docs'])
  const ui = await pane($)
  expect((await texts(ui)).some(x => x.includes('queued: also fix the docs'))).toBe(true)
  await ui.unmount()
  // Its next tool call picks it up.
  await $.classic.PostToolUse({
    tool_name: 'Read',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'q2',
    agent_id: 'sub-q',
  } as never)
  expect(entry()?.queued).toBeUndefined()
})

async function linkedLane($: $Test, on: On) {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-k', description: 'Lane K', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, {
    now: 'coordinating',
    tasks: [{ title: 'Port the parser', status: 'doing', agent: 'Lane K' }],
  })
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-k',
    now: 'w',
    tasks: [{ title: 'read' }, { title: 'write' }],
  } as never)
  const main = async () =>
    ctx(
      await $.classic.PostToolUse({
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
        tool_use_id: `m-${Math.random()}`,
      } as never),
    )
  const sub = async () =>
    ctx(
      await $.classic.PostToolUse({
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
        tool_use_id: `s-${Math.random()}`,
        agent_id: 'sub-k',
      } as never),
    )
  return { disk, world, main, sub }
}

test('✕ on a session task linked to a running agent stops that agent too; the coordinator is told so', async ($, on) => {
  const { disk, world, main, sub } = await linkedLane($, on)
  put(disk, `${DIR}/s-me.dismissed.json`, { version: 1, sessionId: 's-me', entries: [], cancelled: ['t1'] })
  await world.clock.advance(2100)
  const file = read(disk, `${DIR}/s-me.json`)
  expect(file.tasks[0]?.status).toBe('skipped')
  expect(file.agents?.[0]?.cancelledAt).toBeTruthy()
  const told = await main()
  expect(told).toContain('t1 "Port the parser"')
  expect(told).toContain('("Lane K") was told to stop too')
  expect(await sub()).toContain('cancelled your work')
})

test("✕ on a whole agent leaves its linked task unassigned — told, shown, not skipped; one of its steps stays the agent's business", async ($, on) => {
  const { disk, world, main } = await linkedLane($, on)
  // One of its two steps: only the agent hears of it.
  put(disk, `${DIR}/s-me.dismissed.json`, {
    version: 1,
    sessionId: 's-me',
    entries: [],
    cancelled: ['agent:sub-k:t1'],
  })
  await world.clock.advance(2100)
  expect(await main()).not.toContain('unassigned')
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]?.status).toBe('doing')
  // The whole agent: the coordinator is told its task has no worker; the task stays open.
  put(disk, `${DIR}/s-me.dismissed.json`, {
    version: 1,
    sessionId: 's-me',
    entries: [],
    cancelled: ['agent:sub-k:t1', 'agentall:sub-k'],
  })
  await world.clock.advance(2100)
  expect(await main()).toContain('task "Port the parser" is unassigned: re-plan or skip it')
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]?.status).toBe('doing')
  const ui = await pane($)
  expect((await texts(ui)).some(x => x.includes('Lane K stopped in the Progress pane'))).toBe(true)
  await ui.unmount()
})

test("✕ on an agent's last open step leaves its linked task unassigned too", async ($, on) => {
  const { disk, world, main } = await linkedLane($, on)
  put(disk, `${DIR}/s-me.dismissed.json`, {
    version: 1,
    sessionId: 's-me',
    entries: [],
    cancelled: ['agent:sub-k:t1', 'agent:sub-k:t2'],
  })
  await world.clock.advance(2100)
  expect(await main()).toContain('is unassigned')
})

test('a session whose system prompt carried the rule gets no second copy, only the reminder until it reports', async ($, on) => {
  engine(on, makeDisk())
  await start($)
  await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash', TOOL],
    outputStyle: null,
    traits: ['skills'],
  })
  const context = async () =>
    ((await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)) as { additionalContext?: string[] })
      .additionalContext ?? []
  const first = await context()
  expect(first).toHaveLength(1)
  expect(first[0]).not.toContain('# Progress pane')
  await update($, { now: 'Fixing it', tasks: [{ title: 'Fix' }] })
  expect(await context()).toEqual([])
})

// A repo the fake git answers for: `git -C <where> …` as the auto-watch asks it.
function gitRepo(
  world: ReturnType<typeof engine>,
  where: string,
  repo: {
    root?: string
    remote?: string
    url: string
    branch?: string
    sha?: string
    tracking?: string | null
    upstream?: string | null
  },
) {
  const sha = repo.sha ?? 'a'.repeat(40)
  const branch = repo.branch ?? 'main'
  const remote = repo.remote ?? 'origin'
  const g = (...args: string[]) => ['git', '-C', where, ...args].join(' ')
  world.programs.set(g('rev-parse', '--show-toplevel'), `${repo.root ?? where}\n`)
  if (repo.upstream !== null)
    world.programs.set(
      g('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'),
      `${repo.upstream ?? `${remote}/${branch}`}\n`,
    )
  world.programs.set(g('remote', 'get-url', remote), `${repo.url}\n`)
  world.programs.set(g('rev-parse', '--verify', '--quiet', 'HEAD^{commit}'), `${sha}\n`)
  world.programs.set(g('rev-parse', '--verify', '--quiet', `${branch}^{commit}`), `${sha}\n`)
  world.programs.set(g('rev-parse', '--abbrev-ref', 'HEAD'), `${branch}\n`)
  if (repo.tracking !== null)
    world.programs.set(
      g('rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`),
      `${repo.tracking ?? sha}\n`,
    )
}

function ciFile(disk: Disk, path: string) {
  disk.tick += 1
  disk.files.set(path, { text: 'ci', mtimeMs: disk.tick })
}

async function bash($: $Test, command: string, extra: Record<string, unknown> = {}) {
  const result = (await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: '', stderr: '' },
    tool_use_id: `b-${command.length}`,
    cwd: '/w/app',
    ...extra,
  } as never)) as { additionalContext?: string[] }
  return (result.additionalContext ?? []).join(' ')
}

const keys = (disk: Disk) => (read(disk, `${DIR}/s-me.json`).pipelines ?? []).map(p => p.key)

test('a push to a GitLab repo is watched by its sha on its own — host and project off the ssh remote', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git' })
  const note = await bash($, 'pnpm lint && git push')
  const sha = 'a'.repeat(40)
  // The key names the commit AND the ref it landed on.
  expect(keys(disk)).toEqual([`team/app@${sha}:main`])
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.[0]).toMatchObject({
    label: 'app main',
    sha,
    watchRef: 'main',
    pushed: true,
  })
  expect(note).toContain(`team/app@${sha}:main`)
  expect(note).toMatch(/no `watch` call needed/)
})

test('GitHub Actions over https, a self-hosted GitLab and a Forgejo repo: each on its own forge and host', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  ciFile(disk, '/w/gh/.github/workflows/ci.yml')
  gitRepo(world, '/w/gh', { url: 'https://github.com/Owner/Repo.git', sha: 'b'.repeat(40) })
  ciFile(disk, '/w/gl/.gitlab-ci.yml')
  gitRepo(world, '/w/gl', { url: 'https://git.example.com/team/app.git', sha: 'c'.repeat(40) })
  ciFile(disk, '/w/fj/.forgejo/workflows/build.yaml')
  gitRepo(world, '/w/fj', { url: 'ssh://git@forge.example.org:2222/team/svc.git', sha: 'd'.repeat(40) })
  await bash($, 'git -C /w/gh push')
  await bash($, 'cd /w/gl && git push')
  await bash($, 'git push', { cwd: '/w/fj' })
  expect(keys(disk)).toEqual([
    `gh:Owner/Repo@${'b'.repeat(40)}:main`,
    `git.example.com/team/app@${'c'.repeat(40)}:main`,
    `gt:forge.example.org/team/svc@${'d'.repeat(40)}:main`,
  ])
})

test('-C and cd are resolved against where the command ran; the named refspec is the pushed branch', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  ciFile(disk, '/w/other/.gitlab-ci.yml')
  gitRepo(world, '/w/other', { url: 'git@gitlab.com:team/other.git', branch: 'next', upstream: null })
  // HEAD:next lands on `next`; the tracking ref checked is origin/next.
  await bash($, 'git -C ../other push origin HEAD:next')
  expect(read(disk, `${DIR}/s-me.json`).pipelines?.map(p => [p.key, p.label])).toEqual([
    [`team/other@${'a'.repeat(40)}:next`, 'other next'],
  ])
})

test('a failed, rejected or dry-run push, a delete and a repo without CI watch nothing', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git' })
  expect(await bash($, 'git push', { tool_response: { exitCode: 1 } })).toBe('')
  expect(await bash($, 'git push', { tool_response: { interrupted: true } })).toBe('')
  await bash($, 'git push --dry-run')
  await bash($, 'git push origin --delete old')
  // Rejected: the remote-tracking ref is not the pushed sha.
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git', tracking: 'f'.repeat(40) })
  await bash($, 'git push')
  // No CI files and no custom command: nothing to watch.
  gitRepo(world, '/w/plain', { url: 'git@gitlab.com:team/plain.git' })
  await bash($, 'git push', { cwd: '/w/plain' })
  // An unknown remote host (an ssh alias) names no forge either.
  ciFile(disk, '/w/alias/.gitlab-ci.yml')
  gitRepo(world, '/w/alias', { url: 'work:team/app.git' })
  await bash($, 'git push', { cwd: '/w/alias' })
  // A GitLab-CI repo pushed to its GitHub mirror: GitHub runs none of it.
  ciFile(disk, '/w/mirrored/.gitlab-ci.yml')
  gitRepo(world, '/w/mirrored', { url: 'git@github.com:owner/app.git', remote: 'mirror', upstream: null })
  await bash($, 'git push mirror main', { cwd: '/w/mirrored' })
  // Nothing watched, so nothing was ever written.
  expect(disk.files.has(`${DIR}/s-me.json`)).toBe(false)
})

test("a push the agent also watches by hand is one row; a subagent's push is watched on its session", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk, { remote: 'git@gitlab.com:team/app.git' })
  await start($)
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git' })
  const sha = 'a'.repeat(40)
  await update($, { watch: [{ project: 'team/app', sha }] })
  expect(await bash($, 'git push')).not.toContain('watched automatically')
  expect(keys(disk)).toEqual([`team/app@${sha}`])

  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git', sha: 'e'.repeat(40) })
  const note = await bash($, 'git push', { agent_id: 'sub-push' })
  expect(keys(disk)).toEqual([`team/app@${sha}`, `team/app@${'e'.repeat(40)}:main`])
  // The other way round: a commit a push already watches is not watched again whole.
  await update($, { watch: [{ project: 'team/app', sha: 'e'.repeat(40) }] })
  expect(keys(disk)).toHaveLength(2)
  expect(note).toContain('watched automatically')
})

test("the same commit pushed to a second branch, or tagged, gets its own row with that ref's pipeline", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  const sha = 'a'.repeat(40)
  const list = `projects/team%2Fapp/pipelines?sha=${sha}&per_page=100`
  const jobs = (id: number) => `projects/team%2Fapp/pipelines/${id}/jobs?per_page=100`
  // Pushed to `next`: its pipeline runs and passes.
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git', branch: 'next' })
  world.gitlab.set(list, [{ id: 61, status: 'success', ref: 'next' }])
  world.gitlab.set(jobs(61), jobsOf(['test', 'success']))
  expect(await bash($, 'git push origin next 2>&1')).toContain(`team/app@${sha}:next`)
  await world.clock.advance(16_000)
  const rows = () =>
    (read(disk, `${DIR}/s-me.json`).pipelines ?? []).map(p => [p.key, p.id, p.state, p.label])
  expect(rows()).toEqual([[`team/app@${sha}:next`, 61, 'success', 'app next']])

  // `main` fast-forwarded to the very same commit: a second pipeline, on `main` — its own row.
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git', branch: 'main' })
  world.gitlab.set(list, [
    { id: 62, status: 'running', ref: 'main' },
    { id: 61, status: 'success', ref: 'next' },
  ])
  world.gitlab.set(jobs(62), jobsOf(['test', 'running']))
  const note = await bash($, 'git push origin main')
  expect(note).toContain(`team/app@${sha}:main`)
  await world.clock.advance(16_000)
  expect(rows()).toEqual([
    [`team/app@${sha}:next`, 61, 'success', 'app next'],
    [`team/app@${sha}:main`, 62, 'running', 'app main'],
  ])

  // A tag on that commit, and two refs in one push: each ref is a watch of its own.
  world.programs.set(`git -C /w/app rev-parse --verify --quiet v1.0.0^{commit}`, `${sha}\n`)
  await bash($, 'git push origin v1.0.0')
  expect(keys(disk)).toEqual([`team/app@${sha}:next`, `team/app@${sha}:main`, `team/app@${sha}:v1.0.0`])
  gitRepo(world, '/w/two', { url: 'git@gitlab.com:team/two.git', branch: 'next', sha: 'b'.repeat(40) })
  gitRepo(world, '/w/two', { url: 'git@gitlab.com:team/two.git', branch: 'main', sha: 'b'.repeat(40) })
  ciFile(disk, '/w/two/.gitlab-ci.yml')
  await bash($, 'git push origin next main', { cwd: '/w/two' })
  expect(keys(disk).slice(3)).toEqual([`team/two@${'b'.repeat(40)}:next`, `team/two@${'b'.repeat(40)}:main`])
})

test('a commit with several workflow runs is one row: green only when ALL are, and its task closes on that', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  const sha = 'c'.repeat(40)
  const REPO = 'repos/o/r'
  const run = (id: number, name: string, status: string, conclusion: string | null) => ({
    id,
    name,
    status,
    conclusion,
    head_branch: 'main',
    head_sha: sha,
    event: 'push',
    html_url: `https://github.com/o/r/actions/runs/${id}`,
  })
  const ghJobs = (...jobs: [string, string, string | null][]) => ({
    jobs: jobs.map(([name, status, conclusion], i) => ({ id: i + 1, name, status, conclusion })),
  })
  const list = `${REPO}/actions/runs?head_sha=${sha}&per_page=100`
  // The labeler is done in seconds; the real CI still runs.
  world.github.set(list, {
    workflow_runs: [run(12, 'CI', 'in_progress', null), run(11, 'Labeler', 'completed', 'success')],
  })
  world.github.set(`${REPO}/actions/runs/12/jobs?per_page=100`, ghJobs(['unit', 'in_progress', null]))
  world.github.set(`${REPO}/actions/runs/11/jobs?per_page=100`, ghJobs(['label', 'completed', 'success']))
  const key = `gh:o/r@${sha}`
  await update($, {
    watch: [{ provider: 'github', project: 'o/r', sha }],
    tasks: [{ id: 'ship', title: 'Ship', status: 'doing', pipeline: key }],
  })
  await world.clock.advance(16_000)
  const row = () => read(disk, `${DIR}/s-me.json`).pipelines?.[0]
  const task = () => read(disk, `${DIR}/s-me.json`).tasks[0]
  // One row for the commit: still running, both runs' jobs under their workflow's name.
  expect(row()).toMatchObject({
    key,
    id: 12,
    state: 'running',
    runs: [
      { id: 12, state: 'running', name: 'CI' },
      { id: 11, state: 'success', name: 'Labeler' },
    ],
  })
  expect(row()?.jobs.map(j => [j.stage, j.name, j.state])).toEqual([
    ['CI', 'unit', 'running'],
    ['Labeler', 'label', 'success'],
  ])
  expect(task()?.status).toBe('doing')
  expect(world.toasts.filter(x => x.startsWith('Pipeline'))).toEqual([])
  // A finished run's jobs are read once, not again every round.
  const labelerJobs = () =>
    world.runs.filter(r => r[r.length - 1] === `${REPO}/actions/runs/11/jobs?per_page=100`).length
  const before = labelerJobs()
  await world.clock.advance(15_000)
  expect(labelerJobs()).toBe(before)

  // The CI fails: only now is the commit's pipeline failed, by the run and job that failed it.
  world.github.set(list, {
    workflow_runs: [run(12, 'CI', 'completed', 'failure'), run(11, 'Labeler', 'completed', 'success')],
  })
  world.github.set(`${REPO}/actions/runs/12/jobs?per_page=100`, ghJobs(['unit', 'completed', 'failure']))
  await world.clock.advance(15_000)
  expect(row()).toMatchObject({ id: 12, state: 'failed' })
  expect(task()).toMatchObject({ status: 'failed', note: 'pipeline 12 failed: unit' })
  expect(world.toasts.filter(x => x.startsWith('Pipeline'))).toEqual(['Pipeline r failed'])

  // Re-run and green everywhere: success — one toast per finish, never one per run.
  world.github.set(list, {
    workflow_runs: [run(12, 'CI', 'completed', 'success'), run(11, 'Labeler', 'completed', 'success')],
  })
  world.github.set(`${REPO}/actions/runs/12/jobs?per_page=100`, ghJobs(['unit', 'completed', 'success']))
  await world.clock.advance(60_000)
  expect(row()).toMatchObject({ state: 'success' })
})

test(
  'a commit with a branch and a merge-request pipeline settles on both, and ⊘ stop stops each running one',
  { options: { runningPipelineX: 'cancel' } },
  async ($, on) => {
    const disk = makeDisk()
    const world = engine(on, disk)
    await start($)
    const sha = 'd'.repeat(40)
    const list = `projects/g%2Fapp/pipelines?sha=${sha}&per_page=100`
    world.gitlab.set(list, [
      { id: 72, status: 'running', ref: 'refs/merge-requests/3/head', source: 'merge_request_event' },
      { id: 71, status: 'running', ref: 'feat', source: 'push' },
      { id: 70, status: 'success', ref: 'other', source: 'push' },
    ])
    world.gitlab.set('projects/g%2Fapp/pipelines/72/jobs?per_page=100', jobsOf(['lint', 'running']))
    world.gitlab.set('projects/g%2Fapp/pipelines/71/jobs?per_page=100', jobsOf(['lint', 'success']))
    await update($, { watch: [{ project: 'g/app', sha, ref: 'feat' }] })
    await world.clock.advance(16_000)
    const row = read(disk, `${DIR}/s-me.json`).pipelines?.[0]
    // The other branch's pipeline is none of this watch's; the two that are tell apart by trigger.
    expect(row?.runs?.map(r => [r.id, r.name])).toEqual([
      [72, 'merge_request_event #72'],
      [71, 'push #71'],
    ])
    expect(row?.jobs.map(j => j.stage)).toEqual(['merge_request_event #72 · build', 'push #71 · build'])
    const ui = await pane($)
    world.gitlab.set('projects/g%2Fapp/pipelines/72/cancel', { id: 72, status: 'canceled' })
    world.gitlab.set('projects/g%2Fapp/pipelines/71/cancel', { id: 71, status: 'canceled' })
    const stop = `cancelpipe:s-me:g/app@${sha}:feat`
    await ui.press({ key: stop })
    await ui.press({ key: stop })
    await ui.unmount()
    const posts = world.runs.filter(r => r.includes('POST')).map(r => r[r.length - 1])
    expect(posts).toEqual(['projects/g%2Fapp/pipelines/72/cancel', 'projects/g%2Fapp/pipelines/71/cancel'])
  },
)

test('a long title with steps is cut with an ellipsis and its right column stays put; unfolded, it shows whole; one without steps wraps and never folds', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  const long =
    'progress-panel: skipped/failed/unfinished shown with their reason; item 4 dead sessions proven live'
  const second = 'a second task title far too long for forty columns, with its steps behind a fold'
  await update($, {
    tasks: [
      { title: long, status: 'doing', steps: [{ title: 'a', status: 'done' }, { title: 'b' }] },
      { title: 'short', status: 'todo' },
      { title: `${long} (no steps)`, status: 'todo' },
      { title: second, status: 'todo', steps: [{ title: 'c' }] },
    ],
  })
  for (const width of [40, 60, 80]) {
    const ui = await pane($, width)
    const all = await ui.findAll({ type: 'Text' })
    // A folded title truncates instead of wrapping: its Text says so… (t1 is `doing` with steps,
    // so it starts open and its title wraps whole — shown once.)
    const title = all.find(x => (x.text ?? '').includes(second))
    expect(title?.props.wrap, `width ${width}`).toBe('truncate-end')
    // A long title with nothing under it is not folded and not cut: it wraps, whole.
    const bare = all.find(x => (x.text ?? '').includes('(no steps)'))
    expect(bare?.props.wrap, `width ${width}`).toBeUndefined()
    const openTitle = all.filter(x => (x.text ?? '').includes(long) && !(x.text ?? '').includes('(no steps)'))
    expect(openTitle, `width ${width}`).toHaveLength(1)
    // …and its row keeps the bar and n/m in a column that does not shrink.
    const rows = await ui.findAll({ type: 'Box' })
    const row = rows.find(b => b.props.key === 'row:task:s-me:t1')
    expect(row?.props.justifyContent).toBe('space-between')
    const sides = rows.filter(b => b.props.flexShrink === 0)
    expect(sides.length).toBeGreaterThan(0)
    expect((await texts(ui)).some(l => l.endsWith('1/2'))).toBe(true)
    await ui.unmount()
  }
  // A long task with steps folds, so its whole title is one press away — and then shown ONCE.
  const ui = await pane($, 40)
  expect(await ui.find({ type: 'Button', key: 'task:s-me:t4' })).toBeDefined()
  const occurrences = async () => (await texts(ui)).filter(l => l.includes(second)).length
  expect(await occurrences()).toBe(1)
  await ui.press({ key: 'task:s-me:t4' })
  expect(await occurrences()).toBe(1)
  const open = (await ui.findAll({ type: 'Text' })).find(x => (x.text ?? '').includes(second))
  expect(open?.props.wrap).toBeUndefined()
  // A long one with no steps and a short one are plain lines: no Button, no arrow.
  expect(await ui.find({ type: 'Button', key: 'task:s-me:t3' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'task:s-me:t2' })).toBeUndefined()
  expect((await texts(ui)).filter(l => l.includes(`${long} (no steps)`))).toEqual([`○ ${long} (no steps)`])
  await ui.unmount()
})

test('a Now line never folds: a long one wraps and shows whole, a short one is the same plain line', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  const now = 'running the full check suite across every platform, then pushing the branch and watching CI'
  await update($, { now })
  for (const width of [40, 200]) {
    const ui = await pane($, width)
    // Nothing is under a Now line: no Button of any kind for it, no arrow, never cut.
    expect(
      (await ui.findAll({ type: 'Button' })).some(b => String(b.props.key ?? '').startsWith('full:')),
    ).toBe(false)
    const shown = (await ui.findAll({ type: 'Text' })).filter(x => (x.text ?? '').includes(now))
    expect(shown, `width ${width}`).toHaveLength(1)
    expect(shown[0]?.props.wrap, `width ${width}`).toBeUndefined()
    expect(shown[0]?.text, `width ${width}`).toBe(now)
    await ui.unmount()
  }
})

// --- A row folds only when it has something under it ---------------------------------------------
// One rule for every row: no sub-items → a plain line (no Button, no arrow); the first sub-item
// makes it foldable, and when the last one goes it is plain again. Now lines and asks have nothing
// under them ever (see their tests above); a running agent's row is pinned by the agents test.

test('a task folds only with a detail or steps: they arriving makes it foldable, their going makes it plain again', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  const key = 'task:s-me:t1'
  const shape = async () => {
    const ui = await pane($)
    const button = (await ui.find({ type: 'Button', key }))?.text
    const plain = (await texts(ui)).includes('○ Ship it')
    await ui.unmount()
    return { button, plain }
  }
  const task = (extra: Record<string, unknown>) =>
    update($, { tasks: [{ id: 't1', title: 'Ship it', ...extra }] })
  await task({})
  expect(await shape()).toEqual({ button: undefined, plain: true })
  await task({ steps: [{ title: 'push' }] })
  expect(await shape()).toEqual({ button: '▸ Ship it', plain: false })
  await task({ steps: [] })
  expect(await shape()).toEqual({ button: undefined, plain: true })
  await task({ detail: 'Push, then watch CI.' })
  expect(await shape()).toEqual({ button: '▸ Ship it', plain: false })
  await task({ detail: '' })
  expect(await shape()).toEqual({ button: undefined, plain: true })
})

test("a session's header folds only with a task, an agent or Done under it, and follows its file live", async ($, on) => {
  const disk = makeDisk()
  put(disk, `${DIR}/s-other.json`, other('s-other', 'site', T0, { now: 'Idle' }))
  const world = engine(on, disk)
  await start($)
  await update($, { now: 'here' })
  const shape = async () => {
    const ui = await pane($)
    const button = (await ui.find({ type: 'Button', key: 'group:s-other' }))?.text
    const plain = (await texts(ui)).find(l => /^site · \d\d:\d\d/.test(l))
    await ui.unmount()
    return { button, plain }
  }
  // Only a Now line (shown in its own section): nothing under the header, so no arrow.
  const bare = await shape()
  expect(bare.button).toBeUndefined()
  expect(bare.plain).toMatch(/^site · \d\d:\d\d · 0 open · 0 done$/)
  put(
    disk,
    `${DIR}/s-other.json`,
    other('s-other', 'site', T0 + 1000, { now: 'Idle', tasks: [{ title: 'Deploy', status: 'doing' }] }),
  )
  await world.clock.advance(2000)
  const open = await shape()
  expect(open.plain).toBeUndefined()
  expect(open.button).toMatch(/^▾ site · \d\d:\d\d · 1 open · 0 done$/)
  put(disk, `${DIR}/s-other.json`, other('s-other', 'site', T0 + 3000, { now: 'Idle' }))
  await world.clock.advance(2000)
  const gone = await shape()
  expect(gone.button).toBeUndefined()
  expect(gone.plain).toMatch(/^site · \d\d:\d\d · 0 open · 0 done$/)
})

test('a finished agent folds only with steps under it', async ($, on) => {
  const disk = makeDisk()
  const file = withFinishedAgents('s-me', ['Bare lane', 'Busy lane'])
  put(disk, `${DIR}/s-me.json`, {
    ...file,
    agents: file.agents?.map(a =>
      a.label === 'Busy lane' ? { ...a, tasks: [{ id: 't1', title: 'one step', status: 'done' }] } : a,
    ),
  })
  engine(on, disk)
  await start($)
  const ui = await pane($)
  await ui.press({ key: 'done:s-me' })
  await ui.press({ key: 'doneagents:s-me' })
  expect(await ui.find({ type: 'Button', key: 'doneagent:s-me:sub-1' })).toBeUndefined()
  expect((await texts(ui)).some(l => l.startsWith('✓ Bare lane  finished'))).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'doneagent:s-me:sub-2' }))?.text).toMatch(
    /^▸ ✓ Busy lane {2}finished/,
  )
  await ui.unmount()
})

test('a pipeline folds only once it has jobs to show; they arriving makes it foldable', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.gitlab.set(PIPE, { id: 42, status: 'running', ref: 'main' })
  world.gitlab.set(`${PIPE}/jobs?per_page=100`, [])
  await start($)
  await watch($, world, { watch: [{ project: 'g/app', pipeline: 42 }] })
  let ui = await pane($)
  // No jobs yet: the row is a plain line — no Button on its header or its status, no arrow.
  expect(await ui.find({ type: 'Button', key: 'pipe:s-me:g/app#42' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'pipestate:pipe:s-me:g/app#42' })).toBeUndefined()
  const lines = await texts(ui)
  expect(lines.some(l => l.includes('app #42 · main'))).toBe(true)
  expect(lines.some(l => /^[▾▸]/.test(l) && l.includes('app #42'))).toBe(false)
  // The section itself has the row under it: it still folds.
  expect((await ui.find({ type: 'Button', key: 'pipelines' }))?.text).toMatch(/^▾ Pipelines/)
  await ui.unmount()

  world.gitlab.set(`${PIPE}/jobs?per_page=100`, jobsOf(['lint', 'running']))
  await world.clock.advance(15_000)
  ui = await pane($)
  expect(await pipeLine(ui, 'pipe:s-me:g/app#42')).toBe('● ▸ app #42 · main · running  ░░░░░░░░ 0/1')
  await ui.unmount()
})

test('the switches sit under the header while one is off, say their state, and reporting off takes a second press', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { now: 'working', tasks: [{ title: 'one' }] })
  let ui = await pane($)
  expect(await texts(ui)).not.toContain('Switches:')
  const inSettings = async (key: string) => {
    await ui.press({ key: 'settings:open' })
    await ui.press({ key })
    await ui.press({ key: 'settings:back' })
  }
  // Tasks switch off at once: OFF in yellow, and the session header says what is off.
  await inSettings('setting:session:tasks')
  let lines = await texts(ui)
  // Right under the header line, before Now: labelled as switches, each with its state.
  const header = lines.findIndex(l => l.startsWith('updated '))
  const label = lines.indexOf('Switches:')
  expect(label).toBeGreaterThan(header)
  expect(label).toBeLessThan(lines.indexOf('Now'))
  expect(lines).toContain('● agents on')
  expect((await exactText(ui, '○ tasks OFF'))?.props.color).toBe('yellow')
  expect(lines.some(l => l.includes('off: tasks'))).toBe(true)
  // Reporting, in Settings too: the first press only asks…
  await ui.press({ key: 'settings:open' })
  await ui.press({ key: 'setting:session:reporting' })
  expect(await exactText(ui, 'press again to turn OFF')).toBeDefined()
  expect(read(disk, `${DIR}/s-me.json`).toggles).toEqual({ tasks: false })
  await ui.press({ key: 'settings:back' })
  // …and the row in the pane asks the same, in its place.
  expect(await exactText(ui, 'reporting: press again to turn OFF')).toBeDefined()
  expect(await exactText(ui, '● reporting on')).toBeUndefined()
  // …a second within the window turns it off, and the header shows the pause.
  await ui.press({ key: 'switch:reporting' })
  lines = await texts(ui)
  expect(lines).toContain('○ reporting OFF')
  expect(lines.some(l => l.includes('paused: reporting'))).toBe(true)
  // Back on with one press.
  await ui.press({ key: 'switch:reporting' })
  expect(await exactText(ui, '● reporting on')).toBeDefined()
  // A first press left alone expires: a later press only asks again.
  await ui.press({ key: 'switch:reporting' })
  await world.clock.advance(6000)
  await ui.press({ key: 'switch:reporting' })
  expect(await exactText(ui, 'reporting: press again to turn OFF')).toBeDefined()
  // Each switch carries what turning it changes, shown on hover.
  expect((await texts(ui)).some(l => l.startsWith('turns agents off for this session'))).toBe(true)
  await ui.unmount()
  // Too narrow for the label: the switches stay, the prefix goes.
  ui = await pane($, 40)
  lines = await texts(ui)
  expect(lines).not.toContain('Switches:')
  expect(lines.some(l => l.startsWith('● agents'))).toBe(true)
  await ui.unmount()
})

test('many presses between two prompts reach the agent as the net change: one line each, the rule at most once', async ($, on) => {
  engine(on, makeDisk())
  await start($)
  await update($, { now: 'working' })
  const ctx = async () =>
    ((await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)) as { additionalContext?: string[] })
      .additionalContext ?? []
  await ctx() // whatever the start owed
  const ui = await pane($)
  // The user's run: agents off/on, pipelines off/on, tasks off, reporting off, on, tasks on, off,
  // reporting off, on, tasks on — net: nothing changed.
  // In Settings, where every switch is always there (the pane's own row shows only while one is off).
  await ui.press({ key: 'settings:open' })
  const press = (k: string) => ui.press({ key: `setting:session:${k}` })
  await press('agents')
  await press('agents')
  await press('pipelines')
  await press('pipelines')
  await press('tasks')
  await press('reporting')
  await press('reporting') // second press: off
  await press('reporting') // on again
  await press('tasks')
  await press('tasks')
  await press('reporting')
  await press('reporting') // off
  await press('reporting') // on
  await press('tasks')
  expect(await ctx()).toEqual([])
  // Net change: tasks off (after off → on → off) and pipelines off → one line each.
  await press('tasks')
  await press('tasks')
  await press('tasks')
  await press('pipelines')
  const notes = await ctx()
  expect(notes).toHaveLength(2)
  expect(notes.join('\n')).not.toContain('# Progress pane')
  // Reporting off and on again between two prompts, tasks back on: the agent never heard of the
  // pause, so only the net change — tasks on.
  await press('reporting')
  await press('reporting')
  await press('tasks')
  await press('reporting')
  expect(await ctx()).toEqual([
    'Progress pane: tasks are on again for this session — keep the task list current as before.',
  ])
  // Reporting off, told; then on with pipelines back too: the rule once, nothing else.
  await press('reporting')
  await press('reporting')
  expect((await ctx()).join('')).toContain('reporting is off for this session')
  await press('pipelines')
  await press('reporting')
  const back = await ctx()
  expect(back).toHaveLength(1)
  expect(back[0]).toContain('# Progress pane')
  // Said once: the next prompt carries nothing.
  expect(await ctx()).toEqual([])
  await ui.unmount()
})

// --- A task never stays in a state that is no longer true (0.23.2) ---------------------------------

test('a push links its pipeline to the one `doing` task of that repo; the task closes by itself when it goes green', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, {
    now: 'shipping',
    tasks: [{ id: 'ship', title: 'Ship the fix', status: 'doing', repo: 'app' }],
  })
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git' })
  const sha = 'a'.repeat(40)
  world.gitlab.set(`projects/team%2Fapp/pipelines?sha=${sha}&per_page=100`, [
    { id: 51, status: 'running', ref: 'main', web_url: 'u' },
  ])
  world.gitlab.set('projects/team%2Fapp/pipelines/51', {
    id: 51,
    status: 'running',
    ref: 'main',
    web_url: 'u',
  })
  world.gitlab.set('projects/team%2Fapp/pipelines/51/jobs?per_page=100', [])
  const note = await bash($, 'git push')
  expect(note).toContain('task "Ship the fix" now waits on pipeline')
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]).toMatchObject({
    status: 'doing',
    pipeline: `team/app@${sha}:main`,
  })
  // Green: done by itself, the coordinator told once.
  world.gitlab.set(`projects/team%2Fapp/pipelines?sha=${sha}&per_page=100`, [
    { id: 51, status: 'success', ref: 'main', web_url: 'u' },
  ])
  await world.clock.advance(16_000)
  const task = read(disk, `${DIR}/s-me.json`).tasks[0]
  expect(task).toMatchObject({ status: 'done', note: 'pipeline 51 green' })
  const told = await $.classic.UserPromptSubmit({ prompt: 'next' } as never)
  expect(((told as { additionalContext?: string[] }).additionalContext ?? []).join(' ')).toContain(
    'task "Ship the fix" is done — pipeline 51 green',
  )
})

test('a red pipeline fails its task with the failing job; two `doing` tasks in the repo link nothing', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  world.gitlab.set('projects/team%2Fapp/pipelines/41', {
    id: 41,
    status: 'running',
    ref: 'main',
    web_url: 'u',
  })
  world.gitlab.set('projects/team%2Fapp/pipelines/41/jobs?per_page=100', [])
  await update($, {
    watch: [{ project: 'team/app', pipeline: 41 }],
    tasks: [{ id: 'fix', title: 'Fix CI', status: 'doing', pipeline: 'team/app#41' }],
  })
  world.gitlab.set('projects/team%2Fapp/pipelines/41', {
    id: 41,
    status: 'failed',
    ref: 'main',
    web_url: 'u',
  })
  world.gitlab.set('projects/team%2Fapp/pipelines/41/jobs?per_page=100', [
    { id: 1, name: 'check:macos', stage: 'test', status: 'failed', duration: 9 },
    { id: 2, name: 'check', stage: 'test', status: 'success', duration: 9 },
  ])
  await world.clock.advance(16_000)
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]).toMatchObject({
    status: 'failed',
    note: 'pipeline 41 failed: check:macos',
  })
  // Two `doing` tasks of the repo: a push links neither (never a guess).
  await update($, {
    tasks: [
      { id: 'a', title: 'One', status: 'doing', repo: 'app' },
      { id: 'b', title: 'Two', status: 'doing', repo: 'app' },
    ],
  })
  ciFile(disk, '/w/app/.gitlab-ci.yml')
  gitRepo(world, '/w/app', { url: 'git@gitlab.com:team/app.git', sha: 'e'.repeat(40) })
  const note = await bash($, 'git push')
  expect(note).not.toContain('now waits on pipeline')
  expect(read(disk, `${DIR}/s-me.json`).tasks.filter(t => t.pipeline)).toHaveLength(1)
})

test('a `doing` task untouched this turn stops the turn once — never twice for the same list — then is marked unconfirmed', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  // The tasks are seeded 11 min old — O(1) work, never minutes of simulated 2 s ticks (load-proof).
  put(
    disk,
    `${DIR}/s-me.json`,
    other('s-me', 'app', T0 - 11 * 60_000, {
      now: 'n',
      tasks: [
        { id: 'w', title: 'Write docs', status: 'doing' },
        { title: 'Later', status: 'todo' },
      ],
    }),
  )
  await start($)
  await $.classic.UserPromptSubmit({ prompt: 'thanks' } as never)
  const first = (await $.classic.Stop({ stop_hook_active: false } as never)) as { block?: string }
  expect(first.block).toContain('w "Write docs" (doing, last updated 11 min ago)')
  // The todo task never stops a turn.
  expect(first.block).not.toContain('Later')
  // The agent's stop right after the block (or the same list again) passes, and the task is marked.
  const second = (await $.classic.Stop({ stop_hook_active: true } as never)) as { block?: string }
  expect(second.block).toBeUndefined()
  expect(read(disk, `${DIR}/s-me.json`).tasks.find(t => t.id === 'w')?.unconfirmed).toBe(true)
  const ui = await pane($)
  expect((await texts(ui)).some(x => x.includes('unconfirmed at the end of a turn'))).toBe(true)
  await ui.unmount()
  // Same list in a later turn: no block (no loop).
  await $.classic.UserPromptSubmit({ prompt: 'again' } as never)
  expect(
    ((await $.classic.Stop({ stop_hook_active: false } as never)) as { block?: string }).block,
  ).toBeUndefined()
  // An update in the turn confirms it: the mark goes, and the stop passes.
  await update($, { tasks: [{ id: 'w', note: 'still writing' }] })
  expect(read(disk, `${DIR}/s-me.json`).tasks.find(t => t.id === 'w')?.unconfirmed).toBeUndefined()
  // The task's age, set by hand (never minutes of simulated ticks): last updated `min` minutes ago.
  const aged = (min: number) => {
    const file = read(disk, `${DIR}/s-me.json`)
    const at = new Date(T0 - min * 60_000).toISOString()
    put(disk, `${DIR}/s-me.json`, {
      ...file,
      tasks: file.tasks.map(t => (t.id === 'w' ? { ...t, updatedAt: at } : t)),
    })
  }
  const stop = async () => {
    await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)
    return ((await $.classic.Stop({ stop_hook_active: false } as never)) as { block?: string }).block
  }
  // Still `doing` many turns later, touched in between (long background work): it was asked about
  // once in this spell of `doing` — a later turn that leaves it untouched passes, marked.
  aged(12)
  expect(await stop()).toBeUndefined()
  expect(read(disk, `${DIR}/s-me.json`).tasks.find(t => t.id === 'w')?.unconfirmed).toBe(true)
  // It leaves `doing` and comes back: a new spell, asked about once again.
  await update($, { tasks: [{ id: 'w', status: 'blocked', note: 'waiting' }] })
  await update($, { tasks: [{ id: 'w', status: 'doing' }] })
  aged(12)
  expect(await stop()).toContain('w "Write docs"')
  aged(12)
  expect(await stop()).toBeUndefined()
})

test(
  'with tasks switched off, no task check ever stops a turn',
  { options: { tasksDefault: 'off' } },
  async ($, on) => {
    const disk = makeDisk()
    engine(on, disk)
    // Seeded 30 min old: the check would stop this turn if tasks were on.
    put(
      disk,
      `${DIR}/s-me.json`,
      other('s-me', 'app', T0 - 30 * 60_000, { tasks: [{ id: 'w', title: 'Write', status: 'doing' }] }),
    )
    await start($)
    await $.classic.UserPromptSubmit({ prompt: 'x' } as never)
    expect(
      ((await $.classic.Stop({ stop_hook_active: false } as never)) as { block?: string }).block,
    ).toBeUndefined()
  },
)

test('tasks in progress or blocked, untouched for 20 min, are asked about once — together in one line, and never a planned one', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  // Seeded 21 min old — one prompt, no simulated minutes.
  put(
    disk,
    `${DIR}/s-me.json`,
    other('s-me', 'app', T0 - 21 * 60_000, {
      now: 'n',
      tasks: [
        { id: 'b', title: 'Waiting on review', status: 'blocked', note: 'review' },
        { id: 'd', title: 'Long build', status: 'doing' },
        // Planned for later: untouched for 20 min is what a plan looks like.
        { id: 'p', title: 'Release notes', status: 'todo' },
      ],
    }),
  )
  await start($)
  const ctx = async () =>
    ((await $.classic.UserPromptSubmit({ prompt: 'p' } as never)) as { additionalContext?: string[] })
      .additionalContext ?? []
  const first = (await ctx()).filter(x => x.includes('no update'))
  expect(first).toEqual([
    'Progress pane: no update for a while on b "Waiting on review" (blocked for 21 min), d "Long build" (doing for 21 min) — is that still true? Update each to its real state.',
  ])
  expect((await ctx()).join(' ')).not.toContain('no update')
  // Kept on the task itself, in its current state — the task's own times are not touched.
  const asked = read(disk, `${DIR}/s-me.json`).tasks.find(x => x.id === 'd')
  expect(asked?.staleAsked).toBe(asked?.updatedAt)
  expect(asked?.updatedAt).toBe(new Date(T0 - 21 * 60_000).toISOString())
})

test('a task already asked about in its current state is not asked about again after a reload', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  const old = new Date(T0 - 40 * 60_000).toISOString()
  const file = other('s-me', 'app', T0 - 40 * 60_000, {
    now: 'n',
    tasks: [
      { id: 'a', title: 'Asked before', status: 'blocked' },
      { id: 'n', title: 'New since', status: 'doing' },
    ],
  })
  // As the copy before the reload left it: `a` was asked about in the state it is still in.
  put(disk, `${DIR}/s-me.json`, {
    ...file,
    tasks: file.tasks.map(x => (x.id === 'a' ? { ...x, staleAsked: old } : x)),
  })
  await start($)
  const line = (
    ((await $.classic.UserPromptSubmit({ prompt: 'p' } as never)) as { additionalContext?: string[] })
      .additionalContext ?? []
  ).find(x => x.includes('no update'))
  expect(line).toContain('n "New since" (doing for 40 min)')
  expect(line).not.toContain('Asked before')
})

test('the Settings view: values right-aligned and coloured, a changed one bold, the defaults grouped in order', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  const rows = [
    {
      key: 'progress-panel.palette',
      label: 'Colours',
      kind: 'choice',
      value: 'default',
      options: ['default', 'colorblind', 'none'],
      provider: 'plugin',
      isLocked: false,
    },
    {
      key: 'progress-panel.bell',
      label: 'Also notify through the terminal',
      kind: 'choice',
      value: 'on',
      options: ['on', 'off'],
      provider: 'plugin',
      isLocked: false,
    },
    {
      key: 'progress-panel.autoStart',
      label: 'Start in every new session',
      kind: 'choice',
      value: 'on',
      options: ['on', 'off'],
      provider: 'plugin',
      isLocked: false,
    },
    {
      key: 'progress-panel.pipelinesDefault',
      label: 'Pipelines in new sessions',
      kind: 'choice',
      value: 'off',
      options: ['on', 'off'],
      provider: 'plugin',
      isLocked: false,
    },
  ]
  on('config.list', () => ({ value: rows }) as never)
  await start($)
  await update($, { now: 'n' })
  for (const width of [80, 40]) {
    const ui = await pane($, width)
    await ui.press({ key: 'settings:open' })
    const all = await ui.findAll({ type: 'Text' })
    const headings = all
      .map(x => x.text)
      .filter(x => ['Reporting', 'Pipelines', 'Notifications', 'Pane'].includes(x ?? ''))
    expect(headings).toEqual(['Reporting', 'Pipelines', 'Notifications', 'Pane'])
    // The value is its own Text in the right column — never cut, whatever the width.
    const on = all.find(x => x.text === 'on' && x.props.bold === true)
    expect(on?.props.color).toBe('green')
    const off = all.find(x => x.text === 'off')
    expect(off?.props.color).toBe('yellow')
    // `default` is the palette's own default: cyan, not bold, marked "(default)".
    const choice = all.find(x => x.text === 'default')
    expect(choice?.props).toMatchObject({ color: 'cyan', bold: false })
    expect(all.some(x => x.text === '(default)')).toBe(true)
    await ui.press({ key: 'settings:back' })
    await ui.unmount()
  }
})

test("a session's work in several repos groups by repo, each with its own agents; one repo stays flat", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push(
    { id: 'ag-a', description: 'Lane A', type: 'general-purpose', status: 'running' },
    { id: 'ag-w', description: 'Lane W', type: 'general-purpose', status: 'running' },
    { id: 'ag-x', description: 'Lane X', type: 'general-purpose', status: 'running' },
  )
  // Lane W works in a worktree of `site`: git names the repo by its common dir.
  world.programs.set(
    'git -C /tmp/wt-site rev-parse --path-format=absolute --git-common-dir',
    '/w/site/.git\n',
  )
  await start($)
  await update($, {
    now: 'n',
    tasks: [
      { id: 'p', title: 'Panel fix', status: 'doing', repo: 'panel', agent: 'Lane A' },
      { id: 'q', title: 'App fix', status: 'doing' },
    ],
  })
  await world.clock.advance(2100)
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: '', stderr: '', interrupted: false },
    tool_use_id: 'w1',
    agent_id: 'ag-w',
    cwd: '/tmp/wt-site',
  } as never)
  const ui = await pane($, 100)
  // Each repo branch holds its agents; the unknown one goes to "other"; no session-level Agents.
  expect(await ui.find({ type: 'Button', key: 'agents:s-me:panel' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'agents:s-me:site' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'agents:s-me:\u0000other' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'agents:s-me' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'repo:s-me:\u0000other' }))?.text).toBe('▾ other  0 open')
  await ui.unmount()
})

test("an agent's first tool call before its entry exists does not lose its repo: asked again once it has one", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  const common = 'git -C /tmp/wt-site rev-parse --path-format=absolute --git-common-dir'
  world.programs.set(common, '/w/site/.git\n')
  await start($)
  await update($, { now: 'n' })
  const call = (id: string, cwd: string) =>
    $.classic.PostToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: '', stderr: '', interrupted: false },
      tool_use_id: `u-${id}`,
      agent_id: id,
      cwd,
    } as never)
  const asked = () => world.runs.filter(r => r.join(' ') === common).length
  // Its first call lands before any scan listed it: it has no entry to put a repo on — git is not
  // even asked (nothing to write), and the question stays open.
  await call('ag-early', '/tmp/wt-site')
  expect(asked()).toBe(0)
  world.agents.push({ id: 'ag-early', description: 'Lane E', type: 'general-purpose', status: 'running' })
  await world.clock.advance(2100)
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]?.repo).toBeUndefined()
  await call('ag-early', '/tmp/wt-site')
  expect(read(disk, `${DIR}/s-me.json`).agents?.[0]?.repo).toBe('site')
  // Answered: its later calls ask nothing more.
  await call('ag-early', '/tmp/wt-site')
  expect(asked()).toBe(1)
  // One that runs outside any repository is asked once, not at every call.
  world.agents.push({ id: 'ag-none', description: 'Lane N', type: 'general-purpose', status: 'running' })
  await world.clock.advance(2100)
  const outside = () => world.runs.filter(r => r.includes('/tmp/nowhere')).length
  await call('ag-none', '/tmp/nowhere')
  await call('ag-none', '/tmp/nowhere')
  expect(outside()).toBe(1)
})

test('one repo: tasks, then the session-level Agents — no repo headings', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'ag-a', description: 'Lane A', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, { now: 'n', tasks: [{ id: 'q', title: 'App fix', status: 'doing', agent: 'Lane A' }] })
  await world.clock.advance(2100)
  const ui = await pane($, 100)
  expect(await ui.find({ type: 'Button', key: 'agents:s-me' })).toBeDefined()
  expect(
    (await ui.findAll({ type: 'Button' })).some(b => String(b.props.key ?? '').startsWith('repo:')),
  ).toBe(false)
  await ui.unmount()
})

test('a permission prompt says what it is for, and the task / agent / step it belongs to is marked; cleared with it', async ($, on) => {
  const disk = makeDisk()
  // The engine beneath (registered before the kit's catch-all): a Bash or Write call asks the person
  // first — Claude Code's generic notice arrives while the call is in flight, before the tool runs.
  const prompt = (agentId?: string) => async () => {
    await $.classic.Notification({
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
      ...(agentId ? { agent_id: agentId } : {}),
    } as never)
    return { result: {} } as never
  }
  on('tool.call', { tool: 'Bash' }, prompt())
  on('tool.call', { tool: 'Write' }, prompt('sub-q'))
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-q', description: 'Lane Q', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, {
    now: 'n',
    tasks: [
      { id: 'main', title: 'Main work', status: 'doing' },
      { id: 'lane', title: 'Lane work', status: 'todo', agent: 'Lane Q' },
    ],
  })
  // The subagent reports a doing step.
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-q',
    now: 'deploying',
    tasks: [{ title: 'Deploy', status: 'doing' }],
  } as never)
  const autoNeeds = () => read(disk, `${DIR}/s-me.json`).autoNeeds ?? []
  // The main loop's Bash call: the generic notice is enriched from that call.
  await $.tool.call({ tool: 'Bash', tool_use_id: 'm1', command: 'git push origin next\nmore' } as never)
  expect(autoNeeds()[0]).toMatchObject({
    text: 'Permission: Bash — git push origin next',
    what: 'Bash — git push origin next',
    taskId: 'main',
  })
  // The subagent's prompt names it; its call's input says what.
  await $.tool.call({ tool: 'Write', tool_use_id: 'q1', file_path: '/w/app/x.ts', agentId: 'sub-q' } as never)
  expect(autoNeeds().map(a => a.text)).toContain('Permission: Write — /w/app/x.ts (agent: Lane Q)')
  const ui = await pane($, 100)
  const all = await texts(ui)
  // The main task: the Needs-you mark, the reason beneath.
  expect(all).toContain('⚠ Main work')
  expect(all).toContain('waiting for your permission: Bash — git push origin next')
  // The agent's row and its doing step, and the task linked to it.
  expect(all).toContain('waiting for your permission: Write — /w/app/x.ts')
  expect(all).toContain('⚠ Deploy')
  // Beneath the agent's row, its doing step, and the task linked to that agent (a fold: its mark is
  // the row's own Text): three times, each its own item.
  expect(all.filter(x => x === 'waiting for your permission: Write — /w/app/x.ts')).toHaveLength(3)
  expect(all).toContain('⚠ ▾ Lane Q')
  await ui.unmount()
  // The main loop's tool ran: its item and mark go; the subagent's stay until its own call.
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'm1',
  } as never)
  expect(autoNeeds().map(a => a.agentId)).toEqual(['sub-q'])
  const after = await pane($, 100)
  expect(await texts(after)).toContain('● Main work')
  await after.unmount()
  await $.classic.PostToolUse({
    tool_name: 'Write',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'q1',
    agent_id: 'sub-q',
  } as never)
  expect(autoNeeds()).toEqual([])
})

test("a permission prompt with no recorded call names the notice's tool; several doing tasks mark none", async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, {
    now: 'n',
    tasks: [
      { id: 'a', title: 'A', status: 'doing' },
      { id: 'b', title: 'B', status: 'doing' },
    ],
  })
  await $.classic.Notification({
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use WebFetch',
  } as never)
  const need = (read(disk, `${DIR}/s-me.json`).autoNeeds ?? [])[0]
  expect(need?.text).toBe('Permission: WebFetch')
  expect(need?.taskId).toBeUndefined()
})

test('a bare permission notice is never shown bare: it says where to look and what to do', async ($, on) => {
  const disk = makeDisk()
  engine(on, disk)
  await start($)
  await update($, { now: 'n' })
  await $.classic.Notification({
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission',
  } as never)
  expect((read(disk, `${DIR}/s-me.json`).autoNeeds ?? [])[0]?.text).toBe(
    'Permission prompt in session app — open that terminal to see and answer it',
  )
})

test('an ask may name its task or subagent: that one shows the Needs-you mark with the ask beneath; a plain string still works', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-r', description: 'Lane R', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, {
    now: 'n',
    tasks: [
      { id: 'rel', title: 'Release 0.23.2', status: 'doing' },
      { id: 'other', title: 'Other work', status: 'doing' },
    ],
    needsYou: [
      { text: 'Push progress-panel 0.23.2? — reply yes or no here', task: 'rel' },
      { text: 'Pick a port for Lane R — answer here', agent: 'Lane R' },
      'Plug in the USB key — any time today',
    ],
  })
  await $.tool.call({
    tool: TOOL,
    agentId: 'sub-r',
    now: 'r',
    tasks: [{ title: 'Bind', status: 'doing' }],
  } as never)
  const file = read(disk, `${DIR}/s-me.json`)
  expect(file.needsYou).toEqual([
    'Push progress-panel 0.23.2? — reply yes or no here',
    'Pick a port for Lane R — answer here',
    'Plug in the USB key — any time today',
  ])
  const ui = await pane($, 120)
  const all = await texts(ui)
  expect(all).toContain('⚠ Release 0.23.2')
  expect(all).toContain('Push progress-panel 0.23.2? — reply yes or no here')
  expect(all).toContain('● Other work')
  expect(all).toContain('⚠ ▾ Lane R')
  expect(all).toContain('⚠ Bind')
  await ui.unmount()
  // Answered: [] clears the asks, and the marks go with them.
  await update($, { needsYou: [] })
  const after = await pane($, 120)
  expect(await texts(after)).toContain('● Release 0.23.2')
  await after.unmount()
  // A blank ask is refused.
  const answer = String(
    ((await update($, { needsYou: [{ text: ' ' }] })) as { result?: unknown }).result ?? '',
  )
  expect(answer).toContain('an ask needs its text')
})

test('the only open session is never named — not in Needs you, Now, its header, the top line or the status line — and needs no "here"', async ($, on) => {
  const disk = makeDisk()
  // An ended session is not open: it keeps its name, and the open one still needs none.
  const old = other('s-old', 'old', T0 - HOUR, { now: 'Was busy' })
  put(disk, `${DIR}/s-old.json`, {
    ...old,
    session: { ...old.session, endedAt: new Date(T0 - HOUR).toISOString() },
  })
  const world = engine(on, disk)
  await start($)
  await update($, {
    now: 'Writing tests',
    tasks: [{ id: 'rel', title: 'Release 1.0', status: 'doing' }],
    needsYou: [{ text: 'Push 1.0?', reply: 'yes or no', task: 'rel' }, 'Plug in the USB key'],
  })

  const ui = await pane($, 120)
  const lines = await texts(ui)
  expect(lines).toContain('• Push 1.0? — reply yes or no')
  expect(lines).toContain('• Plug in the USB key')
  expect(lines).toContain('Push 1.0? — reply yes or no')
  expect(lines).toContain('Writing tests')
  expect(lines.filter(l => l.includes('app'))).toEqual([])
  expect(lines.filter(l => l.includes('reply') && l.endsWith(' here'))).toEqual([])
  expect(lines[0]).toMatch(/^updated \d\d:\d\d$/)
  expect((await ui.find({ type: 'Button', key: 'group:s-me' }))?.text).toMatch(/^▾ This session · /)
  await groupHeader(ui, 's-old', /^old · ended /)
  expect(world.status.at(-1)).toBe('⚠ 2 need you — Push 1.0? — reply yes or no')
  await ui.unmount()
})

test('with two sessions open, "reply … here" shows only in the pane of the session that asks', async ($, on) => {
  const disk = makeDisk()
  put(
    disk,
    `${DIR}/s-other.json`,
    other('s-other', 'site', T0 - HOUR, {
      now: 'Deploying',
      tasks: [{ id: 'dep', title: 'Deploy', status: 'doing' }],
      needsYou: [{ text: 'Approve the deploy?', reply: 'yes or no', task: 'dep' }],
    }),
  )
  const world = engine(on, disk)
  await start($)
  await update($, {
    now: 'Writing tests',
    tasks: [{ id: 'rel', title: 'Release 1.0', status: 'doing' }],
    needsYou: [{ text: 'Push 1.0?', reply: 'yes or no', task: 'rel' }],
  })

  const ui = await pane($, 120)
  const lines = await texts(ui)
  // This session's own ask: answered here. The other session's: not here, and it says whose it is.
  expect(lines).toContain('• app: Push 1.0? — reply yes or no here')
  expect(lines).toContain('• site: Approve the deploy? — reply yes or no')
  // The same wording beneath the task each ask belongs to.
  expect(lines).toContain('Push 1.0? — reply yes or no here')
  expect(lines).toContain('Approve the deploy? — reply yes or no')
  expect(lines).not.toContain('Approve the deploy? — reply yes or no here')
  expect(lines).toContain('app · Writing tests')
  expect((await ui.find({ type: 'Button', key: 'group:s-me' }))?.text).toMatch(/^▾ app \(this session\) · /)
  expect(world.status.at(-1)).toBe('⚠ 2 need you — app: Push 1.0? — reply yes or no here')
  await ui.unmount()
})

test('a session that has not reported yet is still a second open session: the other one keeps its name', async ($, on) => {
  const disk = makeDisk()
  put(disk, `${DIR}/s-other.json`, other('s-other', 'site', T0, { now: 'Busy', needsYou: ['Answer me'] }))
  engine(on, disk)
  await start($)
  const ui = await pane($)
  const lines = await texts(ui)
  expect(lines).toContain('• site: Answer me')
  expect(lines).toContain('site · Busy')
  await ui.unmount()
})

test('the idle wait says "answer here" only in its own pane, and only when another session is open', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { now: 'n', tasks: [{ title: 'Work', status: 'doing' }] })
  await $.classic.Notification({ notification_type: 'idle_prompt', message: 'x' } as never)
  let ui = await pane($)
  // Worded as a state, never as a question left unanswered — beneath its task too.
  expect(await texts(ui)).toContain('○ Turn finished — waiting for your next message')
  expect(await texts(ui)).toContain('turn finished — waiting for your next message')
  await ui.unmount()

  // Another session opens: here is now worth saying. Its own idle wait is not "here".
  const waiting = other('s-other', 'site', T0, { now: 'Idle' })
  put(disk, `${DIR}/s-other.json`, {
    ...waiting,
    autoNeeds: [
      {
        kind: 'idle',
        text: 'Waiting for your reply — answer in this session',
        at: new Date(T0).toISOString(),
      },
    ],
  })
  await world.clock.advance(2000)
  ui = await pane($, 140)
  const lines = await texts(ui)
  // Sessions that only finished a turn are one line, counted — never a list that buries an ask.
  expect(lines).toContain(
    '○ 2 sessions finished their turn — waiting for your next message: app (here), site',
  )
  expect(lines.filter(l => l.includes('Needs you'))).toEqual([])
  await ui.unmount()
})

test('an ask outranks sessions that only finished a turn: first in the pane and the status line, and only it is toasted', async ($, on) => {
  const disk = makeDisk()
  const at = new Date(T0).toISOString()
  const idle = (id: string, project: string, ms: number) => ({
    ...other(id, project, ms, { now: 'Idle' }),
    autoNeeds: [{ kind: 'idle', text: 'Turn finished — waiting for your next message', at }],
  })
  const world = engine(on, disk)
  await start($)
  await update($, { now: 'mine' })
  // The ask is the OLDEST update; two sessions went idle after it.
  put(
    disk,
    `${DIR}/s-ask.json`,
    other('s-ask', 'api', T0 - 60_000, { now: 'Waiting', needsYou: ['Approve the deploy'] }),
  )
  put(disk, `${DIR}/s-idle1.json`, idle('s-idle1', 'site', T0 + 1000))
  put(disk, `${DIR}/s-idle2.json`, idle('s-idle2', 'docs', T0 + 2000))
  await world.clock.advance(2000)
  expect(world.status.at(-1)).toBe('⚠ api: Approve the deploy')
  // A session that finished its turn is no ask: it raises no toast.
  expect(world.toasts).toEqual(['api needs you: Approve the deploy'])
  const ui = await pane($, 140)
  const lines = await texts(ui)
  expect(lines).toContain('⚠ Needs you (1)')
  expect(lines).toContain('• api: Approve the deploy')
  const idleLine = lines.findIndex(l => l.startsWith('○ 2 sessions finished their turn'))
  expect(idleLine).toBeGreaterThan(lines.indexOf('• api: Approve the deploy'))
  expect(lines[idleLine]).toContain('docs, site')
  expect((await ui.find({ type: 'Text', text: /^○ 2 sessions finished/ }))?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('two open sessions in one repo are told apart: the later one is numbered, and their long asks wrap as plain lines', async ($, on) => {
  const disk = makeDisk()
  const long = `Decide: ${'which of the two release trains this fix should ride '.repeat(3)}`.trim()
  const world = engine(on, disk)
  await start($)
  await update($, { now: 'mine', needsYou: [long] })
  put(disk, `${DIR}/s-twin.json`, other('s-twin', 'app', T0 + 1000, { now: 'theirs', needsYou: [long] }))
  put(disk, `${DIR}/s-old.json`, {
    ...other('s-old', 'app', T0 - HOUR, { now: 'was here' }),
    session: { ...other('s-old', 'app', T0 - HOUR, {}).session, endedAt: new Date(T0 - 1000).toISOString() },
  })
  await world.clock.advance(2000)
  const ui = await pane($)
  const lines = await texts(ui)
  expect(lines).toContain('app · mine')
  expect(lines).toContain('app #2 · theirs')
  // Nothing under any of the three: plain header lines, no arrow.
  await groupHeader(ui, 's-twin', /^app #2 · /)
  await groupHeader(ui, 's-me', /^app \(this session\) · /)
  // An ended session of the same repo takes no number: "ended …" already tells it apart.
  await groupHeader(ui, 's-old', /^app · ended /)
  expect(world.toasts).toEqual([`app #2 needs you: ${long}`])
  // The same ask in both: each a plain line (nothing is under an ask), wrapped, never cut or folded.
  expect(
    (await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key ?? '').startsWith('full:')),
  ).toEqual([])
  const asks = (await ui.findAll({ type: 'Text' })).filter(x => (x.text ?? '').includes(long))
  expect(asks.map(x => x.text).sort()).toEqual([`• app #2: ${long}`, `• app: ${long}`])
  expect(asks.map(x => x.props.wrap)).toEqual([undefined, undefined])
  await ui.unmount()
})

test(
  "paneScope session: other sessions' asks stay out of this pane's Needs you, its toasts and its status line",
  { options: { paneScope: 'session' } },
  async ($, on) => {
    const disk = makeDisk()
    const world = engine(on, disk)
    await start($)
    await update($, { now: 'mine' })
    put(
      disk,
      `${DIR}/s-else.json`,
      other('s-else', 'elsewhere', T0, { now: 'other', needsYou: ['Approve elsewhere'] }),
    )
    await world.clock.advance(2000)
    expect(world.toasts).toEqual([])
    expect(world.status.at(-1)).toBeUndefined()
    const ui = await pane($)
    const shown = (await texts(ui)).join('\n')
    expect(shown).not.toContain('Approve elsewhere')
    expect(shown).not.toContain('Needs you')
    // The only session this pane lists: it needs no name.
    await groupHeader(ui, 's-me', /^This session · /)
    await ui.unmount()
    await update($, { needsYou: ['Mine to answer'] })
    expect(world.status.at(-1)).toBe('⚠ Mine to answer')
  },
)

test(
  "paneScope repo: another repo's ask is not toasted here, the same repo's is",
  { options: { paneScope: 'repo' } },
  async ($, on) => {
    const disk = makeDisk()
    const world = engine(on, disk)
    await start($)
    await update($, { now: 'mine' })
    put(
      disk,
      `${DIR}/s-else.json`,
      other('s-else', 'elsewhere', T0, { now: 'other', needsYou: ['Approve elsewhere'] }),
    )
    put(
      disk,
      `${DIR}/s-same.json`,
      other('s-same', 'app', T0 + 1000, { now: 'same', needsYou: ['Approve here'] }),
    )
    await world.clock.advance(2000)
    expect(world.toasts).toEqual(['app #2 needs you: Approve here'])
    expect(world.status.at(-1)).toBe('⚠ app #2: Approve here')
  },
)

test("another session's malformed file never breaks the pane: what is unreadable in it is left out", async ($, on) => {
  const disk = makeDisk()
  const iso = new Date(T0).toISOString()
  put(disk, `${DIR}/s-odd.json`, {
    ...other('s-odd', 'site', T0, { now: 'deploying', tasks: [{ title: 'Deploy docs', status: 'doing' }] }),
    autoNeeds: [null, { kind: 'idle' }],
    needLinks: [null],
    toggles: 'on',
    agents: [{ id: 'a1', tasks: [null] }, null],
    pipelines: [
      {
        key: 'g/site#7',
        project: 'g/site',
        id: 7,
        label: 'site',
        state: 'exploded',
        jobs: [null],
        addedAt: iso,
        checkedAt: null,
      },
    ],
  })
  const raw = JSON.parse(disk.files.get(`${DIR}/s-odd.json`)?.text ?? '{}')
  raw.tasks.push(null, { id: 't2', title: 'Steps', status: 'doing', steps: [null, { title: 'one' }] })
  put(disk, `${DIR}/s-odd.json`, raw)
  const world = engine(on, disk)
  await start($)
  const ui = await pane($)
  const lines = await texts(ui)
  expect(lines).toContain('● Deploy docs')
  expect(lines.some(l => l.includes('site #7'))).toBe(true)
  await ui.press({ key: 'agent:s-odd:a1' }).catch(() => undefined)
  await ui.unmount()
  // The scan went through to its end: the status line was set, nothing threw on the way.
  expect(world.status.length).toBeGreaterThan(0)
})

const pressedFile = (disk: Disk, id: string) =>
  JSON.parse(disk.files.get(`${DIR}/${id}.dismissed.json`)?.text ?? '{}') as {
    cancelled?: string[]
    cancelledAt?: Record<string, string>
    entries?: { id: string; all?: true; at?: string }[]
  }
const mainNote = async ($: $Test, id: string) =>
  ctx(
    await $.classic.PostToolUse({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: {},
      tool_use_id: id,
    } as never),
  )

test('a ✕ on an open task can be taken back for a few seconds: its session never acts on it', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { tasks: [{ title: 'Write the docs' }, { title: 'Push' }] })
  const ui = await pane($)
  await ui.press({ key: 'cancel:s-me:t1' })
  // The row is gone at once; in its session's group one dim line says so, with its undo.
  let lines = await texts(ui)
  expect(lines).not.toContain('○ Write the docs')
  expect(lines).toContain('– Write the docs  removed')
  expect((await ui.find({ type: 'Button', key: 'undo:s-me:removal:t1' }))?.text).toBe('  ↶ undo  ')
  expect(pressedFile(disk, 's-me')).toMatchObject({
    cancelled: ['t1'],
    cancelledAt: { t1: new Date(T0).toISOString() },
  })
  // While it can be taken back, its session does nothing: the task is as it was, the agent hears nothing.
  await world.clock.advance(4000)
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]?.status).toBe('todo')
  expect(await mainNote($, 'u1')).toBe('')
  await ui.press({ key: 'undo:s-me:removal:t1' })
  lines = await texts(ui)
  expect(lines).toContain('○ Write the docs')
  expect(lines).not.toContain('– Write the docs  removed')
  expect(pressedFile(disk, 's-me').cancelled ?? []).toEqual([])
  expect(pressedFile(disk, 's-me').cancelledAt).toBeUndefined()
  // …and it stays so: nothing was removed.
  await world.clock.advance(UNDO_OVER)
  expect(read(disk, `${DIR}/s-me.json`).tasks.map(x => x.status)).toEqual(['todo', 'todo'])
  expect(await mainNote($, 'u2')).toBe('')
  await ui.unmount()
})

test('an undo not taken runs out: its line goes, then the session marks the task skipped and tells its agent', async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  await update($, { tasks: [{ title: 'Write the docs' }] })
  const ui = await pane($)
  await ui.press({ key: 'cancel:s-me:t1' })
  await world.clock.advance(UNDO_MS + 2000)
  expect(await ui.find({ type: 'Button', key: 'undo:s-me:removal:t1' })).toBeUndefined()
  expect((await texts(ui)).some(l => l.includes('Write the docs'))).toBe(false)
  // Not yet acted on: the session waits past the last moment an undo could land.
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]?.status).toBe('todo')
  await world.clock.advance(4000)
  expect(read(disk, `${DIR}/s-me.json`).tasks[0]).toMatchObject({ status: 'skipped' })
  expect(await mainNote($, 'u1')).toContain('t1 "Write the docs"')
  await ui.unmount()
})

test('✕ on a done task, on a finished agent, and Clear all can each be taken back', async ($, on) => {
  const disk = makeDisk()
  put(disk, `${DIR}/s-me.json`, withFinishedAgents('s-me', ['Lane A', 'Lane B']))
  const world = engine(on, disk)
  await start($)
  await update($, {
    tasks: [
      { title: 'Alpha', status: 'done' },
      { title: 'Beta', status: 'done' },
      { title: 'Gamma', status: 'doing' },
    ],
  })
  const ui = await pane($)
  await ui.press({ key: 'done:s-me' })
  // (Tasks of the session's repo and agents of none: Done groups them, the agents under "other".)
  await ui.press({ key: 'doneagents:s-me:\u0000other' })
  const has = async (re: RegExp) => (await texts(ui)).some(l => re.test(l))

  await ui.press({ key: 'dismiss:s-me:t1' })
  expect(await has(/^✓ Alpha/)).toBe(false)
  expect(await texts(ui)).toContain('– Alpha  cleared')
  expect((await ui.find({ type: 'Button', key: 'done:s-me' }))?.text).toBe('▾ Done (3)')
  await ui.press({ key: 'undo:s-me:entry:t1' })
  expect(await has(/^✓ Alpha/)).toBe(true)
  expect(pressedFile(disk, 's-me').entries).toEqual([])

  await ui.press({ key: 'dismiss:s-me:agent:sub-1' })
  expect(await has(/^✓ Lane A/)).toBe(false)
  expect(await texts(ui)).toContain('– Lane A  cleared')
  await ui.press({ key: 'undo:s-me:entry:agent:sub-1' })
  expect(await has(/^✓ Lane A/)).toBe(true)

  // Clear all says how many rows go — the whole of Done, finished agents included — and is one undo.
  expect((await ui.find({ type: 'Button', key: 'clear:s-me' }))?.text).toBe('Clear all (4)')
  await ui.press({ key: 'clear:s-me' })
  expect(await ui.find({ type: 'Button', key: 'done:s-me' })).toBeUndefined()
  expect(await texts(ui)).toContain('– Done cleared: 4 rows')
  const at = new Date(T0).toISOString()
  expect(pressedFile(disk, 's-me').entries?.every(d => d.all === true && d.at === at)).toBe(true)
  await ui.press({ key: `undo:s-me:all:${at}` })
  expect((await ui.find({ type: 'Button', key: 'done:s-me' }))?.text).toBe('▾ Done (4)')
  expect(await has(/^✓ Beta/)).toBe(true)
  await world.clock.advance(UNDO_OVER)
  expect(read(disk, `${DIR}/s-me.json`).tasks.map(x => x.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
  expect(read(disk, `${DIR}/s-me.json`).agents?.map(a => a.label)).toEqual(['Lane A', 'Lane B'])

  // Not taken back: gone for good once its session folds it in.
  await ui.press({ key: 'clear:s-me' })
  await world.clock.advance(UNDO_OVER)
  expect((await texts(ui)).some(l => l.includes('Done cleared'))).toBe(false)
  expect(read(disk, `${DIR}/s-me.json`).tasks.map(x => x.title)).toEqual(['Gamma'])
  expect(read(disk, `${DIR}/s-me.json`).agents ?? []).toEqual([])
  await ui.unmount()
})

test("a hidden pipeline, a running agent's ✕ and a step's ✕ can be taken back", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  world.agents.push({ id: 'sub-r', description: 'Lane R', type: 'general-purpose', status: 'running' })
  await start($)
  await update($, {
    now: 'n',
    tasks: [{ title: 'A', status: 'doing', steps: [{ title: 'one' }, { title: 'two' }] }],
  })
  await $.tool.call({ tool: TOOL, agentId: 'sub-r', now: 'w', tasks: [{ title: 'read' }] } as never)
  const key = await runningPipeline(world, $)
  await world.clock.settle()
  const ui = await pane($)

  await ui.press({ key: `hidepipe:s-me:${key}` })
  expect(await ui.find({ type: 'Button', key: `pipe:s-me:${key}` })).toBeUndefined()
  // The Pipelines section stays for the undo, though no pipeline is listed.
  expect(await texts(ui)).toContain('– app  hidden')
  await ui.press({ key: `undo:s-me:entry:pipeline:${key}` })
  expect(await ui.find({ type: 'Button', key: `pipe:s-me:${key}` })).toBeDefined()

  await ui.press({ key: 'cancel:s-me:agentall:sub-r' })
  expect(await texts(ui)).toContain('– Lane R  will be stopped')
  // Pressed: its ✕ is not offered a second time.
  expect(await ui.find({ type: 'Button', key: 'cancel:s-me:agentall:sub-r' })).toBeUndefined()
  await ui.press({ key: 'undo:s-me:removal:agentall:sub-r' })
  expect(await ui.find({ type: 'Button', key: 'cancel:s-me:agentall:sub-r' })).toBeDefined()

  await ui.press({ key: 'cancel:s-me:step:t1:two' })
  expect(await texts(ui)).not.toContain('○ two')
  expect(await texts(ui)).toContain('– two  removed')
  await ui.press({ key: 'undo:s-me:removal:step:t1:two' })
  expect(await texts(ui)).toContain('○ two')

  // Nothing of it ever reached the session: still watched, still running, the step still to do.
  await world.clock.advance(UNDO_OVER)
  const file = read(disk, `${DIR}/s-me.json`)
  expect(file.pipelines?.map(p => p.key)).toEqual([key])
  expect(file.agents?.[0]?.cancelledAt).toBeUndefined()
  expect(file.tasks[0]?.steps?.map(x => x.status)).toEqual(['todo', 'todo'])
  expect(await mainNote($, 'u1')).toBe('')
  await ui.unmount()
})

test("a press that cannot be saved says so: this session's file caught unreadable is no silent loss", async ($, on) => {
  const disk = makeDisk()
  const world = engine(on, disk)
  await start($)
  const key = await runningPipeline(world, $)
  await world.clock.settle()
  const ui = await pane($)
  // ⊘ stop, twice: the cancel reaches the CI, then the row's removal needs this session's own file.
  disk.readFails = `${DIR}/s-me.json`
  await ui.press({ key: `cancelpipe:s-me:${key}` })
  await ui.press({ key: `cancelpipe:s-me:${key}` })
  await world.clock.settle()
  expect(world.toasts).toContain('Progress pane: that press could not be saved just now — press again.')
  disk.readFails = undefined
  await ui.unmount()
})

test('a watch the plugin stopped does not look like a running pipeline: no live mark, no bar, no clock, no ⊘', async ($, on) => {
  const disk = makeDisk()
  const iso = new Date(T0 - HOUR).toISOString()
  const why = 'stopped watching — still unfinished after 24 h. Watch it again to go on.'
  put(disk, `${DIR}/s-other.json`, {
    ...other('s-other', 'site', T0, {
      now: 'waiting',
      tasks: [{ id: 'ship', title: 'Ship', status: 'doing', pipeline: 'team/app#9' }],
    }),
    pipelines: [
      {
        key: 'team/app#9',
        project: 'team/app',
        id: 9,
        label: 'app main',
        state: 'running',
        stopped: 'age',
        error: why,
        startedAt: iso,
        jobs: [
          { name: 'build', stage: 'build', state: 'success', durationS: 30 },
          { name: 'test', stage: 'test', state: 'running', durationS: null },
        ],
        addedAt: iso,
        checkedAt: iso,
      },
    ],
  })
  engine(on, disk)
  await start($)
  const ui = await pane($, 140)
  const key = 'pipe:s-other:team/app#9'
  // Its row: dim like a finished one, "not watched" where the state stood — no bar, no running time.
  expect(await pipeLine(ui, key)).toBe('▸ app main #9 · not watched  1/2')
  const header = (await ui.findAll({ type: 'Text' })).find(x => x.text === '▸ app main #9')
  expect(header?.props.bold).toBeFalsy()
  expect(header?.props.dimColor).toBe(true)
  expect(await exactText(ui, '● ')).toBeUndefined()
  // Why, as a warning — not the red of a failure in CI.
  expect((await exactText(ui, why))?.props.color).toBe('yellow')
  // Nothing to stop from here (the plugin no longer knows its state); ✕ still hides the row.
  expect(await ui.find({ type: 'Button', key: 'cancelpipe:s-other:team/app#9' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'hidepipe:s-other:team/app#9' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'pipelines' }))?.text).toBe(
    '▾ Pipelines  0 watching · 0 succeeded · 0 failed · 1 not watched',
  )
  // The task that waited on it says it will not close by itself any more.
  expect(await texts(ui)).toContain('⧗ app main is no longer watched — this task does not close by itself')
  await ui.unmount()
})

test("a commit's several runs show on its row: how many, each one's state, and each one's own link", async ($, on) => {
  const disk = makeDisk()
  const iso = new Date(T0).toISOString()
  const sha = 'c'.repeat(40)
  const key = `gh:o/r@${sha}`
  put(disk, `${DIR}/s-other.json`, {
    ...other('s-other', 'site', T0, { now: 'pushed' }),
    pipelines: [
      {
        key,
        provider: 'github',
        project: 'o/r',
        id: 12,
        sha,
        ref: 'main',
        label: 'r',
        state: 'running',
        url: 'https://github.com/o/r/actions/runs/12',
        runs: [
          { id: 12, state: 'running', name: 'CI', url: 'https://github.com/o/r/actions/runs/12' },
          { id: 11, state: 'success', name: 'Labeler', url: 'https://github.com/o/r/actions/runs/11' },
          { id: 10, state: 'failed', name: 'Docs' },
        ],
        jobs: [
          { name: 'unit', stage: 'CI', state: 'running', durationS: null },
          { name: 'label', stage: 'Labeler', state: 'success', durationS: 3 },
          { name: 'links', stage: 'Docs', state: 'failed', durationS: 9 },
        ],
        addedAt: iso,
        checkedAt: iso,
      },
    ],
  })
  engine(on, disk)
  await start($)
  const ui = await pane($, 140)
  const row = `pipe:s-other:${key}`
  // The row is the commit's, not one run's: it says how many runs it stands for, not one run's id.
  expect((await ui.find({ type: 'Button', key: row }))?.text).toBe('● ▸ r · 3 runs · main')
  // Folded: one line of the runs, each with its own mark and colour.
  expect((await exactText(ui, '● CI'))?.props.color).toBe('yellow')
  expect((await exactText(ui, '✓ Labeler'))?.props.color).toBe('green')
  expect((await exactText(ui, '✗ Docs'))?.props.color).toBe('red')
  // Open: a row per run with its state and its own page, above the jobs.
  await ui.press({ key: row })
  const lines = await texts(ui)
  expect(lines).toContain('● CI  running')
  expect(lines).toContain('✓ Labeler  success')
  expect(lines).toContain('✗ Docs  failed')
  const links = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
  expect(links).toContain('https://github.com/o/r/actions/runs/11')
  expect(lines.some(l => l.startsWith('● unit'))).toBe(true)
  await ui.unmount()
})
