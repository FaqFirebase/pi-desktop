import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyMessageUpdate,
  applyToolEnd,
  applyToolStart,
  applyToolUpdate,
  applyTurnComplete,
  emptyChatStreamState,
  placeStreamedDelta,
  turnErrorText,
  type ChatStreamClock,
  type ChatStreamState,
  type TurnCompleteOptions,
} from './chat-stream'
import { CLAUDE_CLI_PROVIDER_ID } from './claude-cli-markers'
import type {
  PiMessageUpdateEvent,
  PiToolExecutionEndEvent,
  PiToolExecutionStartEvent,
  PiToolExecutionUpdateEvent,
} from '../ipc-contracts'

const START_TIME = 1_000
/** turn_end, agent_end and an engine stop: tools are committed too. */
const AT_TURN_END: TurnCompleteOptions = { completeTools: true, activeModel: undefined }

/** A clock the test moves by hand, with ids that count up. */
function createClock(): ChatStreamClock & { advance(ms: number): void } {
  let time = START_TIME
  let nextId = 1
  return {
    now: () => time,
    generateId: () => `id-${nextId++}`,
    advance: (ms) => {
      time += ms
    },
  }
}

function merge(state: ChatStreamState, patch: Partial<ChatStreamState>): ChatStreamState {
  return { ...state, ...patch }
}

/** Apply one message update and return the new state. */
function stream(state: ChatStreamState, event: PiMessageUpdateEvent, clock: ChatStreamClock): ChatStreamState {
  return merge(state, applyMessageUpdate(state, event, clock).patch)
}

function update(
  type: string,
  fields: Partial<PiMessageUpdateEvent['assistantMessageEvent']> = {},
): PiMessageUpdateEvent {
  return { type: 'message_update', message: {}, assistantMessageEvent: { type, ...fields } }
}

function toolStart(toolCallId: string, toolName: string, args: Record<string, unknown> = {}): PiToolExecutionStartEvent {
  return { type: 'tool_execution_start', toolCallId, toolName, args }
}

function toolUpdate(toolCallId: string, toolName: string, text: string, details: Record<string, unknown> = {}): PiToolExecutionUpdateEvent {
  return {
    type: 'tool_execution_update',
    toolCallId,
    toolName,
    args: {},
    partialResult: { content: [{ type: 'text', text }], details },
  }
}

function toolEnd(toolCallId: string, toolName: string, text: string, isError = false): PiToolExecutionEndEvent {
  return {
    type: 'tool_execution_end',
    toolCallId,
    toolName,
    result: { content: [{ type: 'text', text }], details: {} },
    isError,
  }
}

test('deltas take their place by offset, and a delta the view already holds changes nothing', () => {
  assert.equal(placeStreamedDelta('', 'Hello', 0), 'Hello')
  assert.equal(placeStreamedDelta('Hello', ' world', 5), 'Hello world')
  assert.equal(placeStreamedDelta('Hello world', ' world', 5), 'Hello world')
  assert.equal(placeStreamedDelta('Hello', ' there', undefined), 'Hello there')
  assert.equal(placeStreamedDelta('', 'middle of a sentence', 40), null)
})

test('text and thinking deltas append to their buffers', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  state = stream(state, update('text_delta', { delta: 'Hel', offset: 0 }), clock)
  state = stream(state, update('text_delta', { delta: 'lo', offset: 3 }), clock)
  state = stream(state, update('thinking_delta', { delta: 'hmm' }), clock)

  assert.equal(state.streamingContent, 'Hello')
  assert.equal(state.streamingThinking, 'hmm')
})

test('a delta past the end of the buffer reports a missed start and changes nothing', () => {
  const clock = createClock()
  const state = { ...emptyChatStreamState(), streamingContent: 'Hi' }

  assert.deepEqual(applyMessageUpdate(state, update('text_delta', { delta: 'later', offset: 40 }), clock), {
    patch: {},
    missedStart: true,
  })
  assert.deepEqual(applyMessageUpdate(state, update('thinking_delta', { delta: 'x', offset: 5 }), clock), {
    patch: {},
    missedStart: true,
  })
})

test('text_end, thinking_end and unknown update types change nothing', () => {
  const clock = createClock()
  const state = emptyChatStreamState()
  const unchanged = { patch: {}, missedStart: false }

  assert.deepEqual(applyMessageUpdate(state, update('text_end'), clock), unchanged)
  assert.deepEqual(applyMessageUpdate(state, update('thinking_end'), clock), unchanged)
  assert.deepEqual(applyMessageUpdate(state, update('something_new'), clock), unchanged)
})

test('a streamed tool call builds its arguments and stays running until it executes', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  state = stream(state, update('toolcall_start', { toolCall: { id: 'c1', name: 'read' } }), clock)
  assert.deepEqual(state.streamingToolCalls.get('c1'), { name: 'read', args: '', isExecuting: true, startedAt: START_TIME })

  state = stream(state, update('toolcall_delta', { toolCall: { id: 'c1' }, delta: '{"pa' }), clock)
  assert.equal(state.streamingToolCalls.get('c1')?.args, '{"pa')

  clock.advance(250)
  state = stream(state, update('toolcall_end', { toolCall: { id: 'c1', arguments: { path: 'a.ts' } } }), clock)
  assert.deepEqual(state.streamingToolCalls.get('c1'), {
    name: 'read',
    args: '{"path":"a.ts"}',
    isExecuting: true,
    startedAt: START_TIME,
  })
})

test('start and delta events find the tool call by its index in the partial message', () => {
  const clock = createClock()
  const partial = { content: [{ type: 'text', text: 'x' }, { type: 'toolCall', id: 'c7', name: 'bash' }] }
  let state = emptyChatStreamState()
  state = stream(state, update('toolcall_start', { contentIndex: 1, partial }), clock)
  state = stream(state, update('toolcall_delta', { contentIndex: 1, partial, delta: '{"command":' }), clock)

  assert.equal(state.streamingToolCalls.get('c7')?.name, 'bash')
  assert.equal(state.streamingToolCalls.get('c7')?.args, '{"command":')
})

test('a tool call delta or end for an unknown id adds nothing', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  state = stream(state, update('toolcall_delta', { toolCall: { id: 'nope' }, delta: 'x' }), clock)
  state = stream(state, update('toolcall_end', { toolCall: { id: 'nope' } }), clock)

  assert.equal(state.streamingToolCalls.size, 0)
})

test('a tool call start without a toolCall payload changes nothing', () => {
  const clock = createClock()
  assert.deepEqual(applyMessageUpdate(emptyChatStreamState(), update('toolcall_start'), clock), { patch: {}, missedStart: false })
})

test('applyMessageUpdate does not change the map it was given', () => {
  const clock = createClock()
  const state = emptyChatStreamState()
  applyMessageUpdate(state, update('toolcall_start', { toolCall: { id: 'c1', name: 'read' } }), clock)

  assert.equal(state.streamingToolCalls.size, 0)
})

test('turn end commits the assistant message and one result per finished tool call', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  state = stream(state, update('text_delta', { delta: 'Done.' }), clock)
  state = stream(state, update('thinking_delta', { delta: 'plan' }), clock)
  state = merge(state, applyToolStart(state, toolStart('c1', 'bash', { command: 'ls' }), clock))
  clock.advance(40)
  state = merge(state, applyToolEnd(state, toolEnd('c1', 'bash', 'a.ts'), clock))
  state = merge(state, applyToolStart(state, toolStart('c2', 'read', { path: 'b.ts' }), clock))

  state = merge(state, applyTurnComplete(state, { model: 'm-1', provider: 'p-1' }, { completeTools: true, activeModel: { id: 'active', provider: 'other' } }, clock))

  assert.deepEqual(state.messages, [
    {
      id: 'id-1',
      role: 'assistant',
      content: 'Done.',
      timestamp: START_TIME + 40,
      thinking: 'plan',
      initiallyShowThinking: true,
      toolCalls: [
        { id: 'c1', name: 'bash', arguments: '{"command":"ls"}', result: 'a.ts', isError: false, isExecuting: false, durationMs: 40 },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}', result: undefined, isError: undefined, isExecuting: false, durationMs: undefined },
      ],
      model: 'm-1',
      provider: 'p-1',
      stopped: undefined,
    },
    { id: 'c1-result', role: 'toolResult', content: 'a.ts', timestamp: START_TIME + 40, toolCallId: 'c1', toolName: 'bash' },
  ])
  assert.equal(state.streamingContent, '')
  assert.equal(state.streamingThinking, '')
  assert.equal(state.streamingToolCalls.size, 0)
  assert.deepEqual(state.subagentProgress, [])
})

test('an assistant message end commits the full text and keeps its tools live until the turn ends', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  // A view that attached late saw only the end of the text.
  state = stream(state, update('text_delta', { delta: 'world' }), clock)
  state = merge(state, applyToolStart(state, toolStart('c1', 'bash', { command: 'ls' }), clock))
  const ended = {
    role: 'assistant',
    stopReason: 'toolUse',
    timestamp: 1_790_000_000_000,
    content: [
      { type: 'text', text: 'Hello world' },
      { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
    ],
  }

  state = merge(state, applyTurnComplete(state, ended, { completeTools: false, activeModel: undefined }, clock))

  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].content, 'Hello world')
  assert.equal(state.messages[0].timestamp, 1_790_000_000_000)
  assert.equal(state.messages[0].toolCalls, undefined)
  assert.equal(state.streamingToolCalls.get('c1')?.isExecuting, true)

  state = merge(state, applyToolEnd(state, toolEnd('c1', 'bash', 'a.ts'), clock))
  state = merge(state, applyTurnComplete(state, undefined, AT_TURN_END, clock))

  assert.equal(state.messages.length, 3)
  assert.equal(state.messages[1].toolCalls?.[0].id, 'c1')
  assert.equal(state.messages[1].toolCalls?.[0].result, 'a.ts')
  assert.equal(state.messages[2].role, 'toolResult')
  assert.equal(state.streamingToolCalls.size, 0)
})

test('a stopped answer is kept and marked even when nothing streamed', () => {
  const clock = createClock()
  const state = emptyChatStreamState()
  const stopped = { role: 'assistant', stopReason: 'aborted', errorMessage: 'Request was aborted', content: [] }

  const patch = applyTurnComplete(state, stopped, { completeTools: false, activeModel: undefined }, clock)

  assert.equal(patch.messages?.length, 1)
  assert.equal(patch.messages?.[0].stopped, true)
})

test('only the message end marks an answer as stopped, not the turn end', () => {
  const clock = createClock()
  const state = { ...emptyChatStreamState(), streamingContent: 'partial' }
  const stopped = { role: 'assistant', stopReason: 'aborted', content: [] }

  const patch = applyTurnComplete(state, stopped, AT_TURN_END, clock)

  assert.equal(patch.messages?.[0].stopped, undefined)
})

test('Claude CLI tool markers become tool calls for that provider only', () => {
  const clock = createClock()
  const text = 'Reading.[Claude Code · Read #t1 {"file_path":"a.ts"}][Claude Code · result #t1 {"summary":"ok"}] Done.'
  const state = { ...emptyChatStreamState(), streamingContent: text }

  const claude = applyTurnComplete(state, undefined, { completeTools: true, activeModel: { provider: CLAUDE_CLI_PROVIDER_ID } }, clock)
  assert.equal(claude.messages?.[0].content, 'Reading. Done.')
  assert.deepEqual(claude.messages?.[0].toolCalls, [{ id: 't1', name: 'Read', arguments: '{"file_path":"a.ts"}', result: 'ok', isError: false }])

  const other = applyTurnComplete(state, undefined, { completeTools: true, activeModel: { provider: 'anthropic' } }, clock)
  assert.equal(other.messages?.[0].content, text)
  assert.equal(other.messages?.[0].toolCalls, undefined)
})

test('turn end falls back to the active model when the message names none', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  state = stream(state, update('text_delta', { delta: 'Hi' }), clock)
  state = merge(state, applyTurnComplete(state, undefined, { completeTools: true, activeModel: { id: 'active', provider: 'prov' } }, clock))

  assert.equal(state.messages[0].model, 'active')
  assert.equal(state.messages[0].provider, 'prov')
  assert.equal(state.messages[0].thinking, undefined)
  assert.equal(state.messages[0].toolCalls, undefined)
})

test('a turn end with empty buffers commits nothing and keeps the same message list', () => {
  const clock = createClock()
  const existing = { id: 'old', role: 'user' as const, content: 'q', timestamp: 1 }
  const state = { ...emptyChatStreamState(), messages: [existing] }

  const patch = applyTurnComplete(state, { model: 'm' }, AT_TURN_END, clock)

  assert.equal(patch.messages, state.messages)
})

test('tool start adds an executing call with its arguments as JSON', () => {
  const clock = createClock()
  const patch = applyToolStart(emptyChatStreamState(), toolStart('c1', 'bash', { command: 'ls' }), clock)

  assert.deepEqual(patch.streamingToolCalls?.get('c1'), {
    name: 'bash',
    args: '{"command":"ls"}',
    isExecuting: true,
    startedAt: START_TIME,
  })
  assert.equal(patch.subagentProgress, undefined)
})

test('tool start for a subagent tool adds a progress row with a cut caption', () => {
  const clock = createClock()
  const longTask = 'x'.repeat(300)
  const patch = applyToolStart(emptyChatStreamState(), toolStart('s1', 'subagent', { agent: 'reviewer', task: longTask }), clock)

  assert.deepEqual(patch.subagentProgress, [
    { toolCallId: 's1', agent: 'reviewer', status: 'running', task: 'x'.repeat(120), toolCount: 0, tokens: 0, durationMs: 0 },
  ])
})

test('tool update sets the partial result and keeps the old one when the new text is empty', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  state = merge(state, applyToolStart(state, toolStart('c1', 'bash'), clock))
  state = merge(state, applyToolUpdate(state, toolUpdate('c1', 'bash', 'line 1')))
  assert.equal(state.streamingToolCalls.get('c1')?.result, 'line 1')

  state = merge(state, applyToolUpdate(state, toolUpdate('c1', 'bash', '')))
  assert.equal(state.streamingToolCalls.get('c1')?.result, 'line 1')
})

test('a tool update for a call this view never saw start gives it a live card', () => {
  const patch = applyToolUpdate(emptyChatStreamState(), toolUpdate('c9', 'bash', 'still going'))

  assert.deepEqual(patch.streamingToolCalls?.get('c9'), { name: 'bash', args: '{}', isExecuting: true, result: 'still going' })
})

test('tool update folds subagent details into the matching progress row', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  state = merge(state, applyToolStart(state, toolStart('s1', 'subagent', { agent: 'reviewer', task: 'check' }), clock))
  state = merge(
    state,
    applyToolUpdate(
      state,
      toolUpdate('s1', 'subagent', '', { progress: [{ status: 'running', toolCount: 3, tokens: 50, durationMs: 900, currentTool: 'read' }] }),
    ),
  )

  assert.equal(state.subagentProgress[0].toolCount, 3)
  assert.equal(state.subagentProgress[0].tokens, 50)
  assert.equal(state.subagentProgress[0].currentTool, 'read')
  assert.equal(state.subagentProgress[0].status, 'running')
})

test('tool end records the result, the error flag and the duration', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  state = merge(state, applyToolStart(state, toolStart('c1', 'bash'), clock))
  clock.advance(75)
  const patch = applyToolEnd(state, toolEnd('c1', 'bash', 'boom', true), clock)
  state = merge(state, patch)

  // A call this view saw start never touches the saved history.
  assert.equal('messages' in patch, false)
  assert.deepEqual(state.streamingToolCalls.get('c1'), {
    name: 'bash',
    args: '{}',
    isExecuting: false,
    isError: true,
    result: 'boom',
    startedAt: START_TIME,
    durationMs: 75,
  })
})

test('tool end for a call that lives only in history settles that call', () => {
  const clock = createClock()
  const running = {
    id: 'a1',
    role: 'assistant' as const,
    content: '',
    timestamp: 1,
    toolCalls: [{ id: 'c1', name: 'bash', arguments: '{}', isExecuting: true }],
  }
  const state = { ...emptyChatStreamState(), messages: [running] }

  const patch = applyToolEnd(state, toolEnd('c1', 'bash', 'done', true), clock)

  assert.deepEqual(patch.messages?.[0].toolCalls?.[0], { id: 'c1', name: 'bash', arguments: '{}', isExecuting: false, isError: true })
  assert.equal(patch.streamingToolCalls?.size, 0)
})

test('tool end closes the subagent progress row with the elapsed time', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  state = merge(state, applyToolStart(state, toolStart('s1', 'subagent', { agent: 'reviewer', task: 'check' }), clock))
  clock.advance(500)
  state = merge(state, applyToolEnd(state, toolEnd('s1', 'subagent', 'ok'), clock))

  assert.equal(state.subagentProgress[0].status, 'done')
  assert.equal(state.subagentProgress[0].durationMs, 500)
  assert.equal(state.subagentProgress[0].currentTool, undefined)
})

test('tool end marks the subagent progress row as an error on failure', () => {
  const clock = createClock()
  let state = emptyChatStreamState()
  state = merge(state, applyToolStart(state, toolStart('s1', 'task', { agent: 'reviewer' }), clock))
  state = merge(state, applyToolEnd(state, toolEnd('s1', 'task', 'failed', true), clock))

  assert.equal(state.subagentProgress[0].status, 'error')
})

test('turnErrorText reports a provider error, with a fallback text', () => {
  assert.equal(turnErrorText({ role: 'assistant', stopReason: 'error', errorMessage: 'HTTP 402' }), 'HTTP 402')
  const fallback = turnErrorText({ role: 'assistant', stopReason: 'error' })
  assert.equal(typeof fallback, 'string')
  assert.notEqual(fallback, '')
})

test('turnErrorText reports a specific abort reason but not a plain user stop from Pi or OMP', () => {
  assert.equal(turnErrorText({ role: 'assistant', stopReason: 'aborted', errorMessage: 'Quota reached' }), 'Quota reached')
  assert.equal(turnErrorText({ role: 'assistant', stopReason: 'aborted', errorMessage: 'Request was aborted' }), null)
  assert.equal(turnErrorText({ role: 'assistant', stopReason: 'aborted', errorMessage: 'Interrupted by user' }), null)
  assert.equal(turnErrorText({ role: 'assistant', stopReason: 'aborted' }), null)
})

test('turnErrorText ignores non-assistant and missing messages', () => {
  assert.equal(turnErrorText({ role: 'user', stopReason: 'error', errorMessage: 'x' }), null)
  assert.equal(turnErrorText(undefined), null)
  assert.equal(turnErrorText({ role: 'assistant', stopReason: 'stop' }), null)
})
