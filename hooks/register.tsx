// The plugin's hooks: what it registers with the engine, each handing on to session.tsx / pane.tsx.

import type { Register } from 'claude-code'
import { fields } from './events'
import { pollAll } from './forge'
import { whoAmI } from './host'
import { t } from './i18n'
import { endAgent, isBlank, isClosed, linkedAgent, ownBackground, waitingOnFrom } from './model'
import { renderPane } from './pane'
import { INPUT_SCHEMA } from './schema'
import type { ToolInput } from './session'
import {
  autoLink,
  callSummary,
  checkRelease,
  clearAutoNeeds,
  detached,
  doctor,
  endOfTurnCheck,
  endPendingCallOf,
  feedAgentPrompt,
  forgetCiVerdicts,
  markEnded,
  noteAgentBackground,
  noteAgentRepo,
  notePendingCall,
  ownManifest,
  paneArgs,
  permissionAnswered,
  queueMessage,
  raiseAutoNeed,
  reopenIfActive,
  runAgentUpdate,
  runUpdate,
  scan,
  setToggle,
  staleNudges,
  takeDeferredRule,
  tick,
  toggleStatus,
  watchPushes,
  withPendingNotes,
  withPushNote,
  withRemovalNotice,
  withReportingNudge,
  withSubagentRule,
} from './session'
import { readSettings } from './settings'
import {
  agentBackground,
  finishedLinks,
  isOn,
  PANE,
  pendingAgentNotices,
  pendingNotes,
  REFRESH_MS,
  REPORTING_SECTION,
  ruleText,
  self,
  TOOL,
  TOOL_ID,
  takeFinishedLinks,
  updateViewing,
} from './state'
import { exclusive, noteTitle, nowIso, ownFile, progressDir, save } from './store'
import { parseProgressCommand } from './toggles'

export const register: Register = (on, options) => {
  self.settings = readSettings(options as Record<string, unknown>)
  on('session.start', async ($, e, next) => {
    self.ownProcess = await whoAmI($)
    await $.command.register({ name: 'progress', description: t('command.description') })
    await $.tool.register({
      name: TOOL,
      description: t('tool.description'),
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    // A session's file is created by its first report, never blank (a session that reports
    // nothing leaves nothing behind); a resumed session's existing file is kept as it is.
    const dir = await progressDir($, options)
    if (dir)
      await exclusive(async () => {
        const own = await ownFile($, dir)
        self.sessionToggles = own.toggles
        if (!isBlank(own)) await save($, dir, own)
      })
    await scan($, options)
    $.clock.every(REFRESH_MS, () => detached(tick($, options)))
    $.clock.every(self.settings.pipelineRefreshMs, () => detached(pollAll($, options)))
    detached(ownManifest($))
    detached(checkRelease($))
    $.clock.every(3_600_000, () => detached(checkRelease($)))
    // A dormant session (autoStart off and not switched on) does not open the pane by itself.
    if (isOn(options, 'reporting') && self.settings.autoOpen !== 'never') void $.ui.open(paneArgs(options))
    return next(e)
  })

  // The reporting rule rides every session's system prompt, so no session waits to be told to use the
  // pane. Only where the tool is offered (nothing to report through otherwise), and never in a
  // teammate's render of its lead's prompt (the lead reports). Steady text: the prompt cache keeps it.
  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL_ID) || e.traits.includes('teammate')) return composed
    if (!isOn(options, 'reporting')) return composed
    self.ruleComposed = true
    return {
      sections: [...composed.sections, { id: REPORTING_SECTION, text: ruleText(options), scope: 'session' }],
    }
  })

  // The session's name (the plugin API has none): SessionStart carries a resumed session's title,
  // UserPromptSubmit the current one, so a `/rename` shows from the next prompt on.
  // A compaction keeps the system prompt but summarises the conversation: a rule that only rode a
  // prompt (`ruleSent`, the plugin joined mid-way) can be summarised away, so the session's own
  // compaction (SessionStart `compact`, never a subagent's) hands it over again.
  on('classic.SessionStart', async ($, e, next) => {
    const start = fields(e)
    await noteTitle($, options, start.session_title)
    if (start.source === 'startup' && !start.agent_id) self.freshStart = true
    const result = await next(e)
    if (start.source !== 'compact' || start.agent_id || self.ruleComposed || !isOn(options, 'reporting'))
      return result
    self.ruleSent = true
    return { ...result, additionalContext: [...(result.additionalContext ?? []), ruleText(options)] }
  }).catch(() => undefined)
  // A subagent starts: the subagent part of the rule, once (its tool calls then carry none).
  on('classic.SubagentStart', async ($, e, next) => {
    const result = await next(e)
    const id = fields(e).agent_id
    return typeof id === 'string' && id ? withSubagentRule($, options, id, result) : result
  }).catch(() => undefined) // a failure here never holds a subagent up: the hook counts as absent
  on('classic.UserPromptSubmit', async ($, e, next) => {
    // The person answered: every automatic Needs-you item goes.
    await clearAutoNeeds($, options, () => true).catch(() => undefined)
    await noteTitle($, options, fields(e).session_title)
    const stale = await staleNudges($, options).catch(() => [] as string[])
    const result = withPendingNotes(await next(e))
    const nudged =
      stale.length > 0
        ? { ...result, additionalContext: [...(result.additionalContext ?? []), ...stale] }
        : result
    return withReportingNudge($, options, isOn(options, 'reporting') ? withRemovalNotice(nudged) : nudged)
  }).catch(() => undefined)
  // After every main-loop tool call: a task the person removed reaches the agent at its next step
  // (a subagent's calls never take the note — it is the coordinator's).
  // A subagent stopped: its entry is marked finished — it folds under Agents and stays (nothing is
  // cleaned up automatically).
  on('classic.SubagentStop', async ($, e, next) => {
    const id = fields(e).agent_id
    const dir = await progressDir($, options)
    if (typeof id === 'string' && dir) {
      const at = await nowIso($)
      await exclusive(async () => {
        const own = await ownFile($, dir)
        // Still running background work OF ITS OWN: it waits (and resumes on its own). The event lists
        // the whole session's background work with no owner — the coordinator's watchers among it —
        // so only tasks this agent's own calls started count; anything else is not its, and it ended.
        const background = ownBackground(fields(e).background_tasks, agentBackground.get(id) ?? new Set())
        const waiting = background.length > 0
        const ended = endAgent(own, id, at, waiting, waiting ? waitingOnFrom(background) : undefined)
        if (ended !== own) await save($, dir, ended)
        if (waiting) return
        // A task linked to it: the coordinator is told to verify and update it — never done for it.
        for (const task of own.tasks)
          if (!isClosed(task.status) && linkedAgent(own, task)?.id === id)
            finishedLinks.push(
              t('notice.agentFinished', { agent: linkedAgent(own, task)?.label ?? id, task: task.title }),
            )
      })
    }
    return next(e)
  }).catch(() => undefined)
  // A subagent's first call instead carries the reporting rule it never got (`withSubagentRule`).
  on('classic.PostToolUse', async ($, e, next) => {
    noteAgentBackground(e)
    await permissionAnswered($, options, e)
    const pushNotes: string[] = []
    const pushed = isOn(options, 'pipelines')
      ? await watchPushes($, options, e, pushNotes).catch(() => [] as string[])
      : []
    const result = withPushNote(pushed, await next(e), pushNotes)
    const agentId = fields(e).agent_id
    if (typeof agentId === 'string' && agentId) {
      await reopenIfActive($, options, agentId).catch(() => undefined)
      await noteAgentRepo($, options, e).catch(() => undefined)
      const own = pendingAgentNotices.get(agentId)
      pendingAgentNotices.delete(agentId)
      const told = own?.length
        ? { ...result, additionalContext: [...(result.additionalContext ?? []), ...own] }
        : result
      return withSubagentRule($, options, agentId, told)
    }
    if (agentId) return result
    pendingNotes.push(...takeFinishedLinks(), ...takeDeferredRule(options))
    const noted = withPendingNotes(result)
    return isOn(options, 'reporting') ? withRemovalNotice(noted) : noted
  }).catch(() => undefined)

  // Claude Code waits on the person: a permission prompt or the idle prompt becomes a Needs-you item.
  on('classic.Notification', async ($, e, next) => {
    await raiseAutoNeed($, options, e).catch(() => undefined)
    return next(e)
  }).catch(() => undefined)
  // Every tool call about to run (PreToolUse rides `tool.call`): remembered per loop, so a
  // permission prompt can say what it is for. It only notes and passes on — never changes a call.
  on('tool.call', async (_$, e, next) => {
    const key = notePendingCall(e)
    try {
      return await next(e)
    } finally {
      // The call ended (ran, failed or was refused): it no longer explains a prompt.
      if (key) endPendingCallOf(key)
    }
  }).catch(() => undefined)
  on('classic.PostToolUseFailure', async ($, e, next) => {
    await permissionAnswered($, options, e)
    return next(e)
  }).catch(() => undefined)
  on('classic.PermissionDenied', async ($, e, next) => {
    await permissionAnswered($, options, e)
    return next(e)
  }).catch(() => undefined)
  // The turn ended: no permission is pending any more.
  // …and a `doing` task left untouched stops the turn once (`endOfTurnCheck`).
  on('classic.Stop', async ($, e, next) => {
    await clearAutoNeeds($, options, a => a.kind === 'permission').catch(() => undefined)
    const result = await next(e)
    if (result.block) return result
    const block = await endOfTurnCheck($, options, e).catch(() => undefined)
    return block ? { ...result, block } : result
  }).catch(() => undefined)

  on('session.end', async ($, e, next) => {
    await markEnded($, options)
    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const command = parseProgressCommand(e.args)
    if (command.kind === 'doctor') return { text: await doctor($, options) }
    if (command.kind === 'status') return { text: toggleStatus(options) }
    if (command.kind === 'set') {
      await setToggle($, options, command.feature, command.on)
      return {
        text: t('toggle.set', {
          feature: t(`toggle.feature.${command.feature}`),
          state: t(command.on ? 'toggle.on' : 'toggle.off'),
        }),
      }
    }
    if (command.kind === 'recheck') return { text: await forgetCiVerdicts($, options) }
    if (command.kind === 'settings') {
      await updateViewing($, () => 'settings')
      await $.ui.open(paneArgs(options))
      return { text: t('settings.opened') }
    }
    if (command.kind === 'unknown') return { text: t('toggle.usage') }
    await scan($, options)
    await $.ui.open(paneArgs(options))
    return { text: t('command.opened') }
  })

  // The coordinator sends a running agent more work: shown on that agent's row until it picks it up.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    await queueMessage($, options, e).catch(() => undefined)
    return next(e)
  }).catch(() => undefined)

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    await autoLink($, options, fields(e).description).catch(() => undefined)
    const prompt = feedAgentPrompt(options, e as never)
    return next(prompt === undefined ? e : ({ ...e, prompt } as typeof e))
  }).catch(() => undefined)

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    // One entry per session, kept by its main loop: a subagent's report would mix into it.
    // A subagent's report goes to ITS entry under the session (its steps, what it is on, its
    // estimate) — never the session's own tasks, which its coordinator keeps.
    if (!isOn(options, 'reporting')) return { result: t('tool.reportingOff') }
    const agentId = fields(e).agentId
    if (typeof agentId === 'string' && agentId) {
      if (!isOn(options, 'agents')) return { result: t('tool.agentsOff') }
      return { result: await runAgentUpdate($, options, agentId, e as unknown as ToolInput) }
    }
    const input = e as unknown as ToolInput
    // A switched-off part of the call is dropped, and the answer says so.
    const tasksOn = isOn(options, 'tasks')
    const pipelinesOn = isOn(options, 'pipelines')
    const dropped: string[] = []
    if (!tasksOn && (input.tasks?.length || input.order?.length || input.remove?.length))
      dropped.push(t('tool.tasksOff'))
    if (!pipelinesOn && input.watch?.length) dropped.push(t('tool.pipelinesOff'))
    const text = await runUpdate($, options, {
      now: input.now,
      needsYou: input.needsYou,
      tasks: tasksOn ? input.tasks : undefined,
      remove: tasksOn ? input.remove : undefined,
      order: tasksOn ? input.order : undefined,
      eta: input.eta,
      watch: pipelinesOn ? input.watch : undefined,
      unwatch: input.unwatch,
      clearAgents: input.clearAgents,
      dismissAgents: input.dismissAgents,
    })
    return { result: dropped.length ? `${dropped.join('\n')}\n${text}` : text }
  }).catch(() => ({ result: t('tool.failed') }))

  // The transcript: a progress_update call is bookkeeping, not work — one quiet line instead of its
  // whole input and the task list it answered (ctrl+o, an error or an interrupt draw it in full).
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = e.props
    if (row.tool !== TOOL_ID || row.isExpanded || row.isErrored || row.isInterrupted) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{callSummary(row.input as ToolInput | undefined)}</Text>
  })
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const result = e.props
    if (result.tool !== TOOL_ID || result.isExpanded || result.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => renderPane($, e, options))
}
