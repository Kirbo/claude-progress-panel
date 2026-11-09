// Per-session feature toggles: what the panel does for THIS session's agent. Each feature is on or
// off by the plugin's defaults (userConfig: `autoStart` and one default per feature), and a session
// may override any of them for the rest of its life (`/progress <feature> on|off`, the pane's
// buttons) — stored in its own file, so a reload or a resume keeps it and a new session starts from
// the defaults again. Pure: the I/O is register.tsx's.

import type { MessageKey } from '../locales/en'

export const FEATURES = ['reporting', 'tasks', 'agents', 'pipelines'] as const
export type Feature = (typeof FEATURES)[number]
export type Toggles = Partial<Record<Feature, boolean>>
export type Effective = Record<Feature, boolean>

/** The defaults a new session starts from: `autoStart` is reporting's; the rest are their own. */
export function defaultsFrom(options: Record<string, unknown>): Effective {
  const on = (name: string, fallback: boolean) => {
    const raw = options[name]
    if (raw === undefined || raw === '') return fallback
    return raw === true || raw === 'on' || raw === 'true'
  }
  return {
    reporting: on('autoStart', true),
    tasks: on('tasksDefault', true),
    agents: on('agentsDefault', true),
    pipelines: on('pipelinesDefault', true),
  }
}

/** What applies to a session: its overrides over the defaults. */
export function effective(defaults: Effective, overrides: Toggles | undefined): Effective {
  const out = { ...defaults }
  for (const f of FEATURES) if (typeof overrides?.[f] === 'boolean') out[f] = overrides[f] as boolean
  return out
}

/** Whether a feature acts: reporting is the master switch over the rest. */
export function active(eff: Effective, feature: Feature): boolean {
  return feature === 'reporting' ? eff.reporting : eff.reporting && eff[feature]
}

/** A session's overrides with one feature set; a value equal to the default is still an override
 *  (the person chose it), and `undefined` resets it to the default. */
export function withToggle(
  overrides: Toggles | undefined,
  feature: Feature,
  value: boolean | undefined,
): Toggles {
  const next: Toggles = { ...(overrides ?? {}) }
  if (value === undefined) delete next[feature]
  else next[feature] = value
  return next
}

export type ProgressCommand =
  | { kind: 'open' }
  | { kind: 'doctor' }
  | { kind: 'status' }
  | { kind: 'set'; feature: Feature; on: boolean }
  | { kind: 'recheck' }
  | { kind: 'settings' }
  | { kind: 'unknown' }

const ON = new Set(['on', 'enable', 'resume', 'start'])
const OFF = new Set(['off', 'disable', 'pause', 'stop'])

/**
 * `/progress …`'s argument: nothing opens the pane; `doctor`; `status`; `on` / `off` (and
 * enable/disable, resume/pause) set reporting; `<feature> on|off` sets that feature.
 */
export function parseProgressCommand(args: string | undefined): ProgressCommand {
  const words = (args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [first, second] = words
  if (!first) return { kind: 'open' }
  if (first === 'doctor') return { kind: 'doctor' }
  if (first === 'status') return { kind: 'status' }
  if (first === 'settings') return { kind: 'settings' }
  if (ON.has(first) || OFF.has(first)) return { kind: 'set', feature: 'reporting', on: ON.has(first) }
  if (first === 'pipelines' && second === 'recheck') return { kind: 'recheck' }
  if ((FEATURES as readonly string[]).includes(first) && second && (ON.has(second) || OFF.has(second)))
    return { kind: 'set', feature: first as Feature, on: ON.has(second) }
  return { kind: 'unknown' }
}

/** The reporting rule for what is on, at a reporting effort: the bullets of the features that are
 *  off are left out; `milestones` asks only for the plan and its turning points, `minimal` only for
 *  `now` and what needs the person. */
export function ruleKeys(
  eff: Effective,
  effort: 'detailed' | 'milestones' | 'minimal' = 'detailed',
): MessageKey[] {
  const keys: MessageKey[] = ['rule.title', 'rule.intro']
  if (!eff.tasks || effort === 'minimal') keys.push('rule.nowOnly')
  else if (effort === 'milestones') keys.push('rule.milestones', 'rule.repo')
  else keys.push('rule.plan', 'rule.repo', 'rule.steps', 'rule.move')
  keys.push('rule.needs')
  if (eff.pipelines) keys.push('rule.push')
  keys.push('rule.oneReply')
  if (eff.agents) keys.push('rule.subagent')
  return keys
}

/** The one-line note a change of a feature hands the agent, once; undefined when none is due. */
export function changeNote(feature: Feature, on: boolean): MessageKey | undefined {
  switch (feature) {
    case 'reporting':
      return on ? undefined : 'toggle.note.reportingOff' // on: the whole rule is handed over instead
    case 'tasks':
      return on ? 'toggle.note.tasksOn' : 'toggle.note.tasksOff'
    case 'agents':
      return on ? 'toggle.note.agentsOn' : 'toggle.note.agentsOff'
    case 'pipelines':
      return on ? 'toggle.note.pipelinesOn' : 'toggle.note.pipelinesOff'
  }
}
