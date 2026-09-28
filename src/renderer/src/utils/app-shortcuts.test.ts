import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { useAppStore } from '../store'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { handleAppShortcut, runAppShortcut } from './app-shortcuts'
import type { SessionRuntimeInfo } from '../../../shared/ipc-contracts'

const initialState = useAppStore.getState()

class Target {
  constructor(private recording = false) {}
  closest(): Target | null { return this.recording ? this : null }
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
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

test('file, review, terminal and sidebar shortcuts reveal and toggle their panels', async () => {
  for (const action of ['files', 'review', 'terminal'] as const) {
    useAppStore.setState({ currentView: 'settings', workflowPanelOpen: true, chatSidePanel: 'files', terminalOpen: true, reviewOpen: true })
    await runAppShortcut(action)
    assert.equal(useAppStore.getState().currentView, 'chat')
    assert.equal(useAppStore.getState().workflowPanelOpen, false)
    await runAppShortcut(action)
    const state = useAppStore.getState()
    assert.equal(action === 'files' ? state.chatSidePanel : action === 'review' ? state.reviewOpen : state.terminalOpen, action === 'files' ? null : false)
    await runAppShortcut(action)
    const reopened = useAppStore.getState()
    assert.equal(action === 'files' ? reopened.chatSidePanel : action === 'review' ? reopened.reviewOpen : reopened.terminalOpen, action === 'files' ? 'files' : true)
  }
  useAppStore.setState({ sidebarOpen: true })
  await runAppShortcut('sidebar')
  assert.equal(useAppStore.getState().sidebarOpen, false)
  await runAppShortcut('sidebar')
  assert.equal(useAppStore.getState().sidebarOpen, true)
})

test('new session dispatches once, and its old binding stops working after remapping or disabling', async () => {
  let created = 0
  useAppStore.setState({ createNewSession: async () => { created++ } })
  const event = keyEvent({ key: 'n', code: 'KeyN' })
  handleAppShortcut(event)
  await settle()
  assert.equal(created, 1)
  assert.equal(event.defaultPrevented, true)
  assert.equal(useAppStore.getState().workflowPanelOpen, false)
  assert.equal(useAppStore.getState().currentView, 'chat')
  handleAppShortcut(keyEvent({ key: 'n', code: 'KeyN', repeat: true }))
  useAppStore.getState().setSettingsDraft({ shortcuts: { ...DEFAULT_SETTINGS.shortcuts, newSession: 'Mod+Shift+J' } })
  handleAppShortcut(keyEvent({ key: 'n', code: 'KeyN' }))
  handleAppShortcut(keyEvent({ key: 'J', code: 'KeyJ', shiftKey: true }))
  await settle()
  assert.equal(created, 2)
  useAppStore.getState().setSettingsDraft({ shortcuts: { ...DEFAULT_SETTINGS.shortcuts, newSession: null } })
  handleAppShortcut(keyEvent({ key: 'n', code: 'KeyN' }))
  await settle()
  assert.equal(created, 2)
})

test('project shortcuts use visible order, wrap, and respect a cancelled workspace change', async () => {
  const base = useAppStore.getState().activeWorkspace!
  const workspaces = [
    { ...base, id: 'last', createdAt: 3 },
    { ...base, id: 'first', createdAt: 1 },
    { ...base, id: 'middle', createdAt: 2 },
  ]
  const selected: string[] = []
  useAppStore.setState({ workspaces, activeWorkspace: workspaces[0], activateWorkspace: async (id) => {
    selected.push(id)
    useAppStore.setState({ activeWorkspace: workspaces.find((workspace) => workspace.id === id)! })
    return true
  } })
  handleAppShortcut(keyEvent({ key: '}', code: 'BracketRight', shiftKey: true }))
  await settle()
  assert.deepEqual(selected, ['first'])
  await runAppShortcut('previousProject')
  assert.deepEqual(selected, ['first', 'last'])
  assert.equal(useAppStore.getState().workflowPanelOpen, false)
  useAppStore.setState({ activateWorkspace: initialState.activateWorkspace, editorDirty: true, currentView: 'settings', workflowPanelOpen: true })
  const cancelled = runAppShortcut('nextProject')
  assert.ok(useAppStore.getState().confirmRequest)
  useAppStore.getState().resolveConfirm(false)
  await cancelled
  assert.equal(useAppStore.getState().activeWorkspace?.id, 'last')
  assert.equal(useAppStore.getState().currentView, 'settings')
  assert.equal(useAppStore.getState().workflowPanelOpen, true)
})

test('project shortcuts follow the manually reordered tabs in both directions', async () => {
  const base = useAppStore.getState().activeWorkspace!
  const workspaces = ['a', 'b', 'c'].map((id, createdAt) => ({ ...base, id, createdAt }))
  const selected: string[] = []
  useAppStore.setState({ workspaces, activeWorkspace: workspaces[0], activateWorkspace: async (id) => {
    selected.push(id)
    useAppStore.setState({ activeWorkspace: workspaces.find((workspace) => workspace.id === id)! })
    return true
  } })
  useAppStore.getState().reorderProjectTab('c', 'a', 'after')
  await runAppShortcut('nextProject')
  await runAppShortcut('nextProject')
  await runAppShortcut('nextProject')
  await runAppShortcut('previousProject')
  assert.deepEqual(selected, ['c', 'b', 'a', 'b'])
})

test('session navigation uses open sessions in the active project, supports remapping and ignores recording', async () => {
  const runtime = (id: string, workspaceId = 'project', sessionPath: string | null = `/${id}`): SessionRuntimeInfo => ({
    runtimeId: id, workspaceId, sessionPath, sessionId: id, activity: null, active: false, status: 'running', pid: null, error: null,
  })
  const selected: string[] = []
  useAppStore.setState({
    sessionRuntimes: { first: runtime('first'), other: runtime('other', 'elsewhere'), starting: runtime('starting', 'project', null), last: runtime('last') },
    activeSessionRuntimeId: 'last',
    switchSession: async (path, projectPath) => {
      assert.equal(projectPath, '/project')
      selected.push(path)
      useAppStore.setState({ activeSessionRuntimeId: path.slice(1) })
    },
  })
  handleAppShortcut(keyEvent({ key: ']', code: 'BracketRight', target: new Target(true) }))
  assert.deepEqual(selected, [])
  handleAppShortcut(keyEvent({ key: ']', code: 'BracketRight' }))
  await settle()
  assert.deepEqual(selected, ['/first'])
  await runAppShortcut('nextSession')
  assert.deepEqual(selected, ['/first', '/last'])
  await runAppShortcut('previousSession')
  assert.deepEqual(selected, ['/first', '/last', '/first'])
  useAppStore.getState().setSettingsDraft({ shortcuts: { ...DEFAULT_SETTINGS.shortcuts, nextSession: 'Mod+J' } })
  handleAppShortcut(keyEvent({ key: ']', code: 'BracketRight' }))
  assert.equal(selected.length, 3)
  handleAppShortcut(keyEvent({ key: 'j', code: 'KeyJ' }))
  await settle()
  assert.deepEqual(selected, ['/first', '/last', '/first', '/last'])
  assert.equal(useAppStore.getState().currentView, 'chat')
  assert.equal(useAppStore.getState().workflowPanelOpen, false)
  useAppStore.setState({ sessionRuntimes: {} })
  await runAppShortcut('nextSession')
  assert.equal(selected.length, 4)
})
