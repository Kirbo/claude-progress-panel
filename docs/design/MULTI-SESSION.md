# Multi-session progress panel (v0.2)

> **Status:** shipped in 0.2.0 · 2026-11-06 · single-writer sidecar + mid-write tolerance in 0.3.1 · pipelines in 0.4.0 · GitHub Actions in 0.10.0 · GitLab links in 0.9.0 · orphaned pipelines polled by any pane in 0.11.1 · pipeline finish time in 0.12.0 · reporting rule in every system prompt in 0.13.0 · own-file writes serialized in 0.13.1 · forges/hosts/any CI, session names, plan order, task details, repo groups, filter, quiet transcript rows, Releases in 0.14.0 · version + update notice in 0.15.0 · task removal, per-list repo groups in 0.16.0 · subagent progress (Agents) in 0.17.0 · pane size settings in 0.18.0 · silent subagents listed in 0.18.1 · agent steps + finished agents under Done in 0.19.0
> **Asked for (2026-11-06):** every Claude Code session on one machine writes to the same store and
> every pane shows the same status, grouped by session; collapsible groups, a Done section with
> timestamps, "Clear all" and per-item ✕, sortable tasks, the plugin's own settings.

## Layout (top to bottom)

```
updated 22:05 · switchboard                      ← newest update across sessions
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
- "Clear all (N)" shows only while its Done section is open (0.14.0) and says how many rows it
  clears: all of Done, the rows behind "N older" and the finished agents included.
- The pane scrolls when taller than its window (the engine's own scrolling).
- With anything in Needs you, the status line reads `⚠ N need you`; an item that appears from
  another session also raises a toast once.
- **What is asked comes first** (`liveNeeds`): asks and permission prompts, by the newest session;
  then the sessions that only finished a turn (`autoNeeds` of kind `idle`). Every session idle for
  a minute used to add its own Needs-you line, toast every other pane and — sorted by update time
  — take the status line's first slot ahead of a real ask. Now the idle ones are ONE dim line under
  the asks, counted and named ("○ 3 sessions finished their turn — …: api, docs, site"; the
  magenta header counts asks only, and is not drawn for idle sessions alone), they raise no toast,
  and the status line counts them only when nothing is asked.
- **A name is one session's** (`nameIn`): two OPEN sessions that carry one name (two in one repo)
  were the same word in Now, Needs you and their headers. The one that started later is numbered
  (`app`, `app #2`; by `startedAt`, then id); an ended one takes no number ("ended …" tells it
  apart). An ask's fold is keyed by its session and text, so the same ask in two sessions folds
  separately.

## Store

One folder, default `<CLAUDE_CONFIG_DIR or ~/.claude>/progress/`, option `progressDir`. One file
per session, `<session-id>.json`, written only whole. The id is the file's name and is written into
paths, so it is a plain name (letters, digits, `.`, `_`, `-`; no separator, no `..`): a file whose
name is not one, or whose `session.id` is not its own name, is not a session's file — never shown,
and nothing is written or deleted through the id it claims (`isSessionId`, `parseSessionFile`; a
stored pipeline's `project` and `id` are held to what a forge's API path allows the same way,
`isSafeProject`; its `sha` is 7–64 hex digits, its `host` a plain host name, its `watchRef` a ref
name — each reaches a command line — and a pipeline that fails any of them is dropped on read;
its and its jobs' `url` is kept only when http(s), job and stage names are cleaned to one short
line without control characters: `asPipelines`). The file:

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
  "doneAt": "ISO", "at": "ISO" }], "cancelled": ["t5"], "cancelledAt": { "t5": "ISO" },
  "pipelines": [ … ] }` (`at`, `all` and `cancelledAt` are optional: see "Undo") — on ✕ / Clear all, and with refreshed copies of the
  session's orphaned pipelines (see Pipelines); always read fresh, change, write whole, so neither
  drops the other's part. The plugin API has no file lock and no rename, so `writeSidecar`
  (store.ts) guards twice: one pane's changes to one sidecar run one at a time (a press and a poll
  interleave at every await), and a change computed from a copy another pane replaced meanwhile
  (the file's mtime moved between the read and the write) is computed again from the new copy —
  which narrows the window between two panes to the last stat and the write, and cannot close it.
  So a person's click can never
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
- **…and never a new session, for its owner.** The owner reads its own file before every write.
  A read that failed, or a file that did not parse, used to count as "no file": a blank session
  was then saved over everything the file held (tasks, agents, pipelines, switches). Only a file
  that is not there (the read fails and so does its `stat`) is a new session now. One that is
  there but unreadable makes `ownFile` throw `OwnFileUnreadable`: the change is not made and
  nothing is written — `progress_update` answers that nothing was written and to send the update
  again (`tool.unreadable`), a hook counts as absent, a scan's own part waits for the next tick. A
  file still unreadable with the same content `OWN_UNREADABLE_MS` (10 s) after it was first seen
  so is damaged, not in flight, and the session does start it over — it could never report again
  otherwise (`refuseUnreadable`, store.ts).
- **Every stored field is checked on read** (`parseSessionFile`, `parseSidecar`): any pane reads
  every session's file, so one malformed value in one file would throw in every pane on the
  machine at each redraw. What every reader relies on (the version, the session block,
  `updatedAt`, the task list) makes the file refused when it is wrong — it then keeps its last
  good copy, like a file caught mid-write. Inside it, what is no task, step, agent, ask, link,
  pipeline, job or run at all is dropped; of one that is, each optional field is what its type
  says or is left out, and a field that must be there gets a safe stand-in (a task's times the
  file's `updatedAt`, an agent's label its id, a pipeline's state `unknown`). A field this version
  does not know rides along untouched, so a newer version's addition survives an older one's
  rewrite of the file.
- Forgetting an ended session deletes both its files.
- **A blank session is never stored or shown** (0.11.0, asked for 2026-11-07: sessions that never
  reported anything piled up in the pane). Blank = no task, no `now`, no ask, no pipeline. A
  session's file is created by its first `progress_update`, not at start; a session still blank
  at `session.end` deletes its file and sidecar instead of stamping `endedAt`; any pane deletes an
  ended blank file it finds (older versions wrote one at start), and the pane skips a live blank one.
- **A session that died without `session.end` is ended (0.23.0).** At start a session records its
  process and machine in its file (`session.pid`, `session.host`, `session.pidStart`, from
  `whoAmI`: a spawned child's parent, the machine's name and when that parent started —
  `sh -c 'echo $PPID; ps -o comm= -p $PPID; uname -n; …'`, PowerShell's `ParentProcessId` and
  `hostname` on Windows), but only when that parent is `claude`/`node`: a helper in between
  would die at once and end every idle session. Any pane on the SAME host asks, at most once a
  minute per session, whether a live session idle for `DEAD_AFTER_MS` (10 min) still has its process
  (`kill -0`, `tasklist`); gone → `endedAt` = its last `updatedAt` (its owner is gone, so the
  one-writer rule holds). **A pid alone is not a process:** after a reboot, or once the number has
  been handed out again, `kill -0` answers for a stranger and the dead session stayed live with
  its asks. So the start of the process is recorded too (`pidStart`: on Linux the start in clock
  ticks since boot, field 22 of `/proc/<pid>/stat` — stable whatever the clock, time zone or
  locale does; elsewhere `ps -o lstart=` under `LC_ALL=C TZ=UTC0`) and asked again with the
  liveness check: the same pid with another start is another process, and the session is ended.
  A start that cannot be read decides nothing, a file without `pidStart` (an older version's) is
  asked by pid alone, and Windows records none (pid only, as before). The machine's name is
  `uname -n`, not `hostname`: that command is missing on some minimal systems, where nothing was
  recorded at all. A false "dead" heals itself: the owner's next write clears `endedAt`
  (`withProcess`). Can't tell → nothing changes. `/progress doctor` shows the recorded pid.
  Proven live on macOS (2026-11-09): a real session's file carries its `claude` pid and host; a
  headless session (stream-json input held open) reported, was killed with `kill -9` (no
  `session.end`), and — its file aged past `DEAD_AFTER_MS` — another live session's pane checked the
  real pid and ended it as of its last write within one scan.

## Writing: the `progress_update` tool

The plugin registers `progress_update` (listed as `mcp__progress-panel__progress_update`, schema
in the prompt from the start). Input — every field optional, a patch, not the whole state:

| Field      | Meaning                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `now`      | replaces the "now" line                                                  |
| `needsYou` | replaces the list (`[]` clears it)                                       |
| `tasks`    | upserts by `id` (or, with no id, the exact `title` of an open task); new tasks get `t<n>` ids |
| `remove`   | task ids to delete                                                       |
| `clearAgents` / `dismissAgents` | remove finished (or only waiting) subagent rows — all, or by description / id (0.23.1) |

**Which task a patch means.** With an `id`: that task. Without one: the OPEN task of that exact
title — a closed one only when the patch itself closes (a result sent again), or when the person
removed it in a pane (it stays skipped, and the answer says so). So "Verify" sent again in a second
round is a new task, never the first round's left `done` (`titleMatch`). An id the agent chooses
for a new task is a plain name — letters, digits, `.`, `_`, `-` (`isTaskId`): `step:…` and
`agent:…` are how a pane's removal of a step or of a subagent's task is keyed in the sidecar
(`removalKey`), and an id of that shape would be read as one. A stored task under an older, freer
id is still updated by it. An id in `cancelled` (removed in a pane) never names a new task: every
pane would hide it at once and its own ✕ could not be folded in again.

**The tool's description is a few sentences.** The tool is never deferred, so its description and
schema ride every request of every session and every subagent. The description had grown to about
450 words that the reporting rule, the subagent's prompt and the schema's own field descriptions
each said again (the "estimates are your own wall-clock time" sentence reached a subagent four
times). It now says what the tool is, the four fields that matter and when to call it; what a
field means is said once, on the field (`hooks/schema.ts` — every top-level field and every task
field has a description, the watch examples and key formats included), and how to behave is the
rule's business. `scripts/docs-watch.test.mjs` holds the description to 700 characters and the
schema's watch examples to the schema.

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
then — if the session's own file is still blank at a later prompt — a one-line `prompt.nudge`,
once (it rode every prompt until the first report, so a session of plain questions and answers,
which has nothing to report, was reminded for as long as it ran).

**…but never both, in a session seen from its start (0.23.3).** A new session's first prompt
arrived with the whole rule although its system prompt carried it too (2026-11-10): the tool is
still connecting when the session starts, so the prompt composed then has no rule (`ruleComposed`
stays false) and the one composed for the first request does. A session this copy saw start
(`classic.SessionStart`, source `startup`) therefore leaves the rule to its system prompt on the
first prompt (`freshStart` / `ruleDeferred`); if no composed prompt carried it by the main loop's
first tool call, that call hands it over (`takeDeferredRule`), once.

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
description is remembered (`promptFed` — also when the prompt already held the rule), and
SubagentStart / the first-call fallback skip an agent whose `$.agent.list()` description is one of
those. The rule says a job of about three tool calls may skip reporting; a longer one reports from
its first call.

**…never twice: an agent that cannot be identified is not handed a copy.** Which subagent a
SubagentStart is about can only be told from `$.agent.list()` — the event carries no description —
and a starting agent is not always listed yet. The skip above then failed, and the subagent got the
rule in its prompt AND again as it started (seen live, 2026-11-12: every subagent paid the
paragraph twice). So while any prompt has been fed, `withSubagentRule` hands the rule only to an
agent it can identify as not fed: one not listed at start is left to its first tool call, and one
still unlisted then is taken for a fed one. An agent started some other way (no Agent call of this
session) is listed under a description nothing fed, and gets the rule at start or with its first
call as before. The cost of the rare wrong guess is a subagent without the paragraph (the tool's
own description still tells it to report), never a second copy.

**…and after a compaction (0.23.0).** A compaction keeps the system prompt but summarises the
conversation, so a rule that only rode a prompt (the mid-way case) can be summarised away. The
session's own compaction fires `classic.SessionStart` with `source: "compact"` (no `agent_id`):
when this module composed no prompt, its `additionalContext` carries `prompt.reporting` again. A
composed session gets nothing — its section survives.

Status values: `todo`, `doing`, `blocked`, `done`, `skipped`, `failed` (0.23.0), and the plugin's
own `unfinished` (0.23.0: never accepted from a report). Closed = done / skipped / failed /
unfinished. Each row's `note` shows beneath it (a step's too, since 0.23.0 — `Step.note`): the
outcome of a done one, WHY for blocked (⚠ magenta), skipped (– dim), failed (✗ red) — the reason
is never folded away, and never dimmed where it matters most: why a row is blocked or failed
reads as plain text, what waits on the person in the Needs-you colour (`reasonStyle`); only a
note on work that goes on, is done or was set aside is dim. A subagent that stops for good (SubagentStop or the list sync, not a
background-work pause) turns its `doing` steps `unfinished` (– dim, "agent stopped before
finishing" unless noted); a resume turns them back to `doing`. A finished subagent folds open
under Done → Agents to the same step list, without ✕. The plugin stamps `createdAt`,
`updatedAt` and `doneAt` (set on entering a closed status, cleared on re-opening). The tool answers
with the tasks the agent still works with (ids, statuses), so it can address them by id: the open
ones, and those this call created or changed (`applyUpdate`'s `touched`). Tasks closed before are
only counted ("; 12 closed ones are not listed") — a session keeps its done tasks all day, and
echoing every one of them in every answer, over hundreds of calls, was the largest avoidable cost
of the plugin to the agent. A stand-in task (`auto`) is never listed (`summarize`).

## Reading: refresh

There is no file-watch API for plugins, so each session lists the folder every **2 s**
(`$.clock.every`) and reads a file only when its mtime changed — one directory listing per tick.
A session's own write redraws at once. (Deliberate poll: push is impossible here.)
A tick folds its result into the store as it is when the tick ends (`mergeScan`), not as it was
when it began: a session's own save that landed during the scan's awaits keeps its newer copy
(it used to be overwritten by the scan's older read until the next tick), and a tick that finds
the previous scan still running skips, so slow disks never stack scans that land out of order
(0.20.0).
The pane keeps the end of its last successful listing; once that is older than 10 s (five missed
ticks) the header adds a yellow "checked HH:MM:SS (stale)" — a failed listing keeps the last known
state rather than blanking the pane. (Added in 0.3.0, asked for 2026-11-06: "updated" alone could
not tell an idle status from a pane that stopped refreshing. While the checks run the time is not
drawn: a clock ticking every two seconds in the pane's first line told nothing.)

With no session to show, the pane is not one bare line: it names its version, opens Settings and
points at `/progress doctor`, so a silent pane can be told from a broken one.

## Retention (settings)

| Option                  | Values (picker)                         | Default  |
| ----------------------- | --------------------------------------- | -------- |
| `progressDir`           | path (`~/` allowed)                      | empty    |
| `autoClearDoneHours`    | 0 (never), 1, 3, 6, 12, 24, 48, 72, 168 | 0        |
| `keepEndedSessionsDays` | 0 (never), 1, 3, 7, 14, 30              | 7        |
| `sortTasksBy`           | status, title, created, done            | status   |

- Done tasks older than `autoClearDoneHours` — and subagents that ended that long ago — are
  removed by the owning session (or by any session once the owner has ended).
- A session that ended more than `keepEndedSessionsDays` ago is deleted (`rm -f` / `del`, the
  plugin API has no file delete). An ended session can also be dismissed with its ✕.
- The pane's `[Sort: …]` Button cycles the order and remembers it per user (`$.store`); the
  option is the starting value.
- Sorting: `status` = blocked, doing, todo (open) and newest done first; `title` = A→Z;
  `created` = oldest first; `done` = newest done first (open tasks by creation).

## Pipelines (0.4.0)

Asked for 2026-11-06: a live, visual status of the CI pipelines the agent waits on.

- The tool's `watch` (`{ project, pipeline }` or `{ project, sha }`, optional `ref`, `host`,
  `label`) and `unwatch` (keys) maintain the session file's `pipelines` list: key (`project#id`
  for a run watched by id; `project@sha` or `project@sha:ref` for a watch by commit), state, ref,
  url, jobs (`name`, `stage`, `state`, `durationS`), `addedAt`, `checkedAt`, `finishedAt`, `error`
  — and for a watch by commit `watchRef`, `pushed`, `runs`, plus the poller's `noPipeline`,
  `fails`, `stopped` (see "Watching by commit" and "Bounded polling" below).
- **A push is watched on its own (0.22.0)** — asked 2026-11-09: "add the pipelines to the panel
  automatically, if the repo at hand has pipeline … automatically detect where the CI/CD is
  running". `classic.PostToolUse` reads every Bash call (main loop and subagents) for `git push`
  (`hooks/push.ts`, pure: shell words and operators, a leading `cd`, git's `-C`/`-c`, env
  assignments; `--dry-run`/`-n`, `--delete`/`-d`, `:ref`, `--mirror` and the `ci.skip` push option
  skipped). The reader drops redirections with their targets (`2>&1`, `> log`, `&>/dev/null`),
  follows subshell parentheses (a `cd` inside them ends with them), steps over shell keywords and
  wrappers (`{`, `if`/`then`, `time`, `env`, `timeout 120`), reads `$(git branch --show-current)`
  as HEAD, and takes a command substitution, a heredoc body and a comment for text, never for
  commands — `git push 2>&1` once read `2>` as the remote and watched nothing. Per push, through
  `git -C <dir>`: the toplevel; the CI off its files (`ciProvider`: `.gitlab-ci.yml`,
  `.github/workflows/*.y(a)ml`, `.gitea/` or `.forgejo/workflows/`, else the `ciCommand` setting,
  else nothing); the remote the push named (a name or URL), else the upstream's, else `origin`,
  parsed by `parseRemote`; each pushed ref's sha (`<src>^{commit}`, a bare push = HEAD and its
  branch). Landed only: an interrupted or non-zero call watches nothing, and a branch whose
  remote-tracking ref is not the pushed sha (rejected) neither. The watches go through `applyWatch`
  under the same lock as the tool's, each with the ref it landed on (key `project@sha:ref`,
  `pushed: true`); a whole-commit `watch` of the agent's and a per-ref one of the same commit
  never stand side by side (whichever came first covers the other), so it stays one row; the
  result's `additionalContext` tells the agent it is watched. Label `<repo> <branch>`.
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
  a short sha showed `unknown 0/0` forever, under the last error any call had hit) and carries the
  `noPipeline` flag — what the code reads, never the row's translated words.
- **Watching by commit = every run of the commit.** One push can start several pipelines: one run
  per GitHub workflow, a branch and a merge-request pipeline on GitLab. `refreshCommit` lists them
  all (`pipelines?sha=…&per_page=100`, `runs?head_sha=…&per_page=100`, Gitea `…&limit=50`), keeps
  the ones on the watched ref (`runsOnRef`, client-side: a run on another plain branch or tag is
  left out; a `refs/merge-requests/…` or `#12` ref, or none, belongs to every watch of the commit)
  and reads them as ONE row (`hooks/commit.ts`, pure): unfinished while any run is (running once
  one runs or some already finished, else queued, else manual), and only when ALL are complete
  the worst outcome — failed, canceled, success. Before, the newest run alone decided: a fast
  lint or labeler run going green closed the linked task as done while the real CI still ran.
  With several runs the row's `runs` lists them (id, state, a label: the workflow's name, the
  trigger when two share it, else the id), every job's `stage` is prefixed with its run's label,
  the row's id and link are the run that failed it (else the newest), its clock runs from the
  first start to the last finish, the estimate is the longest run's, and ⊘ stop cancels each run
  still going. A finished run's jobs are read once and then kept in memory (`self.runJobs`).
  A new run of the same commit that the forge creates only after every listed one finished green
  (a `workflow_run` chain) is not seen: a success is never re-checked.
- **The same commit on a second ref** (`next`, then `main` fast-forwarded to it; a tag; `git push
  origin next main`): each ref is a watch of its own, since the ref is part of the key.
- **Bounded polling** (`shouldPoll` + `bounded`, pure). A check that ends in an error (a missing
  or logged-out CLI, a forge that will not answer) is counted on the pipeline (`fails`) and the
  next one waits 30 s, 1 min, 2 min … up to 10 min; after 8 in a row the watch stops. A pipeline
  waiting on a person (`manual`: a manual job, an approval) and a commit past the 10-minute hint
  are asked every 5 minutes. A commit still without a pipeline an hour after it was watched
  stops, and so does any watch still unfinished 24 h after it was added. A stopped watch
  (`stopped`: `errors` / `nopipeline` / `age`) says "stopped watching — <why>" on its row, counts
  as watched nowhere (the section header, a linked task's "tracked"), and the agent is told once
  (`notice.watchStopped`); watching the same key again starts it over (`applyWatch`).
- **One polling path** (`pollAll`, single-flight). A new watch's first check is `pollSoon`:
  detached — the tool's answer and a push's result never wait for a forge — and when a round is
  already running it asks that round to look once more at what is new, instead of running a
  second round beside it (which could toast one finish twice).
- **Push is not possible** from GitLab to a local plugin: webhooks need a reachable HTTP server,
  and GitLab's own live updates (GraphQL subscriptions over ActionCable) need a browser websocket
  session; the plugin API has neither. So the **watching session** polls through the user's
  `glab api` every `pipelineRefreshSec` (15 s by default) — only its own pipelines, only while
  unfinished — and stops at the first finished state. Other panes read the result from the file (no extra GitLab calls).
- **Orphaned pipelines (0.11.1).** A session that ends (or is killed) mid-pipeline stops polling,
  and its watch used to freeze at its last state forever (seen 2026-11-07: a 69 s pipeline shown
  "running" for 9 h). Now any pane polls another session's unfinished pipeline once its
  `checkedAt` (or `addedAt`, never checked) is older than 1 min — four of the owner's poll periods,
  so a live owner keeps sole charge. The fresh copy goes to that session's **sidecar**
  `pipelines`, never its file (one writer). Panes draw the file's list with the sidecar's copies
  laid over it — per key, the later `checkedAt` wins; copies of unwatched keys are ignored and
  pruned on the next write — and the owner folds them into its file on its next write (a resumed
  session then stops polling what already finished). ONE pane does it: the holder of the
  `orphan-poller` lease in the plugin's shared store (`holdsOrphanLease`: taken when free or run
  out, 150 s, renewed with each round; no compare-and-set exists, so the read-back after the
  write settles two panes asking in the same instant). Orphans are held to the same bounds as a
  session's own pipelines (backoff, parked, stopped).
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
  `…/actions/runs?head_sha=<sha>&per_page=100` (EVERY run of the commit, read as one row — see
  "Watching by commit"), then `…/actions/runs/<id>/jobs?per_page=100` per run. Same cadence, same
  stop on finish.
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

## Cancel + delete a running pipeline (0.23.0)

Asked 2026-11-09 (item 15). A running pipeline's row gets a ✕ (`cancelpipe:<session>:<key>`, beside
↗) when `cancellable` — a known id on GitLab or GitHub; Gitea/Forgejo (no tea cancel/delete the
plugin can rely on) and a custom command (its contract has no verbs) get none. Two presses: the
first arms it (`armed` atom: key + `CONFIRM_MS` 5 s; the label turns "cancel + delete? ✕"), a second
within that window runs `cancelPipeline`: `glab|gh api -X POST <run>/cancel`, then by
`runningPipelineX` (delete / cancel / off) `-X DELETE <run>`. Done → the row goes (own session:
removed from its file; another's: a canceled copy + a dismissal in its sidecar). A failed cancel,
or a refused delete (403: GitLab's delete needs Maintainer/Owner — then it stays cancelled), shows
on the row as its error.

## A resumed subagent runs again (0.23.0)

Bug 2026-11-09 (item 16): a subagent that stopped (its turn limit, or waiting on its own
background work) and was then resumed stayed under Done → Agents — its own reports cleared
`endedAt`, but the 2 s `syncAgents` closed it again at once, since `$.agent.list()` still said its
first run "completed". Now: its own activity — a report, or a tool call carrying its `agent_id`
(`reopenIfActive`, a plain read first) — reopens an ended or waiting entry (`reopenAgent`, steps
kept) and stamps `resumedAt`; `syncAgents` no longer ends a resumed agent (only its own next
`SubagentStop` does) and reopens one the list shows running again. A `SubagentStop` whose
`background_tasks` is not empty marks it `waiting` (shown "waiting on background work"), not
finished.

**Gone from the list (0.23.1).** Bug 2026-11-09, live on 0.23.0: an agent stayed `waiting` with open
steps hours after it finished — finished agents drop OUT of `$.agent.list()` (after a reload the
list is empty), and `syncOwnAgents` skipped an empty answer, so nothing ever ended it. Now a failed
list call is no answer (nothing changes), an empty one is: an agent still marked running that the
list does not name and that showed no activity for `AGENT_IDLE_MS` (3 min) ends like a completed
one (open steps `unfinished`); one the list says runs is never ended. An ended agent never keeps
`waiting` (an older build's leftover is normalised on the next scan; the pane never shows
"waiting" on an ended agent). And the coordinator clears agent rows itself: `progress_update`
`clearAgents: true` (every agent no longer working — ended or only waiting) or `dismissAgents`
(descriptions / ids) removes them from its own entry exactly as the pane's ✕ does; a running one is
never removed (named in the answer when asked for by name). The reporting rule says to use it when
the person asks to clear the pane.

## Removals cross the link (0.23.0)

Asked 2026-11-09 (item 19). As the owner folds removals (`ownFile`), `crossLinks` (model.ts) reads
the link both ways: a removed session task whose linked agent still runs adds that agent's
`agentall:` key to the same `cancelDeeper` pass — the agent is told to stop at its next tool call,
the coordinator that it was (`notice.linkedAgentStopped`); a stopped agent, or one whose last open
step was removed, leaves each open session task linked to it unassigned — the coordinator is told
(`notice.taskUnassigned`) and the pane's link line reads "stopped in the Progress pane — re-plan or
skip" (from the agent's `cancelledAt`); the task is not skipped. A removed step of an agent that
still has work is the agent's alone: the session task's status stays the coordinator's.

## No drift between a task and its agent (0.23.0)

Asked 2026-11-09 (item 18), on top of the links: a linked task's steps ARE its agent's — `extras`
drops `steps` sent to a task with `agent` (one error line in the answer), and the pane draws the
agent's own steps for it (n/m included). An Agent call whose description no open task is linked to
(and no unambiguous auto-link) queues one `notice.agentUnlinked` for the coordinator — only when
the session has a task that could be the agent's (open, its own, linked to none: `hasLinkableTask`);
a session with no such task, an ad-hoc agent's, is told nothing. If the agent then reports while
still on no task, a stand-in `↳ <label>` task (`auto`, doing, linked) appears (`withAutoTask`), and
`dropReplacedAutoTasks` removes it once the coordinator links a task of its own to that agent.

**A stand-in lives only while its agent works.** Nobody made it, so nobody closes it: left `doing`
after its agent ended it drew a "verify and update task ↳ …" note, then the end-of-turn stop and the
stale nudge, for a task the coordinator never planned. When the agent ends for good (its
SubagentStop, the list sync, its row cleared) the stand-in is removed with it
(`dropEndedAutoTasks`; the finished agent itself is listed under Done → Agents) and no "agent
finished — verify" note is sent for it; a scan clears one an older version left behind. A waiting
agent (background work) keeps its stand-in, and one resumed after it ended gets a new one with its
next report. The end-of-turn check and the stale nudge never list an `auto` task.

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
skipped + `cancelledAt`. Notices are routed: the main loop's go with the next prompt, main-loop
tool call or `progress_update` answer; a subagent's with ITS next tool call (`PostToolUse` carries
`agent_id`).

**What is owed is kept in the file, not in memory.** The fold used to queue its notices in the
module's memory while the removal itself was saved to the file: a module reload in between (any
settings change reloads it) dropped the queue, the saved removal was never folded again, and the
agent was never told. Now the fold puts each notice into the session file's `owed` list — beside
`cancelled`, in the same returned object: `{ removed: { id, title } }` for a main-loop task (several
are told in one line), `{ text }` for a ready notice, `agentId` naming the subagent it is for
(`ownFile`, store.ts). A read that is not saved finds the same removal again and computes the same
notice; the save that keeps the removal keeps the notice; handing it over removes it from the file
under the lock (`takeOwed` / `takeOwedFor`) — so each is told exactly once, and the per-fold memory
guard this needed before is gone. `self.owes` only spares the tool calls a read while nothing is
owed (unknown after a reload = look once). Taking the main loop's notices also drops those owed to
subagents that no longer run. Other notes (a pipeline's outcome, a switch change, a linked agent's
finish) are still queued in memory. Nothing comes back: `applyUpdate` keeps a removed task skipped on any upsert (an error
line says so; a new title or id is a new task), a removed step stays as it was in every resent
`steps` list, and a subagent's list runs with its own `cancelled`. Panes hide a removal at once
(`removedHere`) before the fold — which waits until the removal can no longer be taken back (see
"Undo"). The engine has no call to stop a subagent: the whole-agent ✕ is the
notice ("stop now: report what you have so far and end"). Every ✕ sits at the right of its row,
which lights on hover like the task rows'.

## Undo: a ✕ can be taken back

Asked for with the review of 2026-11-12: ✕ on an open task, a step or a running agent was one
click with no way back, and it stops an agent's work; the same glyph on a done row only hides.
Confirms on every ✕ would have made the common case (clearing rows) slower, so instead every ✕ in
the pane — task, step, a subagent's step, a running subagent, a done row, a finished agent, a
pipeline's row (running or finished), and Clear all — can be taken back for a short while, from
the pane itself.

**How it reads.** As before, the row leaves every pane at once. For `UNDO_MS` (8 s) a dim line
stands at the top of that session's group — a pipeline's at the top of the Pipelines section, which
is drawn for it even when no pipeline is left — saying what went, with a `↶ undo` button at the
row's right edge, where the ✕ was: `– Deploy docs  removed`, `– Lane Q  will be stopped`,
`– Alpha  cleared`, `– app main  hidden`, `– Done cleared: 12 rows` (one line and one undo for a
whole Clear all). It is a row like the pane's others (left text cut with "…", action on the right),
and it goes by itself, like the ⊘ button's armed label. A running agent's ✕ is not offered a second
time while its line stands. `undoRows` (pane.tsx).

**Why the session waits.** An undo that only un-hid a row would be a lie once the owning session
had folded the removal in: the task is `skipped` by then and its agent told "do not do it". So the
removal is stamped with the time of the press and nobody acts on it until it can no longer be
taken back:

- the sidecar's entries carry `at` (and `all: true` for Clear all's, which share one `at` and go
  back together); its `cancelled` keys have their time in `cancelledAt`, by key;
- the pane offers the undo while a press is younger than `UNDO_MS`, and honours a press on it up to
  `UNDO_PRESS_MS` (+2 s: a pane redraws every two seconds, so a button drawn just before the
  window closed can be pressed just after) — `withoutPressed` takes the key or entries out of the
  sidecar again, through the same `writeSidecar` as the ✕;
- the owner (`ownFile`) reads only what is older than `REMOVAL_DUE_MS` (+4 s) — `splitPressed(…).settled`
  — so between the last press that can land and the first fold there are two seconds; until then
  its file is as it was: the task open, the agent not told, a hidden pipeline still watched and
  polled. After it, everything is as before the undo existed (skipped, `owed` notice, the agent
  stopped across the link, the done row merged into `dismissed`, the finished agent dropped).

So an undone removal never existed for the session or its agent, and one that stood reaches them
about 12 s after the press instead of within 2 s.

**Old and mixed versions.** All three fields are optional. An entry or key without a time (a
sidecar written before this, or by an older pane) is acted on at once, exactly as before, and has
no undo. An older session reading a newer sidecar ignores the times and folds at once: the undo
line may then still show for a few seconds but takes nothing back (`cancelled` already folded stays
skipped; the pane's line goes with the window).

**A pipeline's ✕ goes through the sidecar for this session's own rows too** (it edited the session's
file directly before, which nothing could take back, and could fail on a file caught mid-write).
A row hidden while it runs is named by that watch — `doneAt: "added:<addedAt>"`
(`pipelineDismissal`) — so it stays hidden through its finish, the owner drops it from its list
(= stops watching) once the window is over, and watching the same pipeline again later is a new
watch and shows; an older sidecar's `doneAt: null` still hides its key for good.

**Not undoable, on purpose:** ✕ on an ended session (it deletes the files at once — there is
nothing left to restore from), and ⊘ stop (it acts in CI; it has its own second press). **Clear
all** says how many rows go (`Clear all (12)`): it clears the whole of Done — the rows folded
behind "N older" and the finished agents, which the count has always included — not only the rows
listed.

**A press that fails says so** (`pressed`, pane.tsx): a press's work is awaited by nobody, and one
that rejected — this session's own file caught mid-write (`OwnFileUnreadable`) under ⊘ stop or a
switch — used to end as an unhandled rejection with the press silently lost. It raises a toast
("that press could not be saved just now — press again").

## Tasks never stay in a state that is no longer true (0.23.2)

Asked three times (2026-11-09): the coordinator kept a task `doing` ~30 min after its work was done
and pushed, only to wait for CI. Three mechanisms, each closing a path:
1. **Task ↔ pipeline.** `Task.pipeline` (a watch key; the tool's `pipeline` field) — and the push
   watch sets it itself (`linkPushedPipeline`): the session's single open `doing` task of the pushed
   repo (`task.repo ?? session.project` = the repo root's folder name) waiting on no running pipeline;
   none or several → no link. `pollPipelines` writes each refresh through `settleLinkedTasks`: green →
   `done` ("pipeline <id> green"), failed → `failed` (the failed jobs), canceled → `failed`; a status
   the agent set after the pipeline finished (`updatedAt` > its finish) wins. The main loop is told
   through `pendingNotes`. The pane shows the pipeline's state on the task.
2. **End of turn** (`classic.Stop`, main loop): `doing` tasks with `updatedAt` before the turn's start
   (the last UserPromptSubmit) and ≥ 10 min old, nothing tracking them (a running linked pipeline or
   agent), return `{ block }` once with the list. A task is asked about **once per spell of
   `doing`**: the block marks it `stopAsked` on the task itself (kept across touches and reloads,
   dropped when the task leaves `doing`), and a turn that finds only tasks already asked about —
   or `stop_hook_active`, the stop right after a block — passes and marks them `unconfirmed`
   (cleared by their next update). Before, "once" was one list signature (ids + `updatedAt`) held
   in memory: a long `doing` task that the agent touched and left `doing` (background work) drew a
   new block at every later turn, and a reload forgot the signature. `todo` (not started) and `blocked` (its reason
   given) never block a turn (`blocked` gets (3)). Off when reporting or tasks is off. Subagents: an agent
   that stops ends its open steps `unfinished` (0.23.0), so they need no stop check.
3. **Staleness nudge** (UserPromptSubmit): `doing` and `blocked` tasks untouched ≥ 20 min,
   untracked, are asked about in ONE additionalContext line naming them all, once per state: the
   task keeps the `updatedAt` it was asked at (`staleAsked`, `markStaleAsked`), so neither a later
   prompt nor a reload asks again until it changes. A `todo` task is never asked about — a later
   item of the plan untouched for 20 min is what a plan looks like (it used to draw a line per
   planned task, and a session picked up the next day one per open task).

Running pipelines (same release): ✕ only hides the row (the own session's is unwatched; another
session's is dismissed with `doneAt: null`, which `visiblePipelines` hides for good); the separate red
"⊘ stop" (two presses; setting "Pipeline ⊘ stop button", key `runningPipelineX`) cancels / deletes in
CI — the two were one ✕ before, and a hide-meant press deleted a release pipeline.

Agents under their repo (same release): when a session's open tasks and running agents span more
than one repo (`groupWorkByRepo`), each repo branch holds its tasks, then its agents; there is no
session-level Agents list then. An agent's repo (`agentRepo`): the repo of the task linked to it,
else `AgentEntry.repo` — recorded once per agent from a tool call's cwd through
`git rev-parse --path-format=absolute --git-common-dir` (`repoFromCommonDir`, so a worktree is its
repo): the first call made once the agent has an entry to keep the answer on (a call before a scan
or its first report gave it one asks nothing and leaves the question open — it used to count as
asked, and the repo was lost for good) — else `OTHER_REPO` ("other"). One repo keeps the flat layout. Done → Agents groups the same.

Background work (same release): a SubagentStop's `background_tasks` is the whole session's, with no
owner; only ids the agent's own Bash results named (`backgroundTaskId`) count as its, so a stop with
none of its own ends it. The "waiting on" line is one short name (`commandHead`).

Needs you never bare (same release): `needsYou` items are a string or `{ text, task?, agent? }`;
the file keeps `needsYou` as texts (every reader unchanged) plus `needLinks` (text → task / agent),
replaced with every `needsYou`. Since 0.26.0 an item may also carry `reply` (the answer it waits
for, "yes or no"), kept in its `needLinks` entry: the agent no longer writes "reply … here" into the
text — each pane words it (`askLine`: "{text} — reply {reply}", plus " here" only when the pane is
the asking session's own AND another session is open). The idle wait is worded per pane the same
way ("Turn finished — waiting for your next message", plus " here"; reworded in 0.26.1 — "Waiting
for your reply" read as a question left unanswered). A session that is the only open one (`isSolo`: no other file with
`endedAt === null`; a session that has not reported yet has no file, so the other one keeps its
name in its pane) is never named: Needs you, Now, the top line and the status line drop the name,
its header reads "This session". Ended sessions keep their names. Automatic permission items take what from the loop's pending tool
call (a pass-through `tool.call` hook notes it and forgets it when the call returns — PreToolUse
rides `tool.call`); else the tool the notice names; else "Permission prompt in session <name> —
open that terminal to see and answer it". `attentionFor` gives a task / agent / agent step its
reason — an automatic wait (main loop: its one `doing` task; a subagent: its row, its `doing` step,
the task linked to it) or a linked ask — and the pane draws the magenta ⚠ with it beneath. The
status line names the first ask (`⚠ <project>: <ask>`), cut with "…".

The Settings view (same release): rows grouped (`SETTING_GROUPS`), values in the right column,
coloured by `valueTone`, bold when `isChangedSetting` against the manifest's own defaults.

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
that finishes in a poll round (`notifiesFinish`); `paneScope` filters the sessions the pane is about (this one
always stays) — its list and pipelines, and equally Needs you, the toasts and the status line
(`scoped`: a pane set to one session is not interrupted by the others' asks); `autoOpen` never = no open at start (`always` is not offered: the engine seats an
unasked pane only from ~144 columns); `doneShown` / `agentsShown` / `successFoldHours` replace the
old constants; `clock` (`formatClock` / `formatTime`: 24h default, 12h, or the locale's via Intl);
`reportingEffort` picks the rule's bullets (`ruleKeys(eff, effort)`: `rule.milestones`, or
`rule.nowOnly` for minimal) and the subagent rule (`prompt.subagent*`); `pipelineRefreshSec` the
poll timer; `updateCheck` the release lookup (the env var still wins); `palette` passes every
drawn colour through `tint` (Okabe–Ito blue for success and vermillion `#D55E00` for failure when
colour-blind safe — its orange sat too close to the yellow of what is running — or none).

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
an agent finished in minutes. Both ends: the rule, the subagent note and the
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
known forge of another kind), `yes`, `nopipeline` — a PUSH's watch reached the 10-minute "no
pipeline yet" hint AND the forge, asked once (`projectRuns`: `pipelines?per_page=1`,
`actions/runs?per_page=1`), lists no pipeline for the whole project (`markNoPipeline`, every `yes`
entry on that host + project). One commit without a pipeline proves nothing — CI on `main` only, a
path filter, `[skip ci]` — and a `watch` the agent sent (a wrong sha) never decides it; a custom
command's CI cannot be asked, so it is never marked.
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
`watch` dropped — each with a one-line note in the answer). What the agent hears is the NET change since it was last told (0.23.0, `netChange`):
presses between two hand-overs coalesce — a switch toggled back says nothing, one that really
changed one line (`changeNote`), reporting off one line, reporting back on the whole rule once
(it already says what else is on) — handed over with the next prompt or main-loop tool call. The pane: a "Switches:" row right under the header — drawn only while a switch is off, or
reporting is one press from it (a dormant session has reporting off, so it can still switch itself
on there); with everything on it said nothing and took the pane's second line, and a switch is
turned off in Settings (the same two presses for reporting) or with `/progress`. They read as switches, not filters (people pressed the
old "This session: ● tasks" row as a list filter): each names its state ("● tasks on" / "○ tasks
OFF", OFF in yellow, bold), a hover explains what turning it changes, and turning REPORTING off —
it silences the whole session — asks a second press within 5 s (the pipeline ✕'s `armed` pattern);
whole switches wrap, the label goes where the pane is too narrow. Every session's group reads its
file's switches over this pane's defaults — its header says "· paused: reporting" or "· off: tasks,
agents", dims a paused one, tasks off hides its tasks, agents off its Agents section. With `autoStart` off a session does not open the pane by itself. Commands:
`/progress on|off` (also enable/disable, resume/pause), `/progress <feature> on|off`,
`/progress status`.

**A `/clear` starts the next entry over.** `/clear` ends the session (`session.end`, reason
`clear`) but the process — and this module's memory — goes on under a new session id, and no
`session.start` fires for it. What the module remembered of the ended session used to follow it:
the new entry took the old `/rename` title and behaved under the old switches while its file said
defaults, and notes owed to the old conversation reached the new one. On `session.end` with reason
`clear` or `resume` the module now forgets everything that belonged to that session
(`forgetSessionMemory`: switches, title, owed notes, what was told, its subagents' bookkeeping, a
rule that only rode a prompt — the next prompt carries it again); what belongs to the process stays.
The classic SessionStart that follows (source `clear` / `resume`) reads the switches of the session
the process now runs from its own file, if it has one (`adoptSession`): a session resumed in place
gets its own switches back, a cleared one starts from the defaults.

## `/progress doctor` (0.23.0)

`/progress doctor` (the `progress` command's argument, case and spaces ignored) answers one line per
check, ✓ / ✗ / –, each ✗ with its fix beneath (`hooks/doctor.ts`: the classifiers + the format,
pure; the checks in session.tsx): the version (`ownManifest`); the reporting rule (`ruleComposed` /
`ruleSent` / not yet); the progress folder (resolved, then a probe file written and deleted); the
repo's CI (`repoCi`, the one detection the auto-watch uses); the forge CLI — ONE API call for this
repo's project through the person's own `glab` / `gh` / `tea` (`projects/<path>`, `repos/<path>`),
its failure classified (`classifyCliError`): not installed, not logged in for the host, or logged in
but unable to read the project (403/404 — a token scoped to other projects, the 2026-11-09 case);
and `git ls-remote --exit-code origin HEAD`, its whole stderr classified (`classifyGitError`: an
untrusted SSH host key, missing credentials). Read-only apart from the probe; a custom CI command is
not run.

## What an agent runs on: model and effort (0.24.0)

An agent's row starts its right side with the model and effort it actually runs on —
`sonnet 5.5 · medium · ██░░ 3/7 · 2m · ~4 min left` — so a glance tells which lanes run on which
model. The source is the engine's own word, not the Agent call's: a `turn.step` hook (one model
request, the main loop's or a subagent's) reads the request's `model` (as the engine resolved it:
the call's, the agent type's, the session's subagent default or the parent's) and `effort`, and
`noteAgentRun` stores them on the agent's entry (`AgentEntry.model` / `.effort`) when they differ
from what it holds. `agentRunNoted` remembers what each agent was given, so a repeated step costs no
file read; an agent with no entry yet is noted at a later step. The event streams, so the hook is a
generator that hands everything beneath it through unchanged (`return yield* next(e)`) — it never
rewrites a request. The main loop's requests are ignored. `modelLabel` shortens an id for the row
(`claude-sonnet-5-5-20261001[1m]` → `sonnet 5.5`; an id of another shape shows as it is); a model
without effort shows the model alone; a numeric budget shows as its number. An agent's report
rebuilds its entry and keeps both fields. With `agents` off nothing is noted.

## A row folds only when it has something inside (0.25.0)

Nothing in the pane shows a fold arrow it cannot honour. A running agent's row is a fold (`▾` / `▸`)
only when `agentHasInside` says there is something to show beneath it: a waiting line, what it said
it is doing (`now`), its latest tool call, messages queued for it, or steps. Otherwise it is a plain
line, `• <label>`, with its model, run time and ✕ as before. Tasks already follow the rule (a task
without steps or a detail is a plain row), as do finished agents without steps.

So that a row seldom stays bare, an agent that reports no steps of its own still gets a second
level: the plugin sees every tool call a subagent makes (`PostToolUse` with its `agent_id`) and
`noteAgentActivity` keeps the latest one on the agent's entry as one line
(`AgentEntry.activity`, from `toolCallSummary`: `Read — src/x.rs`) with a running count
(`AgentEntry.calls`), shown as `↳ Read — src/x.rs · 41 tool calls`. Every call is counted in memory
(`agentCalls`); the entry is written at most every `ACTIVITY_EVERY_MS` (3 s) per agent, so a busy
lane costs one small write a few seconds apart. The agent's own `progress_update` calls are not
activity. An agent type whose tool list leaves out the progress tool (a read-only reviewer, say)
cannot report steps at all: this line is what its row shows — give such a type the tool
(`mcp__progress-panel__progress_update` in its `tools:`) to get real steps.

## Out of scope / later

- Other machines: the store is local. Mirroring to a shared place stays the agent's job.
- v0.1's single `progress.json` is not read any more (breaking; noted in the README).

## Agents: their steps, and finished ones under Done (0.19.0)

User, 2026-11-08: "I don't know what it's doing and how it's progressing, nor how long each step is
expected to last" and "a separate section for the finished agents … under the Done". A running agent
is a fold (default open) showing its `now` and each of its steps with status and note — the reporting
rule asks subagents to put each open step's own estimate in its `note` — beside `n/m`, its run time
(`startedAt` → now) and `~N min left`. The **Agents** section lists only running agents; a finished one
moves under the session's **Done** into a folded **Agents** heading (Done's count includes them).

**Finished agents are cleared like done tasks.** They had no ✕, *Clear all* passed tasks only (and
was not even shown while only agents were done), and auto-clear ignored them: a session's file grew
all day — rewritten whole every few seconds per active agent and re-parsed by every pane. Now each
finished agent's row has a ✕, *Clear all* (shown whenever Done is open) clears the done tasks and
the finished agents, and `autoClearDoneHours` covers agents by their `endedAt` (`pruneDone`). A ✕
is a sidecar entry `{ "id": "agent:<agent id>", "doneAt": <its endedAt> }` (`agentDismissal`): like
a task's it names that ending, so every pane hides the row at once (`visibleAgents`), the owner
drops it from its file on its next scan (`mergeSidecar`), an ended session's is simply hidden, and
an agent that is resumed and ends again shows again. (A running agent's ✕ stays the removal
`agentall:<id>` in `cancelled`: it stops work, it does not clear a row.)

## Long lines (0.23.0)

Every row with something on its right (task, step, agent, agent step, pipeline, job, Done item,
session header, the pane's own header) keeps that right part — bar, n/m, time, eta, ✕, ↗ — in a
column that never shrinks (`flexShrink: 0`), and cuts its text with "…" (`wrap="truncate-end"`)
at the room left; the engine measures display width and lays it out again on every resize. Nothing
is lost: a task whose title would be cut folds, and unfolded shows the whole title wrapped beneath;
an agent's cut label shows whole when open; a Now line or Needs-you item too long for the pane
folds open to its whole text. `displayWidth` (wide CJK / emoji 2 cells, marks and joiners 0)
decides whether a text would be cut. Notes, details and reasons beneath a row wrap, never cut.
