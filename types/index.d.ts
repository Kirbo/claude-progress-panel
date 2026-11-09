// The plugin's type contract: the session file every session writes, and the pane's state.
// Self-contained on purpose — `claude plugin validate` refuses imports here.

/** `failed` (0.23.0): tried and could not be done — the reason in `note`. `unfinished` (0.23.0) is
 *  never sent: the plugin sets it on an agent's open step when the agent stops for good. */
export type Status = 'todo' | 'doing' | 'blocked' | 'done' | 'skipped' | 'failed' | 'unfinished'

/** A subagent's progress under its coordinator's session: its steps, what it is on, its estimate. */
export type AgentEntry = {
  id: string
  /** The Agent call's description (`$.agent.list()`), else a short id. */
  label: string
  now: string | null
  tasks: Task[]
  seq: number
  /** Minutes it expects to need for the rest, as last reported. */
  etaMin?: number
  startedAt: string
  updatedAt: string
  /** When the subagent stopped (SubagentStop); null while it runs. */
  endedAt: string | null
  /** Its tasks the person removed in a pane (0.23.0): they stay skipped. */
  cancelled?: string[]
  /** When the person cancelled the whole subagent's work in a pane (0.23.0). */
  cancelledAt?: string
  /** It stopped with background work still running (0.23.0): it resumes on its own. */
  waiting?: true
  /** It was resumed after it had ended (0.23.0): only its own next stop ends it again. */
  resumedAt?: string
  /** Messages the coordinator sent it (SendMessage) that it has not picked up yet (0.23.0). */
  queued?: string[]
}

/** One subtask of a task: a title, its own status and, once closed, when (0.23.0: the pace a
 *  time-left estimate is calibrated on). */
export type Step = {
  title: string
  status: Status
  /** Why (0.23.0): shown beneath the step — the reason a step is blocked, skipped or failed. */
  note?: string
  doneAt?: string
  removedByUser?: true
}

export type Task = {
  id: string
  title: string
  status: Status
  note?: string
  /** A longer description, shown when the task is unfolded. */
  detail?: string
  /** The repo the task belongs to, when the session works in several; absent = the session's own. */
  repo?: string
  /** Subtasks, shown when unfolded; the title counts the closed ones (`n/m`). */
  steps?: Step[]
  /** The subagent working on it (0.23.0): its Agent call's description or its id; the pane shows
   *  that agent's live progress under the task. */
  agent?: string
  /** Made by the plugin for a subagent that reported while working on no task (0.23.0): replaced
   *  as soon as the coordinator links a task of its own to that agent. */
  auto?: true
  createdAt: string
  updatedAt: string
  doneAt: string | null
}

export type SessionInfo = {
  id: string
  project: string
  /** Claude Code's name for the session (`/rename`, a resumed title); the pane shows it over `project`. */
  title?: string
  cwd: string
  startedAt: string
  endedAt: string | null
  /** The Claude Code process that writes this file, and its machine (0.23.0): a session whose
   *  process is gone without `session.end` (a closed terminal, a kill) is marked ended. */
  pid?: number
  host?: string
}

/** A CI job's state, GitLab's statuses folded into what the pane shows. */
export type JobState = 'queued' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual'

export type PipelineJob = {
  name: string
  stage: string
  state: JobState
  durationS: number | null
  /** When the job started (GitLab's started_at) — a running job's elapsed time counts from it. */
  startedAt?: string
  /** The job's page on GitLab (its web_url) — the pane's ↗ link. */
  url?: string
}

/** Where a watched pipeline lives: GitLab CI (the default) or GitHub Actions. */
export type PipelineProvider = 'gitlab' | 'github' | 'gitea' | 'command'

/**
 * A CI pipeline the session watches; the session's own timer refreshes it through `glab` (GitLab)
 * or `gh` (GitHub Actions, where a "pipeline" is one workflow run) — and any pane does once the
 * session stopped (its copy goes to the session's sidecar).
 */
export type Pipeline = {
  /** `project#id`, or `project@sha` until the pipeline of that commit is found; GitHub runs carry
   *  a `gh:` prefix (`gh:owner/repo#<runId>`). */
  key: string
  /** Absent = GitLab (every pipeline written before 0.10.0). */
  provider?: PipelineProvider
  /** The forge host its calls go to (absent: the forge's public host — gitlab.com, github.com). */
  host?: string
  project: string
  id: number | null
  sha?: string
  ref?: string
  label: string
  state: JobState | 'unknown'
  url?: string
  jobs: PipelineJob[]
  addedAt: string
  checkedAt: string | null
  finishedAt?: string
  /** GitLab's start / finish of the pipeline and its own `duration` (seconds), when known. */
  startedAt?: string
  pipelineFinishedAt?: string
  durationS?: number
  /** How it was triggered (GitLab's source / GitHub's event: push, schedule, …) — similar runs
   *  are matched on it. */
  source?: string
  /** GitHub only: the workflow the run belongs to — similar runs are that workflow's. */
  workflowId?: number
  /** Average duration (s) of up to 5 earlier successful runs of the same ref + source; null = none. */
  estimateS?: number | null
  /** Per job name: the average duration (s) in those similar runs where that job succeeded. */
  jobEstimates?: Record<string, number>
  /** The last refresh's error (glab missing, not logged in, no such pipeline…). */
  error?: string
}

/** One session's file in the shared progress folder (`<session-id>.json`). */
export type SessionFile = {
  version: 2
  session: SessionInfo
  /** This session's own feature switches (0.23.0), over the plugin's defaults: `/progress <feature>
   *  on|off` or the pane's buttons. Absent = the defaults. */
  toggles?: { reporting?: boolean; tasks?: boolean; agents?: boolean; pipelines?: boolean }
  /** Needs-you items Claude Code's own waiting states raised (0.23.0) — a permission prompt, the
   *  idle "waiting for your input" — apart from the agent's `needsYou` (which every report
   *  replaces); cleared as soon as the wait ends. */
  autoNeeds?: { kind: 'permission' | 'idle'; text: string; at: string; agentId?: string }[]
  now?: string
  needsYou: string[]
  updatedAt: string
  tasks: Task[]
  dismissed: string[]
  /** The highest `t<n>` ever handed out, so an id is never reused. */
  seq: number
  /** CI pipelines this session watches (absent in files written before 0.4.0). */
  pipelines?: Pipeline[]
  /** Tasks the person removed in a pane and this session folded in (0.16.0): never removed twice. */
  cancelled?: string[]
  /** The session's subagents' own progress (0.17.0), apart from the session's tasks. */
  agents?: AgentEntry[]
}

/** One person's ✕ on a finished task: hides that task while it stays the same completion (`doneAt`). */
export type Dismissal = { id: string; doneAt: string | null }

/**
 * `<session-id>.dismissed.json` beside a session's file. Only panes write it (✕ / Clear all, and
 * refreshes of pipelines the session stopped polling), so a session's own file keeps exactly one
 * writer, its session. The owner merges it on its next write.
 */
export type SidecarFile = {
  version: 1
  sessionId: string
  entries: Dismissal[]
  /** Open tasks a person removed with ✕ (ids), for the session to fold in and stop (0.16.0). */
  cancelled?: string[]
  /** Pipelines of this session that a pane refreshed because the session stopped polling them
   *  (absent in sidecars written before 0.11.1). A copy wins over the file's entry when checked later. */
  pipelines?: Pipeline[]
}

/** Every session the pane knows, by session id: its file and its sidecar, with the mtimes read at. */
export type Loaded = Record<
  string,
  {
    mtimeMs: number
    file: SessionFile
    sidecar?: { mtimeMs: number; entries: Dismissal[]; pipelines: Pipeline[]; cancelled: string[] }
  }
>

/** Fold state this pane's person set, by Button key (`group:<id>`, `done:<id>`); unset = the default. */
export type Folds = Record<string, boolean>

/** The pane's sort order once the person picked one this session; '' = not yet (use $.store / the option). */
export type SortChoice = '' | 'status' | 'title' | 'created' | 'done'

declare module 'claude-code' {
  interface PluginState {
    'progress-panel': {
      sessions: Shaped<Loaded>
      folds: Shaped<Folds>
      sort: Shaped<SortChoice>
      /** The pane's task filter, as typed (empty = off). */
      filter: Shaped<string>
      /** The plugin's newest release, as last looked up (null = not known). */
      release: Shaped<{ version: string; url: string } | null>
      /** When this pane last listed the folder successfully (ms since the epoch; 0 = not yet). */
      checked: Shaped<number>
      /** What the pane shows: the sessions, or its Settings view (0.23.0). */
      view: Shaped<'main' | 'settings'>
      /** Bumped after each setting the Settings view wrote, so it redraws with the new value. */
      configTick: Shaped<number>
      /** A running pipeline's ✕ pressed once: its key and when the confirm expires (0.23.0). */
      armed: Shaped<{ key: string; untilMs: number } | null>
    }
  }
}
