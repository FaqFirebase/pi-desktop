import type { RendererErrorKind, RendererErrorRecord } from '../../../shared/ipc-contracts'
import { PI_DESKTOP_PRODUCT_NAME } from '../../../shared/product-name'

export interface RendererErrorContext {
  view: string | null
  sessionId: string | null
}

export interface RendererErrorOptions {
  componentStack?: string | null
  unhandled: boolean
}

type RendererErrorSender = (record: RendererErrorRecord) => Promise<void>

/** The name given to a thrown value that is not an Error. */
export const UNKNOWN_ERROR_NAME = 'Error'
/** Browser notices that are not app errors (a layout settling across frames). */
export const BENIGN_WINDOW_ERROR_PREFIXES = ['ResizeObserver loop'] as const
const NO_VIEW_LABEL = 'none'
const COMPONENT_STACK_HEADING = 'Component stack:'
const LEADING_NEWLINES = /^\n+/

const EMPTY_CONTEXT: RendererErrorContext = { view: null, sessionId: null }
let contextSource: () => RendererErrorContext = () => EMPTY_CONTEXT
let sender: RendererErrorSender | null = null

/** The main app registers its store here; Quick Chat keeps the empty context. */
export function setRendererErrorContextSource(source: () => RendererErrorContext): void {
  contextSource = source
}

/** The view and session at this moment, for a record or the copied crash details. */
export function currentRendererErrorContext(): RendererErrorContext {
  return contextSource()
}

/** The window's bridge to main: each window has its own preload. */
export function setRendererErrorSender(send: RendererErrorSender): void {
  sender = send
}

function describeThrownValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export function errorFields(value: unknown): { name: string; message: string; stack: string | null } {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack ?? null }
  if (typeof value === 'string') return { name: UNKNOWN_ERROR_NAME, message: value, stack: null }
  return { name: UNKNOWN_ERROR_NAME, message: describeThrownValue(value), stack: null }
}

export function buildRendererErrorRecord(
  kind: RendererErrorKind,
  error: unknown,
  options: RendererErrorOptions,
  context: RendererErrorContext,
): RendererErrorRecord {
  return {
    kind,
    ...errorFields(error),
    componentStack: options.componentStack ?? null,
    view: context.view,
    sessionId: context.sessionId,
    unhandled: options.unhandled,
  }
}

/** Send one record to the app log. A failed send is dropped: reporting must never raise a new error. */
export function reportRendererError(kind: RendererErrorKind, error: unknown, options: RendererErrorOptions): void {
  const send = sender
  if (!send) return
  const record = buildRendererErrorRecord(kind, error, options, currentRendererErrorContext())
  void Promise.resolve()
    .then(() => send(record))
    .catch(() => undefined)
}

function isBenignWindowError(event: ErrorEvent): boolean {
  return event.error == null && BENIGN_WINDOW_ERROR_PREFIXES.some((prefix) => event.message.startsWith(prefix))
}

export function installRendererErrorForwarding(target: Pick<Window, 'addEventListener'>, report: typeof reportRendererError): void {
  target.addEventListener('error', (event: ErrorEvent) => {
    if (isBenignWindowError(event)) return
    report('window-error', event.error ?? event.message, { unhandled: true })
  })
  target.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    report('unhandled-rejection', event.reason, { unhandled: true })
  })
}

/** Plain English text for "Copy details": version, view, the error, then the component stack. */
export function formatCrashDetails(input: {
  error: unknown
  componentStack: string | null
  appVersion: string
  view: string | null
}): string {
  const { name, message, stack } = errorFields(input.error)
  const lines = [
    `${PI_DESKTOP_PRODUCT_NAME} ${input.appVersion}`,
    `View: ${input.view ?? NO_VIEW_LABEL}`,
    // A V8 stack already starts with "<name>: <message>".
    stack ?? `${name}: ${message}`,
  ]
  if (input.componentStack) lines.push(COMPONENT_STACK_HEADING, input.componentStack.replace(LEADING_NEWLINES, ''))
  return lines.join('\n')
}
