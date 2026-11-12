import { expect, test } from 'claude-code/testing'

import { ciProvider, parsePushes, pushedRef, resolvePath } from './push'

test('parsePushes: a plain push, one naming its remote and refspecs, and no push at all', () => {
  expect(parsePushes('git push')).toEqual([{ refs: [] }])
  expect(parsePushes('git push origin main feature/x')).toEqual([
    { remote: 'origin', refs: ['main', 'feature/x'] },
  ])
  expect(parsePushes('git status && git log --oneline')).toEqual([])
  expect(parsePushes('echo "git push"')).toEqual([])
  expect(parsePushes('')).toEqual([])
})

test('parsePushes: the folder from -C and from a leading cd, chained and quoted', () => {
  expect(parsePushes('git -C ../other push')).toEqual([{ dir: '../other', refs: [] }])
  expect(parsePushes("cd '/w/my app' && git push -u origin HEAD")).toEqual([
    { dir: '/w/my app', remote: 'origin', refs: ['HEAD'] },
  ])
  // A cd applies to everything after it; -C is relative to it.
  expect(parsePushes('cd /w && git -C app push; git push')).toEqual([
    { dir: '/w/app', refs: [] },
    { dir: '/w', refs: [] },
  ])
  expect(parsePushes('pnpm lint && git commit -m "x; y" && git push')).toEqual([{ refs: [] }])
  // Environment assignments and git's own options before the subcommand.
  expect(parsePushes('GIT_TRACE=0 git -c credential.helper= -c x=y --no-pager push origin')).toEqual([
    { remote: 'origin', refs: [] },
  ])
})

test('parsePushes: Windows and pushd forms — cd /d, a drive path, git.exe, pushd', () => {
  expect(parsePushes('cd /d C:/w/app && git push')).toEqual([{ dir: 'C:/w/app', refs: [] }])
  expect(parsePushes("cd 'D:\\w\\app' && git.exe push origin")).toEqual([
    { dir: 'D:\\w\\app', remote: 'origin', refs: [] },
  ])
  expect(parsePushes('pushd /w/app && git push && popd')).toEqual([{ dir: '/w/app', refs: [] }])
  // A drive path after cd is absolute: never joined onto an earlier cd.
  expect(parsePushes('cd /w && cd C:/x && git push')).toEqual([{ dir: 'C:/x', refs: [] }])
})

test('parsePushes: options that take a value are skipped; --all and --tags are noted', () => {
  expect(parsePushes('git push -o merge_request.create --force-with-lease origin main')).toEqual([
    { remote: 'origin', refs: ['main'] },
  ])
  expect(parsePushes('git push --push-option=x --all origin')).toEqual([
    { remote: 'origin', refs: [], all: true },
  ])
  expect(parsePushes('git push --tags')).toEqual([{ refs: [], tags: true }])
})

test('parsePushes: a dry run, a delete and a mirror push watch nothing', () => {
  expect(parsePushes('git push --dry-run')).toEqual([])
  expect(parsePushes('git push -n origin main')).toEqual([])
  expect(parsePushes('git push --delete origin old')).toEqual([])
  expect(parsePushes('git push -d origin old')).toEqual([])
  expect(parsePushes('git push origin :old')).toEqual([])
  expect(parsePushes('git push --mirror')).toEqual([])
})

// The idioms an agent actually writes around a push: each must read as the same push.
const IDIOMS: [string, ReturnType<typeof parsePushes>][] = [
  // Redirections: the operator and its target are no part of the push.
  ['git push 2>&1', [{ refs: [] }]],
  ['git push > push.log 2>&1', [{ refs: [] }]],
  ['git push >push.log 2>&1', [{ refs: [] }]],
  ['git push >> push.log', [{ refs: [] }]],
  ['git push 2>/dev/null', [{ refs: [] }]],
  ['git push &> /dev/null', [{ refs: [] }]],
  ['git push &>/dev/null', [{ refs: [] }]],
  ['git push 1>&2', [{ refs: [] }]],
  ['git push 2>&1 | tail -5', [{ refs: [] }]],
  ['git push < /dev/null', [{ refs: [] }]],
  ['git push origin next 2>&1', [{ remote: 'origin', refs: ['next'] }]],
  ['git push origin main>log', [{ remote: 'origin', refs: ['main'] }]],
  ['2>&1 git push', [{ refs: [] }]],
  // Chains.
  ['git add -A && git commit -m "fix: x" && git push', [{ refs: [] }]],
  ['git commit -m "a (b) > c" && git push 2>&1', [{ refs: [] }]],
  ['git push || echo failed', [{ refs: [] }]],
  [
    'git push origin next && git push origin main',
    [
      { remote: 'origin', refs: ['next'] },
      { remote: 'origin', refs: ['main'] },
    ],
  ],
  [
    'git push origin next;git push origin v1.2.3',
    [
      { remote: 'origin', refs: ['next'] },
      { remote: 'origin', refs: ['v1.2.3'] },
    ],
  ],
  // Subshells and groups: a cd inside parentheses ends with them; braces keep it.
  ['(cd x && git push)', [{ dir: 'x', refs: [] }]],
  ['(cd x && git push) && git push', [{ dir: 'x', refs: [] }, { refs: [] }]],
  ['( cd /w/app; git push origin main ) 2>&1', [{ dir: '/w/app', remote: 'origin', refs: ['main'] }]],
  ['cd /w && (cd app && git push)', [{ dir: '/w/app', refs: [] }]],
  ['{ git push; } 2>&1', [{ refs: [] }]],
  [
    '{ cd x && git push; }; git push',
    [
      { dir: 'x', refs: [] },
      { dir: 'x', refs: [] },
    ],
  ],
  // -C, env prefixes and wrappers in front of git.
  ['git -C /w/app push 2>&1', [{ dir: '/w/app', refs: [] }]],
  ['git -C "/w/my app" push origin main', [{ dir: '/w/my app', remote: 'origin', refs: ['main'] }]],
  ['GIT_SSH_COMMAND="ssh -S /tmp/s" git push origin next', [{ remote: 'origin', refs: ['next'] }]],
  ['A=1 B=2 git push', [{ refs: [] }]],
  ['env GIT_TRACE=1 git push', [{ refs: [] }]],
  ['timeout 120 git push origin main', [{ remote: 'origin', refs: ['main'] }]],
  ['timeout -k 5 2m git push', [{ refs: [] }]],
  ['time git push', [{ refs: [] }]],
  ['if git push; then echo ok; fi', [{ refs: [] }]],
  // Force, upstream, an explicit remote and refspecs, several refs in one push.
  ['git push --force-with-lease', [{ refs: [] }]],
  ['git push --force-with-lease=main:abc1234 origin main', [{ remote: 'origin', refs: ['main'] }]],
  ['git push --force-with-lease --force-if-includes origin +feat', [{ remote: 'origin', refs: ['+feat'] }]],
  ['git push -fu origin HEAD', [{ remote: 'origin', refs: ['HEAD'] }]],
  ['git push --set-upstream origin feature/x', [{ remote: 'origin', refs: ['feature/x'] }]],
  ['git push origin next main', [{ remote: 'origin', refs: ['next', 'main'] }]],
  [
    'git push origin HEAD:refs/heads/next refs/tags/v1.0.0',
    [{ remote: 'origin', refs: ['HEAD:refs/heads/next', 'refs/tags/v1.0.0'] }],
  ],
  ['git push git@gitlab.com:team/app.git main', [{ remote: 'git@gitlab.com:team/app.git', refs: ['main'] }]],
  [
    'git push https://github.com/o/r.git HEAD:main',
    [{ remote: 'https://github.com/o/r.git', refs: ['HEAD:main'] }],
  ],
  ['git push --follow-tags origin main', [{ remote: 'origin', refs: ['main'] }]],
  ['git push --no-verify --atomic origin main v2', [{ remote: 'origin', refs: ['main', 'v2'] }]],
  // The current branch, asked of git in the command itself, is HEAD.
  ['git push origin "$(git branch --show-current)"', [{ remote: 'origin', refs: ['HEAD'] }]],
  ['git push -u origin $(git rev-parse --abbrev-ref HEAD) 2>&1', [{ remote: 'origin', refs: ['HEAD'] }]],
  // A comment, and a trailing background &.
  ['git push # ship it', [{ refs: [] }]],
  ['git push &', [{ refs: [] }]],
]

test('parsePushes: redirects, chains, subshells, -C, env prefixes, force, remotes and refspecs', () => {
  for (const [command, pushes] of IDIOMS) expect([command, parsePushes(command)]).toEqual([command, pushes])
})

test('parsePushes: text that only mentions a push is no push — quotes, heredocs, substitutions', () => {
  const heredoc = [
    "git commit -m \"$(cat <<'EOF'",
    "fix: don't (ever) drop a redirect",
    '',
    'git push 2>&1 is watched now',
    'EOF',
    ')"',
  ].join('\n')
  expect(parsePushes(heredoc)).toEqual([])
  expect(parsePushes(`${heredoc} && git push origin next`)).toEqual([{ remote: 'origin', refs: ['next'] }])
  expect(parsePushes('cat > notes.md <<EOF\ngit push origin main\nEOF\ngit status')).toEqual([])
  expect(parsePushes('cat <<-EOF\n\tgit push\n\tEOF\ngit push origin v1')).toEqual([
    { remote: 'origin', refs: ['v1'] },
  ])
  expect(parsePushes('echo $(git push --help | head -1)')).toEqual([])
  expect(parsePushes('echo `git push --help`')).toEqual([])
  expect(parsePushes('# git push\ngit status')).toEqual([])
  expect(parsePushes('grep -rn "git push" docs > out.txt')).toEqual([])
})

test('parsePushes: a push that tells the forge to skip CI watches nothing', () => {
  expect(parsePushes('git push -o ci.skip origin main')).toEqual([])
  expect(parsePushes('git push --push-option=ci.skip')).toEqual([])
  expect(parsePushes('git push --push-option ci.skip 2>&1')).toEqual([])
})

test('pushedRef: a refspec → the local source and the remote branch or tag it lands on', () => {
  expect(pushedRef('main')).toEqual({ src: 'main', name: 'main', tag: false })
  expect(pushedRef('+HEAD:refs/heads/next')).toEqual({ src: 'HEAD', name: 'next', tag: false })
  expect(pushedRef('feature:main')).toEqual({ src: 'feature', name: 'main', tag: false })
  expect(pushedRef('refs/tags/v1.2.0')).toEqual({ src: 'refs/tags/v1.2.0', name: 'v1.2.0', tag: true })
  expect(pushedRef(':gone')).toBeUndefined()
  // Never a source git would read as an option.
  expect(pushedRef('+-x')).toBeUndefined()
  expect(pushedRef('')).toBeUndefined()
})

test('resolvePath: absolute, relative, ~ and .. segments', () => {
  expect(resolvePath('/w/app', undefined, '/home/me')).toBe('/w/app')
  expect(resolvePath('/w/app', '../other', '/home/me')).toBe('/w/other')
  expect(resolvePath('/w/app', '/srv/x/', '/home/me')).toBe('/srv/x')
  expect(resolvePath('/w/app', '~/Projects/p', '/home/me')).toBe('/home/me/Projects/p')
  expect(resolvePath('/w/app', './sub/./deeper/..', '/home/me')).toBe('/w/app/sub')
})

test('resolvePath: Windows drive paths stay on their drive, backslashes read as slashes', () => {
  expect(resolvePath('C:/w/app', undefined, undefined)).toBe('C:/w/app')
  expect(resolvePath('C:\\w\\app', '..\\other', undefined)).toBe('C:/w/other')
  expect(resolvePath('/w/app', 'D:\\x\\y', undefined)).toBe('D:/x/y')
  expect(resolvePath('C:/w', '~/p', 'C:/Users/me')).toBe('C:/Users/me/p')
})

test('ciProvider: GitLab, GitHub, Gitea/Forgejo, a custom command, else none', () => {
  expect(ciProvider({ gitlab: true, github: false, gitea: false }, false)).toBe('gitlab')
  expect(ciProvider({ gitlab: false, github: true, gitea: false }, true)).toBe('github')
  expect(ciProvider({ gitlab: false, github: false, gitea: true }, false)).toBe('gitea')
  expect(ciProvider({ gitlab: false, github: false, gitea: false }, true)).toBe('command')
  expect(ciProvider({ gitlab: false, github: false, gitea: false }, false)).toBeUndefined()
})
