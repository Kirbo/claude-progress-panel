import { expect, test } from 'claude-code/testing'

import { INPUT_SCHEMA, schemaProblems } from './schema'

test('schemaProblems: types, enums, required and unknown properties, each named by its path', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string' },
      kind: { type: 'string', enum: ['a', 'b'] },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      on: { type: 'boolean' },
      list: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', required: ['text'] }] } },
    },
  }
  expect(
    schemaProblems(schema, { name: 'x', kind: 'a', count: 2, ratio: 0.5, on: true, list: ['a'] }),
  ).toEqual([])
  expect(schemaProblems(schema, { name: 'x', list: [{ text: 't' }] })).toEqual([])
  expect(
    schemaProblems(schema, { kind: 'c', count: 1.5, ratio: 'x', on: 1, list: [7, {}], extra: 1 }),
  ).toEqual([
    'input: missing name',
    'input.kind: "c" is not one of a, b',
    'input.count: not an integer',
    'input.ratio: not a number',
    'input.on: not a boolean',
    'input.list[0]: matches none of the allowed shapes',
    'input.list[1]: matches none of the allowed shapes',
    'input.extra: not a known property',
  ])
  expect(schemaProblems(schema, [])).toEqual(['input: not an object'])
})

test('the tool takes every forge the plugin reads, a host, and a run or pipeline by id or commit', () => {
  for (const watch of [
    { project: 'group/name', pipeline: 7 },
    { project: 'group/name', sha: 'a'.repeat(40), label: 'app main' },
    { provider: 'gitlab', project: 'group/name', pipeline: 7, host: 'git.example.com' },
    { provider: 'github', project: 'owner/repo', run: 9 },
    { provider: 'gitea', project: 'owner/repo', run: 3, host: 'codeberg.org' },
    { provider: 'command', project: 'jenkins/nightly', pipeline: 12 },
  ])
    expect([watch, schemaProblems(INPUT_SCHEMA, { watch: [watch] })]).toEqual([watch, []])
  expect(
    schemaProblems(INPUT_SCHEMA, { watch: [{ provider: 'bitbucket', project: 'o/r', run: 1 }] }),
  ).toEqual(['input.watch[0].provider: "bitbucket" is not one of gitlab, github, gitea, command'])
  expect(schemaProblems(INPUT_SCHEMA, { watch: [{ pipeline: 1 }] })).toEqual([
    'input.watch[0]: missing project',
  ])
})
