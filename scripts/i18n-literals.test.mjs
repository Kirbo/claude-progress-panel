// Every text the plugin words itself — in the pane, in a command's answer, in what the tool answers
// an agent, on a pipeline's row — is a key in locales/en.ts, read through `t()`. A literal in the
// code is a text no other language can ever carry, and i18n fails silently: nothing else notices.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const HOOKS = new URL('../hooks/', import.meta.url)

// Not wording: the tool's input schema (its field documentation, read by the model as the API it
// is), and the catalog's own reader.
const SKIPPED = new Set(['schema.ts', 'i18n.ts'])

// A literal that reads as a sentence but is not one: a shell command handed to the person to run.
const COMMAND = /^(gh|glab|tea|git) [a-z -]+--[a-z]+/

/** The code of a source file without its comments (line numbers kept). */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, (_whole, before) => before)
}

/** The string and template literals of `code`, each with its line. */
function literals(code) {
  const found = []
  const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
  for (const m of code.matchAll(literal))
    found.push({ text: m[0].slice(1, -1), line: code.slice(0, m.index).split('\n').length })
  return found
}

function sources() {
  return readdirSync(HOOKS)
    .filter(name => /\.tsx?$/.test(name) && !/\.test\./.test(name) && !SKIPPED.has(name))
    .map(name => ({ name, code: withoutComments(readFileSync(new URL(name, HOOKS), 'utf8')) }))
}

test('no sentence is worded in the code: every text comes from the catalog', () => {
  const worded = []
  for (const { name, code } of sources())
    for (const { text, line } of literals(code)) {
      const plain = text.replace(/\$\{[^}]*\}/g, 'X')
      if (plain.includes('\n') || COMMAND.test(plain)) continue
      if (/[A-Za-z]{2,} [a-z]{2,} [a-z]{2,}/.test(plain)) worded.push(`${name}:${line}: ${text.slice(0, 80)}`)
    }
  assert.deepEqual(worded, [])
})

test('a problem the tool reports back is never a literal', () => {
  const worded = []
  for (const { name, code } of sources()) {
    // `errors.push('…')`, `error: '…'`, `?? '…'` / `|| '…'` after an error — the short ones the
    // sentence check cannot see ("order: no task x", "git exited 1").
    const literal =
      /(errors\.push\(\s*|\berror:\s*|\berror\s*(?:\?\?|\|\|)\s*|stderr\)\s*\|\|\s*)(['"`])(?!\2)/g
    for (const m of code.matchAll(literal))
      worded.push(`${name}:${code.slice(0, m.index).split('\n').length}: ${m[0].trim()}`)
  }
  assert.deepEqual(worded, [])
})
