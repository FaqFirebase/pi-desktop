import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { useAppStore } from './store'
import { PROJECT_TAB_ORDER_STORAGE_KEY, projectTabs, readProjectTabOrder } from './utils/tab-navigation'

const initialState = useAppStore.getState()
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
let saved: Map<string, string>

beforeEach(() => {
  saved = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { piDesktop: {
    ui: { setEditorDirty: () => {} },
  } } })
  useAppStore.setState(initialState, true)
  const workspaces = ['a', 'b', 'c'].map((id, createdAt) => ({
    id, createdAt, name: id, path: `/${id}`, lastActiveAt: 0, color: '',
  }))
  useAppStore.setState({ workspaces, activeWorkspace: workspaces[1], projectTabOrder: [] })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  for (const [key, descriptor] of [['localStorage', originalStorage], ['window', originalWindow]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('reordering persists the visible order without switching projects or disturbing sessions and edits', async () => {
  useAppStore.setState({ editorDirty: true })
  const before = useAppStore.getState()
  before.reorderProjectTab('c', 'a', 'before')
  const after = useAppStore.getState()
  assert.deepEqual(after.projectTabOrder, ['c', 'a', 'b'])
  assert.deepEqual(readProjectTabOrder(), after.projectTabOrder)
  assert.equal(after.activeWorkspace, before.activeWorkspace)
  assert.equal(after.sessionRuntimes, before.sessionRuntimes)
  assert.equal(after.editorDirty, true)
  assert.equal(after.confirmRequest, null)
  assert.equal(after.workspaces, before.workspaces)

  Object.defineProperty(globalThis, 'window', { configurable: true, value: { piDesktop: {
    ui: { setEditorDirty: () => {} },
    workspace: {
      list: async () => [...before.workspaces].reverse(),
      getActive: async () => before.activeWorkspace,
    },
  } } })
  await after.loadWorkspaces()
  const refreshed = useAppStore.getState()
  assert.deepEqual(projectTabs(refreshed.workspaces, refreshed.projectTabOrder).map((tab) => tab.id), ['c', 'a', 'b'])
})

test('self-drops, unchanged positions and stale targets do not change or persist order', () => {
  const before = useAppStore.getState()
  before.reorderProjectTab('a', 'a', 'after')
  before.reorderProjectTab('a', 'b', 'before')
  before.reorderProjectTab('closed', 'a', 'before')
  before.reorderProjectTab('a', 'closed', 'after')
  assert.equal(useAppStore.getState(), before)
  assert.equal(saved.size, 0)
})

test('missing or damaged stored order uses creation order; duplicate IDs are normalized', () => {
  assert.deepEqual(readProjectTabOrder(), [])
  for (const invalid of ['not JSON', '{}', 'null', '["a", 1]']) {
    saved.set(PROJECT_TAB_ORDER_STORAGE_KEY, invalid)
    assert.deepEqual(readProjectTabOrder(), [])
  }
  saved.set(PROJECT_TAB_ORDER_STORAGE_KEY, '["c", "a", "c"]')
  assert.deepEqual(readProjectTabOrder(), ['c', 'a'])
})

test('blocked storage does not prevent reordering in the current window', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked') } })
  assert.deepEqual(readProjectTabOrder(), [])
  useAppStore.getState().reorderProjectTab('a', 'c', 'after')
  assert.deepEqual(useAppStore.getState().projectTabOrder, ['b', 'c', 'a'])
})
