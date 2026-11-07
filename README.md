# Claude Code progress panel

A pane beside every Claude Code chat on your machine that shows what **every session** is doing —
the newest update, what **needs you** (from any session, highlighted), one **now** line per
session, and each session's tasks grouped and foldable, with a Done list you can clear.

![The Progress pane: needs you, now, live pipelines and every session's tasks — grouped by repo, in plan order](docs/screenshots/pane.png)

It is a Claude Code plugin: a hooks module that draws the pane and gives the agent a
`progress_update` tool, plus a skill that teaches the agent when to call it. Nothing leaves your
machine: sessions share a local folder.

## Install

Needs Claude Code **2.1.318 or newer**.

In a terminal (any directory):

```sh
claude plugin marketplace add https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel.git
claude plugin install progress-panel@claude-progress-panel --scope user
```

Or inside a Claude Code session:

```
/plugin install progress-panel --marketplace https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel.git
```

answer `y` to add the marketplace and pick the **user** scope. New sessions load it from then on.

**Update:** `claude plugin update progress-panel@claude-progress-panel`, then `/reload-plugins` in
a running session. **Remove:** `claude plugin uninstall progress-panel@claude-progress-panel`.

## Use

- The pane opens by itself when a session starts in a terminal at least ~144 columns wide; on a
  narrower one (or after closing it) type **`/progress`**.
- **Every session reports on its own.** The plugin adds a short rule to each session's system
  prompt: on any task with more than one step the agent's first call sets `now` and the task
  list, **in the order it will do them**; it moves each task as it goes, gives a task its
  subtasks (`steps`) and a longer `detail` when it has parts, tags tasks with their `repo` when it
  works in several, puts every decision only you can make in **Needs you**, and watches every push
  to a repo with CI. Nothing to add to your `CLAUDE.md`; the bundled `progress-panel` skill has the
  details.
- **Sessions** are named as Claude Code names them: a `/rename` shows from your next prompt on
  (else the repo or folder name).
- **Tasks:** listed in plan order by default — the order the agent will do them (it reshuffles
  with `order`). A task with subtasks or a detail is a fold: its title shows `██░░ n/m` of its steps
  done, and a press opens the detail and each step. A session whose tasks span several repos
  groups them under one foldable heading per repo.
- **Sort** cycles plan → status → title → created → done (remembered). **Filter tasks** beside it
  keeps only the tasks whose title, note, detail or steps hold what you type; sessions without a
  match step aside.
- Every `▾`/`▸` line folds. **✕** removes a done task (or an ended session); **Clear all** (shown
  while its Done list is open) empties the list.
- **In the transcript** a `progress_update` call is one quiet line (`◦ Progress · <now> · 2 tasks`);
  ctrl+o shows it in full.

### Pipelines

The agent `watch`es a CI run by id, or by commit sha before the run exists, and the pane follows it
live: state, a progress bar of finished / all jobs while it runs, how long it has run (beside an
estimate from up to 5 earlier successful runs of the same branch and trigger, GitLab and GitHub),
and once finished the counts, the duration and the time it finished — all on the right of the
row, beside `↗` (open it in the browser) and `✕` (dismiss a finished one). A press unfolds every
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
- **Who polls:** the session that watches a run polls it every 15 s until it finishes (no forge
  can push to a local plugin). If that session ends or dies first, any open pane takes over after
  a minute.
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

### Settings

`/config` (or `claude plugin configure progress-panel`):

| Option                  | Values                                  | Default                |
| ----------------------- | --------------------------------------- | ---------------------- |
| `progressDir`           | a folder (`~/` allowed)                  | `~/.claude/progress`   |
| `autoClearDoneHours`    | 0 (never), 1, 3, 6, 12, 24, 48, 72, 168 | 0                      |
| `keepEndedSessionsDays` | 0 (never), 1, 3, 7, 14, 30              | 7                      |
| `sortTasksBy`           | plan, status, title, created, done      | plan                   |
| `ciCommand`             | a command line (see Pipelines)          | (off)                  |

The environment variable `PROGRESS_PANEL_DIR` overrides `progressDir` for one session (a demo
or test folder) without moving everyone else's.

### How it works

- Each session writes only its own file, `<progressDir>/<session-id>.json`, through the
  `progress_update` tool, one write at a time — nobody else writes it, so sessions never
  overwrite each other. Your ✕ / Clear all, and pipeline refreshes a pane made for a session that
  stopped polling, go to a separate `<session-id>.dismissed.json`, which the session folds in on
  its next update. A file caught half-written is ignored until the next refresh. The tool takes a
  patch (`now`, `needsYou`, `tasks` upserted by id or title — with `note`, `detail`, `steps`,
  `repo` — `remove`, `order`, `watch`, `unwatch`); the plugin stamps the times. Format:
  [`docs/design/MULTI-SESSION.md`](docs/design/MULTI-SESSION.md).
- Every pane lists the folder every 2 seconds and reads a file only when it changed (plugins have
  no file-watch API). A session's own update shows at once.
- The header carries two times: **updated** — the newest status change of any session — and
  **checked** — when this pane last looked. A check older than 10 s turns yellow with "(stale)".
- A session marks its entry ended when it closes; ended entries are dimmed and folded, and are
  removed after `keepEndedSessionsDays`. A session that never reported anything leaves nothing.

### Releases

Every version has a [GitLab Release](https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel/-/releases)
with what changed in it.

## Develop

Toolchain via [mise](https://mise.jdx.dev) (`mise.toml` pins Biome and Claude Code; `mise.lock`
is committed):

```sh
mise install
mise exec -- biome check .                 # lint + format check (biome check --write . to fix)
mise exec -- claude plugin test .          # hooks/*.test.tsx against the engine
mise exec -- claude plugin validate .      # manifest + module, as the engine reads them
mise exec -- node --test scripts/          # sealing + audit-register guard tests
mise exec -- node scripts/check-audits.mjs # audit-register guard (also run by CI)
claude --plugin-dir .                      # a session with this working copy loaded
git config core.hooksPath .githooks        # once per clone: pre-commit runs Biome (fix + re-stage) and seals audit findings
```

Test-first: a change lands with its test (`hooks/*.test.ts` for the pure logic,
`hooks/register.test.tsx` for the plugin against the engine). Every user-facing string
lives in `locales/en.ts` and goes through `t()` (`hooks/i18n.ts`). CI (`.gitlab-ci.yml`) runs the
checks above on every push, and on `main` gives each new `version` in `.claude-plugin/plugin.json`
its GitLab Release, notes by [git-cliff](https://git-cliff.org) from the commit subjects
(`scripts/release.mjs`, `cliff.toml`). Security findings that are not fixed yet are never published: they are
age-sealed in `docs/audits/` (process: [`docs/audits/README.md`](docs/audits/README.md); `/audit`
and `/maintain` are project skills in `.claude/skills/`).

## License

[MIT](LICENSE)
