import { STATUSES } from './model'

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
          id: { type: 'string' },
          title: { type: 'string' },
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
        'CI pipelines to follow live in the pane: GitLab CI pipelines (the default) or GitHub Actions workflow runs (provider "github"). A git push run through Bash is watched automatically; watch a run by id, another repo\'s pipeline or a push made elsewhere.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['project'],
        properties: {
          provider: {
            type: 'string',
            enum: ['gitlab', 'github'],
            description: 'gitlab (default) or github (GitHub Actions)',
          },
          project: { type: 'string', description: 'GitLab group/name (full path) or GitHub owner/repo' },
          pipeline: { type: 'integer', description: 'GitLab pipeline id (GitHub: same as run)' },
          run: { type: 'integer', description: 'GitHub Actions workflow run id' },
          sha: { type: 'string', description: 'commit sha, when the id is not known yet' },
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
