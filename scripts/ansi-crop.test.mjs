import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crop, cropLine, dominantBackground, xterm256 } from './ansi-crop.mjs'

test('cropLine keeps the columns asked for and every colour code, drops hyperlinks', () => {
  const line = 'ab\x1b[32mcd\x1b[0mef\x1b]8;id=1;https://x\x1b\\↗\x1b]8;;\x1b\\g'
  assert.equal(cropLine(line, 2, 4), '\x1b[32mcd\x1b[0mef\x1b[0m')
  assert.equal(cropLine(line, 6, 2), '\x1b[32m\x1b[0m↗g\x1b[0m')
})

test('crop takes the row range', () => {
  assert.equal(crop('1\n2\n3\n4', 0, 9, 1, 3), '2\x1b[0m\n3\x1b[0m')
})

test('xterm256 maps the 256-colour palette to hex', () => {
  assert.equal(xterm256(235), '#262626')
  assert.equal(xterm256(16), '#000000')
  assert.equal(xterm256(231), '#ffffff')
  assert.equal(xterm256(1), '#800000')
})

test("dominantBackground is the capture's most used background colour (256-colour or truecolour)", () => {
  const e = String.fromCharCode(27)
  assert.equal(dominantBackground(`${e}[48;5;235ma${e}[48;5;235mb${e}[48;5;16mc`), '#262626')
  assert.equal(dominantBackground(`${e}[48;2;1;2;3mx${e}[48;2;1;2;3my`), '#010203')
  assert.equal(dominantBackground('plain text'), undefined)
})
