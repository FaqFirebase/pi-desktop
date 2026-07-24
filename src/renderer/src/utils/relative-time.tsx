import { createContext, useContext } from 'react'
import { formatRelativeTime } from './format-relative-time'

export { formatRelativeTime }

/**
 * A single "now" value, refreshed on an interval by the chat panel, so all
 * relative-time labels tick together without each one owning a timer.
 */
export const NowContext = createContext<number>(Date.now())

/**
 * Renders a relative-time label that re-renders on each tick of `NowContext`.
 * Kept as a tiny leaf so the surrounding (heavier) message bubble does not
 * re-render every 30s — only these labels do.
 */
export function RelativeTime({ timestamp }: { timestamp: number }): React.JSX.Element {
  const now = useContext(NowContext)
  return <span>{formatRelativeTime(timestamp, now)}</span>
}
