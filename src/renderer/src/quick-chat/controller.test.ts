import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as flush } from 'node:timers/promises'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import type { AttachmentReadResult, ModelInfo, PiExtensionUiRequest, PiResponseEvent, PiRpcEvent, PromptImage, Workspace } from '../../../shared/ipc-contracts'
import type { QuickChatApi, QuickChatBinding, QuickChatContext, QuickChatSnapshot, QuickChatUpdate } from '../../../shared/quick-chat'
import { QuickChatController } from './controller'
import { composerKeyAction, targetOptions } from './presentation'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  // The renderer's ES2022 library target does not expose Promise.withResolvers.
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function binding(id: string, version = 1): QuickChatBinding {
  return { version, runtime: { runtimeId: id, workspaceId: `workspace-${id}`, sessionPath: `/sessions/${id}.jsonl`, sessionId: id, status: 'running', pid: 12, error: null, activity: null, active: id === 'B' } }
}
function snapshot(target: QuickChatBinding, patch: Partial<QuickChatSnapshot> = {}): QuickChatSnapshot {
  return { binding: target, messages: [], streaming: null, request: null, model: null, thinkingLevel: null, permissionMode: null, ...patch }
}
function message(text: string, id: string, role = 'assistant'): Record<string, unknown> {
  return { id, role, content: [{ type: 'text', text }], timestamp: 1730000000000 }
}
function model(provider: string, id: string, efforts?: string[]): ModelInfo {
  return { provider, id, name: id, api: 'test', baseUrl: '', reasoning: true, input: ['text'], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinking: efforts ? { efforts } : undefined }
}
function harness(initial: QuickChatBinding | null = binding('A')): {
  api: QuickChatApi; controller: QuickChatController; context: QuickChatContext
  emit: (update: QuickChatUpdate) => void; event: (event: PiRpcEvent, target?: QuickChatBinding) => void
  submissions: Array<{ version: number; text: string; mode: 'prompt' | 'steer'; images?: PromptImage[]; model?: { provider: string; modelId: string }; thinkingLevel?: string }>
  answers: Array<{ version: number; id: string; response: Record<string, unknown> }>
  creations: string[]; stops: number[]
  modelCalls: Array<{ provider: string; modelId: string; version: number }>
  thinkingCalls: Array<{ level: string; version: number }>
  homeResolutions: () => number
  hides: () => number
} {
  const context: QuickChatContext = {
    pinned: false,
    binding: initial, runtimes: [initial?.runtime ?? binding('A').runtime, binding('B', 2).runtime],
    workspaces: ['A', 'B'].map((id) => ({ id: `workspace-${id}`, name: id, path: `/cwd/${id}`, createdAt: 0, lastActiveAt: 0, color: '' })),
    defaultWorkspaceId: 'workspace-A', runtimeUpdatedAt: {},
    sessions: [], settings: { ...DEFAULT_SETTINGS }, i18nEnvironment: { systemLanguages: ['en'], pseudoLanguageEnabled: false }, themes: [],
  }
  let listener: ((update: QuickChatUpdate) => void) | null = null
  let hides = 0
  let current = initial
  let version = initial?.version ?? 0
  const creations: string[] = []
  const stops: number[] = []
  let homeResolutions = 0
  const submissions: Array<{ version: number; text: string; mode: 'prompt' | 'steer'; images?: PromptImage[]; model?: { provider: string; modelId: string }; thinkingLevel?: string }> = []
  const answers: Array<{ version: number; id: string; response: Record<string, unknown> }> = []
  const modelCalls: Array<{ provider: string; modelId: string; version: number }> = []
  const thinkingCalls: Array<{ level: string; version: number }> = []
  const homeWorkspace: Workspace = { id: 'workspace-home', name: 'Home', path: '/home', createdAt: 0, lastActiveAt: 0, color: '' }
  const api: QuickChatApi = {
    getContext: async () => context,
    selectTarget: async (target) => {
      current = binding('runtimeId' in target ? target.runtimeId : 'saved', ++version)
      listener?.({ type: 'binding', binding: current })
      return current
    },
    createSession: async (workspaceId) => {
      creations.push(workspaceId)
      current = binding(`created-${creations.length}`, ++version)
      current.runtime.workspaceId = workspaceId
      listener?.({ type: 'binding', binding: current })
      return current
    },
    newDraft: async () => { current = null; version++; listener?.({ type: 'binding', binding: null }) },
    pickWorkspace: async () => null,
    resolveHomeWorkspace: async () => {
      homeResolutions++
      if (!context.workspaces.some((workspace) => workspace.id === homeWorkspace.id)) context.workspaces.push(homeWorkspace)
      return homeWorkspace
    },
    stop: async (bindingVersion) => { stops.push(bindingVersion) },
    getSnapshot: async () => snapshot(current!),
    submitText: async (input) => { submissions.push(input); return { type: 'response', id: `prompt-${submissions.length}`, command: input.mode, success: true } },
    respond: async (input) => { answers.push(input) },
    pickAttachment: async () => [],
    listModels: async () => [],
    setRuntimeModel: async (input) => { modelCalls.push({ provider: input.provider, modelId: input.modelId, version: input.version }); return { type: 'response', command: 'set_model', success: true } },
    setRuntimeThinking: async (input) => { thinkingCalls.push({ level: input.level, version: input.version }); return { type: 'response', command: 'set_thinking_level', success: true } },
    setPinned: async (pinned) => { context.pinned = pinned; listener?.({ type: 'pinned', pinned }) },
    hide: async () => { hides++ }, openInMain: async () => {},
    onUpdate: (callback) => { listener = callback; return () => { listener = null } },
  }
  return { api, controller: new QuickChatController(api), context, submissions, answers, creations, stops, hides: () => hides, modelCalls, thinkingCalls, homeResolutions: () => homeResolutions,
    emit: (update) => { listener?.(update) },
    event: (event, target = current!) => { listener?.({ type: 'event', event, version: target.version, runtimeId: target.runtime.runtimeId }) },
  }
}

test('popup stays pinned while main changes active session, filters events, and isolates drafts', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.controller.setDraft('A draft')
  h.context.runtimes[0].active = false
  h.context.runtimes[1].active = true
  await h.controller.refreshContext()
  assert.equal(h.controller.getState().binding?.runtime.runtimeId, 'A')
  h.event({ type: 'message_end', message: message('wrong B', 'wrong') }, binding('B', 2))
  assert.equal(h.controller.getState().messages.length, 0)
  await h.controller.select({ runtimeId: 'B' })
  await flush()
  h.controller.setDraft('B draft')
  await h.controller.select({ runtimeId: 'A' })
  await flush()
  assert.equal(h.controller.getState().draft, 'A draft')
  await h.controller.hide()
  assert.equal(h.controller.getState().draft, 'A draft')
  assert.equal(h.hides(), 1)
  h.controller.dispose()
})

test('a stale context response cannot replace a binding update received during startup', async () => {
  const h = harness()
  const pending = deferred<QuickChatContext>()
  h.api.getContext = () => pending.promise
  h.api.getSnapshot = async () => snapshot(binding('B', 2))
  h.controller.start()
  h.emit({ type: 'binding', binding: binding('B', 2) })
  pending.resolve(h.context)
  await flush()
  assert.equal(h.controller.getState().binding?.runtime.runtimeId, 'B')
  h.controller.dispose()
})

test('pin updates during startup and show-time hydration outrank stale context without optimistic state', async () => {
  const h = harness(null)
  const startup = deferred<QuickChatContext>()
  h.api.getContext = () => startup.promise
  h.controller.start()
  h.emit({ type: 'pinned', pinned: true })
  startup.resolve({ ...h.context, pinned: false })
  await flush()
  assert.equal(h.controller.getState().context?.pinned, true)

  const confirmation = deferred<void>()
  let requested: boolean | null = null
  h.api.setPinned = async (pinned) => { requested = pinned; await confirmation.promise }
  const toggle = h.controller.togglePinned()
  assert.equal(requested, false, 'the first click targets the hydrated native value')
  assert.equal(h.controller.getState().context?.pinned, true, 'no local pin truth before main confirms')
  h.emit({ type: 'pinned', pinned: false })
  confirmation.resolve()
  await toggle
  assert.equal(h.controller.getState().context?.pinned, false)

  h.emit({ type: 'visibility', visible: false })
  assert.equal(h.controller.getState().context?.pinned, false, 'hide does not reset pin state')
  const shown = deferred<QuickChatContext>()
  h.api.getContext = () => shown.promise
  h.emit({ type: 'visibility', visible: true })
  h.emit({ type: 'pinned', pinned: true })
  shown.resolve({ ...h.context, pinned: false })
  await flush()
  assert.equal(h.controller.getState().context?.pinned, true)
  h.controller.dispose()
})

test('switching bindings discards a delayed snapshot and its approval', async () => {
  const h = harness()
  const pending = deferred<QuickChatSnapshot>()
  h.api.getSnapshot = (version) => version === 1 ? pending.promise : Promise.resolve(snapshot(binding('B', 2)))
  h.controller.start()
  await flush()
  await h.controller.select({ runtimeId: 'B' })
  pending.resolve(snapshot(binding('A'), { messages: [message('old A', 'a')], request: { type: 'extension_ui_request', method: 'confirm', id: 'old' } }))
  await flush()
  assert.equal(h.controller.getState().messages.length, 0)
  assert.equal(h.controller.getState().request, null)
  assert.equal(h.controller.getState().binding?.runtime.runtimeId, 'B')
  h.controller.dispose()
})

test('offset deltas recover missing prefixes and snapshot overlap never duplicates text or thinking', async () => {
  const h = harness()
  const pending = deferred<QuickChatSnapshot>()
  h.api.getSnapshot = () => pending.promise
  h.controller.start()
  await flush()
  h.event({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: ' world', offset: 5 } })
  h.event({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'thinking_delta', delta: 'ing', offset: 5 } })
  pending.resolve(snapshot(binding('A'), { streaming: { content: 'Hello world', thinking: 'Thinking' } }))
  await flush()
  assert.equal(h.controller.getState().content, 'Hello world')
  assert.equal(h.controller.getState().thinking, 'Thinking')
  h.event({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: '!', offset: 11 } })
  assert.equal(h.controller.getState().content, 'Hello world!')
  h.controller.dispose()
})

test('a snapshot for one assistant message cannot fill a later message', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  const pending = deferred<QuickChatSnapshot>()
  h.api.getSnapshot = () => pending.promise
  const loading = h.controller.reloadSnapshot()
  h.event({ type: 'message_end', message: message('old answer', 'old') })
  h.event({ type: 'agent_start' })
  h.event({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: 'New', offset: 0 } })
  pending.resolve(snapshot(binding('A'), { streaming: { content: 'old answer long enough to overwrite', thinking: 'old reasoning' } }))
  await loading
  assert.equal(h.controller.getState().content, 'New')
  assert.equal(h.controller.getState().thinking, '')
  assert.equal(h.controller.getState().busy, true)
  h.controller.dispose()
})

test('live messages survive an older history snapshot, then agent end backfills final history once', async () => {
  const h = harness()
  const pending = deferred<QuickChatSnapshot>()
  let reads = 0
  const final = message('final answer', 'final')
  h.api.getSnapshot = async () => {
    reads++
    return reads === 1 ? pending.promise : snapshot(binding('A'), { messages: [message('ask', 'user', 'user'), final] })
  }
  h.controller.start()
  await flush()
  h.event({ type: 'message_start', message: message('ask', 'user', 'user') })
  h.event({ type: 'message_end', message: final })
  h.event({ type: 'agent_end', messages: [final] })
  pending.resolve(snapshot(binding('A')))
  await flush()
  assert.deepEqual(h.controller.getState().messages.map((item) => item.content), ['ask', 'final answer'])
  assert.equal(h.controller.getState().busy, false)
  assert.equal(reads, 2)
  h.controller.dispose()
})

test('failed sends keep text; accepted sends do not clear a later draft revision', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.controller.setDraft('keep me')
  h.api.submitText = async () => ({ type: 'response', command: 'prompt', success: false, error: 'engine refused' })
  await h.controller.submit()
  assert.equal(h.controller.getState().draft, 'keep me')
  assert.equal(h.controller.getState().error, 'engine refused')
  const pending = deferred<PiResponseEvent | null>()
  h.api.submitText = () => pending.promise
  const submitting = h.controller.submit()
  h.controller.setDraft('changed')
  h.controller.setDraft('keep me')
  pending.resolve({ type: 'response', command: 'prompt', success: true })
  await submitting
  assert.equal(h.controller.getState().draft, 'keep me')
  h.controller.dispose()
})

test('only the sent session draft clears if the target changes while submission is in flight', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.controller.setDraft('send A')
  const pending = deferred<PiResponseEvent | null>()
  h.api.submitText = () => pending.promise
  const submitting = h.controller.submit()
  await h.controller.select({ runtimeId: 'B' })
  await flush()
  h.controller.setDraft('keep B')
  pending.resolve({ type: 'response', command: 'prompt', success: true })
  await submitting
  assert.equal(h.controller.getState().draft, 'keep B')
  await h.controller.select({ runtimeId: 'A' })
  await flush()
  assert.equal(h.controller.getState().draft, '')
  h.controller.dispose()
})

test('send intent is explicit prompt while idle, steer while busy, and duplicate submissions are blocked', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.controller.setDraft('idle')
  await h.controller.submit()
  await flush()
  assert.equal(h.submissions[0].mode, 'prompt')
  h.event({ type: 'agent_start' })
  h.controller.setDraft('steer now')
  const pending = deferred<PiResponseEvent | null>()
  h.api.submitText = (input) => { h.submissions.push(input); return pending.promise }
  const submitting = h.controller.submit()
  await h.controller.submit()
  assert.equal(h.submissions.length, 2)
  assert.equal(h.submissions[1].mode, 'steer')
  pending.resolve({ type: 'response', command: 'steer', success: true })
  await submitting
  h.controller.dispose()
})

test('hiding approval sends no answer; explicit cancel responds once and owner revocation wins over a stale snapshot', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  const request: PiExtensionUiRequest = { type: 'extension_ui_request', method: 'confirm', id: 'approval' }
  h.emit({ type: 'approval', version: 1, request })
  await h.controller.hide()
  assert.equal(h.answers.length, 0)
  assert.equal(h.controller.getState().request?.id, 'approval')
  const pending = deferred<QuickChatSnapshot>()
  h.api.getSnapshot = () => pending.promise
  const loading = h.controller.reloadSnapshot()
  h.emit({ type: 'approval', version: 1, request: null })
  pending.resolve(snapshot(binding('A'), { request }))
  await loading
  assert.equal(h.controller.getState().request, null)
  h.emit({ type: 'approval', version: 1, request })
  const answering = deferred<void>()
  h.api.respond = (answer) => { h.answers.push(answer); return answering.promise }
  const cancelled = h.controller.cancelRequest()
  await h.controller.cancelRequest()
  assert.equal(h.answers.length, 1)
  assert.deepEqual(h.answers[0].response, { confirmed: false })
  answering.resolve()
  await cancelled
  assert.equal(h.controller.getState().request, null)
  h.controller.dispose()
})

test('raw blocking events cannot acquire approval ownership and response failures remain actionable', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  const request: PiExtensionUiRequest = { type: 'extension_ui_request', method: 'input', id: 'input' }
  h.event(request)
  assert.equal(h.controller.getState().request, null)
  h.emit({ type: 'approval', version: 1, request })
  h.api.respond = async () => { throw new Error('request ownership changed') }
  await h.controller.answer({ value: 'answer' })
  assert.equal(h.controller.getState().error, 'request ownership changed')
  assert.equal(h.controller.getState().request?.id, 'input')
  h.controller.dispose()
})

test('history uses stopped markers and recovers in-progress tool summaries', async () => {
  const h = harness()
  const target = binding('A')
  target.runtime.activity = 'working'
  h.api.getSnapshot = async () => snapshot(target, { messages: [{ ...message('partial', 'stopped'), stopReason: 'aborted' }, { ...message('', 'tool'), content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }] }] })
  h.controller.start()
  await flush()
  assert.equal(h.controller.getState().messages[0].stopped, true)
  assert.equal(h.controller.getState().messages[1].toolCalls?.[0].isExecuting, true)
  h.event({ type: 'tool_execution_end', toolCallId: 'call', toolName: 'read', result: { content: [], details: {} }, isError: false })
  assert.equal(h.controller.getState().messages[1].toolCalls?.[0].isExecuting, false)
  h.controller.dispose()
})

test('target list reuses live sessions and maps saved sessions to their own cwd, excluding unrelated files', () => {
  const h = harness()
  h.context.sessions = [
    { path: '/sessions/A.jsonl', name: 'Live A', preview: null, sessionId: 'A', projectPath: '/cwd/A', projectName: 'A', lastModified: 1, messageCount: 2 },
    { path: '/saved/B.jsonl', name: 'Saved B', preview: null, sessionId: 'saved', projectPath: '/cwd/B/', projectName: 'B', lastModified: 1, messageCount: 2 },
    { path: '/foreign.jsonl', name: 'Foreign', preview: null, sessionId: 'foreign', projectPath: '/not-open', projectName: 'foreign', lastModified: 1, messageCount: 2 },
  ]
  const options = targetOptions(h.context)
  assert.equal(options.find((option) => option.key === 'runtime:A')?.title, 'Live A')
  assert.equal(options.filter((option) => 'runtimeId' in option.target && option.target.runtimeId === 'A').length, 1)
  assert.deepEqual(options.find((option) => option.key === 'saved:workspace-B:/saved/B.jsonl')?.target, { workspaceId: 'workspace-B', sessionPath: '/saved/B.jsonl' })
  assert.equal(options.some((option) => option.title === 'Foreign'), false)
})

test('IME suppresses Enter and Escape; dropdown Escape has priority over hiding', () => {
  assert.equal(composerKeyAction({ key: 'Enter', shiftKey: false, isComposing: true }, false, false), 'none')
  assert.equal(composerKeyAction({ key: 'Escape', shiftKey: false, keyCode: 229 }, false, false), 'none')
  assert.equal(composerKeyAction({ key: 'Escape', shiftKey: false }, true, false), 'none')
  assert.equal(composerKeyAction({ key: 'Escape', shiftKey: false }, false, true), 'close-dropdown')
  assert.equal(composerKeyAction({ key: 'Escape', shiftKey: false }, false, false), 'hide')
  assert.equal(composerKeyAction({ key: 'Enter', shiftKey: true }, false, false), 'none')
  assert.equal(composerKeyAction({ key: 'Enter', shiftKey: false }, false, false), 'submit')
})

test('runtime restart keeps the same draft and blocks a second send until the first settles', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.controller.setDraft('resume session')
  const pending = deferred<PiResponseEvent | null>()
  let submissions = 0
  h.api.submitText = () => { submissions++; return pending.promise }
  const submitting = h.controller.submit()
  const restarted = binding('A', 2)
  h.api.getSnapshot = async () => snapshot(restarted)
  h.emit({ type: 'binding', binding: restarted })
  await flush()
  assert.equal(h.controller.getState().draft, 'resume session')
  assert.equal(h.controller.getState().sending, true)
  await h.controller.submit()
  assert.equal(submissions, 1)
  pending.resolve({ type: 'response', command: 'prompt', success: true })
  await submitting
  assert.equal(h.controller.getState().draft, '')
  assert.equal(h.controller.getState().sending, false)
  h.controller.dispose()
})

test('a newly saved session migrates only its own pending draft, never an identical other-session draft', async () => {
  const initial = binding('A')
  initial.runtime.sessionPath = null
  const h = harness(initial)
  h.controller.start()
  await flush()
  h.controller.setDraft('identical text')
  const pending = deferred<PiResponseEvent | null>()
  h.api.submitText = () => pending.promise
  const submitting = h.controller.submit()
  h.emit({ type: 'binding', binding: binding('A') })
  await h.controller.select({ runtimeId: 'B' })
  await flush()
  h.controller.setDraft('identical text')
  pending.resolve({ type: 'response', command: 'prompt', success: true })
  await submitting
  assert.equal(h.controller.getState().draft, 'identical text')
  await h.controller.select({ runtimeId: 'A' })
  await flush()
  assert.equal(h.controller.getState().draft, '')
  h.controller.dispose()
})

test('selection errors and binding invalidation preserve drafts without silently selecting another session', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.controller.setDraft('keep this')
  h.api.selectTarget = async () => { throw new Error('cannot resume saved session') }
  await h.controller.select({ workspaceId: 'workspace-B', sessionPath: '/saved/B' })
  assert.equal(h.controller.getState().binding?.runtime.runtimeId, 'A')
  assert.equal(h.controller.getState().draft, 'keep this')
  assert.equal(h.controller.getState().error, 'cannot resume saved session')
  h.emit({ type: 'binding', binding: null })
  assert.equal(h.controller.getState().binding, null)
  assert.equal(h.controller.getState().draft, 'keep this')
  assert.ok(h.controller.getState().error)
  await h.controller.submit()
  assert.equal(h.submissions.length, 0)
  h.controller.dispose()
})

test('input, editor and select requests send explicit values and a true cancel, never an implicit hide answer', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  for (const method of ['input', 'editor', 'select'] as const) {
    h.emit({ type: 'approval', version: 1, request: { type: 'extension_ui_request', method, id: method } })
    await h.controller.hide()
    assert.equal(h.controller.getState().request?.id, method)
    await h.controller.answer({ value: `answer ${method}` })
    assert.deepEqual(h.answers.at(-1)?.response, { value: `answer ${method}` })
    h.emit({ type: 'approval', version: 1, request: { type: 'extension_ui_request', method, id: `${method}-cancel` } })
    await h.controller.cancelRequest()
    // A cancel is a first-class answer, never an empty value: a select would
    // reject { value: '' } as a non-option, and an input would submit it.
    assert.deepEqual(h.answers.at(-1)?.response, { cancelled: true })
  }
  assert.equal(h.answers.length, 6)
  h.controller.dispose()
})

test('a deferred engine refusal restores only the accepted draft revision, not later user edits', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.controller.setDraft('OMP admitted but later refused')
  await h.controller.submit()
  await flush()
  assert.equal(h.controller.getState().draft, '')
  h.event({ type: 'prompt_result', id: 'prompt-1', agentInvoked: false, status: 'error', error: { message: 'missing model' } })
  assert.equal(h.controller.getState().draft, 'OMP admitted but later refused')
  assert.equal(h.controller.getState().error, 'missing model')
  h.controller.setDraft('try another message')
  await h.controller.submit()
  await flush()
  h.controller.setDraft('new unsent draft')
  h.event({ type: 'prompt_result', id: 'prompt-2', agentInvoked: false, status: 'error', error: { message: 'expired login' } })
  assert.equal(h.controller.getState().draft, 'new unsent draft')
  assert.equal(h.controller.getState().busy, false)
  h.controller.dispose()
})

test('an engine refusal arriving before the submit response cannot clear failed text', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.controller.setDraft('do not lose this')
  const pending = deferred<PiResponseEvent | null>()
  h.api.submitText = () => pending.promise
  const submitting = h.controller.submit()
  h.event({ type: 'prompt_result', id: 'refused-prompt', agentInvoked: false, status: 'error', error: { message: 'engine rejected after admission' } })
  pending.resolve({ type: 'response', id: 'refused-prompt', command: 'prompt', success: true })
  await submitting
  assert.equal(h.controller.getState().draft, 'do not lose this')
  assert.equal(h.controller.getState().error, 'engine rejected after admission')
  h.controller.dispose()
})

test('history cannot replace a same-id message committed after the snapshot request began', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  const pending = deferred<QuickChatSnapshot>()
  h.api.getSnapshot = () => pending.promise
  const loading = h.controller.reloadSnapshot()
  h.event({ type: 'message_end', message: message('new final answer', 'same-id') })
  pending.resolve(snapshot(binding('A'), { messages: [message('older partial answer', 'same-id')] }))
  await loading
  assert.equal(h.controller.getState().messages[0].content, 'new final answer')
  assert.equal(h.controller.getState().messages.length, 1)
  h.controller.dispose()
})

test('another prompt result cannot restore a steer draft or erase a running answer', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.event({ type: 'agent_start' })
  const running = binding('A')
  running.runtime.activity = 'working'
  h.api.getSnapshot = async () => snapshot(running, { streaming: { content: 'still working', thinking: '' } })
  h.event({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'still working', offset: 0 } })
  h.controller.setDraft('steer the running task')
  await h.controller.submit()
  h.event({ type: 'prompt_result', id: 'main-window-command', agentInvoked: false, status: 'error', error: { message: 'unrelated refusal' } })
  assert.equal(h.controller.getState().draft, '')
  assert.equal(h.controller.getState().content, 'still working')
  assert.equal(h.controller.getState().busy, true)
  h.controller.dispose()
})

test('only the matching prompt outcome can refuse an unacknowledged submission', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  const pending = deferred<PiResponseEvent | null>()
  h.api.submitText = () => pending.promise
  h.controller.setDraft('popup prompt')
  const sending = h.controller.submit()
  h.event({ type: 'prompt_result', id: 'another-request', agentInvoked: false, status: 'error', error: { message: 'not this prompt' } })
  pending.resolve({ type: 'response', id: 'popup-request', command: 'prompt', success: true })
  await sending
  assert.equal(h.controller.getState().draft, '')
  assert.equal(h.controller.getState().error, null)
  h.controller.dispose()
})

test('distinct engine message ids survive identical text and timestamps across history refresh', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.event({ type: 'message_end', message: message('same answer', 'first') })
  h.event({ type: 'message_end', message: message('same answer', 'second') })
  assert.deepEqual(h.controller.getState().messages.map((item) => item.id), ['first', 'second'])
  h.api.getSnapshot = async () => snapshot(binding('A'), { messages: [message('same answer', 'first'), message('same answer', 'second')] })
  await h.controller.reloadSnapshot()
  assert.deepEqual(h.controller.getState().messages.map((item) => item.id), ['first', 'second'])
  h.controller.dispose()
})

test('history reconciliation consumes fallback messages by occurrence, not by a signature set', async () => {
  const h = harness()
  const raw = { role: 'assistant', content: [{ type: 'text', text: 'repeat' }], timestamp: 1730000000000 }
  h.api.getSnapshot = async () => snapshot(binding('A'), { messages: [raw, { ...raw }] })
  h.controller.start()
  await flush()
  await h.controller.reloadSnapshot()
  assert.deepEqual(h.controller.getState().messages.map((item) => item.content), ['repeat', 'repeat'])
  h.controller.dispose()
})

test('separate id-less live messages are retained, and terminal batches do not add duplicate copies', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  const raw = { role: 'assistant', content: [{ type: 'text', text: 'repeat' }], timestamp: 1730000000000 }
  h.event({ type: 'message_end', message: raw })
  h.event({ type: 'message_end', message: { ...raw } })
  assert.deepEqual(h.controller.getState().messages.map((item) => item.content), ['repeat', 'repeat'])
  h.api.getSnapshot = async () => snapshot(binding('A'), { messages: [raw, { ...raw }] })
  h.event({ type: 'agent_end', messages: [raw, { ...raw }] })
  await flush()
  assert.deepEqual(h.controller.getState().messages.map((item) => item.content), ['repeat', 'repeat'])
  h.controller.dispose()
})

test('fresh popup opens in no-project state without adopting main or allocating a session', async () => {
  const h = harness(null)
  h.controller.start()
  await flush()
  assert.equal(h.controller.getState().mode, 'new')
  assert.equal(h.controller.getState().workspaceId, null)
  assert.equal(h.controller.getState().binding, null)
  assert.equal(h.homeResolutions(), 0, 'opening the popup must not materialize the home workspace')
  h.controller.setDraft('a quick task')
  await h.controller.newTask()
  await h.controller.hide()
  h.emit({ type: 'visibility', visible: true })
  await flush()
  assert.equal(h.controller.getState().draft, 'a quick task')
  assert.equal(h.controller.getState().binding, null)
  assert.deepEqual(h.creations, [])
  assert.deepEqual(h.submissions, [])
})

test('unassigned input sends to the home workspace, then new-task drafts stay project-local', async () => {
  const h = harness(null)
  h.context.defaultWorkspaceId = null
  h.controller.start()
  await flush()
  // No project: type a task and send it — the home workspace materializes.
  h.controller.setDraft('capture before choosing a project')
  await h.controller.submit()
  assert.equal(h.homeResolutions(), 1, 'a no-project send resolves the home workspace once')
  assert.deepEqual(h.creations, ['workspace-home'], 'the created session targets the home workspace')
  assert.equal(h.controller.getState().workspaceId, 'workspace-home', 'the home workspace is adopted after sending')
  assert.equal(h.controller.getState().binding?.runtime.runtimeId, 'created-1')
  assert.equal(h.controller.getState().draft, '', 'the sent draft clears')
  await h.controller.newTask()
  assert.equal(h.controller.getState().workspaceId, 'workspace-home', 'new task keeps the home workspace chosen by the send')
  // Drafts stay project-local: a no-project draft, a B draft and a home draft
  // never leak into each other.
  h.controller.setWorkspace('workspace-A')
  assert.equal(h.controller.getState().draft, '')
  h.controller.setDraft('task for A')
  h.controller.setWorkspace('workspace-B')
  assert.equal(h.controller.getState().draft, '')
  h.controller.setDraft('task for B')
  h.controller.setWorkspace('workspace-A')
  assert.equal(h.controller.getState().draft, 'task for A')
  h.controller.setWorkspace('workspace-B')
  assert.equal(h.controller.getState().draft, 'task for B')
  h.controller.setNoProject()
  assert.equal(h.controller.getState().draft, 'task for B', 'returning to no project carries the current folder draft into its bucket')
  assert.equal(h.controller.getState().workspaceId, null)
  h.controller.setWorkspace('workspace-B')
  assert.equal(h.controller.getState().draft, 'task for B', 'switching back to B restores its own draft')
  h.controller.setNoProject()
  h.controller.setDraft('unassigned idea')
  h.controller.setWorkspace('workspace-B')
  assert.equal(h.controller.getState().draft, 'unassigned idea', 'an unassigned draft follows the next chosen project')
  h.controller.setNoProject()
  assert.equal(h.controller.getState().draft, 'unassigned idea', 'the unassigned draft carries back when returning to no project')
  h.controller.dispose()
})

test('first submission creates exactly one session and preserves typing during creation', async () => {
  const h = harness(null)
  const pending = deferred<QuickChatBinding>()
  const created = binding('new-task', 5)
  created.runtime.workspaceId = 'workspace-A'
  h.api.createSession = (workspaceId) => { h.creations.push(workspaceId); return pending.promise }
  h.api.getSnapshot = async () => snapshot(created)
  h.controller.start()
  await flush()
  h.controller.setWorkspace('workspace-A')
  h.controller.setDraft('first task')
  const sending = h.controller.submit()
  await h.controller.submit()
  h.controller.setDraft('next unsent text')
  h.controller.setWorkspace('workspace-B')
  await h.controller.newTask()
  assert.equal(h.controller.getState().workspaceId, 'workspace-A')
  h.emit({ type: 'binding', binding: created })
  pending.resolve(created)
  await sending
  assert.deepEqual(h.creations, ['workspace-A'])
  assert.deepEqual(h.submissions, [{ version: 5, text: 'first task', mode: 'prompt' }])
  assert.equal(h.controller.getState().binding?.runtime.runtimeId, 'new-task')
  assert.equal(h.controller.getState().draft, 'next unsent text')
  assert.equal(h.controller.getState().mode, 'session')
  assert.equal(h.context.runtimes.find((runtime) => runtime.active)?.runtimeId, 'B')
})

test('a failed initial send retries the same created session without losing text', async () => {
  const h = harness(null)
  let attempts = 0
  h.api.submitText = async (input) => {
    h.submissions.push(input)
    if (++attempts === 1) throw new Error('provider unavailable')
    return { type: 'response', id: 'retry', command: 'prompt', success: true }
  }
  h.controller.start()
  await flush()
  h.controller.setDraft('keep this task')
  await h.controller.submit()
  await flush()
  const runtimeId = h.controller.getState().binding?.runtime.runtimeId
  assert.equal(h.controller.getState().draft, 'keep this task')
  assert.equal(h.controller.getState().error, 'provider unavailable')
  await h.controller.submit()
  assert.equal(h.creations.length, 1)
  assert.equal(h.controller.getState().binding?.runtime.runtimeId, runtimeId)
  assert.equal(h.controller.getState().draft, '')
  assert.equal(h.submissions.length, 2)
})

test('new-task navigation does not stop or answer the old task and preserves its draft for continuation', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  h.controller.setDraft('a follow-up for A')
  h.event({ type: 'agent_start' })
  h.emit({ type: 'approval', version: 1, request: { type: 'extension_ui_request', id: 'pending-A', method: 'confirm' } })
  await h.controller.newTask()
  assert.equal(h.controller.getState().mode, 'new')
  assert.equal(h.controller.getState().binding, null)
  assert.equal(h.controller.getState().draft, '')
  assert.deepEqual(h.answers, [])
  assert.deepEqual(h.stops, [])
  h.controller.setDraft('independent task')
  await h.controller.select({ runtimeId: 'A' })
  await flush()
  assert.equal(h.controller.getState().draft, 'a follow-up for A')
  await h.controller.newTask()
  assert.equal(h.controller.getState().draft, 'independent task')
})

test('reopening preserves the current session so the user can see responses and active tasks', async () => {
  const h = harness(null)
  h.controller.start()
  await flush()
  h.controller.setDraft('finish this')
  await h.controller.submit()
  await flush()
  const completed = h.controller.getState().binding!
  completed.runtime.activity = 'completed'
  h.emit({ type: 'binding', binding: completed })
  h.emit({ type: 'visibility', visible: false })
  h.emit({ type: 'visibility', visible: true })
  await flush()
  assert.equal(h.controller.getState().mode, 'session')
  assert.equal(h.controller.getState().binding?.runtime.runtimeId, completed.runtime.runtimeId)
  assert.equal(h.creations.length, 1)
})

test('reopening keeps unsent follow-ups and pending approvals, and Stop never implicitly answers them', async () => {
  const h = harness(null)
  h.controller.start()
  await flush()
  h.controller.setDraft('start this')
  await h.controller.submit()
  await flush()
  const target = h.controller.getState().binding!
  target.runtime.activity = 'needs-approval'
  const request: PiExtensionUiRequest = { type: 'extension_ui_request', id: 'approval', method: 'confirm' }
  h.api.getSnapshot = async () => snapshot(target, { request })
  h.emit({ type: 'binding', binding: target })
  h.emit({ type: 'approval', version: target.version, request })
  h.controller.setDraft('follow-up not yet sent')
  h.emit({ type: 'visibility', visible: true })
  await flush()
  assert.equal(h.controller.getState().binding?.runtime.runtimeId, target.runtime.runtimeId)
  assert.equal(h.controller.getState().draft, 'follow-up not yet sent')
  assert.equal(h.controller.getState().request?.id, 'approval')
  await h.controller.hide()
  assert.deepEqual(h.stops, [])
  await h.controller.stop()
  assert.deepEqual(h.stops, [target.version])
  assert.deepEqual(h.answers, [])
  assert.equal(h.controller.getState().draft, 'follow-up not yet sent')
})

test('Enter during Stop preserves the draft without starting or steering another turn', async () => {
  const h = harness()
  const target = binding('A')
  target.runtime.activity = 'working'
  h.api.getSnapshot = async () => snapshot(target, { streaming: { content: 'running', thinking: '' } })
  h.controller.start()
  await flush()
  const pending = deferred<void>()
  h.api.stop = () => pending.promise
  const stopping = h.controller.stop()
  h.controller.setDraft('send only after stopping')
  await h.controller.submit()
  assert.deepEqual(h.submissions, [])
  assert.equal(h.controller.getState().draft, 'send only after stopping')
  pending.resolve()
  await stopping
  assert.deepEqual(h.submissions, [])
})

test('startup binding revisions do not lose a matching refusal received before admission returns', async () => {
  const h = harness()
  const pending = deferred<PiResponseEvent | null>()
  h.api.submitText = () => pending.promise
  const started = binding('A', 2)
  h.api.getSnapshot = async () => snapshot(started)
  h.controller.start()
  await flush()
  h.controller.setDraft('keep the startup task')
  const sending = h.controller.submit()
  h.emit({ type: 'binding', binding: started })
  h.event({ type: 'prompt_result', id: 'startup-refusal', agentInvoked: false, status: 'error', error: { message: 'missing credentials' } }, started)
  pending.resolve({ type: 'response', id: 'startup-refusal', command: 'prompt', success: true })
  await sending
  assert.equal(h.controller.getState().draft, 'keep the startup task')
  assert.equal(h.controller.getState().error, 'missing credentials')
  h.controller.dispose()
})

test('canceling the project picker keeps unassigned text and choosing a folder attaches it without creating a task', async () => {
  const h = harness(null)
  h.context.defaultWorkspaceId = null
  h.context.workspaces = []
  h.controller.start()
  await flush()
  h.controller.setDraft('an idea captured before a folder exists')
  await h.controller.pickWorkspace()
  assert.equal(h.controller.getState().workspaceId, null)
  assert.equal(h.controller.getState().draft, 'an idea captured before a folder exists')
  const workspace = { id: 'new-project', name: 'Project', path: '/project', createdAt: 0, lastActiveAt: 0, color: '' }
  h.api.pickWorkspace = async () => {
    h.context.workspaces.push(workspace)
    return workspace
  }
  await h.controller.pickWorkspace()
  assert.equal(h.controller.getState().workspaceId, 'new-project')
  assert.equal(h.controller.getState().draft, 'an idea captured before a folder exists')
  assert.equal(h.controller.getState().binding, null)
  assert.deepEqual(h.creations, [])
  h.controller.dispose()
})

test('a removed draft project falls back to the home workspace instead of silently re-targeting', async () => {
  const h = harness(null)
  h.controller.start()
  await flush()
  h.controller.setDraft('task for a removed project')
  h.context.workspaces = h.context.workspaces.filter((workspace) => workspace.id !== 'workspace-A')
  await h.controller.refreshContext()
  assert.equal(h.controller.getState().workspaceId, null)
  assert.equal(h.controller.getState().draft, 'task for a removed project')
  await h.controller.submit()
  assert.deepEqual(h.creations, ['workspace-home'], 'the removed-project draft sends to the home workspace')
  assert.equal(h.controller.getState().workspaceId, 'workspace-home')
  h.controller.dispose()
})

test('a new-task model choice creates no runtime and rides the first send', async () => {
  const h = harness(null)
  h.controller.start()
  await flush()
  h.controller.setDraft('first task')
  const chosen = await h.controller.setModelChoice(model('deepseek', 'deepseek-v4-flash'))
  assert.equal(chosen, true)
  assert.equal(h.controller.getState().preparedModel?.modelId, 'deepseek-v4-flash')
  assert.equal(h.controller.getState().model, null)
  assert.deepEqual(h.modelCalls, [], 'a pending choice must not touch a runtime that does not exist')
  await h.controller.submit()
  assert.equal(h.creations.length, 1)
  assert.deepEqual(h.submissions, [{
    version: h.controller.getState().binding!.version, text: 'first task', mode: 'prompt', model: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
  }])
  // The engine accepted the send with the config: it is no longer pending.
  assert.equal(h.controller.getState().preparedModel, null)
  h.controller.dispose()
})

test('per-project draft model isolation survives project switches and hide/reshow', async () => {
  const h = harness(null)
  h.controller.start()
  await flush()
  h.controller.setWorkspace('workspace-A')
  await h.controller.setModelChoice(model('provider-a', 'model-a'))
  h.controller.setDraft('task for A')
  h.controller.setWorkspace('workspace-B')
  assert.equal(h.controller.getState().preparedModel, null, 'B starts without A choice')
  assert.equal(h.controller.getState().draft, '')
  await h.controller.setModelChoice(model('provider-b', 'model-b'))
  h.controller.setWorkspace('workspace-A')
  assert.equal(h.controller.getState().preparedModel?.provider, 'provider-a')
  assert.equal(h.controller.getState().draft, 'task for A')
  h.controller.setWorkspace('workspace-B')
  assert.equal(h.controller.getState().preparedModel?.provider, 'provider-b')
  h.controller.dispose()
})

test('a stopped session keeps its model choice pending and applies it on the next send', async () => {
  const h = harness()
  const stopped = binding('A')
  stopped.runtime.status = 'stopped'
  stopped.runtime.activity = 'completed'
  h.api.getSnapshot = async () => snapshot(stopped)
  h.controller.start()
  await flush()
  h.controller.setDraft('resume this')
  const chosen = await h.controller.setModelChoice(model('deepseek', 'deepseek-v4-flash'))
  assert.equal(chosen, true)
  assert.deepEqual(h.modelCalls, [], 'a stopped runtime never receives a live switch')
  assert.equal(h.controller.getState().preparedModel?.modelId, 'deepseek-v4-flash')
  await h.controller.submit()
  assert.deepEqual(h.submissions, [{
    version: h.controller.getState().binding!.version, text: 'resume this', mode: 'prompt', model: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
  }])
  assert.equal(h.controller.getState().preparedModel, null)
  h.controller.dispose()
})

test('an idle running session switches its model live; a busy one stores it pending instead', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  const chosen = await h.controller.setModelChoice(model('deepseek', 'deepseek-v4-flash'))
  assert.equal(chosen, true)
  assert.deepEqual(h.modelCalls, [{ provider: 'deepseek', modelId: 'deepseek-v4-flash', version: 1 }])
  assert.equal(h.controller.getState().preparedModel, null)
  // Busy: no live switch, choice is pending on the draft and sent with the steer.
  h.event({ type: 'agent_start' })
  const busy = await h.controller.setModelChoice(model('anthropic', 'claude-sonnet-4'))
  assert.equal(busy, true)
  assert.equal(h.modelCalls.length, 1, 'a busy runtime must not receive set_model')
  assert.equal(h.controller.getState().preparedModel?.provider, 'anthropic')
  h.controller.setDraft('steer now')
  await h.controller.submit()
  assert.equal(h.submissions[0].mode, 'steer')
  assert.equal(h.submissions[0].model?.provider, 'anthropic')
  h.controller.dispose()
})

test('a live switch that fails keeps the pending choice and surfaces the engine error', async () => {
  const h = harness()
  h.api.setRuntimeModel = async () => { throw new Error('model not found') }
  h.controller.start()
  await flush()
  const chosen = await h.controller.setModelChoice(model('deepseek', 'nope'))
  assert.equal(chosen, false)
  assert.equal(h.controller.getState().error, 'model not found')
  assert.equal(h.controller.getState().preparedModel, null)
  assert.equal(h.controller.getState().switching, false)
  h.controller.dispose()
})

test('model/thinking choices are refused while a request waits for an answer', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  const request: PiExtensionUiRequest = { type: 'extension_ui_request', id: 'hold', method: 'confirm' }
  h.api.getSnapshot = async () => snapshot(h.controller.getState().binding!, { request })
  h.emit({ type: 'approval', version: 1, request })
  await flush()
  assert.equal(h.controller.getState().request?.id, 'hold')
  const chosen = await h.controller.setModelChoice(model('deepseek', 'deepseek-v4-flash'))
  assert.equal(chosen, false)
  const thinking = await h.controller.setThinkingChoice('high')
  assert.equal(thinking, false)
  assert.equal(h.controller.getState().preparedModel, null)
  assert.deepEqual(h.modelCalls, [])
  assert.deepEqual(h.thinkingCalls, [])
  h.controller.dispose()
})

test('a thinking choice on an idle running session switches live and is not kept pending', async () => {
  const h = harness()
  h.controller.start()
  await flush()
  const chosen = await h.controller.setThinkingChoice('high')
  assert.equal(chosen, true)
  assert.deepEqual(h.thinkingCalls, [{ level: 'high', version: 1 }])
  assert.equal(h.controller.getState().preparedThinkingLevel, null)
  h.controller.dispose()
})

test('a binding event during the first send does not leave the applied model pending', async () => {
  const h = harness(null)
  h.controller.start()
  await flush()
  h.controller.setWorkspace('workspace-A')
  h.controller.setDraft('first task')
  await h.controller.setModelChoice(model('deepseek', 'deepseek-v4-flash'))
  // The engine starts the runtime mid-send and its status-change events
  // re-bind with a fresh version — exactly what the real app does. The
  // harness's createSession emits the first created runtime at version 1.
  const started = binding('created-1', 2)
  started.runtime.workspaceId = 'workspace-A'
  const withSessionPath = binding('created-1', 3)
  withSessionPath.runtime.workspaceId = 'workspace-A'
  withSessionPath.runtime.sessionPath = '/sessions/created-1.jsonl'
  const pending = deferred<PiResponseEvent | null>()
  h.api.submitText = (input) => {
    h.submissions.push(input)
    // The runtime reports starting/running while the prompt is in flight.
    h.emit({ type: 'binding', binding: started })
    h.emit({ type: 'binding', binding: withSessionPath })
    return pending.promise
  }
  h.api.getSnapshot = async () => snapshot(withSessionPath, { model: { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' } as unknown as ModelInfo })
  const sending = h.controller.submit()
  pending.resolve({ type: 'response', id: 'prompt-1', command: 'prompt', success: true })
  await sending
  assert.deepEqual(h.submissions, [{
    version: 3, text: 'first task', mode: 'prompt', model: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
  }])
  // The applied config must not linger as pending, even though the binding
  // changed while the prompt was in flight.
  assert.equal(h.controller.getState().preparedModel, null)
  assert.equal(h.controller.getState().model?.name, 'DeepSeek V4 Flash')
  h.controller.dispose()
})

test('a runtime-state update refreshes only the bound session after a main-window model switch', async () => {
  const h = harness()
  const switched = snapshot(binding('A'), { model: { provider: 'deepseek', id: 'flash', name: 'Flash' } as unknown as ModelInfo })
  let reads = 0
  h.api.getSnapshot = async () => { reads++; return switched }
  h.controller.start()
  await flush()
  assert.equal(h.controller.getState().model?.name, 'Flash')
  const readsAfterStart = reads
  // A switch on some other runtime must not touch this view.
  h.emit({ type: 'runtime-state', runtimeId: 'elsewhere' })
  await flush()
  assert.equal(reads, readsAfterStart, 'a foreign runtime switch triggers no reload')
  // A switch on the bound runtime refreshes its state.
  const after = snapshot(binding('A'), { model: { provider: 'deepseek', id: 'pro', name: 'Pro' } as unknown as ModelInfo })
  h.api.getSnapshot = async () => { reads++; return after }
  h.emit({ type: 'runtime-state', runtimeId: 'A' })
  await flush()
  assert.ok(reads > readsAfterStart, 'the bound runtime re-read its snapshot')
  assert.equal(h.controller.getState().model?.name, 'Pro', 'the label follows the main-window switch')
  h.controller.dispose()
})

for (const mode of ['new', 'stopped'] as const) {
  test(`${mode} draft model changes keep compatible efforts and clear incompatible ones without losing text`, async () => {
    const initial = mode === 'new' ? null : binding('A')
    if (initial) initial.runtime.status = 'stopped'
    const h = harness(initial)
    h.controller.start()
    try {
      await flush()
      h.controller.setDraft('keep this task')
      await h.controller.setThinkingChoice('max')
      await h.controller.setModelChoice(model('provider', 'wide', ['low', 'max']))
      assert.equal(h.controller.getState().preparedThinkingLevel, 'max')
      await h.controller.setModelChoice(model('provider', 'narrow', ['low']))
      assert.equal(h.controller.getState().preparedThinkingLevel, null)
      assert.equal(h.controller.getState().draft, 'keep this task')
      await h.controller.submit()
      assert.deepEqual(h.submissions[0].model, { provider: 'provider', modelId: 'narrow' })
      assert.equal(h.submissions[0].thinkingLevel, undefined)
    } finally {
      h.controller.dispose()
    }
  })
}

test('controller stages attachments, composes prompt with text files inlined and images sent as blocks', async () => {
  const h = harness(binding('A'))
  h.controller.start()
  try {
    await flush()
    h.controller.setDraft('Check these')
    h.controller.addAttachments([
      { kind: 'text', name: 'config.json', path: 'config.json', content: '{"key":"value"}' },
      { kind: 'image', name: 'screenshot.png', path: 'screenshot.png', image: { type: 'image', mimeType: 'image/png', data: 'BASE64IMG' } },
    ])
    assert.equal(h.controller.getState().attachments.length, 2)
    await h.controller.submit()
    assert.equal(h.submissions.length, 1)
    assert.ok(h.submissions[0].text.includes('Check these'))
    assert.ok(h.submissions[0].text.includes('config.json'))
    assert.ok(h.submissions[0].text.includes('{"key":"value"}'))
    assert.deepEqual(h.submissions[0].images, [{ type: 'image', mimeType: 'image/png', data: 'BASE64IMG' }])
    assert.equal(h.controller.getState().draft, '')
    assert.equal(h.controller.getState().attachments.length, 0)
  } finally {
    h.controller.dispose()
  }
})

test('attachment removal, error clearing and deduplication work as expected', async () => {
  const h = harness(binding('A'))
  h.controller.start()
  try {
    await flush()
    h.controller.addAttachments([
      { kind: 'text', name: 'a.txt', path: 'a.txt', content: 'AAA' },
      { kind: 'text', name: 'b.txt', path: 'b.txt', content: 'BBB' },
    ])
    assert.equal(h.controller.getState().attachments.length, 2)
    // Duplicate attachment ignored
    h.controller.addAttachments([{ kind: 'text', name: 'a.txt', path: 'a.txt', content: 'AAA' }])
    assert.equal(h.controller.getState().attachments.length, 2)
    h.controller.removeAttachment(0)
    assert.equal(h.controller.getState().attachments.length, 1)
    assert.equal(h.controller.getState().attachments[0].name, 'b.txt')
    h.controller.setAttachError('Failed to read file')
    assert.equal(h.controller.getState().attachError, 'Failed to read file')
    h.controller.clearAttachments()
    assert.equal(h.controller.getState().attachments.length, 0)
    assert.equal(h.controller.getState().attachError, null)
  } finally {
    h.controller.dispose()
  }
})

test('a pending model switch cannot lock the next session or apply its result there', async () => {
  const h = harness()
  const pending = deferred<PiResponseEvent | null>()
  h.api.setRuntimeModel = () => pending.promise
  h.controller.start()
  try {
    await flush()
    const changing = h.controller.setModelChoice(model('provider', 'chosen'))
    await h.controller.select({ runtimeId: 'B' })
    pending.resolve({ type: 'response', command: 'set_model', success: true })
    await changing
    assert.equal(h.controller.getState().switching, false)
    assert.equal(h.controller.getState().preparedModel, null)
    assert.equal(await h.controller.setThinkingChoice('high'), true)
    assert.equal(h.thinkingCalls[0].version, h.controller.getState().binding?.version)
  } finally {
    h.controller.dispose()
  }
})

test('picked attachments do not move into another project when their read finishes late', async () => {
  const h = harness(null)
  const pending = deferred<AttachmentReadResult[]>()
  h.api.pickAttachment = () => pending.promise
  h.controller.start()
  try {
    await flush()
    h.controller.setWorkspace('workspace-A')
    const reading = h.controller.pickAttachment()
    h.controller.setWorkspace('workspace-B')
    pending.resolve([{ kind: 'text', name: 'private-A.txt', content: 'A only' }])
    await reading
    assert.deepEqual(h.controller.getState().attachments, [])
    assert.equal(h.controller.getState().isReadingAttachments, false)
  } finally {
    h.controller.dispose()
  }
})

test('send acknowledgement removes only the attachments captured by that send', async () => {
  const h = harness()
  const pending = deferred<PiResponseEvent | null>()
  h.api.submitText = () => pending.promise
  h.controller.start()
  try {
    await flush()
    h.controller.setDraft('send these files')
    h.controller.addAttachments([{ kind: 'text', name: 'first.txt', path: 'first.txt', content: 'first' }])
    const sending = h.controller.submit()
    h.controller.addAttachments([{ kind: 'text', name: 'next.txt', path: 'next.txt', content: 'next' }])
    pending.resolve({ type: 'response', id: 'prompt-1', command: 'prompt', success: true })
    await sending
    assert.equal(h.controller.getState().draft, '')
    assert.deepEqual(h.controller.getState().attachments.map((item) => item.name), ['next.txt'])
    h.event({
      type: 'prompt_result', id: 'prompt-1', agentInvoked: false,
      status: 'error', error: { message: 'The request was not accepted' },
    })
    assert.equal(h.controller.getState().draft, 'send these files')
    assert.deepEqual(h.controller.getState().attachments.map((item) => item.name), ['first.txt', 'next.txt'])
  } finally {
    h.controller.dispose()
  }
})

test('a dropped attachment batch is discarded after its draft target changes', async () => {
  const h = harness(null)
  const pending = deferred<AttachmentReadResult>()
  h.controller.start()
  try {
    await flush()
    h.controller.setWorkspace('workspace-A')
    const reading = h.controller.readAttachments([
      { label: 'private.txt', path: 'private.txt', read: () => pending.promise },
    ])
    h.controller.setWorkspace('workspace-B')
    pending.resolve({ kind: 'text', name: 'private.txt', content: 'A only' })
    await reading
    assert.deepEqual(h.controller.getState().attachments, [])
    assert.equal(h.controller.getState().attachError, null)
  } finally {
    h.controller.dispose()
  }
})

test('a replacement attachment with the same path survives an earlier send', async () => {
  const h = harness()
  const pending = deferred<PiResponseEvent | null>()
  h.api.submitText = () => pending.promise
  h.controller.start()
  try {
    await flush()
    h.controller.setDraft('original')
    h.controller.addAttachments([{ kind: 'text', name: 'file.txt', path: 'file.txt', content: 'old' }])
    const sending = h.controller.submit()
    h.controller.removeAttachment(0)
    h.controller.addAttachments([{ kind: 'text', name: 'file.txt', path: 'file.txt', content: 'new' }])
    pending.resolve({ type: 'response', command: 'prompt', success: true })
    await sending
    assert.deepEqual(h.controller.getState().attachments, [
      { kind: 'text', name: 'file.txt', path: 'file.txt', content: 'new' },
    ])
  } finally {
    h.controller.dispose()
  }
})

test('stream activity cannot hide the confirmed model and thinking level from a snapshot', async () => {
  const h = harness()
  h.controller.start()
  try {
    await flush()
    const pending = deferred<QuickChatSnapshot>()
    h.api.getSnapshot = () => pending.promise
    const loading = h.controller.reloadSnapshot()
    h.event({ type: 'agent_start' })
    h.event({
      type: 'message_update', message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'Live answer', offset: 0 },
    })
    pending.resolve(snapshot(binding('A'), {
      model: model('provider', 'actual-model'), thinkingLevel: 'max', permissionMode: 'ask-edits',
    }))
    await loading
    assert.equal(h.controller.getState().model?.id, 'actual-model')
    assert.equal(h.controller.getState().thinkingLevel, 'max')
    assert.equal(h.controller.getState().permissionMode, 'ask-edits')
    assert.equal(h.controller.getState().busy, true)
    assert.equal(h.controller.getState().content, 'Live answer')
  } finally {
    h.controller.dispose()
  }
})
