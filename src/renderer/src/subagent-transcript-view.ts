import {
  appendCapped,
  OMP_TRANSCRIPT_POLL_MS,
  PI_INSPECT_POLL_MS,
  type SubagentInspectLine,
  type SubagentTaskStatus,
  type SubagentTranscriptRef,
  type SubagentTranscriptResult,
} from '../../shared/subagent-task'
import { parseAgentMessage, type DisplayMessage } from './message-parsing'

/**
 * What the Tasks panel's transcript view shows. `progress`: a foreground Pi
 * run whose session file is not known until it ends.
 */
export type TranscriptView =
  | { kind: 'loading' }
  | { kind: 'progress' }
  | { kind: 'unavailable' }
  | { kind: 'messages'; messages: DisplayMessage[]; refreshFailed: boolean }
  | { kind: 'lines'; lines: SubagentInspectLine[]; finalOutput?: string; refreshFailed: boolean }

export interface TranscriptState {
  view: TranscriptView
  /** OMP byte offset of the next read. */
  cursor: number
}

export function initialTranscriptState(ref: SubagentTranscriptRef, running: boolean): TranscriptState {
  if (ref.kind === 'none') return { view: { kind: 'unavailable' }, cursor: 0 }
  // A foreground run's file is known only once it ends; ended without one, there is nothing to show.
  if (ref.kind === 'pi-foreground' && !ref.sessionFile) return { view: { kind: running ? 'progress' : 'unavailable' }, cursor: 0 }
  return { view: { kind: 'loading' }, cursor: 0 }
}

export function reduceTranscript(state: TranscriptState, result: SubagentTranscriptResult, running: boolean): TranscriptState {
  switch (result.kind) {
    case 'messages': {
      const page = result.messages
        .map(parseAgentMessage)
        .filter((message): message is DisplayMessage => message !== null)
      const previous = state.view.kind === 'messages' && !result.reset ? state.view.messages : []
      return { cursor: result.nextCursor, view: { kind: 'messages', messages: appendCapped(previous, page), refreshFailed: false } }
    }
    case 'lines':
      return {
        cursor: state.cursor,
        view: {
          kind: 'lines',
          lines: result.lines,
          ...(result.finalOutput !== undefined ? { finalOutput: result.finalOutput } : {}),
          refreshFailed: false,
        },
      }
    case 'error': {
      if (state.view.kind === 'messages' || state.view.kind === 'lines') {
        return { ...state, view: { ...state.view, refreshFailed: true } }
      }
      const gone = result.code === 'unavailable' || result.code === 'not-found' || !running
      return gone ? { ...state, view: { kind: 'unavailable' } } : state
    }
  }
}

/**
 * The status an inspect reply sets on its row, or null. For a step child the
 * extension reports the whole run's state, so only a run-level row (a launch
 * row with no child id) takes it.
 */
export function transcriptStatusUpdate(ref: SubagentTranscriptRef, result: SubagentTranscriptResult): SubagentTaskStatus | null {
  if (result.kind !== 'lines' || !result.status) return null
  return ref.kind === 'pi-async' && ref.childId === undefined ? result.status : null
}

/**
 * Fetches allowed after a background Pi row stops running. pi-subagents writes
 * the final output a moment after the row turns done, so one last fetch can
 * come too early.
 */
export const MAX_FETCHES_AFTER_END = 3

/** Delay before the next fetch, or null when no further fetch is needed. */
export function transcriptPollMs(
  ref: SubagentTranscriptRef,
  running: boolean,
  view: TranscriptView,
  fetchesAfterEnd: number
): number | null {
  if (running) {
    if (ref.kind === 'omp') return OMP_TRANSCRIPT_POLL_MS
    if (ref.kind === 'pi-async') return PI_INSPECT_POLL_MS
    return null
  }
  const awaitingFinalOutput = ref.kind === 'pi-async' && view.kind === 'lines' && view.finalOutput === undefined
  return awaitingFinalOutput && fetchesAfterEnd < MAX_FETCHES_AFTER_END ? PI_INSPECT_POLL_MS : null
}
