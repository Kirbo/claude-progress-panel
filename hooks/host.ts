// What the plugin asks of the machine it runs on, through `$.process`: which process this session
// is, whether another one still runs, and deleting a file (the plugin API has no delete).

import type { EngineInterface } from 'claude-code'

// When process `$1`-style `pid` started, as one line of sh: its start in clock ticks since boot
// (Linux: field 22 of /proc/<pid>/stat, read past the name, which may hold spaces — the same for as
// long as the process lives, whatever the clock or the locale does), else `ps`'s start time (macOS,
// the BSDs) in one fixed locale and time zone. Empty when neither can tell.
const startOf = (pid: string) =>
  `s=$(sed "s/.*) //" /proc/${pid}/stat 2>/dev/null | cut -d" " -f20); ` +
  `[ -n "$s" ] || s=$(LC_ALL=C TZ=UTC0 ps -o lstart= -p ${pid} 2>/dev/null); echo $s`

/** `sh -c` script: the parent's pid, its name, this machine's name, and when that parent started. */
export const WHO_AM_I = `echo $PPID; ps -o comm= -p $PPID; uname -n; ${startOf('$PPID')}`

/** `sh -c` script (`$1` = a pid): fails when no such process runs, else prints when it started. */
export const STILL_RUNS = `kill -0 "$1" 2>/dev/null || exit 1; ${startOf('"$1"')}`

// The engine's process — a spawned child's parent — the machine's name, and when that process
// started. Recorded only when that parent is Claude Code itself (`claude` / `node`): a helper in
// between would die at once and make every idle session look dead. The machine's name is `uname -n`
// (POSIX; `hostname` is not installed on every minimal system, and without it nothing was recorded).
export async function whoAmI(
  $: EngineInterface,
): Promise<{ pid: number; host: string; pidStart?: string } | undefined> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const ran = await $.process
    .run(
      windows
        ? [
            'powershell',
            '-NoProfile',
            '-Command',
            '$p = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId; $p; (Get-Process -Id $p).ProcessName; hostname',
          ]
        : ['sh', '-c', WHO_AM_I],
    )
    .catch(() => undefined)
  if (ran?.exitCode !== 0) return undefined
  const [pidText, name, host, start] = ran.stdout.split(/\r?\n/).map(l => l.trim())
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 1 || !host || !/claude|node/i.test(name ?? '')) return undefined
  return { pid, host: host.toLowerCase(), ...(start && isPidStart(start) ? { pidStart: start } : {}) }
}

/** A recorded process start: one short line (a tick count, or `ps`'s date). It is only ever compared. */
export function isPidStart(value: unknown): value is string {
  return typeof value === 'string' && /^[\w :.+-]{1,64}$/.test(value)
}

// Whether a process on this machine is still running (`kill -0`; `tasklist` on Windows) — and, when
// its session recorded when it started (`pidStart`), whether it is still THAT process: after a
// reboot, or once the pid has been handed out again, a number alone says "alive" for a stranger.
// A start that cannot be read now decides nothing (the pid is taken at its word, as before).
// Windows compares the pid only (no start is recorded there).
export async function processAlive(
  $: EngineInterface,
  pid: number,
  pidStart?: string,
): Promise<boolean | undefined> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const ran = await $.process
    .run(
      windows
        ? ['tasklist', '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']
        : ['sh', '-c', STILL_RUNS, 'sh', String(pid)],
    )
    .catch(() => undefined)
  if (!ran) return undefined // cannot tell: never end a session on a guess
  if (windows) return ran.stdout.includes(`"${pid}"`)
  if (ran.exitCode !== 0) return false
  const startedNow = ran.stdout.trim()
  return !pidStart || !startedNow || startedNow === pidStart
}

/** A path `cmd /c del` would read as more than a path: `cmd` parses its line again, so `&`, `|`,
 *  `<`, `>`, `^`, `%`, `!`, a quote or a line break in it ends the `del` or expands inside it. */
export function isUnsafeForCmd(path: string): boolean {
  return /[&|<>^%!"\r\n]/.test(path)
}

// The plugin API has no file delete: the platform's own command removes the file. On Windows a path
// `cmd` would not read as one path (`isUnsafeForCmd` — a profile folder named "R&D") is never handed
// to it: the file stays (an ended session's row comes back at the next scan), nothing else runs.
export async function deleteFile($: EngineInterface, path: string): Promise<void> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  if (isWindows && isUnsafeForCmd(path)) return
  const argv = isWindows ? ['cmd', '/c', 'del', '/q', path.replace(/\//g, '\\')] : ['rm', '-f', path]
  await $.process.run(argv).catch(() => undefined)
}
