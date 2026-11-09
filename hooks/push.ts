// What a shell command line pushed: the `git push` calls in it (the folder each ran in, the remote
// and refspecs it named), read so the plugin can watch the pipeline a push starts without the agent
// asking. Pure — the I/O (git, the CI files) is register.tsx's.

import type { PipelineProvider } from '../types'

/** One `git push` in a command line. `dir` is relative to where the command ran (cd and -C applied). */
export type PushCall = { dir?: string; remote?: string; refs: string[]; all?: true; tags?: true }

/** A pushed refspec: the local source to read the sha of, and the branch or tag it lands on. */
export type PushedRef = { src: string; name: string; tag: boolean }

// The shell's words and the operators between commands (&&, ||, ;, |, &, newline), quotes honoured.
type Token = { word: string } | { op: true }

function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let word = ''
  let inWord = false
  let quote: "'" | '"' | undefined
  const end = () => {
    if (inWord) tokens.push({ word })
    word = ''
    inWord = false
  }
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (c === ' ' || c === '\t') end()
    else if (c === ';' || c === '|' || c === '&' || c === '\n') {
      end()
      if (tokens.at(-1) && !('op' in (tokens.at(-1) as Token))) tokens.push({ op: true })
    } else {
      word += c
      inWord = true
    }
  }
  end()
  return tokens
}

function segments(command: string): string[][] {
  const out: string[][] = [[]]
  for (const t of tokenize(command)) {
    if ('op' in t) out.push([])
    else out.at(-1)?.push(t.word)
  }
  return out.filter(s => s.length > 0)
}

function joinDir(base: string | undefined, next: string): string {
  if (!base || next.startsWith('/') || next.startsWith('~')) return next
  return `${base.replace(/\/+$/, '')}/${next}`
}

// git's own options that take a value as the next word.
const GIT_VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
// push's options that take a value as the next word.
const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
// A push that starts no new pipeline worth watching (or none at all).
const PUSH_SKIP = new Set(['-n', '--dry-run', '-d', '--delete', '--mirror', '--prune'])

/** Every `git push` in a command line, in order; dry runs, deletes and mirror pushes are left out. */
export function parsePushes(command: string): PushCall[] {
  const pushes: PushCall[] = []
  let cwd: string | undefined
  for (const words of segments(command)) {
    let i = 0
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i += 1
    const head = words[i]
    if (head === 'cd' && words[i + 1] !== undefined) {
      cwd = joinDir(cwd, words[i + 1] as string)
      continue
    }
    if (head !== 'git') continue
    i += 1
    let dir = cwd
    while (i < words.length && (words[i] as string).startsWith('-')) {
      const opt = words[i] as string
      if (opt === '-C' && words[i + 1] !== undefined) {
        dir = joinDir(dir, words[i + 1] as string)
        i += 2
      } else if (GIT_VALUE_OPTIONS.has(opt)) i += 2
      else i += 1
    }
    if (words[i] !== 'push') continue
    const call: PushCall = { refs: [] }
    let skip = false
    const positional: string[] = []
    for (let k = i + 1; k < words.length; k += 1) {
      const w = words[k] as string
      if (!w.startsWith('-') || w === '-') {
        positional.push(w)
        continue
      }
      const name = w.includes('=') ? w.slice(0, w.indexOf('=')) : w
      if (PUSH_SKIP.has(name)) skip = true
      else if (name === '--all' || name === '--branches') call.all = true
      else if (name === '--tags') call.tags = true
      else if (PUSH_VALUE_OPTIONS.has(w)) k += 1
    }
    const [remote, ...refs] = positional
    if (refs.some(r => r.startsWith(':'))) skip = true
    if (skip) continue
    pushes.push({
      ...(dir !== undefined ? { dir } : {}),
      ...(remote !== undefined ? { remote } : {}),
      refs,
      ...(call.all ? { all: true as const } : {}),
      ...(call.tags ? { tags: true as const } : {}),
    })
  }
  return pushes
}

/** A refspec (`main`, `+HEAD:refs/heads/next`, `refs/tags/v1`) → what is pushed; undefined for a delete. */
export function pushedRef(refspec: string): PushedRef | undefined {
  const spec = refspec.replace(/^\+/, '')
  const colon = spec.indexOf(':')
  const src = colon < 0 ? spec : spec.slice(0, colon)
  const dst = colon < 0 ? spec : spec.slice(colon + 1) || src
  if (!src) return undefined
  const tag = dst.startsWith('refs/tags/')
  const name = dst.replace(/^refs\/(heads|tags)\//, '')
  return { src, name, tag }
}

/** Where a push ran: the command's folder, with the push's own `cd` / `-C` applied (`~/` = home). */
export function resolvePath(base: string, rel: string | undefined, home: string | undefined): string {
  let path = rel ?? base
  if (path === '~' || path.startsWith('~/')) path = `${home ?? ''}${path.slice(1)}`
  else if (!path.startsWith('/')) path = `${base.replace(/\/+$/, '')}/${path}`
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** The CI a repository runs, by the files it carries (else the person's custom command, else none). */
export function ciProvider(
  files: { gitlab: boolean; github: boolean; gitea: boolean },
  hasCommand: boolean,
): PipelineProvider | undefined {
  if (files.gitlab) return 'gitlab'
  if (files.github) return 'github'
  if (files.gitea) return 'gitea'
  return hasCommand ? 'command' : undefined
}
