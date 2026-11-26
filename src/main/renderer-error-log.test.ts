import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import type { RendererErrorRecord } from '../shared/ipc-contracts'
import {
  MAX_RENDERER_STACK_CHARS,
  MAX_RENDERER_TEXT_CHARS,
  RENDERER_ERROR_LIMIT,
  RENDERER_ERROR_WINDOW_MS,
  RendererErrorLog,
  parseRendererErrorRecord,
} from './renderer-error-log'

interface LoggedEntry {
  level: 'error' | 'warn'
  scope: string
  message: string
  detail: unknown
}

let entries: LoggedEntry[]
let clock: number
let log: RendererErrorLog

beforeEach(() => {
  entries = []
  clock = 1_000
  log = new RendererErrorLog({
    log: {
      error: (scope, message, detail) => entries.push({ level: 'error', scope, message, detail }),
      warn: (scope, message, detail) => entries.push({ level: 'warn', scope, message, detail }),
    },
    now: () => clock,
  })
})

function record(overrides: Partial<RendererErrorRecord> = {}): RendererErrorRecord {
  return {
    kind: 'render-error',
    name: 'Error',
    message: 'boom',
    stack: 's',
    componentStack: 'c',
    view: 'chat',
    sessionId: 'id-1',
    unhandled: true,
    ...overrides,
  }
}

test('writes an accepted record under the renderer scope', () => {
  assert.equal(log.record(record({ name: 'TypeError', message: 'x is undefined' })), true)
  assert.deepEqual(entries[0], {
    level: 'error',
    scope: 'renderer',
    message: 'TypeError: x is undefined',
    detail: { kind: 'render-error', stack: 's', componentStack: 'c', view: 'chat', sessionId: 'id-1', unhandled: true },
  })
})

test('rejects malformed records and truncates long fields', () => {
  assert.equal(parseRendererErrorRecord({ ...record(), kind: 'other' }), null)
  assert.equal(parseRendererErrorRecord({ ...record(), message: 5 }), null)
  assert.equal(parseRendererErrorRecord({ ...record(), unhandled: 'yes' }), null)
  assert.equal(parseRendererErrorRecord({ ...record(), view: 3 }), null)
  assert.equal(parseRendererErrorRecord(null), null)
  const long = parseRendererErrorRecord({ ...record(), stack: 'a'.repeat(5_000_000), message: 'm'.repeat(10_000) })!
  assert.equal(long.stack!.length, MAX_RENDERER_STACK_CHARS)
  assert.equal(long.message.length, MAX_RENDERER_TEXT_CHARS)
  assert.equal(log.record({ kind: 'render-error' }), false)
  assert.equal(entries.length, 0)
})

test('drops records over the limit and reports the dropped count once', () => {
  for (let i = 0; i < RENDERER_ERROR_LIMIT + 5; i++) log.record(record())
  assert.equal(entries.length, RENDERER_ERROR_LIMIT)
  assert.equal(log.record(record()), false)
  clock += RENDERER_ERROR_WINDOW_MS
  assert.equal(log.record(record()), true)
  assert.deepEqual(entries.slice(-2).map((e) => [e.level, e.message]), [
    ['warn', 'Dropped 6 renderer errors over the rate limit'],
    ['error', 'Error: boom'],
  ])
  assert.equal(log.record(record()), true)
  assert.equal(entries.filter((e) => e.level === 'warn').length, 1)
})
