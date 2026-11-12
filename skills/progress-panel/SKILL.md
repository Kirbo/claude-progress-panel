---
name: progress-panel
description: Keep the Progress pane current — the pane beside every Claude Code session on this machine that shows each session's "now", what needs the user, and its tasks. Use the progress_update tool from the FIRST step of any multi-step task (now + the task list), on every status change, for every decision only the user can make, in unattended runs and handovers, and when the user asks for the panel / progress pane / status panel.
---

# Keeping the Progress pane current

The `progress-panel` plugin shows one pane in EVERY Claude Code session on this machine. Each
session owns one entry in a shared folder; every pane shows all of them, grouped by session:

1. `updated HH:MM · project · checked HH:MM:SS` — the newest update anywhere, and when this pane
   last refreshed (yellow "(stale)" if it stopped).
2. `⚠ Needs you` — every live session's asks, highlighted, also in the status line and toasted to
   the other sessions.
3. `Now` — one line per live session.
4. `Sessions` — one foldable group per session (this one first): open tasks, then a foldable
   Done section with done times, "Clear all" and a ✕ per item.

## How to write: the `progress_update` tool

Call `mcp__progress-panel__progress_update` (its schema is in your tool list). It is a **patch** —
send only what changed:

| Field      | Effect                                                                     |
| ---------- | -------------------------------------------------------------------------- |
| `now`      | replaces your one-line summary: what you are doing, what comes next        |
| `needsYou` | replaces your asks — only what the USER must do/decide; `[]` once answered |
| `tasks`    | upserts `{ id?, title?, status?, note? }` — by `id`, or by the exact `title` of an open task |
| `remove`   | task ids to delete (mistakes, not finished work — finish with `done`)      |
| `tasks[].steps`  | subtasks `{ title, status? }`, the whole list each time (`[]` clears); the pane shows n/m |
| `tasks[].repo`   | the repo it belongs to, when the session works in several; the pane groups by it — the agents linked to its tasks too (`""` clears) |
| `tasks[].detail` | a longer description, shown when the person unfolds the task (`""` clears)          |
| `order`    | task ids (or exact titles) in the order you will do them; the rest follow  |
| `watch`    | CI to follow live — GitLab: `{ project: "group/name", pipeline: <id> }` or `{ project, sha }`; GitHub Actions: `{ provider: "github", project: "owner/repo", run: <id> }` or `{ provider: "github", project, sha }`; optional `label` |
| `clearAgents` | `true` removes every subagent row that is no longer working (finished or only waiting) — when the person asks to clear the pane; `dismissAgents: [description|id]` names specific ones; a running one is never removed |
| `unwatch`  | pipeline keys (`group/name#<id>`, `group/name@<sha>`, `gh:owner/repo#<id>`, `gh:owner/repo@<sha>`) to stop showing |

- `status`: `todo` (○), `doing` (●), `blocked` (⚠, magenta like Needs you), `done` (✓), `skipped` (–, dim:
  it will not be done), `failed` (✗, red: tried and could not be done). For blocked / skipped / failed,
  say WHY in `note` — the pane shows it beneath the row. Steps take a `note` the same way. A subagent
  that stops for good leaves its open steps `unfinished` (–, "agent stopped before finishing"); the
  plugin sets that one, never send it.
- New tasks need a `title`; the tool assigns ids (`t1`, `t2`, …) and answers with the full list —
  use the ids afterwards. A title alone reaches only an OPEN task of that title: the same title
  again after it closed is a new task (a second "Verify" round), so reopen a closed task by its
  `id`. An id of your own is a plain name (letters, digits, `.`, `_`, `-`), and one the person
  removed in the pane is never reused.
- Timestamps (created, updated, done) are stamped for you. Never write the files yourself.

## Pipelines

**A `git push` you run through Bash is watched automatically** — the plugin detects the repo's CI,
forge, host and the pushed sha once the push lands, and the tool result tells you (`that push is
watched automatically`); do not `watch` it again. `watch` yourself only what that cannot see: a
pipeline or run by id, another repo's pipeline, a push made outside this session (then the rules
below apply) — never a repo the plugin told you runs no CI (it remembers those and skips their
pushes) — and a push it cannot see: through a git alias or a wrapper script (`git p`,
`./release.sh`), so `watch` those by sha yourself. CI = a `.gitlab-ci.yml` (GitLab), any `.github/workflows/*.yml` (GitHub
Actions: `provider: "github"`, `project: "owner/repo"`), any `.gitea/workflows/` or
`.forgejo/workflows/` (`provider: "gitea"`, `project: "owner/repo"`), or another CI the user set
up a **Custom CI command** for (`provider: "command"`, `project` = the name that command knows).
**Host:** a watch of the session's own repo takes its `origin` remote's host by itself; for any
other repo on a self-hosted forge (GitLab, GitHub Enterprise, Gitea/Forgejo) add `host`
(`"git.example.com"`). Gitea/Forgejo always need one (given, or the own repo's). Watch in the same call that sets
`now`: by id when you know it, else by the pushed commit's `sha` (`git rev-parse HEAD` of what you
pushed) — a `sha` is 7 to 64 hex digits; the plugin finds the pipeline / run once the forge creates it. A
watch by sha follows EVERY pipeline / workflow run of that commit as one row: unfinished while any
of them is, green only when all are — never add the others by id. The same commit on several
branches or tags: add `ref` (`"main"`) to follow that ref's pipelines only (a push's own watch
already does).

The plugin then refreshes it through the user's `glab` (GitLab), `gh` (GitHub), `tea`
(Gitea/Forgejo) or their custom command until it finishes — do not poll it yourself just to update the pane. A watch the plugin gives up on (the CLI keeps failing, no pipeline ever came, still unfinished after a day) says "stopped watching — <why>" and you are told once: a task waiting on it no longer closes by itself, so settle it yourself, or `watch` the same thing again once the cause is fixed. You still read the result yourself
(e.g. `glab api …/pipelines/<id>/jobs`, `gh run view <id>`) before reporting on it.

## The routine

- **Start of multi-step work:** your FIRST tool call is one call with `now` and the planned tasks
  (`todo`), listed in the order you will do them — on your own, never waiting to be asked. The
  pane's default sort is that plan order: when it changes, send `order`. The plugin adds this rule to every session's
  system prompt (section `progress-panel:reporting`) — or, in a session it joined mid-way, to the next
  prompt (and again after a compaction), with a short reminder until the first report; a subagent
  gets its part inside the Agent call's own prompt — so it holds without loading this skill. A
  subagent whose job is about three tool calls may skip reporting; a longer one reports from its
  first call.
- **Each change:** mark the task `doing` when you start it, `done` (with a one-line outcome in
  `note`: commit hash, pipeline id) when verified, `blocked` with the reason when stuck.
- **Never keep a task open to wait for CI:** a push links its pipeline to your `doing` task of that
  repo (or set `pipeline` yourself) and the task closes with it — done on green, failed on red. A
  `doing` task you did not touch in a turn stops that turn once with the list: update each to its
  true state. A task untouched for 20 min is asked about once.
- **Asks:** put a blocker in `needsYou` the moment you need the user, and clear it (`[]` or the
  remaining list) as soon as it is answered. Keep it honest — every session shows it. Each ask
  says WHAT is needed and HOW to give it. An answer you wait for in this session goes in `reply`,
  not in the text: `{ text: "Push progress-panel 0.23.2?", reply: "yes or no" }` — the pane words
  "— reply yes or no" itself and adds "here" only in this session's own pane while another session
  is open, so never write "here" or the session's name. When it is about a task, add
  `task: "<id>"` (or `agent` for a subagent) — that task then shows the Needs-you mark with the
  ask beneath it.
- **Keep `now` true:** what is actually running right now.
- **Don't delete history:** finished tasks stay `done`; the user clears them (✕ / Clear all) or
  the plugin's auto-clear setting does.
- **Resume:** a resumed session keeps its entry while its session id is unchanged (a `/clear`
  starts a new entry); the tool's answer lists your tasks and ids.

## Delegating to a subagent

When a subagent takes over a task, set that task's `agent` to the Agent call's description (the
plugin links it on its own when the description names exactly one task you have `doing`). The
pane shows the agent's own steps under the task — never copy or mirror them into the task (steps
sent to a linked task are dropped); send it only its status and note. Work you send a running agent
later needs no copy either: its new steps show there as it adds them. An agent that works on no
task of yours is shown as a stand-in task "↳ <agent>" while it runs, or until you link the real
one (you are told once, when you have a task it could be); the stand-in is the plugin's and goes
when the agent ends — never update or close it. When an agent linked to a task of yours finishes
you are told once ("agent … finished — verify its result and update task …"): check its result,
then mark the task done yourself — the plugin never does.

## Removed in the pane

The person can remove a task, a task's step, one of a subagent's steps, or a whole subagent's work
with ✕. You are told once ("… was removed in the Progress pane — do not do it; stop if you are on
it"; a subagent is told about its own). Do not do it, and do not send it again: a removed item stays
skipped whatever a later report says — only a new title or id is a new task. A cancelled subagent
reports what it has and ends. Across a link: a removed task's agent is stopped too (you are told);
an agent the person stopped leaves its task unassigned — re-plan or skip it yourself; a removed
step of an agent never changes your task's status.

## Reporting effort

The person may have set a lower reporting effort: the rule you were given says which — **milestones**
(the plan, each task done or blocked, Needs you; no step-by-step updates) or **minimal** (only
`now` and `needsYou`). Follow the rule as given; it wins over the routine below.

## Estimates

Every estimate you report — a subagent's `eta`, a step's `~N min` note — is YOUR OWN wall-clock
time as an agent: the tool calls, builds and tests still to run. Never the time the work would take
a person (an agent finishes in minutes what a person plans in hours). Once a step has finished, the
pane shows the pace it has measured instead of your guess; until then your guess shows as "(est.)".

## When the person switched parts off

The person can switch this session's reporting, tasks, agents and pipelines off (`/progress …`,
the pane's switches). Each change reaches you once as a one-line note. While **reporting** is off,
do not call `progress_update` (it writes nothing); **tasks** off: send only `now` and `needsYou`;
**agents** off: subagents do not report; **pipelines** off: send no `watch`. A switch turned back
on hands you the rule again.

## When the pane is not visible

- `/progress` opens it (a session opens it by itself only on a terminal ~144 columns wide);
  `/progress settings` opens its Settings view (this session's switches, the defaults).
- No `progress_update` tool and no `/progress` → the plugin is not installed on this machine: see
  the repository's `CLAUDE.md` ("Set the panel up on a machine").
- A pipeline that shows an error, a rule that never arrived, a push that was not watched →
  `/progress doctor` names the cause and its fix (forge CLI missing / not logged in / unable to read
  this project, SSH host key, folder not writable).
