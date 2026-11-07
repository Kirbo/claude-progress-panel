# Multi-session progress panel (v0.2)

> **Status:** shipped in 0.2.0 · 2026-11-06 · single-writer sidecar + mid-write tolerance in 0.3.1 · pipelines in 0.4.0 · GitHub Actions in 0.10.0 · GitLab links in 0.9.0 · orphaned pipelines polled by any pane in 0.11.1 · pipeline finish time in 0.12.0 · reporting rule in every system prompt in 0.13.0 · own-file writes serialized in 0.13.1
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
    ✗ macOS build — runner restarted
    ● Screenshot refresh — capture running
    ▸ Done (5)                          ← [Clear all] only while open
▸ panel · ended 21:40 · 0 open · 3 done            ← dimmed
```

- Every `▾`/`▸` line is a Button that folds its part. Defaults: live sessions open, ended
  sessions folded, every Done section folded. Fold state is per pane (`$.state`).
- Done rows read `✓ title  YYYY-MM-DD HH:MM  [✕]` (time the task was done, local time).
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

Status values: `todo`, `doing`, `blocked`, `done`, `skipped`. The plugin stamps `createdAt`,
`updatedAt` and `doneAt` (set on entering done/skipped, cleared on re-opening). The tool answers
with the session's task list (ids, statuses) so the agent can address tasks by id.

## Reading: refresh

There is no file-watch API for plugins, so each session lists the folder every **2 s**
(`$.clock.every`) and reads a file only when its mtime changed — one directory listing per tick.
A session's own write redraws at once. (Deliberate poll: push is impossible here.)
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
  manual. Header: `label #id · ref` on the left; `state  ██░░ finished/total · duration` on the right beside `↗` / `✕` (0.14.0; a second Button, folding like the name), finished = success + failed +
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
- Duration (0.5.1): running → now − GitLab's `started_at` (ticks with the pane's 2 s redraw);
  finished → GitLab's `duration` (as its UI shows), else `finished_at − started_at`; omitted
  before the pipeline has started.
- The section header is a fold button with a summary (0.5.0): `Pipelines  N watching · N succeeded
  · N failed` (+ canceled when any). It is folded by default once every pipeline succeeded and
  open otherwise. The person's fold/unfold is stored under the pipelines' current state signature,
  so it holds until a state changes — then the default applies again (news reopens the section).

## GitHub Actions (0.10.0)

Asked for 2026-11-07: "add support for GitHub pipelines, similarly to the current GitLab pipeline"
— and every push to a repo with CI is watched (the bundled skill's rule).

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

## Out of scope / later

- Other machines: the store is local. Mirroring to a shared place stays the agent's job.
- v0.1's single `progress.json` is not read any more (breaking; noted in the README).
