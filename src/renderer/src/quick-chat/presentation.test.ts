import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import type { QuickChatContext } from '../../../shared/quick-chat'
import type { DisplayMessage } from '../message-parsing'
import { boundStatus, quickChatKeyAction, targetOptions, transcriptMessages } from './presentation'

function context(): QuickChatContext {
  return {
    binding: null,
    defaultWorkspaceId: 'project',
    workspaces: [{ id: 'project', name: 'Project', path: '/project', createdAt: 0, lastActiveAt: 0, color: '' }],
    runtimes: [{ runtimeId: 'live', workspaceId: 'project', sessionId: 'id-not-a-title', sessionPath: '/sessions/live', status: 'running', pid: 1, error: null, activity: 'working', active: false }],
    runtimeUpdatedAt: {},
    sessions: [
      { path: '/sessions/live', sessionId: 'live', name: 'Live task', preview: null, projectName: 'Project', projectPath: '/project', lastModified: 100, messageCount: 1 },
      { path: '/sessions/saved', sessionId: 'saved', name: 'Recent saved task', preview: null, projectName: 'Project', projectPath: '/project', lastModified: 200, messageCount: 1 },
    ],
    settings: { ...DEFAULT_SETTINGS }, i18nEnvironment: { systemLanguages: ['en'], pseudoLanguageEnabled: false }, themes: [],
  }
}

test('a tool and its result appear only in the live bubble until the transcript takes over', () => {
  const messages: DisplayMessage[] = [
    { id: 'call', role: 'assistant', timestamp: 1, content: '', toolCalls: [{ id: 'write', name: 'write', arguments: '{}' }] },
    { id: 'result', role: 'toolResult', timestamp: 2, content: 'written', toolCallId: 'write' },
    { id: 'answer', role: 'assistant', timestamp: 3, content: 'done' },
  ]
  assert.deepEqual(transcriptMessages(messages, new Map([['write', {}]])), [messages[2]])
  assert.equal(transcriptMessages(messages, new Map()), messages, 'settled history must reappear without mutating or losing messages')
  assert.equal(messages[0].toolCalls?.length, 1)
})

test('live tool projection preserves prose, thinking, stopped answers and unrelated tool calls', () => {
  const call = { id: 'live', name: 'write', arguments: '{}' }
  const other = { id: 'older', name: 'read', arguments: '{}' }
  const messages: DisplayMessage[] = [
    { id: 'mixed', role: 'assistant', timestamp: 1, content: 'Explanation', thinking: 'Reasoning', toolCalls: [call, other] },
    { id: 'stopped', role: 'assistant', timestamp: 2, content: '', stopped: true, toolCalls: [call] },
    { id: 'old-result', role: 'toolResult', timestamp: 3, content: 'old result', toolCallId: 'older' },
  ]
  const projected = transcriptMessages(messages, new Map([['live', {}]]))
  assert.deepEqual(projected[0], { ...messages[0], toolCalls: [other] })
  assert.deepEqual(projected[1], { ...messages[1], toolCalls: undefined })
  assert.equal(projected[2], messages[2])
  assert.equal(messages[0].toolCalls?.length, 2)
})

test('recent-task ordering uses saved history until newer live activity occurs, without listing a live session twice', () => {
  const value = context()
  assert.deepEqual(targetOptions(value).map((option) => option.key), ['saved:project:/sessions/saved', 'runtime:live'])
  value.runtimeUpdatedAt.live = 300
  assert.deepEqual(targetOptions(value).map((option) => option.key), ['runtime:live', 'saved:project:/sessions/saved'])
})

test('recent rows distinguish approval, completed, failed, stopped and starting instead of marking every live runtime busy', () => {
  const value = context()
  const runtime = value.runtimes[0]
  const status = (): string => targetOptions(value).find((option) => option.key === 'runtime:live')!.status
  assert.equal(status(), 'working')
  runtime.activity = 'needs-approval'
  assert.equal(status(), 'needs-approval')
  runtime.activity = 'completed'
  assert.equal(status(), 'completed')
  runtime.status = 'error'
  assert.equal(status(), 'failed')
  runtime.activity = null
  runtime.status = 'stopped'
  assert.equal(status(), 'stopped')
  runtime.status = 'starting'
  assert.equal(status(), 'starting')
})

function chord(key: string, change: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) {
  return { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...change }
}

test('inside the popup, the Quick Chat key hides it and the other keys keep their commands', () => {
  const shortcuts = { ...DEFAULT_SETTINGS.shortcuts, quickChat: 'Mod+Alt+Q' }
  assert.equal(quickChatKeyAction(chord('q', { altKey: true }), shortcuts, 'linux'), 'hide')
  assert.equal(quickChatKeyAction(chord('q', { ctrlKey: false, metaKey: true, altKey: true }), shortcuts, 'darwin'), 'hide')
  assert.equal(quickChatKeyAction(chord('n'), shortcuts, 'linux'), 'newTask')
  assert.equal(quickChatKeyAction(chord('m', { shiftKey: true }), shortcuts, 'linux'), 'models')
  assert.equal(quickChatKeyAction(chord('q'), shortcuts, 'linux'), null)
})

test('with no Quick Chat key set, no chord hides the popup', () => {
  assert.equal(quickChatKeyAction(chord('q', { altKey: true }), DEFAULT_SETTINGS.shortcuts, 'linux'), null)
})

test('the bound status line puts an open question and a running turn before the process state', () => {
  const runtime = context().runtimes[0]
  assert.equal(boundStatus({ request: true, busy: true, runtime }), 'needs-approval')
  assert.equal(boundStatus({ request: false, busy: true, runtime: { ...runtime, status: 'stopped' } }), 'working')
  assert.equal(boundStatus({ request: false, busy: false, runtime: { ...runtime, activity: 'completed' } }), 'ready', 'a finished turn reads as ready, not completed')
  assert.equal(boundStatus({ request: false, busy: false, runtime: { ...runtime, status: 'starting' } }), 'starting')
  assert.equal(boundStatus({ request: false, busy: false, runtime: { ...runtime, status: 'error' } }), 'failed')
  assert.equal(boundStatus({ request: false, busy: false, runtime: undefined }), 'ready')
})
