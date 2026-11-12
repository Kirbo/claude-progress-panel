// The plugin's constants, the pane's atoms, and everything this session's copy remembers between
// hooks (`self`, and the queues of notes owed to an agent). No I/O here.

import type { EngineInterface, PluginOptions } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Folds, JobState, Loaded, PipelineJob, SortChoice } from '../types'
import { t } from './i18n'
import type { Settings } from './settings'
import { readSettings } from './settings'
import type { Effective, Feature, Toggles } from './toggles'
import { active, defaultsFrom, effective, ruleKeys } from './toggles'

export const PANE = 'progress'

export const TOOL = 'progress_update'

export const TOOL_ID = `mcp__progress-panel__${TOOL}`

export const REPORTING_SECTION = 'progress-panel:reporting'

// No file-watch API exists for plugins, so other sessions' files are noticed by listing the
// folder on this timer (a file is read only when its mtime moved). Own writes redraw at once.
export const REFRESH_MS = 2000

// A check older than this many refresh periods is shown as stale (the timer or the folder failed).
export const STALE_AFTER_MS = 5 * REFRESH_MS

export const DAY_MS = 24 * 3_600_000

// GitLab cannot push pipeline status to a local plugin (webhooks need a reachable server; its live
// updates need a browser websocket session), so the session that watches a pipeline polls it
// through the user's own `glab` — only while it is unfinished, and only that session.
export const PIPELINE_POLL_MS = 15_000

// Once the watching session has not checked an unfinished pipeline for this long (it ended, or was
// killed without ending), any pane polls it instead, writing to that session's sidecar.
export const ORPHAN_AFTER_MS = 4 * PIPELINE_POLL_MS

// A pipeline that succeeded longer ago than this moves into the folded "Finished" list.
// Similar-run estimates are cached in the plugin's store this long, per project + ref + source.
export const ESTIMATE_TTL_MS = 24 * 3_600_000

// Orphans are polled by ONE pane on the machine: the one holding this lease in the plugin's store
// (shared by every session). The holder renews it with each round; when it goes away the lease
// runs out and the next pane takes over.
export const ORPHAN_LEASE_KEY = 'orphan-poller'
export const ORPHAN_LEASE_MS = 150_000

export const FINISHED_KEY = 'pipelines-finished'

// `-2` (0.14.0): `plan` became the default, so a choice remembered from before starts over once.
export const SORT_KEY = 'sortTasksBy-2'

export const SIDECAR = '.dismissed.json'

// A destructive ✕ (cancel + delete a running pipeline) needs a second press within this long.
export const CONFIRM_MS = 5000

// GitLab cannot push its releases to a local plugin, so the newest one is looked up — at most every
// 6 h across every session on the machine (the answer is shared in the plugin's store).
// poll-exception: no push from GitLab to a local plugin
export const RELEASE_CHECK_MS = 6 * 3_600_000

export const RELEASE_KEY = 'latest-release'

// This session's own file, there but not readable as a session file: caught mid-write (writes are
// not atomic — the plugin API has no rename), so nothing is saved over it. One that still reads the
// same this long after it was first seen so is damaged, not in flight, and is started over.
export const OWN_UNREADABLE_MS = 10_000

// The subagent rule at each reporting effort.
export const SUBAGENT_RULE = {
  detailed: 'prompt.subagent',
  milestones: 'prompt.subagentMilestones',
  minimal: 'prompt.subagentMinimal',
} as const

export const pendingNotes: string[] = []

// Each subagent's own background tasks: the ids its Bash calls' results named (`backgroundTaskId`).
// A SubagentStop lists the whole session's background work without owners; only these are its.
export const agentBackground = new Map<string, Set<string>>()

// Linked agents that finished, not yet told to the coordinator (its next progress_update answer, or
// its next main-loop tool call — once).
export const finishedLinks: string[] = []

// A pane's change to a session's sidecar: read fresh, change, write whole, so a ✕ and a pipeline
// refresh never drop each other's part. Two guards, since the plugin API has no file lock or rename:
// this pane's own changes to one sidecar run one at a time (a press and a poll interleave at every
// await), and a change computed from a copy another pane replaced meanwhile (the file's mtime moved
// between the read and the write) is computed again from the new copy. The second narrows the
// window between panes to the last stat and the write; it cannot close it.
export const sidecarChains = new Map<string, Promise<unknown>>()

// When each other session's process was last asked after (one ask a minute, at most).
export const livenessAskedAt = new Map<string, number>()

// The descriptions of Agent calls whose prompt carried the subagent rule (`feedAgentPrompt`): their
// subagents get no second copy at start or with their first tool call.
export const promptFed = new Set<string>()

// The repo a subagent works in, from the cwd of its tool calls — asked of git once per agent (the
// answer is kept on its entry), so a worktree counts as the repo it belongs to.
export const agentRepoAsked = new Set<string>()

// What each subagent's entry was last given as its model and effort (`model|effort`): a model
// request repeats them at every step, and only a change is worth a read of the session's file.
export const agentRunNoted = new Map<string, string>()

// A subagent's tool calls, counted as they pass, and when its entry was last given its latest one:
// the entry is written at most every ACTIVITY_EVERY_MS, so a busy agent costs one write a few
// seconds apart, not one per call.
export const agentCalls = new Map<string, number>()
// The agents whose count this copy has joined to the one on their entry: a copy that starts while an
// agent is at work (a reload) counts on from what the copy before it wrote, never from 1 again.
export const agentCallsJoined = new Set<string>()
export const agentActivityAt = new Map<string, number>()
export const ACTIVITY_EVERY_MS = 3000

// Subagents told the reporting rule (once each, process-wide).
export const subagentRuleSent = new Set<string>()

// Repos whose agent was told, this session, that they run no CI (once each).
export const toldNoCi = new Set<string>()

// Claude Code's own waiting states as Needs-you items of this session: a permission prompt (naming
// the subagent that asks) and the idle "waiting for your reply" — each kind behind its setting, only
// while reporting is on. Kept apart from the agent's own `needsYou`, never touching it.
// The tool call each loop is in (main loop = '', else the subagent's id): what a permission prompt
// is about — Claude Code's own notice often says only "Claude needs your permission".
export const pendingCall = new Map<string, { token: object; toolUseId?: string; what: string }>()

export const sessions = atom({ plugin: 'progress-panel', key: 'sessions' } as const, {} as Loaded, {
  shape: 'sessions-5',
})

// Bumped after a setting is written from the Settings view: the view redraws with the new value
// (a userConfig value is no atom of ours).
export const configTick = atom({ plugin: 'progress-panel', key: 'configTick' } as const, 0, {
  shape: 'config-1',
})

export const armed = atom(
  { plugin: 'progress-panel', key: 'armed' } as const,
  null as { key: string; untilMs: number } | null,
  { shape: 'armed-1' },
)

// The pane's view: the sessions, or Settings (this session's switches, the defaults for new ones).
export const viewing = atom(
  { plugin: 'progress-panel', key: 'view' } as const,
  'main' as 'main' | 'settings',
  {
    shape: 'view-1',
  },
)

export const folds = atom({ plugin: 'progress-panel', key: 'folds' } as const, {} as Folds, {
  shape: 'folds-1',
})

// The newest release of the plugin (from the shared store or a check), drawn in the pane's corner.
export const releasing = atom(
  { plugin: 'progress-panel', key: 'release' } as const,
  null as { version: string; url: string } | null,
  { shape: 'release-1' },
)

// The text the person typed into the Filter beside Sessions: tasks without it are hidden.
export const filtering = atom({ plugin: 'progress-panel', key: 'filter' } as const, '', { shape: 'filter-1' })

// When the last successful folder listing finished, so the header can show the pane is live.
export const checked = atom({ plugin: 'progress-panel', key: 'checked' } as const, 0, { shape: 'checked-1' })

// The order the pane draws in, mirrored from $.store (kept per user across sessions) so a change redraws.
export const sorting = atom({ plugin: 'progress-panel', key: 'sort' } as const, '' as SortChoice, {
  shape: 'sort-1',
})

// Each atom is read and changed through these, from every file: an atom's initial value and shape
// tag live on the atom itself, so it is declared once (above) and never by reference elsewhere.
export function readSessions($: EngineInterface) {
  return read($, sessions)
}

export function updateSessions($: EngineInterface, change: (value: Loaded) => Loaded) {
  return update($, sessions, change)
}

export function readConfigTick($: EngineInterface) {
  return read($, configTick)
}

export function updateConfigTick($: EngineInterface, change: (value: number) => number) {
  return update($, configTick, change)
}

export function readArmed($: EngineInterface) {
  return read($, armed)
}

export function updateArmed(
  $: EngineInterface,
  change: (value: { key: string; untilMs: number } | null) => { key: string; untilMs: number } | null,
) {
  return update($, armed, change)
}

export function readViewing($: EngineInterface) {
  return read($, viewing)
}

export function updateViewing(
  $: EngineInterface,
  change: (value: 'main' | 'settings') => 'main' | 'settings',
) {
  return update($, viewing, change)
}

export function readFolds($: EngineInterface) {
  return read($, folds)
}

export function updateFolds($: EngineInterface, change: (value: Folds) => Folds) {
  return update($, folds, change)
}

export function readReleasing($: EngineInterface) {
  return read($, releasing)
}

export function updateReleasing(
  $: EngineInterface,
  change: (value: { version: string; url: string } | null) => { version: string; url: string } | null,
) {
  return update($, releasing, change)
}

export function readFiltering($: EngineInterface) {
  return read($, filtering)
}

export function updateFiltering($: EngineInterface, change: (value: string) => string) {
  return update($, filtering, change)
}

export function readChecked($: EngineInterface) {
  return read($, checked)
}

export function updateChecked($: EngineInterface, change: (value: number) => number) {
  return update($, checked, change)
}

export function readSorting($: EngineInterface) {
  return read($, sorting)
}

export function updateSorting($: EngineInterface, change: (value: SortChoice) => SortChoice) {
  return update($, sorting, change)
}

// What this session's copy of the plugin remembers between hooks, in one place: a reload starts it
// over. Each field is written wherever the plugin learns it and read everywhere else.
export const self: {
  /** The version this copy runs, read from its own manifest once. */
  manifest: { version: string; repository: string; defaults: Record<string, string> } | undefined
  /** Needs-you items already announced, so a toast fires once per new item (a reload starts quiet
   *  again, seeded on its first scan). */
  seenNeeds: Set<string> | undefined
  /** Every read-modify-write of this session's own file runs one at a time: a timer's poll and a
   *  tool call interleave at each await, and the later save would put a stale copy over the other's. */
  ownChain: Promise<unknown>
  /** The name Claude Code gives this session (`/rename`, a resumed session's title), as the classic
   *  SessionStart / UserPromptSubmit events last carried it; the plugin API has no call for it. */
  sessionTitle: string | undefined
  /** Whether this module put the reporting rule into a composed system prompt, and whether it has
   *  handed it to the agent another way. A plugin installed, reloaded (`/reload-plugins`) or resumed
   *  mid-session is not asked to compose until the session's prompt is rebuilt, so the rule it
   *  relies on never reaches that agent — which then never reports. The next prompt carries it. */
  ruleComposed: boolean
  ruleSent: boolean
  /** The one-line "this session has not reported yet" reminder was sent: it is sent once. */
  nudged: boolean
  /** A session this copy saw start (SessionStart `startup`): its system prompt is composed again for
   *  the first request, with the tool offered by then (it is still connecting when the session
   *  starts), so the first prompt leaves the rule to that prompt (`ruleDeferred`) — the first tool
   *  call hands it over if no composed prompt carried it after all. */
  freshStart: boolean
  ruleDeferred: boolean
  /** The plugin's settings, read as the module loads (a changed setting reloads it). */
  settings: Settings
  /** This session's own feature switches (its file's `toggles`, read at start and kept in step with
   *  every change). */
  sessionToggles: Toggles | undefined
  /** A task never stays in a state that is no longer true (0.23.2): when this turn began (the
   *  person's prompt). */
  turnStartMs: number | undefined
  /** The switches as the agent last heard of them, while a change since is not handed over yet
   *  (undefined: nothing owed), and the options to read them with then. */
  toldSwitches: Effective | undefined
  togglesOptions: PluginOptions | undefined
  /** This session's own process and machine (`whoAmI`, at start): written into its file so another
   *  session can tell when it died without `session.end`. Undefined where it cannot be told. */
  ownProcess: { pid: number; host: string; pidStart?: string } | undefined
  /** The folder scan and the pipeline poll are single-flight: a round that finds the previous one
   *  still running skips, so slow disks or forges never stack rounds that land out of order. */
  scanning: boolean
  polling: boolean
  /** A watch was added while a poll round ran: the round looks once more (at what is new) before
   *  it ends, so a new watch never waits a whole interval for its first check. */
  pollWanted: boolean
  /** Whether this session's file holds notices still owed to an agent (`owed`), as of this copy's
   *  last look: `false` spares every tool call a read; `undefined` (a fresh copy, a new session)
   *  means look. */
  owes: boolean | undefined
  /** This session's own file as it was last found unreadable (see OWN_UNREADABLE_MS): whose, what it
   *  held ('' for a read that failed) and since when. */
  ownUnreadable: { id: string; text: string; sinceMs: number } | undefined
  /** `tea`'s logins, as last listed (cached a minute). */
  teaLogins: { atMs: number; text: string } | undefined
  /** The jobs of a finished run of a watch by commit (`<key>#<run id>`), as last read: a run that
   *  is still in that state is not asked for its jobs again. Memory only — a reload asks once more. */
  runJobs: Map<string, { state: JobState; jobs: PipelineJob[] }>
  /** What this copy has put in front of the agent so far, in characters (`/progress doctor` says it
   *  as tokens): the rule as last composed into a system prompt (it rides every request), the tool's
   *  answers and how many, the notes handed over with hook results, and the rule appended to Agent
   *  calls' prompts. Memory only: a reload starts it over. */
  cost: { ruleChars: number; answers: number; answerChars: number; noteChars: number; promptChars: number }
} = {
  manifest: undefined,
  seenNeeds: undefined,
  ownChain: Promise.resolve(),
  sessionTitle: undefined,
  ruleComposed: false,
  ruleSent: false,
  nudged: false,
  freshStart: false,
  ruleDeferred: false,
  settings: readSettings({}),
  sessionToggles: undefined,
  turnStartMs: undefined,
  toldSwitches: undefined,
  togglesOptions: undefined,
  ownProcess: undefined,
  scanning: false,
  polling: false,
  pollWanted: false,
  owes: undefined,
  ownUnreadable: undefined,
  teaLogins: undefined,
  runJobs: new Map(),
  cost: { ruleChars: 0, answers: 0, answerChars: 0, noteChars: 0, promptChars: 0 },
}

// The conversation ended but the process goes on under another session id (`/clear`, a resume in
// place — no `session.start` fires for it): what this copy remembers about the session that ended
// is not the next one's. Its switches, its name, the notes it was owed, what it was told, its
// subagents. What belongs to the process or the machine stays (settings, the manifest, the locks,
// its own pid, what the panes have announced, whether a composed prompt carries the rule).
export function forgetSessionMemory(): void {
  self.sessionToggles = undefined
  self.sessionTitle = undefined
  self.turnStartMs = undefined
  self.toldSwitches = undefined
  self.togglesOptions = undefined
  // A rule that only rode a prompt went with the conversation: the next prompt carries it again.
  self.ruleSent = false
  self.nudged = false
  self.ruleDeferred = false
  self.freshStart = false
  self.ownUnreadable = undefined
  self.cost = { ruleChars: self.cost.ruleChars, answers: 0, answerChars: 0, noteChars: 0, promptChars: 0 }
  pendingNotes.length = 0
  finishedLinks.length = 0
  self.owes = undefined
  toldNoCi.clear()
  promptFed.clear()
  subagentRuleSent.clear()
  agentBackground.clear()
  agentRepoAsked.clear()
  agentRunNoted.clear()
  agentCalls.clear()
  agentCallsJoined.clear()
  agentActivityAt.clear()
  pendingCall.clear()
}

export function takeFinishedLinks(): string[] {
  return finishedLinks.splice(0)
}

export function switches(options: PluginOptions): Effective {
  return effective(defaultsFrom(options as Record<string, unknown>), self.sessionToggles)
}

export function isOn(options: PluginOptions, feature: Feature): boolean {
  return active(switches(options), feature)
}

/** The reporting rule for what is on in this session. */
export function ruleText(options: PluginOptions): string {
  return ruleKeys(switches(options), self.settings.effort)
    .map(k => t(k))
    .join('\n')
}

export function optionNumber(options: PluginOptions, name: string, fallback: number): number {
  const raw = options[name]
  if (raw === undefined || raw === '') return fallback
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function optionString(options: PluginOptions, name: string): string {
  const raw = options[name]
  return typeof raw === 'string' ? raw : ''
}
