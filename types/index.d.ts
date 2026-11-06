export type PhaseStatus = 'doing' | 'blocked' | 'done' | 'skipped' | 'todo'

export type Phase = { title: string; status: PhaseStatus | string; note?: string }

export type Progress = {
  now?: string
  needsYou?: string[]
  phases?: Phase[]
  updated?: string
}

export type Loaded = { mtimeMs: number; progress?: Progress; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'progress-panel': { loaded: Shaped<Loaded> }
  }
}
