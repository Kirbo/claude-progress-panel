# Set the panel up on a machine (exact steps for agents)

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
   or later `claude plugin configure progress-panel`). Every other setting (27 in all, each with
   its default) is listed in the README's "Settings" and can be changed in the pane's ⚙ Settings
   view — ask the user only if they care. The ones worth raising: `ciCommand` (a CI that is not
   GitLab, GitHub or Gitea/Forgejo), `reportingEffort` (how much the agents report, so what the
   panel costs them) and `autoStart` (off = a session reports only once switched on).
   If the user is continuing work from another machine, put their handover into THIS session
   with the `progress_update` tool (tasks + now + needsYou) — never invent content.
5. Pipelines in the pane need the CLI of the repo's forge on PATH and logged in for its host:
   [`glab`](https://gitlab.com/gitlab-org/cli) for GitLab CI (`glab auth status`),
   [`gh`](https://cli.github.com) for GitHub Actions (`gh auth status`),
   [`tea`](https://gitea.com/gitea/tea) for Gitea / Forgejo Actions (`tea login list`) — or, for any
   other CI, the user's own **Custom CI command** (the `ciCommand` setting). Without it everything
   else works and a watched pipeline's row shows the CLI's error; `/progress doctor` checks exactly
   this for the repo the session is in.
6. Verify: `claude plugin list` shows `progress-panel@claude-progress-panel` enabled, then
   `/progress doctor` in a session (one line per check, each failure with its fix). The pane
   appears in the NEXT session (or after `/reload-plugins` in a running one); `/progress` opens it.
   It needs a terminal ≥ ~144 columns to open by itself and does not draw usefully inside
   `screen`/`tmux` panes that are too narrow.
7. Nothing goes into the user's `CLAUDE.md`: the plugin puts its reporting rule into every
   session's system prompt by itself (a session already running gets it with its next prompt), and
   `/progress doctor` shows "Reporting rule" as delivered. If an older setup added a line such as
   "Keep the progress panel current…" to `~/.claude/CLAUDE.md`, it is redundant — offer to remove
   it (ask first — it is their file).
