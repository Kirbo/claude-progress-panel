# Multi-session progress panel (v0.2)

> **Status:** shipped in 0.2.0 · 2026-11-06
> **Asked for (2026-11-06):** every Claude Code session on one machine writes to the same store and
> every pane shows the same status, grouped by session; collapsible groups, a Done section with
> timestamps, "Clear all" and per-item ✕, sortable tasks, the plugin's own settings.

## Layout (top to bottom)

```
updated 22:05 · switchboard                       ← newest update across sessions
⚠ Needs you (2)                                   ← bold magenta, only when non-empty
  • switchboard: push OK for next
  • panel: pick a name
Now                                                ← one line per live session, newest first
  switchboard · Waiting for pipeline 3037602037
  panel · Writing the design doc
Sessions                              [Sort: status]
▾ switchboard (this session) · 22:05 · 2 open · 5 done
    ✗ macOS build — runner restarted
    ● Screenshot refresh — capture running
    ▸ Done (5)                          [Clear all]
▸ panel · ended 21:40 · 0 open · 3 done            ← dimmed
```

- Every `▾`/`▸` line is a Button that folds its part. Defaults: live sessions open, ended
  sessions folded, every Done section folded. Fold state is per pane (`$.state`).
- Done rows read `✓ title  YYYY-MM-DD HH:MM  [✕]` (time the task was done, local time).
- The pane scrolls when taller than its window (the engine's own scrolling).
- With anything in Needs you, the status line reads `⚠ N need you`; an item that appears from
  another session also raises a toast once.

## Store

One folder, default `<CLAUDE_CONFIG_DIR or ~/.claude>/progress/`, option `progressDir`. One file
per session, `<session-id>.json`, written only whole:

```json
{
  "version": 2,
  "session": { "id": "…", "project": "switchboard", "cwd": "/…", "startedAt": "ISO", "endedAt": null },
  "now": "…",
  "needsYou": ["…"],
  "updatedAt": "ISO",
  "tasks": [
    { "id": "t1", "title": "…", "status": "doing", "note": "…",
      "createdAt": "ISO", "updatedAt": "ISO", "doneAt": null }
  ],
  "dismissed": ["t7"],
  "seq": 7
}
```

- `project` = the repository's name (`$.session.repo()`), else the last segment of the cwd.
- A session writes its own file; a pane's ✕ / Clear all / dismiss-session write the file of the
  session the row belongs to: read it fresh, change only those rows, write it back (the window
  for a lost update is one read-modify-write; acceptable for a status display).
- `dismissed` remembers ids the person removed, so the agent re-sending a done task does not
  bring it back. Re-opening it (a non-done status) clears the dismissal.

## Writing: the `progress_update` tool

The plugin registers `progress_update` (listed as `mcp__progress-panel__progress_update`, schema
in the prompt from the start). Input — every field optional, a patch, not the whole state:

| Field      | Meaning                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `now`      | replaces the "now" line                                                  |
| `needsYou` | replaces the list (`[]` clears it)                                       |
| `tasks`    | upserts by `id` (or exact `title` when no id); new tasks get `t<n>` ids  |
| `remove`   | task ids to delete                                                       |

Status values: `todo`, `doing`, `blocked`, `done`, `skipped`. The plugin stamps `createdAt`,
`updatedAt` and `doneAt` (set on entering done/skipped, cleared on re-opening). The tool answers
with the session's task list (ids, statuses) so the agent can address tasks by id.

## Reading: refresh

There is no file-watch API for plugins, so each session lists the folder every **2 s**
(`$.clock.every`) and reads a file only when its mtime changed — one directory listing per tick.
A session's own write redraws at once. (Deliberate poll: push is impossible here.)

## Retention (settings)

| Option                  | Values (picker)                         | Default  |
| ----------------------- | --------------------------------------- | -------- |
| `progressDir`           | path (`~/` allowed)                      | empty    |
| `autoClearDoneHours`    | 0 (never), 1, 3, 6, 12, 24, 48, 72, 168 | 0        |
| `keepEndedSessionsDays` | 0 (never), 1, 3, 7, 14, 30              | 7        |
| `sortTasksBy`           | status, title, created, done            | status   |

- Done tasks older than `autoClearDoneHours` are removed by the owning session (or by any
  session once the owner has ended).
- A session that ended more than `keepEndedSessionsDays` ago is deleted (`rm -f` / `del`, the
  plugin API has no file delete). An ended session can also be dismissed with its ✕.
- The pane's `[Sort: …]` Button cycles the order and remembers it per user (`$.store`); the
  option is the starting value.
- Sorting: `status` = blocked, doing, todo (open) and newest done first; `title` = A→Z;
  `created` = oldest first; `done` = newest done first (open tasks by creation).

## Out of scope / later

- Other machines: the store is local. Mirroring to a shared place stays the agent's job.
- v0.1's single `progress.json` is not read any more (breaking; noted in the README).
