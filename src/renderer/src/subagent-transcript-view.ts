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
  /** A permanent failure was reported: polling stops, the shown content stays. */
  settled: boolean
}

function initialView(ref: SubagentTranscriptRef, running: boolean): TranscriptView {
  if (ref.kind === 'none') return { kind: 'unavailable' }
  // A foreground run's file is known only once it ends; ended without one, there is nothing to show.
  if (ref.kind === 'pi-foreground' && !ref.sessionFile) return { kind: running ? 'progress' : 'unavailable' }
  return { kind: 'loading' }
}

export function initialTranscriptState(ref: SubagentTranscriptRef, running: boolean): TranscriptState {
  return { view: initialView(ref, running), cursor: 0, settled: false }
}

/**
 * Whether the transcript is fetched at all: the row must have a source, and
 * the chat must be on screen (the panel stays mounted behind other views).
 * Decided from the row alone, so a mid-run failure never blocks the final fetch.
 */
export function transcriptFetchAllowed(ref: SubagentTranscriptRef, running: boolean, chatVisible: boolean): boolean {
  return chatVisible && initialView(ref, running).kind === 'loading'
}

function sameInspectLines(a: readonly SubagentInspectLine[], b: readonly SubagentInspectLine[]): boolean {
  return a.length === b.length && a.every((line, index) => {
    const other = b[index]
    return line.role === other.role && line.kind === other.kind && line.text === other.text &&
      line.name === other.name && line.isError === other.isError
  })
}

export function reduceTranscript(state: TranscriptState, result: SubagentTranscriptResult, running: boolean): TranscriptState {
  switch (result.kind) {
    case 'messages': {
      const page = result.messages
        .map(parseAgentMessage)
        .filter((message): message is DisplayMessage => message !== null)
      // Nothing new: keep the same view object, so the transcript does not render again.
      if (page.length === 0 && !result.reset && state.view.kind === 'messages' && !state.view.refreshFailed) {
        return result.nextCursor === state.cursor ? state : { ...state, cursor: result.nextCursor }
      }
      const previous = state.view.kind === 'messages' && !result.reset ? state.view.messages : []
      return { ...state, cursor: result.nextCursor, view: { kind: 'messages', messages: appendCapped(previous, page), refreshFailed: false } }
    }
    case 'lines':
      if (
        state.view.kind === 'lines' && !state.view.refreshFailed &&
        state.view.finalOutput === result.finalOutput && sameInspectLines(state.view.lines, result.lines)
      ) {
        return state
      }
      return {
        ...state,
        view: {
          kind: 'lines',
          lines: result.lines,
          ...(result.finalOutput !== undefined ? { finalOutput: result.finalOutput } : {}),
          refreshFailed: false,
        },
      }
    case 'error': {
      // `unavailable` is permanent (no source, no inspect command, a refused request).
      const settled = state.settled || result.code === 'unavailable'
      if (state.view.kind === 'messages' || state.view.kind === 'lines') {
        return { ...state, settled, view: { ...state.view, refreshFailed: true } }
      }
      const gone = result.code === 'unavailable' || result.code === 'not-found' || !running
      return gone ? { ...state, settled, view: { kind: 'unavailable' } } : { ...state, settled }
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
  state: TranscriptState,
  fetchesAfterEnd: number
): number | null {
  if (state.settled) return null
  const view = state.view
  if (running) {
    if (ref.kind === 'omp') return OMP_TRANSCRIPT_POLL_MS
    if (ref.kind === 'pi-async') return PI_INSPECT_POLL_MS
    return null
  }
  const awaitingFinalOutput = ref.kind === 'pi-async' && view.kind === 'lines' && view.finalOutput === undefined
  return awaitingFinalOutput && fetchesAfterEnd < MAX_FETCHES_AFTER_END ? PI_INSPECT_POLL_MS : null
}
