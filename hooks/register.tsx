import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Loaded, Phase, Progress } from '../types'
import { t } from './i18n'
import { resolveProgressFile } from './paths'

const PANE = 'progress'
// Tools that may have rewritten the file: re-check it (one stat) after each of them.
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit'])

const loaded = atom({ plugin: 'progress-panel', key: 'loaded' } as const, { mtimeMs: 0 } as Loaded, {
  shape: 'loaded-2',
})

const ORDER: Record<string, number> = { blocked: 0, doing: 1, todo: 2, done: 3, skipped: 4 }
const MARK: Record<string, { sign: string; color?: string }> = {
  blocked: { sign: '✗', color: 'red' },
  doing: { sign: '●', color: 'yellow' },
  todo: { sign: '○' },
  done: { sign: '✓', color: 'green' },
  skipped: { sign: '–' },
}

export function sortPhases(phases: readonly Phase[]): Phase[] {
  return [...phases].sort((a, b) => (ORDER[a.status] ?? 2) - (ORDER[b.status] ?? 2))
}

function isClosed(phase: Phase): boolean {
  return phase.status === 'done' || phase.status === 'skipped'
}

// Where the file is: the option, else CLAUDE_CONFIG_DIR, else ~/.claude (HOME, or USERPROFILE on Windows).
async function progressFile($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  const option = typeof options.progressFile === 'string' ? options.progressFile : ''
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  return resolveProgressFile(option, { home, configDir })
}

// Reads the file when its mtime moved; a missing or broken file shows as an error line instead.
async function refresh($: EngineInterface, options: PluginOptions): Promise<void> {
  const file = await progressFile($, options)
  if (!file) {
    await update($, loaded, () => ({ mtimeMs: 0, error: t('error.noHome') }))
    return
  }
  const stat = await $.fs.stat(file).catch(() => undefined)
  if (!stat) {
    await update($, loaded, () => ({ mtimeMs: 0, error: t('error.notFound', { file }) }))
    return
  }
  const before = await read($, loaded)
  if (stat.mtimeMs === before.mtimeMs && !before.error) return
  try {
    const progress = JSON.parse(await $.fs.read(file)) as Progress
    await update($, loaded, () => ({ mtimeMs: stat.mtimeMs, progress }))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await update($, loaded, () => ({ mtimeMs: stat.mtimeMs, error: t('error.unreadable', { file, reason }) }))
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'progress', description: t('command.description') })
    await refresh($, options)
    void $.ui.open({ id: PANE, title: t('pane.title') })
    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    await refresh($, options)
    await $.ui.open({ id: PANE, title: t('pane.title') })
    return { text: t('command.opened') }
  })

  // Never in the tool's way: if the refresh fails, the call's own result still stands.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (WRITERS.has(e.tool)) await refresh($, options)
    return ran
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { progress, error } = await read($, loaded)
    const phases = sortPhases(progress?.phases ?? [])
    const open = phases.filter(p => !isClosed(p)).length
    const needsYou = progress?.needsYou ?? []

    return (
      <Box flexDirection="column">
        {error && <Text color="red">{error}</Text>}
        {progress?.updated && <Text dimColor>{t('pane.updated', { when: progress.updated })}</Text>}
        {progress?.now && <Text>{progress.now}</Text>}
        {needsYou.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="magenta">
              {t('pane.needsYou')}
            </Text>
            {needsYou.map(item => (
              <Text color="magenta">• {item}</Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          {phases.map(p => {
            const mark = MARK[p.status] ?? { sign: '?' }
            const closed = isClosed(p)
            return (
              <Box flexDirection="column">
                <Text color={mark.color} dimColor={closed} bold={!closed}>
                  {mark.sign} {p.title}
                </Text>
                {!closed && p.note && <Text dimColor> {p.note}</Text>}
              </Box>
            )
          })}
        </Box>
        {phases.length > 0 && (
          <Text dimColor>{t('pane.summary', { open, closed: phases.length - open })}</Text>
        )}
      </Box>
    )
  })
}
