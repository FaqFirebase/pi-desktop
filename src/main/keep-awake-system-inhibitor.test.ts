import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createSystemInhibitor,
  SYSTEMD_INHIBIT_COMMAND,
  type InhibitorChild,
} from './keep-awake-system-inhibitor'

const SETTLE_MS = 5

class FakeChild extends EventEmitter implements InhibitorChild {
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

interface Harness {
  children: FakeChild[]
  commands: string[]
  argLists: (readonly string[])[]
  lostCount: () => number
  inhibitor: ReturnType<typeof createSystemInhibitor>
}

function createHarness(): Harness {
  const children: FakeChild[] = []
  const commands: string[] = []
  const argLists: (readonly string[])[] = []
  let lost = 0
  const inhibitor = createSystemInhibitor({
    spawn: (command, args) => {
      commands.push(command)
      argLists.push(args)
      const child = new FakeChild()
      children.push(child)
      return child
    },
    who: 'Pi Desktop',
    why: 'Keep awake is on',
    settleMs: SETTLE_MS,
    onLost: () => {
      lost++
    },
  })
  return { children, commands, argLists, lostCount: () => lost, inhibitor }
}

test('acquire runs systemd-inhibit with a block on sleep and idle, held open by cat', async () => {
  const h = createHarness()
  const acquired = h.inhibitor.acquire()
  h.children[0].emit('spawn')

  assert.equal(await acquired, true)
  assert.deepEqual(h.commands, [SYSTEMD_INHIBIT_COMMAND])
  assert.deepEqual(h.argLists[0], [
    '--what=sleep:idle',
    '--who=Pi Desktop',
    '--why=Keep awake is on',
    '--mode=block',
    'cat',
  ])
  assert.equal(h.inhibitor.isHeld(), true)
})

test('acquire resolves false when the command does not exist', async () => {
  const h = createHarness()
  const acquired = h.inhibitor.acquire()
  h.children[0].emit('error', new Error('spawn systemd-inhibit ENOENT'))

  assert.equal(await acquired, false)
  assert.equal(h.inhibitor.isHeld(), false)
  assert.equal(h.lostCount(), 0)
})

test('acquire resolves false when the helper exits before it settles', async () => {
  const h = createHarness()
  const acquired = h.inhibitor.acquire()
  h.children[0].emit('spawn')
  h.children[0].emit('exit', 1)

  assert.equal(await acquired, false)
  assert.equal(h.inhibitor.isHeld(), false)
  assert.equal(h.lostCount(), 0)
})

test('a second acquire while held starts no second helper', async () => {
  const h = createHarness()
  const first = h.inhibitor.acquire()
  h.children[0].emit('spawn')
  await first

  assert.equal(await h.inhibitor.acquire(), true)
  assert.equal(h.children.length, 1)
})

test('release kills the helper and reports no loss', async () => {
  const h = createHarness()
  const acquired = h.inhibitor.acquire()
  h.children[0].emit('spawn')
  await acquired

  h.inhibitor.release()
  h.children[0].emit('exit', null)

  assert.equal(h.children[0].killed, true)
  assert.equal(h.inhibitor.isHeld(), false)
  assert.equal(h.lostCount(), 0)
})

test('release with nothing held does nothing', () => {
  const h = createHarness()
  h.inhibitor.release()
  assert.equal(h.children.length, 0)
})

test('an unexpected exit after acquire reports the loss once', async () => {
  const h = createHarness()
  const acquired = h.inhibitor.acquire()
  h.children[0].emit('spawn')
  await acquired

  h.children[0].emit('exit', 1)

  assert.equal(h.inhibitor.isHeld(), false)
  assert.equal(h.lostCount(), 1)
})

test('acquire works again after a release', async () => {
  const h = createHarness()
  const first = h.inhibitor.acquire()
  h.children[0].emit('spawn')
  await first
  h.inhibitor.release()

  const second = h.inhibitor.acquire()
  h.children[1].emit('spawn')

  assert.equal(await second, true)
  assert.equal(h.children.length, 2)
})
