// Which forge host a watched pipeline lives on: read off the session's `origin` remote, or given
// with the watch. Every forge call names its host (`--hostname`), so a call never depends on the
// directory it runs in — another session's pane polls in its own repo.

import type { PipelineProvider } from '../types'

export type Remote = { host: string; path: string }

// The forges' ssh-only names, and the web host their API answers on.
const SSH_ALIASES: Record<string, string> = {
  'ssh.github.com': 'github.com',
  'altssh.gitlab.com': 'gitlab.com',
}

const DEFAULT_HOST: Partial<Record<PipelineProvider, string>> = { gitlab: 'gitlab.com', github: 'github.com' }

/**
 * A git remote URL → its forge host and repository path; undefined for a local path, a `file://`
 * URL or an ssh config alias (a host without a dot names no forge the CLIs could reach).
 */
export function parseRemote(url: string | null | undefined): Remote | undefined {
  const text = (url ?? '').trim()
  if (!text) return undefined
  let host: string
  let path: string
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::(\d+))?\/(.*)$/i.exec(text)
  if (scheme) {
    const [, protocol = '', name = '', port, rest = ''] = scheme
    if (protocol.toLowerCase() === 'file') return undefined
    const isWeb = /^https?$/i.test(protocol)
    host = name.toLowerCase() + (isWeb && port ? `:${port}` : '')
    path = rest
  } else {
    // scp-like `user@host:path` (no scheme); a path with a `/` before any `:` is a local one.
    const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(text)
    if (!scp) return undefined
    host = (scp[1] ?? '').toLowerCase()
    path = scp[2] ?? ''
  }
  host = SSH_ALIASES[host] ?? host
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '')
  if (!host.includes('.') || !path) return undefined
  return { host, path }
}

/** A host as a person or agent may write it (`https://Git.Example.com/`) → `git.example.com`. */
function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** The host a new watch is on: the one given, else the remote's when the watch is that repo. */
export function watchHost(
  given: string | undefined,
  project: string,
  remote: Remote | undefined,
): string | undefined {
  const host = given === undefined ? '' : normalizeHost(given)
  if (host) return host
  if (remote && remote.path.toLowerCase() === project.toLowerCase()) return remote.host
  return undefined
}

/** The public host of a forge, when it has one. */
export function defaultHost(provider: PipelineProvider): string | undefined {
  return DEFAULT_HOST[provider]
}

/** The host a stored pipeline's calls go to: its own, else its forge's public one. */
export function apiHost(p: { provider?: PipelineProvider; host?: string }): string | undefined {
  return p.host ?? defaultHost(p.provider ?? 'gitlab')
}
