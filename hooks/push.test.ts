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
  expect(parsePushes('git push -o ci.skip --force-with-lease origin main')).toEqual([
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

test('pushedRef: a refspec → the local source and the remote branch or tag it lands on', () => {
  expect(pushedRef('main')).toEqual({ src: 'main', name: 'main', tag: false })
  expect(pushedRef('+HEAD:refs/heads/next')).toEqual({ src: 'HEAD', name: 'next', tag: false })
  expect(pushedRef('feature:main')).toEqual({ src: 'feature', name: 'main', tag: false })
  expect(pushedRef('refs/tags/v1.2.0')).toEqual({ src: 'refs/tags/v1.2.0', name: 'v1.2.0', tag: true })
  expect(pushedRef(':gone')).toBeUndefined()
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
