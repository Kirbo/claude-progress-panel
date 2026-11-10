import { expect, test } from 'claude-code/testing'

import { fields, text } from './events'

test('fields: an event read as a record of unknowns — anything else reads as empty', () => {
  expect(fields({ agent_id: 'a1', n: 2 }).agent_id).toBe('a1')
  for (const e of [undefined, null, 'x', 7, true, ['a']]) expect(fields(e)).toEqual({})
  // A nested part is read the same way, so a missing or odd one never throws.
  expect(fields(fields({ tool_response: null }).tool_response).backgroundTaskId).toBeUndefined()
  expect(fields(fields({ tool_response: { backgroundTaskId: 'b1' } }).tool_response).backgroundTaskId).toBe(
    'b1',
  )
})

test('text: a field that is a non-empty string, else undefined', () => {
  expect(text({ agent_id: 'a1' }, 'agent_id')).toBe('a1')
  for (const e of [{ agent_id: '' }, { agent_id: 7 }, { agent_id: null }, {}, undefined, 'agent_id'])
    expect(text(e, 'agent_id')).toBeUndefined()
})
