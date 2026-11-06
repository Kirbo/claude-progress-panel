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
}

/** Every session file the pane knows, by session id, with the mtime it was read at. */
export type Loaded = Record<string, { mtimeMs: number; file: SessionFile }>

/** Fold state this pane's person set, by Button key (`group:<id>`, `done:<id>`); unset = the default. */
export type Folds = Record<string, boolean>

/** The pane's sort order once the person picked one this session; '' = not yet (use $.store / the option). */
export type SortChoice = '' | 'status' | 'title' | 'created' | 'done'

declare module 'claude-code' {
  interface PluginState {
    'progress-panel': { sessions: Shaped<Loaded>; folds: Shaped<Folds>; sort: Shaped<SortChoice> }
  }
}
