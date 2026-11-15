import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RendererErrorRecord } from '../../../shared/ipc-contracts'
import {
  buildRendererErrorRecord,
  errorFields,
  formatCrashDetails,
  installRendererErrorForwarding,
  reportRendererError,
  setRendererErrorContextSource,
  setRendererErrorSender,
} from './renderer-error-report'

test('errorFields reads errors, strings and other values', () => {
  const error = new TypeError('bad')
  assert.deepEqual(errorFields(error), { name: 'TypeError', message: 'bad', stack: error.stack ?? null })
  assert.deepEqual(errorFields('plain'), { name: 'Error', message: 'plain', stack: null })
  assert.deepEqual(errorFields({ code: 1 }), { name: 'Error', message: '{"code":1}', stack: null })
  assert.deepEqual(errorFields(undefined), { name: 'Error', message: 'undefined', stack: null })
})

test('buildRendererErrorRecord carries the context and flags', () => {
  const record = buildRendererErrorRecord('render-error', new Error('x'), { componentStack: 'at App', unhandled: true }, { view: 'chat', sessionId: 's1' })
  assert.equal(record.kind, 'render-error')
  assert.equal(record.componentStack, 'at App')
  assert.equal(record.view, 'chat')
  assert.equal(record.sessionId, 's1')
  assert.equal(record.unhandled, true)
  const bare = buildRendererErrorRecord('window-error', 'oops', { unhandled: false }, { view: null, sessionId: null })
  assert.equal(bare.componentStack, null)
})

test('reportRendererError sends with the current context and never throws on a failed send', async () => {
  const sent: RendererErrorRecord[] = []
  setRendererErrorContextSource(() => ({ view: 'settings', sessionId: 'abc' }))
  setRendererErrorSender(async (record) => { sent.push(record) })
  reportRendererError('unhandled-rejection', new Error('one'), { unhandled: true })
  await Promise.resolve()
  assert.deepEqual([sent[0].kind, sent[0].message, sent[0].view, sent[0].sessionId], ['unhandled-rejection', 'one', 'settings', 'abc'])

  setRendererErrorSender(() => Promise.reject(new Error('ipc down')))
  assert.doesNotThrow(() => reportRendererError('window-error', 'two', { unhandled: true }))
  setRendererErrorSender(() => { throw new Error('bridge missing') })
  assert.doesNotThrow(() => reportRendererError('window-error', 'three', { unhandled: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
})

test('forwarding reports window errors and rejections but skips benign resize notices', () => {
  const listeners: Record<string, (event: unknown) => void> = {}
  const target = { addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener } }
  const calls: Array<[string, unknown, { unhandled: boolean }]> = []
  installRendererErrorForwarding(target as unknown as Pick<Window, 'addEventListener'>, (kind, error, options) => { calls.push([kind, error, options]) })
  listeners.error({ error: new Error('e'), message: 'e' })
  listeners.error({ error: null, message: 'ResizeObserver loop completed with undelivered notifications.' })
  listeners.error({ error: null, message: 'Script error.' })
  listeners.unhandledrejection({ reason: 'nope' })
  assert.deepEqual(calls.map((c) => c[0]), ['window-error', 'window-error', 'unhandled-rejection'])
  assert.equal(calls[1][1], 'Script error.')
  assert.ok(calls.every((c) => c[2].unhandled === true))
})

test('formatCrashDetails lists version, view, error and component stack', () => {
  const text = formatCrashDetails({ error: new Error('boom'), componentStack: '\n    at Chat', appVersion: '0.1.9', view: 'chat' })
  assert.match(text, /^Pi Desktop 0\.1\.9\nView: chat\nError: boom\n/)
  assert.match(text, /Component stack:\n\s+at Chat/)
})

test('formatCrashDetails without a stack or view names the error alone', () => {
  const error = new RangeError('too far')
  error.stack = undefined
  assert.equal(formatCrashDetails({ error, componentStack: null, appVersion: '1.0.0', view: null }), 'Pi Desktop 1.0.0\nView: none\nRangeError: too far')
})
