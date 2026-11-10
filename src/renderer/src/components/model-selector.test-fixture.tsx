import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { I18nextProvider } from 'react-i18next'
import { ChatSessionContext, type ChatSessionBindings } from '../chat-session-context'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import type { AgentEngineKind, ModelInfo } from '../../../shared/ipc-contracts'
import { i18n } from '../../../shared/i18n'
import { ModelSelector } from './model-selector'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
// Timers work in a hidden BrowserWindow too; requestAnimationFrame can be throttled.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000
  while (!predicate()) {
    check(performance.now() < deadline, 'Timed out waiting for the rendered picker')
    await tick()
  }
}
const candidate: ModelInfo = {
  id: 'candidate', name: 'Candidate', provider: 'probe', api: 'openai-completions', baseUrl: '',
  reasoning: true, input: ['text'], contextWindow: 1000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinking: { efforts: ['low', 'high'] },
}

function mount(engine: AgentEngineKind) {
  const host = document.getElementById('root')!
  const root = createRoot(host)
  const calls: string[] = []
  let bindings: ChatSessionBindings = {
    engine, settings: DEFAULT_SETTINGS, permissionMode: 'ask-edits',
    models: {
      scopeKey: 'A', status: 'running', model: null, thinkingLevel: 'low',
      pendingModel: null, pendingThinkingLevel: null, useDefaults: false,
      locked: false, open: true,
      setOpen: (open) => { bindings.models.open = open; render() },
      list: async () => [candidate], select: async () => { calls.push('model') },
      selectThinking: async (level) => { calls.push(level) }, cycle: async () => {},
    },
    composer: {
      scopeKey: 'A', active: true, loading: false, streaming: false, sending: false,
      focusRequested: false, requestFocus: () => {
        calls.push('focus'); host.querySelector('textarea')!.focus()
      }, clearFocusRequest: () => {}, pendingInsert: null,
      readDraft: () => ({ text: '', attachments: [] }), saveDraft: () => {},
      history: [], recordPrompt: () => {}, submit: async () => true, stop: () => {}, escape: 'abort',
      searchFiles: async () => [], pickAttachments: async () => ({ attachments: [], errors: [] }),
      commands: [], guiCommands: [],
    },
    approval: { request: null, notify: null, answering: false, respond: () => {}, cancel: () => {}, dismissNotify: () => {} },
    voice: { loadStatus: async () => { throw new Error('Voice is outside this picker probe') }, openSettings: () => {}, globalShortcuts: false },
  }
  function render(): void {
    root.render(<I18nextProvider i18n={i18n}><ChatSessionContext.Provider value={{ ...bindings }}><textarea /><ModelSelector /></ChatSessionContext.Provider></I18nextProvider>)
  }
  flushSync(render)
  const search = (): HTMLInputElement => {
    const input = host.querySelector('input')
    check(input, 'The model search must be visible')
    return input
  }
  return {
    host, calls, search,
    key: (key: string) => search().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    ready: () => until(() => host.querySelector('[data-model-index]') !== null),
    change: (patch: Partial<ChatSessionBindings['models']>) => {
      bindings = { ...bindings, models: { ...bindings.models, ...patch } }
      flushSync(render)
    },
    unmount: () => { flushSync(() => root.unmount()) },
  }
}

export async function run(): Promise<Array<{ name: string; error?: string }>> {
  await i18n.changeLanguage('en')
  const results: Array<{ name: string; error?: string }> = []
  for (const engine of ['pi', 'omp'] as const) {
    const scenario = async (name: string, body: (probe: ReturnType<typeof mount>) => Promise<void>): Promise<void> => {
      localStorage.clear()
      const probe = mount(engine)
      try {
        await body(probe)
        results.push({ name: `${engine}: ${name}` })
      } catch (error) {
        results.push({ name: `${engine}: ${name}`, error: String(error) })
      } finally { probe.unmount() }
    }
    await scenario('effort is staged, confirmation waits for the model, and duplicate Enter is ignored', async (p) => {
      const selected = deferred<void>()
      p.change({ select: async () => { p.calls.push('model'); await selected.promise } })
      await p.ready()
      p.key('ArrowRight')
      await tick()
      check(!p.calls.length, 'Arrows must not change the engine model or effort')
      p.key('Enter'); p.key('Enter')
      await tick()
      check(p.calls.join() === 'model', 'Effort must wait for exactly one model selection')
      selected.resolve()
      await until(() => !p.host.querySelector('input'))
      check(p.calls.join() === 'model,high,focus', `Unexpected selection order: ${p.calls}`)
    })
    await scenario('a failed model selection leaves the picker and effort draft available for retry', async (p) => {
      let fail = true
      p.change({ select: async () => { p.calls.push('model'); if (fail) throw new Error('Model switch refused') } })
      await p.ready()
      p.key('ArrowRight'); await tick(); p.key('Enter')
      await until(() => !!p.host.querySelector('[role="alert"]'))
      check(p.host.textContent?.includes('Model switch refused'), 'The engine error must be visible')
      check(p.calls.join() === 'model', 'A rejected model must not apply effort or close')
      fail = false
      p.key('Enter')
      await until(() => !p.host.querySelector('input'))
      check(p.calls.join() === 'model,model,high,focus', 'Retry must preserve the chosen effort')
    })
    await scenario('Escape closes the picker and returns focus without selecting a model', async (p) => {
      await p.ready()
      p.key('Escape')
      await until(() => !p.host.querySelector('input'))
      check(p.calls.join() === 'focus', 'Escape must only return focus')
      check(document.activeElement === p.host.querySelector('textarea'), 'Composer must regain focus')
    })
    await scenario('a late catalog from A cannot replace B after switching sessions', async (p) => {
      const oldCatalog = deferred<ModelInfo[]>()
      p.change({ list: () => oldCatalog.promise })
      await tick()
      p.change({ scopeKey: 'B', list: async () => [{ ...candidate, id: 'b', name: 'Model B' }] })
      await p.ready()
      oldCatalog.resolve([{ ...candidate, name: 'Stale A' }])
      await tick(); await tick()
      check(p.host.textContent?.includes('Model B'), 'B must retain its own catalog')
      check(!p.host.textContent?.includes('Stale A'), 'A must not overwrite B')
    })
    await scenario('switching sessions during selection cannot apply old effort or close the new picker', async (p) => {
      const pending = deferred<void>()
      p.change({ select: async () => { p.calls.push('model:A'); await pending.promise } })
      await p.ready()
      p.key('ArrowRight'); await tick(); p.key('Enter'); await tick()
      p.change({ scopeKey: 'B', list: async () => [{ ...candidate, id: 'b', name: 'Model B' }] })
      await p.ready()
      pending.resolve()
      await tick(); await tick()
      check(p.calls.join() === 'model:A', 'A completion must not apply effort or move focus in B')
      check(!!p.host.querySelector('input') && p.host.textContent?.includes('Model B'), 'B picker must remain open')
    })
  }
  return results
}
