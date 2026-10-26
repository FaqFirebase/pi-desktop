import { createContext } from 'react'

/** Alternate chat views share rendering, but never main-window editing/navigation actions. */
export const ReadOnlyChatContext = createContext<{
  showThinking: boolean
  singleDollarMath: boolean
  provider?: string
} | null>(null)
