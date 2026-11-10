// What the plugin asks of the machine it runs on, through `$.process`: which process this session
// is, whether another one still runs, and deleting a file (the plugin API has no delete).

import type { EngineInterface } from 'claude-code'

// The engine's process — a spawned child's parent — and the machine's name. Recorded only when that
// parent is Claude Code itself (`claude` / `node`): a helper in between would die at once and make
// every idle session look dead.
export async function whoAmI($: EngineInterface): Promise<{ pid: number; host: string } | undefined> {
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
        : ['sh', '-c', 'echo $PPID; ps -o comm= -p $PPID; hostname'],
    )
    .catch(() => undefined)
  if (ran?.exitCode !== 0) return undefined
  const [pidText, name, host] = ran.stdout.split(/\r?\n/).map(l => l.trim())
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 1 || !host || !/claude|node/i.test(name ?? '')) return undefined
  return { pid, host: host.toLowerCase() }
}

// Whether a process on this machine is still running (`kill -0`; `tasklist` on Windows).
export async function processAlive($: EngineInterface, pid: number): Promise<boolean | undefined> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const ran = await $.process
    .run(
      windows
        ? ['tasklist', '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']
        : ['sh', '-c', 'kill -0 "$1" 2>/dev/null', 'sh', String(pid)],
    )
    .catch(() => undefined)
  if (!ran) return undefined // cannot tell: never end a session on a guess
  return windows ? ran.stdout.includes(`"${pid}"`) : ran.exitCode === 0
}

// The plugin API has no file delete: the platform's own command removes the file.
export async function deleteFile($: EngineInterface, path: string): Promise<void> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows ? ['cmd', '/c', 'del', '/q', path.replace(/\//g, '\\')] : ['rm', '-f', path]
  await $.process.run(argv).catch(() => undefined)
}
