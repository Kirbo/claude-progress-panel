// What a shell command line pushed: the `git push` calls in it (the folder each ran in, the remote
// and refspecs it named), read so the plugin can watch the pipeline a push starts without the agent
// asking. Pure — the I/O (git, the CI files) is register.tsx's.

import type { PipelineProvider } from '../types'

/** One `git push` in a command line. `dir` is relative to where the command ran (cd and -C applied). */
export type PushCall = { dir?: string; remote?: string; refs: string[]; all?: true; tags?: true }

/** A pushed refspec: the local source to read the sha of, and the branch or tag it lands on. */
export type PushedRef = { src: string; name: string; tag: boolean }

// The shell's words and what stands between commands: a separator (&&, ||, ;, |, &, newline) or a
// subshell's parentheses. Quotes are honoured; a redirection (`2>&1`, `> log`, `&>/dev/null`, `<`)
// and its target are no words of the command; a substitution (`$(…)`, backticks) is one literal
// word, never commands of its own; a heredoc's body and a comment are skipped.
type Token = { word: string } | { op: 'sep' | 'open' | 'close' }

// The index of the newline that ends the last pending heredoc's body (the command's end when a
// body never closes). `at` is the newline that ends the line the heredocs were opened on.
function skipHeredocs(command: string, at: number, pending: { word: string; tabs: boolean }[]): number {
  let i = at
  for (const doc of pending) {
    for (;;) {
      if (i >= command.length) return command.length
      const next = command.indexOf('\n', i + 1)
      const line = command.slice(i + 1, next < 0 ? command.length : next)
      i = next < 0 ? command.length : next
      if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.word) break
    }
  }
  return i
}

// A heredoc's opening after `<<` at `i` (the index past both `<`): its delimiter, and where it ends.
function heredocWord(command: string, from: number): { word: string; tabs: boolean; end: number } {
  let i = from
  const tabs = command[i] === '-'
  if (tabs) i += 1
  while (command[i] === ' ' || command[i] === '\t') i += 1
  let word = ''
  for (; i < command.length && !/[\s;&|()<>]/.test(command[i] as string); i += 1)
    if (command[i] !== "'" && command[i] !== '"' && command[i] !== '\\') word += command[i]
  return { word, tabs, end: i }
}

// The index of the `)` that closes the substitution opened just before `from` (the command's end
// when it never closes): quotes, nested parentheses and heredoc bodies inside it are stepped over.
function skipSubstitution(command: string, from: number): number {
  let depth = 1
  const pending: { word: string; tabs: boolean }[] = []
  for (let i = from; i < command.length; i += 1) {
    const c = command[i] as string
    if (c === '\\') i += 1
    else if (c === "'") {
      const close = command.indexOf("'", i + 1)
      if (close < 0) return command.length
      i = close
    } else if (c === '"') {
      for (i += 1; i < command.length && command[i] !== '"'; i += 1) {
        if (command[i] === '\\') i += 1
        else if (command[i] === '$' && command[i + 1] === '(') i = skipSubstitution(command, i + 2)
      }
    } else if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const doc = heredocWord(command, i + 2)
      if (doc.word) pending.push(doc)
      i = doc.end - 1
    } else if (c === '\n' && pending.length > 0) {
      i = skipHeredocs(command, i, pending.splice(0)) - 1
    } else if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return command.length
}

function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let word = ''
  let inWord = false
  let quote: "'" | '"' | undefined
  // A redirection's target is the next word: dropped.
  let dropNext = false
  const pending: { word: string; tabs: boolean }[] = []
  const end = () => {
    if (inWord && !dropNext) tokens.push({ word })
    if (inWord) dropNext = false
    word = ''
    inWord = false
  }
  const boundary = (op: 'sep' | 'open' | 'close') => {
    end()
    dropNext = false
    const last = tokens.at(-1)
    if (op !== 'sep' || (last && !('op' in last && last.op === 'sep'))) tokens.push({ op })
  }
  // `$(…)` from the index past its `(`: taken whole, as the literal text it is.
  const substitution = (from: number): number => {
    const close = skipSubstitution(command, from)
    word += `$(${command.slice(from, close)})`
    inWord = true
    return close
  }
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else if (c === '$' && quote === '"' && command[i + 1] === '(') i = substitution(i + 2)
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (c === '$' && command[i + 1] === '(') i = substitution(i + 2)
    else if (c === '`') {
      const close = command.indexOf('`', i + 1)
      word += command.slice(i, close < 0 ? command.length : close + 1)
      inWord = true
      i = close < 0 ? command.length : close
    } else if (c === ' ' || c === '\t') end()
    else if (c === '#' && !inWord) {
      const eol = command.indexOf('\n', i)
      i = (eol < 0 ? command.length : eol) - 1
    } else if (c === '>' || c === '<' || (c === '&' && command[i + 1] === '>')) {
      // A file descriptor right before the operator (`2>`) belongs to it.
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      } else end()
      if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
        const doc = heredocWord(command, i + 2)
        if (doc.word) pending.push(doc)
        i = doc.end - 1
        continue
      }
      if (c === '&') i += 1
      while (command[i + 1] === '>' || command[i + 1] === '<' || command[i + 1] === '|') i += 1
      if (command[i + 1] === '&') i += 1
      // `<(…)` / `>(…)` is a process substitution: its parentheses follow, no target word.
      dropNext = command[i + 1] !== '('
    } else if (c === '\n' && pending.length > 0) {
      boundary('sep')
      i = skipHeredocs(command, i, pending.splice(0)) - 1
    } else if (c === ';' || c === '|' || c === '&' || c === '\n') boundary('sep')
    else if (c === '(') boundary('open')
    else if (c === ')') boundary('close')
    else {
      word += c
      inWord = true
    }
  }
  end()
  return tokens
}

// The commands of a line, each with the subshell depth change that follows it.
type Segment = { words: string[]; paren?: 'open' | 'close' }

function segments(command: string): Segment[] {
  const out: Segment[] = [{ words: [] }]
  for (const t of tokenize(command)) {
    if ('word' in t) out.at(-1)?.words.push(t.word)
    else {
      if (t.op !== 'sep') (out.at(-1) as Segment).paren = t.op
      out.push({ words: [] })
    }
  }
  return out.filter(s => s.words.length > 0 || s.paren)
}

// An absolute path on any OS: `/…`, `~…`, a drive (`C:/…`, `C:\…`) or a UNC share (`\\host\…`).
function isAbsolute(path: string): boolean {
  return /^([/~]|[A-Za-z]:[\\/]|\\\\)/.test(path)
}

function joinDir(base: string | undefined, next: string): string {
  if (!base || isAbsolute(next)) return next
  return `${base.replace(/\/+$/, '')}/${next}`
}

// git's own options that take a value as the next word.
const GIT_VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
// push's options that take a value as the next word.
const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
// A push that starts no new pipeline worth watching (or none at all).
const PUSH_SKIP = new Set(['-n', '--dry-run', '-d', '--delete', '--mirror', '--prune'])

// Words that may stand before the command itself: shell keywords, a group's brace, wrappers.
const PREFIX_WORDS = new Set([
  '{',
  '}',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  'time',
  'command',
  'exec',
  'env',
  'nohup',
])
// `timeout`'s options that take a value as the next word.
const TIMEOUT_VALUE_OPTIONS = new Set(['-s', '--signal', '-k', '--kill-after'])
// The current branch, asked of git inside the command: what a bare HEAD pushes.
const CURRENT_BRANCH =
  /^\$\(\s*git\s+(branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|symbolic-ref\s+--short\s+HEAD)\s*\)$/
// A push option that tells the forge to start no pipeline for the push.
const SKIP_CI = new Set(['ci.skip', 'ci-skip'])

// Where the command itself starts: past env assignments, shell keywords and wrappers.
function commandStart(words: readonly string[]): number {
  let i = 0
  for (;;) {
    const w = words[i]
    if (w === undefined) return i
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIX_WORDS.has(w)) i += 1
    else if (w === 'timeout') {
      i += 1
      while (words[i]?.startsWith('-')) i += TIMEOUT_VALUE_OPTIONS.has(words[i] as string) ? 2 : 1
      i += 1
    } else return i
  }
}

/** Every `git push` in a command line, in order; dry runs, deletes, mirror and skip-CI pushes are left out. */
export function parsePushes(command: string): PushCall[] {
  const pushes: PushCall[] = []
  let cwd: string | undefined
  // A subshell's `cd` ends with its parentheses.
  const outer: (string | undefined)[] = []
  for (const { words, paren } of segments(command)) {
    const push = pushIn(words, cwd)
    if (push.cwd !== undefined) cwd = push.cwd
    if (push.call) pushes.push(push.call)
    if (paren === 'open') outer.push(cwd)
    else if (paren === 'close' && outer.length > 0) cwd = outer.pop()
  }
  return pushes
}

// One command: the folder a `cd` moves to, or the push it is.
function pushIn(words: readonly string[], cwd: string | undefined): { cwd?: string; call?: PushCall } {
  let i = commandStart(words)
  const head = words[i]
  if (head === 'cd' || head === 'pushd') {
    // `cd /d <dir>` (cmd's drive switch) names its folder after the flag.
    const target = words[i + 1] === '/d' || words[i + 1] === '/D' ? words[i + 2] : words[i + 1]
    return target !== undefined ? { cwd: joinDir(cwd, target) } : {}
  }
  if (head !== 'git' && head !== 'git.exe') return {}
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
  if (words[i] !== 'push') return {}
  const call: PushCall = { refs: [] }
  let skip = false
  const positional: string[] = []
  for (let k = i + 1; k < words.length; k += 1) {
    const w = words[k] as string
    if (!w.startsWith('-') || w === '-') {
      positional.push(CURRENT_BRANCH.test(w) ? 'HEAD' : w)
      continue
    }
    const eq = w.indexOf('=')
    const name = eq < 0 ? w : w.slice(0, eq)
    if (PUSH_SKIP.has(name)) skip = true
    else if (name === '--all' || name === '--branches') call.all = true
    else if (name === '--tags') call.tags = true
    if (name === '-o' || name === '--push-option') {
      if (SKIP_CI.has(eq < 0 ? (words[k + 1] ?? '') : w.slice(eq + 1))) skip = true
    }
    if (PUSH_VALUE_OPTIONS.has(w)) k += 1
  }
  const [remote, ...refs] = positional
  if (refs.some(r => r.startsWith(':'))) skip = true
  if (skip) return {}
  return {
    call: {
      ...(dir !== undefined ? { dir } : {}),
      ...(remote !== undefined ? { remote } : {}),
      refs,
      ...(call.all ? { all: true as const } : {}),
      ...(call.tags ? { tags: true as const } : {}),
    },
  }
}

/** A refspec (`main`, `+HEAD:refs/heads/next`, `refs/tags/v1`) → what is pushed; undefined for a delete. */
export function pushedRef(refspec: string): PushedRef | undefined {
  const spec = refspec.replace(/^\+/, '')
  const colon = spec.indexOf(':')
  const src = colon < 0 ? spec : spec.slice(0, colon)
  const dst = colon < 0 ? spec : spec.slice(colon + 1) || src
  // No source (a delete), or one git would read as an option.
  if (!src || src.startsWith('-')) return undefined
  const tag = dst.startsWith('refs/tags/')
  const name = dst.replace(/^refs\/(heads|tags)\//, '')
  return { src, name, tag }
}

/** Where a push ran: the command's folder, with the push's own `cd` / `-C` applied (`~/` = home). */
export function resolvePath(base: string, rel: string | undefined, home: string | undefined): string {
  const slashes = (p: string) => p.replace(/\\/g, '/')
  let path = slashes(rel ?? base)
  if (path === '~' || path.startsWith('~/')) path = `${slashes(home ?? '')}${path.slice(1)}`
  else if (!isAbsolute(path)) path = `${slashes(base).replace(/\/+$/, '')}/${path}`
  // A drive (`C:`) or a UNC share (`//host`) is kept as the root; everything else is POSIX.
  const root = /^[A-Za-z]:/.exec(path)?.[0] ?? (path.startsWith('//') ? '/' : '')
  const parts: string[] = []
  for (const part of path.slice(root.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${root}/${parts.join('/')}`
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
