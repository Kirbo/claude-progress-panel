import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crop, cropLine } from './ansi-crop.mjs'

test('cropLine keeps the columns asked for and every colour code, drops hyperlinks', () => {
  const line = 'ab\x1b[32mcd\x1b[0mef\x1b]8;id=1;https://x\x1b\\↗\x1b]8;;\x1b\\g'
  assert.equal(cropLine(line, 2, 4), '\x1b[32mcd\x1b[0mef\x1b[0m')
  assert.equal(cropLine(line, 6, 2), '\x1b[32m\x1b[0m↗g\x1b[0m')
})

test('crop takes the row range', () => {
  assert.equal(crop('1\n2\n3\n4', 0, 9, 1, 3), '2\x1b[0m\n3\x1b[0m')
})
