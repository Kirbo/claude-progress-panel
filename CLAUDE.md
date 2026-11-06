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
4. Status file: `~/.claude/progress.json` unless `CLAUDE_CONFIG_DIR` is set or the user wants
   another path (`claude plugin install … --config progressFile=<path>`, or later
   `claude plugin configure progress-panel`). If the user is continuing work from another machine,
   seed the file from their handover (same JSON shape) — never invent its content.
5. Verify: `claude plugin list` shows `progress-panel@claude-progress-panel` enabled. The pane
   appears in the NEXT session (or after `/reload-plugins` in a running one); `/progress` opens it.
   It needs a terminal ≥ ~144 columns to open by itself and does not draw usefully inside
   `screen`/`tmux` panes that are too narrow.
6. If the user wants the agent to keep it current by default, add one line to their
   `~/.claude/CLAUDE.md` (ask first — it is their file):
   `Keep the progress panel (progress-panel skill) current during multi-step work.`

## B. Working on this repo

- **Toolchain: mise only.** `mise install`; run tools as `mise exec -- <tool>`. Pins are exact in
  `mise.toml`; after a bump run `mise lock` and commit `mise.lock`. Pin only releases at least one
  day old.
- **Lint/format: Biome** (`biome check .`; `--write` to fix). No ESLint/Prettier.
- **TDD.** Write the failing test in `hooks/register.test.tsx` first (`claude plugin test .`),
  then the code. Tests stand in for the engine with `on('<op>', …)` stubs — see the existing
  `engine()` helper; reuse it, don't fork it.
- **i18n.** Every user-facing string is a key in `locales/en.ts`, read through `t()` from
  `hooks/i18n.ts` — never a literal in JSX or a command answer.
- **The module has no Node/DOM.** Everything outside goes through `$` (`$.fs`, `$.env`, …). A
  function that takes `$` must be a top-level function declaration (the validator follows `$`
  only into those). `$.env.get` takes string literals only.
- **State shape:** the pane's value is the `loaded` atom; change its `shape` tag whenever the
  stored `Loaded` type changes, so an old value from before a reload is declined.
- **Done = green:** `biome check .`, `claude plugin test .`, `claude plugin validate .` all clean
  (validate's "plugin directory" notes about the icon are informational). Bump `version` in
  `.claude-plugin/plugin.json` for any behaviour change — `claude plugin update` keys on it.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- Public repo: no secrets, hostnames, private URLs or personal paths in code, docs or tests.
