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
| `tasks`    | upserts `{ id?, title?, status?, note? }` — by `id`, or by exact `title`   |
| `remove`   | task ids to delete (mistakes, not finished work — finish with `done`)      |
| `tasks[].steps`  | subtasks `{ title, status? }`, the whole list each time (`[]` clears); the pane shows n/m |
| `tasks[].repo`   | the repo it belongs to, when the session works in several; the pane groups by it (`""` clears) |
| `tasks[].detail` | a longer description, shown when the person unfolds the task (`""` clears)          |
| `order`    | task ids (or exact titles) in the order you will do them; the rest follow  |
| `watch`    | CI to follow live — GitLab: `{ project: "group/name", pipeline: <id> }` or `{ project, sha }`; GitHub Actions: `{ provider: "github", project: "owner/repo", run: <id> }` or `{ provider: "github", project, sha }`; optional `label` |
| `unwatch`  | pipeline keys (`group/name#<id>`, `group/name@<sha>`, `gh:owner/repo#<id>`, `gh:owner/repo@<sha>`) to stop showing |

- `status`: `todo` (○), `doing` (●), `blocked` (⚠, magenta like Needs you — say why in `note`), `done` (✓), `skipped` (–).
- New tasks need a `title`; the tool assigns ids (`t1`, `t2`, …) and answers with the full list —
  use the ids afterwards.
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
pushed) — the plugin finds the pipeline / run once the forge creates it. A push that starts several
GitHub workflows: watch by sha shows the newest run; add the others by `run` id if they matter.

The plugin then refreshes it through the user's `glab` (GitLab), `gh` (GitHub), `tea`
(Gitea/Forgejo) or their custom command every 15 s until it finishes — do not poll it yourself just to update the pane. You still read the result yourself
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
- **Asks:** put a blocker in `needsYou` the moment you need the user, and clear it (`[]` or the
  remaining list) as soon as it is answered. Keep it honest — every session shows it.
- **Keep `now` true:** what is actually running right now.
- **Don't delete history:** finished tasks stay `done`; the user clears them (✕ / Clear all) or
  the plugin's auto-clear setting does.
- **Resume:** a resumed session keeps its entry while its session id is unchanged (a `/clear`
  starts a new entry); the tool's answer lists your tasks and ids.

## Removed in the pane

The person can remove a task, a task's step, one of a subagent's steps, or a whole subagent's work
with ✕. You are told once ("… was removed in the Progress pane — do not do it; stop if you are on
it"; a subagent is told about its own). Do not do it, and do not send it again: a removed item stays
skipped whatever a later report says — only a new title or id is a new task. A cancelled subagent
reports what it has and ends.

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

- `/progress` opens it (a session opens it by itself only on a terminal ~144 columns wide).
- No `progress_update` tool and no `/progress` → the plugin is not installed on this machine: see
  the repository's `CLAUDE.md` ("Set the panel up on a machine").
- A pipeline that shows an error, a rule that never arrived, a push that was not watched →
  `/progress doctor` names the cause and its fix (forge CLI missing / not logged in / unable to read
  this project, SSH host key, folder not writable).
