import type { RendererErrorKind, RendererErrorRecord } from '../shared/ipc-contracts'
import type { AppLog } from './app-log'

export const RENDERER_LOG_SCOPE = 'renderer'
/** Records accepted per window; a render loop past it is counted, not written. */
export const RENDERER_ERROR_LIMIT = 20
export const RENDERER_ERROR_WINDOW_MS = 60_000
/** Cap for name, message, view and sessionId. */
export const MAX_RENDERER_TEXT_CHARS = 2_000
/** Cap for stack and componentStack. */
export const MAX_RENDERER_STACK_CHARS = 16_000

const RENDERER_ERROR_KINDS: readonly RendererErrorKind[] = ['window-error', 'unhandled-rejection', 'render-error']

function isRendererErrorKind(value: unknown): value is RendererErrorKind {
  return RENDERER_ERROR_KINDS.includes(value as RendererErrorKind)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function capNullable(value: string | null, maxChars: number): string | null {
  return value === null ? null : value.slice(0, maxChars)
}

/** A record from the renderer, checked field by field; null when any field has the wrong type. */
export function parseRendererErrorRecord(value: unknown): RendererErrorRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const input = value as Record<string, unknown>
  const { kind, name, message, stack, componentStack, view, sessionId, unhandled } = input
  if (
    !isRendererErrorKind(kind) ||
    typeof name !== 'string' ||
    typeof message !== 'string' ||
    !isNullableString(stack) ||
    !isNullableString(componentStack) ||
    !isNullableString(view) ||
    !isNullableString(sessionId) ||
    typeof unhandled !== 'boolean'
  ) return null
  return {
    kind,
    name: name.slice(0, MAX_RENDERER_TEXT_CHARS),
    message: message.slice(0, MAX_RENDERER_TEXT_CHARS),
    stack: capNullable(stack, MAX_RENDERER_STACK_CHARS),
    componentStack: capNullable(componentStack, MAX_RENDERER_STACK_CHARS),
    view: capNullable(view, MAX_RENDERER_TEXT_CHARS),
    sessionId: capNullable(sessionId, MAX_RENDERER_TEXT_CHARS),
    unhandled,
  }
}

/** Writes renderer error records to the app log, at most RENDERER_ERROR_LIMIT per fixed window. */
export class RendererErrorLog {
  private readonly log: Pick<AppLog, 'error' | 'warn'>
  private readonly now: () => number
  private windowStart: number | null = null
  private acceptedInWindow = 0
  private droppedInWindow = 0

  constructor(deps: { log: Pick<AppLog, 'error' | 'warn'>; now?: () => number }) {
    this.log = deps.log
    this.now = deps.now ?? Date.now
  }

  /** False when the record is malformed or over the rate limit. */
  record(value: unknown): boolean {
    const record = parseRendererErrorRecord(value)
    if (!record) return false
    const now = this.now()
    if (this.windowStart === null || now - this.windowStart >= RENDERER_ERROR_WINDOW_MS) this.startWindow(now)
    if (this.acceptedInWindow >= RENDERER_ERROR_LIMIT) {
      this.droppedInWindow++
      return false
    }
    this.acceptedInWindow++
    const { kind, name, message, stack, componentStack, view, sessionId, unhandled } = record
    this.log.error(RENDERER_LOG_SCOPE, `${name}: ${message}`, { kind, stack, componentStack, view, sessionId, unhandled })
    return true
  }

  private startWindow(now: number): void {
    if (this.droppedInWindow > 0) {
      this.log.warn(RENDERER_LOG_SCOPE, `Dropped ${this.droppedInWindow} renderer errors over the rate limit`)
    }
    this.windowStart = now
    this.acceptedInWindow = 0
    this.droppedInWindow = 0
  }
}
