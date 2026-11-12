# To do

Work that is known and not done yet, each with what "done" means. Finished items are deleted here and
described in their commit / the release notes.

- **Regenerate `docs/screenshots/pane.png`** (the README's picture). The pane changed visibly since
  it was taken: no switches row while everything is on, no "checked" clock in the first line, the
  idle sessions' one line under Needs you, "Clear all (N)", ✕ on finished agent rows, the undo
  line, a stopped watch's row and a commit's several runs. Done = the `screenshots` skill run once
  (headless tmux + `freeze`; neither is installed on the machine it was last attempted on, and the
  recipe starts a second Claude Code session), with `scripts/screenshot-demo.mjs` extended by a
  finished agent and a commit row of several runs so the picture shows them.
