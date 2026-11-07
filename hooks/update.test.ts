import { expect, test } from 'claude-code/testing'

import { isNewer, latestReleaseUrl, parseLatestRelease } from './update'

test('isNewer compares versions number by number; a v prefix or junk never counts as newer', () => {
  expect(isNewer('0.15.0', '0.14.0')).toBe(true)
  expect(isNewer('v0.14.1', '0.14.0')).toBe(true)
  expect(isNewer('1.0.0', '0.99.9')).toBe(true)
  expect(isNewer('0.10.0', '0.9.1')).toBe(true)
  expect(isNewer('0.14.0', '0.14.0')).toBe(false)
  expect(isNewer('0.13.9', '0.14.0')).toBe(false)
  expect(isNewer('nope', '0.14.0')).toBe(false)
  expect(isNewer('0.15.0', 'nope')).toBe(false)
})

test("latestReleaseUrl: the manifest's GitLab repository → its newest-release API call", () => {
  expect(latestReleaseUrl('https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel')).toBe(
    'https://gitlab.com/api/v4/projects/KirboDev%2Fagentic-coding%2Fclaude-progress-panel/releases?per_page=1',
  )
  expect(latestReleaseUrl('https://git.example.com/team/panel.git/')).toBe(
    'https://git.example.com/api/v4/projects/team%2Fpanel/releases?per_page=1',
  )
  expect(latestReleaseUrl('')).toBeUndefined()
  expect(latestReleaseUrl('not a url')).toBeUndefined()
})

test('parseLatestRelease reads the newest release: its version and its page', () => {
  const text = JSON.stringify([
    { tag_name: 'v0.15.0', _links: { self: 'https://gitlab.com/x/-/releases/v0.15.0' } },
  ])
  expect(parseLatestRelease(text)).toEqual({
    version: '0.15.0',
    url: 'https://gitlab.com/x/-/releases/v0.15.0',
  })
  expect(parseLatestRelease('[]')).toBeUndefined()
  expect(parseLatestRelease('{"message":"404"}')).toBeUndefined()
  expect(parseLatestRelease('nope')).toBeUndefined()
})
