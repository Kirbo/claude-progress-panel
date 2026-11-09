import { expect, test } from 'claude-code/testing'

import {
  active,
  changeNote,
  defaultsFrom,
  effective,
  netChange,
  parseProgressCommand,
  ruleKeys,
  withToggle,
} from './toggles'

test('defaults: everything on unless the settings say otherwise; autoStart is reporting', () => {
  expect(defaultsFrom({})).toEqual({ reporting: true, tasks: true, agents: true, pipelines: true })
  expect(
    defaultsFrom({ autoStart: 'off', tasksDefault: 'off', agentsDefault: 'on', pipelinesDefault: '' }),
  ).toEqual({
    reporting: false,
    tasks: false,
    agents: true,
    pipelines: true,
  })
})

test("a session's overrides win over the defaults; reporting is the master switch", () => {
  const d = defaultsFrom({ autoStart: 'off' })
  const eff = effective(d, { reporting: true, pipelines: false })
  expect(eff).toEqual({ reporting: true, tasks: true, agents: true, pipelines: false })
  expect(active(eff, 'pipelines')).toBe(false)
  expect(active(eff, 'tasks')).toBe(true)
  expect(active(effective(d, {}), 'tasks')).toBe(false)
  expect(withToggle({ tasks: false }, 'tasks', undefined)).toEqual({})
  expect(withToggle(undefined, 'agents', false)).toEqual({ agents: false })
})

test('/progress arguments: open, doctor, status, on/off and per-feature switches', () => {
  expect(parseProgressCommand('')).toEqual({ kind: 'open' })
  expect(parseProgressCommand(undefined)).toEqual({ kind: 'open' })
  expect(parseProgressCommand(' Doctor ')).toEqual({ kind: 'doctor' })
  expect(parseProgressCommand('status')).toEqual({ kind: 'status' })
  expect(parseProgressCommand('settings')).toEqual({ kind: 'settings' })
  expect(parseProgressCommand('off')).toEqual({ kind: 'set', feature: 'reporting', on: false })
  expect(parseProgressCommand('enable')).toEqual({ kind: 'set', feature: 'reporting', on: true })
  expect(parseProgressCommand('pipelines off')).toEqual({ kind: 'set', feature: 'pipelines', on: false })
  expect(parseProgressCommand('AGENTS on')).toEqual({ kind: 'set', feature: 'agents', on: true })
  expect(parseProgressCommand('pipelines recheck')).toEqual({ kind: 'recheck' })
  expect(parseProgressCommand('tasks')).toEqual({ kind: 'unknown' })
  expect(parseProgressCommand('bogus on')).toEqual({ kind: 'unknown' })
})

test('the rule leaves out the bullets of what is off', () => {
  const all = ruleKeys({ reporting: true, tasks: true, agents: true, pipelines: true })
  expect(all).toContain('rule.plan')
  expect(all).toContain('rule.push')
  expect(all).toContain('rule.subagent')
  const lean = ruleKeys({ reporting: true, tasks: false, agents: false, pipelines: false })
  expect(lean).toContain('rule.nowOnly')
  expect(lean).toContain('rule.needs')
  for (const gone of ['rule.plan', 'rule.steps', 'rule.push', 'rule.subagent'] as const)
    expect(lean).not.toContain(gone)
  // The reporting effort: milestones swaps the step-by-step bullets for one; minimal keeps now only.
  const on = { reporting: true, tasks: true, agents: true, pipelines: true }
  expect(ruleKeys(on, 'milestones')).toContain('rule.milestones')
  expect(ruleKeys(on, 'milestones')).not.toContain('rule.move')
  expect(ruleKeys(on, 'minimal')).toContain('rule.nowOnly')
  expect(ruleKeys(on, 'minimal')).not.toContain('rule.plan')
})

test('a change hands the agent one note; turning reporting on hands the rule instead', () => {
  expect(changeNote('reporting', false)).toBe('toggle.note.reportingOff')
  expect(changeNote('reporting', true)).toBeUndefined()
  expect(changeNote('pipelines', false)).toBe('toggle.note.pipelinesOff')
  expect(changeNote('tasks', true)).toBe('toggle.note.tasksOn')
})

test('the agent hears the NET change since it was last told, however many presses lay between', () => {
  const on = { reporting: true, tasks: true, agents: true, pipelines: true }
  // Toggled back and forth: nothing changed, nothing to say.
  expect(netChange(on, { ...on })).toEqual({ rule: false, notes: [] })
  // off → on → off for tasks, net off: one "off" line.
  expect(netChange(on, { ...on, tasks: false })).toEqual({ rule: false, notes: ['toggle.note.tasksOff'] })
  // Two switches really changed: a line each.
  expect(netChange(on, { ...on, agents: false, pipelines: false })).toEqual({
    rule: false,
    notes: ['toggle.note.agentsOff', 'toggle.note.pipelinesOff'],
  })
  // Reporting off (whatever else moved): one line — the rest no longer matters.
  expect(netChange(on, { ...on, reporting: false, tasks: false })).toEqual({
    rule: false,
    notes: ['toggle.note.reportingOff'],
  })
  // Reporting back on: the rule, once — it already says what else is on.
  const off = { ...on, reporting: false }
  expect(netChange(off, { ...on, tasks: false })).toEqual({ rule: true, notes: [] })
  // Off, and still off: nothing.
  expect(netChange(off, { ...off, tasks: false })).toEqual({ rule: false, notes: [] })
})
