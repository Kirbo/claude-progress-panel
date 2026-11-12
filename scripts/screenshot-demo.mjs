#!/usr/bin/env node
// Demo status files for the README screenshot (CLAUDE.md "Screenshots"), modelled on a real
// session: node scripts/screenshot-demo.mjs <empty folder>. Times are relative to now — capture
// within a minute, before the demo pane starts polling the "running" pipeline.
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const min = 60_000

/** The demo sessions' files as of `now` (ms): what the script writes, one object per file. */
export function demoFiles(now) {
  const iso = ms => new Date(ms).toISOString()
  const task = (id, title, status, extra = {}, ago = 30) => ({
    id,
    title,
    status,
    createdAt: iso(now - ago * min),
    updatedAt: iso(now - (ago * min) / 2),
    doneAt: status === 'done' ? iso(now - (ago / 3) * min) : null,
    ...extra,
  })
  const step = (id, title, status, ago) => ({
    id,
    title,
    status,
    createdAt: iso(now - ago * min),
    updatedAt: iso(now - (ago * min) / 2),
    doneAt: status === 'done' ? iso(now - (ago / 2) * min) : null,
  })
  const SHA = '4c1d9e07a2b35f6088e1d4c7b9a0f3e2d5c6b7a8'
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
          't7',
          'Review the pipeline adapters',
          'doing',
          { repo: 'claude-progress-panel', agent: 'Review: forge adapters' },
          12,
        ),
        task(
          't5',
          'Beta pipeline for 07a32aff',
          'doing',
          { repo: 'switchboard', note: 'docs only — watching CI' },
          90,
        ),
        task('t6', 'Lift the fnox hold', 'done', { repo: 'switchboard' }, 200),
      ],
      // A subagent at work (under its task) and one that finished (Done → Agents).
      agents: [
        {
          id: 'demo-agent-review',
          label: 'Review: forge adapters',
          now: 'Reading the Gitea adapter',
          tasks: [
            step('t1', 'GitLab adapter', 'done', 10),
            step('t2', 'GitHub adapter', 'done', 8),
            step('t3', 'Gitea / Forgejo adapter', 'doing', 4),
            step('t4', 'Write the findings', 'todo', 4),
          ],
          seq: 4,
          etaMin: 6,
          model: 'claude-sonnet-5-5',
          activity: 'Read — hooks/gitea.ts',
          calls: 23,
          startedAt: iso(now - 12 * min),
          updatedAt: iso(now - min),
          endedAt: null,
        },
        {
          id: 'demo-agent-notes',
          label: 'Draft the release notes',
          now: null,
          tasks: [step('t1', 'Collect the commits', 'done', 50), step('t2', 'Write the notes', 'done', 45)],
          seq: 2,
          model: 'claude-haiku-5',
          calls: 14,
          startedAt: iso(now - 50 * min),
          updatedAt: iso(now - 41 * min),
          endedAt: iso(now - 41 * min),
        },
      ],
      pipelines: [
        // One push, several runs: the commit's row stands for all of them.
        {
          key: `gh:Kirbo/claude-progress-panel@${SHA}:main`,
          provider: 'github',
          project: 'Kirbo/claude-progress-panel',
          id: 9001,
          sha: SHA,
          watchRef: 'main',
          pushed: true,
          label: 'claude-progress-panel main',
          ref: 'main',
          state: 'running',
          url: 'https://github.com/Kirbo/claude-progress-panel/actions/runs/9001',
          addedAt: iso(now - 4 * min),
          checkedAt: iso(now),
          startedAt: iso(now - 200 * 1000),
          runs: [
            {
              id: 9001,
              state: 'running',
              name: 'CI',
              url: 'https://github.com/Kirbo/claude-progress-panel/actions/runs/9001',
            },
            {
              id: 9002,
              state: 'success',
              name: 'Lint',
              url: 'https://github.com/Kirbo/claude-progress-panel/actions/runs/9002',
            },
          ],
          jobs: [
            job('CI / test (linux)', 'CI', 'success', 95),
            job('CI / test (macos)', 'CI', 'running', null, 110),
            job('Lint / biome', 'Lint', 'success', 21),
          ],
        },
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
  return [main, web, docs]
}

// Run as a script (not imported by its test): write the files into the folder given.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: node scripts/screenshot-demo.mjs <empty folder>')
    process.exit(2)
  }
  for (const f of demoFiles(Date.now()))
    writeFileSync(`${dir}/${f.session.id}.json`, `${JSON.stringify(f, null, 2)}\n`)
  console.log('demo files written')
}
