import { createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { I18nextProvider } from 'react-i18next'
import { ChatSessionContext, type ChatSessionBindings } from '../chat-session-context'
import type { ComposerDraft } from '../store'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { i18n } from '../../../shared/i18n'
import type { ChromiumProbeResult } from './chromium-probe.test-helper'
import { ChatComposerDock } from './chat-composer-dock'

const FIRST_PROMPT = 'first prompt of a new chat'
const FLOATING_FRAME_CLASS = 'absolute'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
// Timers work in a hidden BrowserWindow too; requestAnimationFrame can be throttled.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 3000
  while (!predicate()) {
    check(performance.now() < deadline, `Timed out waiting for ${what}`)
    await tick()
  }
}

/**
 * The chat panel's composer dock with a host that behaves like the main
 * chat: an accepted first prompt adds a message, so the empty chat's
 * centered layout gives way to the floating one before the send resolves.
 */
function mount(accept: boolean) {
  const host = document.getElementById('root')!
  const root = createRoot(host)
  const dropZoneRef = createRef<HTMLDivElement>()
  const state = { centered: true, draft: { text: '', attachments: [] } as ComposerDraft, settled: false }
  const isFloating = (): boolean => host.firstElementChild?.classList.contains(FLOATING_FRAME_CLASS) ?? false
  const bindings: ChatSessionBindings = {
    engine: 'pi', settings: DEFAULT_SETTINGS, permissionMode: 'ask-edits',
    models: {
      scopeKey: 'A', status: 'running', model: null, thinkingLevel: null,
      pendingModel: null, pendingThinkingLevel: null, useDefaults: false, locked: false, open: false,
      setOpen: () => {}, list: async () => [], select: async () => {}, selectThinking: async () => {}, cycle: async () => {},
    },
    composer: {
      scopeKey: 'A', active: true, loading: false, streaming: false, sending: false,
      focusRequested: false, requestFocus: () => {}, clearFocusRequest: () => {}, pendingInsert: null,
      readDraft: () => state.draft,
      saveDraft: (draft) => { state.draft = draft },
      history: [], recordPrompt: () => {},
      submit: async () => {
        try {
          if (!accept) return false
          state.centered = false
          render()
          await until(isFloating, 'the floating composer')
          return true
        } finally {
          state.settled = true
        }
      },
      stop: () => {}, escape: 'abort',
      searchFiles: async () => [], pickAttachments: async () => ({ attachments: [], errors: [] }),
      commands: [], guiCommands: [],
    },
    approval: { request: null, notify: null, answering: false, respond: () => {}, cancel: () => {}, dismissNotify: () => {} },
    voice: { loadStatus: async () => { throw new Error('Voice is outside this composer probe') }, openSettings: () => {}, globalShortcuts: false },
  }
  function render(): void {
    root.render(
      <I18nextProvider i18n={i18n}>
        <ChatSessionContext.Provider value={bindings}>
          <ChatComposerDock centered={state.centered} dropZoneRef={dropZoneRef} />
        </ChatSessionContext.Provider>
      </I18nextProvider>
    )
  }
  flushSync(render)
  const textarea = (): HTMLTextAreaElement => {
    const element = host.querySelector('textarea')
    check(element, 'The composer must be visible')
    return element
  }
  return {
    state, textarea, isFloating,
    type: (text: string) => {
      const element = textarea()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, text)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    },
    send: () => {
      const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('chat.sendButton.ariaLabel')}"]`)
      check(button, 'The send button must be visible')
      button.click()
    },
    unmount: () => { flushSync(() => root.unmount()) },
  }
}

export async function run(): Promise<ChromiumProbeResult[]> {
  await i18n.changeLanguage('en')
  const results: ChromiumProbeResult[] = []
  const scenario = async (name: string, accept: boolean, body: (probe: ReturnType<typeof mount>) => Promise<void>): Promise<void> => {
    const probe = mount(accept)
    try {
      await body(probe)
      results.push({ name })
    } catch (error) {
      results.push({ name, error: String(error) })
    } finally { probe.unmount() }
  }
  await scenario('the first send of an empty chat clears the composer after it starts to float', true, async (p) => {
    const composer = p.textarea()
    p.type(FIRST_PROMPT)
    p.send()
    await until(() => p.state.settled, 'the send to settle')
    await tick()
    check(p.isFloating(), 'An accepted first prompt must move the composer to the floating layout')
    check(p.textarea() === composer, 'The layout switch must keep the same composer')
    check(composer.value === '', `The sent prompt must leave the box, found "${composer.value}"`)
    check(p.state.draft.text === '', `The sent prompt must leave the saved draft, found "${p.state.draft.text}"`)
  })
  await scenario('a refused first send keeps the prompt in the centered composer', false, async (p) => {
    p.type(FIRST_PROMPT)
    p.send()
    await until(() => p.state.settled, 'the send to settle')
    await tick()
    check(!p.isFloating(), 'A refused prompt must leave the chat empty')
    check(p.textarea().value === FIRST_PROMPT, 'A refused prompt must stay in the box')
  })
  return results
}
