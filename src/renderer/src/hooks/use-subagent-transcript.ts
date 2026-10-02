import { useEffect, useRef, useState } from 'react'
import type { SubagentTask, SubagentTranscriptResult } from '../../../shared/subagent-task'
import { useAppStore } from '../store'
import { useChatVisible } from '../hooks'
import {
  initialTranscriptState,
  reduceTranscript,
  transcriptFetchAllowed,
  transcriptPollMs,
  transcriptStatusUpdate,
  type TranscriptState,
  type TranscriptView,
} from '../subagent-transcript-view'

const FAILED_FETCH: SubagentTranscriptResult = { kind: 'error', code: 'failed' }
const UNAVAILABLE_FETCH: SubagentTranscriptResult = { kind: 'error', code: 'unavailable' }

/**
 * Fetch a subagent's transcript and keep it live while the subagent runs and
 * the chat is on screen.
 * One request at a time (setTimeout after each reply, never setInterval), and
 * a reply that lands after the row changed or the view closed is dropped.
 * When the row stops running the effect runs once more for the final fetch,
 * plus a few retries while a background Pi run's final output is not written yet.
 */
export function useSubagentTranscript(task: SubagentTask): TranscriptView {
  const refKey = JSON.stringify(task.transcriptRef)
  const running = task.status === 'running'
  const chatVisible = useChatVisible()
  const stateRef = useRef<{ key: string; state: TranscriptState }>({ key: '', state: initialTranscriptState(task.transcriptRef, running) })
  const [view, setView] = useState<TranscriptView>(stateRef.current.state.view)

  useEffect(() => {
    const key = `${task.id}|${refKey}`
    // A foreground run that ended without a file leaves its progress card.
    const progressEnded = stateRef.current.state.view.kind === 'progress' && !running
    if (stateRef.current.key !== key || progressEnded) {
      stateRef.current = { key, state: initialTranscriptState(task.transcriptRef, running) }
      setView(stateRef.current.state.view)
    }
    if (!transcriptFetchAllowed(task.transcriptRef, running, chatVisible)) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let fetchesAfterEnd = 0
    const ref = task.transcriptRef
    const tick = async (): Promise<void> => {
      let result: SubagentTranscriptResult
      try {
        const runtimeId = useAppStore.getState().activeSessionRuntimeId
        result = runtimeId
          ? await window.piDesktop.subagents.getTranscript(runtimeId, ref, stateRef.current.state.cursor)
          : UNAVAILABLE_FETCH
      } catch {
        result = FAILED_FETCH
      }
      if (cancelled) return
      stateRef.current.state = reduceTranscript(stateRef.current.state, result, running)
      setView(stateRef.current.state.view)
      // A background Pi launch row with no widget learns its end from the inspect reply.
      const status = transcriptStatusUpdate(ref, result)
      if (status && status !== task.status) useAppStore.getState().setSubagentTaskStatus(task.id, status)
      if (!running) fetchesAfterEnd += 1
      const delay = transcriptPollMs(ref, running, stateRef.current.state, fetchesAfterEnd)
      if (delay !== null && !cancelled) timer = setTimeout(() => void tick(), delay)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // task.transcriptRef is covered by refKey; task.status by running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, refKey, running, chatVisible])

  return view
}
