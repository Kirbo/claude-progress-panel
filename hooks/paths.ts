export type PathEnv = { home?: string; configDir?: string }

const FILE_NAME = 'progress.json'

function trimSlash(dir: string): string {
  return dir.replace(/[\\/]+$/, '')
}

/**
 * The status file the pane reads: the `progressFile` option when set (`~/` expands to the home
 * directory), else `progress.json` in Claude Code's config directory (`CLAUDE_CONFIG_DIR`, or
 * `~/.claude`). Undefined when no option is set and no home directory is known.
 */
export function resolveProgressFile(option: string, env: PathEnv): string | undefined {
  const chosen = option.trim()
  if (chosen) {
    if (chosen.startsWith('~/') && env.home) return `${trimSlash(env.home)}/${chosen.slice(2)}`
    return chosen
  }
  if (env.configDir?.trim()) return `${trimSlash(env.configDir.trim())}/${FILE_NAME}`
  if (env.home) return `${trimSlash(env.home)}/.claude/${FILE_NAME}`
  return undefined
}
