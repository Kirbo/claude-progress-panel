---
name: screenshots
description: Regenerate docs/screenshots/pane.png (the pane screenshot shown in the README) from demo data in a headless tmux session. Use after any visible change to the pane, or when the user asks to update the screenshot.
---

# Regenerate the pane screenshot

`docs/screenshots/pane.png` is shown in the README. It is demo data, never a real session's store,
captured from a headless session — no window opens.

Regenerate after a visible change, in one go (the demo's "running" pipeline gets polled after a
minute):

1. `node scripts/screenshot-demo.mjs <empty dir>`
2. In tmux (`mise exec tmux@3.7c --`, own socket `-L panel-demo`, 190×60), from a folder Claude
   Code already trusts, run:

   ```sh
   PROGRESS_PANEL_DIR=<dir> claude --plugin-dir . --settings '{"enabledPlugins":{"progress-panel@claude-progress-panel":false}}'
   ```

3. Wait for the pane, then `tmux capture-pane -e -p > full.ansi`, and kill the server.
4. `node scripts/ansi-crop.mjs full.ansi <pane's first column> 84 1 30 > pane.ansi`
5. Render:

   ```sh
   mise exec aqua:charmbracelet/freeze@0.2.2 -- freeze --window --background "$(node scripts/ansi-crop.mjs --print-bg pane.ansi)" --padding 24 --font.size 14 --line-height 1.3 -o docs/screenshots/pane.png pane.ansi < /dev/null
   ```

   Stdin must be closed, or `freeze` waits. The canvas takes the pane's own background, so empty
   cells match the text cells.
