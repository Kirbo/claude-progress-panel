// The README tells people what the plugin costs their agents before they install it. Those numbers
// are measured here from the code, so a longer rule or schema cannot quietly make them untrue.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// The plugin's modules import each other without an extension (the engine resolves them).
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier))
      return next(`${specifier}.ts`, context)
    return next(specifier, context)
  },
})
const { INPUT_SCHEMA } = await import('../hooks/schema.ts')
const { en } = await import('../locales/en.ts')
const { defaultsFrom, ruleKeys } = await import('../hooks/toggles.ts')

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\n> /g, ' ')

/** Characters as tokens, the way `/progress doctor` estimates them. */
const tokens = chars => Math.round(chars / 4)
const rule = effort =>
  tokens(
    ruleKeys(defaultsFrom({}), effort)
      .map(key => en[key])
      .join('\n').length,
  )

/** The number the README states after `before` ("~1,800"), as a number. */
function stated(before) {
  const found = new RegExp(`${before}\\D{0,12}?~?([\\d,]+)`).exec(readme)
  assert.ok(found, `the README states a number after "${before}"`)
  return Number(found[1].replaceAll(',', ''))
}

/** Within a fifth: the README rounds, the code moves a little with every wording change. */
function close(actual, said, what) {
  assert.ok(
    Math.abs(actual - said) <= said * 0.2,
    `${what}: the code measures ${actual}, the README says ${said}`,
  )
}

test('the README states what the tool, the rule and both together cost, as the code measures them', () => {
  const tool = tokens(en['tool.description'].length + JSON.stringify(INPUT_SCHEMA).length)
  close(tool, stated('tool and its schema'), 'the tool and its schema')
  close(rule('detailed'), stated('rule in the system prompt'), 'the rule')
  close(tool + rule('detailed'), stated('costs the agent tokens — about'), 'both')
  close(rule('minimal'), stated('`minimal`: a rule of'), 'the minimal rule')
})
