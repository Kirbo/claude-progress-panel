import { expect, test } from 'claude-code/testing'

import { notifiesFinish, readSettings, tint } from './settings'

test('every setting has its built-in default, and an unknown value falls back to it', () => {
  const d = readSettings({})
  expect(d).toMatchObject({
    toastNeedsYou: true,
    bell: false,
    pipelineNotify: 'failures',
    paneScope: 'all',
    autoOpen: 'auto',
    doneShown: 10,
    agentsShown: 5,
    successFoldMs: 3_600_000,
    clock: '24h',
    effort: 'detailed',
    pipelineRefreshMs: 15_000,
    updateCheck: true,
    palette: 'default',
    runningPipelineX: 'delete',
  })
  expect(readSettings({ paneScope: 'bogus', doneShown: '7', pipelineRefreshSec: '30' })).toMatchObject({
    paneScope: 'all',
    doneShown: 10,
    pipelineRefreshMs: 30_000,
  })
  expect(readSettings({ successFoldHours: '0.5', reportingEffort: 'minimal', bell: 'on' })).toMatchObject({
    successFoldMs: 1_800_000,
    effort: 'minimal',
    bell: true,
  })
})

test('the palette: unchanged, colour-blind safe, or no colour at all', () => {
  expect(tint('default', 'green')).toBe('green')
  expect(tint('colorblind', 'green')).toBe('blue')
  expect(tint('colorblind', 'red')).toBe('#E69F00')
  expect(tint('colorblind', 'cyan')).toBe('cyan')
  expect(tint('none', 'red')).toBeUndefined()
  expect(tint('default', undefined)).toBeUndefined()
})

test('a finished pipeline notifies never, on failure only, or always', () => {
  expect(notifiesFinish('never', 'failed')).toBe(false)
  expect(notifiesFinish('failures', 'failed')).toBe(true)
  expect(notifiesFinish('failures', 'success')).toBe(false)
  expect(notifiesFinish('always', 'success')).toBe(true)
})
