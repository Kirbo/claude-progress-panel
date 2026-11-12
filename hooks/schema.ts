import { STATUSES } from './model'
import { PROVIDERS } from './pipelines'

export const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    now: { type: 'string', description: 'One line: what you are doing now and what comes next.' },
    needsYou: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'string' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', description: 'What is needed, and how to give it.' },
              reply: {
                type: 'string',
                description:
                  'The answer you wait for, when it is a reply in this session ("yes or no"): the pane adds "— reply yes or no" after the text itself, with "here" only where that is true. Leave it out of the text.',
              },
              task: { type: 'string', description: 'The id of the task it is about.' },
              agent: { type: 'string', description: 'The subagent it is about (its description or id).' },
            },
            required: ['text'],
          },
        ],
      },
      description:
        'Everything only the user can do or decide right now; [] clears it. Each item says WHAT is needed and HOW to give it; an answer you wait for in this session goes in `reply` ({ text: "Push progress-panel 0.23.2?", reply: "yes or no" }) — never write "here" or the session\'s name. Add `task` (or `agent`) when it is about a task or a subagent — that one then shows the Needs-you mark with the ask beneath it.',
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description:
              'The task to update (the tool assigns t1, t2, … and its answer names them). Leave it out for a new task.',
          },
          title: {
            type: 'string',
            description:
              'Needed for a new task. Without an id it names the open task of that exact title; a closed one is reopened by its id.',
          },
          status: { type: 'string', enum: [...STATUSES] },
          note: {
            type: 'string',
            description:
              'One line, shown beneath the task: the outcome once done — and WHY when it is blocked, skipped (will not be done) or failed (tried and could not be done).',
          },
          repo: {
            type: 'string',
            description:
              'The repo this task belongs to (its name), when the session works in more than one; the pane groups tasks by it. "" clears.',
          },
          agent: {
            type: 'string',
            description:
              "The subagent working on this task: its Agent call's description (or id). The pane shows that agent's own steps under the task — never copy them into the task (`steps` sent to a linked task are dropped); send it only its status and note. You still mark it done yourself once you verified the agent's result. \"\" clears.",
          },
          detail: {
            type: 'string',
            description: 'A longer description, shown when the person unfolds the task; "" clears it.',
          },
          pipeline: {
            type: 'string',
            description:
              'The pipeline this task waits on (a watch key, e.g. "group/name@<sha>"): the task then closes by itself — done when it goes green, failed when red. A push you run links its pipeline to your one `doing` task of that repo automatically. "" clears.',
          },
          steps: {
            type: 'array',
            description:
              'Subtasks, replacing the whole list (send it all each time; [] clears). The task shows how many are done (n/m).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                status: { type: 'string', enum: [...STATUSES] },
                note: {
                  type: 'string',
                  description: 'Why, shown beneath the step: blocked, skipped or failed.',
                },
              },
              required: ['title'],
            },
          },
        },
      },
    },
    remove: { type: 'array', items: { type: 'string' } },
    eta: {
      type: 'number',
      description:
        'A subagent only: the minutes you expect the rest of your job to take, re-estimated each call.',
    },
    order: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Task ids (or exact titles) in the order you will do them; the pane lists them so. The rest keep their order after them.',
    },
    watch: {
      type: 'array',
      description:
        'CI pipelines to follow live in the pane: GitLab CI pipelines (the default), GitHub Actions or Gitea / Forgejo Actions workflow runs (provider "github" / "gitea"), or a run of the CI the user set a custom command for (provider "command"). A git push run through Bash is watched automatically; watch a run by id, another repo\'s pipeline or a push made elsewhere.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['project'],
        properties: {
          provider: {
            type: 'string',
            enum: [...PROVIDERS],
            description:
              'gitlab (default), github (GitHub Actions), gitea (Gitea / Forgejo Actions) or command (the custom CI command from the plugin settings)',
          },
          project: {
            type: 'string',
            description:
              'GitLab group/name (full path), GitHub or Gitea owner/repo, or the name the custom command knows',
          },
          pipeline: { type: 'integer', description: 'GitLab pipeline id (GitHub / Gitea: same as run)' },
          run: { type: 'integer', description: 'GitHub / Gitea Actions workflow run id' },
          sha: {
            type: 'string',
            description: 'commit sha (7 to 64 hex digits), when the id is not known yet',
          },
          ref: {
            type: 'string',
            description:
              'with sha: the branch or tag whose pipelines to follow, when the same commit is on several (a fast-forwarded branch, a tag); without it every pipeline of the commit counts',
          },
          host: {
            type: 'string',
            description:
              'the forge host ("git.example.com") for a repo on a self-hosted forge that is not this session\'s own; Gitea / Forgejo always need one',
          },
          label: { type: 'string', description: 'short name shown in the pane' },
        },
      },
    },
    unwatch: { type: 'array', items: { type: 'string' }, description: 'pipeline keys to stop showing' },
    clearAgents: {
      type: 'boolean',
      description:
        "true: remove every subagent row that is no longer working (finished, or only waiting) from this session's entry — as the pane's ✕ does. Use it when the person asks to clear the pane. A running agent is never removed.",
    },
    dismissAgents: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Subagent rows to remove, by the Agent call's description or id — only ones no longer working; a running one is kept and named in the answer.",
    },
  },
}

type Schema = {
  type?: string
  enum?: readonly unknown[]
  properties?: Record<string, Schema>
  additionalProperties?: boolean
  required?: readonly string[]
  items?: Schema
  anyOf?: readonly Schema[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * What is wrong with `value` under a JSON schema, each problem named by its path ([] = valid). Only
 * the keywords the tool's own schema uses: type, enum, properties, additionalProperties, required,
 * items, anyOf. The harness checks a real call the same way before the plugin sees it; this is how
 * the tests and the documented examples are held to the schema.
 */
export function schemaProblems(schema: unknown, value: unknown, path = 'input'): string[] {
  const s = schema as Schema
  if (s.anyOf) {
    return s.anyOf.some(option => schemaProblems(option, value, path).length === 0)
      ? []
      : [`${path}: matches none of the allowed shapes`]
  }
  if (s.type === 'string' && typeof value !== 'string') return [`${path}: not a string`]
  if (s.type === 'boolean' && typeof value !== 'boolean') return [`${path}: not a boolean`]
  if (s.type === 'number' && typeof value !== 'number') return [`${path}: not a number`]
  if (s.type === 'integer' && !Number.isInteger(value)) return [`${path}: not an integer`]
  if (s.enum && !s.enum.includes(value))
    return [`${path}: ${JSON.stringify(value)} is not one of ${s.enum.join(', ')}`]
  if (s.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: not an array`]
    const items = s.items
    return items ? value.flatMap((item, i) => schemaProblems(items, item, `${path}[${i}]`)) : []
  }
  if (s.type !== 'object') return []
  if (!isObject(value)) return [`${path}: not an object`]
  const problems = (s.required ?? []).filter(name => !(name in value)).map(name => `${path}: missing ${name}`)
  for (const [name, item] of Object.entries(value)) {
    const known = s.properties?.[name]
    if (known) problems.push(...schemaProblems(known, item, `${path}.${name}`))
    else if (s.additionalProperties === false) problems.push(`${path}.${name}: not a known property`)
  }
  return problems
}
