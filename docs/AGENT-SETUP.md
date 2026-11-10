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
   or later `claude plugin configure progress-panel`). Other settings: `autoClearDoneHours`,
   `keepEndedSessionsDays`, `sortTasksBy` (README "Settings") — ask the user only if they care.
   If the user is continuing work from another machine, put their handover into THIS session
   with the `progress_update` tool (tasks + now + needsYou) — never invent content.
5. Pipelines in the pane need [`glab`](https://gitlab.com/gitlab-org/cli) on PATH and logged in
   (`glab auth status`); without it everything else works and a watched pipeline shows glab's error.
6. Verify: `claude plugin list` shows `progress-panel@claude-progress-panel` enabled, then
   `/progress doctor` in a session (one line per check, each failure with its fix). The pane
   appears in the NEXT session (or after `/reload-plugins` in a running one); `/progress` opens it.
   It needs a terminal ≥ ~144 columns to open by itself and does not draw usefully inside
   `screen`/`tmux` panes that are too narrow.
7. If the user wants the agent to keep it current by default, add one line to their
   `~/.claude/CLAUDE.md` (ask first — it is their file):
   `Keep the progress panel (progress-panel skill) current during multi-step work.`
