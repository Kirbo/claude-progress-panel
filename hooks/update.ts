// "Is there a newer panel?" — the newest GitLab Release of the plugin's own repository (its
// manifest's `repository`), compared with the version it runs.

const json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const parts = (version: string): number[] | undefined => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

/** Whether `candidate` is a later version than `current` (major.minor.patch, an optional `v`). */
export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate)
  const b = parts(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/** A GitLab repository URL → the API call answering its newest release (releases are listed newest first). */
export function latestReleaseUrl(repository: string): string | undefined {
  const m = /^(https?:\/\/[^/]+)\/(.+?)(?:\.git)?\/*$/.exec(repository.trim())
  if (!m) return undefined
  return `${m[1]}/api/v4/projects/${encodeURIComponent(m[2] ?? '')}/releases?per_page=1`
}

/** The releases API's answer → the newest release's version (no `v`) and its page. */
export function parseLatestRelease(text: string): { version: string; url: string } | undefined {
  const raw = json(text)
  const r = (Array.isArray(raw) ? raw[0] : undefined) as Record<string, unknown> | undefined
  const tag = typeof r?.tag_name === 'string' ? r.tag_name : undefined
  const links = r?._links as Record<string, unknown> | undefined
  const url = typeof links?.self === 'string' ? links.self : undefined
  return tag && url ? { version: tag.replace(/^v/, ''), url } : undefined
}
