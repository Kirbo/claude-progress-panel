// The plugin's type contract: the session file every session writes, and the pane's state.
// Self-contained on purpose — `claude plugin validate` refuses imports here.

export type Status = 'todo' | 'doing' | 'blocked' | 'done' | 'skipped'

/** One subtask of a task: a title and its own status. */
export type Step = { title: string; status: Status }

export type Task = {
  id: string
  title: string
  status: Status
  note?: string
  /** A longer description, shown when the task is unfolded. */
  detail?: string
  /** Subtasks, shown when unfolded; the title counts the closed ones (`n/m`). */
  steps?: Step[]
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
  now?: string
  needsYou: string[]
  updatedAt: string
  tasks: Task[]
  dismissed: string[]
  /** The highest `t<n>` ever handed out, so an id is never reused. */
  seq: number
  /** CI pipelines this session watches (absent in files written before 0.4.0). */
  pipelines?: Pipeline[]
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
    sidecar?: { mtimeMs: number; entries: Dismissal[]; pipelines: Pipeline[] }
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
      /** When this pane last listed the folder successfully (ms since the epoch; 0 = not yet). */
      checked: Shaped<number>
    }
  }
}
