import { createRef, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useChatKeyboard, useEscapeToClose } from '../hooks'
import { ESCAPE_KEY } from '../utils/escape-key'
import type { ChromiumProbeResult } from './chromium-probe.test-helper'
import { useContextMenu } from './context-menu'

const ABORT = 'abort'
const CLOSE = 'close'
const LOWER_MODAL = 'lower-modal'
const UPPER_MODAL = 'upper-modal'
const MENU_ITEM_ID = 'probe-item'
const MENU_POSITION = 40
/** The context menu adds its key listener after a short delay, so the opening click cannot close it. */
const CONTEXT_MENU_LISTENER_DELAY_MS = 50

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 3000
  while (!predicate()) {
    check(performance.now() < deadline, `Timed out waiting for ${what}`)
    await delay(0)
  }
}

/** A streaming chat: Escape that reaches the chat's handler stops the turn. */
function StreamingChat({ calls, children }: { calls: string[]; children?: React.ReactNode }): React.JSX.Element {
  useChatKeyboard(() => {}, () => {}, createRef<HTMLTextAreaElement>(), {
    active: true, streaming: true, escape: 'abort', onEscape: () => { calls.push(ABORT) },
  })
  return <>{children}</>
}

function MenuOwner({ calls, onReady }: { calls: string[]; onReady: (open: () => void) => void }): React.JSX.Element {
  const { show, ContextMenuComponent } = useContextMenu()
  useEffect(() => {
    onReady(() => show({
      preventDefault: () => {}, stopPropagation: () => {}, clientX: MENU_POSITION, clientY: MENU_POSITION,
    } as unknown as React.MouseEvent, [{ id: MENU_ITEM_ID, label: MENU_ITEM_ID, action: () => { calls.push(MENU_ITEM_ID) } }]))
  }, [calls, onReady, show])
  return <>{ContextMenuComponent}</>
}

/** A modal added after the chat's handler, as a dialog that opens mid-turn is; Escape closes it. */
function LateModal({ name, onClose }: { name: string; onClose: (name: string) => void }): React.JSX.Element {
  useEscapeToClose(true, () => onClose(name))
  return <div role="dialog" data-name={name} />
}

function mount() {
  const host = document.getElementById('root')!
  const root = createRoot(host)
  const calls: string[] = []
  let openMenu: (() => void) | null = null
  let modals: readonly string[] = []
  const render = (): void => root.render(
    <StreamingChat calls={calls}>
      <MenuOwner calls={calls} onReady={(open) => { openMenu = open }} />
      {modals.map((name) => <LateModal key={name} name={name} onClose={closeModal} />)}
    </StreamingChat>,
  )
  function closeModal(name: string): void {
    calls.push(name)
    modals = modals.filter((open) => open !== name)
    render()
  }
  flushSync(render)
  return {
    host, calls,
    menu: () => host.querySelector('[role="menu"]'),
    openModals: () => [...host.querySelectorAll('[role="dialog"]')].map((modal) => modal.getAttribute('data-name')).join(),
    openMenu: () => { check(openMenu, 'The menu owner must be mounted'); flushSync(openMenu) },
    openModal: (name = CLOSE) => { modals = [...modals, name]; flushSync(render) },
    escape: () => {
      const target = document.activeElement ?? document.body
      target.dispatchEvent(new KeyboardEvent('keydown', { key: ESCAPE_KEY, bubbles: true, cancelable: true }))
    },
    unmount: () => { flushSync(() => root.unmount()) },
  }
}

export async function run(): Promise<ChromiumProbeResult[]> {
  const results: ChromiumProbeResult[] = []
  const scenario = async (name: string, body: (probe: ReturnType<typeof mount>) => Promise<void>): Promise<void> => {
    const probe = mount()
    try {
      await body(probe)
      results.push({ name })
    } catch (error) {
      results.push({ name, error: String(error) })
    } finally { probe.unmount() }
  }
  await scenario('Escape with nothing open stops the running turn', async (p) => {
    p.escape()
    check(p.calls.join() === ABORT, `Escape must stop the turn, calls: ${p.calls.join()}`)
  })
  await scenario('Escape closes an open context menu and leaves the running turn alone', async (p) => {
    p.openMenu()
    await until(() => p.menu() !== null, 'the context menu')
    await delay(CONTEXT_MENU_LISTENER_DELAY_MS)
    p.escape()
    await until(() => p.menu() === null, 'the context menu to close')
    check(p.calls.length === 0, `Escape must only close the menu, calls: ${p.calls.join()}`)
  })
  await scenario('Escape closes a modal opened after the chat handler and leaves the running turn alone', async (p) => {
    p.openModal()
    p.escape()
    check(p.calls.join() === CLOSE, `Escape must only close the modal, calls: ${p.calls.join()}`)
  })
  await scenario('Each Escape closes only the top of two modals and never stops the running turn', async (p) => {
    p.openModal(LOWER_MODAL)
    p.openModal(UPPER_MODAL)
    p.escape()
    await until(() => p.openModals() === LOWER_MODAL, 'the upper modal to close')
    check(p.calls.join() === UPPER_MODAL, `The first Escape must only close the upper modal, calls: ${p.calls.join()}`)
    p.escape()
    await until(() => p.openModals() === '', 'the lower modal to close')
    check(p.calls.join() === [UPPER_MODAL, LOWER_MODAL].join(), `The second Escape must only close the lower modal, calls: ${p.calls.join()}`)
  })
  await scenario('Escape closes a context menu opened over a modal before the modal', async (p) => {
    p.openModal()
    p.openMenu()
    await until(() => p.menu() !== null, 'the context menu')
    await delay(CONTEXT_MENU_LISTENER_DELAY_MS)
    p.escape()
    await until(() => p.menu() === null, 'the context menu to close')
    check(p.calls.length === 0 && p.openModals() === CLOSE, `The first Escape must only close the menu, calls: ${p.calls.join()}`)
    p.escape()
    await until(() => p.openModals() === '', 'the modal to close')
    check(p.calls.join() === CLOSE, `The second Escape must only close the modal, calls: ${p.calls.join()}`)
  })
  return results
}
