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
}

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
  }
}

// Okabe–Ito: blue for success and orange for failure tell apart under every common colour blindness.
const COLORBLIND: Record<string, string> = {
  green: 'blue',
  red: '#E69F00',
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
