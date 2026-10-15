import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forkPointForUserMessage, normalizeForkMessages, type ForkPoint } from './fork-point'
import { PLANNING_PREAMBLE_OPENING, PLANNING_PREAMBLE_SENTINEL } from './session-preview'

test('returns [] for non-array input', () => {
  assert.deepEqual(normalizeForkMessages(null), [])
  assert.deepEqual(normalizeForkMessages({}), [])
})

test('maps entryId + text fields', () => {
  const r = normalizeForkMessages([
    { entryId: 'a1', text: 'first message' },
    { entryId: 'b2', text: 'second' },
  ])
  assert.deepEqual(r, [
    { entryId: 'a1', text: 'first message' },
    { entryId: 'b2', text: 'second' },
  ] satisfies ForkPoint[])
})

test('falls back to id and content field names', () => {
  const r = normalizeForkMessages([{ id: 'x', content: 'hello' }])
  assert.deepEqual(r, [{ entryId: 'x', text: 'hello' }])
})

test('skips entries without an id', () => {
  const r = normalizeForkMessages([{ text: 'no id' }, { entryId: 'ok', text: 't' }])
  assert.equal(r.length, 1)
  assert.equal(r[0].entryId, 'ok')
})

const user = (id: string, content: string): { id: string; role: string; content: string } => ({ id, role: 'user', content })
const reply = (id: string): { id: string; role: string; content: string } => ({ id, role: 'assistant', content: 'answer' })

test('forkPointForUserMessage finds the entry of a chat user message', () => {
  const chat = [user('u1', 'first'), reply('a1'), user('u2', 'second'), reply('a2')]
  const points = [{ entryId: 'e1', text: 'first' }, { entryId: 'e2', text: 'second' }]
  assert.deepEqual(forkPointForUserMessage(chat, 'u1', points), points[0])
  assert.deepEqual(forkPointForUserMessage(chat, 'u2', points), points[1])
  assert.equal(forkPointForUserMessage(chat, 'a1', points), null)
})

test('forkPointForUserMessage aligns at the end when compaction hid earlier messages', () => {
  const chat = [user('u3', 'same'), reply('a3'), user('u4', 'same')]
  const points = [{ entryId: 'e1', text: 'old' }, { entryId: 'e2', text: 'same' }, { entryId: 'e3', text: 'same' }]
  assert.equal(forkPointForUserMessage(chat, 'u3', points)?.entryId, 'e2')
  assert.equal(forkPointForUserMessage(chat, 'u4', points)?.entryId, 'e3')
})

test('forkPointForUserMessage matches a planning prompt by the words the user typed', () => {
  const wrapped = `${PLANNING_PREAMBLE_OPENING}\n\n${PLANNING_PREAMBLE_SENTINEL}\nadd a test`
  assert.equal(forkPointForUserMessage([user('u1', 'add a test')], 'u1', [{ entryId: 'e1', text: wrapped }])?.entryId, 'e1')
})

test('forkPointForUserMessage refuses when the session does not hold the message', () => {
  // A message the session has not saved yet shifts the alignment.
  const chat = [user('u1', 'first'), user('u2', 'not saved yet')]
  assert.equal(forkPointForUserMessage(chat, 'u2', [{ entryId: 'e1', text: 'first' }]), null)
  assert.equal(forkPointForUserMessage(chat, 'u1', [{ entryId: 'e1', text: 'first' }]), null)
  assert.equal(forkPointForUserMessage(chat, 'u1', []), null)
})
