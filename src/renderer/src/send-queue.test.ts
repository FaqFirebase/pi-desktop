import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tEnglish } from '../../shared/i18n'
import { firstQueued, sendQueueStatusText, withQueued, withoutQueued, withoutChats, type QueuedPrompt, type SendQueues } from './send-queue'

const CHAT = 'runtime-1'
const OTHER_CHAT = 'runtime-2'

function prompt(id: string, text = `Message ${id}`): QueuedPrompt {
  return { id, text, attachments: [] }
}

test('withQueued appends to the end of one chat queue only', () => {
  let queues: SendQueues = {}
  queues = withQueued(queues, CHAT, prompt('a'))
  queues = withQueued(queues, CHAT, prompt('b'))
  queues = withQueued(queues, OTHER_CHAT, prompt('c'))
  assert.deepEqual(queues[CHAT].map((p) => p.id), ['a', 'b'])
  assert.deepEqual(queues[OTHER_CHAT].map((p) => p.id), ['c'])
})

test('firstQueued gives the oldest prompt, or nothing for an empty queue', () => {
  const queues = withQueued(withQueued({}, CHAT, prompt('a')), CHAT, prompt('b'))
  assert.equal(firstQueued(queues, CHAT)?.id, 'a')
  assert.equal(firstQueued(queues, OTHER_CHAT), undefined)
})

test('withoutQueued removes one prompt and drops a queue left empty', () => {
  const queues = withQueued(withQueued({}, CHAT, prompt('a')), CHAT, prompt('b'))
  const afterOne = withoutQueued(queues, CHAT, 'a')
  assert.deepEqual(afterOne[CHAT].map((p) => p.id), ['b'])
  const afterBoth = withoutQueued(afterOne, CHAT, 'b')
  assert.equal(CHAT in afterBoth, false)
})

test('withoutQueued returns the same queues when the prompt is not there', () => {
  const queues = withQueued({}, CHAT, prompt('a'))
  assert.equal(withoutQueued(queues, CHAT, 'missing'), queues)
  assert.equal(withoutQueued(queues, OTHER_CHAT, 'a'), queues)
})

test('withoutChats drops the entries of the closed chats and keeps the others', () => {
  const queues = withQueued(withQueued({}, CHAT, prompt('a')), OTHER_CHAT, prompt('b'))
  const next = withoutChats(queues, [CHAT])
  assert.equal(CHAT in next, false)
  assert.deepEqual(next[OTHER_CHAT].map((p) => p.id), ['b'])
  assert.equal(withoutChats(next, [CHAT]), next)
  assert.deepEqual(withoutChats(queues, [CHAT, OTHER_CHAT]), {})
})

test('the queue functions never change the queues they were given', () => {
  const queues = withQueued({}, CHAT, prompt('a'))
  const snapshot = JSON.stringify(queues)
  withQueued(queues, CHAT, prompt('b'))
  withoutQueued(queues, CHAT, 'a')
  assert.equal(JSON.stringify(queues), snapshot)
})

test('each hold reason tells the user what starts the queue again', () => {
  assert.equal(sendQueueStatusText(tEnglish, undefined), 'Sends when the agent finishes')
  assert.equal(sendQueueStatusText(tEnglish, 'interrupted'), 'Paused. Your next message, or Send now, starts it again')
  assert.equal(sendQueueStatusText(tEnglish, 'ended-off-screen'), 'Paused while you were away. Press Send now to send it')
})
