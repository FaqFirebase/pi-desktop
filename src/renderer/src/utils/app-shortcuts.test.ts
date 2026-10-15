import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { useAppStore } from '../store'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import {
  activeShortcuts, handleAppShortcut, handleAppShortcutAfterTarget, handleAppShortcutRelease, releasePushToTalk, runAppShortcut,
} from './app-shortcuts'
import { onVoiceShortcut, type VoiceShortcutCommand } from '../voice/voice-shortcut'
import type { SessionRuntimeInfo } from '../../../shared/ipc-contracts'

const initialState = useAppStore.getState()

const SHORTCUT_RECORDER = '[data-shortcut-recorder]'
const CODE_EDITOR = '.cm-editor'
const TERMINAL = '.xterm'
// Ctrl alone, as the primary modifier on Linux and Windows.
const CTRL = { metaKey: false, ctrlKey: true }

// The focused element; `within` lists the selectors of the elements around it.
class Target {
  constructor(private readonly within: string[] = []) {}
  closest(selector: string): Target | null { return this.within.includes(selector) ? this : null }
}

function setPlatform(platform: string): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { piDesktop: {
    system: { platform }, ui: { setEditorDirty: () => {} },
  } } })
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: Target })
  setPlatform('darwin')
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
    defaultPrevented: false, cancelBubble: false, repeat: false, target: new Target(),
    preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true },
    stopPropagation(this: { cancelBubble: boolean }) { this.cancelBubble = true }, ...change,
  } as unknown as KeyboardEvent
}

/**
 * Delivers a key press in DOM order: the document capture listener, the focused element's own
 * key handler (CodeMirror's keymap or xterm), then the document bubble listener. Each step runs
 * only while the event still propagates.
 */
function press(event: KeyboardEvent, focusedElement: (event: KeyboardEvent) => void = () => {}): void {
  handleAppShortcut(event)
  if (!event.cancelBubble) focusedElement(event)
  if (!event.cancelBubble) handleAppShortcutAfterTarget(event)
}

// xterm sends a control key to the shell, then calls preventDefault and stopPropagation.
function xtermSendsKey(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

// A CodeMirror keymap command ran: CodeMirror calls preventDefault and lets the event bubble.
function editorRunsCommand(event: KeyboardEvent): void {
  event.preventDefault()
}

function sessionRuntime(id: string, workspaceId = 'project', sessionPath: string | null = `/${id}`): SessionRuntimeInfo {
  return { runtimeId: id, workspaceId, sessionPath, sessionId: id, activity: null, active: false, status: 'running', pid: null, error: null }
}

/** Gives the project, session and new-session shortcuts a visible effect, so a test can tell that none ran. */
function arrangeShortcutEffects(): void {
  const project = useAppStore.getState().activeWorkspace!
  useAppStore.setState({
    workspaces: [project, { ...project, id: 'other', createdAt: 1 }],
    sessionRuntimes: { first: sessionRuntime('first'), second: sessionRuntime('second') },
    activeSessionRuntimeId: 'first',
    activateWorkspace: async () => true,
    switchSession: async () => {},
    createNewSession: async () => {},
  })
}

/** How many store updates `pressKeys` and the shortcuts it runs make. */
async function storeUpdatesDuring(pressKeys: () => void): Promise<number> {
  let updates = 0
  const unsubscribe = useAppStore.subscribe(() => { updates++ })
  pressKeys()
  await settle()
  unsubscribe()
  return updates
}

async function settle(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)) }

test('the shortcuts in force come from the Settings draft, then the saved settings, then the defaults', () => {
  const saved = { ...DEFAULT_SETTINGS.shortcuts, diff: 'Mod+Shift+D' }
  const draft = { ...DEFAULT_SETTINGS.shortcuts, diff: 'Mod+Alt+D' }
  assert.equal(activeShortcuts({ settingsDraft: { shortcuts: draft }, settings: { ...DEFAULT_SETTINGS, shortcuts: saved } }).diff, 'Mod+Alt+D')
  assert.equal(activeShortcuts({ settingsDraft: {}, settings: { ...DEFAULT_SETTINGS, shortcuts: saved } }).diff, 'Mod+Shift+D')
  assert.equal(activeShortcuts({ settingsDraft: {}, settings: null }), DEFAULT_SETTINGS.shortcuts)
})

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
  for (const change of [{ target: new Target([SHORTCUT_RECORDER]) }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { repeat: true }]) {
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
  const selected: string[] = []
  useAppStore.setState({
    sessionRuntimes: {
      first: sessionRuntime('first'), other: sessionRuntime('other', 'elsewhere'),
      starting: sessionRuntime('starting', 'project', null), last: sessionRuntime('last'),
    },
    activeSessionRuntimeId: 'last',
    switchSession: async (path, projectPath) => {
      assert.equal(projectPath, '/project')
      selected.push(path)
      useAppStore.setState({ activeSessionRuntimeId: path.slice(1) })
    },
  })
  handleAppShortcut(keyEvent({ key: ']', code: 'BracketRight', target: new Target([SHORTCUT_RECORDER]) }))
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

test('push to talk holds while its keys are down and releases on its own key-up or a lost focus', () => {
  const commands: VoiceShortcutCommand[] = []
  const unsubscribe = onVoiceShortcut((command) => commands.push(command))
  const press = keyEvent({ key: 'T', code: 'KeyT', shiftKey: true })
  handleAppShortcut(press)
  handleAppShortcut(keyEvent({ key: 'T', code: 'KeyT', shiftKey: true, repeat: true }))
  assert.equal(press.defaultPrevented, true)
  assert.deepEqual(commands, ['hold'])
  handleAppShortcutRelease(keyEvent({ key: 'a', code: 'KeyA', metaKey: false }))
  assert.deepEqual(commands, ['hold'])
  handleAppShortcutRelease(keyEvent({ key: 'Meta', code: 'MetaLeft', metaKey: false, shiftKey: true }))
  handleAppShortcutRelease(keyEvent({ key: 'T', code: 'KeyT', metaKey: false }))
  assert.deepEqual(commands, ['hold', 'release'])
  handleAppShortcut(keyEvent({ key: 'T', code: 'KeyT', shiftKey: true }))
  releasePushToTalk()
  releasePushToTalk()
  assert.deepEqual(commands, ['hold', 'release', 'hold', 'release'])
  unsubscribe()
})

test('the system-wide dictation key is left to the main process when it reaches the window', () => {
  const commands: VoiceShortcutCommand[] = []
  const unsubscribe = onVoiceShortcut((command) => commands.push(command))
  useAppStore.getState().setSettingsDraft({ shortcuts: { ...DEFAULT_SETTINGS.shortcuts, globalDictation: 'Mod+Alt+D' } })
  const event = keyEvent({ key: 'd', code: 'KeyD', altKey: true })
  handleAppShortcut(event)
  assert.equal(event.defaultPrevented, false)
  assert.deepEqual(commands, [])
  unsubscribe()
})

test('in the terminal, Ctrl+K, Ctrl+B, Ctrl+N, Ctrl+G, Ctrl+[ and Ctrl+] go to the shell on Linux and Windows', async () => {
  arrangeShortcutEffects()
  const expected: string[] = []
  const reachedXterm: string[] = []
  const updates = await storeUpdatesDuring(() => {
    for (const platform of ['linux', 'win32']) {
      setPlatform(platform)
      for (const [key, code] of [['k', 'KeyK'], ['b', 'KeyB'], ['n', 'KeyN'], ['g', 'KeyG'], ['[', 'BracketLeft'], [']', 'BracketRight']]) {
        expected.push(`${platform} ${code}`)
        press(keyEvent({ ...CTRL, key, code, target: new Target([TERMINAL]) }), (event) => {
          if (!event.defaultPrevented) reachedXterm.push(`${platform} ${code}`)
          xtermSendsKey(event)
        })
      }
    }
  })
  assert.deepEqual(reachedXterm, expected)
  assert.equal(updates, 0)
})

test('in the terminal, the terminal toggle, Ctrl+Shift keys and macOS Cmd keys run their shortcuts before xterm', async () => {
  const reachedXterm: string[] = []
  const xterm = (event: KeyboardEvent) => { reachedXterm.push(event.code); xtermSendsKey(event) }
  const inTerminal = { target: new Target([TERMINAL]) }
  useAppStore.setState({ currentView: 'chat', workflowPanelOpen: false, terminalOpen: true })
  setPlatform('linux')
  press(keyEvent({ ...CTRL, ...inTerminal, key: '`', code: 'Backquote' }), xterm)
  assert.equal(useAppStore.getState().terminalOpen, false)
  // Moved to a control key, the toggle still closes the terminal from inside it.
  useAppStore.getState().setSettingsDraft({ shortcuts: { ...DEFAULT_SETTINGS.shortcuts, terminal: 'Mod+J' } })
  press(keyEvent({ ...CTRL, ...inTerminal, key: 'j', code: 'KeyJ' }), xterm)
  assert.equal(useAppStore.getState().terminalOpen, true)
  press(keyEvent({ ...CTRL, ...inTerminal, key: 'E', code: 'KeyE', shiftKey: true }), xterm)
  await settle()
  assert.equal(useAppStore.getState().chatSidePanel, 'files')
  setPlatform('darwin')
  press(keyEvent({ ...inTerminal, key: 'k', code: 'KeyK' }), xterm)
  assert.equal(useAppStore.getState().commandPaletteOpen, true)
  assert.deepEqual(reachedXterm, [])
})

test('in the terminal, a Ctrl key xterm does not send still runs its shortcut, and Windows copy and paste stay native', () => {
  setPlatform('linux')
  useAppStore.setState({ currentView: 'chat' })
  const reachedXterm: string[] = []
  // xterm 5.5 has no control character for Ctrl+Comma, so it lets the event bubble on.
  const settings = keyEvent({ ...CTRL, key: ',', code: 'Comma', target: new Target([TERMINAL]) })
  press(settings, (event) => { if (!event.defaultPrevented) reachedXterm.push(event.code) })
  assert.deepEqual(reachedXterm, ['Comma'])
  assert.equal(settings.defaultPrevented, true)
  assert.equal(useAppStore.getState().currentView, 'settings')
  // xterm skips Windows Ctrl+V and Ctrl+C (terminal-clipboard.ts) so that the browser pastes and copies.
  setPlatform('win32')
  for (const [key, code] of [['v', 'KeyV'], ['c', 'KeyC']]) {
    const clipboardKey = keyEvent({ ...CTRL, key, code, target: new Target([TERMINAL]) })
    press(clipboardKey)
    assert.equal(clipboardKey.defaultPrevented, false)
  }
})

test('in the code editor, its own indent, find-next and fold keys never run an app shortcut', async () => {
  arrangeShortcutEffects()
  const editorKeys: Array<[string, string, boolean]> = [['[', 'BracketLeft', false], [']', 'BracketRight', false], ['g', 'KeyG', false]]
  // Ctrl+Shift+[ and Ctrl+Shift+] fold and unfold on Linux and Windows.
  const foldKeys: Array<[string, string, boolean]> = [['{', 'BracketLeft', true], ['}', 'BracketRight', true]]
  const expected: string[] = []
  const reachedEditor: string[] = []
  const updates = await storeUpdatesDuring(() => {
    for (const platform of ['darwin', 'linux']) {
      setPlatform(platform)
      const modifier = platform === 'darwin' ? {} : CTRL
      for (const [key, code, shiftKey] of platform === 'darwin' ? editorKeys : [...editorKeys, ...foldKeys]) {
        const name = `${platform} ${shiftKey ? 'Shift+' : ''}${code}`
        expected.push(name)
        press(keyEvent({ ...modifier, key, code, shiftKey, target: new Target([CODE_EDITOR]) }), (event) => {
          if (!event.defaultPrevented) reachedEditor.push(name)
          editorRunsCommand(event)
        })
      }
    }
  })
  assert.deepEqual(reachedEditor, expected)
  assert.equal(updates, 0)
})

test('in the code editor, a shortcut its keymap leaves alone runs once, after the editor', async () => {
  const palette: boolean[] = []
  useAppStore.setState({ setCommandPalette: (open) => { palette.push(open) }, currentView: 'chat', workflowPanelOpen: false })
  const reachedEditor: string[] = []
  const editor = (event: KeyboardEvent) => { if (!event.defaultPrevented) reachedEditor.push(event.code) }
  const inEditor = { target: new Target([CODE_EDITOR]) }
  const commandPalette = keyEvent({ ...inEditor, key: 'k', code: 'KeyK' })
  press(commandPalette, editor)
  assert.deepEqual(palette, [true])
  assert.equal(commandPalette.defaultPrevented, true)
  press(keyEvent({ ...inEditor, key: 'b', code: 'KeyB' }), editor)
  press(keyEvent({ ...inEditor, key: 'E', code: 'KeyE', shiftKey: true }), editor)
  await settle()
  assert.deepEqual(reachedEditor, ['KeyK', 'KeyB', 'KeyE'])
  assert.equal(useAppStore.getState().sidebarOpen, false)
  assert.equal(useAppStore.getState().chatSidePanel, 'files')
  // Even with both listeners called for one press, its shortcut runs once, in the editor and elsewhere.
  for (const target of [new Target([CODE_EDITOR]), new Target()]) {
    const event = keyEvent({ key: 'k', code: 'KeyK', target })
    handleAppShortcut(event)
    handleAppShortcutAfterTarget(event)
  }
  assert.deepEqual(palette, [true, true, true])
})

test('push to talk holds and releases from inside the code editor and the terminal', () => {
  const commands: VoiceShortcutCommand[] = []
  const unsubscribe = onVoiceShortcut((command) => commands.push(command))
  const reachedFocused: string[] = []
  for (const platform of ['darwin', 'linux']) {
    setPlatform(platform)
    const modifier = platform === 'darwin' ? {} : CTRL
    for (const within of [CODE_EDITOR, TERMINAL]) {
      const pushToTalk = { ...modifier, key: 'T', code: 'KeyT', shiftKey: true, target: new Target([within]) }
      press(keyEvent(pushToTalk), () => reachedFocused.push(`${platform} ${within}`))
      press(keyEvent({ ...pushToTalk, repeat: true }))
      handleAppShortcutRelease(keyEvent(pushToTalk))
    }
  }
  // The editor binds no command to the key and sees it first; xterm never sees it.
  assert.deepEqual(reachedFocused, [`darwin ${CODE_EDITOR}`, `linux ${CODE_EDITOR}`])
  press(keyEvent({ ...CTRL, key: 'T', code: 'KeyT', shiftKey: true, target: new Target([CODE_EDITOR]) }))
  releasePushToTalk()
  assert.deepEqual(commands, ['hold', 'release', 'hold', 'release', 'hold', 'release', 'hold', 'release', 'hold', 'release'])
  unsubscribe()
})
