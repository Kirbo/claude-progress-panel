// A custom CI command: the person's own script, named in the plugin's settings (never by the tool's
// input), that prints a pipeline's status as JSON — any CI the plugin has no adapter for (Jenkins,
// Bitbucket, Azure DevOps, Woodpecker…). No shell: the setting is split on whitespace and each
// placeholder is filled inside its own argument, so a watched value never becomes more arguments.

import type { JobState, PipelineJob } from '../types'
import { json, str } from './github'
import type { PipelineHead } from './pipelines'

const STATES: readonly JobState[] = [
  'queued',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
  'manual',
]

export type CommandValues = {
  project: string
  id: number | null
  sha?: string
  host?: string
  home: string
}

/** The setting → argv: `{project}`, `{id}`, `{sha}`, `{host}` filled ('' when unknown), `~/` = home. */
export function commandArgv(template: string, v: CommandValues): string[] {
  const values: Record<string, string> = {
    project: v.project,
    id: v.id === null ? '' : String(v.id),
    sha: v.sha ?? '',
    host: v.host ?? '',
  }
  return template
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((arg, i) => {
      const expanded = i === 0 && arg.startsWith('~/') ? `${v.home}${arg.slice(1)}` : arg
      return expanded.replace(/\{(project|id|sha|host)\}/g, (_, name: string) => values[name] ?? '')
    })
}

const state = (v: unknown): JobState =>
  typeof v === 'string' && (STATES as readonly string[]).includes(v) ? (v as JobState) : 'queued'

/**
 * The command's output → the pipeline's head and jobs; null when it printed nothing or `{}` (not
 * created yet — try again next round), undefined when it is not the documented shape.
 */
export function parseCommandStatus(
  text: string,
): { head: PipelineHead; jobs: PipelineJob[] } | null | undefined {
  if (!text.trim()) return null
  const raw = json(text) as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if (Object.keys(raw).length === 0) return null
  if (typeof raw.id !== 'number' || typeof raw.state !== 'string') return undefined
  const head: PipelineHead = {
    id: raw.id,
    state: state(raw.state),
    ...(str(raw.url) ? { url: raw.url as string } : {}),
    ...(str(raw.ref) ? { ref: raw.ref as string } : {}),
    ...(str(raw.startedAt) ? { startedAt: raw.startedAt as string } : {}),
    ...(str(raw.finishedAt) ? { pipelineFinishedAt: raw.finishedAt as string } : {}),
    ...(typeof raw.durationS === 'number' ? { durationS: raw.durationS } : {}),
  }
  const jobs = (Array.isArray(raw.jobs) ? raw.jobs : [])
    .filter(
      (j): j is Record<string, unknown> => typeof j === 'object' && j !== null && typeof j.name === 'string',
    )
    .map(j => ({
      name: j.name as string,
      stage: str(j.stage) ?? '',
      state: state(j.state),
      durationS: typeof j.durationS === 'number' ? j.durationS : null,
      ...(str(j.startedAt) ? { startedAt: j.startedAt as string } : {}),
      ...(str(j.url) ? { url: j.url as string } : {}),
    }))
  return { head, jobs }
}
