import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstQueued, withQueued, withoutQueued, withoutWorkspaceQueue, type QueuedPrompt, type SendQueues } from './send-queue'

const WORKSPACE = 'ws-1'
const OTHER_WORKSPACE = 'ws-2'

function prompt(id: string, text = `Message ${id}`): QueuedPrompt {
  return { id, text, attachments: [] }
}

test('withQueued appends to the end of one workspace queue only', () => {
  let queues: SendQueues = {}
  queues = withQueued(queues, WORKSPACE, prompt('a'))
  queues = withQueued(queues, WORKSPACE, prompt('b'))
  queues = withQueued(queues, OTHER_WORKSPACE, prompt('c'))
  assert.deepEqual(queues[WORKSPACE].map((p) => p.id), ['a', 'b'])
  assert.deepEqual(queues[OTHER_WORKSPACE].map((p) => p.id), ['c'])
})

test('firstQueued gives the oldest prompt, or nothing for an empty queue', () => {
  const queues = withQueued(withQueued({}, WORKSPACE, prompt('a')), WORKSPACE, prompt('b'))
  assert.equal(firstQueued(queues, WORKSPACE)?.id, 'a')
  assert.equal(firstQueued(queues, OTHER_WORKSPACE), undefined)
})

test('withoutQueued removes one prompt and drops a queue left empty', () => {
  const queues = withQueued(withQueued({}, WORKSPACE, prompt('a')), WORKSPACE, prompt('b'))
  const afterOne = withoutQueued(queues, WORKSPACE, 'a')
  assert.deepEqual(afterOne[WORKSPACE].map((p) => p.id), ['b'])
  const afterBoth = withoutQueued(afterOne, WORKSPACE, 'b')
  assert.equal(WORKSPACE in afterBoth, false)
})

test('withoutQueued returns the same queues when the prompt is not there', () => {
  const queues = withQueued({}, WORKSPACE, prompt('a'))
  assert.equal(withoutQueued(queues, WORKSPACE, 'missing'), queues)
  assert.equal(withoutQueued(queues, OTHER_WORKSPACE, 'a'), queues)
})

test('withoutWorkspaceQueue drops one workspace queue and keeps the others', () => {
  const queues = withQueued(withQueued({}, WORKSPACE, prompt('a')), OTHER_WORKSPACE, prompt('b'))
  const next = withoutWorkspaceQueue(queues, WORKSPACE)
  assert.equal(WORKSPACE in next, false)
  assert.deepEqual(next[OTHER_WORKSPACE].map((p) => p.id), ['b'])
  assert.equal(withoutWorkspaceQueue(next, WORKSPACE), next)
})

test('the queue functions never change the queues they were given', () => {
  const queues = withQueued({}, WORKSPACE, prompt('a'))
  const snapshot = JSON.stringify(queues)
  withQueued(queues, WORKSPACE, prompt('b'))
  withoutQueued(queues, WORKSPACE, 'a')
  assert.equal(JSON.stringify(queues), snapshot)
})
