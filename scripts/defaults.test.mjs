// A setting's default lives twice by necessity: in the manifest (what Claude Code shows and stores)
// and in the code's fallback (what runs when the option is unset). They must never drift.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { NUMBER_DEFAULTS, readSettings } from '../hooks/settings.ts'
import { defaultsFrom } from '../hooks/toggles.ts'

const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
const declared = Object.fromEntries(
  Object.entries(manifest.userConfig).map(([name, spec]) => [name, spec.default]),
)

test("the code's fallback for every setting is the manifest's default", () => {
  assert.deepEqual(readSettings({}), readSettings(declared))
  assert.deepEqual(defaultsFrom({}), defaultsFrom(declared))
  for (const [name, fallback] of Object.entries(NUMBER_DEFAULTS))
    assert.equal(String(fallback), declared[name], `${name}: code ${fallback}, manifest ${declared[name]}`)
})

test("every default the manifest declares is one of the setting's own options", () => {
  for (const [name, spec] of Object.entries(manifest.userConfig))
    if (spec.options) assert.ok(spec.options.includes(spec.default), `${name}: ${spec.default}`)
})
