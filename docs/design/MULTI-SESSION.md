# Multi-session progress panel (v0.2)

> **Status:** shipped in 0.2.0 · 2026-11-06 · single-writer sidecar + mid-write tolerance in 0.3.1 · pipelines in 0.4.0 · GitHub Actions in 0.10.0 · GitLab links in 0.9.0 · orphaned pipelines polled by any pane in 0.11.1 · pipeline finish time in 0.12.0 · reporting rule in every system prompt in 0.13.0 · own-file writes serialized in 0.13.1 · forges/hosts/any CI, session names, plan order, task details, repo groups, filter, quiet transcript rows, Releases in 0.14.0 · version + update notice in 0.15.0 · task removal, per-list repo groups in 0.16.0 · subagent progress (Agents) in 0.17.0 · pane size settings in 0.18.0 · silent subagents listed in 0.18.1 · agent steps + finished agents under Done in 0.19.0
> **Asked for (2026-11-06):** every Claude Code session on one machine writes to the same store and
> every pane shows the same status, grouped by session; collapsible groups, a Done section with
> timestamps, "Clear all" and per-item ✕, sortable tasks, the plugin's own settings.

## Layout (top to bottom)

```
updated 22:05 · switchboard · checked 22:08:14   ← newest update across sessions · last refresh
⚠ Needs you (2)                                   ← bold magenta, only when non-empty
  • switchboard: push OK for next
  • panel: pick a name
Now                                                ← one line per live session, newest first
  switchboard · Waiting for pipeline 3037602037
  panel · Writing the design doc
Sessions                              [Sort: status]
▾ switchboard (this session) · 22:05 · 2 open · 5 done
    ⚠ macOS build — runner restarted
    ● Screenshot refresh — capture running
    ▸ Done (5)                          ← [Clear all] only while open
▸ panel · ended 21:40 · 0 open · 3 done            ← dimmed
```

- Every `▾`/`▸` line is a Button that folds its part. Defaults: live sessions open, ended
  sessions folded, every Done section folded. Fold state is per pane (`$.state`).
- Done rows read `✓ title  YYYY-MM-DD HH:MM  [✕]` (time the task was done, local time).
- An open Done lists its **newest 10** finished tasks, and the finished agents its newest 5; the
  rest fold behind `▸ N older` (`capNewest`, 0.20.0). A session's history grows all day — one had
  70 finished tasks and 59 finished agents by evening — and an open Done that long pushed the Now
  line and the open tasks out of a 20-row pane, which then looked frozen: the person saw only old
  finished rows and no live work.
- "Clear all" shows only while its Done section is open (0.14.0): nothing is cleared unseen.
- The pane scrolls when taller than its window (the engine's own scrolling).
- With anything in Needs you, the status line reads `⚠ N need you`; an item that appears from
  another session also raises a toast once.

## Store

One folder, default `<CLAUDE_CONFIG_DIR or ~/.claude>/progress/`, option `progressDir`. One file
per session, `<session-id>.json`, written only whole:

```json
{
  "version": 2,
  "session": { "id": "…", "project": "switchboard", "cwd": "/…", "startedAt": "ISO", "endedAt": null },
  "now": "…",
  "needsYou": ["…"],
  "updatedAt": "ISO",
  "tasks": [
    { "id": "t1", "title": "…", "status": "doing", "note": "…",
      "createdAt": "ISO", "updatedAt": "ISO", "doneAt": null }
  ],
  "dismissed": ["t7"],
  "seq": 7
}
```

- `project` = the repository's name (`$.session.repo()`), else the last segment of the cwd.
- **One writer per file.** A session's file is written only by that session (its tool calls,
  its `session.end`, its own auto-clear). Any pane may write only the **sidecar**
  `<session-id>.dismissed.json` — `{ "version": 1, "sessionId": "…", "entries": [{ "id": "t3",
  "doneAt": "ISO" }], "pipelines": [ … ] }` — on ✕ / Clear all, and with refreshed copies of the
  session's orphaned pipelines (see Pipelines); always read fresh, change, write whole, so neither
  drops the other's part. So a person's click can never
  race the session writing its status. (Exception: an *ended* session's file, whose session is
  gone, is auto-cleared and deleted by whichever pane gets there; concurrent panes write identical
  results.)
- **One write at a time within a session (0.13.1).** A session's own writes (tool calls, its
  pipeline poll, its prune, `session.start`/`session.end`) run through one lock, each re-reading
  the file inside it. Before, the poll read the file, waited seconds on the forge, and saved that
  copy — a `done` sent meanwhile was lost (seen 2026-11-07). The forge calls stay outside the lock;
  only their results are written, onto the file as it is by then.
- **Dismissals name a completion.** A sidecar entry hides a task only while it is closed with that
  same `doneAt`; re-opening and finishing it again shows it again. Panes apply the sidecar when
  drawing; the session folds it into its own `dismissed` on its next write, so a re-sent done
  copy of a dismissed task is ignored (`dismissed` is cleared again when the task is re-opened).
- **A file caught mid-write is not news.** Writes are not atomic (the plugin API has no rename),
  so a pane may read a half-written file. An unreadable file keeps its last good copy and is
  re-read on the next tick — the group never flickers out and its asks are never re-toasted.
- Forgetting an ended session deletes both its files.
- **A blank session is never stored or shown** (0.11.0, asked for 2026-11-07: sessions that never
  reported anything piled up in the pane). Blank = no task, no `now`, no ask, no pipeline. A
  session's file is created by its first `progress_update`, not at start; a session still blank
  at `session.end` deletes its file and sidecar instead of stamping `endedAt`; any pane deletes an
  ended blank file it finds (older versions wrote one at start), and the pane skips a live blank one.
- **A session that died without `session.end` is ended (0.23.0).** At start a session records its
  process and machine in its file (`session.pid`, `session.host`, from `whoAmI`: a spawned child's
  parent and `hostname` — `sh -c 'echo $PPID; ps -o comm= -p $PPID; hostname'`, PowerShell's
  `ParentProcessId` on Windows), but only when that parent is `claude`/`node`: a helper in between
  would die at once and end every idle session. Any pane on the SAME host asks, at most once a
  minute per session, whether a live session idle for `DEAD_AFTER_MS` (10 min) still has its process
  (`kill -0`, `tasklist`); gone → `endedAt` = its last `updatedAt` (its owner is gone, so the
  one-writer rule holds). A false "dead" heals itself: the owner's next write clears `endedAt`
  (`withProcess`). Can't tell → nothing changes. `/progress doctor` shows the recorded pid.

## Writing: the `progress_update` tool

The plugin registers `progress_update` (listed as `mcp__progress-panel__progress_update`, schema
in the prompt from the start). Input — every field optional, a patch, not the whole state:

| Field      | Meaning                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `now`      | replaces the "now" line                                                  |
| `needsYou` | replaces the list (`[]` clears it)                                       |
| `tasks`    | upserts by `id` (or exact `title` when no id); new tasks get `t<n>` ids  |
| `remove`   | task ids to delete                                                       |

**Reporting without being asked (0.13.0).** A tool description and an on-demand skill proved too
passive: a session ran a diagnose → fix → push job with almost nothing in its entry until the user
asked why (2026-11-07). So a `prompt.compose` hook appends one section, `progress-panel:reporting`
(scope `session`, after the cache boundary), to every system prompt the engine renders where the
tool is offered: first call on any multi-step task = `now` + the task list; statuses as they move;
every user-only decision in `needsYou`, cleared once answered; every push to a CI repo watched;
one-reply questions and subagents report nothing. Left out where the tool is not offered and in a
`teammate` render (its lead reports). The text is a fixed catalog string (`prompt.reporting`), so
it never breaks the prompt cache.

**…and in a session the plugin joined mid-way (0.21.4).** A plugin installed, reloaded
(`/reload-plugins`) or resumed into a running session is not asked to compose until that session's
prompt is rebuilt, so the section above never reached it — and the agent did not report until the
user asked why the pane was empty (2026-11-09). `UserPromptSubmit` now closes the gap through its
`additionalContext`: the same `prompt.reporting` text once, when this module composed no prompt,
then — while the session's own file is still blank — a one-line `prompt.nudge`. The first report
ends both.

**…and in every subagent (0.21.5; 0.23.0 as it starts).** A subagent's system prompt is not
composed through this hook either: a fresh general-purpose subagent had the tool but never the
rule, and never reported (2026-11-09). `classic.SubagentStart` (its `additionalContext`) hands it
`prompt.subagent` as it starts; where that event does not fire, its FIRST tool call (`PostToolUse`
with an `agent_id`) carries it instead — once per agent id either way (process-wide set), and not
at all to one whose entry already holds a `now` or tasks. The main loop's `PostToolUse` keeps only
the removal notice.

**…and in the Agent call's own prompt (0.23.0).** A note at start or after the first tool call
still came too late for a short subagent (3–4 calls batched in one turn, ~6 s: it was done before
acting on it — seen with haiku and the default model, 2026-11-09). So a `tool.call` hook on the
coordinator's `Agent` tool appends `prompt.subagent` to the call's `prompt` (`next({ ...e, prompt })`,
checked against the tool's schema) — not for a `fork` (it inherits the session's context, rule
included), not to a prompt already holding it, not while reporting or agents are off. Its
description is remembered (`promptFed`), and SubagentStart / the first-call fallback skip an agent
whose `$.agent.list()` description is one of those. The rule says a job of about three tool calls
may skip reporting; a longer one reports from its first call.

**…and after a compaction (0.23.0).** A compaction keeps the system prompt but summarises the
conversation, so a rule that only rode a prompt (the mid-way case) can be summarised away. The
session's own compaction fires `classic.SessionStart` with `source: "compact"` (no `agent_id`):
when this module composed no prompt, its `additionalContext` carries `prompt.reporting` again. A
composed session gets nothing — its section survives.

Status values: `todo`, `doing`, `blocked`, `done`, `skipped`. The plugin stamps `createdAt`,
`updatedAt` and `doneAt` (set on entering done/skipped, cleared on re-opening). The tool answers
with the session's task list (ids, statuses) so the agent can address tasks by id.

## Reading: refresh

There is no file-watch API for plugins, so each session lists the folder every **2 s**
(`$.clock.every`) and reads a file only when its mtime changed — one directory listing per tick.
A session's own write redraws at once. (Deliberate poll: push is impossible here.)
A tick folds its result into the store as it is when the tick ends (`mergeScan`), not as it was
when it began: a session's own save that landed during the scan's awaits keeps its newer copy
(it used to be overwritten by the scan's older read until the next tick), and a tick that finds
the previous scan still running skips, so slow disks never stack scans that land out of order
(0.20.0).
The header's `checked HH:MM:SS` is the end of the last successful listing; older than 10 s (five
missed ticks) it turns yellow with "(stale)" — a failed listing keeps the last known state rather
than blanking the pane. (Added in 0.3.0, asked for 2026-11-06: "updated" alone could not tell an
idle status from a pane that stopped refreshing.)

## Retention (settings)

| Option                  | Values (picker)                         | Default  |
| ----------------------- | --------------------------------------- | -------- |
| `progressDir`           | path (`~/` allowed)                      | empty    |
| `autoClearDoneHours`    | 0 (never), 1, 3, 6, 12, 24, 48, 72, 168 | 0        |
| `keepEndedSessionsDays` | 0 (never), 1, 3, 7, 14, 30              | 7        |
| `sortTasksBy`           | status, title, created, done            | status   |

- Done tasks older than `autoClearDoneHours` are removed by the owning session (or by any
  session once the owner has ended).
- A session that ended more than `keepEndedSessionsDays` ago is deleted (`rm -f` / `del`, the
  plugin API has no file delete). An ended session can also be dismissed with its ✕.
- The pane's `[Sort: …]` Button cycles the order and remembers it per user (`$.store`); the
  option is the starting value.
- Sorting: `status` = blocked, doing, todo (open) and newest done first; `title` = A→Z;
  `created` = oldest first; `done` = newest done first (open tasks by creation).

## Pipelines (0.4.0)

Asked for 2026-11-06: a live, visual status of the CI pipelines the agent waits on.

- The tool's `watch` (`{ project, pipeline }` or `{ project, sha }`, optional `label`) and
  `unwatch` (keys) maintain the session file's `pipelines` list: key (`project#id`, or
  `project@sha` until found), state, ref, url, jobs (`name`, `stage`, `state`, `durationS`),
  `addedAt`, `checkedAt`, `finishedAt`, `error`.
- **A push is watched on its own (0.22.0)** — asked 2026-11-09: "add the pipelines to the panel
  automatically, if the repo at hand has pipeline … automatically detect where the CI/CD is
  running". `classic.PostToolUse` reads every Bash call (main loop and subagents) for `git push`
  (`hooks/push.ts`, pure: shell words and operators, a leading `cd`, git's `-C`/`-c`, env
  assignments; `--dry-run`/`-n`, `--delete`/`-d`, `:ref` and `--mirror` skipped). Per push, through
  `git -C <dir>`: the toplevel; the CI off its files (`ciProvider`: `.gitlab-ci.yml`,
  `.github/workflows/*.y(a)ml`, `.gitea/` or `.forgejo/workflows/`, else the `ciCommand` setting,
  else nothing); the remote the push named (a name or URL), else the upstream's, else `origin`,
  parsed by `parseRemote`; each pushed ref's sha (`<src>^{commit}`, a bare push = HEAD and its
  branch). Landed only: an interrupted or non-zero call watches nothing, and a branch whose
  remote-tracking ref is not the pushed sha (rejected) neither. The watches go through `applyWatch`
  under the same lock as the tool's, so the agent's own `watch` of that sha is the same key, one
  row; the result's `additionalContext` tells the agent it is watched. Label `<repo> <branch>`.
  Hardened (0.23.0): `cd /d <dir>`, `pushd`, `git.exe` and drive / UNC paths (`resolvePath` keeps
  `C:` as the root, backslashes read as slashes); a push to a KNOWN public forge of another kind
  than the repo's CI (`forgeMatches`: github.com / gitlab.com / codeberg.org) watches nothing — a
  GitLab-CI repo's GitHub mirror; a self-hosted host could be any forge, so it is trusted. No
  PowerShell tool exists on this engine (Windows pushes come through Bash). A git alias or wrapper
  script is invisible to the parser: the rule's own `watch` stays the fallback.
- **A retried pipeline is followed again** (0.21.1): a failed or canceled pipeline is still
  re-checked once a minute for 2 h after it ended (`shouldPoll`), since a Retry turns it back into
  a running one; then it shows running again (its old finish times cleared) and finally its new
  outcome. A success is never re-checked. (2026-11-08: a retried pipeline stayed "failed" in the
  pane while its retry ran and passed.)
- A by-commit watch with an **abbreviated sha** (GitLab's `pipelines?sha=` and GitHub's
  `runs?head_sha=` match only the whole id) is resolved once through the forge's commit API
  (`repository/commits/<sha>`, `commits/<sha>`) and kept whole; the key stays as watched, so an
  `unwatch` by it still works. While no pipeline exists the watch waits quietly, any earlier error
  dropped; after 10 minutes it says "no pipeline for commit … — is the sha right?" (0.20.1; before,
  a short sha showed `unknown 0/0` forever, under the last error any call had hit).
- **Push is not possible** from GitLab to a local plugin: webhooks need a reachable HTTP server,
  and GitLab's own live updates (GraphQL subscriptions over ActionCable) need a browser websocket
  session; the plugin API has neither. So the **watching session** polls through the user's
  `glab api` every 15 s — only its own pipelines, only while unfinished — and stops at the first
  finished state. Other panes read the result from the file (no extra GitLab calls).
- **Orphaned pipelines (0.11.1).** A session that ends (or is killed) mid-pipeline stops polling,
  and its watch used to freeze at its last state forever (seen 2026-11-07: a 69 s pipeline shown
  "running" for 9 h). Now any pane polls another session's unfinished pipeline once its
  `checkedAt` (or `addedAt`, never checked) is older than 1 min — four of the owner's poll periods,
  so a live owner keeps sole charge. The fresh copy goes to that session's **sidecar**
  `pipelines`, never its file (one writer). Panes draw the file's list with the sidecar's copies
  laid over it — per key, the later `checkedAt` wins; copies of unwatched keys are ignored and
  pruned on the next write — and the owner folds them into its file on its next write (a resumed
  session then stops polling what already finished). Two panes may both poll an orphan in the
  same 15 s tick; the cost is one duplicate read, the results are identical.
- States: GitLab's statuses fold into queued / running / success / failed / canceled / skipped /
  manual. Header: `label #id · ref` on the left; `state  ██░░ finished/total · duration` on the right beside `↗` / `✕` (0.14.0; a second Button, folding like the name; the bar only while it runs — a finished one reads `success  15/15 · 18m30s · 20:23`), finished = success + failed +
  canceled + skipped; a finished pipeline's header ends with `· HH:MM` (0.12.0) — when it finished,
  GitLab's own time else when it was seen to finish, with the date once that is not today, like a
  done task's time. Then the counts line (each state in its colour, zeros dimmed) and the jobs
  grouped by stage in pipeline order (GitLab lists newest first; sorted by job id), names padded
  so the durations line up. Layout (0.4.1): one indent step per level — section → item → details →
  jobs — for Needs you, Now, Pipelines and Sessions alike.
  Every pipeline starts folded — header + counts line, the compact form (0.4.2) — and a press
  shows the stage/job tree; ✕ on a finished one goes to the
  sidecar (`pipeline:<key>` + `finishedAt`), so the session's file keeps its one writer.
- A `glab` failure (not installed, not logged in, no such pipeline) is shown on the pipeline.
- List (0.6.0): newest first (by GitLab's `started_at`, else when watched), across sessions. A
  success folds to its one header line (running / failed ones keep the counts line). A pipeline
  that succeeded more than 1 h ago moves into a folded `Finished (N)` row at the end of the
  section; one press lists them. Actions (✕) are right-aligned, padded to a five-column hitbox.
- Estimate (0.7.0, fixed 0.8.1): on its first refresh the watching session lists up to 5 earlier
  successful pipelines of the same project + ref + source (`pipelines?ref=…&status=success&source=…`),
  skips the pipeline itself, reads each one's details (`pipelines/<id>` — GitLab's LIST carries no
  `duration`, verified against the real API 2026-11-07; 0.7.0–0.8.0 read it from the list and so
  never had an estimate) and stores their average as `estimateS` (null when there are none; a
  running pipeline with none retries, the cache keeping that free). The
  lookup is cached in the plugin's `$.store` (`estimate2:` keys) for 24 h per project + ref + source, so the next
  pipeline of that kind costs no call. A running pipeline's line reads `elapsed / ~estimate`.
  Job estimates (0.8.0): the same lookup also reads those sample runs' jobs (one call each, at most
  5, cached with the rest) and stores each job name's average over the runs where it succeeded as
  `jobEstimates`. Unfolded, a running job reads `elapsed / ~estimate` (from its `started_at`), a
  queued one `~estimate`, a finished one its real time; a job without history shows none.
- Links (0.9.0, asked for 2026-11-07: "open the one I want to view"): a `↗` at the right edge of
  every pipeline's header, and of every job row when unfolded, is the surface's own `Link`
  element to GitLab's `web_url` (the pipeline's, and each job's — the jobs API carries `web_url`,
  verified against the real API 2026-11-07, stored as the job's `url`). On the terminal it is an
  OSC 8 hyperlink, so the terminal opens the browser on the person's click; the plugin never runs
  an opener itself. A pipeline or job without a `web_url` draws no link. Hover (0.9.1, asked for
  2026-11-07: "easier to see which link belongs to which job"): every pipeline header and job row
  is its own hover scope (a keyed Box) — the pointer lights the whole row (`backgroundColor:
  'subtle'`, a theme key, so dim on dark and light themes) and underlines the job's text; the
  surface applies it, no hook runs.
- Live vs finished (0.21.0, asked 2026-11-08: "it's too easy now not to notice a new running
  pipeline"): a running row starts with a yellow `●` (queued / not found yet: cyan `○`), its name
  and state bold, its state in the running / queued colour; a finished row's name dims, its state
  keeps the outcome colour (success green, failed bold red, canceled / skipped dim). The section's
  `N watching` is yellow and bold while anything runs, so it shows even folded.
- Duration (0.5.1): running → now − GitLab's `started_at` (ticks with the pane's 2 s redraw);
  finished → GitLab's `duration` (as its UI shows), else `finished_at − started_at`; omitted
  before the pipeline has started.
- The section header is a fold button with a summary (0.5.0): `Pipelines  N watching · N succeeded
  · N failed` (+ canceled when any). It is folded by default once every pipeline succeeded and
  open otherwise. The person's fold/unfold is stored under the pipelines' current state signature,
  so it holds until a state changes — then the default applies again (news reopens the section).

## GitHub Actions (0.10.0)

Asked for 2026-11-07: "add support for GitHub pipelines, similarly to the current GitLab pipeline"
— and every push to a repo with CI is watched (the bundled skill's rule; automatic since 0.22.0).

- **Watch input:** `{ provider: "github", project: "owner/repo", run: <id> }` (`pipeline` is
  accepted as the run id) or `{ provider: "github", project, sha }`. No `provider` = GitLab, so
  every older call and file stays valid. Keys carry a `gh:` prefix (`gh:owner/repo#<runId>`,
  `gh:owner/repo@<sha>`), so a GitHub run never collides with a GitLab pipeline of the same number.
  The stored pipeline gets `provider: "github"` and `workflowId`.
- **Fetch:** the watching session asks the user's `gh api`: `repos/<o>/<r>/actions/runs/<id>`, or
  `…/actions/runs?head_sha=<sha>&per_page=1` (the newest run of the commit — a push that starts
  several workflows shows the newest; others can be watched by id), then
  `…/actions/runs/<id>/jobs?per_page=100`. Same 15 s cadence, same stop on finish.
- **States:** GitHub splits `status` (queued / requested / pending / waiting / in_progress /
  completed) from `conclusion`. In progress → running; waiting (an environment approval) → manual;
  completed → success / neutral = success, failure / timed_out / startup_failure = failed,
  cancelled / stale = canceled, skipped, action_required = manual; anything else → queued.
- **Durations** (verified against the real API 2026-11-07): a run has no duration field;
  `updated_at − run_started_at` of a completed run equals the `…/timing` endpoint's
  `run_duration_ms`, so no extra call. A job's is `completed_at − started_at`; a queued job's
  `started_at` is not a start and is ignored.
- **Jobs** have no stage: they list flat (no heading), in job-id order, with their `html_url` as
  the `↗` link and the same hover rows.
- **Estimate:** `…/actions/workflows/<workflow_id>/runs?branch=<ref>&event=<event>&status=success&per_page=6`
  (`/actions/runs` ignores a `workflow_id` filter) — up to 5 runs other than this one, durations
  read from the list itself (unlike GitLab, no detail call), plus each sample's jobs for the job
  estimates; cached 24 h under `estimate-gh:<repo>@<workflow>:<ref>:<event>`.

## Forges, hosts and any CI (0.14.0)

Asked for 2026-11-07: "usable for everyone, for any git repository", including repos behind
authorization.

- **Auth:** the plugin never calls an API itself; it runs the person's own CLI (`glab`, `gh`,
  `tea`) or command, with their login — private repos work for anyone who can read them.
- **Host:** `watch` takes `host`; without it a watch of the session's own repo takes the host of
  its `origin` remote (`hooks/forges.ts` `parseRemote`: scp-style, ssh:// and https://; an ssh
  config alias — no dot — names none; `ssh.github.com` / `altssh.gitlab.com` map to the web hosts),
  else the forge's public host. Every glab / gh call passes `--hostname`, so the answer never
  depends on the directory the command runs in (an orphan is polled from another session's
  repo). Keys carry a non-public host: `git.example.com/team/app#7`, `gh:ghe.example.com/o/r#9`.
- **Gitea / Forgejo** (`provider: "gitea"`, host required): `tea api --login <login> <path>`, the
  login whose URL is on the host (`tea login list --output json`, cached a minute). Gitea's API is
  GitHub-shaped; Forgejo's has its own names (`commit_sha`, `prettyref`, `started`/`stopped` with
  Go's zero time for unset, nanosecond `duration`, a plain job list without times) — both from the
  servers' swagger (gitea.com 1.25, codeberg.org Forgejo 17), `hooks/gitea.ts`. No estimates yet.
- **Custom CI command** (`provider: "command"`): the `ciCommand` setting only — never the tool's
  input, so no session can make another pane run a command. Split on whitespace, placeholders
  filled inside their own argument, no shell; a project starting with `-` is refused. Output: the
  JSON in the README (`hooks/command.ts`); nothing / `{}` = not created yet.
- `$.process.run` is CLI-only: on a surface with no local CLI, pipelines cannot refresh; the rest
  of the pane works.

## Sessions and tasks (0.14.0)

- **Name:** the plugin API has no call for the session's name, but the classic SessionStart (a
  resumed session) and UserPromptSubmit events carry `session_title`; the latest is stored as
  `session.title` and drawn over the repo/folder name. A `/rename` shows from the next prompt.
- **Plan order** (`sort: plan`, the default; the store key moved to `sortTasksBy-2` once so the new
  default applies): tasks in the order the session lists them; the tool's `order` (ids or exact
  titles) puts the named ones first, the rest after in their order.
- **Details and steps:** `detail` (text) and `steps` (`{ title, status }`, replaced whole) make a
  task a fold — mark, title Button, `██░░ n/m` closed steps on the right; unfolded: detail, then
  each step with its mark. A `doing` task with steps starts unfolded (0.21.0, asked 2026-11-08:
  "they should automatically be opened so that I can see what's going on"); the person's own fold
  wins, and a task no longer `doing` folds back by default.
- **Repos:** `repo` on a task; when a session's tasks span several repos, open tasks group under
  `▾ <repo>  N open` (plan order, each repo where its first task stands; untagged = the session's
  `project`) and Done rows read `<repo> · <title>`.
- **Filter:** an Input beside Sessions (pane state `filter`): case-insensitive over title, note,
  detail and step titles, open and done; a session without a match is hidden while it is on.
- **Transcript:** a `ui.render` hook on `ToolUse` / `ToolResult` draws a progress_update call as
  one dim line (`◦ Progress · <now> · N tasks · watching N pipelines`) and hides its result;
  expanded (ctrl+o), errored or interrupted calls draw the engine's own rows.
- **Releases:** CI's `release` job on main — every `version` without a `v<version>` tag gets a
  GitLab Release at the commit that first carried it, notes from git-cliff over the commits since
  the previous bump (`scripts/release.mjs`, `cliff.toml`); job token; the first run backfilled
  0.1.0 → 0.13.1.

## Version and update notice (0.15.0)

The header row's right corner: `v<version>` from the plugin's own manifest (`$.plugin.root`), and
— when the newest GitLab Release of the manifest's `repository` is later — `v<newer> available`
plus `↗` to its release page. The lookup (`releases?per_page=1`, anonymous, through
`$.http.fetch`) runs at session start and hourly, but answers from the store (`latest-release`,
shared by every session) while it is under 6 h old; a failure keeps the last answer. Skipped
entirely under `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. (A deliberate poll: GitLab cannot push to
a local plugin.)

## Removing a task; repo groups per list; subagents (0.16.0)

- **✕ on an open task** (a live session's) writes its id to that session's sidecar `cancelled`
  (the one-writer rule: panes never touch a session's file); every pane hides it at once
  (`visibleTasks(file, entries, cancelled)`). The OWNER folds it in (`cancelTasks`, on its next
  scan or write): status `skipped`, note "removed in the Progress pane", id into the file's
  `cancelled` so a stale sidecar entry never removes it again after the session re-opens it. The
  agent learns it once, at the first of: its next main-loop tool call (`classic.PostToolUse`
  `additionalContext`), the person's next prompt (`classic.UserPromptSubmit`), its next
  `progress_update` answer. A subagent's tool calls never take the note.
- **Repo headings per list:** the open list groups by repo only when its OPEN tasks span more
  than one repo; the Done list groups the same way on its own (`▾ <repo>  N done`, open by
  default, each foldable). No prefixes.
- **A finished pipeline folds again (0.16.1):** a pipeline's fold choice is kept per run state
  (`pipe:<session>:<key>` while running, `…@<finishedAt>` once finished), so one unfolded while it
  ran no longer reopens unfolded when a new pipeline opens the section.
- **Filter highlight:** while the filter is on, every hit in a title, note, detail, step or done
  row is drawn `inverse` (`splitMatches`); a foldable task's title moves beside its fold arrow as
  text (a Button label cannot be styled), and a hit inside its detail or steps unfolds it until the
  person folds it.
- **Subagents report into their own entries (0.17.0; 0.16.0 refused them):** a `progress_update`
  from a subagent (`tool.call` `agentId`) upserts `agents[]` in the session file (`AgentEntry`:
  label = its Agent call's description from `$.agent.list()`, else `agent <id8>`; `now`, its own
  `tasks` through the one task logic, `etaMin` from the tool's `eta`), never the session's tasks.
  `classic.SubagentStop` marks it finished; finished ones fold and stay (no automatic clean-up —
  user, 2026-11-07: never auto-prune, only collapse). The pane
  shows `▾ Agents  N running · M finished` per session (running: label, `██░░ n/m · ~N min left`,
  its `now`; finished folded). The coordinator's own answers end with `Subagents: <label> n/m, ~N
  min left; …`. The reporting rule and the tool description tell subagents to report every few
  steps.
- **Silent subagents are listed too (0.18.1):** an agent without the progress tool (a read-only
  reviewer type with `tools: Read, Grep, …`) never reports, so it used to be invisible. Each 2 s
  scan folds `$.agent.list()` into the session's own file (`syncAgents`): a running agent not yet
  known gets an entry labelled by its description (no steps), one the list says `completed` /
  `failed` / `killed` is finished; written only when something changed. (`classic.SubagentStart` delivers the
  reporting rule since 0.23.0; the listing stays the scan's, which also sees agents without the tool.)
- Every background step nobody awaits (timer ticks, the startup lookups) is `detached`: a failure
  or a step outliving its session is dropped, never an unhandled rejection.

## Pane size (0.18.0)

Every `$.ui.open` asks for `columns` (the dock's width beside a fullscreen transcript; Claude Code
caps it at 45 % of the terminal, at least 24) and `rows` (the inline block's height above the
prompt) from the settings `paneColumns` (default 84 — the content's natural width) and `paneRows`
(default 20); 0 asks for none. Requests, not grants: a size the person dragged or keyed wins. Where
the pane sits (dock from 110 columns in fullscreen, inline otherwise) and when it opens unasked
(from 144 columns) are Claude Code's — a plugin cannot open itself narrower.

## Tasks linked to subagents (0.23.0)

Asked 2026-11-09 (item 14): the coordinator keeps owning its task list (one writer; it verifies
an agent's result), but the two must not drift apart. A task's optional `agent` (tool field, `''`
clears) names the subagent by its Agent call's description — what `$.agent.list()` returns — or
its id; `linkedAgent` matches it to the session's agent entry. The pane draws, under an open
linked task, `● <label> n/m · ~N min left` (the agent's own counts and `timeLeft`), or "finished —
verify and update this task" once it ended — never a copy of its steps. `SubagentStop` queues one
`notice.agentFinished` per open task linked to it (`finishedLinks`), handed to the coordinator in
its next `progress_update` answer or main-loop `PostToolUse`, once; nothing is marked done. The
Agent-call hook auto-links (`autoLinkTarget`): only when exactly one open `doing`, unlinked task's
title and the description contain one another; otherwise nothing. The rule gains `rule.delegate`
(when agents and tasks are on, not at minimal effort).

## ✕ at every level (0.23.0)

Asked 2026-11-09 (item 10): the task ✕ (0.16.0) reaches every level through the SAME path — the
sidecar's `cancelled`, folded in by the owner — with encoded keys (`removalKey` / `parseRemoval`):
a plain task id; `step:<task>:<step title>`; `agent:<agent>:<task>` (a subagent's step — its own
task list); `agentall:<agent>` (its whole work). `cancelDeeper` (after `cancelTasks`) folds each
once (the key joins `cancelled`): a step → `skipped` + `removedByUser` (out of `stepCounts`), a
subagent's task → skipped in its list + its own `cancelled`, a whole subagent → its open tasks
skipped + `cancelledAt`. Notices are routed: the main loop's go with the next prompt or main-loop
tool call; a subagent's (`pendingAgentNotices`) with ITS next tool call (`PostToolUse` carries
`agent_id`). Nothing comes back: `applyUpdate` keeps a removed task skipped on any upsert (an error
line says so; a new title or id is a new task), a removed step stays as it was in every resent
`steps` list, and a subagent's list runs with its own `cancelled`. Panes hide a removal at once
(`removedHere`) before the fold. The engine has no call to stop a subagent: the whole-agent ✕ is the
notice ("stop now: report what you have so far and end"). Every ✕ sits at the right of its row,
which lights on hover like the task rows'.

## The Settings view (0.23.0)

Asked 2026-11-09 (item 9): settings without commands. A `view` atom (`main` | `settings`) — "⚙
Settings" in the header corner and `/progress settings` open it, "← Back" leaves. Two sections:
**This session** — the four switches (`setToggle`, `undefined` = reset to default), each labelled
on/off and default / this session; **Defaults for new sessions** — the plugin's own rows from
`$.config.list()` (key `progress-panel.<field>`: the engine's label, value and declared options):
a `choice` row cycles on press (`cycleConfig`), a text row is the pane's `Input`, submitted on
Enter; both write through `$.config.set` — the same store `/plugin configure` writes, so there is
no second settings file and no precedence puzzle (a session's switch > the setting > the built-in
default); a refusal (`{ deny }`) is toasted. The view reads `sessions` and a `configTick` atom
(bumped after each write) so it redraws at once.

## Settings: one reader (0.23.0)

Asked 2026-11-09 (item 8). Every option is read once per module load by `readSettings`
(`hooks/settings.ts`, each with its built-in default; a value outside its options falls back) into
`settings` — the one place a value and its default live (the switches' defaults stay
`defaultsFrom`'s). Their effects: `toastNeedsYou` + `bell` (`$.ui.notify`, the person's own
channel) on Needs-you toasts; `pipelineNotify` (never / failures / always) on a watched pipeline
that finishes in a poll round (`notifiesFinish`); `paneScope` filters the listed sessions (this one
always stays); `autoOpen` never = no open at start (`always` is not offered: the engine seats an
unasked pane only from ~144 columns); `doneShown` / `agentsShown` / `successFoldHours` replace the
old constants; `clock` (`formatClock` / `formatTime`: 24h default, 12h, or the locale's via Intl);
`reportingEffort` picks the rule's bullets (`ruleKeys(eff, effort)`: `rule.milestones`, or
`rule.nowOnly` for minimal) and the subagent rule (`prompt.subagent*`); `pipelineRefreshSec` the
poll timer; `updateCheck` the release lookup (the env var still wins); `palette` passes every
drawn colour through `tint` (Okabe–Ito blue / orange for colour-blind safe, or none).

## Claude Code's waits as Needs you (0.23.0)

Asked 2026-11-09 (item 13). `classic.Notification` (`notification_type` `permission_prompt` /
`idle_prompt`, `message`, and `agent_id` in a subagent) raises an item in the session's own
`autoNeeds` — apart from the agent's `needsYou`, which every report replaces wholesale — one per
kind and loop (a subagent's names it by its `$.agent.list()` description). `liveNeeds` reads both,
so the status line, the toasts and the pane's Needs you show them like any ask. Cleared as the wait
ends: that loop's permission item by its next `PostToolUse` / `PostToolUseFailure` /
`PermissionDenied`, every permission item by `Stop`, everything by the next `UserPromptSubmit`;
a plain read first, so a tool call with nothing to clear writes nothing. Behind `autoNeedsPermission`
/ `autoNeedsIdle` (both on) and the reporting switch.

## Time left: measured, not guessed (0.23.0)

Asked 2026-11-09 (item 11): agents' estimates were far too pessimistic — human-effort hours for work
an agent finished in minutes. Both ends: the rule, the subagent note, the tool description and the
skill say an estimate is the agent's OWN wall-clock time (the calls, builds and tests left), never
a person's; and the pane stops trusting the guess once it has data. `timeLeft` (model.ts): with at
least one finished step, the median of the finished steps' durations (each from the previous
finish, the first from the agent's `startedAt`) × the open steps, at least 1 min; before that the
agent's `etaMin`, shown as `(est.)` — in the pane's agent row and in the coordinator's
`Subagents: … ~N min left` line alike. A step's `doneAt` is stamped when it closes (kept across the
whole-list resends of `steps`), so a task's steps carry the same history.

## Repos without CI are remembered (0.23.0)

Asked 2026-11-09 (item 6): the first push from a repo decides whether it runs CI, and the verdict
is reused. `hooks/cimemory.ts` (pure) + `ci-memory.v1` in the progress folder (not `.json`: the
session scan reads those), shared by the machine's sessions, read-change-write (tiny). Key = the
repo's toplevel + the remote the push named (a mirror apart). Verdicts: `none` (no CI files, or a
known forge of another kind), `yes`, `nopipeline` — the poller saw a by-sha watch reach the
10-minute "no pipeline yet" hint (`markNoPipeline`, every `yes` entry on that host + project).
Each push stats the CI files (`repoCiFiles`, cheap) and compares them with the verdict's `files`:
same files and younger than `CI_MEMORY_TTL_MS` (7 days) → a non-`yes` verdict skips every other
lookup; else the repo is judged again. A no-CI repo's agent is told once per session per repo
(`push.noCi`). `/progress pipelines recheck` and `/progress doctor` forget the repo's verdicts.

## Switches: per-session features over plugin defaults (0.23.0)

Asked 2026-11-09 (items 5–7): turn the panel's agent-facing parts off per session, with defaults
for new sessions. ONE model (`hooks/toggles.ts`, pure): four features — `reporting` (the master
switch), `tasks`, `agents`, `pipelines`. Defaults from userConfig (`autoStart` is reporting's;
`tasksDefault`, `agentsDefault`, `pipelinesDefault`; all `on`); a session's overrides live in ITS
OWN file (`toggles`, written by that session only — the one-writer rule holds), read back at
`session.start` (a reload or resume keeps them; a new session = the defaults). `active(f)` =
reporting && f. What each gates: the composed rule (`ruleKeys`: a feature off drops its bullets;
tasks off swaps in `rule.nowOnly`), the prompt reminder, the subagent rule, the removal notices,
the automatic watch, `syncOwnAgents`, and `progress_update` (reporting off: nothing written;
agents off: a subagent's call refused; tasks off: `tasks`/`order`/`remove` dropped; pipelines off:
`watch` dropped — each with a one-line note in the answer). A change queues ONE note for the agent
(`changeNote`; reporting back on queues the whole rule), handed over with the next prompt or
main-loop tool call. The pane: a "This session:" row of ● / ○ buttons (always drawn, so a dormant
session can switch itself on); every session's group reads its file's switches over this pane's
defaults — reporting off adds "· paused" and dims it, tasks off hides its tasks, agents off its
Agents section. With `autoStart` off a session does not open the pane by itself. Commands:
`/progress on|off` (also enable/disable, resume/pause), `/progress <feature> on|off`,
`/progress status`.

## `/progress doctor` (0.23.0)

`/progress doctor` (the `progress` command's argument, case and spaces ignored) answers one line per
check, ✓ / ✗ / –, each ✗ with its fix beneath (`hooks/doctor.ts`: the classifiers + the format,
pure; the checks in register.tsx): the version (`ownManifest`); the reporting rule (`ruleComposed` /
`ruleSent` / not yet); the progress folder (resolved, then a probe file written and deleted); the
repo's CI (`repoCi`, the one detection the auto-watch uses); the forge CLI — ONE API call for this
repo's project through the person's own `glab` / `gh` / `tea` (`projects/<path>`, `repos/<path>`),
its failure classified (`classifyCliError`): not installed, not logged in for the host, or logged in
but unable to read the project (403/404 — a token scoped to other projects, the 2026-11-09 case);
and `git ls-remote --exit-code origin HEAD`, its whole stderr classified (`classifyGitError`: an
untrusted SSH host key, missing credentials). Read-only apart from the probe; a custom CI command is
not run.

## Out of scope / later

- Other machines: the store is local. Mirroring to a shared place stays the agent's job.
- v0.1's single `progress.json` is not read any more (breaking; noted in the README).

## Agents: their steps, and finished ones under Done (0.19.0)

User, 2026-11-08: "I don't know what it's doing and how it's progressing, nor how long each step is
expected to last" and "a separate section for the finished agents … under the Done". A running agent
is a fold (default open) showing its `now` and each of its steps with status and note — the reporting
rule asks subagents to put each open step's own estimate in its `note` — beside `n/m`, its run time
(`startedAt` → now) and `~N min left`. The **Agents** section lists only running agents; a finished one
moves under the session's **Done** into a folded **Agents** heading (Done's count includes them; *Clear
all* still clears tasks only — agents are never cleaned up automatically).
