import { randomUUID } from 'crypto'
import type { AgentEngineKind, PiResponseEvent, PiRpcEvent } from '../shared/ipc-contracts'
import {
  buildInspectCommand,
  MAX_TRANSCRIPT_MESSAGES,
  parseInspectReply,
  PI_INSPECT_COMMAND_NAME,
  PI_INSPECT_TIMEOUT_MS,
  PI_INSPECT_WIDGET_KEY,
  tasksFromOmpSubagents,
  type SubagentListResult,
  type SubagentTranscriptErrorCode,
  type SubagentTranscriptRef,
  type SubagentTranscriptResult,
} from '../shared/subagent-task'
import { trimMessagePayload } from './get-messages-trim'
import { isWithinSessionRoots } from './pi-paths'
import { readSessionEntries } from './session-jsonl'

/** A finished foreground subagent session larger than this is not loaded. */
const MAX_FOREGROUND_SESSION_BYTES = 8 * 1024 * 1024
/** Pi lists commands an extension registered under this source. */
const EXTENSION_COMMAND_SOURCE = 'extension'
/** pi-subagents inspect errors that say the run is not there (it may still appear). */
const INSPECT_NOT_FOUND_CODES: ReadonlySet<string> = new Set(['not_found', 'stale'])
/** pi-subagents inspect errors that will not change on a retry. */
const INSPECT_PERMANENT_CODES: ReadonlySet<string> = new Set(['invalid_request', 'foreign_session', 'no_active_session'])

function inspectErrorCode(code: string): SubagentTranscriptErrorCode {
  if (INSPECT_PERMANENT_CODES.has(code)) return 'unavailable'
  return INSPECT_NOT_FOUND_CODES.has(code) ? 'not-found' : 'failed'
}

/** The slice of PiRpcManager this module needs, so tests can pass a fake. */
export interface SubagentRpc {
  getEngineKind(): AgentEngineKind
  sendCommand(command: Record<string, unknown>): Promise<PiResponseEvent | null>
  on(event: 'event', listener: (event: PiRpcEvent) => void): unknown
  off(event: 'event', listener: (event: PiRpcEvent) => void): unknown
}

export interface TranscriptDeps {
  timeoutMs: number
  newRequestId: () => string
  readEntries: (filePath: string) => Promise<Record<string, unknown>[] | null>
  isReadablePath: (filePath: string) => boolean
}

const DEFAULT_DEPS: TranscriptDeps = {
  timeoutMs: PI_INSPECT_TIMEOUT_MS,
  newRequestId: randomUUID,
  readEntries: (filePath) => readSessionEntries(filePath, MAX_FOREGROUND_SESSION_BYTES),
  isReadablePath: isWithinSessionRoots,
}

const UNSUPPORTED: SubagentListResult = { supported: false, tasks: [] }

function failure(code: SubagentTranscriptErrorCode): SubagentTranscriptResult {
  return { kind: 'error', code }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Newest messages only, each trimmed, so one huge transcript cannot stall the renderer. */
function shipMessages(messages: unknown[]): unknown[] {
  return messages.slice(-MAX_TRANSCRIPT_MESSAGES).map(trimMessagePayload)
}

/** The slice of WorkspaceManager that picks the manager for a request. */
export interface RuntimeManagerSource<T> {
  getActivePiManager(): T | null
  runtimeIdFor(manager: T): string | null
}

/**
 * The active manager, but only while it still runs the session the renderer
 * asked about: a request that crosses a chat switch must not reach the new
 * chat's process.
 */
export function activeManagerForRuntime<T>(source: RuntimeManagerSource<T>, runtimeId: string): T | null {
  const manager = source.getActivePiManager()
  return manager && source.runtimeIdFor(manager) === runtimeId ? manager : null
}

/**
 * OMP's running subagents. Pi has no such command, and an OMP build without
 * it answers with an error: both report `supported: false`.
 */
export async function listSubagents(pi: SubagentRpc): Promise<SubagentListResult> {
  if (pi.getEngineKind() !== 'omp') return UNSUPPORTED
  const response = await pi.sendCommand({ type: 'get_subagents' }).catch(() => null)
  if (!response?.success) return UNSUPPORTED
  return { supported: true, tasks: tasksFromOmpSubagents(response.data) }
}

export async function fetchSubagentTranscript(
  pi: SubagentRpc,
  ref: SubagentTranscriptRef,
  cursor: number,
  deps: TranscriptDeps = DEFAULT_DEPS
): Promise<SubagentTranscriptResult> {
  switch (ref.kind) {
    case 'omp':
      return fetchOmpTranscript(pi, ref.subagentId, cursor)
    case 'pi-async':
      return fetchInspectTranscript(pi, ref, deps)
    case 'pi-foreground':
      return fetchForegroundTranscript(ref.sessionFile, deps)
    case 'none':
      return failure('unavailable')
  }
}

/** OMP tails the subagent's JSONL from `fromByte`, whole lines only. */
async function fetchOmpTranscript(pi: SubagentRpc, subagentId: string, cursor: number): Promise<SubagentTranscriptResult> {
  const response = await pi.sendCommand({ type: 'get_subagent_messages', subagentId, fromByte: cursor }).catch(() => null)
  if (!response?.success || !isRecord(response.data)) return failure('failed')
  const data = response.data
  return {
    kind: 'messages',
    messages: shipMessages(Array.isArray(data.messages) ? data.messages : []),
    nextCursor: typeof data.nextByte === 'number' ? data.nextByte : cursor,
    reset: data.reset === true,
  }
}

/**
 * Whether this Pi has the inspect command loaded. pi-subagents before 0.52
 * lacks it, and Pi sends an unhandled slash command to the model as a paid
 * user turn, so the command is never sent on a guess.
 */
async function hasInspectCommand(pi: SubagentRpc): Promise<boolean> {
  const response = await pi.sendCommand({ type: 'get_commands' }).catch(() => null)
  const data = response?.success && isRecord(response.data) ? response.data : undefined
  const commands: unknown[] = Array.isArray(data?.commands) ? data.commands : []
  return commands.some((command) =>
    isRecord(command) && command.name === PI_INSPECT_COMMAND_NAME && command.source === EXTENSION_COMMAND_SOURCE
  )
}

/**
 * pi-subagents answers its inspect command with a `subagent-inspect` widget
 * line carrying the request id. The listener is attached before the command is
 * sent, because the widget can arrive before the command's response.
 */
async function fetchInspectTranscript(
  pi: SubagentRpc,
  ref: { asyncId: string; childId?: string },
  deps: TranscriptDeps
): Promise<SubagentTranscriptResult> {
  const requestId = deps.newRequestId()
  const command = buildInspectCommand(requestId, ref)
  if (!command || !(await hasInspectCommand(pi))) return failure('unavailable')

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: SubagentTranscriptResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pi.off('event', onEvent)
      resolve(result)
    }
    const onEvent = (event: PiRpcEvent): void => {
      if (event.type !== 'extension_ui_request' || event.method !== 'setWidget' || event.widgetKey !== PI_INSPECT_WIDGET_KEY) return
      const reply = parseInspectReply(event.widgetLines)
      if (!reply || reply.requestId !== requestId) return
      if (reply.errorCode) {
        finish(failure(inspectErrorCode(reply.errorCode)))
        return
      }
      finish({
        kind: 'lines',
        lines: reply.lines,
        ...(reply.finalOutput !== undefined ? { finalOutput: reply.finalOutput } : {}),
        ...(reply.status !== undefined ? { status: reply.status } : {}),
      })
    }
    const timer = setTimeout(() => finish(failure('timeout')), deps.timeoutMs)
    pi.on('event', onEvent)
    // A refused prompt sends no widget, so it fails now instead of at the timeout.
    pi.sendCommand({ type: 'prompt', message: command }).then(
      (response) => {
        if (response && !response.success) finish(failure('failed'))
      },
      () => finish(failure('failed'))
    )
  })
}

/** A finished foreground run's own session file, read only inside the session roots. */
async function fetchForegroundTranscript(sessionFile: string | undefined, deps: TranscriptDeps): Promise<SubagentTranscriptResult> {
  if (!sessionFile || !deps.isReadablePath(sessionFile)) return failure('unavailable')
  const entries = await deps.readEntries(sessionFile)
  if (!entries) return failure('unavailable')
  const messages = entries
    .filter((entry) => entry.type === 'message' && isRecord(entry.message))
    .map((entry) => entry.message)
  return { kind: 'messages', messages: shipMessages(messages), nextCursor: 0, reset: true }
}
