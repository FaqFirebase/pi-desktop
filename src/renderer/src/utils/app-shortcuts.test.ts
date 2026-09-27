import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { useAppStore } from '../store'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { handleAppShortcut, runAppShortcut } from './app-shortcuts'

class Target {
  constructor(private recording = false) {}
  closest(): Target | null { return this.recording ? this : null }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: Target })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { piDesktop: {
    system: { platform: 'darwin' }, ui: { setEditorDirty: () => {} },
  } } })
  useAppStore.setState({
    activeWorkspace: { id: 'project', name: 'Project', path: '/project', createdAt: 0, lastActiveAt: 0, color: '' },
    currentView: 'settings', chatSidePanel: null, settings: DEFAULT_SETTINGS, settingsDraft: {},
    previewTarget: null, editorDirty: false, confirmRequest: null, workflowPanelOpen: true,
    workflowPanelFilter: null, workflowPanelWorkspaceId: null,
  })
})

function keyEvent(change: Record<string, unknown> = {}): KeyboardEvent {
  return {
    key: 'g', code: 'KeyG', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    defaultPrevented: false, repeat: false, target: new Target(),
    preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true }, stopPropagation() {}, ...change,
  } as unknown as KeyboardEvent
}

async function settle(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)) }

test('the actual Command+G dispatcher opens the diff panel and reveals it above workflow navigation', async () => {
  const event = keyEvent()
  handleAppShortcut(event)
  await settle()
  assert.equal(event.defaultPrevented, true)
  assert.equal(useAppStore.getState().currentView, 'chat')
  assert.equal(useAppStore.getState().chatSidePanel, 'diff')
  assert.equal(useAppStore.getState().workflowPanelOpen, false)
})

test('Command+G toggles the visible diff off and back on without repeating while held', async () => {
  handleAppShortcut(keyEvent())
  await settle()
  handleAppShortcut(keyEvent({ repeat: true }))
  await settle()
  assert.equal(useAppStore.getState().chatSidePanel, 'diff')
  handleAppShortcut(keyEvent())
  await settle()
  assert.equal(useAppStore.getState().chatSidePanel, null)
  assert.equal(useAppStore.getState().currentView, 'chat')
  assert.equal(useAppStore.getState().confirmRequest, null)
  handleAppShortcut(keyEvent())
  await settle()
  assert.equal(useAppStore.getState().chatSidePanel, 'diff')
})

test('a diff retained behind another view or workflow is revealed rather than closed', async () => {
  for (const currentView of ['settings', 'chat', 'diff'] as const) {
    useAppStore.setState({ currentView, chatSidePanel: 'diff', workflowPanelOpen: true })
    await runAppShortcut('diff')
    assert.equal(useAppStore.getState().currentView, 'chat')
    assert.equal(useAppStore.getState().chatSidePanel, 'diff')
    assert.equal(useAppStore.getState().workflowPanelOpen, false)
  }
  useAppStore.setState({ currentView: 'settings' })
  await runAppShortcut('diff')
  assert.equal(useAppStore.getState().chatSidePanel, 'diff')
  assert.equal(useAppStore.getState().currentView, 'chat')
})

test('a visible full-page diff closes without leaving a second diff in the chat', async () => {
  useAppStore.setState({ currentView: 'diff', chatSidePanel: 'diff', workflowPanelOpen: false })
  await runAppShortcut('diff')
  assert.equal(useAppStore.getState().currentView, 'chat')
  assert.equal(useAppStore.getState().chatSidePanel, null)
})

test('opening diff respects the dirty-editor cancel and confirm paths', async () => {
  useAppStore.setState({ editorDirty: true })
  const cancelled = runAppShortcut('diff')
  assert.ok(useAppStore.getState().confirmRequest)
  useAppStore.getState().resolveConfirm(false)
  await cancelled
  assert.equal(useAppStore.getState().chatSidePanel, null)
  assert.equal(useAppStore.getState().currentView, 'settings')
  const accepted = runAppShortcut('diff')
  useAppStore.getState().resolveConfirm(true)
  await accepted
  assert.equal(useAppStore.getState().chatSidePanel, 'diff')
  assert.equal(useAppStore.getState().editorDirty, false)
})

test('remapping and disabling take effect without keeping the old shortcut active', async () => {
  useAppStore.getState().setSettingsDraft({ shortcuts: { ...DEFAULT_SETTINGS.shortcuts, diff: 'Mod+Shift+D' } })
  handleAppShortcut(keyEvent())
  await settle()
  assert.equal(useAppStore.getState().chatSidePanel, null)
  handleAppShortcut(keyEvent({ key: 'D', code: 'KeyD', shiftKey: true }))
  await settle()
  assert.equal(useAppStore.getState().chatSidePanel, 'diff')
  useAppStore.setState({ chatSidePanel: null, settingsDraft: { shortcuts: { ...DEFAULT_SETTINGS.shortcuts, diff: null } } })
  handleAppShortcut(keyEvent())
  await settle()
  assert.equal(useAppStore.getState().chatSidePanel, null)
})

test('recording, IME, consumed keys and repeats never open a panel', async () => {
  for (const change of [{ target: new Target(true) }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { repeat: true }]) {
    handleAppShortcut(keyEvent(change))
    await settle()
    assert.equal(useAppStore.getState().chatSidePanel, null)
  }
  useAppStore.setState({ activeWorkspace: null })
  await runAppShortcut('diff')
  assert.equal(useAppStore.getState().currentView, 'settings')
})
