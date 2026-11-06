# Claude Code progress panel

A pane beside the Claude Code chat that shows what the agent is working on — **now**, what
**needs you**, and every **phase** of the task with its status — read live from one JSON file
the agent keeps current.

```
┌ Progress ─────────────────────────────────────────────┐
│ updated 2026-11-06 22:05                              │
│ Waiting for CI, then pushing the release branch       │
│                                                       │
│ Needs you                                             │
│ • Push OK for the release branch                      │
│                                                       │
│ ✗ macOS build                                         │
│   EPERM on the app icon — runner restarted            │
│ ● Screenshot refresh                                  │
│   throttled capture running                           │
│ ✓ Prefill images                                      │
│ 2 open · 1 done/skipped                               │
└───────────────────────────────────────────────────────┘
```

It is a Claude Code plugin (a hooks module) plus a skill that teaches the agent how to keep the
file current. Nothing leaves your machine: the pane only reads a local file.

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
  `progress-panel` skill tells it the file's location, shape and the update-every-turn routine.
  To make it the default for every task, add a line like this to your `~/.claude/CLAUDE.md`:
  `Keep the progress panel (progress-panel skill) current during multi-step work.`
- You can edit the file yourself too; the pane picks the change up after the agent's next file
  or shell tool call.

### The status file

Default: `~/.claude/progress.json` (or `$CLAUDE_CONFIG_DIR/progress.json`). Another path:
`claude plugin configure progress-panel` (option `progressFile`, `~/` allowed) or `/config`.

```json
{
  "now": "What is happening right now.",
  "needsYou": ["Only things the user must do or decide."],
  "updated": "2026-11-06 22:05",
  "phases": [{ "title": "Unit of work", "status": "doing", "note": "where it stands" }]
}
```

| `status`  | Mark | Shown                 |
| --------- | ---- | --------------------- |
| `blocked` | ✗    | red, with its note    |
| `doing`   | ●    | yellow, with its note |
| `todo`    | ○    | with its note         |
| `done`    | ✓    | dimmed, note hidden   |
| `skipped` | –    | dimmed, note hidden   |

All fields are optional. A missing file or invalid JSON shows one red line naming the path.

### How it refreshes

No polling: after every `Write`, `Edit`, `MultiEdit`, `Bash` or `NotebookEdit` tool call the
plugin `stat`s the file and re-reads it only if its modification time moved. An edit made outside
the session shows after the next such tool call, or on `/progress`.

## Develop

Toolchain via [mise](https://mise.jdx.dev) (`mise.toml` pins Biome and Claude Code; `mise.lock`
is committed):

```sh
mise install
mise exec -- biome check .                 # lint + format check (biome check --write . to fix)
mise exec -- claude plugin test .          # hooks/*.test.tsx against the engine
mise exec -- claude plugin validate .      # manifest + module, as the engine reads them
claude --plugin-dir .                      # a session with this working copy loaded
```

Test-first: a change lands with its test in `hooks/register.test.tsx`. Every user-facing string
lives in `locales/en.ts` and goes through `t()` (`hooks/i18n.ts`). CI (`.gitlab-ci.yml`) runs the
three checks on every push.

## License

[MIT](LICENSE)
