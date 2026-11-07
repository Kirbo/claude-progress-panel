# claude-progress-panel — instructions for agents

Two jobs live here: **(A) setting the panel up on a machine** and **(B) working on this repo**.
How to _use_ the panel during a task is the bundled skill:
[`skills/progress-panel/SKILL.md`](skills/progress-panel/SKILL.md).

## A. Set the panel up on a machine (exact steps)

1. Check Claude Code is new enough: `claude --version` ≥ **2.1.318**. Older → tell the user to
   update Claude Code first; stop.
2. Install from this repo's marketplace, user scope (non-interactive, works from any directory):

   ```sh
   claude plugin marketplace add https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel.git
   claude plugin install progress-panel@claude-progress-panel --scope user
   ```

   Already added → `claude plugin marketplace update claude-progress-panel` then
   `claude plugin update progress-panel@claude-progress-panel`.
3. Remove any older copy that would load the same plugin twice: a `progress-panel` folder named in
   `CLAUDE_CODE_PLUGIN_DIRS` (`env` block of `~/.claude/settings.json` or the shell profile), or a
   `~/.claude/skills/progress-panel` plugin folder. Ask before deleting anything that is not
   clearly a copy of this plugin.
4. Store: `~/.claude/progress/` (one `<session-id>.json` per session) unless `CLAUDE_CONFIG_DIR`
   is set or the user wants another folder (`claude plugin install … --config progressDir=<path>`,
   or later `claude plugin configure progress-panel`). Other settings: `autoClearDoneHours`,
   `keepEndedSessionsDays`, `sortTasksBy` (README "Settings") — ask the user only if they care.
   If the user is continuing work from another machine, put their handover into THIS session
   with the `progress_update` tool (tasks + now + needsYou) — never invent content.
5. Pipelines in the pane need [`glab`](https://gitlab.com/gitlab-org/cli) on PATH and logged in
   (`glab auth status`); without it everything else works and a watched pipeline shows glab's error.
6. Verify: `claude plugin list` shows `progress-panel@claude-progress-panel` enabled. The pane
   appears in the NEXT session (or after `/reload-plugins` in a running one); `/progress` opens it.
   It needs a terminal ≥ ~144 columns to open by itself and does not draw usefully inside
   `screen`/`tmux` panes that are too narrow.
7. If the user wants the agent to keep it current by default, add one line to their
   `~/.claude/CLAUDE.md` (ask first — it is their file):
   `Keep the progress panel (progress-panel skill) current during multi-step work.`

## B. Working on this repo

- **Toolchain: mise only.** `mise install`; run tools as `mise exec -- <tool>`. Pins are exact in
  `mise.toml`; after a bump run `mise lock` and commit `mise.lock`. Pin only releases at least one
  day old.
- **Lint/format: Biome** (`biome check .`; `--write` to fix). No ESLint/Prettier.
- **TDD.** Write the failing test first (`claude plugin test .`), then the code: pure logic in
  `hooks/model.ts` ↔ `hooks/model.test.ts` and `hooks/pipelines.ts` ↔ `hooks/pipelines.test.ts`; I/O, tool, timer and pane in `hooks/register.tsx` ↔
  `hooks/register.test.tsx`, whose `engine()` helper stands in for the engine (`on('<op>', …)`
  stubs, a fake disk, `mock.clock`) — reuse and extend it, don't fork it.
- **i18n.** Every user-facing string is a key in `locales/en.ts`, read through `t()` from
  `hooks/i18n.ts` — never a literal in JSX or a command answer.
- **The module has no Node/DOM.** Everything outside goes through `$` (`$.fs`, `$.env`, …). A
  function that takes `$` must be a top-level function declaration (the validator follows `$`
  only into those). `$.env.get` takes string literals only.
- **State shape:** the pane's values are the `sessions`, `folds` and `sort` atoms; change an
  atom's `shape` tag whenever its stored type changes, so an old value from before a reload is
  declined. `types/index.d.ts` is the contract and must stay self-contained (no imports).
- **The design** (store format, tool semantics, refresh, retention) is
  `docs/design/MULTI-SESSION.md` — keep it in step with the code.
- **Done = green:** `biome check .`, `claude plugin test .`, `claude plugin validate .`,
  `node --test scripts/`, `node scripts/check-audits.mjs` all clean
  (validate's "plugin directory" notes about the icon are informational). Bump `version` in
  `.claude-plugin/plugin.json` for any behaviour change — `claude plugin update` keys on it — in
  the LAST commit of that version: on `main`, CI's `release` job makes a GitLab Release `v<version>`
  at the commit that first carried it, its notes git-cliff's (`cliff.toml`) over the Conventional
  Commits since the version before (`scripts/release.mjs`; `node scripts/release.mjs --dry-run`
  previews). So commit subjects are release notes: write them for users.
- **Hooks:** once per clone `git config core.hooksPath .githooks`. The pre-commit hook runs Biome
  over the staged files first — fixes what it can, re-stages fully staged files (never a partly
  staged one), refuses the commit on anything left (`scripts/lint-staged.mjs`) — then seals audit
  findings (see below).
- **Audits (`/audit`, `.claude/skills/audit/`).** Process, formats, IDs (`CPP-NNNN`) and sealing:
  [`docs/audits/README.md`](docs/audits/README.md). **A finding that is not fixed is never readable
  in the clear** — only in the age-sealed `docs/audits/open/*.md.age` (plaintext gitignored, sealed
  by the pre-commit hook to the maintainer key). Never write an open finding's content into
  README/CLAUDE.md/docs, a code comment, a test name, an issue or a commit message. A fix commit
  cites the ID, ships a regression test and moves the finding to `docs/audits/fixed/` in the same
  commit. Never commit with `--no-verify`; never print, copy or create the private identity (only
  `.age-recipients`, public keys, is in the repo). `node scripts/seal.mjs status|unseal|verify`.
- **Maintenance (`/maintain`, `.claude/skills/maintain/`):** toolchain + CI pin bumps (releases at
  least 1 day old), docs reconciliation, all gates.
- **Screenshots** (`docs/screenshots/pane.png`, shown in the README): demo data, never a real
  session's store, captured from a headless session — no window opens. Regenerate after a visible
  change, in one go (the demo's "running" pipeline gets polled after a minute):
  `node scripts/screenshot-demo.mjs <empty dir>`, then in tmux (`mise exec tmux@3.7c --`, own
  socket `-L panel-demo`, 190×60) run `PROGRESS_PANEL_DIR=<dir> claude --plugin-dir . --settings
  '{"enabledPlugins":{"progress-panel@claude-progress-panel":false}}'` from a folder Claude Code
  already trusts, wait for the pane, `tmux capture-pane -e -p > full.ansi`, kill the server,
  `node scripts/ansi-crop.mjs full.ansi <pane's first column> 84 1 30 > pane.ansi`, and render with
  `mise exec aqua:charmbracelet/freeze@0.2.2 -- freeze --window --background "$(node
  scripts/ansi-crop.mjs --print-bg pane.ansi)" --padding 24 --font.size 14 --line-height 1.3 -o
  docs/screenshots/pane.png pane.ansi < /dev/null` (stdin closed, or it waits; the canvas takes the
  pane's own background, so empty cells match the text cells).
- Scripts (`scripts/*.mjs`) are plain Node with no dependencies, tested with `node --test scripts/`.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- **GitHub mirror** (`github.com/Kirbo/claude-progress-panel`; read-only copy for discovery — issues
  and MRs live on GitLab, its issues/wiki are off): GitLab push-mirrors every branch and tag to it
  automatically (Settings → Repository → Mirroring repositories; a fine-grained GitHub token for that
  one repo, held by GitLab). Never push to it directly. GitLab stays canonical (`repository` in the
  manifest, the update check, the Releases).
- Public repo: no secrets, hostnames, private URLs or personal paths in code, docs or tests.
