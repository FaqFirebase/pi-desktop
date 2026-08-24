import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'child_process'
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

test('a grandchild in its own process group is still found', { skip: IS_WINDOWS }, async () => {
  // Parent sleeps; child detaches into a NEW group, exactly like an OMP
  // subagent. setsid is what makes the group signal miss it.
  const parent = spawn('sh', ['-c', 'setsid sleep 30 & sleep 30'], { detached: true, stdio: 'ignore' })
  try {
    assert.ok(parent.pid, 'parent must have a pid')
    await settle(400)

    const found = walk(new PiRpcManager(), parent.pid!)
    assert.ok(found.length > 0, 'the walk must see the descendants')

    // A plain group kill leaves the detached grandchild behind. That is the bug.
    const escaped = found.filter((pid) => {
      const sid = spawnSync('ps', ['-o', 'sid=', '-p', String(pid)], { encoding: 'utf-8' })
      return sid.status === 0 && sid.stdout.trim() !== '' && Number(sid.stdout.trim()) !== parent.pid
    })
    assert.ok(escaped.length > 0, 'at least one descendant must have escaped the parent group')
  } finally {
    try { process.kill(-parent.pid!, 'SIGKILL') } catch { /* gone */ }
    for (const pid of walk(new PiRpcManager(), parent.pid ?? 0)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
  }
})

test('an escaped descendant is signalled directly and dies', { skip: IS_WINDOWS }, async () => {
  const parent = spawn('sh', ['-c', 'setsid sleep 30 & sleep 30'], { detached: true, stdio: 'ignore' })
  assert.ok(parent.pid, 'parent must have a pid')
  await settle(400)

  const strays = walk(new PiRpcManager(), parent.pid!)
  assert.ok(strays.length > 0)

  try { process.kill(-parent.pid!, 'SIGTERM') } catch { /* gone */ }
  for (const pid of strays) {
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
  }
  await settle(600)

  for (const pid of strays) {
    assert.equal(alive(pid), false, `descendant ${pid} must not survive the kill`)
  }
  assert.equal(alive(parent.pid!), false, 'the agent itself must not survive either')
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
