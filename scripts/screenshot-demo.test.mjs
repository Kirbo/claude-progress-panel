// The demo data behind the README's picture must stay data the pane can read, and must show what
// the picture is there to show: a subagent at work and one that finished (Done → Agents), and a
// commit whose push started several runs.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

import { demoFiles } from './screenshot-demo.mjs'

// The plugin's modules import each other without an extension (the engine resolves them).
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier))
      return next(`${specifier}.ts`, context)
    return next(specifier, context)
  },
})
const { parseSessionFile } = await import('../hooks/model.ts')

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)

test('every demo file reads back as the session file it was written as', () => {
  for (const file of demoFiles(NOW)) {
    const read = parseSessionFile(JSON.stringify(file))
    assert.deepEqual(read, file, file.session.id)
  }
})

test('the demo shows a finished subagent beside a running one', () => {
  const agents = demoFiles(NOW).flatMap(file => file.agents ?? [])
  assert.ok(agents.some(a => a.endedAt === null))
  const finished = agents.find(a => a.endedAt !== null)
  assert.ok(finished, 'a finished agent')
  assert.ok(finished.tasks.length > 0 && finished.tasks.every(t => t.status === 'done'))
})

test('the demo shows a commit row that stands for several runs', () => {
  const rows = demoFiles(NOW).flatMap(file => file.pipelines)
  const several = rows.find(p => (p.runs?.length ?? 0) > 1)
  assert.ok(several, 'a watch by commit with several runs')
  assert.match(several.key, /@[0-9a-f]{40}:/)
  assert.ok(several.watchRef)
})
