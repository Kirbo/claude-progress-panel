// `/progress doctor`: the pure half — what a forge CLI's or git's failure means, and how a check
// reads. The checks themselves (version, rule, folder, the repo's CI, its forge CLI, git's reach)
// run in register.tsx through `$`.

/** How a check came out: fine, wrong (with a fix), or not applicable / not checked. */
export type CheckState = 'ok' | 'fail' | 'skip'

export type Check = { state: CheckState; label: string; detail: string; fix?: string }

/** What a failed forge CLI call says about the person's setup. */
export type CliProblem = 'missing' | 'auth' | 'access' | 'other'

/**
 * A forge CLI's failure → why: not installed (the engine's spawn error or exit 127), not logged in
 * for the host (401, "not logged in", "authentication"), logged in but unable to read the project
 * (403 / 404 — a token scoped to other projects reads exactly so), or something else.
 */
export function classifyCliError(error: string, exitCode?: number): CliProblem {
  const text = error.toLowerCase()
  if (
    exitCode === 127 ||
    /enoent|exited 127|not found in path|command not found|no such file|executable file not found/.test(text)
  )
    return 'missing'
  if (
    /\b401\b|unauthori[sz]ed|not logged|no login|no token|authentication|auth login|has not been authenticated/.test(
      text,
    )
  )
    return 'auth'
  if (/\b40[34]\b|forbidden|not found|could not resolve to a repository|no such project/.test(text))
    return 'access'
  return 'other'
}

/** A failed `git ls-remote` → the setup problem it shows, or undefined when nothing specific. */
export function classifyGitError(error: string): 'hostkey' | 'auth' | undefined {
  const text = error.toLowerCase()
  if (/host key verification failed|remote host identification has changed/.test(text)) return 'hostkey'
  if (/permission denied|could not read username|authentication failed|terminal prompts disabled/.test(text))
    return 'auth'
  return undefined
}

const MARK: Record<CheckState, string> = { ok: '✓', fail: '✗', skip: '–' }

/** The report: one line per check, its fix indented beneath a failed one. */
export function formatChecks(checks: Check[]): string {
  return checks
    .map(c => {
      const line = `${MARK[c.state]} ${c.label}: ${c.detail}`
      return c.fix && c.state === 'fail' ? `${line}\n    → ${c.fix}` : line
    })
    .join('\n')
}
