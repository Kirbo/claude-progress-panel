import { expect, test } from 'claude-code/testing'

import { apiHost, defaultHost, forgeMatches, parseRemote, watchHost } from './forges'

test('parseRemote: scp-style, ssh:// and https:// remotes → host + path, .git and users dropped', () => {
  expect(parseRemote('git@gitlab.com:KirboDev/agentic-coding/switchboard.git')).toEqual({
    host: 'gitlab.com',
    path: 'KirboDev/agentic-coding/switchboard',
  })
  expect(parseRemote('ssh://git@git.example.com:2222/team/app.git')).toEqual({
    host: 'git.example.com',
    path: 'team/app',
  })
  expect(parseRemote('https://user:secret@GitHub.com/Owner/Repo')).toEqual({
    host: 'github.com',
    path: 'Owner/Repo',
  })
  // An https port is the web port, so it stays part of the API host.
  expect(parseRemote('https://git.example.com:8443/team/app.git/')).toEqual({
    host: 'git.example.com:8443',
    path: 'team/app',
  })
  // The forges' ssh-only names are their web hosts.
  expect(parseRemote('ssh://git@ssh.github.com:443/o/r.git')?.host).toBe('github.com')
  expect(parseRemote('ssh://git@altssh.gitlab.com:443/g/r.git')?.host).toBe('gitlab.com')
})

test('parseRemote: an ssh alias (no dot), a local path or nothing is no forge host', () => {
  expect(parseRemote('work-gitlab:team/app.git')).toBeUndefined()
  expect(parseRemote('/srv/git/app.git')).toBeUndefined()
  expect(parseRemote('file:///srv/git/app.git')).toBeUndefined()
  expect(parseRemote('')).toBeUndefined()
  expect(parseRemote(null)).toBeUndefined()
  expect(parseRemote('https://gitlab.com/')).toBeUndefined()
})

test('watchHost: the given host, else the remote host when the watch is that repo, else none', () => {
  const remote = { host: 'git.example.com', path: 'team/app' }
  expect(watchHost('https://Git.Other.org/', 'team/app', remote)).toBe('git.other.org')
  expect(watchHost(undefined, 'team/app', remote)).toBe('git.example.com')
  expect(watchHost(undefined, 'Team/App', remote)).toBe('git.example.com')
  expect(watchHost(undefined, 'team/other', remote)).toBeUndefined()
  expect(watchHost(undefined, 'team/app', undefined)).toBeUndefined()
  expect(watchHost('  ', 'team/app', undefined)).toBeUndefined()
})

test('apiHost: a stored host, else the forge default (gitea/command have none)', () => {
  expect(defaultHost('gitlab')).toBe('gitlab.com')
  expect(defaultHost('github')).toBe('github.com')
  expect(defaultHost('gitea')).toBeUndefined()
  expect(defaultHost('command')).toBeUndefined()
  expect(apiHost({ provider: 'github', host: 'ghe.example.com' })).toBe('ghe.example.com')
  expect(apiHost({ provider: 'github' })).toBe('github.com')
  // Absent provider = GitLab (files from before 0.10.0).
  expect(apiHost({})).toBe('gitlab.com')
})

test("forgeMatches: a repo's CI runs only on its own kind of forge — a mirror on another forge watches nothing", () => {
  expect(forgeMatches('gitlab', 'gitlab.com')).toBe(true)
  expect(forgeMatches('gitlab', 'git.example.com')).toBe(true)
  // A GitLab-CI repo pushed to its GitHub mirror: GitHub runs no .gitlab-ci.yml.
  expect(forgeMatches('gitlab', 'github.com')).toBe(false)
  expect(forgeMatches('github', 'github.com')).toBe(true)
  expect(forgeMatches('github', 'github.example.com')).toBe(true)
  expect(forgeMatches('github', 'gitlab.com')).toBe(false)
  expect(forgeMatches('gitea', 'codeberg.org')).toBe(true)
  expect(forgeMatches('gitea', 'github.com')).toBe(false)
  expect(forgeMatches('gitea', 'gitlab.com')).toBe(false)
  expect(forgeMatches('command', 'github.com')).toBe(true)
})
