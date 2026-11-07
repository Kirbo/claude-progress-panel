#!/usr/bin/env node
// Demo status files for the README screenshot (CLAUDE.md "Screenshots"), modelled on a real
// session: node scripts/screenshot-demo.mjs <empty folder>. Times are relative to now — capture
// within a minute, before the demo pane starts polling the "running" pipeline.
import { writeFileSync } from 'node:fs'

const dir = process.argv[2]
const now = Date.now()
const iso = ms => new Date(ms).toISOString()
const min = 60_000
const task = (id, title, status, extra = {}, ago = 30) => ({
  id,
  title,
  status,
  createdAt: iso(now - ago * min),
  updatedAt: iso(now - (ago * min) / 2),
  doneAt: status === 'done' ? iso(now - (ago / 3) * min) : null,
  ...extra,
})
const job = (name, stage, state, durationS = null, startedAgoS) => ({
  name,
  stage,
  state,
  durationS,
  ...(startedAgoS ? { startedAt: iso(now - startedAgoS * 1000) } : {}),
  url: 'https://gitlab.com/KirboDev/agentic-coding/switchboard/-/jobs/1',
})
const file = (session, rest) => ({
  version: 2,
  session,
  now: null,
  needsYou: [],
  tasks: [],
  dismissed: [],
  seq: 20,
  updatedAt: iso(now - min),
  pipelines: [],
  ...rest,
})
const main = file(
  {
    id: 'demo-main',
    project: 'switchboard',
    title: 'Switchboard + Panel',
    cwd: '/home/me/Projects/switchboard',
    startedAt: iso(now - 300 * min),
    endedAt: null,
  },
  {
    now: 'Panel 0.14.0 ready; README screenshots, then push',
    needsYou: ['Push claude-progress-panel 0.14.0 to main?'],
    updatedAt: iso(now - 2 * min),
    tasks: [
      task(
        't1',
        'README screenshots',
        'doing',
        {
          repo: 'claude-progress-panel',
          detail: 'Headless tmux capture of demo data, rendered with freeze.',
          steps: [
            { title: 'demo data', status: 'done' },
            { title: 'capture', status: 'doing' },
            { title: 'README', status: 'todo' },
          ],
        },
        20,
      ),
      task('t2', 'Gitea / Forgejo Actions adapter', 'done', { repo: 'claude-progress-panel' }, 60),
      task('t3', 'Release notes from git-cliff', 'done', { repo: 'claude-progress-panel' }, 40),
      task('t4', 'Push 0.14.0, watch CI, install', 'todo', { repo: 'claude-progress-panel' }, 10),
      task(
        't5',
        'Beta pipeline for 07a32aff',
        'doing',
        { repo: 'switchboard', note: 'docs only — watching CI' },
        90,
      ),
      task('t6', 'Lift the fnox hold', 'done', { repo: 'switchboard' }, 200),
    ],
    pipelines: [
      {
        key: 'KirboDev/agentic-coding/switchboard#3040407974',
        project: 'KirboDev/agentic-coding/switchboard',
        id: 3040407974,
        label: 'switchboard',
        ref: 'next',
        state: 'running',
        source: 'push',
        url: 'https://gitlab.com/KirboDev/agentic-coding/switchboard/-/pipelines/3040407974',
        addedAt: iso(now - 10 * min),
        checkedAt: iso(now),
        startedAt: iso(now - 393 * 1000),
        estimateS: 1110,
        jobs: [
          job('build-image:linux:amd64', 'images', 'success', 78),
          job('build-image:windows:arm64', 'images', 'success', 70),
          job('check:frontend', 'verify', 'success', 160),
          job('check:rust', 'verify', 'running', null, 120),
          job('e2e:linux:arm64', 'verify', 'running', null, 60),
          job('build:linux:amd64', 'build', 'queued'),
          job('build:macos:universal', 'build', 'queued'),
          job('release', 'release', 'skipped'),
        ],
      },
      {
        key: 'KirboDev/agentic-coding/claude-progress-panel@f13ad13e',
        project: 'KirboDev/agentic-coding/claude-progress-panel',
        id: 3039611200,
        sha: 'f13ad13e',
        label: 'panel 0.13.1',
        ref: 'main',
        state: 'success',
        source: 'push',
        url: 'https://gitlab.com/KirboDev/agentic-coding/claude-progress-panel/-/pipelines/3039611200',
        addedAt: iso(now - 25 * min),
        checkedAt: iso(now - 23 * min),
        startedAt: iso(now - 25 * min),
        pipelineFinishedAt: iso(now - 24 * min),
        finishedAt: iso(now - 24 * min),
        durationS: 69,
        jobs: [job('check', 'test', 'success', 61), job('release', 'release', 'success', 8)],
      },
    ],
  },
)
const web = file(
  {
    id: 'demo-web',
    project: 'web',
    cwd: '/home/me/Projects/web',
    startedAt: iso(now - 90 * min),
    endedAt: null,
  },
  {
    now: 'Refactoring the settings view',
    updatedAt: iso(now - 6 * min),
    tasks: [
      task('t1', 'Split SettingsView into sections', 'doing', {}, 50),
      task('t2', 'Keyboard shortcuts page', 'todo', {}, 40),
      task('t3', 'Dark-mode tokens', 'done', {}, 80),
    ],
  },
)
const docs = file(
  {
    id: 'demo-docs',
    project: 'docs',
    cwd: '/home/me/Projects/docs',
    startedAt: iso(now - 400 * min),
    endedAt: iso(now - 150 * min),
  },
  {
    updatedAt: iso(now - 150 * min),
    tasks: [
      task('t1', 'Rewrite the install guide', 'done', {}, 300),
      task('t2', 'Screenshots for 2026.11', 'done', {}, 280),
    ],
  },
)
for (const f of [main, web, docs])
  writeFileSync(`${dir}/${f.session.id}.json`, `${JSON.stringify(f, null, 2)}\n`)
console.log('demo files written')
