// The Progress pane: how the sessions, their tasks, agents and pipelines are drawn, and Settings.

import type { EngineInterface, MatchedHook, PluginOptions, RenderChildren } from 'claude-code'
import type { AgentEntry, Loaded } from '../types'
import { cancellable, cancelPipeline } from './forge'
import { t, tn } from './i18n'
import type { SessionFile, SortBy, Status, Task } from './model'
import {
  agentDismissal,
  agentHasInside,
  attentionFor,
  capNewest,
  displayWidth,
  formatClock,
  formatTime,
  groupWorkByRepo,
  isBlank,
  isClosed,
  linkedAgent,
  matchesTask,
  modelLabel,
  OTHER_REPO,
  removalKey,
  SORTS,
  sortTasks,
  splitMatches,
  stepCounts,
  taskPipeline,
  timeLeft,
  visibleAgents,
  visibleTasks,
} from './model'
import type { JobState, Pipeline } from './pipelines'
import {
  formatDuration,
  formatEstimate,
  isFinished,
  jobCounts,
  overlayPipelines,
  pipelineDuration,
  progressBar,
  shownError,
  stageGroups,
  visiblePipelines,
} from './pipelines'
import {
  announce,
  askLine,
  isSolo,
  liveNeeds,
  minutesSince,
  nameIn,
  ownManifest,
  scoped,
  setToggle,
  toggle,
} from './session'
import { groupSettings, isChangedSetting, tint, valueTone } from './settings'
import {
  CONFIRM_MS,
  FINISHED_KEY,
  optionString,
  type PANE,
  readArmed,
  readChecked,
  readConfigTick,
  readFiltering,
  readFolds,
  readReleasing,
  readSessions,
  readSorting,
  readViewing,
  SORT_KEY,
  STALE_AFTER_MS,
  self,
  switches,
  updateArmed,
  updateConfigTick,
  updateFiltering,
  updateFolds,
  updateSorting,
  updateViewing,
} from './state'
import { dismiss, exclusive, forgetSession, ownFile, progressDir, save, writeSidecar } from './store'
import type { Feature } from './toggles'
import { defaultsFrom, effective, FEATURES } from './toggles'
import { isNewer } from './update'

/** A pointer over a pipeline or job row lights the whole row (a theme key: dim on dark and light
 *  themes alike), so the ↗ at its right edge is visibly that row's. */
export const ROW_HOVER = { backgroundColor: 'subtle' } as const

export const JOB_MARK: Record<JobState | 'unknown', { sign: string; color?: string }> = {
  success: { sign: '✓', color: 'green' },
  failed: { sign: '✗', color: 'red' },
  running: { sign: '●', color: 'yellow' },
  queued: { sign: '○' },
  skipped: { sign: '–' },
  canceled: { sign: '×' },
  manual: { sign: '»' },
  unknown: { sign: '?' },
}

// One indent step (columns) per level: section → item → details → jobs. Rows with an action (✕,
// Clear all) are full-width, the label left and the action on the pane's right edge.
export const INDENT = 2

// Cells a task row keeps on its right (`██████░░ 12/14  ✕`): what a title is measured against.
export const TASK_RIGHT_COLS = 18

export const COUNT_ORDER: JobState[] = [
  'running',
  'queued',
  'skipped',
  'success',
  'failed',
  'canceled',
  'manual',
]

export const COUNT_COLOR: Partial<Record<JobState, string>> = {
  running: 'yellow',
  success: 'green',
  failed: 'red',
}

// A pipeline's own state on its row: a live one in the running / queued colour behind its mark and
// in bold, a finished one dimmed but for the outcome's colour (2026-11-08: "it's too easy now not to
// notice a new running pipeline").
export const PIPE_STATE_COLOR: Partial<Record<JobState | 'unknown', string>> = {
  running: 'yellow',
  queued: 'cyan',
  success: 'green',
  failed: 'red',
  manual: 'magenta',
}

export const PIPE_LIVE_MARK: Partial<Record<JobState | 'unknown', string>> = {
  running: '● ',
  queued: '○ ',
  unknown: '○ ',
}

// Always shown, even at 0 (the rest only when present): the line reads the same way every time.
export const ALWAYS_COUNTED = new Set<JobState>(['running', 'queued', 'skipped', 'success', 'failed'])

// `dim`: closed without being done — the row reads as set aside, its reason beneath it.
export const MARK: Record<string, { sign: string; color?: string; dim?: true }> = {
  // Blocked = waiting (usually on the person): the Needs-you mark and colour, never a failure's ✗.
  blocked: { sign: '⚠', color: 'magenta' },
  doing: { sign: '●', color: 'yellow' },
  todo: { sign: '○' },
  done: { sign: '✓', color: 'green' },
  // Failed = tried and could not be done: the pipelines' red ✗.
  failed: { sign: '✗', color: 'red' },
  skipped: { sign: '–', dim: true },
  // An agent stopped with the step still open (set by the plugin, never reported).
  unfinished: { sign: '–', dim: true },
}

/** The line beneath a task / step: its note — for an `unfinished` one without its own, why it is. */
// The line beneath a task / agent / step that waits on the person.
/** The words for what a row waits on; an ask's are `file`'s, worded for this pane (`isHere`). */
export function waitReasons(file: SessionFile, isHere: boolean) {
  return {
    permission: (what: string) => t('wait.permission', { what }),
    reply: () => t('wait.reply'),
    ask: (text: string) => askLine(file, text, isHere),
  }
}

/** How the line beneath a row reads: why something is blocked or failed, and what waits on the
 *  person, is the text that matters most on the pane — plain (a wait in the Needs-you colour),
 *  never dimmed like a note on work that goes on or was set aside. */
export function reasonStyle(status: Status, waits: boolean): { dimColor?: true; color?: string } {
  if (waits) return { color: tint(self.settings.palette, 'magenta') }
  return status === 'blocked' || status === 'failed' ? {} : { dimColor: true }
}

export function reasonOf(item: { status: Status; note?: string }): string | undefined {
  if (item.note) return item.note
  return item.status === 'unfinished' ? t('pane.unfinishedReason') : undefined
}

// A default for new sessions written where `/plugin configure` writes it (the plugin's userConfig,
// through the engine); a refusal is shown, never swallowed.
export async function setConfig($: EngineInterface, key: string, value: string): Promise<void> {
  const answer = (await $.config.set({ key, value }).catch((err: unknown) => ({
    deny: err instanceof Error ? err.message : String(err),
  }))) as { deny?: string }
  if (answer.deny) await $.ui.toast(t('settings.refused', { reason: answer.deny }))
  else await updateConfigTick($, n => n + 1)
}

// A choice row pressed: its next option (after the last, the first again).
export async function cycleConfig(
  $: EngineInterface,
  key: string,
  options: readonly string[],
  current: string,
): Promise<void> {
  const at = options.indexOf(current)
  await setConfig($, key, options[(at + 1) % options.length] ?? current)
}

// The running pipeline ✕: the first press arms it (the label asks to confirm), a second within
// CONFIRM_MS does it — never one accidental click.
// ✕ on a running pipeline only hides it (0.23.2) — CI is never touched: this session's own stops
// being watched (and polled); another session's is hidden in the panes through its sidecar.
export async function hidePipeline(
  $: EngineInterface,
  options: PluginOptions,
  sessionId: string,
  p: Pipeline,
): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  if (sessionId === (await $.session.id())) {
    await exclusive(async () => {
      const own = await ownFile($, dir)
      const pipelines = (own.pipelines ?? []).filter(x => x.key !== p.key)
      if (pipelines.length !== (own.pipelines ?? []).length) await save($, dir, { ...own, pipelines })
    })
    await announce($, await readSessions($), sessionId)
    return
  }
  await dismiss($, options, sessionId, [{ id: `pipeline:${p.key}`, doneAt: null }])
}

export async function pressPipelineX(
  $: EngineInterface,
  options: PluginOptions,
  sessionId: string,
  p: Pipeline,
): Promise<void> {
  const nowMs = await $.clock.now()
  const current = await readArmed($)
  if (current && current.key === p.key && nowMs <= current.untilMs) {
    await updateArmed($, () => null)
    await cancelPipeline($, options, sessionId, p)
    return
  }
  await updateArmed($, () => ({ key: p.key, untilMs: nowMs + CONFIRM_MS }))
}

// A switch in the pane: turning REPORTING off silences the whole session, so it takes a second
// press within CONFIRM_MS (the pipeline ✕'s pattern); everything else switches at once.
export async function pressSwitch(
  $: EngineInterface,
  options: PluginOptions,
  f: Feature,
  on: boolean,
): Promise<void> {
  if (f !== 'reporting' || on) {
    await updateArmed($, () => null)
    await setToggle($, options, f, on)
    return
  }
  const nowMs = await $.clock.now()
  const current = await readArmed($)
  if (current?.key === 'switch:reporting' && nowMs <= current.untilMs) {
    await updateArmed($, () => null)
    await setToggle($, options, f, false)
    return
  }
  await updateArmed($, () => ({ key: 'switch:reporting', untilMs: nowMs + CONFIRM_MS }))
}

/** A session header's marker of what is off there (" · paused: reporting", " · off: tasks, agents"). */
export function offMarker(sw: Record<Feature, boolean>): string {
  if (!sw.reporting) return t('pane.pausedReporting')
  const off = FEATURES.filter(f => f !== 'reporting' && !sw[f]).map(f => t(`toggle.feature.${f}`))
  return off.length > 0 ? t('pane.offFeatures', { list: off.join(', ') }) : ''
}

// A ✕ on an open task: the removal goes to that session's sidecar (its own file keeps one writer);
// the session folds it in and tells its agent.
export async function cancelTask(
  $: EngineInterface,
  options: PluginOptions,
  id: string,
  taskId: string,
): Promise<void> {
  const dir = await progressDir($, options)
  if (!dir) return
  await writeSidecar($, dir, id, sidecar =>
    sidecar.cancelled.includes(taskId) ? sidecar : { ...sidecar, cancelled: [...sidecar.cancelled, taskId] },
  )
}

export function asSort(value: unknown): SortBy | undefined {
  return typeof value === 'string' && (SORTS as readonly string[]).includes(value)
    ? (value as SortBy)
    : undefined
}

export async function sortBy($: EngineInterface, options: PluginOptions): Promise<SortBy> {
  return (
    asSort(await readSorting($)) ??
    asSort(await $.store.get(SORT_KEY)) ??
    asSort(optionString(options, 'sortTasksBy')) ??
    'plan'
  )
}

export async function cycleSort($: EngineInterface, options: PluginOptions): Promise<void> {
  const current = await sortBy($, options)
  const next = SORTS[(SORTS.indexOf(current) + 1) % SORTS.length] as SortBy
  await $.store.set(SORT_KEY, next)
  await updateSorting($, () => next)
}

// The Pipelines section's fold is keyed by the pipelines' current states (`pipelines@<signature>`):
// the person's choice holds until a state changes, then the default (open unless every pipeline
// succeeded) applies again. Older signatures are dropped so the fold state does not pile up.
export async function toggleSection($: EngineInterface, key: string, isOpenNow: boolean): Promise<void> {
  await updateFolds($, all => {
    const kept = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith('pipelines@')))
    return { ...kept, [key]: !isOpenNow }
  })
}

export function lastActivity(file: SessionFile): number {
  return Date.parse(file.session.endedAt ?? file.updatedAt) || 0
}

// Sessions with something in them: this session first, then live sessions by newest update, then ended ones by when they ended.
export function orderSessions(all: Loaded, me: string): SessionFile[] {
  return Object.values(all)
    .map(s => s.file)
    .filter(f => !isBlank(f))
    .sort((a, b) => {
      if (a.session.id === me) return -1
      if (b.session.id === me) return 1
      const aEnded = a.session.endedAt !== null
      const bEnded = b.session.endedAt !== null
      if (aEnded !== bEnded) return aEnded ? 1 : -1
      return lastActivity(b) - lastActivity(a)
    })
}

// One drawing of the pane, for the `ui.render` hook register.tsx registers (an `on` call lives in
// `register` itself; what it draws lives here).
type PaneEvent = Parameters<MatchedHook<'ui.render', { component: 'Pane'; requestId: typeof PANE }>>[1]

export async function renderPane($: EngineInterface, e: PaneEvent, options: PluginOptions) {
  const { Box, Text, Button, Input, Link } = $.ui.resolve(e)
  // A row keeps its right-hand parts (bar, counts, time, ✕, ↗) in a fixed column: the left side
  // shrinks and its text is cut with "…" at the room left — the engine measures display width
  // (wide characters count 2) and lays it out again on every resize.
  const leftSide = (...nodes: RenderChildren[]) => (
    <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} gap={1}>
      {nodes}
    </Box>
  )
  const rightSide = (...nodes: RenderChildren[]) => (
    <Box flexDirection="row" flexShrink={0} gap={1}>
      {nodes}
    </Box>
  )
  // Whether `text` would be cut: wider than the pane's body less `used` cells before it (indents,
  // marks) and `reserved` after it (the right column). A cut title shows whole when unfolded.
  const wouldCut = (text: string, used: number, reserved: number) =>
    displayWidth(text) > e.props.bodyColumns - used - reserved
  // A line with nothing on its right (a Now line, a Needs-you item). Fits → the text, no fold.
  // Too long → a fold: folded, ONE line cut with "…" (inside a shrinkable row, so the cut holds
  // instead of the line wrapping); unfolded, the same header line shows the whole text wrapped —
  // once, never repeated beneath it.
  const cutLine = (
    key: string,
    text: string,
    style: { bold?: boolean; color?: string; dimColor?: boolean },
  ) => {
    if (!wouldCut(text, INDENT * 2, 0)) return <Text {...style}>{text}</Text>
    const foldKey = `full:${key}`
    const isOpen = folded[foldKey] ?? false
    return (
      <Box key={`fullbox:${key}`} flexDirection="row">
        {leftSide(
          <Button key={foldKey} label={text} plain onPress={() => void toggle($, foldKey, isOpen)}>
            <Text {...style} {...(isOpen ? {} : { wrap: 'truncate-end' as const })}>
              {`${isOpen ? '▾' : '▸'} ${text}`}
            </Text>
          </Button>,
        )}
      </Box>
    )
  }
  if ((await readViewing($)) === 'settings') {
    // Settings: this session's switches, and the defaults for new sessions — the plugin's own
    // userConfig rows as the engine lists them (their labels, values and options), written back
    // through $.config.set: the one store `/plugin configure` writes too.
    const rows = (await $.config.list().catch(() => [])).filter(r => r.key.startsWith('progress-panel.'))
    // Read for its redraws: a switch's change lands in this session's file, so in this atom; a
    // written setting bumps the tick.
    await readSessions($)
    await readConfigTick($)
    const eff = switches(options)
    const defaultsByField = (await ownManifest($)).defaults
    // Reporting pressed once: its row asks for the second press (`pressSwitch`).
    const armedAt = await readArmed($)
    const settingsNow = await $.clock.now()
    const armedOff = (f: Feature) => armedAt?.key === `switch:${f}` && settingsNow <= armedAt.untilMs
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text bold>{t('settings.title')}</Text>
          <Button
            key="settings:back"
            label={t('settings.back')}
            plain
            onPress={() => void updateViewing($, () => 'main')}
          />
        </Box>
        <Text bold>{t('settings.session')}</Text>
        <Box flexDirection="column" paddingLeft={INDENT}>
          {FEATURES.map(f => {
            const own = typeof self.sessionToggles?.[f] === 'boolean'
            return (
              <Box
                key={`setting:row:${f}`}
                flexDirection="row"
                justifyContent="space-between"
                gap={2}
                hover={ROW_HOVER}
              >
                {leftSide(
                  <Button
                    key={`setting:session:${f}`}
                    label={t('settings.switchRow', {
                      feature: t(`toggle.feature.${f}`),
                      state: t(eff[f] ? 'toggle.on' : 'toggle.off'),
                      source: t(own ? 'toggle.overridden' : 'toggle.default'),
                    })}
                    plain
                    onPress={() => void pressSwitch($, options, f, !eff[f])}
                  >
                    <Text wrap="truncate-end">{t(`toggle.feature.${f}`)}</Text>
                  </Button>,
                )}
                {rightSide(
                  own ? (
                    <Button
                      key={`setting:reset:${f}`}
                      label={t('settings.reset')}
                      plain
                      dimColor
                      onPress={() => void setToggle($, options, f, undefined)}
                    />
                  ) : null,
                  <Text
                    key={`setting:state:${f}`}
                    color={tint(self.settings.palette, armedOff(f) ? 'red' : eff[f] ? 'green' : 'yellow')}
                    bold={own || !eff[f] || armedOff(f)}
                  >
                    {armedOff(f) ? t('settings.confirmOff') : t(eff[f] ? 'settings.on' : 'settings.off')}
                  </Text>,
                  <Text key={`setting:source:${f}`} dimColor>
                    {t(own ? 'settings.sourceSession' : 'settings.sourceDefault')}
                  </Text>,
                )}
              </Box>
            )
          })}
        </Box>
        <Text bold>{t('settings.defaults')}</Text>
        {/* Grouped under small headings; each row: its label on the left (cut with "…" when the
              pane is narrow — never the value), its value in the right column, coloured — on green,
              off yellow, a choice cyan, empty dim — and bold when it differs from its default. */}
        {groupSettings(rows).map(group => (
          <Box key={`setting:group:${group.heading}`} flexDirection="column" paddingLeft={INDENT}>
            <Text dimColor>{t(group.heading)}</Text>
            {group.rows.map(r => {
              const value = String(r.value ?? '')
              const field = r.key.slice(r.key.indexOf('.') + 1)
              const changed = isChangedSetting(value, defaultsByField[field])
              const tone = valueTone(value)
              const color =
                tone === 'on' ? 'green' : tone === 'off' ? 'yellow' : tone === 'choice' ? 'cyan' : undefined
              const shown = (
                <Box key={`setting:value:${r.key}`} flexDirection="row" flexShrink={0} gap={1}>
                  <Text color={tint(self.settings.palette, color)} bold={changed} dimColor={tone === 'empty'}>
                    {tone === 'empty' ? t('settings.empty') : value}
                  </Text>
                  {changed || tone === 'empty' ? null : <Text dimColor>{t('settings.defaultMark')}</Text>}
                </Box>
              )
              return r.options && r.options.length > 0 ? (
                <Box
                  key={`setting:row:${r.key}`}
                  flexDirection="row"
                  justifyContent="space-between"
                  gap={2}
                  hover={ROW_HOVER}
                >
                  {leftSide(
                    <Button
                      key={`setting:${r.key}`}
                      label={t('settings.row', { label: r.label, value })}
                      plain
                      onPress={() => void cycleConfig($, r.key, r.options ?? [], value)}
                    >
                      <Text wrap="truncate-end">{r.label}</Text>
                    </Button>,
                  )}
                  {shown}
                </Box>
              ) : (
                <Box key={`setting:row:${r.key}`} flexDirection="row" justifyContent="space-between" gap={2}>
                  {leftSide(<Text wrap="truncate-end">{t('settings.textLabel', { label: r.label })}</Text>)}
                  <Box flexShrink={0}>
                    <Input
                      key={`setting:input:${r.key}`}
                      placeholder={t('settings.empty')}
                      value={value}
                      onSubmit={next => void setConfig($, r.key, next)}
                    />
                  </Box>
                </Box>
              )
            })}
          </Box>
        ))}
        <Text dimColor>{t('settings.hint')}</Text>
      </Box>
    )
  }
  const me = await $.session.id()
  // The sessions this pane is about (its scope setting): everything below is drawn from these.
  const all = await scoped($, await readSessions($), me)
  const folded = await readFolds($)
  const lastCheck = await readChecked($)
  const nowMs = await $.clock.now()
  const by = await sortBy($, options)
  const query = await readFiltering($)
  const defaults = defaultsFrom(options as Record<string, unknown>)
  const armedNow = await readArmed($)
  // Whether a pane already asked a session to remove something (its sidecar's `cancelled`).
  const removedHere = (sessionId: string, key: string) =>
    (all[sessionId]?.sidecar?.cancelled ?? []).includes(key)
  const mine = switches(options)
  const filteringNow = query.trim() !== ''
  // The filter's hits, inverted (readable on dark and light themes); the text as is without a filter.
  const hl = (text: string) =>
    filteringNow
      ? splitMatches(text, query).map(part => (part.hit ? <Text inverse>{part.text}</Text> : part.text))
      : text
  // A catalog line holding a title: only the title's hits are highlighted, the rest stays as is.
  const hlTitle = (line: string, title: string) => {
    const at = line.indexOf(title)
    if (!filteringNow || at < 0) return line
    return [line.slice(0, at), ...[hl(title)].flat(), line.slice(at + title.length)]
  }
  const release = await readReleasing($)
  const version = (await ownManifest($)).version
  const ordered = orderSessions(all, me)
  const live = ordered.filter(f => f.session.endedAt === null)
  const needs = liveNeeds(all, me)
  // The only open session: nothing names it, and its asks need no "here".
  const solo = isSolo(all, me)
  const isHere = (sessionId: string) => sessionId === me && !solo
  // A session's name among the others shown (two in one repo: `app`, `app #2`).
  const nameOf = (f: SessionFile) => nameIn(all, f)
  // What is asked, and — apart from it — the sessions that only finished a turn.
  const asks = needs.filter(n => n.kind !== 'idle')
  const idle = needs.filter(n => n.kind === 'idle')
  const newest = [...ordered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]

  // Nothing reported yet: the pane still says which copy runs, how to check the setup, and opens
  // Settings — a bare line left a person with a silent pane no way to tell why it is silent.
  if (!newest)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          {leftSide(
            <Text dimColor wrap="truncate-end">
              {t('pane.empty')}
            </Text>,
          )}
          {rightSide(
            version ? <Text dimColor>{t('pane.version', { version })}</Text> : null,
            <Button
              key="settings:open"
              label={t('settings.open')}
              plain
              dimColor
              onPress={() => void updateViewing($, () => 'settings')}
            />,
          )}
        </Box>
        <Text dimColor>{t('pane.emptyHint')}</Text>
      </Box>
    )

  // Every session's pipelines, newest first, minus the finished ones dismissed with ✕.
  const startedMs = (p: Pipeline) => Date.parse(p.startedAt ?? p.addedAt) || 0
  const pipelineRows = ordered
    .flatMap(f =>
      visiblePipelines(
        overlayPipelines(f.pipelines ?? [], all[f.session.id]?.sidecar?.pipelines ?? []),
        all[f.session.id]?.sidecar?.entries ?? [],
      ).map(pipeline => ({
        sessionId: f.session.id,
        pipeline,
      })),
    )
    .sort((a, b) => startedMs(b.pipeline) - startedMs(a.pipeline))
  // Successes older than an hour step aside into the folded "Finished" list.
  const isArchived = (p: Pipeline) => {
    const ended = Date.parse(p.pipelineFinishedAt ?? p.finishedAt ?? '')
    return p.state === 'success' && !Number.isNaN(ended) && ended < nowMs - self.settings.successFoldMs
  }
  const currentRows = pipelineRows.filter(r => !isArchived(r.pipeline))
  const archivedRows = pipelineRows.filter(r => isArchived(r.pipeline))
  const isFinishedOpen = folded[FINISHED_KEY] ?? false

  const states = pipelineRows.map(r => r.pipeline.state)
  const allSucceeded = states.length > 0 && states.every(st => st === 'success')
  const sectionKey = `pipelines@${pipelineRows
    .map(r => `${r.sessionId}:${r.pipeline.key}=${r.pipeline.state}`)
    .sort()
    .join('|')}`
  const isSectionOpen = folded[sectionKey] ?? !allSucceeded
  const stoppedOther = states.filter(st => st === 'canceled' || st === 'skipped').length
  const sectionParts = {
    fold: isSectionOpen ? '▾' : '▸',
    // A watch the plugin stopped polling is not being watched (its row says why).
    watching: pipelineRows.filter(r => !isFinished(r.pipeline.state) && !r.pipeline.stopped).length,
    succeeded: states.filter(st => st === 'success').length,
    failed: states.filter(st => st === 'failed').length,
    rest: stoppedOther > 0 ? t('pane.pipelinesCanceled', { n: stoppedOther }) : '',
  }
  const sectionLabel = t('pane.pipelines', sectionParts)

  // A ↗ that opens a GitLab page in the browser: the surface's own hyperlink (OSC 8 on the
  // terminal), so the click is the terminal's — nothing opens unless the person clicks it.
  const openLink = (url: string | undefined) =>
    url ? (
      <Text dimColor>
        <Link href={url} label={t('pipe.open')} />
      </Text>
    ) : null

  const pipelineBlock = (sessionId: string, p: Pipeline) => {
    const key = `pipe:${sessionId}:${p.key}`
    const finished = isFinished(p.state)
    // Folded by default (compact): header + counts; a press opens the stage/job tree. The choice is
    // kept per run state: unfolded while running, a pipeline folds again once it finishes (it
    // would otherwise reopen unfolded when a new pipeline opens the section).
    const foldKey = finished ? `${key}@${p.finishedAt ?? 'finished'}` : key
    const isOpen = folded[foldKey] ?? false
    const counts = jobCounts(p.jobs)
    const label = t('pipe.header', {
      fold: isOpen ? '▾' : '▸',
      label: p.label,
      id: p.id ?? '?',
      ref: p.ref ? t('pipe.ref', { ref: p.ref }) : '',
    })
    // The state, bar, counts and times sit on the right, beside ↗ / ✕.
    const status = t('pipe.status', {
      state: t(`pipe.state.${p.state}`),
      // The bar only while it runs: a finished pipeline's counts say it all.
      bar: finished ? '' : `${progressBar(counts.finished, counts.total)} `,
      finished: counts.finished,
      total: counts.total,
      duration: ((d: number | null) => {
        if (d === null) return ''
        // While it runs, the elapsed time beside the similar-run estimate: "4m53s / ~33m".
        if (!finished && typeof p.estimateS === 'number')
          return t('pipe.durationEstimate', { d: formatDuration(d), e: formatEstimate(p.estimateS) })
        return t('pipe.duration', { d: formatDuration(d) })
      })(pipelineDuration(p, nowMs)),
      // When it finished, like a done task's time: GitLab's own, else when this pane saw it end.
      ended: ((at: string | undefined) => {
        const when = finished && at ? formatTime(at, nowMs, self.settings.clock) : ''
        return when ? t('pipe.ended', { when }) : ''
      })(p.pipelineFinishedAt ?? p.finishedAt),
    })
    const countParts = COUNT_ORDER.filter(s => ALWAYS_COUNTED.has(s) || counts[s] > 0)
    // Names padded to the widest in this pipeline, so the times line up in a column.
    const width = Math.max(0, ...p.jobs.map(j => j.name.length))
    return (
      <Box flexDirection="column">
        <Box key={`row:${key}`} flexDirection="row" justifyContent="space-between" gap={2} hover={ROW_HOVER}>
          {leftSide(
            <Button key={key} label={label} plain onPress={() => void toggle($, foldKey, isOpen)}>
              {finished ? null : (
                <Text color={tint(self.settings.palette, PIPE_STATE_COLOR[p.state] ?? 'cyan')}>
                  {PIPE_LIVE_MARK[p.state] ?? '● '}
                </Text>
              )}
              <Text bold={!finished} dimColor={finished} wrap="truncate-end">
                {label}
              </Text>
            </Button>,
          )}
          <Box flexDirection="row" flexShrink={0}>
            <Button
              key={`pipestate:${key}`}
              label={status}
              plain
              onPress={() => void toggle($, foldKey, isOpen)}
            >
              <Text
                color={tint(self.settings.palette, PIPE_STATE_COLOR[p.state])}
                bold={!finished || p.state === 'failed'}
                dimColor={p.state === 'canceled' || p.state === 'skipped'}
              >
                {status}
              </Text>
            </Button>
            {openLink(p.url)}
            {/* Running: "⊘ stop" — the destructive one, red and apart, two presses — cancels (and
                  by setting deletes) it in CI; "✕" beside it only hides the row, as on a finished one. */}
            {!finished && self.settings.runningPipelineX !== 'off' && cancellable(p) ? (
              <Box key={`stopbox:${sessionId}:${p.key}`} flexDirection="column">
                <Button
                  key={`cancelpipe:${sessionId}:${p.key}`}
                  label={
                    armedNow?.key === p.key && nowMs <= armedNow.untilMs
                      ? t(
                          self.settings.runningPipelineX === 'delete'
                            ? 'pipe.confirmDelete'
                            : 'pipe.confirmCancel',
                        )
                      : t('pipe.stop')
                  }
                  plain
                  onPress={() => void pressPipelineX($, options, sessionId, p)}
                >
                  <Text
                    color={tint(self.settings.palette, 'red')}
                    bold={armedNow?.key === p.key && nowMs <= armedNow.untilMs}
                  >
                    {armedNow?.key === p.key && nowMs <= armedNow.untilMs
                      ? t(
                          self.settings.runningPipelineX === 'delete'
                            ? 'pipe.confirmDelete'
                            : 'pipe.confirmCancel',
                        )
                      : t('pipe.stop')}
                  </Text>
                </Button>
                <Box position="absolute" top={1} left={0} display="none" hover={{ display: 'flex' }}>
                  <Text dimColor>
                    {t(
                      self.settings.runningPipelineX === 'delete'
                        ? 'pipe.stopHintDelete'
                        : 'pipe.stopHintCancel',
                    )}
                  </Text>
                </Box>
              </Box>
            ) : null}
            {!finished ? (
              <Button
                key={`hidepipe:${sessionId}:${p.key}`}
                label={t('pipe.dismiss')}
                plain
                dimColor
                onPress={() => void hidePipeline($, options, sessionId, p)}
              />
            ) : null}
            {finished && p.finishedAt ? (
              <Button
                key={`unpipe:${sessionId}:${p.key}`}
                label={t('pipe.dismiss')}
                plain
                dimColor
                onPress={() =>
                  void dismiss($, options, sessionId, [
                    { id: `pipeline:${p.key}`, doneAt: p.finishedAt ?? null },
                  ])
                }
              />
            ) : null}
          </Box>
        </Box>
        <Box flexDirection="column" paddingLeft={INDENT * 2}>
          {p.error && shownError(p.error) ? (
            <Text color={tint(self.settings.palette, 'red')}>{shownError(p.error)}</Text>
          ) : null}
          {/* A success folds to its one header line; anything else keeps its counts line. */}
          {counts.total > 0 && (isOpen || p.state !== 'success') ? (
            <Text>
              {countParts.flatMap((state, i) => [
                i > 0 ? <Text dimColor>{' · '}</Text> : null,
                <Text
                  color={tint(self.settings.palette, counts[state] > 0 ? COUNT_COLOR[state] : undefined)}
                  dimColor={counts[state] === 0}
                >
                  {t(`pipe.count.${state}`, { n: counts[state] })}
                </Text>,
              ])}
            </Text>
          ) : null}
          {isOpen
            ? stageGroups(p.jobs).map(group => (
                <Box flexDirection="column">
                  {/* GitHub runs have no stages: their jobs list flat, without a heading. */}
                  {group.stage ? <Text dimColor>{group.stage}</Text> : null}
                  <Box flexDirection="column" paddingLeft={group.stage ? INDENT : 0}>
                    {group.jobs.map(j => {
                      const jm = JOB_MARK[j.state]
                      const est = p.jobEstimates?.[j.name]
                      const elapsed =
                        j.state === 'running' && j.startedAt
                          ? Math.max(0, (nowMs - Date.parse(j.startedAt)) / 1000)
                          : null
                      // Finished: the real time. Running: elapsed / ~estimate. Queued: ~estimate.
                      const duration = isFinished(j.state)
                        ? formatDuration(j.durationS)
                        : elapsed !== null && est !== undefined
                          ? `${formatDuration(elapsed)} / ${formatEstimate(est)}`
                          : elapsed !== null
                            ? formatDuration(elapsed)
                            : est !== undefined
                              ? formatEstimate(est)
                              : ''
                      const line = (
                        <Text
                          color={tint(self.settings.palette, jm.color)}
                          hover={{ underline: true }}
                          wrap="truncate-end"
                        >
                          {t(duration ? 'pipe.jobTimed' : 'pipe.job', {
                            glyph: jm.sign,
                            name: duration ? j.name.padEnd(width) : j.name,
                            duration,
                          })}
                        </Text>
                      )
                      // Every job row is its own hover scope: the row lights and its text
                      // underlines, so the ↗ at the right edge reads as that row's.
                      return (
                        <Box
                          key={`row:${key}:${group.stage}:${j.name}`}
                          flexDirection="row"
                          justifyContent="space-between"
                          gap={2}
                          hover={ROW_HOVER}
                        >
                          {leftSide(line)}
                          {rightSide(openLink(j.url))}
                        </Box>
                      )
                    })}
                  </Box>
                </Box>
              ))
            : null}
        </Box>
      </Box>
    )
  }

  const taskRow = (sessionId: string, given: Task) => {
    let task = given
    // Waiting on the person (a permission prompt, a reply): the Needs-you mark, the reason beneath.
    const waitFile = all[sessionId]?.file
    const wait =
      waitFile && !isClosed(task.status)
        ? attentionFor(waitFile, { task }, waitReasons(waitFile, isHere(sessionId)))
        : undefined
    const mark: { sign: string; color?: string; dim?: true } = (wait ? MARK.blocked : MARK[task.status]) ?? {
      sign: '?',
    }
    // The subagent working on it: its live progress, under the task (its steps stay its own).
    const linkFile = all[sessionId]?.file
    const linked = linkFile && !isClosed(task.status) ? linkedAgent(linkFile, task) : undefined
    const linkLine = linked ? (
      <Box paddingLeft={INDENT}>
        <Text dimColor>
          {(() => {
            const counts = linked.tasks.filter(x => isClosed(x.status)).length
            const left = timeLeft(linked.tasks, linked.startedAt, linked.etaMin)
            if (linked.cancelledAt) return t('pane.linkedAgentStopped', { agent: linked.label })
            return t(linked.endedAt === null ? 'pane.linkedAgent' : 'pane.linkedAgentDone', {
              agent: linked.label,
              steps: linked.tasks.length > 0 ? ` ${counts}/${linked.tasks.length}` : '',
              left: left ? t(left.guess ? 'pane.agentEtaGuess' : 'pane.agentEta', { min: left.min }) : '',
            })
          })()}
        </Text>
      </Box>
    ) : null
    const reason = wait ?? reasonOf(task)
    const note = reason ? (
      <Box paddingLeft={INDENT}>
        <Text {...reasonStyle(task.status, wait !== undefined)}>{hl(reason)}</Text>
      </Box>
    ) : null
    // The pipeline it waits on (0.23.2): its state here — the task closes when it finishes.
    const pipe = linkFile && !isClosed(task.status) ? taskPipeline(linkFile, task) : undefined
    const pipeLine = pipe ? (
      <Box paddingLeft={INDENT}>
        <Text dimColor wrap="truncate-end">
          {t('pane.linkedPipeline', { label: pipe.label ?? pipe.key, state: pipe.state })}
        </Text>
      </Box>
    ) : null
    // Still open and untouched when a turn ended past the end-of-turn check: marked until updated.
    const unconfirmedLine =
      task.unconfirmed && !isClosed(task.status) ? (
        <Box paddingLeft={INDENT}>
          <Text dimColor>{t('pane.unconfirmed', { min: minutesSince(task.updatedAt, nowMs) })}</Text>
        </Box>
      ) : null
    // A linked task shows the agent's own steps (never a copy in the task).
    if (linked) task = { ...task, steps: linked.tasks.map(x => ({ title: x.title, status: x.status })) }
    // Nothing more to show: one plain line.
    // ✕ removes an open task of a live session: it will not be done.
    const live = all[sessionId]?.file.session.endedAt === null
    const remove = live ? (
      <Button
        key={`cancel:${sessionId}:${task.id}`}
        label={t('pane.cancel')}
        plain
        dimColor
        onPress={() => void cancelTask($, options, sessionId, task.id)}
      />
    ) : null
    // A title too long for its line is cut with "…" and the task folds, so it shows whole when open.
    const long = wouldCut(task.title, INDENT * 3 + 4, TASK_RIGHT_COLS)
    if (!task.detail && !task.steps?.length && !long)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            {leftSide(
              <Text
                color={tint(self.settings.palette, mark.color)}
                bold={!mark.dim}
                dimColor={mark.dim}
                wrap="truncate-end"
              >
                {`${mark.sign} `}
                {hl(task.title)}
              </Text>,
            )}
            {rightSide(remove)}
          </Box>
          {note}
          {linkLine}
          {pipeLine}
          {unconfirmedLine}
        </Box>
      )
    // Details or subtasks: the title folds them, its steps counted on the right like a pipeline's jobs.
    const key = `task:${sessionId}:${task.id}`
    // While filtering, a hit inside the detail or the steps unfolds the task, so it shows.
    const hitInside = filteringNow && matchesTask({ ...task, title: '', note: undefined }, query)
    // A task in progress with steps starts open, so what it is on shows without a click; the
    // person's own fold wins, and once it is no longer `doing` it folds back by default.
    const inProgress = task.status === 'doing' && (task.steps?.length ?? 0) > 0
    const isOpen = folded[key] ?? (hitInside || inProgress)
    const steps = stepCounts(task)
    return (
      <Box flexDirection="column">
        <Box key={`row:${key}`} flexDirection="row" justifyContent="space-between" gap={2} hover={ROW_HOVER}>
          {leftSide(
            <Text color={tint(self.settings.palette, mark.color)} bold={!mark.dim} dimColor={mark.dim}>
              {mark.sign}
            </Text>,
            /* A Button label cannot be styled: while filtering, the title moves beside the fold
                 arrow as text, so its hit can be highlighted. */
            <Button
              key={key}
              label={
                filteringNow
                  ? t('pane.foldGlyph', { fold: isOpen ? '▾' : '▸' })
                  : t('pane.taskFold', { fold: isOpen ? '▾' : '▸', title: task.title })
              }
              plain
              onPress={() => void toggle($, key, isOpen)}
            >
              {/* Folded: one line cut with "…"; open: the whole title wraps here — shown once. */}
              <Text {...(isOpen ? {} : { wrap: 'truncate-end' as const })}>
                {filteringNow
                  ? t('pane.foldGlyph', { fold: isOpen ? '▾' : '▸' })
                  : t('pane.taskFold', { fold: isOpen ? '▾' : '▸', title: task.title })}
              </Text>
            </Button>,
            filteringNow ? (
              <Text {...(isOpen ? {} : { wrap: 'truncate-end' as const })}>{hl(task.title)}</Text>
            ) : null,
          )}
          <Box flexDirection="row" flexShrink={0}>
            {steps.total > 0 ? (
              <Text dimColor>
                {t('pane.taskSteps', {
                  bar: progressBar(steps.closed, steps.total),
                  closed: steps.closed,
                  total: steps.total,
                })}
              </Text>
            ) : null}
            {remove}
          </Box>
        </Box>
        {note}
        {linkLine}
        {pipeLine}
        {unconfirmedLine}
        {isOpen ? (
          <Box flexDirection="column" paddingLeft={INDENT * 2}>
            {task.detail ? <Text dimColor>{hl(task.detail)}</Text> : null}
            {(task.steps ?? [])
              // A step a pane removed hides at once, before its session folds the removal in.
              .filter(
                step =>
                  !removedHere(sessionId, removalKey({ kind: 'step', taskId: task.id, step: step.title })),
              )
              .map(step => {
                const m = MARK[step.status] ?? { sign: '?' }
                const stepKey = removalKey({ kind: 'step', taskId: task.id, step: step.title })
                const why = reasonOf(step)
                return (
                  <Box key={`stepbox:${sessionId}:${stepKey}`} flexDirection="column">
                    <Box
                      key={`steprow:${sessionId}:${stepKey}`}
                      flexDirection="row"
                      justifyContent="space-between"
                      gap={2}
                      hover={ROW_HOVER}
                    >
                      {leftSide(
                        <Text
                          color={tint(self.settings.palette, m.color)}
                          dimColor={m.dim}
                          wrap="truncate-end"
                        >
                          {`${m.sign} `}
                          {hl(step.title)}
                        </Text>,
                      )}
                      {rightSide(
                        live && !isClosed(step.status) ? (
                          <Button
                            key={`cancel:${sessionId}:${stepKey}`}
                            label={t('pane.cancel')}
                            plain
                            dimColor
                            onPress={() => void cancelTask($, options, sessionId, stepKey)}
                          />
                        ) : null,
                      )}
                    </Box>
                    {why ? (
                      <Box paddingLeft={INDENT}>
                        <Text {...reasonStyle(step.status, false)}>{hl(why)}</Text>
                      </Box>
                    ) : null}
                  </Box>
                )
              })}
          </Box>
        ) : null}
      </Box>
    )
  }

  // A finished task: ✓ done, – skipped / unfinished, ✗ failed (red) — and why, beneath, for the
  // ones not done.
  const doneRow = (sessionId: string, task: Task) => {
    const why = task.status === 'done' ? undefined : reasonOf(task)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          {leftSide(
            <Text
              dimColor={task.status !== 'failed'}
              color={task.status === 'failed' ? tint(self.settings.palette, 'red') : undefined}
              wrap="truncate-end"
            >
              {hlTitle(
                t(
                  task.status === 'done'
                    ? 'pane.doneItem'
                    : task.status === 'failed'
                      ? 'pane.failedItem'
                      : 'pane.skippedItem',
                  {
                    title: task.title,
                    when: formatTime(task.doneAt ?? task.updatedAt, nowMs, self.settings.clock),
                  },
                ),
                task.title,
              )}
            </Text>,
          )}
          {rightSide(
            <Button
              key={`dismiss:${sessionId}:${task.id}`}
              label={t('pane.dismiss')}
              plain
              dimColor
              onPress={() => void dismiss($, options, sessionId, [task])}
            />,
          )}
        </Box>
        {why ? (
          <Box paddingLeft={INDENT}>
            <Text {...reasonStyle(task.status, false)}>{hl(why)}</Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  // The session's subagents: the running ones in their own section, each folding open to its steps
  // (status + note — a step's own estimate) beside its progress, run time and estimate; the finished
  // ones in a second section, folded by default.
  // A subagent's own steps, each with its mark and — when it is not done — why, beneath it. `live`:
  // its open steps take a ✕ (a finished agent's list is a record, nothing left to stop).
  const agentStepRows = (id: string, a: AgentEntry, live: boolean) =>
    a.tasks
      .filter(step => !removedHere(id, removalKey({ kind: 'agentTask', agentId: a.id, taskId: step.id })))
      .map(step => {
        // The agent waits on the person: its `doing` step carries the Needs-you mark and why.
        const agentWait =
          live && step.status === 'doing' && all[id]?.file
            ? attentionFor(all[id].file, { agent: a }, waitReasons(all[id].file, isHere(id)))
            : undefined
        const m = agentWait
          ? (MARK.blocked as { sign: string; color?: string; dim?: true })
          : (MARK[step.status] ?? { sign: '?' })
        const stepKey = removalKey({ kind: 'agentTask', agentId: a.id, taskId: step.id })
        const why = agentWait ?? reasonOf(step)
        return (
          <Box key={`agentstepbox:${id}:${stepKey}`} flexDirection="column">
            <Box
              key={`agentstep:${id}:${stepKey}`}
              flexDirection="row"
              justifyContent="space-between"
              gap={2}
              hover={ROW_HOVER}
            >
              {leftSide(
                <Text color={tint(self.settings.palette, m.color)} dimColor={m.dim} wrap="truncate-end">
                  {`${m.sign} ${step.title}`}
                </Text>,
              )}
              {rightSide(
                live && !isClosed(step.status) ? (
                  <Button
                    key={`cancel:${id}:${stepKey}`}
                    label={t('pane.cancel')}
                    plain
                    dimColor
                    onPress={() => void cancelTask($, options, id, stepKey)}
                  />
                ) : null,
              )}
            </Box>
            {why ? (
              <Box paddingLeft={INDENT}>
                <Text {...reasonStyle(step.status, agentWait !== undefined)}>{why}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })

  // The session's running agents — or, when its work is grouped by repo, one repo's (`only`, with
  // `scope` keeping that branch's fold key its own).
  const agentsBlock = (file: SessionFile, only?: readonly AgentEntry[], scope = '') => {
    // A session that switched agent reporting off shows no Agents section.
    if (!effective(defaults, file.toggles).agents) return null
    const agents = file.agents ?? []
    const id = file.session.id
    const running = (only ?? agents).filter(a => a.endedAt === null)
    if (running.length === 0) return null
    const runKey = `agents:${id}${scope}`
    const runOpen = folded[runKey] ?? true
    const agentRow = (a: (typeof agents)[number]) => {
      const key = `agent:${id}:${a.id}`
      // A permission prompt or a question of this agent's: the row says so, magenta like Needs you.
      const personWait = attentionFor(file, { agent: a }, waitReasons(file, isHere(id)))
      const hasInside = agentHasInside(a)
      const isOpen = hasInside && (folded[key] ?? true)
      const closed = a.tasks.filter(x => isClosed(x.status)).length
      const steps =
        a.tasks.length > 0
          ? t('pane.agentSteps', {
              bar: progressBar(closed, a.tasks.length),
              done: closed,
              total: a.tasks.length,
            })
          : ''
      const ranS = Math.max(0, (nowMs - Date.parse(a.startedAt)) / 1000)
      const elapsed = Number.isFinite(ranS) ? t('pane.agentElapsed', { d: formatDuration(ranS) }) : ''
      const left = timeLeft(a.tasks, a.startedAt, a.etaMin)
      const eta = left ? t(left.guess ? 'pane.agentEtaGuess' : 'pane.agentEta', { min: left.min }) : ''
      // What it runs on, first on the right: the model (short) and, where it has one, the effort.
      const run = a.model
        ? a.effort
          ? t('pane.agentRun', { model: modelLabel(a.model), effort: a.effort })
          : t('pane.agentRunModel', { model: modelLabel(a.model) })
        : ''
      return (
        <Box flexDirection="column">
          <Box
            key={`row:${key}`}
            flexDirection="row"
            justifyContent="space-between"
            gap={2}
            hover={ROW_HOVER}
          >
            {leftSide(
              hasInside ? (
                <Button
                  key={key}
                  label={t('pane.agentFold', { fold: isOpen ? '▾' : '▸', label: a.label })}
                  plain
                  onPress={() => void toggle($, key, isOpen)}
                >
                  {/* Folded: one cut line; open: the whole label wraps here (shown once). Waiting on the
                      person: the Needs-you mark before it. */}
                  <Text {...(isOpen ? {} : { wrap: 'truncate-end' as const })}>
                    {personWait ? (
                      <Text color={tint(self.settings.palette, 'magenta')} bold>
                        {'⚠ '}
                      </Text>
                    ) : null}
                    {t('pane.agentFold', { fold: isOpen ? '▾' : '▸', label: a.label })}
                  </Text>
                </Button>
              ) : (
                // Nothing to unfold (no report, no tool call seen yet): a plain line, never a fold.
                <Text key={key}>
                  {personWait ? (
                    <Text color={tint(self.settings.palette, 'magenta')} bold>
                      {'⚠ '}
                    </Text>
                  ) : null}
                  {t('pane.agentPlain', { label: a.label })}
                </Text>
              ),
            )}
            <Box flexDirection="row" flexShrink={0} gap={1}>
              <Text dimColor>
                {[
                  run,
                  `${steps}${elapsed}${a.waiting && a.endedAt === null ? t('pane.agentWaiting') : eta}`.replace(
                    /^ · /,
                    '',
                  ),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {/* ✕ on a running subagent: its work is cancelled — it is told to stop and wrap up. */}
              {a.cancelledAt ? null : (
                <Button
                  key={`cancel:${id}:${removalKey({ kind: 'agent', agentId: a.id })}`}
                  label={t('pane.cancel')}
                  plain
                  dimColor
                  onPress={() =>
                    void cancelTask($, options, id, removalKey({ kind: 'agent', agentId: a.id }))
                  }
                />
              )}
            </Box>
          </Box>
          {personWait ? (
            <Box paddingLeft={INDENT}>
              <Text color={tint(self.settings.palette, 'magenta')} wrap="truncate-end">
                {personWait}
              </Text>
            </Box>
          ) : null}
          {isOpen ? (
            <Box flexDirection="column" paddingLeft={INDENT}>
              {a.waiting && a.endedAt === null ? (
                <Text dimColor wrap="truncate-end">
                  {a.waitingOn ? t('pane.waitingOn', { what: a.waitingOn }) : t('pane.waitingOnUnknown')}
                </Text>
              ) : null}
              {a.now ? <Text dimColor>{a.now}</Text> : null}
              {/* Its latest tool call: the second level of an agent that reports no steps. */}
              {a.activity ? (
                <Text dimColor wrap="truncate-end">
                  {a.calls
                    ? t('pane.agentActivityCalls', { what: a.activity, calls: a.calls })
                    : t('pane.agentActivity', { what: a.activity })}
                </Text>
              ) : null}
              {(a.queued ?? []).map(q => (
                <Text dimColor>{t('pane.agentQueued', { text: q })}</Text>
              ))}
              {agentStepRows(id, a, true)}
            </Box>
          ) : null}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Button
          key={runKey}
          label={t('pane.agents', { fold: runOpen ? '▾' : '▸', running: running.length })}
          plain
          onPress={() => void toggle($, runKey, runOpen)}
        />
        {runOpen ? (
          <Box flexDirection="column" paddingLeft={INDENT}>
            {running.map(agentRow)}
          </Box>
        ) : null}
      </Box>
    )
  }

  // A session's finished subagents, under its Done: one folded "Agents" heading after the done tasks.
  const finishedAgentsBlock = (file: SessionFile, only?: readonly AgentEntry[], scope = '') => {
    const id = file.session.id
    const finished = (only ?? file.agents ?? []).filter(a => a.endedAt !== null)
    if (finished.length === 0) return null
    const key = `doneagents:${id}${scope}`
    const isOpen = folded[key] ?? false
    const olderKey = `agentsolder:${id}${scope}`
    const isOlderOpen = folded[olderKey] ?? false
    const capped = capNewest(finished, self.settings.agentsShown, a => a.endedAt ?? a.updatedAt)
    const listed = isOlderOpen ? finished : capped.shown
    return (
      <Box flexDirection="column">
        <Button
          key={key}
          label={t('pane.agentsFinished', { fold: isOpen ? '▾' : '▸', count: finished.length })}
          plain
          dimColor
          onPress={() => void toggle($, key, isOpen)}
        />
        {isOpen ? (
          <Box flexDirection="column" paddingLeft={INDENT}>
            {listed.map(a => {
              const label = t('pane.agentFinished', {
                label: a.label,
                when: formatTime(a.endedAt ?? a.updatedAt, nowMs, self.settings.clock),
              })
              // ✕ clears it from every pane, as on a done task: it names this ending, so an agent
              // that is resumed and ends again shows again.
              const clear = (
                <Button
                  key={`dismiss:${id}:agent:${a.id}`}
                  label={t('pane.dismiss')}
                  plain
                  dimColor
                  onPress={() => void dismiss($, options, id, [agentDismissal(a)])}
                />
              )
              // A finished agent with steps folds open to them — each one's reason beneath it.
              if (a.tasks.length === 0)
                return (
                  <Box
                    key={`doneagentbox:${id}:${a.id}`}
                    flexDirection="row"
                    justifyContent="space-between"
                    gap={2}
                  >
                    {leftSide(
                      <Text dimColor wrap="truncate-end">
                        {label}
                      </Text>,
                    )}
                    {rightSide(clear)}
                  </Box>
                )
              const agentKey = `doneagent:${id}:${a.id}`
              const agentOpen = folded[agentKey] ?? false
              return (
                <Box key={`doneagentbox:${id}:${a.id}`} flexDirection="column">
                  <Box flexDirection="row" justifyContent="space-between" gap={2}>
                    {leftSide(
                      <Button
                        key={agentKey}
                        label={t('pane.agentFinishedFold', { fold: agentOpen ? '▾' : '▸', label })}
                        plain
                        dimColor
                        onPress={() => void toggle($, agentKey, agentOpen)}
                      />,
                    )}
                    {rightSide(clear)}
                  </Box>
                  {agentOpen ? (
                    <Box flexDirection="column" paddingLeft={INDENT}>
                      {agentStepRows(id, a, false)}
                    </Box>
                  ) : null}
                </Box>
              )
            })}
            {capped.older > 0 ? (
              <Button
                key={olderKey}
                label={t('pane.olderDone', { fold: isOlderOpen ? '▾' : '▸', count: capped.older })}
                plain
                dimColor
                onPress={() => void toggle($, olderKey, isOlderOpen)}
              />
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  }

  const group = (stored: SessionFile) => {
    const id = stored.session.id
    // A finished agent a pane cleared (✕ / Clear all) is hidden at once, as a done task is, before
    // its session drops the row from its own file.
    const shownAgents = visibleAgents(stored, all[id]?.sidecar?.entries ?? [])
    const file =
      shownAgents.length === (stored.agents ?? []).length ? stored : { ...stored, agents: shownAgents }
    const ended = file.session.endedAt
    // The session's own switches (its file's, over this pane's defaults): paused = reporting off;
    // tasks off hides its task list.
    const sw = effective(defaults, file.toggles)
    const shown = (
      sw.tasks ? visibleTasks(file, all[id]?.sidecar?.entries ?? [], all[id]?.sidecar?.cancelled ?? []) : []
    ).filter(x => matchesTask(x, query))
    const open = sortTasks(
      shown.filter(x => !isClosed(x.status)),
      by,
    )
    const done = sortTasks(
      shown.filter(x => isClosed(x.status)),
      by === 'status' || by === 'plan' ? 'done' : by,
    )
    // Tasks of several repos group by repo (in plan order, open and done alike).
    // Each list groups by repo on its own, and only once its tasks span more than one repo: open
    // tasks in one repo stay flat even when Done holds another.
    // Open tasks and running agents together, by repo: grouped once they span more than one repo
    // (each repo: its tasks, then its agents); else the flat layout — tasks, then Agents.
    const runningAgents = sw.agents ? (file.agents ?? []).filter(a => a.endedAt === null) : []
    const work = groupWorkByRepo(
      file,
      sortTasks(
        shown.filter(x => !isClosed(x.status)),
        by === 'status' ? 'plan' : by,
      ),
      runningAgents,
    )
    // An open Done lists the newest `doneShown` (a setting); the rest fold behind "N older" (capNewest).
    const doneOlderKey = `doneolder:${id}`
    const isDoneOlderOpen = folded[doneOlderKey] ?? false
    const doneCapped = capNewest(done, self.settings.doneShown, x => x.doneAt ?? x.updatedAt)
    const doneListed = isDoneOlderOpen ? done : doneCapped.shown
    const finishedAgents = (file.agents ?? []).filter(a => a.endedAt !== null)
    const doneWork = groupWorkByRepo(file, doneListed, finishedAgents)
    const finishedCount = (file.agents ?? []).filter(a => a.endedAt !== null).length
    const groupKey = `group:${id}`
    const doneKey = `done:${id}`
    const isOpen = folded[groupKey] ?? ended === null
    const isDoneOpen = folded[doneKey] ?? false
    const name =
      id !== me
        ? nameOf(file)
        : solo
          ? t('pane.thisSessionSolo')
          : t('pane.thisSession', { project: nameOf(file) })
    const label =
      t(ended === null ? 'pane.groupLive' : 'pane.groupEnded', {
        fold: isOpen ? '▾' : '▸',
        name,
        when: formatTime(ended ?? file.updatedAt, nowMs, self.settings.clock),
        open: open.length,
        done: done.length,
      }) + (ended === null ? offMarker(sw) : '')
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          {leftSide(
            <Button
              key={groupKey}
              label={label}
              plain
              dimColor={ended !== null || !sw.reporting}
              onPress={() => void toggle($, groupKey, isOpen)}
            >
              <Text wrap="truncate-end" dimColor={ended !== null || !sw.reporting}>
                {label}
              </Text>
            </Button>,
          )}
          {rightSide(
            ended !== null ? (
              <Button
                key={`forget:${id}`}
                label={t('pane.forget')}
                plain
                dimColor
                onPress={() => void forgetSession($, options, id)}
              />
            ) : null,
          )}
        </Box>
        {isOpen ? (
          <Box flexDirection="column" paddingLeft={INDENT}>
            {work.length > 1
              ? work.map(({ repo, tasks, agents }) => {
                  const repoKey = `repo:${id}:${repo}`
                  const isRepoOpen = folded[repoKey] ?? true
                  const openHere = sortTasks(
                    tasks.filter(x => !isClosed(x.status)),
                    by,
                  )
                  const runningHere = agents.filter(a => a.endedAt === null)
                  if (openHere.length === 0 && runningHere.length === 0) return null
                  const repoName = repo === OTHER_REPO ? t('pane.otherRepo') : repo
                  return (
                    <Box flexDirection="column">
                      <Button
                        key={repoKey}
                        label={t('pane.repoGroup', {
                          fold: isRepoOpen ? '▾' : '▸',
                          repo: repoName,
                          open: openHere.length,
                        })}
                        plain
                        onPress={() => void toggle($, repoKey, isRepoOpen)}
                      />
                      {isRepoOpen ? (
                        <Box flexDirection="column" paddingLeft={INDENT}>
                          {openHere.map(task => taskRow(id, task))}
                          {agentsBlock(file, agents, `:${repo}`)}
                        </Box>
                      ) : null}
                    </Box>
                  )
                })
              : open.map(task => taskRow(id, task))}
            {work.length > 1 ? null : agentsBlock(file)}
            {done.length + finishedCount > 0 ? (
              <Box flexDirection="row" justifyContent="space-between" gap={2}>
                <Button
                  key={doneKey}
                  label={t('pane.doneSection', {
                    fold: isDoneOpen ? '▾' : '▸',
                    count: done.length + finishedCount,
                  })}
                  plain
                  dimColor
                  onPress={() => void toggle($, doneKey, isDoneOpen)}
                />
                {/* Only while Done is open: nothing is cleared that the person cannot see. The
                    finished agents are part of Done (its count includes them) and go with it. */}
                {isDoneOpen ? (
                  <Button
                    key={`clear:${id}`}
                    label={t('pane.clearAll')}
                    plain
                    dimColor
                    onPress={() =>
                      void dismiss($, options, id, [...done, ...finishedAgents.map(agentDismissal)])
                    }
                  />
                ) : null}
              </Box>
            ) : null}
            {isDoneOpen ? (
              <Box flexDirection="column" paddingLeft={INDENT}>
                {doneWork.length > 1
                  ? doneWork.map(({ repo, tasks, agents }) => {
                      const repoKey = `donerepo:${id}:${repo}`
                      const isRepoOpen = folded[repoKey] ?? true
                      const repoName = repo === OTHER_REPO ? t('pane.otherRepo') : repo
                      return (
                        <Box flexDirection="column">
                          <Button
                            key={repoKey}
                            label={t('pane.repoDoneGroup', {
                              fold: isRepoOpen ? '▾' : '▸',
                              repo: repoName,
                              done: tasks.length,
                            })}
                            plain
                            dimColor
                            onPress={() => void toggle($, repoKey, isRepoOpen)}
                          />
                          {isRepoOpen ? (
                            <Box flexDirection="column" paddingLeft={INDENT}>
                              {tasks.map(task => doneRow(id, task))}
                              {finishedAgentsBlock(file, agents, `:${repo}`)}
                            </Box>
                          ) : null}
                        </Box>
                      )
                    })
                  : doneListed.map(task => doneRow(id, task))}
                {doneCapped.older > 0 ? (
                  <Button
                    key={doneOlderKey}
                    label={t('pane.olderDone', {
                      fold: isDoneOlderOpen ? '▾' : '▸',
                      count: doneCapped.older,
                    })}
                    plain
                    dimColor
                    onPress={() => void toggle($, doneOlderKey, isDoneOlderOpen)}
                  />
                ) : null}
                {doneWork.length > 1 ? null : finishedAgentsBlock(file)}
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  }

  // The switches row as one line, to tell whether its prefix still fits.
  const switchesLine = [
    t('pane.switchesLabel'),
    ...FEATURES.map(f =>
      t(mine[f] ? 'pane.switchOn' : 'pane.switchOff', { feature: t(`toggle.feature.${f}`) }),
    ),
  ].join(' ')
  const switchesShown =
    FEATURES.some(f => !mine[f]) || (armedNow?.key === 'switch:reporting' && nowMs <= armedNow.untilMs)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {solo && newest.session.id === me
              ? t('pane.updatedSolo', { when: formatTime(newest.updatedAt, nowMs, self.settings.clock) })
              : t('pane.updated', {
                  when: formatTime(newest.updatedAt, nowMs, self.settings.clock),
                  project: nameOf(newest),
                })}
            {/* When the pane last listed the folder — said only once that stopped (the timer or the
                folder failed): a clock ticking every two seconds in the corner told nothing. */}
            {nowMs - lastCheck > STALE_AFTER_MS ? (
              <Text color={tint(self.settings.palette, 'yellow')}>
                {t('pane.checkedStale', { when: formatClock(lastCheck, self.settings.clock) })}
              </Text>
            ) : null}
          </Text>
        </Box>
        {/* The corner: this copy's version, and a newer release with a link to its notes. */}
        <Box flexDirection="row" flexShrink={0} gap={1}>
          {release && version && isNewer(release.version, version) ? (
            <Box flexDirection="row">
              <Text color={tint(self.settings.palette, 'yellow')}>
                {t('pane.newerVersion', { version: release.version })}
              </Text>
              {openLink(release.url)}
            </Box>
          ) : null}
          {version ? <Text dimColor>{t('pane.version', { version })}</Text> : null}
          <Button
            key="settings:open"
            label={t('settings.open')}
            plain
            dimColor
            onPress={() => void updateViewing($, () => 'settings')}
          />
        </Box>
      </Box>
      {/* This session's SWITCHES, right under the header — only while one of them is off (or
            reporting is one press from it): with everything on, the row said nothing and took the
            pane's second line; a switch is turned off in Settings or with /progress. Not filters
            (Filter / Sort sit with the list below): each names its state ("tasks on" / "tasks OFF",
            OFF in yellow), a hover says what turning it changes, and turning reporting off — it
            silences the whole session — takes a second press within a few seconds. Whole switches
            wrap, never mid-label; the prefix goes where the pane is too narrow for it. */}
      {switchesShown ? (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {wouldCut(switchesLine, 0, 0) ? null : <Text dimColor>{t('pane.switchesLabel')}</Text>}
          {FEATURES.map(f => {
            const isArmed = armedNow?.key === `switch:${f}` && nowMs <= armedNow.untilMs
            const label = isArmed
              ? t('pane.switchConfirmOff', { feature: t(`toggle.feature.${f}`) })
              : t(mine[f] ? 'pane.switchOn' : 'pane.switchOff', { feature: t(`toggle.feature.${f}`) })
            return (
              <Box key={`switchbox:${f}`} flexDirection="column">
                <Button
                  key={`switch:${f}`}
                  label={label}
                  plain
                  onPress={() => void pressSwitch($, options, f, !mine[f])}
                >
                  <Text
                    color={tint(self.settings.palette, isArmed ? 'red' : mine[f] ? undefined : 'yellow')}
                    bold={isArmed || !mine[f]}
                    dimColor={mine[f] && !isArmed}
                  >
                    {label}
                  </Text>
                </Button>
                {/* Shown while the pointer is on this switch: what turning it changes. */}
                <Box position="absolute" top={1} left={0} display="none" hover={{ display: 'flex' }}>
                  <Text dimColor>{t(mine[f] ? `switch.hintOff.${f}` : `switch.hintOn.${f}`)}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      ) : null}
      {needs.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {asks.length > 0 ? (
            <Text bold inverse color={tint(self.settings.palette, 'magenta')}>
              {t('pane.needsYou', { count: asks.length })}
            </Text>
          ) : null}
          <Box flexDirection="column" paddingLeft={asks.length > 0 ? INDENT : 0}>
            {/* Each ask folds by its own session and text: the same ask in two sessions is two. */}
            {asks.map(n =>
              cutLine(
                `needs:${n.key}`,
                solo
                  ? t('pane.needsYouItemSolo', { item: n.item })
                  : t('pane.needsYouItem', { project: n.project, item: n.item }),
                {
                  bold: true,
                  color: tint(self.settings.palette, 'magenta'),
                },
              ),
            )}
            {/* Sessions that only finished a turn: one dim line, counted — a list of them buried
                the asks, and nothing is asked there. */}
            {idle.length > 0
              ? cutLine(
                  'idle',
                  solo
                    ? t('pane.idleSolo')
                    : tn('pane.idle', idle.length, {
                        names: idle
                          .map(n =>
                            n.sessionId === me ? t('pane.idleHere', { project: n.project }) : n.project,
                          )
                          .sort((a, b) => a.localeCompare(b))
                          .join(', '),
                      }),
                  { dimColor: true },
                )
              : null}
          </Box>
        </Box>
      ) : null}
      {live.some(f => f.now) ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{t('pane.now')}</Text>
          <Box flexDirection="column" paddingLeft={INDENT}>
            {live
              .filter(f => f.now)
              .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
              .map(f =>
                cutLine(
                  `now:${f.session.id}`,
                  solo
                    ? t('pane.nowItemSolo', { now: f.now ?? '' })
                    : t('pane.nowItem', { project: nameOf(f), now: f.now ?? '' }),
                  {},
                ),
              )}
          </Box>
        </Box>
      ) : null}
      {pipelineRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Button
            key="pipelines"
            label={sectionLabel}
            plain
            onPress={() => void toggleSection($, sectionKey, isSectionOpen)}
          >
            <Text>{t('pane.pipelinesTitle', sectionParts)}</Text>
            {/* What is running now stands out, even with the section folded. */}
            <Text
              color={tint(self.settings.palette, sectionParts.watching > 0 ? 'yellow' : undefined)}
              bold={sectionParts.watching > 0}
            >
              {t('pane.pipelinesWatching', sectionParts)}
            </Text>
            <Text>{t('pane.pipelinesTally', sectionParts)}</Text>
          </Button>
          {isSectionOpen ? (
            <Box flexDirection="column" paddingLeft={INDENT}>
              {currentRows.map(({ sessionId, pipeline }) => pipelineBlock(sessionId, pipeline))}
              {archivedRows.length > 0 ? (
                <Button
                  key={FINISHED_KEY}
                  label={t('pane.pipelinesFinished', {
                    fold: isFinishedOpen ? '▾' : '▸',
                    count: archivedRows.length,
                  })}
                  plain
                  dimColor
                  onPress={() => void toggle($, FINISHED_KEY, isFinishedOpen)}
                />
              ) : null}
              {archivedRows.length > 0 && isFinishedOpen ? (
                <Box flexDirection="column" paddingLeft={INDENT}>
                  {archivedRows.map(({ sessionId, pipeline }) => pipelineBlock(sessionId, pipeline))}
                </Box>
              ) : null}
            </Box>
          ) : null}
        </Box>
      ) : null}
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Text bold>{t('pane.sessions')}</Text>
        <Input
          key="filter"
          placeholder={t('pane.filter')}
          value={query}
          onInput={value => void updateFiltering($, () => value)}
          onSubmit={value => void updateFiltering($, () => value)}
        />
        <Button
          key="sort"
          label={t('pane.sort', { by: t(`sort.${by}`) })}
          plain
          dimColor
          onPress={() => void cycleSort($, options)}
        />
      </Box>
      <Box flexDirection="column" paddingLeft={INDENT}>
        {/* While filtering, a session with no matching task steps aside. */}
        {ordered
          .filter(
            f =>
              !query.trim() ||
              visibleTasks(
                f,
                all[f.session.id]?.sidecar?.entries ?? [],
                all[f.session.id]?.sidecar?.cancelled ?? [],
              ).some(x => matchesTask(x, query)),
          )
          .map(group)}
      </Box>
    </Box>
  )
}
