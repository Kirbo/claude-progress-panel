import { expect, test } from 'claude-code/testing'
import { classifyCliError, classifyGitError, formatChecks } from './doctor'

test('a forge CLI failure says what is wrong with the setup', () => {
  expect(classifyCliError('spawn glab ENOENT')).toBe('missing')
  expect(classifyCliError('anything', 127)).toBe('missing')
  expect(classifyCliError('glab exited 127')).toBe('missing')
  expect(classifyCliError('glab: 401 Unauthorized')).toBe('auth')
  expect(classifyCliError('tea: no login for git.example.com (tea login add)')).toBe('auth')
  expect(classifyCliError('You are not logged into any GitLab hosts. Run glab auth login')).toBe('auth')
  expect(classifyCliError('gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN')).toBe(
    'other',
  )
  // A token that sees only other projects: logged in, this project unreadable.
  expect(classifyCliError('glab: 404 Project Not Found')).toBe('access')
  expect(classifyCliError('gh: Not Found (HTTP 404)')).toBe('access')
  expect(classifyCliError('HTTP 403: Forbidden')).toBe('access')
  expect(classifyCliError('timeout')).toBe('other')
})

test("git's failure to reach a remote names the SSH host key or the credentials", () => {
  expect(classifyGitError('Host key verification failed.\nfatal: Could not read from remote')).toBe('hostkey')
  expect(classifyGitError('git@gitlab.com: Permission denied (publickey).')).toBe('auth')
  expect(classifyGitError("fatal: could not read Username for 'https://gitlab.com'")).toBe('auth')
  expect(classifyGitError('fatal: unable to access: Could not resolve host')).toBeUndefined()
})

test('the report is one line per check, a fix beneath each failed one', () => {
  expect(
    formatChecks([
      { state: 'ok', label: 'Version', detail: '0.22.1' },
      { state: 'fail', label: 'Forge CLI', detail: 'glab cannot read group/app', fix: 'glab auth login' },
      { state: 'skip', label: 'CI', detail: 'no repo', fix: 'never shown' },
    ]),
  ).toBe('✓ Version: 0.22.1\n✗ Forge CLI: glab cannot read group/app\n    → glab auth login\n– CI: no repo')
})
