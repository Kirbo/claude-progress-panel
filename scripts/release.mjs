#!/usr/bin/env node
// GitLab Releases for the plugin's versions (CI, on main). A version is the `version` in
// .claude-plugin/plugin.json; it is released from the commit that first carried it. Every version
// without a `v<version>` tag yet gets its Release — the first run backfills them all, oldest
// first — with this version's changes as the notes: git-cliff (cliff.toml) over the commits since
// the previous version's bump. The Release creates its tag; the job's own token creates it, so
// nothing here needs a secret. `--dry-run` prints the plan and the notes instead.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MANIFEST = '.claude-plugin/plugin.json'

/** `history` oldest first ({ sha, date, version }) → the first commit of each new version. */
export function versionBumps(history) {
  const bumps = []
  for (const c of history) {
    if (!c.version || bumps.some(b => b.version === c.version)) continue
    bumps.push({ version: c.version, sha: c.sha, date: c.date })
  }
  return bumps
}

/** The bumps with no `v<version>` tag yet, each with the previous bump's commit as `from`. */
export function releasePlan(bumps, tags) {
  return bumps
    .map((b, i) => ({ ...b, from: i > 0 ? bumps[i - 1].sha : null }))
    .filter(b => !tags.has(`v${b.version}`))
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout
}

function history() {
  const commits = run('git', ['log', '--reverse', '--format=%H %cI', '--', MANIFEST])
    .trim()
    .split('\n')
    .filter(Boolean)
  return commits.map(line => {
    const [sha, date] = line.split(' ')
    let version
    try {
      version = JSON.parse(run('git', ['show', `${sha}:${MANIFEST}`])).version
    } catch {
      version = undefined
    }
    return { sha, date, version }
  })
}

function notes(release) {
  const root = run('git', ['rev-list', '--max-parents=0', release.sha]).trim().split('\n')[0]
  const range = `${release.from ?? root}..${release.sha}`
  // A range leaves out its start, so the first version adds the root commit by its message.
  const first = release.from ? [] : ['--with-commit', run('git', ['log', '-1', '--format=%s', root]).trim()]
  const text = run('git-cliff', [
    '--config',
    'cliff.toml',
    '--tag',
    `v${release.version}`,
    ...first,
    range,
  ]).trim()
  return text || '_No user-facing changes._'
}

async function publish(release, description) {
  const { CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN } = process.env
  if (!CI_API_V4_URL || !CI_PROJECT_ID || !CI_JOB_TOKEN)
    throw new Error('not in GitLab CI (CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN)')
  const res = await fetch(`${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/releases`, {
    method: 'POST',
    headers: { 'JOB-TOKEN': CI_JOB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `v${release.version}`,
      tag_name: `v${release.version}`,
      ref: release.sha,
      description,
      released_at: release.date,
    }),
  })
  if (!res.ok) throw new Error(`release v${release.version}: HTTP ${res.status} ${await res.text()}`)
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const tags = new Set(run('git', ['tag', '--list', 'v*']).trim().split('\n').filter(Boolean))
  const plan = releasePlan(versionBumps(history()), tags)
  if (plan.length === 0) return console.log('release: every version is released')
  for (const release of plan) {
    const description = notes(release)
    if (dryRun) {
      console.log(`## v${release.version} (${release.sha.slice(0, 8)}, ${release.date})\n${description}\n`)
      continue
    }
    await publish(release, description)
    console.log(`release: v${release.version} at ${release.sha.slice(0, 8)}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
