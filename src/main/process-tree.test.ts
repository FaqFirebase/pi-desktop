import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { once } from 'node:events'
import { PiRpcManager } from './pi-rpc-manager'

/**
 * OMP puts each subagent it spawns in a new process group, so the negative-PID
 * signal the manager sends only reaches the agent itself. Observed live: the
 * app exited, its own OMP died, and two `hub` subagents kept running against
 * the API. Reaping needs the tree captured before the parent is signalled,
 * because re-parenting to init erases the link the moment it dies.
 */

const IS_WINDOWS = process.platform === 'win32'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reach the private walker without widening the class's public surface. */
function walk(manager: PiRpcManager, root: number): number[] {
  return (manager as unknown as { descendantPids: (pid: number) => number[] }).descendantPids(root)
}

async function detachedTree(): Promise<{ parent: ChildProcess; child: number }> {
  const parent = spawn(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(
      process.execPath, ['-e', 'process.on("message", () => {})'],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    )
    child.on('spawn', () => process.send(child.pid))
    child.on('exit', () => process.send('exited'))
    process.on('message', () => {})
  `], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  try {
    const [pid] = await once(parent, 'message', { signal: AbortSignal.timeout(5000) })
    assert.equal(typeof pid, 'number')
    return { parent, child: pid as number }
  } catch (error) {
    parent.kill('SIGKILL')
    throw error
  }
}

function killTree(parent: ChildProcess, child: number): void {
  // Capture the child's PID before stopping its parent: reparenting loses it.
  try { process.kill(child, 'SIGKILL') } catch { /* gone */ }
  if (parent.pid) {
    try { process.kill(-parent.pid, 'SIGKILL') } catch { /* gone */ }
  }
}

test('a grandchild in its own process group is still found', { skip: IS_WINDOWS }, async () => {
  const { parent, child } = await detachedTree()
  try {
    assert.ok(parent.pid, 'parent must have a pid')
    assert.ok(walk(new PiRpcManager(), parent.pid).includes(child))
    const group = spawnSync('ps', ['-o', 'pgid=', '-p', String(child)], { encoding: 'utf-8' })
    assert.equal(group.status, 0, group.stderr)
    assert.equal(Number(group.stdout.trim()), child, 'the descendant owns a separate process group')
    assert.notEqual(child, parent.pid)
  } finally {
    killTree(parent, child)
  }
})

test('an escaped descendant is signalled directly and dies', { skip: IS_WINDOWS }, async () => {
  const { parent, child } = await detachedTree()
  try {
    assert.ok(parent.pid, 'parent must have a pid')
    const strays = walk(new PiRpcManager(), parent.pid)
    assert.ok(strays.includes(child))
    const childExit = once(parent, 'message', { signal: AbortSignal.timeout(5000) })
    for (const pid of strays) process.kill(pid, 'SIGTERM')
    const [message] = await childExit
    assert.equal(message, 'exited')
    const parentExit = once(parent, 'exit')
    process.kill(-parent.pid, 'SIGTERM')
    await parentExit
    assert.equal(alive(child), false, 'the detached descendant must not survive')
    assert.equal(alive(parent.pid), false, 'the agent itself must not survive either')
  } finally {
    killTree(parent, child)
  }
})

test('a childless process yields no descendants', { skip: IS_WINDOWS }, async () => {
  // Not process.pid: the walker shells out to `ps`, so its own transient child
  // shows up under the test runner. An agent pid never parents that call.
  const lonely = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  try {
    assert.ok(lonely.pid)
    await settle(300)
    assert.deepEqual(walk(new PiRpcManager(), lonely.pid!), [])
  } finally {
    try { process.kill(-lonely.pid!, 'SIGKILL') } catch { /* gone */ }
  }
})

test('the walk terminates on an unknown pid', { skip: IS_WINDOWS }, () => {
  assert.deepEqual(walk(new PiRpcManager(), 999_999_999), [])
})
