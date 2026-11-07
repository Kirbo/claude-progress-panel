# Claude Code progress panel

A pane beside every Claude Code chat on your machine that shows what **every session** is doing —
the newest update, what **needs you** (from any session, highlighted), one **now** line per
session, and each session's tasks grouped and foldable, with a Done list you can clear.

```
┌ Progress ──────────────────────────────────────────────────────┐
│ updated 22:05 · api · checked 22:08:14                         │
│                                                                │
│ ⚠ Needs you (1)                                                │
│   • api: Push OK for the release branch                        │
│                                                                │
│ Now                                                            │
│   api · Waiting for CI, then pushing the release branch        │
│   web · Refactoring the settings view                          │
│                                                                │
│ ▾ Pipelines  1 watching · 2 succeeded · 0 failed               │
│   ▾ api #30385 · main · running  ████░░░░ 4/8 · 6m33s / ~9m ↗  │
│       2 running · 1 queued · 1 skipped · 3 passed · 0 failed   │
│       images                                                   │
│         ✓ build-image:linux:amd64    1m18s                  ↗  │
│         ● build-image:windows:arm64  1m10s / ~3m            ↗  │
│       verify                                                   │
│         ○ check                                             ↗  │
│                                                                │
│ Sessions  Sort: status                                         │
│   ▾ api (this session) · 22:05 · 2 open · 3 done               │
│     ✗ macOS build                                              │
│       EPERM on the app icon — runner restarted                 │
│     ● Screenshot refresh                                       │
│     ▾ Done (3)  Clear all                                      │
│       ✓ Prefill images  21:58  ✕                               │
│   ▸ web · 22:01 · 4 open · 0 done                              │
│   ▸ docs · ended 19:40 · 0 open · 6 done  ✕                    │
└────────────────────────────────────────────────────────────────┘
```

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
- Ask the agent to use it: _"keep the progress panel updated while you work"_. The bundled
  `progress-panel` skill tells it how. To make it the default for every task, add a line like this
  to your `~/.claude/CLAUDE.md`:
  `Keep the progress panel (progress-panel skill) current during multi-step work.`
- Every `▾`/`▸` line folds; **Sort** cycles status → title → created → done (remembered); **✕**
  removes a done task (or an ended session), **Clear all** empties a Done list.

### Settings

`/config` (or `claude plugin configure progress-panel`):

| Option                  | Values                                  | Default                |
| ----------------------- | --------------------------------------- | ---------------------- |
| `progressDir`           | a folder (`~/` allowed)                  | `~/.claude/progress`   |
| `autoClearDoneHours`    | 0 (never), 1, 3, 6, 12, 24, 48, 72, 168 | 0                      |
| `keepEndedSessionsDays` | 0 (never), 1, 3, 7, 14, 30              | 7                      |
| `sortTasksBy`           | status, title, created, done            | status                 |

### How it works

- Each session writes only its own file, `<progressDir>/<session-id>.json`, through the
  `progress_update` tool — nobody else writes it, so sessions never overwrite each other. Your ✕ /
  Clear all go to a separate `<session-id>.dismissed.json`, which the session folds in on its next
  update; a file caught half-written is ignored until the next refresh (the last good copy stays).
  The tool takes a patch (`now`, `needsYou`, `tasks` upserted by id or title, `remove`), and
  the plugin stamps created / updated / done times. The format is in
  [`docs/design/MULTI-SESSION.md`](docs/design/MULTI-SESSION.md).
- Every pane lists the folder every 2 seconds and reads a file only when it changed (plugins have
  no file-watch API). A session's own update shows at once.
- The header carries two times: **updated** — the newest status change of any session — and
  **checked** — when this pane last looked (it ticks every 2 s). A check older than 10 s turns
  yellow with "(stale)": the pane stopped refreshing, so what it shows may be old.
- A session marks its entry ended when it closes; ended entries are dimmed and folded, and are
  removed after `keepEndedSessionsDays`.
- **Pipelines:** the agent can `watch` a GitLab CI pipeline (by id, or by commit sha before the
  pipeline exists). The session that watches it polls it through your own `glab` every 15 s until it
  finishes (GitLab cannot push to a local plugin), writes it into its file, and every pane shows
  it: a progress bar of finished / all jobs, how long it has run (live, beside an estimate from the average of
  up to 5 earlier successful runs of the same branch and trigger, cached 24 h; GitLab's duration
  once finished), the counts per state (coloured) and every job, grouped
  by stage in pipeline order, with its result and time. The section header sums up every pipeline (watching / succeeded / failed) and folds itself once
  all of them succeeded (it opens again on news). Pipelines are listed newest first; a success folds to one line, and one that succeeded more
  than an hour ago moves into a folded "Finished" row. A pipeline starts folded — its header and
  counts — and a press opens every job; ✕ removes
  a finished one. The `↗` at the right edge of a pipeline, and of each job when unfolded, is a
  link to its GitLab page: click it to open it in your browser (an OSC 8 terminal hyperlink — the
  terminal opens it; in a terminal without link support the address is printed after it). The
  row under the pointer is highlighted, so it is clear which row a `↗` belongs to. Needs [`glab`](https://gitlab.com/gitlab-org/cli)
  on PATH and logged in (`glab auth status`).
- **Upgrading from 0.1:** the single `~/.claude/progress.json` is no longer read.

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

Test-first: a change lands with its test (`hooks/model.test.ts` for the pure logic,
`hooks/register.test.tsx` for the plugin against the engine). Every user-facing string
lives in `locales/en.ts` and goes through `t()` (`hooks/i18n.ts`). CI (`.gitlab-ci.yml`) runs the
checks above on every push. Security findings that are not fixed yet are never published: they are
age-sealed in `docs/audits/` (process: [`docs/audits/README.md`](docs/audits/README.md); `/audit`
and `/maintain` are project skills in `.claude/skills/`).

## License

[MIT](LICENSE)
