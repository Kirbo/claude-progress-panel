import { expect, test } from 'claude-code/testing'

import { groupSettings, isChangedSetting, notifiesFinish, readSettings, tint, valueTone } from './settings'

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

test('the Settings view groups the defaults in order, an unknown field last; values toned; a change stands out', () => {
  const row = (field: string) => ({ key: `progress-panel.${field}` })
  const groups = groupSettings([
    row('palette'),
    row('bell'),
    row('autoStart'),
    row('newThing'),
    row('progressDir'),
  ])
  expect(groups.map(g => g.heading)).toEqual([
    'settings.group.reporting',
    'settings.group.notifications',
    'settings.group.pane',
    'settings.group.storage',
    'settings.group.other',
  ])
  expect(groups[4]?.rows.map(r => r.key)).toEqual(['progress-panel.newThing'])
  expect([valueTone('on'), valueTone('off'), valueTone(''), valueTone('24h')]).toEqual([
    'on',
    'off',
    'empty',
    'choice',
  ])
  expect(isChangedSetting('on', 'off')).toBe(true)
  expect(isChangedSetting('84', '84')).toBe(false)
  expect(isChangedSetting('', undefined)).toBe(false)
})
