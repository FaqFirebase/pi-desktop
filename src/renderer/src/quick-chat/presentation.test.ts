import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import type { QuickChatContext } from '../../../shared/quick-chat'
import { composerKeyAction, targetOptions } from './presentation'

function context(): QuickChatContext {
  return {
    pinned: false,
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

test('new-task shortcut is platform-specific and never consumes composition or the reserved shifted chord', () => {
  const key = { key: 'n', shiftKey: false }
  assert.equal(composerKeyAction({ ...key, metaKey: true }, false, false, 'darwin'), 'new-task')
  assert.equal(composerKeyAction({ ...key, ctrlKey: true }, false, true, 'win32'), 'new-task')
  assert.equal(composerKeyAction({ ...key, ctrlKey: true }, false, false, 'darwin'), 'none')
  assert.equal(composerKeyAction({ ...key, metaKey: true }, false, false, 'win32'), 'none')
  assert.equal(composerKeyAction({ ...key, metaKey: true, shiftKey: true }, false, false, 'darwin'), 'none')
  assert.equal(composerKeyAction({ ...key, metaKey: true, isComposing: true }, false, false, 'darwin'), 'none')
  assert.equal(composerKeyAction({ ...key, metaKey: true, keyCode: 229 }, false, false, 'darwin'), 'none')
})
