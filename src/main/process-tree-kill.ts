import { ChildProcess, spawn, spawnSync } from 'child_process'

const IS_WINDOWS = process.platform === 'win32'
/** Delay before a stopped child that is still alive gets the forced kill. */
export const FORCE_KILL_TIMEOUT_MS = 3_000
/** Bound on the one `ps` call used to snapshot a child's descendants at kill time. */
const PROCESS_TREE_TIMEOUT_MS = 2_000
/** Signal 0 only tests whether the target exists and can be signalled. */
const PROBE_SIGNAL = 0
const TASKKILL_COMMAND = 'taskkill'
const TASKKILL_EXIT_OK = 0

/** A process that has been asked to stop and may still need the forced kill. */
interface StoppingProcessTree {
  proc: ChildProcess
  pid: number
  /** Descendants found before the stop (POSIX); empty on Windows. */
  strays: number[]
  timer: ReturnType<typeof setTimeout>
}

/**
 * Module-wide, so a quit reaches the trees of managers already dropped by a
 * closed tab or an ended query, not only the ones still in use.
 */
const stoppingTrees = new Set<StoppingProcessTree>()

/** True once the child has exited, however it was signalled. */
export function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

/**
 * True while `target` (a pid, or a negative process-group id) names at least
 * one process this app may signal. EPERM means the id now belongs to another
 * user's process, which must never be signalled.
 */
function processExists(target: number): boolean {
  try {
    process.kill(target, PROBE_SIGNAL)
    return true
  } catch {
    return false
  }
}

/**
 * PIDs descended from `root`, children before grandchildren.
 *
 * A negative-PID signal only reaches the killed process's own group, and OMP
 * puts each subagent it spawns in a new group, so `hub` fan-out survives the
 * parent dying: the app exits, the subagents are re-parented to init, and
 * they keep running and keep billing. They have to be enumerated before the
 * parent is signalled, because re-parenting erases the link immediately.
 *
 * POSIX only: on Windows `taskkill /T` walks the tree itself.
 */
export function descendantPids(root: number): number[] {
  if (IS_WINDOWS) return []
  const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf-8', timeout: PROCESS_TREE_TIMEOUT_MS })
  if (result.status !== 0 || typeof result.stdout !== 'string') return []

  const childrenByParent = new Map<number, number[]>()
  for (const line of result.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    const siblings = childrenByParent.get(ppid)
    if (siblings) siblings.push(pid)
    else childrenByParent.set(ppid, [pid])
  }

  const found: number[] = []
  const queue = [root]
  // Breadth-first with a seen set: a malformed table must not loop forever.
  const seen = new Set<number>([root])
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/** Arguments that make taskkill end `pid` and every process it started. */
export function windowsTreeKillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F']
}

/**
 * Windows has no process groups and no graceful signal: Node's SIGTERM there
 * is TerminateProcess on the one child, which leaves the processes it started
 * (the engine behind a cmd.exe shim, its subagents and tools) running. taskkill
 * /T finds them by parent id, so it must run while the child is still alive.
 * If taskkill cannot run or fails, the child itself is still ended.
 */
function killWindowsTree(proc: ChildProcess, pid: number): void {
  const fallback = (): void => {
    if (!hasExited(proc)) {
      try { proc.kill() } catch { /* already gone */ }
    }
  }
  try {
    const killer = spawn(TASKKILL_COMMAND, windowsTreeKillArgs(pid), { stdio: 'ignore', windowsHide: true })
    killer.once('error', fallback)
    killer.once('exit', (code) => {
      if (code !== TASKKILL_EXIT_OK) fallback()
    })
  } catch {
    fallback()
  }
}

/**
 * The forced kill. On POSIX it signals the process group while any member is
 * still alive (a same-group tool child that ignored SIGTERM outlives the
 * leader), and each stray that still exists. A group id cannot be handed to a
 * new process while one member of the group lives, so the group signal is
 * safe; a stray pid is checked just before its signal, which leaves only the
 * short window between the check and the signal for the pid to be reused.
 */
function forceKillTree(tree: StoppingProcessTree): void {
  clearTimeout(tree.timer)
  stoppingTrees.delete(tree)
  if (IS_WINDOWS) {
    if (!hasExited(tree.proc)) killWindowsTree(tree.proc, tree.pid)
    return
  }
  if (processExists(-tree.pid)) {
    try { process.kill(-tree.pid, 'SIGKILL') } catch { /* group just ended */ }
  }
  // Covers a child that is not a group leader. The exit state is set when the
  // child is reaped, so an unexited child's pid is still its own.
  if (!hasExited(tree.proc)) {
    try { tree.proc.kill('SIGKILL') } catch { /* already gone */ }
  }
  for (const stray of tree.strays) {
    if (!processExists(stray)) continue
    try { process.kill(stray, 'SIGKILL') } catch { /* already gone */ }
  }
}

/**
 * Ask `proc` and every process it started to stop, then force-kill whatever
 * is still alive after FORCE_KILL_TIMEOUT_MS. The child must have been spawned
 * as its own process-group leader on POSIX.
 */
export function stopProcessTree(proc: ChildProcess): void {
  const pid = proc.pid
  if (pid === undefined) return
  // An exited child's pid may already belong to another process. Its group
  // can still hold tool children, but on Windows nothing is left to walk.
  const exited = hasExited(proc)
  if (exited && (IS_WINDOWS || !processExists(-pid))) return

  // Snapshot the tree before signalling: once the parent dies its children
  // are re-parented to init and can no longer be found from this pid.
  const strays = exited ? [] : descendantPids(pid)
  if (IS_WINDOWS) {
    killWindowsTree(proc, pid)
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      if (!exited) {
        try { proc.kill('SIGTERM') } catch { /* already gone */ }
      }
    }
    // Subagents sit in their own groups, so the group signal above misses
    // them. Signal each directly; ESRCH just means it already exited.
    for (const stray of strays) {
      try { process.kill(stray, 'SIGTERM') } catch { /* already gone */ }
    }
  }

  const tree: StoppingProcessTree = {
    proc,
    pid,
    strays,
    timer: setTimeout(() => forceKillTree(tree), FORCE_KILL_TIMEOUT_MS),
  }
  stoppingTrees.add(tree)
}

/**
 * Run the forced kill now for every tree still waiting for it. A quit calls
 * this after the stop wait, so a process that outlived its leader does not
 * survive the app because the force-kill timer had not fired yet.
 */
export function forceKillStoppingProcessTrees(): void {
  for (const tree of [...stoppingTrees]) forceKillTree(tree)
}
