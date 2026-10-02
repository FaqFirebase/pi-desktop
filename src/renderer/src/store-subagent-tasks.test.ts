import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcEvent } from '../../shared/ipc-contracts'
import { PI_ASYNC_WIDGET_PREFIX, type SubagentListResult } from '../../shared/subagent-task'

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore
let listReply: () => Promise<SubagentListResult>
let listedRuntimeIds: string[] = []

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = {
    piDesktop: {
      session: { getStats: async () => null },
      subagents: { list: (runtimeId: string) => { listedRuntimeIds.push(runtimeId); return listReply() } },
    },
  }
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  listReply = async () => ({ supported: false, tasks: [] })
  listedRuntimeIds = []
  useAppStore.setState({
    activeSessionRuntimeId: 'rt-1',
    messages: [],
    isStreaming: true,
    streamingToolCalls: new Map(),
    subagentTasks: [],
    subagentEventsSupported: false,
    selectedSubagentTaskId: null,
    piEngine: 'omp',
  })
})

function emit(event: PiRpcEvent): void {
  useAppStore.getState().handlePiEvent(event)
}

const TASK_START: PiRpcEvent = { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'task', args: { agent: 'scout', task: 'Review' } }
const TASK_END: PiRpcEvent = {
  type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'task',
  result: { content: [{ type: 'text', text: 'Spawned 1 background agent' }], details: { results: [], progress: [{ id: 'A', agent: 'scout', status: 'pending' }] } },
  isError: false,
}

test('with OMP subagent events, the async task tool end does not mark subagents done', () => {
  useAppStore.setState({ subagentEventsSupported: true })
  emit({ type: 'subagent_lifecycle', payload: { id: 'A', agent: 'scout', description: 'Review', status: 'started' } })
  emit(TASK_START)
  emit(TASK_END)
  assert.deepEqual(useAppStore.getState().subagentTasks.map((task) => [task.id, task.status]), [['A', 'running']])
  emit({ type: 'subagent_progress', payload: { agent: 'scout', progress: { id: 'A', status: 'running', currentTool: 'grep' } } })
  assert.equal(useAppStore.getState().subagentTasks[0].currentTool, 'grep')
  emit({ type: 'subagent_lifecycle', payload: { id: 'A', status: 'completed' } })
  assert.equal(useAppStore.getState().subagentTasks[0].status, 'done')
})

test('rows survive turn end and reset when the chat is cleared', () => {
  useAppStore.setState({ subagentEventsSupported: true, selectedSubagentTaskId: 'A' })
  emit({ type: 'subagent_lifecycle', payload: { id: 'A', agent: 'scout', status: 'started' } })
  emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] })
  assert.equal(useAppStore.getState().subagentTasks.length, 1)
  useAppStore.getState().clearMessages()
  const state = useAppStore.getState()
  assert.equal(state.subagentTasks.length, 0)
  assert.equal(state.selectedSubagentTaskId, null)
  assert.equal(state.subagentEventsSupported, false)
})

test('without OMP subagent events, tool events still produce rows', () => {
  emit(TASK_START)
  assert.deepEqual(useAppStore.getState().subagentTasks.map((task) => [task.id, task.status]), [['call-1', 'running']])
})

test('the pi-subagents async widget feeds rows; other widgets are ignored', () => {
  useAppStore.setState({ piEngine: 'pi' })
  const snapshot = { kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [{ id: 'async-1', kind: 'subagent', label: 'reviewer', state: 'running' }] }
  emit({ type: 'extension_ui_request', id: 'u1', method: 'setWidget', widgetKey: 'other', widgetLines: [`${PI_ASYNC_WIDGET_PREFIX}${JSON.stringify(snapshot)}`] })
  assert.equal(useAppStore.getState().subagentTasks.length, 0)
  emit({ type: 'extension_ui_request', id: 'u2', method: 'setWidget', widgetKey: 'subagent-async', widgetLines: [`${PI_ASYNC_WIDGET_PREFIX}${JSON.stringify(snapshot)}`] })
  assert.deepEqual(useAppStore.getState().subagentTasks.map((task) => task.id), ['async-1'])
  emit({ type: 'extension_ui_request', id: 'u3', method: 'setWidget', widgetKey: 'subagent-async' })
  assert.deepEqual(useAppStore.getState().subagentTasks.map((task) => task.id), ['async-1'])
})

test('a listing seeds OMP rows and turns on event mode', async () => {
  emit(TASK_START)
  listReply = async () => ({ supported: true, tasks: [{ id: 'A', source: 'omp', agent: 'scout', label: '', status: 'running', transcriptRef: { kind: 'omp', subagentId: 'A' } }] })
  await useAppStore.getState().refreshSubagentTasks()
  const state = useAppStore.getState()
  assert.equal(state.subagentEventsSupported, true)
  assert.deepEqual(state.subagentTasks.map((task) => task.id), ['A'])
})

test('a listing that answers after a chat switch is dropped', async () => {
  let release!: (value: SubagentListResult) => void
  listReply = () => new Promise((resolve) => { release = resolve })
  useAppStore.setState({ activeSessionRuntimeId: 'one' })
  const pending = useAppStore.getState().refreshSubagentTasks()
  useAppStore.setState({ activeSessionRuntimeId: 'two' })
  release({ supported: true, tasks: [{ id: 'A', source: 'omp', agent: 'scout', label: '', status: 'running', transcriptRef: { kind: 'omp', subagentId: 'A' } }] })
  await pending
  assert.equal(useAppStore.getState().subagentTasks.length, 0)
  assert.equal(useAppStore.getState().subagentEventsSupported, false)
})

test('a status from the transcript view updates its row', () => {
  useAppStore.setState({ subagentTasks: [{ id: 'x', source: 'pi-subagents', agent: 'a', label: '', status: 'running', transcriptRef: { kind: 'pi-async', asyncId: 'x' } }] })
  useAppStore.getState().setSubagentTaskStatus('x', 'done')
  assert.equal(useAppStore.getState().subagentTasks[0].status, 'done')
})

test('the listing asks for the active session and is skipped without one', async () => {
  await useAppStore.getState().refreshSubagentTasks()
  useAppStore.setState({ activeSessionRuntimeId: null })
  await useAppStore.getState().refreshSubagentTasks()
  assert.deepEqual(listedRuntimeIds, ['rt-1'])
})
