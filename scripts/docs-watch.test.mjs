// The `watch` examples the README and the skill show an agent must be input the tool accepts: the
// docs once told agents to send `provider: "gitea"` and `host` while the schema refused both.
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
const { INPUT_SCHEMA, schemaProblems } = await import('../hooks/schema.ts')

const doc = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

// What a shorthand property or a `<placeholder>` stands for in an example.
const SAMPLE = {
  project: 'group/name',
  pipeline: 7,
  run: 7,
  sha: 'a'.repeat(40),
  host: 'git.example.com',
  label: 'app main',
}

/** Every `{ … project … }` object a text shows, as the objects it stands for (`a | b` = one each). */
export function watchExamples(text) {
  const found = []
  for (const [, body] of text.matchAll(/\{([^{}`]*\bproject\b[^{}`]*)\}/g)) {
    // `{project}` alone is the custom command's placeholder, not a watch.
    if (!/[:,|]/.test(body)) continue
    let variants = [{}]
    for (const part of body.replaceAll('\\|', '|').split(',')) {
      const colon = part.indexOf(':')
      if (colon < 0) {
        const names = part.split('|').map(n => n.trim())
        variants = variants.flatMap(v => names.map(n => ({ ...v, [n]: SAMPLE[n] })))
        continue
      }
      const key = part.slice(0, colon).trim()
      const raw = part.slice(colon + 1).trim()
      const value = /^<.*>$/.test(raw) || /^"<.*>"$/.test(raw) ? SAMPLE[key] : JSON.parse(raw)
      variants = variants.map(v => ({ ...v, [key]: value }))
    }
    found.push(...variants.map(example => ({ source: `{${body}}`, example })))
  }
  return found
}

/** Every `key: "value"` a text shows in code, as one-property watches. */
function watchProperties(text) {
  return [...text.matchAll(/`(\w+): ("[^"`]*")`/g)].map(([source, key, value]) => ({
    source,
    example: { project: SAMPLE.project, [key]: JSON.parse(value) },
  }))
}

function assertAccepted(found) {
  for (const { source, example } of found)
    assert.deepEqual(
      schemaProblems(INPUT_SCHEMA, { watch: [example] }),
      [],
      `${source} → ${JSON.stringify(example)}`,
    )
}

test('watchExamples reads the shorthand the docs use', () => {
  assert.deepEqual(
    watchExamples('| `{ provider: "gitea", project: "owner/repo", run \\| sha }` | `{project}` |').map(
      f => f.example,
    ),
    [
      { provider: 'gitea', project: 'owner/repo', run: 7 },
      { provider: 'gitea', project: 'owner/repo', sha: SAMPLE.sha },
    ],
  )
  assert.deepEqual(
    watchExamples('GitLab ({ project: "group/name", pipeline: <id> } or { project, sha })').map(
      f => f.example,
    ),
    [
      { project: 'group/name', pipeline: 7 },
      { project: 'group/name', sha: SAMPLE.sha },
    ],
  )
})

test('every watch the README shows is input the tool accepts', () => {
  const found = watchExamples(doc('README.md'))
  // One row per forge, each by id and by sha.
  assert.ok(found.length >= 8, `only ${found.length} examples found`)
  for (const provider of ['github', 'gitea', 'command'])
    assert.ok(
      found.some(f => f.example.provider === provider),
      `no ${provider} example`,
    )
  assertAccepted(found)
})

test('every watch property the skill names is one the tool accepts', () => {
  const text = doc('skills/progress-panel/SKILL.md')
  const section = text.slice(text.indexOf('## Pipelines'), text.indexOf('## The routine'))
  const found = [...watchExamples(section), ...watchProperties(section)]
  for (const provider of ['github', 'gitea', 'command'])
    assert.ok(
      found.some(f => f.example.provider === provider),
      `no ${provider} mention`,
    )
  assertAccepted(found)
  // The words it tells an agent to add to a watch.
  const watch = INPUT_SCHEMA.properties.watch.items.properties
  for (const name of ['host', 'sha', 'run', 'provider', 'project'])
    if (section.includes(`\`${name}\``))
      assert.ok(name in watch, `the skill names \`${name}\`, the schema has none`)
  assert.ok(section.includes('`host`'))
})

test("the tool's own description shows only watches it accepts", async () => {
  const { en } = await import('../locales/en.ts')
  const found = watchExamples(en['tool.description'])
  assert.ok(found.length >= 4, `only ${found.length} examples found`)
  assertAccepted(found)
})

test('no text an agent or a person reads names the refresh interval as a fixed number', async () => {
  const { en } = await import('../locales/en.ts')
  // The interval is a setting (pipelineRefreshSec): the words follow it, or name no number.
  for (const key of ['tool.description', 'rule.pipelines'])
    if (key in en) assert.doesNotMatch(en[key], /every \d+ ?s\b/, key)
  for (const [key, text] of Object.entries(en))
    if (key.startsWith('rule.') || key.startsWith('prompt.')) assert.doesNotMatch(text, /every \d+ ?s\b/, key)
  assert.match(en['tool.watching'], /every \{seconds\} s/)
  assert.doesNotMatch(doc('skills/progress-panel/SKILL.md'), /every \d+ ?s\b/)
})
