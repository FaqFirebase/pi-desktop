import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiMessageUpdateEvent, PiRpcEvent } from '../../shared/ipc-contracts'

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = {
    piDesktop: { session: { getStats: async () => null } },
  }
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  useAppStore.setState({
    messages: [],
    timelineEvents: [],
    isStreaming: true,
    streamingContent: '',
    streamingThinking: '',
    streamingToolCalls: new Map(),
    subagentProgress: [],
    reattachedMidTurn: false,
  })
})

function emit(event: PiRpcEvent): void {
  useAppStore.getState().handlePiEvent(event)
}

function update(assistantMessageEvent: PiMessageUpdateEvent['assistantMessageEvent']): void {
  emit({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent })
}

test('tool argument streaming is visible before execution starts', () => {
  const toolCall = { type: 'toolCall', id: 'write-1', name: 'write', arguments: {} }
  const partial = { role: 'assistant', content: [{ type: 'text', text: 'Preparing' }, toolCall] }
  update({ type: 'toolcall_start', contentIndex: 1, partial })

  assert.equal(useAppStore.getState().streamingToolCalls.get(toolCall.id)?.name, 'write')
  assert.equal(useAppStore.getState().streamingToolCalls.get(toolCall.id)?.isExecuting, true)

  update({ type: 'toolcall_delta', contentIndex: 1, partial, delta: '{"path":' })
  update({ type: 'toolcall_delta', contentIndex: 1, partial, delta: '"test.ts"}' })
  assert.equal(useAppStore.getState().streamingToolCalls.get(toolCall.id)?.args, '{"path":"test.ts"}')

  const completed = { ...toolCall, arguments: { path: 'test.ts', content: 'export {}' } }
  update({ type: 'toolcall_end', contentIndex: 1, partial, toolCall: completed })
  assert.equal(useAppStore.getState().streamingToolCalls.get(toolCall.id)?.args, JSON.stringify(completed.arguments))

  emit({ type: 'message_end', message: { role: 'assistant', content: [completed] } })
  assert.equal(useAppStore.getState().streamingToolCalls.get(toolCall.id)?.isExecuting, true)
  assert.equal(useAppStore.getState().messages.length, 0)

  emit({ type: 'tool_execution_start', toolCallId: toolCall.id, toolName: 'write', args: completed.arguments })
  emit({
    type: 'tool_execution_end', toolCallId: toolCall.id, toolName: 'write',
    result: { content: [{ type: 'text', text: 'File written' }], details: {} }, isError: false,
  })
  emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: toolCall.id, content: [] } })
  emit({ type: 'turn_end', message: { role: 'assistant', content: [completed] }, toolResults: [] })

  const calls = useAppStore.getState().messages.flatMap((message) => message.toolCalls ?? [])
  assert.equal(calls.length, 1, 'argument streaming and execution must produce only one tool call')
  assert.equal(calls[0].arguments, JSON.stringify(completed.arguments))
  assert.equal(calls[0].result, 'File written')
})

test('one completed tool does not clear another running tool or its subagent progress', () => {
  emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'test.ts' } })
  emit({ type: 'tool_execution_start', toolCallId: 'agent-1', toolName: 'subagent', args: { agent: 'reviewer', task: 'Review changes' } })
  emit({
    type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read',
    result: { content: [{ type: 'text', text: 'file contents' }], details: {} }, isError: false,
  })
  emit({
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: 'file contents' }] },
  })

  assert.equal(useAppStore.getState().streamingToolCalls.get('agent-1')?.isExecuting, true)
  assert.equal(useAppStore.getState().streamingToolCalls.get('read-1')?.result, 'file contents')
  assert.equal(useAppStore.getState().subagentProgress[0]?.status, 'running')
  assert.equal(useAppStore.getState().timelineEvents.some((event) => event.type === 'assistant_message'), false)

  emit({
    type: 'tool_execution_update', toolCallId: 'agent-1', toolName: 'subagent', args: {},
    partialResult: { content: [{ type: 'text', text: 'Checking changes' }], details: {} },
  })
  assert.equal(useAppStore.getState().streamingToolCalls.get('agent-1')?.result, 'Checking changes')

  emit({
    type: 'tool_execution_end', toolCallId: 'agent-1', toolName: 'subagent',
    result: { content: [{ type: 'text', text: 'Review complete' }], details: {} }, isError: false,
  })
  emit({
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: 'agent-1', content: [{ type: 'text', text: 'Review complete' }] },
  })
  emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] })

  const state = useAppStore.getState()
  assert.deepEqual(state.messages.filter((message) => message.role === 'toolResult').map((message) => message.content), [
    'file contents', 'Review complete',
  ])
  assert.equal(state.streamingToolCalls.size, 0)
  assert.equal(state.subagentProgress.length, 0)
  assert.equal(state.isStreaming, true)

  update({ type: 'text_delta', delta: 'All checked.' })
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'All checked.' }] } })
  emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [] })
  emit({ type: 'agent_end', messages: [] })
  assert.equal(useAppStore.getState().messages.filter((message) => message.content === 'All checked.').length, 1)
  assert.equal(useAppStore.getState().isStreaming, false)
})

test('assistant text is committed while its tools stay live until the turn ends', () => {
  const toolCall = { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'test.ts' } }
  const message = { role: 'assistant', content: [{ type: 'text', text: 'Checking the file.' }, toolCall] }
  update({ type: 'text_delta', delta: 'Checking the file.' })
  update({ type: 'toolcall_start', contentIndex: 1, partial: message })
  update({ type: 'toolcall_end', contentIndex: 1, partial: message, toolCall })
  emit({ type: 'message_end', message })

  assert.equal(useAppStore.getState().messages[0]?.content, 'Checking the file.')
  assert.equal(useAppStore.getState().messages[0]?.toolCalls, undefined)
  assert.equal(useAppStore.getState().streamingContent, '')
  assert.equal(useAppStore.getState().streamingToolCalls.get(toolCall.id)?.isExecuting, true)

  emit({ type: 'tool_execution_start', toolCallId: toolCall.id, toolName: 'read', args: toolCall.arguments })
  emit({
    type: 'tool_execution_end', toolCallId: toolCall.id, toolName: 'read',
    result: { content: [{ type: 'text', text: 'file contents' }], details: {} }, isError: false,
  })
  emit({ type: 'turn_end', message, toolResults: [] })

  const messages = useAppStore.getState().messages
  assert.equal(messages.filter((entry) => entry.content === 'Checking the file.').length, 1)
  assert.equal(messages.flatMap((entry) => entry.toolCalls ?? []).length, 1)
  assert.equal(useAppStore.getState().streamingToolCalls.size, 0)
})

test('a user message ending mid-stream leaves the assistant buffers intact', () => {
  update({ type: 'text_delta', delta: 'Current response' })
  update({ type: 'thinking_delta', delta: 'Current reasoning' })
  emit({ type: 'message_end', message: { role: 'user', content: 'Additional instruction' } })

  assert.equal(useAppStore.getState().streamingContent, 'Current response')
  assert.equal(useAppStore.getState().streamingThinking, 'Current reasoning')
  assert.equal(useAppStore.getState().messages.length, 0)
  assert.equal(useAppStore.getState().timelineEvents.length, 0)
})
