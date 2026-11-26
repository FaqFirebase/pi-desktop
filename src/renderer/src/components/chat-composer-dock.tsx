import type { ReactNode, RefObject } from 'react'
import { ChatInput } from './chat-input'

const CENTERED_FRAME_CLASS = 'flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-10'
const FLOATING_FRAME_CLASS = 'pointer-events-none absolute inset-x-0 bottom-0 z-10 pb-3 pt-8 bg-gradient-to-t from-chat-column via-chat-column/80 to-transparent'

export interface ChatComposerDockProps {
  /** An empty chat centers the composer; a chat with messages floats it at the bottom. */
  centered: boolean
  dropZoneRef: RefObject<HTMLElement | null>
  /** Gets the floating frame, to measure it; the centered frame is never passed. */
  floatingRef?: (element: HTMLElement | null) => void
  /** Content above the composer in the current layout. */
  lead?: ReactNode
  /** Content below the composer in the current layout. */
  trail?: ReactNode
}

/**
 * The chat composer in both layouts. The frame changes, but the composer
 * keeps one place in the tree, so it stays the same instance when the first
 * prompt of an empty chat switches the layout, and that send can clear it.
 */
export function ChatComposerDock({ centered, dropZoneRef, floatingRef, lead, trail }: ChatComposerDockProps): React.JSX.Element {
  return (
    <div ref={centered ? undefined : floatingRef} className={centered ? CENTERED_FRAME_CLASS : FLOATING_FRAME_CLASS}>
      {lead}
      <ChatInput dropZoneRef={dropZoneRef} />
      {trail}
    </div>
  )
}
