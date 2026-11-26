import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { useAppStore } from './store'
import type { SessionListItem, SessionState } from '../../shared/ipc-contracts'

const initialState = useAppStore.getState()
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const FILE_A = '/sessions/proj/a.jsonl'
const FILE_B = '/sessions/proj/b.jsonl'

function sessionState(sessionFile: string, sessionName: string | null = null): SessionState {
  return {
    model: null,
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'all',
    sessionFile,
    sessionId: sessionFile,
    sessionName,
    autoCompactionEnabled: false,
    messageCount: 0,
    pendingMessageCount: 0,
  }
}

function listItem(path: string): SessionListItem {
  return { path, name: null, preview: null, sessionId: path, lastModified: 1, messageCount: 1, projectPath: '/proj', projectName: 'proj' }
}

function stubSetName(setName: (name: string) => Promise<unknown>): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { piDesktop: { session: { setName } } } })
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('a confirmed rename shows without a session_info_changed event', async () => {
  // OMP answers set_session_name and sends no event.
  stubSetName(async () => ({ type: 'response', command: 'set_session_name', success: true }))
  useAppStore.setState({ sessionState: sessionState(FILE_A), sessionList: [listItem(FILE_A), listItem(FILE_B)] })
  await useAppStore.getState().setSessionName('Renamed')
  const state = useAppStore.getState()
  assert.equal(state.sessionState?.sessionName, 'Renamed')
  assert.deepEqual(state.sessionList.map((item) => item.name), ['Renamed', null])
})

test('a rename answered after a switch leaves the newly shown session alone', async () => {
  let answer: (value: unknown) => void = () => {}
  stubSetName(() => new Promise((resolve) => { answer = resolve }))
  useAppStore.setState({ sessionState: sessionState(FILE_A), sessionList: [listItem(FILE_A), listItem(FILE_B)] })
  const renaming = useAppStore.getState().setSessionName('Renamed')
  useAppStore.setState({ sessionState: sessionState(FILE_B, 'Other') })
  answer({ success: true })
  await renaming
  const state = useAppStore.getState()
  assert.equal(state.sessionState?.sessionName, 'Other')
  assert.deepEqual(state.sessionList.map((item) => item.name), [null, null])
})

test('a refused rename keeps the current name', async () => {
  stubSetName(async () => ({ success: false, error: 'Session name cannot be empty' }))
  useAppStore.setState({ sessionState: sessionState(FILE_A, 'Kept'), sessionList: [listItem(FILE_A)] })
  await useAppStore.getState().setSessionName('Renamed')
  assert.equal(useAppStore.getState().sessionState?.sessionName, 'Kept')
})
