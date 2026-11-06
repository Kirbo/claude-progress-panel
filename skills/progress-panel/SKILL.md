---
name: progress-panel
description: Keep the Progress pane beside the chat current — write the JSON status file it shows (what you are doing now, what needs the user, every phase with its status). Use during any multi-step task, unattended run or handover, when the user asks for the panel / progress pane / status panel, or when a session starts with an existing status file.
---

# Keeping the Progress pane current

The `progress-panel` plugin draws a pane beside the chat from ONE JSON file. You keep that file
current; the pane re-reads it after every Write / Edit / MultiEdit / Bash / NotebookEdit call
(one `stat`, re-parsed only when its mtime moved) — there is no timer, so write it with one of those
tools.

## Where the file is

1. The plugin option `progressFile`, if set (`claude plugin configure progress-panel` shows it;
   `~/` expands to the home directory).
2. Else `$CLAUDE_CONFIG_DIR/progress.json` when `CLAUDE_CONFIG_DIR` is set.
3. Else `~/.claude/progress.json`.

The pane's first line names the path when the file is missing or unreadable.

## The shape (all fields optional)

```json
{
  "now": "One or two sentences: what you are doing this minute and what comes next.",
  "needsYou": ["Each thing ONLY the user can do or decide — a push OK, a login, a choice."],
  "updated": "2026-11-06 22:05",
  "phases": [{ "title": "Short name of a unit of work", "status": "doing", "note": "where it stands" }]
}
```

- `status` is one of `doing` (●, yellow), `blocked` (✗, red), `todo` (○), `done` (✓, green, dimmed),
  `skipped` (–, dimmed). Unknown values show `?`.
- The pane sorts phases blocked → doing → todo → done → skipped and shows notes only for open ones,
  so a note on a done phase is a record, not clutter. It ends with `N open · M done/skipped`.
- `updated` is free text — use local time `YYYY-MM-DD HH:MM`.

## The protocol

- **Every turn of tracked work:** read the file, change what moved, write it back whole (valid
  JSON — a parse error replaces the pane with an error line). Update `updated`.
- **Keep it true.** `now` says what is actually running; `needsYou` holds only real blockers and is
  emptied the moment they are answered; a phase moves to `done` only when verified.
- **Don't drop history** mid-task: finished phases stay as `done` with a one-line outcome (commit
  hashes, pipeline ids) — they are the user's record of the session.
- **Edit with a JSON tool** (`jq` in Bash, or Write the whole file) rather than string surgery.
  Example — set `now` and the timestamp:
  `jq '.now = "…" | .updated = "2026-11-06 22:05"' "$F" > "$F.new" && mv "$F.new" "$F"`
- **Mirrors are optional.** If the user also keeps the same status somewhere shared (an artifact,
  a doc, a gist), update the mirror from the file each turn so both say the same thing; the file
  is the source.
- **Handover / resume:** a new session (another machine, a resumed one) starts by reading the
  file and continuing from it. Never commit it to a project repository: it is personal state.

## When the pane is not visible

- `/progress` opens it (the session opens it by itself only on a wide enough terminal, ~144
  columns).
- No pane and no `/progress` command → the plugin is not installed/enabled on this machine: see
  the repository README (`claude plugin marketplace add …` then `claude plugin install …`).
