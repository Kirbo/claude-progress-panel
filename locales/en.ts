// English catalog — every user-facing string of the pane. Add a language as a sibling file with the
// same keys and register it in hooks/i18n.ts.
export const en = {
  'pane.title': 'Progress',
  'command.description': 'Show the work-status pane',
  'command.opened': 'Progress pane opened.',
  'error.noHome': 'No home directory: set the progressFile option',
  'error.notFound': '{file} not found',
  'error.unreadable': 'cannot read {file}: {reason}',
  'pane.updated': 'updated {when}',
  'pane.needsYou': 'Needs you',
  'pane.summary': '{open} open · {closed} done/skipped',
} as const

export type MessageKey = keyof typeof en
