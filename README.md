# Claude Code progress panel

A pane beside every Claude Code chat on your machine that shows what **every session** is doing —
the newest update, what **needs you** (from any session, highlighted), one **now** line per
session, and each session's tasks grouped and foldable, with a Done list you can clear.

![The Progress pane: needs you, now, live pipelines and every session's tasks — grouped by repo, in plan order](docs/screenshots/pane.png)

It is a Claude Code plugin: a hooks module that draws the pane and gives the agent a
`progress_update` tool, plus a skill that teaches the agent when to call it. Your sessions' status
never leaves your machine: they share a local folder. The plugin's only network call of its own is
the update check (below); pipelines are read by your own `glab` / `gh` / `tea` / command.

> **A personal tool, shared as is.** I built it for how I work — several sessions at once, in a
> wide terminal, waiting on CI — and publish it in case it helps someone else. Best effort: issues
> and merge requests are welcome on
> [GitLab](https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel/-/issues), but there are
> no promises of support or of keeping up with every Claude Code change. Worth knowing before you
> install: it asks every session to keep its entry current, which costs a few tokens and a tool
> call every few steps; it needs a recent Claude Code; and the pane wants a wide terminal.

## Install

Needs Claude Code **2.1.318 or newer**.

In a terminal (any directory):

```sh
claude plugin marketplace add https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel.git
claude plugin install progress-panel@claude-progress-panel --scope user
```

(The [GitHub mirror](https://github.com/Kirbo/claude-progress-panel) works too:
`claude plugin marketplace add Kirbo/claude-progress-panel`. GitLab is where it is developed and
where the release notes live.)

Or inside a Claude Code session:

```
/plugin install progress-panel --marketplace https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel.git
```

answer `y` to add the marketplace and pick the **user** scope. New sessions load it from then on.

**Update:** `claude plugin update progress-panel@claude-progress-panel`, then `/reload-plugins` in
a running session. **Remove:** `claude plugin uninstall progress-panel@claude-progress-panel`.

## Use

- The pane opens by itself when a session starts in a terminal at least ~144 columns wide; on a
  narrower one (or after closing it) type **`/progress`**. In a fullscreen terminal from 110 columns
  it docks beside the chat as a sidebar — drag its edge (or resize it with the keyboard) and Claude
  Code keeps that width; on a narrower one it sits full width above the prompt, its height likewise
  draggable. Its starting size comes from the settings below.
- **Every session reports on its own.** The plugin adds a short rule to each session's system
  prompt (a session already running when you install or reload the plugin gets it with its next
  prompt, plus a one-line reminder until it first reports): on any task with more than one step the agent's first call sets `now` and the task
  list, **in the order it will do them**; it moves each task as it goes, gives a task its
  subtasks (`steps`) and a longer `detail` when it has parts, tags tasks with their `repo` when it
  works in several, puts every decision only you can make in **Needs you**, and watches every push
  to a repo with CI. Nothing to add to your `CLAUDE.md`; the bundled `progress-panel` skill has the
  details.
- **One session open: no names, no "here".** While a session is the only open one, nothing spells
  out its name — not Needs you, Now, its header ("This session"), the top line or the status line.
  An ask's "— reply … here" is worded by each pane: "here" shows only in the pane of the session
  that asks, and only while another session is open.
- **Claude Code's own waits are Needs you too:** a session stopped on a permission prompt, or one
  whose turn finished and waits for your next message ("Turn finished — waiting for your next
  message": a state, nothing to answer), shows it under **Needs you**, toasted to the other sessions, until the wait
  ends — the tool ran or was denied, the turn ended, or you answered. The agent's own asks are never
  touched. Settings `autoNeedsPermission` / `autoNeedsIdle` (both on).
- **No "needs your attention" without what, where and how.** A permission prompt says which tool
  and input ("Permission: Bash — git push origin next (agent: Lane Q)"), taken from the call
  waiting on it when Claude Code's own notice is only "Claude needs your permission"; when even that
  cannot be told it says where to look ("Permission prompt in session app — open that terminal to
  see and answer it"). The agent writes its asks the same way, and links each to its task or
  subagent; **the task, agent or step a wait or an ask belongs to shows the same magenta ⚠ with the
  reason beneath it**, so the tree shows what needs you and why. The status line names the ask
  itself, not only a count.
- **Sessions** are named as Claude Code names them: a `/rename` shows from your next prompt on
  (else the repo or folder name).
- **What each mark means:** ○ to do, ● in progress, ⚠ blocked (magenta), ✓ done, – skipped
  (dim — it will not be done), ✗ failed (red — tried and could not be done). A blocked, skipped or
  failed task or step shows its reason on the line beneath it. When a subagent stops for good, a step
  it left in progress turns – "agent stopped before finishing", so a finished agent never looks busy;
  a finished agent under Done → Agents folds open to its steps.
- **Tasks:** listed in plan order by default — the order the agent will do them (it reshuffles
  with `order`). A task with subtasks or a detail is a fold: its title shows `██░░ n/m` of its steps
  done, and a press opens the detail and each step — a task in progress with steps starts open, so
  you see what it is on without a click (fold it and it stays folded). Once a session's open work spans several repos
  it groups under one foldable heading per repo — each repo's tasks, then the **Agents** working on
  that repo (an agent's repo: the task linked to it, else the repo its commands run in — a worktree
  counts as its repo — else "other"); one repo: no heading, tasks then Agents. Its Done list groups
  the same way on its own.
- **Subagents report too:** a subagent's `progress_update` lands under its coordinator's session,
  in an **Agents** part — never among the session's tasks. Each running agent shows the model and
  effort it actually runs on (`sonnet 5.5 · medium`, read from its own model requests), its latest
  tool call when it reports no steps of its own (`↳ Read — src/x.rs · 41 tool calls`), its steps
  (`██░░ 3/7`), how long it has run and `~N min left` — the pace it has measured once a step has
  finished (the median time per finished step × the steps left), the agent's own guess before that,
  marked `(est.)` — and unfolds to what it is on and every step
  with its status and note (a step's own estimate, e.g. `~10 min`). A finished agent moves under the
  session's **Done**, in its own folded **Agents** heading, and stays — nothing is cleaned up
  automatically. An open Done lists the newest 10 finished tasks (and 5 finished agents); older
  ones fold behind **N older**, so a long day's history never pushes the live work out of view. A subagent that cannot report (one without the tool, such as a read-only
  reviewer) still shows there by its task description while it runs. The coordinator sees its
  running subagents in every `progress_update` answer.
- **A task handed to a subagent** carries its `agent`: the pane shows that agent's live progress
  under the task (`● <agent> 3/7 · ~4 min left`). When the agent finishes, its coordinator is told
  once to verify the result and update the task — the plugin never marks it done for it. An Agent
  call whose description names exactly one task in progress links it on its own. An agent that
  reports while linked to no task shows as a stand-in task `↳ <agent>` for as long as it runs; the
  stand-in goes when the agent ends (or the coordinator links a task of its own).
- **Remove a task** with the `✕` on its row: every pane hides it at once, its session marks it
  skipped ("removed in the Progress pane") and tells its agent right after its next step — "do not
  do it; stop if you are on it". Works for any live session's tasks, not only this one's — and at
  every level: a task's **step** (skipped, counted out of its n/m, the agent told), a
  **subagent's step** (that subagent is told at its next tool call, not the main loop) and a whole
  **running subagent** (it is told to stop and wrap up; Claude Code offers no way to stop one from
  outside). A later report never brings a removed item back: the agent re-adds it only as a new task
  (a new title or id). **Across a task's link to its agent:** removing a session task stops the
  agent working on it too (it is told to wrap up; the coordinator is told so); stopping an agent —
  or removing its last open step — leaves its linked task open but unassigned (shown "stopped",
  the coordinator told to re-plan or skip it); one of an agent's steps is the agent's business only
  (the session task's status stays the coordinator's).
- **Sort** cycles plan → status → title → created → done (remembered). **Filter tasks** beside it
  keeps only the tasks whose title, note, detail or steps hold what you type, the matching text
  highlighted (a task whose hit is in its detail or steps unfolds by itself); sessions without a
  match step aside.
- Every `▾`/`▸` line folds. **✕** removes a done task (or an ended session, or a subagent that is no
  longer working); **Clear all** (shown while its Done list is open) empties the list. Ask the
  agent to clear the pane and it does the same for its finished tasks and subagent rows.
- **Version and updates:** the pane's top-right corner shows the version it runs; when a newer
  release exists it adds `vX.Y.Z available ↗`, linking that release's notes. The newest release is
  looked up from this repository's GitLab Releases at most every 6 h, shared by every session on
  the machine; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns the check off.
- **Closed the pane?** `/progress` in any session opens it again.
- **Something not working?** `/progress doctor` checks this session's setup, one line per check
  with its fix: the plugin version, whether this session got the reporting rule, the progress
  folder, the repo's CI, the forge CLI for it (installed, logged in for the host, able to read
  this project — one API call through your own `glab` / `gh` / `tea`) and whether git reaches the
  remote (an untrusted SSH host key, missing credentials). Read-only.
- **In the transcript** a `progress_update` call is one quiet line (`◦ Progress · <now> · 2 tasks`);
  ctrl+o shows it in full.

### Pipelines

**A running pipeline's row has two buttons, kept apart:** **✕ only hides the row** (this session's
own pipeline stops being watched; another session's is hidden in the panes) — it never touches the
CI, exactly like ✕ on a finished row. The red **⊘ stop** cancels it — and, by default, deletes it
from the CI — through your own `glab` / `gh` (GitLab: the pipeline's cancel, then delete — deleting
needs the Maintainer or Owner role, so a refused delete leaves it cancelled and says so on its row;
GitHub: the run's cancel, then delete). Its first press only asks ("⊘ cancel + delete?"); a second
press within 5 s does it, then the row goes. The setting **Pipeline ⊘ stop button**
(`runningPipelineX`) = `cancel` only cancels, `off` hides the ⊘ button (✕ stays). Gitea / Forgejo
and a custom CI command offer no ⊘ while running (no cancel or delete verbs the plugin can rely on
there).

**Every `git push` the agent runs is watched automatically** — no tool call: when the push lands,
the plugin reads the repo's CI off its files (`.gitlab-ci.yml` → GitLab, `.github/workflows/` →
GitHub Actions, `.gitea/` or `.forgejo/workflows/` → Gitea/Forgejo, else your **Custom CI command**),
the forge's host and project off the pushed remote (ssh or https, self-hosted included) and the
pushed commit's sha, and watches that run. A push that fails, is rejected, is a dry run or deletes a
branch watches nothing; a repo without CI neither, nor a push to a mirror on another kind of forge
(a GitLab-CI repo pushed to its GitHub mirror), nor one with the `ci.skip` push option. It reads
the push the way an agent writes it: `cd`/`pushd` (Windows' `cd /d` and drive paths too), `git -C`
and `git.exe`, redirects (`git push 2>&1`, `> push.log`), `&&` chains, subshells
(`(cd x && git push)`), env prefixes and `timeout 120 git push`; a push through a git alias or a
wrapper script it cannot see — there the agent's own `watch` (the rule) still covers it. **Each
pushed ref is its own row**: the same commit pushed to `next` and then to `main`, or tagged, shows
the pipeline of each. **Repos without CI are remembered**, for
every session on the machine (`ci-memory.v1` in the progress folder): no CI files, a mirror on
another forge, or a pushed commit that got no pipeline within 10 minutes on a project the forge
lists no pipeline at all for (CI off there; one commit without a pipeline in a repo that runs CI
decides nothing) — their later pushes are skipped without any lookup, and the agent is told once per session not to
watch them. A CI file appearing or disappearing, 7 days passing, `/progress pipelines recheck` or
`/progress doctor` judges the repo again. The agent still `watch`es a CI run by id, or by
commit sha (whole or abbreviated) before the run exists — another repo's, or a push made outside the
session — and the pane follows it
live: state, a progress bar of finished / all jobs while it runs, how long it has run (beside an
estimate from up to 5 earlier successful runs of the same branch and trigger, GitLab and GitHub),
and once finished the counts, the duration and the time it finished — all on the right of the
row, beside `↗` (open it in the browser) and `✕` (dismiss a finished one). A running pipeline
stands out — a yellow `●` (cyan `○` while queued), its name and state in bold, the section's
"N watching" lit — while a finished one dims to its outcome's colour. A press unfolds every
job, grouped by stage. The row under the pointer is highlighted. The section header sums up
every pipeline and folds itself once all succeeded; successes older than an hour move into a
folded "Finished" row.

| CI | `watch` | Needs, on PATH and logged in |
| --- | --- | --- |
| GitLab (gitlab.com or self-hosted) | `{ project: "group/name", pipeline \| sha }` | [`glab`](https://gitlab.com/gitlab-org/cli) |
| GitHub Actions (github.com or Enterprise) | `{ provider: "github", project: "owner/repo", run \| sha }` | [`gh`](https://cli.github.com) |
| Gitea / Forgejo Actions | `{ provider: "gitea", project: "owner/repo", run \| sha }` | [`tea`](https://gitea.com/gitea/tea), a login for that host |
| Anything else (Jenkins, Bitbucket, Azure DevOps, Woodpecker…) | `{ provider: "command", project: "<a name your command knows>", pipeline \| sha }` | your own command, set as **Custom CI command** |

- **Private repos work**: the plugin makes no API calls of its own; it runs your own `glab` / `gh`
  / `tea` with your login, so it sees what you can see.
- **Which host:** a watch of the session's own repo takes the host of its `origin` remote; any
  other gives `host` (e.g. `"git.example.com"`), else the forge's public one. Every call names its
  host, so it works the same from any directory.
- **A watch by commit follows every run of that commit** as one row — each GitHub workflow, a
  GitLab branch and merge-request pipeline: unfinished while any of them is, and green only when
  all are (else the worst outcome, with the jobs of every run under its workflow's name). Add
  `ref: "<branch or tag>"` to follow only that ref's pipelines when the same commit is on several.
- **Who polls:** the session that watches a run polls it every 15 s (the **Pipeline refresh**
  setting, `pipelineRefreshSec`) until it finishes (no forge can push to a local plugin). If that
  session ends or dies first, one open pane on the machine takes over after a minute.
- **Polling is bounded:** a CLI that fails (not installed, logged out) is asked less and less —
  30 s, 1 min, 2 min … 10 min — and after 8 failures in a row the watch stops; a pipeline waiting
  on a manual job or an approval, and a commit that has no pipeline after 10 minutes, are asked
  every 5 minutes; a commit without a pipeline is given up after an hour, any watch still
  unfinished after a day too. A stopped watch says "stopped watching — <why>" on its row; watching
  it again starts it over.
- **What a watch may name:** a `sha` is 7 to 64 hex digits and a `host` a plain host name
  (`git.example.com`, an optional `:port`); anything else is refused. Job names and links that
  come from a forge are shown cleaned (one line, no control characters) and only http(s)
  addresses become links.
- **Custom CI command:** the setting is a command line with placeholders `{project}`, `{id}`,
  `{sha}`, `{host}` (each filled inside its own argument; no shell; `~/` = your home), e.g.
  `~/bin/ci-status {project} {id}`. It must print the run as JSON — or nothing / `{}` while the run
  does not exist yet:

  ```json
  {
    "id": 12,
    "state": "running",
    "url": "https://ci.example.com/job/nightly/12",
    "ref": "main",
    "startedAt": "2026-11-07T10:00:00Z",
    "finishedAt": null,
    "durationS": null,
    "jobs": [{ "name": "build", "stage": "build", "state": "success", "durationS": 30, "url": "…" }]
  }
  ```

  States: `queued`, `running`, `success`, `failed`, `canceled`, `skipped`, `manual`. Only the
  setting chooses the command — an agent can never make the plugin run one.
- Pipelines need Claude Code's CLI host (the terminal, or an IDE extension running it): they
  refresh through `glab` / `gh` / `tea` / your command, which a surface without a local CLI (e.g.
  the mobile app) cannot run. The rest of the pane works everywhere.

### Tasks never stay in a state that is no longer true

- **A pushed task closes with its pipeline.** A `git push` links its pipeline to your one `doing`
  task of that repo (none or several: no link — never a guess); the task shows the pipeline's state
  and becomes **done** when it goes green, **failed** (naming the failing job) when it goes red. The
  agent is told; a status it set after the pipeline finished wins. Link one by hand with the task's
  `pipeline` field.
- **The end of a turn checks.** A `doing` task not touched during the turn (and for 10 min), with no
  running pipeline or agent behind it, stops the turn once with the list, so the agent updates each
  to its true state. The same list never stops a turn twice — the next stop passes and those tasks
  are marked **unconfirmed** in the pane until their next update.
- **Staleness nudge.** An open task untouched for 20 min is asked about once with your next prompt
  ("has been blocked for 40 min with no update — is that still true?"), never again in that state.

### Settings

**⚙ Settings** in the pane's top-right corner (or `/progress settings`) opens them inside the pane
— no commands needed; **← Back** returns:

- **This session** — the four switches (reporting, tasks, agents, pipelines), each showing on/off
  and whether that is the default or this session's own choice; press to change, **reset to
  default** to drop the session's own choice.
- **Defaults for new sessions** — every option below, grouped under Reporting, Pipelines,
  Notifications, Pane and Storage & updates: press a row to step through its values; a text field
  (progress folder, custom CI command) takes what you type on Enter.

Each row's value sits in the right column (a long label is cut with "…", never the value) and is
coloured — on green, off yellow, a choice cyan, an empty one dim — and **bold when it differs from
its default**, so what you changed stands out; an unchanged one says "(default)".

They write the plugin's own settings — the same ones `/plugin configure
progress-panel@claude-progress-panel` (or `/config`, or `--config KEY=VALUE` at install) changes, so
there is one place they live. What applies: a session's own switch, else the setting, else the
built-in default below.

| Option                  | Values                                  | Default                |
| ----------------------- | --------------------------------------- | ---------------------- |
| `progressDir`           | a folder (`~/` allowed)                  | `~/.claude/progress`   |
| `autoClearDoneHours`    | 0 (never), 1, 3, 6, 12, 24, 48, 72, 168 | 0                      |
| `keepEndedSessionsDays` | 0 (never), 1, 3, 7, 14, 30              | 7                      |
| `sortTasksBy`           | plan, status, title, created, done      | plan                   |
| `ciCommand`             | a command line (see Pipelines)          | (off)                  |
| `paneColumns`           | sidebar width: 0 (Claude Code's), 48–110 | 84                     |
| `paneRows`              | height above the prompt: 0 (a third), 12–40 | 20                 |
| `autoStart`             | on, off (dormant until switched on)     | on                     |
| `tasksDefault`          | on, off                                 | on                     |
| `agentsDefault`         | on, off                                 | on                     |
| `pipelinesDefault`      | on, off                                 | on                     |
| `autoNeedsPermission`   | on, off                                 | on                     |
| `autoNeedsIdle`         | on, off                                 | on                     |
| `toastNeedsYou`         | on, off                                 | on                     |
| `bell`                  | on, off (also notify via the terminal)  | off                    |
| `pipelineNotify`        | never, failures, always                 | failures               |
| `paneScope`             | all, repo, session                      | all                    |
| `autoOpen`              | auto, never                             | auto                   |
| `doneShown`             | 5, 10, 20, 50                           | 10                     |
| `agentsShown`           | 3, 5, 10, 20                            | 5                      |
| `successFoldHours`      | 0.5, 1, 3, 12, 24                       | 1                      |
| `clock`                 | 24h, 12h, system                        | 24h                    |
| `reportingEffort`       | detailed, milestones, minimal           | detailed               |
| `pipelineRefreshSec`    | 10, 15, 30, 60                          | 15                     |
| `updateCheck`           | on, off                                 | on                     |
| `palette`               | default, colorblind, none               | default                |
| `runningPipelineX` (⊘ stop button) | delete, cancel, off                | delete                 |

`autoOpen` has no "always": Claude Code itself places a pane the plugin opens unasked only from
~144 columns, and a plugin cannot force it narrower.

Change them with `/plugin configure progress-panel@claude-progress-panel` (or
`claude plugin configure …`, or `--config KEY=VALUE` at install).

**Per session**, four switches override those defaults for the rest of that session — kept in its
own file, so a `/reload-plugins` or a resume keeps them; a new session starts from the defaults:

- **reporting** — the master switch: off = no reporting rule, no reminders, no automatic watches,
  and `progress_update` writes nothing; the entry stays, shown *paused* in every pane.
- **tasks** — off = the session reports only `now` and *Needs you*; its task list is hidden.
- **agents** — off = subagents are not asked to report, their reports are ignored and the
  session's Agents section is hidden.
- **pipelines** — off = no automatic watches, and the agent's `watch` is ignored.

Switch them with the pane's **Switches:** row under its header (`● tasks on` / `○ tasks OFF` — press
one; turning reporting off asks for a second press, since it silences the whole session; a session
with something off says so in its header in every pane), or
`/progress on` / `/progress off` (reporting), `/progress <reporting|tasks|agents|pipelines> on|off`,
and see them with `/progress status`. The agent hears the net change at its next step, however many
presses lay between: one line per switch that really changed (none for one toggled back), and the
reporting rule at most once, when reporting comes back on. With `autoStart` off a new session
stays dormant (the pane does not open by itself) until switched on.

The environment variable `PROGRESS_PANEL_DIR` overrides `progressDir` for one session (a demo
or test folder) without moving everyone else's.

### How it works

- Each session writes only its own file, `<progressDir>/<session-id>.json`, through the
  `progress_update` tool, one write at a time — nobody else writes it, so sessions never
  overwrite each other. Your ✕ / Clear all, and pipeline refreshes a pane made for a session that
  stopped polling, go to a separate `<session-id>.dismissed.json`, which the session folds in on
  its next update. A file caught half-written is ignored until the next refresh. The tool takes a
  patch (`now`, `needsYou`, `tasks` upserted by id or title — with `note`, `detail`, `steps`,
  `repo` — `remove`, `order`, `watch`, `unwatch`, `clearAgents` / `dismissAgents`); the plugin
  stamps the times. Format:
  [`docs/design/MULTI-SESSION.md`](docs/design/MULTI-SESSION.md).
- Every pane lists the folder every 2 seconds and reads a file only when it changed (plugins have
  no file-watch API). A session's own update shows at once.
- The header carries two times: **updated** — the newest status change of any session — and
  **checked** — when this pane last looked. A check older than 10 s turns yellow with "(stale)".
- A session marks its entry ended when it closes; ended entries are dimmed and folded, and are
  removed after `keepEndedSessionsDays`. A session that never reported anything leaves nothing.
  One that died without closing (a terminal closed, a process killed) is noticed by any pane on the
  same machine once it has been quiet for 10 minutes and its process is gone, and ends as of its
  last update; `/progress doctor` says whether this session's process could be recorded.

### Releases

Every version has a [GitLab Release](https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel/-/releases)
with what changed in it.

## Develop

Toolchain via [mise](https://mise.jdx.dev) (`mise.toml` pins Biome and Claude Code; `mise.lock`
is committed):

```sh
mise install
mise exec -- biome check .                 # lint + format check (biome check --write . to fix)
mise exec npm:typescript@7.0.2 -- tsc --noEmit -p .             # type-check (local only: needs the types Claude Code writes on load)
mise exec -- claude plugin test .          # hooks/*.test.tsx against the engine
mise exec -- claude plugin validate .      # manifest + module, as the engine reads them
mise exec -- node --test scripts/          # sealing + audit-register guard tests
mise exec -- node scripts/check-audits.mjs # audit-register guard (also run by CI)
claude --plugin-dir .                      # a session with this working copy loaded
git config core.hooksPath .githooks        # once per clone: pre-commit runs Biome (fix + re-stage) and seals audit findings
```

Test-first: a change lands with its test (`hooks/*.test.ts` for the pure logic,
`hooks/register.test.tsx` for the plugin against the engine), and type-checks
(`mise exec npm:typescript@7.0.2 -- tsc --noEmit -p .`, locally). Every user-facing string
lives in `locales/en.ts` and goes through `t()` (`hooks/i18n.ts`). CI (`.gitlab-ci.yml`) runs the
checks above on every push, and on `main` gives each new `version` in `.claude-plugin/plugin.json`
its GitLab Release, notes by [git-cliff](https://git-cliff.org) from the commit subjects
(`scripts/release.mjs`, `cliff.toml`). Security findings that are not fixed yet are never published: they are
age-sealed in `docs/audits/` (process: [`docs/audits/README.md`](docs/audits/README.md); `/audit`
and `/maintain` are project skills in `.claude/skills/`).

## License

[MIT](LICENSE)
