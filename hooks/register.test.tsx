import type { TestBody } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

import { resolveProgressFile } from './paths'

type On = Parameters<TestBody>[1]

const PANE = {
  plugin: 'progress-panel',
  component: 'Pane',
  requestId: 'progress',
  props: {
    title: 'Progress',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

const PROGRESS = {
  now: 'Watching the pipeline',
  needsYou: ['push OK for the release'],
  updated: '2026-11-06 21:45',
  phases: [
    { title: 'Finished thing', status: 'done', note: 'hidden note' },
    { title: 'Stuck thing', status: 'blocked', note: 'why it is stuck' },
    { title: 'Busy thing', status: 'doing' },
  ],
}

type Disk = { files: Record<string, { text: string; mtimeMs: number }>; reads: string[] }

// Stands in for the engine: a home directory, an optional CLAUDE_CONFIG_DIR and a tiny disk.
function engine(on: On, disk: Disk, env: Record<string, string> = { HOME: '/home/me' }) {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.stat', (_, e) => {
    const file = disk.files[e.path]
    return file
      ? { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
      : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', (_, e) => {
    disk.reads.push(e.path)
    return { value: disk.files[e.path]?.text ?? '' }
  })
}

function diskWith(path: string, value: unknown): Disk {
  return { files: { [path]: { text: JSON.stringify(value), mtimeMs: 1 } }, reads: [] }
}

test('resolveProgressFile: the option wins, ~ expands, else the Claude config dir', () => {
  expect(resolveProgressFile('/abs/p.json', { home: '/h' })).toBe('/abs/p.json')
  expect(resolveProgressFile('~/notes/p.json', { home: '/h' })).toBe('/h/notes/p.json')
  expect(resolveProgressFile('', { home: '/h' })).toBe('/h/.claude/progress.json')
  expect(resolveProgressFile('', { home: '/h', configDir: '/cfg/' })).toBe('/cfg/progress.json')
  expect(resolveProgressFile('  ', { home: 'C:\\Users\\me' })).toBe('C:\\Users\\me/.claude/progress.json')
  expect(resolveProgressFile('', {})).toBeUndefined()
})

test('the pane shows now, needs-you and open phases with notes, on every surface', async ($, on) => {
  engine(on, diskWith('/home/me/.claude/progress.json', PROGRESS))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Watching/ }))?.text).toBe('Watching the pipeline')
    expect((await ui.find({ type: 'Text', text: /push OK/ }))?.text).toBe('• push OK for the release')
    expect((await ui.find({ type: 'Text', text: /Stuck thing/ }))?.text).toBe('✗ Stuck thing')
    expect((await ui.find({ type: 'Text', text: /Busy thing/ }))?.text).toBe('● Busy thing')
    expect(await ui.find({ type: 'Text', text: /why it is stuck/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /hidden note/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /open ·/ }))?.text).toBe('2 open · 1 done/skipped')
    await ui.unmount()
  }
})

test('CLAUDE_CONFIG_DIR moves the default file', async ($, on) => {
  const disk = diskWith('/cfg/progress.json', PROGRESS)
  engine(on, disk, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(disk.reads).toEqual(['/cfg/progress.json'])
})

test(
  'the progressFile option names the file',
  { options: { progressFile: '/elsewhere/p.json' } },
  async ($, on) => {
    const disk = diskWith('/elsewhere/p.json', { now: 'from the option' })
    engine(on, disk)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /from the option/ }))?.text).toBe('from the option')
    await ui.unmount()
  },
)

test('a missing file shows where the pane looked', async ($, on) => {
  engine(on, { files: {}, reads: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /not found/ }))?.text).toBe(
    '/home/me/.claude/progress.json not found',
  )
  await ui.unmount()
})

test('broken JSON shows an error instead of the old state', async ($, on) => {
  engine(on, { files: { '/home/me/.claude/progress.json': { text: '{ nope', mtimeMs: 1 } }, reads: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /cannot read/ }))?.text).toMatch(
    /^cannot read .*progress\.json:/,
  )
  await ui.unmount()
})

test('a write re-reads the file only when it changed', async ($, on) => {
  const disk = diskWith('/home/me/.claude/progress.json', { now: 'first' })
  engine(on, disk)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Bash', command: 'true' })
  expect(disk.reads).toHaveLength(1)

  disk.files['/home/me/.claude/progress.json'] = { text: JSON.stringify({ now: 'second' }), mtimeMs: 2 }
  await $.tool.call({ tool: 'Write', file_path: '/home/me/.claude/progress.json', content: '' })
  expect(disk.reads).toHaveLength(2)

  await $.tool.call({ tool: 'Read', file_path: '/x' })
  expect(disk.reads).toHaveLength(2)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /second/ }))?.text).toBe('second')
  await ui.unmount()
})

test('/progress reopens the pane', async ($, on) => {
  engine(on, diskWith('/home/me/.claude/progress.json', PROGRESS))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const answer = await $.command.run({
    command: 'progress',
    args: '',
    origin: { kind: 'sdk' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(answer).toMatchObject({ text: 'Progress pane opened.' })
})
