import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDebouncedBuffer } from './debounced-buffer'

const DELAY_MS = 150

test('commits the latest pushed text once the delay elapses', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const commits: string[] = []
  const buffer = createDebouncedBuffer(DELAY_MS, (text) => commits.push(text))

  buffer.push('a')
  buffer.push('ab')
  t.mock.timers.tick(DELAY_MS - 1)
  assert.deepEqual(commits, [], 'nothing may commit before the delay elapses')
  t.mock.timers.tick(1)
  assert.deepEqual(commits, ['ab'], 'only the latest text commits, once')
})

test('every push restarts the delay window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const commits: string[] = []
  const buffer = createDebouncedBuffer(DELAY_MS, (text) => commits.push(text))

  buffer.push('a')
  t.mock.timers.tick(DELAY_MS - 1)
  buffer.push('ab')
  t.mock.timers.tick(DELAY_MS - 1)
  assert.deepEqual(commits, [], 'the second push must restart the window')
  t.mock.timers.tick(1)
  assert.deepEqual(commits, ['ab'])
})

test('flush commits pending text immediately and returns it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const commits: string[] = []
  const buffer = createDebouncedBuffer(DELAY_MS, (text) => commits.push(text))

  buffer.push('typed')
  const flushed = buffer.flush()

  assert.equal(flushed, 'typed')
  assert.deepEqual(commits, ['typed'])
  t.mock.timers.tick(DELAY_MS)
  assert.deepEqual(commits, ['typed'], 'the cancelled timer must not commit again')
})

test('flush with nothing pending returns null and commits nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const commits: string[] = []
  const buffer = createDebouncedBuffer(DELAY_MS, (text) => commits.push(text))

  assert.equal(buffer.flush(), null)
  assert.deepEqual(commits, [])
})

test('cancel discards pending text without committing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const commits: string[] = []
  const buffer = createDebouncedBuffer(DELAY_MS, (text) => commits.push(text))

  buffer.push('doomed')
  buffer.cancel()
  t.mock.timers.tick(DELAY_MS * 2)

  assert.deepEqual(commits, [], 'cancelled text must never commit')
  assert.equal(buffer.flush(), null, 'cancel must clear the pending text')
})

test('push after flush starts a fresh window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const commits: string[] = []
  const buffer = createDebouncedBuffer(DELAY_MS, (text) => commits.push(text))

  buffer.push('first')
  buffer.flush()
  buffer.push('second')
  t.mock.timers.tick(DELAY_MS)

  assert.deepEqual(commits, ['first', 'second'])
})
