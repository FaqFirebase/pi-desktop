/**
 * Without a sign of life, a model provider that stops sending looks the same
 * as a model that thinks for a long time. A running turn whose agent sent no
 * event for this long is reported as stalled, so the user can stop it.
 */
export const STALL_AFTER_MS = 30_000

export interface TurnActivityInput {
  now: number
  /** When the turn started (or when this window attached to it). */
  startedAt: number
  /** When the agent last sent any event. */
  lastEventAt: number
  /** A tool is executing: a long command sends no events while it works. */
  toolRunning: boolean
}

export interface TurnActivity {
  elapsedMs: number
  silentMs: number
  stalled: boolean
}

export function turnActivity({ now, startedAt, lastEventAt, toolRunning }: TurnActivityInput): TurnActivity {
  const elapsedMs = Math.max(0, now - startedAt)
  const silentMs = Math.max(0, now - lastEventAt)
  return { elapsedMs, silentMs, stalled: !toolRunning && silentMs >= STALL_AFTER_MS }
}
