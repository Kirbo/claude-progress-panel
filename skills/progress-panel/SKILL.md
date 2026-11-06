---
name: progress-panel
description: Keep the Progress pane current — the pane beside every Claude Code session on this machine that shows each session's "now", what needs the user, and its tasks. Use the progress_update tool during any multi-step task, unattended run or handover, when the user asks for the panel / progress pane / status panel, and whenever your status changes.
---

# Keeping the Progress pane current

The `progress-panel` plugin shows one pane in EVERY Claude Code session on this machine. Each
session owns one entry in a shared folder; every pane shows all of them, grouped by session:

1. `updated HH:MM · project` — the newest update anywhere.
2. `⚠ Needs you` — every live session's asks, highlighted, also in the status line and toasted to
   the other sessions.
3. `Now` — one line per live session.
4. `Sessions` — one foldable group per session (this one first): open tasks, then a foldable
   Done section with done times, "Clear all" and a ✕ per item.

## How to write: the `progress_update` tool

Call `mcp__progress-panel__progress_update` (its schema is in your tool list). It is a **patch** —
send only what changed:

| Field      | Effect                                                                     |
| ---------- | -------------------------------------------------------------------------- |
| `now`      | replaces your one-line summary: what you are doing, what comes next        |
| `needsYou` | replaces your asks — only what the USER must do/decide; `[]` once answered |
| `tasks`    | upserts `{ id?, title?, status?, note? }` — by `id`, or by exact `title`   |
| `remove`   | task ids to delete (mistakes, not finished work — finish with `done`)      |

- `status`: `todo` (○), `doing` (●), `blocked` (✗ — say why in `note`), `done` (✓), `skipped` (–).
- New tasks need a `title`; the tool assigns ids (`t1`, `t2`, …) and answers with the full list —
  use the ids afterwards.
- Timestamps (created, updated, done) are stamped for you. Never write the files yourself.

## The routine

- **Start of multi-step work:** one call with `now` and the planned tasks (`todo`).
- **Each change:** mark the task `doing` when you start it, `done` (with a one-line outcome in
  `note`: commit hash, pipeline id) when verified, `blocked` with the reason when stuck.
- **Asks:** put a blocker in `needsYou` the moment you need the user, and clear it (`[]` or the
  remaining list) as soon as it is answered. Keep it honest — every session shows it.
- **Keep `now` true:** what is actually running right now.
- **Don't delete history:** finished tasks stay `done`; the user clears them (✕ / Clear all) or
  the plugin's auto-clear setting does.
- **Resume:** a resumed session keeps its entry while its session id is unchanged (a `/clear`
  starts a new entry); the tool's answer lists your tasks and ids.

## When the pane is not visible

- `/progress` opens it (a session opens it by itself only on a terminal ~144 columns wide).
- No `progress_update` tool and no `/progress` → the plugin is not installed on this machine: see
  the repository's `CLAUDE.md` ("Set the panel up on a machine").
