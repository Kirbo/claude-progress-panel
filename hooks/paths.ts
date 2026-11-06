export type PathEnv = { home?: string; configDir?: string }

const DIR_NAME = 'progress'

function trimSlash(dir: string): string {
  return dir.replace(/[\\/]+$/, '')
}

/**
 * The shared folder every session's status file lives in: the `progressDir` option when set
 * (`~/` expands to the home directory), else `progress/` in Claude Code's config directory
 * (`CLAUDE_CONFIG_DIR`, or `~/.claude`). Undefined when no option is set and no home is known.
 */
export function resolveProgressDir(option: string, env: PathEnv): string | undefined {
  const chosen = option.trim()
  if (chosen) {
    if (chosen.startsWith('~/') && env.home) return trimSlash(`${trimSlash(env.home)}/${chosen.slice(2)}`)
    return trimSlash(chosen)
  }
  if (env.configDir?.trim()) return `${trimSlash(env.configDir.trim())}/${DIR_NAME}`
  if (env.home) return `${trimSlash(env.home)}/.claude/${DIR_NAME}`
  return undefined
}

/** The last segment of a path, either separator. */
export function baseName(path: string): string {
  return trimSlash(path).split(/[\\/]/).pop() ?? path
}
