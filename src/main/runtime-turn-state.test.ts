import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiExtensionUiRequest, PiRpcEvent } from '../shared/ipc-contracts'
import { createRuntimeTurnState } from './runtime-turn-state'

const AGENT_START: PiRpcEvent = { type: 'agent_start' }
const AGENT_END: PiRpcEvent = { type: 'agent_end', messages: [] }

function uiRequest(id: string, method: PiExtensionUiRequest['method'], targetId?: string): PiRpcEvent {
  return { type: 'extension_ui_request', id, method, ...(targetId ? { targetId } : {}) }
}

test('a started turn is running until agent_end', () => {
  const turns = createRuntimeTurnState()
  assert.equal(turns.isRunningTurn(), false)
  assert.equal(turns.handleEvent(AGENT_START), true)
  assert.equal(turns.isRunningTurn(), true)
  assert.equal(turns.handleEvent(AGENT_END), true)
  assert.equal(turns.isRunningTurn(), false)
})

test('a turn that waits on the user is not running, and runs again after the answer', () => {
  const turns = createRuntimeTurnState()
  turns.handleEvent(AGENT_START)
  assert.equal(turns.handleEvent(uiRequest('p1', 'confirm')), true)
  assert.equal(turns.isRunningTurn(), false)
  assert.equal(turns.handleUiResponse('p1'), true)
  assert.equal(turns.isRunningTurn(), true)
})

test('a cancelled prompt ends the wait', () => {
  const turns = createRuntimeTurnState()
  turns.handleEvent(AGENT_START)
  turns.handleEvent(uiRequest('p1', 'select'))
  assert.equal(turns.handleEvent(uiRequest('c1', 'cancel', 'p1')), true)
  assert.equal(turns.isRunningTurn(), true)
})

test('two open prompts need both answers', () => {
  const turns = createRuntimeTurnState()
  turns.handleEvent(AGENT_START)
  turns.handleEvent(uiRequest('p1', 'input'))
  turns.handleEvent(uiRequest('p2', 'editor'))
  assert.equal(turns.handleUiResponse('p1'), false)
  assert.equal(turns.isRunningTurn(), false)
  assert.equal(turns.handleUiResponse('p2'), true)
  assert.equal(turns.isRunningTurn(), true)
})

test('non-blocking extension UI does not count as a wait', () => {
  const turns = createRuntimeTurnState()
  turns.handleEvent(AGENT_START)
  assert.equal(turns.handleEvent(uiRequest('s1', 'setStatus')), false)
  assert.equal(turns.handleEvent(uiRequest('n1', 'notify')), false)
  assert.equal(turns.isRunningTurn(), true)
})

test('a stop, an error or a crash ends the turn and clears prompts', () => {
  const end = [
    (turns: ReturnType<typeof createRuntimeTurnState>) => turns.handleStatus('stopped'),
    (turns: ReturnType<typeof createRuntimeTurnState>) => turns.handleStatus('error'),
    (turns: ReturnType<typeof createRuntimeTurnState>) => turns.handleExit(),
  ]
  for (const stop of end) {
    const turns = createRuntimeTurnState()
    turns.handleEvent(AGENT_START)
    turns.handleEvent(uiRequest('p1', 'confirm'))
    stop(turns)
    assert.equal(turns.isRunningTurn(), false)
    assert.equal(turns.handleEvent(AGENT_START), true)
    assert.equal(turns.isRunningTurn(), true)
  }
})

test('a running or starting status keeps the turn', () => {
  const turns = createRuntimeTurnState()
  turns.handleEvent(AGENT_START)
  assert.equal(turns.handleStatus('running'), false)
  assert.equal(turns.handleStatus('starting'), false)
  assert.equal(turns.isRunningTurn(), true)
})
