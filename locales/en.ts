// English catalog — every user-facing string of the plugin. Add a language as a sibling file with
// the same keys and register it in hooks/i18n.ts.
export const en = {
  'pane.title': 'Progress',
  'command.description': 'Show the progress pane of every session',
  'command.opened': 'Progress pane opened.',
  'error.noHome': 'No home directory: set the progressDir option',
  'pane.empty': 'No session has reported progress yet.',
  'pane.updated': 'updated {when} · {project}',
  'pane.needsYou': '⚠ Needs you ({count})',
  'pane.needsYouItem': '• {project}: {item}',
  'pane.now': 'Now',
  'pane.nowItem': '{project} · {now}',
  'pane.sessions': 'Sessions',
  'pane.sort': 'Sort: {by}',
  'pane.thisSession': '{project} (this session)',
  'pane.groupLive': '{fold} {name} · {when} · {open} open · {done} done',
  'pane.groupEnded': '{fold} {name} · ended {when} · {open} open · {done} done',
  'pane.doneSection': '{fold} Done ({count})',
  'pane.clearAll': 'Clear all',
  'pane.doneItem': '✓ {title}  {when}',
  'pane.skippedItem': '– {title}  {when}',
  'pane.dismiss': '✕',
  'pane.forget': '✕',
  'status.needsYou': '⚠ {count} need you',
  'toast.needsYou': '{project} needs you: {item}',
  'sort.status': 'status',
  'sort.title': 'title',
  'sort.created': 'created',
  'sort.done': 'done',
  'tool.description':
    "Update this session's entry in the Progress pane that every Claude Code session on this machine shows. A patch: send only what changed. `now` replaces the one-line summary of what you are doing; `needsYou` replaces the list of things only the user can do or decide (send [] once answered); `tasks` upserts by `id` (or by exact `title` when no id; new tasks need a title) with status todo | doing | blocked | done | skipped and an optional short `note`; `remove` deletes task ids. Timestamps are stamped for you. Call it whenever your status changes during multi-step work.",
  'tool.saved': 'Saved. {count} task(s):',
  'tool.problems': 'Not applied:',
  'tool.failed': 'progress_update failed; the pane was not changed.',
  'tool.noDir': 'progress_update: no progress folder (no home directory; set the progressDir option).',
} as const

export type MessageKey = keyof typeof en
