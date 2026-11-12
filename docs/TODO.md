# To do

Work that is known and not done yet, each with what "done" means. Finished items are deleted here and
described in their commit / the release notes.

- **Regenerate `docs/screenshots/pane.png`** (the README's picture). The pane changed visibly since
  it was taken: no switches row while everything is on, no "checked" clock in the first line, the
  idle sessions' one line under Needs you, "Clear all (N)", ✕ on finished agent rows, the undo
  line, a stopped watch's row and a commit's several runs. Done = the `screenshots` skill run once
  (headless tmux + `freeze`; neither is installed on the machine it was last attempted on, and the
  recipe starts a second Claude Code session). The demo data is ready for it:
  `scripts/screenshot-demo.mjs` now carries a running and a finished subagent and a commit row of
  two runs (`scripts/screenshot-demo.test.mjs` keeps it readable by the pane).
- **The pane blinking after a reload — find the cause.** Seen 2026-11-12 ~16:08 for a minute or two,
  right after `/reload-plugins` took a session from 0.26.1 to 0.28.0 with two subagents at work;
  it stopped by itself. Known from that session's own file and the code: it was the only live
  session on the machine (so no other pane, no lease, no second version took part); its file was
  written once in 23 s (so no save loop, and the folder scan's redraw every 2 s was the only
  steady repaint); neither running agent's entry carries `resumedAt` (so no agent flapped between
  running and finished); no pipeline was unfinished. What the reload did change is the `sessions`
  atom's shape tag (`sessions-3` → `sessions-4`): any copy that names the other tag reads the atom
  as empty and draws the empty pane. Suspect, unproven: the old copy's pane drawing — or a hook of
  it still in flight (a `turn.step` or `tool.call` hook stays in flight for a whole model request
  or tool call) — stayed subscribed for a while, and each 2 s update was drawn once by each copy:
  empty, full, empty, full. The test harness has one copy and no shape tags, so this cannot be
  shown there. Done = the next reload across a tag change is watched (0.28.0 → 0.29.0 is one:
  `sessions-4` → `sessions-5`): does the pane alternate between the two-line empty state and the
  full one? If yes, the fix to weigh is to stop changing the tag for additive changes (0.29.0's
  were: `at`, `all`, `cancelledAt` are optional), and to bump it only when an old value would
  really be misread. If the pane alternates between something else, note what, and start there.
- **A pipeline finishing, told to the agent in one line (review H1).** Today the agent hears of a
  finished pipeline only through a task linked to it ("task … is done — pipeline 7 green"); a
  watch without a linked task ends silently for the agent (the person gets the toast). Design: when
  a pipeline of this session's finishes in `pollPipelines`, one `pendingNotes` line — "Progress
  pane: pipeline `<label>` finished: success in 6m" / "… failed: job a, job b and 2 more" (names
  through `cleanText`, at most `FAILED_JOBS_NAMED`) — and a task linked to it is named in that same
  line instead of getting its own. Not built: it changes what every session's agent is told and
  adds a line per pipeline to its context, which is the owner's call after the cuts of 0.28.0
  (`/progress doctor`'s cost line now measures what it would add).
- **A compact pane (review H6).** For a narrow or short terminal: Needs you, the Now lines and the
  running pipelines only — no task lists, no Done, no ended sessions. Design: a `paneLayout`
  setting (`full` / `compact` / `auto`: compact below ~60 body columns or ~12 rows, from
  `e.props.bodyColumns` and `scroll.bodyRows`), a press on a session's Now line unfolds that one
  session in place. Needs `renderPane` split first (next entry): a second layout inside the one
  1,600-line function is how it would stop being maintainable.
- **Split `renderPane` (review F5).** One function draws the whole pane (`hooks/pane.tsx`, ~1,600
  lines: settings view, header, Needs you, pipelines, sessions, tasks, agents, Done, undo). Done =
  each section a top-level function of its own taking one shared context object (the resolved
  components, `all`, `folded`, `nowMs`, the helpers), no change in what is drawn (the pane tests
  stay as they are). A refactor for its own change, not mixed with behaviour.
- **One read of the session's own file per scan (review F6).** Each 2 s scan reads and parses the
  session's own file and sidecar twice — once in `syncOwnAgents`, once in the retention step — and
  a third time when the folder listing shows its mtime moved; on a long day that file is ~200 KB.
  Done = one `ownFile` read under one lock per scan, both steps applied to it, one save.
- **The notice queue in the file, and a trail of what the agent was told (review H7).** Removals
  owed to an agent already survive a reload (`owed`). Pipeline and agent notices (`pendingNotes`,
  `finishedLinks`) are still memory only: a reload between the event and the agent's next step
  loses them. Design: put them in `owed` as `{ text }` entries at the moment they arise (the
  channel exists), and keep the last few handed over (`told: [{ at, text }]`, capped) so the pane
  can show "told the agent: …" under the session. Left as it is on the owner's word (only removal
  notices are persisted for now).
- **Orphan polling and a slow owner.** A pane takes another session's unfinished pipeline for
  orphaned when its `checkedAt` is older than a fixed 60 s (`ORPHAN_AFTER_MS`), and polls it when
  `shouldPoll` says a check is due. An owner that polls less often than that — `pipelineRefreshSec`
  60, a parked watch (5 min), a backed-off one (up to 10 min) — can therefore get a second poller
  (the pane holding the lease) at the moment its own check falls due: harmless on screen (the newer
  copy wins), but a doubled CLI call. Done = the threshold follows the owner's own schedule (the
  interval `shouldPoll` uses for that watch, plus a margin), with a test for each of the three.
- **The tool's schema descriptions are English in the code** (`hooks/schema.ts`). Left out of the
  catalog on purpose: they are the tool's field documentation, read by the model as an API, never
  shown to a person. If a second language ever ships, decide whether the model should read them
  translated (the tool's one-paragraph description already is a catalog key).
