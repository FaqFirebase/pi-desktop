import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { I18nextProvider } from 'react-i18next'
import { useAppStore, type DisplayMessage } from '../store'
import { i18n } from '../../../shared/i18n'
import type { ChromiumProbeResult } from './chromium-probe.test-helper'
import { MessageBubble } from './message-bubble'

const USER_MESSAGE: DisplayMessage = { id: 'u1', role: 'user', content: 'first prompt', timestamp: 0 }

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function mount() {
  const host = document.getElementById('root')!
  const root = createRoot(host)
  const branched: string[] = []
  useAppStore.setState({
    messages: [USER_MESSAGE],
    branchFromMessage: async (messageId) => { branched.push(messageId); return true },
  })
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><MessageBubble message={USER_MESSAGE} /></I18nextProvider>))
  return {
    branched,
    branchButton: () => {
      const button = host.querySelector<HTMLButtonElement>(`button[title="${i18n.t('chat.message.branchFromHere')}"]`)
      check(button, 'A sent user message must offer Branch from here')
      return button
    },
    unmount: () => { flushSync(() => root.unmount()) },
  }
}

export async function run(): Promise<ChromiumProbeResult[]> {
  await i18n.changeLanguage('en')
  const results: ChromiumProbeResult[] = []
  const name = 'Branch from here forks the session at the clicked message'
  const probe = mount()
  try {
    flushSync(() => probe.branchButton().click())
    check(probe.branched.join() === USER_MESSAGE.id, `The branch must fork at ${USER_MESSAGE.id}, forked at: ${probe.branched.join()}`)
    const messages = useAppStore.getState().messages
    check(messages.length === 1, `The branch must not add a chat notice, found ${messages.length} messages`)
    results.push({ name })
  } catch (error) {
    results.push({ name, error: String(error) })
  } finally { probe.unmount() }
  return results
}
