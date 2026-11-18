// Every plugin setting (userConfig) read once into one typed object, each with its built-in
// default: the one place a setting's value and default live. Pure.

export type Settings = {
  /** Needs-you asks of other sessions are toasted. */
  toastNeedsYou: boolean
  /** A notification also goes out through the person's own channel (`$.ui.notify`: bell, banner). */
  bell: boolean
  /** A pipeline this session watches finishing: toasted never, on failure only, or always. */
  pipelineNotify: 'never' | 'failures' | 'always'
  /** Whose sessions the pane lists: all, the ones in this session's repo, or this one only. */
  paneScope: 'all' | 'repo' | 'session'
  /** Whether a session opens the pane by itself (Claude Code still decides where it fits). */
  autoOpen: 'auto' | 'never'
  /** Finished tasks / finished agents an open Done lists before "N older". */
  doneShown: number
  agentsShown: number
  /** A successful pipeline older than this folds into "Finished". */
  successFoldMs: number
  /** How times read: 24-hour, 12-hour, or the system's own. */
  clock: '24h' | '12h' | 'system'
  /** How much the agent is asked to report (the rule's wording follows it). */
  effort: 'detailed' | 'milestones' | 'minimal'
  /** How often watched pipelines are asked after. */
  pipelineRefreshMs: number
  /** The newer-release check (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC still turns it off). */
  updateCheck: boolean
  /** The pane's colours: as designed, colour-blind safe, or none. */
  palette: 'default' | 'colorblind' | 'none'
  /** ✕ on a running pipeline: cancel it and delete it from the CI, only cancel, or no ✕. */
  runningPipelineX: 'delete' | 'cancel' | 'off'
  /** A subagent past `planGateCalls` tool calls without its plan in the pane has its next call
   *  refused once (0.32.0). */
  planGate: boolean
  /** The tool calls a subagent may make before its plan is due (a tiny job needs none). */
  planGateCalls: number
  /** A reminder after this many tool calls without a progress_update (0 = off), at `detailed`. */
  updateEveryCalls: number
  /** …or after this long without one (0 = off), at `detailed`. */
  updateEveryMs: number
  /** A subagent's hand-back / stop with steps still open is refused once (0.32.0). */
  settleBeforeHandback: boolean
}

/**
 * The fallbacks of the settings read as free numbers (any value ≥ 0, not only the listed options):
 * the pane's sizes and the two retention periods. `scripts/defaults.test.mjs` holds these, and every
 * fallback in `readSettings`, to the manifest's own defaults.
 */
export const NUMBER_DEFAULTS = {
  paneColumns: 84,
  paneRows: 20,
  autoClearDoneHours: 0,
  keepEndedSessionsDays: 7,
} as const

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

function num(raw: unknown, allowed: readonly number[], fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && allowed.includes(n) ? n : fallback
}

export function readSettings(options: Record<string, unknown>): Settings {
  return {
    toastNeedsYou: pick(options.toastNeedsYou, ['on', 'off'], 'on') === 'on',
    bell: pick(options.bell, ['on', 'off'], 'off') === 'on',
    pipelineNotify: pick(options.pipelineNotify, ['never', 'failures', 'always'], 'failures'),
    paneScope: pick(options.paneScope, ['all', 'repo', 'session'], 'all'),
    autoOpen: pick(options.autoOpen, ['auto', 'never'], 'auto'),
    doneShown: num(options.doneShown, [5, 10, 20, 50], 10),
    agentsShown: num(options.agentsShown, [3, 5, 10, 20], 5),
    successFoldMs: num(options.successFoldHours, [0.5, 1, 3, 12, 24], 1) * 3_600_000,
    clock: pick(options.clock, ['24h', '12h', 'system'], '24h'),
    effort: pick(options.reportingEffort, ['detailed', 'milestones', 'minimal'], 'detailed'),
    pipelineRefreshMs: num(options.pipelineRefreshSec, [10, 15, 30, 60], 15) * 1000,
    updateCheck: pick(options.updateCheck, ['on', 'off'], 'on') === 'on',
    palette: pick(options.palette, ['default', 'colorblind', 'none'], 'default'),
    runningPipelineX: pick(options.runningPipelineX, ['delete', 'cancel', 'off'], 'delete'),
    planGate: pick(options.planGate, ['on', 'off'], 'on') === 'on',
    planGateCalls: num(options.planGateCalls, [1, 2, 3, 5, 8], 3),
    updateEveryCalls: num(options.updateEveryCalls, [0, 5, 8, 12, 20, 30], 8),
    updateEveryMs: num(options.updateEveryMin, [0, 3, 5, 10, 15, 30], 5) * 60_000,
    settleBeforeHandback: pick(options.settleBeforeHandback, ['on', 'off'], 'on') === 'on',
  }
}

/** What the plugin enforces at the session's reporting effort (0.32.0). A lower effort relaxes the
 *  plan gate and the reminders — `milestones` doubles the reminders' thresholds, `minimal` asks only
 *  for `now` and sends no reminders — but never the settling of an agent's steps at its end, nor
 *  what the pane shows once it ended. 0 = off. */
export type Enforcement = {
  /** A subagent's call past this many without a plan is refused once; undefined = no gate. */
  gateCalls: number | undefined
  /** What counts as a plan: steps (`tasks`), or only `now` (minimal). */
  plan: 'tasks' | 'now'
  /** Subagent reminders: after this many calls / this long without an update. */
  everyCalls: number
  everyMs: number
  /** The main session: one note per turn after this many calls without a task list, and a reminder
   *  after this many calls without an update while a task is `doing`. */
  mainPlanCalls: number
  mainEveryCalls: number
  /** A subagent's hand-back / stop with open steps is refused once. */
  settle: boolean
}

export function enforcement(s: Settings): Enforcement {
  const factor = s.effort === 'milestones' ? 2 : s.effort === 'minimal' ? 0 : 1
  return {
    gateCalls: s.planGate ? s.planGateCalls : undefined,
    plan: s.effort === 'minimal' ? 'now' : 'tasks',
    everyCalls: s.updateEveryCalls * factor,
    everyMs: s.updateEveryMs * factor,
    mainPlanCalls: s.planGateCalls * 2,
    mainEveryCalls: s.updateEveryCalls * 2 * factor,
    settle: s.settleBeforeHandback,
  }
}

// Okabe–Ito: blue for success and vermillion for failure tell apart under every common colour
// blindness — and from each other's neighbours: its orange (#E69F00) sat too close to the yellow of
// what is running.
const COLORBLIND: Record<string, string> = {
  green: 'blue',
  red: '#D55E00',
  yellow: 'yellow',
  magenta: 'magenta',
}

/** A colour as the palette draws it: unchanged, swapped for a colour-blind safe one, or none. */
export function tint(palette: Settings['palette'], color: string | undefined): string | undefined {
  if (!color || palette === 'none') return undefined
  return palette === 'colorblind' ? (COLORBLIND[color] ?? color) : color
}

/** Whether a finished pipeline is worth a notification under the setting. */
export function notifiesFinish(setting: Settings['pipelineNotify'], state: string): boolean {
  if (setting === 'never') return false
  return setting === 'always' || state === 'failed'
}

// --- The Settings view's layout (0.23.2) ----------------------------------------------------------

/** The defaults list, grouped under small headings, each group in this order (locale keys). A field
 *  no group names lands in a last "Other" group, so a new setting is never hidden. */
export const SETTING_GROUPS = [
  {
    heading: 'settings.group.reporting',
    fields: [
      'autoStart',
      'tasksDefault',
      'agentsDefault',
      'reportingEffort',
      'planGate',
      'planGateCalls',
      'updateEveryCalls',
      'updateEveryMin',
      'settleBeforeHandback',
    ],
  },
  {
    heading: 'settings.group.pipelines',
    fields: [
      'pipelinesDefault',
      'pipelineNotify',
      'pipelineRefreshSec',
      'successFoldHours',
      'runningPipelineX',
    ],
  },
  {
    heading: 'settings.group.notifications',
    fields: ['autoNeedsPermission', 'autoNeedsIdle', 'toastNeedsYou', 'bell'],
  },
  {
    heading: 'settings.group.pane',
    fields: [
      'paneScope',
      'autoOpen',
      'doneShown',
      'agentsShown',
      'paneColumns',
      'paneRows',
      'sortTasksBy',
      'clock',
      'palette',
    ],
  },
  {
    heading: 'settings.group.storage',
    fields: ['progressDir', 'autoClearDoneHours', 'keepEndedSessionsDays', 'ciCommand', 'updateCheck'],
  },
] as const

export type SettingGroupHeading = (typeof SETTING_GROUPS)[number]['heading'] | 'settings.group.other'

/** The plugin's rows (`progress-panel.<field>`) in their groups and the groups' order; empty groups
 *  are left out. */
export function groupSettings<R extends { key: string }>(
  rows: readonly R[],
): { heading: SettingGroupHeading; rows: R[] }[] {
  const field = (r: R) => r.key.slice(r.key.indexOf('.') + 1)
  const placed = new Set<string>()
  const out: { heading: SettingGroupHeading; rows: R[] }[] = []
  for (const group of SETTING_GROUPS) {
    const fields: readonly string[] = group.fields
    const inGroup = fields.map(f => rows.find(r => field(r) === f)).filter((r): r is R => r !== undefined)
    for (const r of inGroup) placed.add(r.key)
    if (inGroup.length > 0) out.push({ heading: group.heading, rows: inGroup })
  }
  const rest = rows.filter(r => !placed.has(r.key))
  if (rest.length > 0) out.push({ heading: 'settings.group.other', rows: rest })
  return out
}

/** How a value is drawn: on (green), off (yellow), empty (dim, "empty = default"), any other choice
 *  or number (cyan). */
export function valueTone(value: string): 'on' | 'off' | 'empty' | 'choice' {
  if (value === '') return 'empty'
  if (value === 'on') return 'on'
  if (value === 'off') return 'off'
  return 'choice'
}

/** Whether a setting differs from its built-in default (drawn bold, so a changed one stands out). */
export function isChangedSetting(value: string, fallback: string | undefined): boolean {
  return value !== (fallback ?? '')
}
