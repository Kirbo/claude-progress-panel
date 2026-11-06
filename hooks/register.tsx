import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Folds, Loaded, SortChoice } from '../types'
import { t } from './i18n'
import type { SessionFile, SortBy, Task, UpdateInput } from './model'
import {
  applyUpdate,
  clearDone,
  dismissTasks,
  formatClock,
  formatTime,
  isClosed,
  newSession,
  parseSessionFile,
  pruneDone,
  SORTS,
  sortTasks,
} from './model'
import { baseName, resolveProgressDir } from './paths'

const PANE = 'progress'
const TOOL = 'progress_update'
const TOOL_ID = `mcp__progress-panel__${TOOL}`
// No file-watch API exists for plugins, so other sessions' files are noticed by listing the
// folder on this timer (a file is read only when its mtime moved). Own writes redraw at once.
const REFRESH_MS = 2000
// A check older than this many refresh periods is shown as stale (the timer or the folder failed).
const STALE_AFTER_MS = 5 * REFRESH_MS
const DAY_MS = 24 * 3_600_000
const SORT_KEY = 'sortTasksBy'

const sessions = atom({ plugin: 'progress-panel', key: 'sessions' } as const, {} as Loaded, {
  shape: 'sessions-1',
})
const folds = atom({ plugin: 'progress-panel', key: 'folds' } as const, {} as Folds, { shape: 'folds-1' })
// When the last successful folder listing finished, so the header can show the pane is live.
const checked = atom({ plugin: 'progress-panel', key: 'checked' } as const, 0, { shape: 'checked-1' })
// The order the pane draws in, mirrored from $.store (kept per user across sessions) so a change redraws.
const sorting = atom({ plugin: 'progress-panel', key: 'sort' } as const, '' as SortChoice, {
  shape: 'sort-1',
})

// Needs-you items already announced, so a toast fires once per new item (module-local: a reload
// starts quiet again, seeded on its first scan).
let seenNeeds: Set<string> | undefined

const MARK: Record<string, { sign: string; color?: string }> = {
  blocked: { sign: '✗', color: 'red' },
  doing: { sign: '●', color: 'yellow' },
  todo: { sign: '○' },
  done: { sign: '✓', color: 'green' },
  skipped: { sign: '–' },
}

const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    now: { type: 'string', description: 'One line: what you are doing now and what comes next.' },
    needsYou: {
      type: 'array',
      items: { type: 'string' },
      description: 'Everything only the user can do or decide right now; [] clears it.',
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done', 'skipped'] },
          note: { type: 'string' },
        },
      },
    },
    remove: { type: 'array', items: { type: 'string' } },
  },
}

function optionNumber(options: PluginOptions, name: string, fallback: number): number {
  const raw = options[name]
  if (raw === undefined || raw === '') return fallback
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function optionString(options: PluginOptions, name: string): string {
  const raw = options[name]
  return typeof raw === 'string' ? raw : ''
}

async function progressDir($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  return resolveProgressDir(optionString(options, 'progressDir'), { home, configDir })
}

async function nowIso($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

// Writes a session file whole and records what was written, so the pane redraws at once.
async function save($: EngineInterface, dir: string, file: SessionFile): Promise<void> {
  const path = `${dir}/${file.session.id}.json`
  await $.fs.write(path, `${JSON.stringify(file, null, 2)}\n`)
  const stat = await $.fs.stat(path).catch(() => undefined)
  await update($, sessions, all => ({ ...all, [file.session.id]: { mtimeMs: stat?.mtimeMs ?? 0, file } }))
}

// This session's file as it is on disk now; a fresh one when there is none (first write, or after /clear).
async function ownFile($: EngineInterface, dir: string): Promise<SessionFile> {
  const id = await $.session.id()
  const text = await $.fs.read(`${dir}/${id}.json`).catch(() => undefined)
  const existing = text === undefined ? undefined : parseSessionFile(text)
  if (existing) return existing
  const cwd = await $.session.cwd()
  const repo = await $.session.repo().catch(() => null)
  return newSession({ id, project: baseName(repo?.root ?? cwd), cwd }, await nowIso($))
}

// Re-reads one session's file and applies a change to it (a press on any session's row).
async function changeSession(
  $: EngineInterface,
  options: PluginOptions,
  id: string,
  change: (file: SessionFile) => SessionFile,
): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const text = await $.fs.read(`${dir}/${id}.json`).catch(() => undefined)
  const file = text === undefined ? undefined : parseSessionFile(text)
  if (!file) return
  const next = change(file)
  if (next !== file) await save($, dir, next)
}

// The plugin API has no file delete: the platform's own command removes the file.
async function deleteFile($: EngineInterface, path: string): Promise<void> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows ? ['cmd', '/c', 'del', '/q', path.replace(/\//g, '\\')] : ['rm', '-f', path]
  await $.process.run(argv).catch(() => undefined)
}

async function forgetSession($: EngineInterface, options: PluginOptions, id: string): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  await deleteFile($, `${dir}/${id}.json`)
  await update($, sessions, all => {
    const { [id]: _gone, ...rest } = all
    return rest
  })
}

function liveNeeds(all: Loaded): { project: string; item: string; key: string }[] {
  return Object.values(all)
    .filter(s => s.file.session.endedAt === null)
    .sort((a, b) => Date.parse(b.file.updatedAt) - Date.parse(a.file.updatedAt))
    .flatMap(s =>
      s.file.needsYou.map(item => ({
        project: s.file.session.project,
        item,
        key: `${s.file.session.id}\u0000${item}`,
      })),
    )
}

// The status line, and a toast for each ask another session raised since the last look.
async function announce($: EngineInterface, all: Loaded, me: string): Promise<void> {
  const needs = liveNeeds(all)
  await $.ui.status(needs.length > 0 ? t('status.needsYou', { count: needs.length }) : undefined)
  if (seenNeeds) {
    for (const n of needs) {
      if (!seenNeeds.has(n.key) && !n.key.startsWith(`${me}\u0000`)) {
        await $.ui.toast(t('toast.needsYou', { project: n.project, item: n.item }))
      }
    }
  }
  seenNeeds = new Set(needs.map(n => n.key))
}

// One refresh: list the folder, read what changed, apply retention, update the status line.
async function scan($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const entries = await $.fs.list(dir).catch(() => undefined)
  // A failed listing keeps what the pane knows; its `checked` stamp then ages into "stale".
  if (!entries) return
  const before = await read($, sessions)
  const next: Loaded = {}
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const known = before[entry.name.slice(0, -'.json'.length)]
    if (known && known.mtimeMs === entry.mtimeMs) {
      next[known.file.session.id] = known
      continue
    }
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
    const file = text === undefined ? undefined : parseSessionFile(text)
    if (file) next[file.session.id] = { mtimeMs: entry.mtimeMs, file }
  }
  await update($, sessions, () => next)

  const nowMs = await $.clock.now()
  const me = await $.session.id()
  const doneHours = optionNumber(options, 'autoClearDoneHours', 0)
  const keepDays = optionNumber(options, 'keepEndedSessionsDays', 7)
  for (const { file } of Object.values(next)) {
    const ended = file.session.endedAt
    if (ended !== null && keepDays > 0 && Date.parse(ended) < nowMs - keepDays * DAY_MS) {
      await forgetSession($, options, file.session.id)
      continue
    }
    // Only the owner prunes a live session's file; an ended one is anyone's to prune.
    if (file.session.id !== me && ended === null) continue
    const pruned = pruneDone(file, doneHours, nowMs)
    if (pruned !== file) await save($, dir, pruned)
  }
  await announce($, await read($, sessions), me)
  await update($, checked, () => nowMs)
}

function summarize(file: SessionFile, errors: readonly string[]): string {
  const lines = [t('tool.saved', { count: file.tasks.length })]
  for (const task of file.tasks) lines.push(`${task.id} ${task.status} ${task.title}`)
  if (errors.length > 0) lines.push(t('tool.problems'), ...errors)
  return lines.join('\n')
}

async function runUpdate($: EngineInterface, options: PluginOptions, input: UpdateInput): Promise<string> {
  const dir = await progressDir($, options)
  if (!dir) return t('tool.noDir')
  const { file, errors } = applyUpdate(await ownFile($, dir), input, await nowIso($))
  await save($, dir, file)
  await announce($, await read($, sessions), file.session.id)
  return summarize(file, errors)
}

async function markEnded($: EngineInterface, options: PluginOptions): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  const file = await ownFile($, dir)
  await save($, dir, { ...file, session: { ...file.session, endedAt: await nowIso($) } })
}

function asSort(value: unknown): SortBy | undefined {
  return typeof value === 'string' && (SORTS as readonly string[]).includes(value)
    ? (value as SortBy)
    : undefined
}

async function sortBy($: EngineInterface, options: PluginOptions): Promise<SortBy> {
  return (
    asSort(await read($, sorting)) ??
    asSort(await $.store.get(SORT_KEY)) ??
    asSort(optionString(options, 'sortTasksBy')) ??
    'status'
  )
}

async function cycleSort($: EngineInterface, options: PluginOptions): Promise<void> {
  const current = await sortBy($, options)
  const next = SORTS[(SORTS.indexOf(current) + 1) % SORTS.length] as SortBy
  await $.store.set(SORT_KEY, next)
  await update($, sorting, () => next)
}

async function toggle($: EngineInterface, key: string, isOpenNow: boolean): Promise<void> {
  await update($, folds, all => ({ ...all, [key]: !isOpenNow }))
}

function lastActivity(file: SessionFile): number {
  return Date.parse(file.session.endedAt ?? file.updatedAt) || 0
}

// This session first, then live sessions by newest update, then ended ones by when they ended.
function orderSessions(all: Loaded, me: string): SessionFile[] {
  return Object.values(all)
    .map(s => s.file)
    .sort((a, b) => {
      if (a.session.id === me) return -1
      if (b.session.id === me) return 1
      const aEnded = a.session.endedAt !== null
      const bEnded = b.session.endedAt !== null
      if (aEnded !== bEnded) return aEnded ? 1 : -1
      return lastActivity(b) - lastActivity(a)
    })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'progress', description: t('command.description') })
    await $.tool.register({
      name: TOOL,
      description: t('tool.description'),
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    const dir = await progressDir($, options)
    if (dir) await save($, dir, await ownFile($, dir))
    await scan($, options)
    $.clock.every(REFRESH_MS, () => void scan($, options))
    void $.ui.open({ id: PANE, title: t('pane.title') })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await markEnded($, options)
    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    await scan($, options)
    await $.ui.open({ id: PANE, title: t('pane.title') })
    return { text: t('command.opened') }
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    const input = e as unknown as UpdateInput
    const text = await runUpdate($, options, {
      now: input.now,
      needsYou: input.needsYou,
      tasks: input.tasks,
      remove: input.remove,
    })
    return { result: text }
  }).catch(() => ({ result: t('tool.failed') }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, sessions)
    const folded = await read($, folds)
    const lastCheck = await read($, checked)
    const me = await $.session.id()
    const nowMs = await $.clock.now()
    const by = await sortBy($, options)
    const ordered = orderSessions(all, me)
    const live = ordered.filter(f => f.session.endedAt === null)
    const needs = liveNeeds(all)
    const newest = [...ordered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]

    if (!newest) return <Text dimColor>{t('pane.empty')}</Text>

    const taskRow = (task: Task) => {
      const mark = MARK[task.status] ?? { sign: '?' }
      return (
        <Box flexDirection="column">
          <Text color={mark.color} bold>
            {`${mark.sign} ${task.title}`}
          </Text>
          {task.note ? <Text dimColor>{`  ${task.note}`}</Text> : null}
        </Box>
      )
    }

    const doneRow = (sessionId: string, task: Task) => (
      <Box flexDirection="row" gap={2}>
        <Text dimColor>
          {t(task.status === 'done' ? 'pane.doneItem' : 'pane.skippedItem', {
            title: task.title,
            when: formatTime(task.doneAt ?? task.updatedAt, nowMs),
          })}
        </Text>
        <Button
          key={`dismiss:${sessionId}:${task.id}`}
          label={t('pane.dismiss')}
          plain
          dimColor
          onPress={() => void changeSession($, options, sessionId, f => dismissTasks(f, [task.id]))}
        />
      </Box>
    )

    const group = (file: SessionFile) => {
      const id = file.session.id
      const ended = file.session.endedAt
      const open = sortTasks(
        file.tasks.filter(x => !isClosed(x.status)),
        by,
      )
      const done = sortTasks(
        file.tasks.filter(x => isClosed(x.status)),
        by === 'status' ? 'done' : by,
      )
      const groupKey = `group:${id}`
      const doneKey = `done:${id}`
      const isOpen = folded[groupKey] ?? ended === null
      const isDoneOpen = folded[doneKey] ?? false
      const name = id === me ? t('pane.thisSession', { project: file.session.project }) : file.session.project
      const label = t(ended === null ? 'pane.groupLive' : 'pane.groupEnded', {
        fold: isOpen ? '▾' : '▸',
        name,
        when: formatTime(ended ?? file.updatedAt, nowMs),
        open: open.length,
        done: done.length,
      })
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Button
              key={groupKey}
              label={label}
              plain
              dimColor={ended !== null}
              onPress={() => void toggle($, groupKey, isOpen)}
            />
            {ended !== null ? (
              <Button
                key={`forget:${id}`}
                label={t('pane.forget')}
                plain
                dimColor
                onPress={() => void forgetSession($, options, id)}
              />
            ) : null}
          </Box>
          {isOpen ? (
            <Box flexDirection="column" paddingLeft={2}>
              {open.map(taskRow)}
              {done.length > 0 ? (
                <Box flexDirection="row" gap={2}>
                  <Button
                    key={doneKey}
                    label={t('pane.doneSection', { fold: isDoneOpen ? '▾' : '▸', count: done.length })}
                    plain
                    dimColor
                    onPress={() => void toggle($, doneKey, isDoneOpen)}
                  />
                  <Button
                    key={`clear:${id}`}
                    label={t('pane.clearAll')}
                    plain
                    dimColor
                    onPress={() => void changeSession($, options, id, clearDone)}
                  />
                </Box>
              ) : null}
              {isDoneOpen ? done.map(task => doneRow(id, task)) : null}
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {`${t('pane.updated', { when: formatTime(newest.updatedAt, nowMs), project: newest.session.project })} · `}
          {nowMs - lastCheck > STALE_AFTER_MS ? (
            <Text color="yellow">{t('pane.checkedStale', { when: formatClock(lastCheck) })}</Text>
          ) : (
            t('pane.checked', { when: formatClock(lastCheck) })
          )}
        </Text>
        {needs.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold inverse color="magenta">
              {t('pane.needsYou', { count: needs.length })}
            </Text>
            {needs.map(n => (
              <Text bold color="magenta">
                {t('pane.needsYouItem', { project: n.project, item: n.item })}
              </Text>
            ))}
          </Box>
        ) : null}
        {live.some(f => f.now) ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{t('pane.now')}</Text>
            {live
              .filter(f => f.now)
              .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
              .map(f => (
                <Text>{t('pane.nowItem', { project: f.session.project, now: f.now ?? '' })}</Text>
              ))}
          </Box>
        ) : null}
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Text bold>{t('pane.sessions')}</Text>
          <Button
            key="sort"
            label={t('pane.sort', { by: t(`sort.${by}`) })}
            plain
            dimColor
            onPress={() => void cycleSort($, options)}
          />
        </Box>
        {ordered.map(group)}
      </Box>
    )
  })
}
