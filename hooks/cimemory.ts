// What the plugin remembers about each repo's CI, shared by every session on the machine (a small
// file in the progress folder): a repo known to run no CI is not detected again on every push, and
// its agent is told once to stop watching its pushes. Pure — the file I/O is register.tsx's.

/** `none`: no CI files (or a mirror on another kind of forge); `nopipeline`: CI files, but a pushed
 *  commit never got a pipeline (CI off on the forge); `yes`: pipelines run. */
export type CiVerdict = 'none' | 'nopipeline' | 'yes'

export type RepoMemory = {
  ci: CiVerdict
  /** Which CI files the repo had when judged (`ciFiles`): a change means judge again. */
  files: string
  /** The forge the pushes went to, when known — how a "no pipeline" finding finds its repo. */
  host?: string
  project?: string
  checkedAtMs: number
}

export type CiMemory = { version: 1; repos: Record<string, RepoMemory> }

/** A verdict is trusted this long; then the next push judges again. */
export const CI_MEMORY_TTL_MS = 7 * 24 * 3_600_000

/** The memory's file name in the progress folder (not `.json`: the session scan reads those). */
export const CI_MEMORY_FILE = 'ci-memory.v1'

/** A repo + the remote a push names (`''` = its upstream / origin): a mirror is remembered apart. */
export function repoKey(root: string, remote: string | undefined): string {
  return `${root}|${remote ?? ''}`
}

/** The CI files a repo has, as one comparable string. */
export function ciFiles(
  files: { gitlab: boolean; github: boolean; gitea: boolean },
  hasCommand: boolean,
): string {
  return `${files.gitlab ? 'L' : '-'}${files.github ? 'H' : '-'}${files.gitea ? 'T' : '-'}${hasCommand ? 'C' : '-'}`
}

export function parseCiMemory(text: string | undefined): CiMemory {
  if (!text) return { version: 1, repos: {} }
  try {
    const raw = JSON.parse(text) as Partial<CiMemory>
    if (raw?.version !== 1 || typeof raw.repos !== 'object' || raw.repos === null)
      return { version: 1, repos: {} }
    return { version: 1, repos: raw.repos as Record<string, RepoMemory> }
  } catch {
    return { version: 1, repos: {} }
  }
}

/**
 * The remembered verdict for a repo when it still holds: same CI files and younger than the TTL;
 * undefined when the repo must be judged again.
 */
export function remembered(
  memory: CiMemory,
  key: string,
  files: string,
  nowMs: number,
): RepoMemory | undefined {
  const entry = memory.repos[key]
  if (!entry || entry.files !== files || nowMs - entry.checkedAtMs >= CI_MEMORY_TTL_MS) return undefined
  return entry
}

/** The memory with one repo's verdict set (`undefined` forgets it). */
export function withVerdict(memory: CiMemory, key: string, entry: RepoMemory | undefined): CiMemory {
  const repos = { ...memory.repos }
  if (entry) repos[key] = entry
  else delete repos[key]
  return { version: 1, repos }
}

/** A watched commit never got a pipeline: every repo pushing to that forge project runs none. */
export function markNoPipeline(
  memory: CiMemory,
  host: string | undefined,
  project: string,
  nowMs: number,
): CiMemory {
  let changed = false
  const repos = { ...memory.repos }
  for (const [key, entry] of Object.entries(repos))
    if (entry.ci === 'yes' && entry.project === project && (entry.host ?? '') === (host ?? '')) {
      repos[key] = { ...entry, ci: 'nopipeline', checkedAtMs: nowMs }
      changed = true
    }
  return changed ? { version: 1, repos } : memory
}
