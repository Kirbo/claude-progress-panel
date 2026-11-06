// The plugin's type contract: the session file every session writes, and the pane's state.
// Self-contained on purpose — `claude plugin validate` refuses imports here.

export type Status = 'todo' | 'doing' | 'blocked' | 'done' | 'skipped'

export type Task = {
  id: string
  title: string
  status: Status
  note?: string
  createdAt: string
  updatedAt: string
  doneAt: string | null
}

export type SessionInfo = {
  id: string
  project: string
  cwd: string
  startedAt: string
  endedAt: string | null
}

/** A CI job's state, GitLab's statuses folded into what the pane shows. */
export type JobState = 'queued' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual'

export type PipelineJob = { name: string; stage: string; state: JobState; durationS: number | null }

/** A CI pipeline the session watches; the session's own timer refreshes it through `glab`. */
export type Pipeline = {
  /** `project#id`, or `project@sha` until the pipeline of that commit is found. */
  key: string
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
 * `<session-id>.dismissed.json` beside a session's file. Only panes write it (✕ / Clear all), so a
 * session's own file keeps exactly one writer, its session. The owner merges it on its next write.
 */
export type SidecarFile = { version: 1; sessionId: string; entries: Dismissal[] }

/** Every session the pane knows, by session id: its file and its sidecar, with the mtimes read at. */
export type Loaded = Record<
  string,
  { mtimeMs: number; file: SessionFile; sidecar?: { mtimeMs: number; entries: Dismissal[] } }
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
