import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { AgentEngineKind, PiResponseEvent, PiRpcEvent } from '../shared/ipc-contracts'
import { MAX_TRANSCRIPT_MESSAGES, PI_INSPECT_WIDGET_KEY, PI_INSPECT_WIDGET_PREFIX } from '../shared/subagent-task'
import { fetchSubagentTranscript, listSubagents, type SubagentRpc, type TranscriptDeps } from './subagent-transcripts'

class FakeRpc extends EventEmitter implements SubagentRpc {
  readonly sent: Array<Record<string, unknown>> = []
  constructor(
    private readonly engine: AgentEngineKind,
    private readonly answer: (command: Record<string, unknown>) => PiResponseEvent | null | Promise<PiResponseEvent | null>
  ) {
    super()
  }
  getEngineKind(): AgentEngineKind {
    return this.engine
  }
  async sendCommand(command: Record<string, unknown>): Promise<PiResponseEvent | null> {
    this.sent.push(command)
    return this.answer(command)
  }
  emitWidget(lines: string[]): void {
    const event: PiRpcEvent = { type: 'extension_ui_request', id: 'ui-1', method: 'setWidget', widgetKey: PI_INSPECT_WIDGET_KEY, widgetLines: lines }
    this.emit('event', event)
  }
}

function ok(command: string, data: unknown): PiResponseEvent {
  return { type: 'response', command, success: true, data }
}

const INSPECT_COMMAND_LISTED = ok('get_commands', { commands: [{ name: 'subagents-inspect-rpc', source: 'extension' }] })

/** A Pi with pi-subagents loaded: lists the inspect command, then runs `onPrompt`. */
function withInspect(onPrompt: (command: Record<string, unknown>) => PiResponseEvent | null): (command: Record<string, unknown>) => PiResponseEvent | null {
  return (command) => (command.type === 'get_commands' ? INSPECT_COMMAND_LISTED : onPrompt(command))
}

const DEPS: TranscriptDeps = {
  timeoutMs: 50,
  newRequestId: () => 'req-1',
  readEntries: async () => null,
  isReadablePath: () => true,
}

test('OMP lists its running subagents; Pi reports no support', async () => {
  const omp = new FakeRpc('omp', () => ok('get_subagents', { subagents: [{ id: 'A', agent: 'scout', status: 'running' }] }))
  assert.deepEqual((await listSubagents(omp)).tasks.map((task) => task.id), ['A'])
  assert.equal((await listSubagents(omp)).supported, true)
  const old = new FakeRpc('omp', () => ({ type: 'response', command: 'get_subagents', success: false, error: 'Unknown command' }))
  assert.deepEqual(await listSubagents(old), { supported: false, tasks: [] })
  const pi = new FakeRpc('pi', () => null)
  assert.deepEqual(await listSubagents(pi), { supported: false, tasks: [] })
  assert.equal(pi.sent.length, 0)
})

test('an OMP transcript page is read from the cursor, capped and trimmed', async () => {
  const huge = 'x'.repeat(100_000)
  const messages = Array.from({ length: MAX_TRANSCRIPT_MESSAGES + 20 }, (_, index) => ({ role: 'assistant', content: [{ type: 'text', text: index === MAX_TRANSCRIPT_MESSAGES + 19 ? huge : 'ok' }] }))
  const rpc = new FakeRpc('omp', () => ok('get_subagent_messages', { sessionFile: '/s.jsonl', fromByte: 10, nextByte: 900, reset: false, entries: [], messages }))
  const result = await fetchSubagentTranscript(rpc, { kind: 'omp', subagentId: 'A' }, 10, DEPS)
  assert.deepEqual(rpc.sent[0], { type: 'get_subagent_messages', subagentId: 'A', fromByte: 10 })
  assert.equal(result.kind, 'messages')
  if (result.kind !== 'messages') return
  assert.equal(result.messages.length, MAX_TRANSCRIPT_MESSAGES)
  assert.equal(result.nextCursor, 900)
  assert.equal(result.reset, false)
  const last = result.messages[result.messages.length - 1] as { content: Array<{ text: string }> }
  assert.ok(last.content[0].text.length < huge.length)
})

test('an OMP error reply is a failed transcript', async () => {
  const rpc = new FakeRpc('omp', () => ({ type: 'response', command: 'get_subagent_messages', success: false, error: 'unknown' }))
  assert.deepEqual(await fetchSubagentTranscript(rpc, { kind: 'omp', subagentId: 'A' }, 0, DEPS), { kind: 'error', code: 'failed' })
})

function inspectLines(requestId: string, extra: Record<string, unknown> = {}): string[] {
  return [`${PI_INSPECT_WIDGET_PREFIX}${JSON.stringify({ kind: 'pi-subagents.inspect-reply', version: 1, requestId, messages: [{ role: 'assistant', kind: 'text', text: 'hello' }], ...extra })}`]
}

test('a pi-subagents transcript is the inspect reply with the matching request id', async () => {
  const rpc = new FakeRpc('pi', withInspect((command) => {
    // Another request's reply arrives first and must be ignored.
    rpc.emitWidget(inspectLines('someone-else'))
    rpc.emitWidget(inspectLines('req-1', { status: 'complete', finalOutput: 'done text' }))
    return ok(String(command.type), undefined)
  }))
  const result = await fetchSubagentTranscript(rpc, { kind: 'pi-async', asyncId: 'async-1', childId: 'step:0' }, 0, DEPS)
  assert.deepEqual(rpc.sent[1], { type: 'prompt', message: '/subagents-inspect-rpc req-1 async-1 step:0 --lines 200' })
  assert.deepEqual(result, { kind: 'lines', lines: [{ role: 'assistant', kind: 'text', text: 'hello' }], status: 'done', finalOutput: 'done text' })
  assert.equal(rpc.listenerCount('event'), 0)
})

test('an inspect error, a timeout and an unsafe id are reported, never sent as a prompt', async () => {
  const notFound = new FakeRpc('pi', withInspect(() => {
    notFound.emitWidget(inspectLines('req-1', { error: { code: 'not_found', message: 'gone' } }))
    return null
  }))
  assert.deepEqual(await fetchSubagentTranscript(notFound, { kind: 'pi-async', asyncId: 'a' }, 0, DEPS), { kind: 'error', code: 'not-found' })

  const silent = new FakeRpc('pi', withInspect(() => null))
  assert.deepEqual(await fetchSubagentTranscript(silent, { kind: 'pi-async', asyncId: 'a' }, 0, DEPS), { kind: 'error', code: 'timeout' })
  assert.equal(silent.listenerCount('event'), 0)

  const unsafe = new FakeRpc('pi', () => null)
  assert.deepEqual(await fetchSubagentTranscript(unsafe, { kind: 'pi-async', asyncId: 'a b' }, 0, DEPS), { kind: 'error', code: 'unavailable' })
  assert.equal(unsafe.sent.length, 0)

  const none = new FakeRpc('omp', () => null)
  assert.deepEqual(await fetchSubagentTranscript(none, { kind: 'none' }, 0, DEPS), { kind: 'error', code: 'unavailable' })
  assert.equal(none.sent.length, 0)
})

test('a finished foreground session is read only inside the session roots', async () => {
  const entries = [
    { type: 'session', id: 's' },
    { type: 'message', message: { role: 'user', content: 'go' } },
    { type: 'custom', data: {} },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ]
  const rpc = new FakeRpc('pi', () => null)
  const inside: TranscriptDeps = { ...DEPS, readEntries: async () => entries }
  const result = await fetchSubagentTranscript(rpc, { kind: 'pi-foreground', sessionFile: '/s.jsonl' }, 0, inside)
  assert.equal(result.kind, 'messages')
  if (result.kind === 'messages') {
    assert.equal(result.messages.length, 2)
    assert.equal(result.reset, true)
  }
  const outside: TranscriptDeps = { ...inside, isReadablePath: () => false }
  assert.deepEqual(await fetchSubagentTranscript(rpc, { kind: 'pi-foreground', sessionFile: '/etc/x' }, 0, outside), { kind: 'error', code: 'unavailable' })
  assert.deepEqual(await fetchSubagentTranscript(rpc, { kind: 'pi-foreground' }, 0, inside), { kind: 'error', code: 'unavailable' })
})

test('without the inspect command (an old pi-subagents), no prompt is ever sent', async () => {
  const old = new FakeRpc('pi', (command) =>
    command.type === 'get_commands' ? ok('get_commands', { commands: [{ name: 'subagents-status', source: 'extension' }] }) : null
  )
  assert.deepEqual(await fetchSubagentTranscript(old, { kind: 'pi-async', asyncId: 'a' }, 0, DEPS), { kind: 'error', code: 'unavailable' })
  assert.deepEqual(old.sent.map((command) => command.type), ['get_commands'])
  const noReply = new FakeRpc('pi', () => null)
  assert.deepEqual(await fetchSubagentTranscript(noReply, { kind: 'pi-async', asyncId: 'a' }, 0, DEPS), { kind: 'error', code: 'unavailable' })
  assert.deepEqual(noReply.sent.map((command) => command.type), ['get_commands'])
})
