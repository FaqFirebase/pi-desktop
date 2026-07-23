import { useEffect, useRef } from 'react'
import { MarkdownRenderer } from './markdown-renderer'
import { toolLabel } from '../message-grouping'
import { toolCallIconFor } from './tool-call-icon'
import { useAppStore } from '../store'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { Brain, Bot, Loader2 } from 'lucide-react'
import { clsx } from 'clsx'

interface StreamingBubbleProps {
  content: string
  thinking: string
  toolCalls: Map<
    string,
    {
      name: string
      args: string
      result?: string
      isExecuting: boolean
      isError?: boolean
      startedAt?: number
      durationMs?: number
    }
  >
}

export function StreamingBubble({ content, thinking, toolCalls }: StreamingBubbleProps): React.JSX.Element {
  const thinkingEnabled = useAppStore(
    (state) => state.settingsDraft.showThinking ?? state.settings?.showThinking ?? DEFAULT_SETTINGS.showThinking
  )
  const thinkingScrollRef = useRef<HTMLDivElement>(null)

  // Keep the live thinking tail in view as tokens arrive.
  useEffect(() => {
    const el = thinkingScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [thinking])

  return (
    <div className="mb-4 animate-fade-in">
      <div className="flex items-start gap-3">
        {/* Avatar with pulse */}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-bg">
          <Bot size={14} className="text-accent-fg animate-pulse" />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Thinking — match finalized bubble chrome; scrollable full text
              (no jumbled last-N-char preview). Collapsed finalize still uses
              the Thinking dropdown; live stream always shows the tail. */}
          {thinking && thinkingEnabled && (
            <div className="thinking-hover mb-2 min-w-0">
              <div className="flex h-7 items-center gap-1.5 text-sm text-dim">
                <Brain size={12} className="shrink-0" />
                <Loader2 size={12} className="shrink-0 animate-spin text-special" />
                <span>Thinking</span>
              </div>
              <div
                ref={thinkingScrollRef}
                className="max-h-36 min-w-0 overflow-x-hidden overflow-y-auto"
              >
                <div className="markdown-body font-sans italic text-sm text-muted break-words [overflow-wrap:anywhere] whitespace-pre-wrap">
                  {thinking}
                </div>
              </div>
            </div>
          )}

          {/* Tool calls */}
          {toolCalls.size > 0 && (
            <div className="mb-2 space-y-1">
              {Array.from(toolCalls.entries()).map(([id, tc]) => {
                // Mirror the operation icon (matching the finalized bubble); the
                // spinner takes over while the call is executing.
                const Icon = toolCallIconFor(tc.name)
                return (
                  <div
                    key={id}
                    className={clsx(
                      'flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                      tc.isExecuting
                        ? 'border-warning-bg bg-warning-bg text-warning'
                        : tc.isError
                          ? 'border-error-bg bg-surface/50 text-muted'
                          : 'border-border bg-surface/50 text-muted'
                    )}
                  >
                    {tc.isExecuting ? (
                      <Loader2 size={12} className="shrink-0 animate-spin" />
                    ) : (
                      <Icon size={12} className="shrink-0" />
                    )}
                    <span className="min-w-0 truncate font-jetbrains">{toolLabel(tc.name)}</span>
                    <span
                      className={clsx(
                        'ml-auto shrink-0 text-xs capitalize',
                        tc.isExecuting && 'text-warning animate-pulse',
                        !tc.isExecuting && tc.isError && 'text-error',
                        !tc.isExecuting && !tc.isError && 'text-success'
                      )}
                    >
                      {tc.isExecuting ? 'running' : tc.isError ? 'error' : 'done'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Streaming text */}
          {content && (
            <div className="markdown-body min-w-0 text-sm break-words [overflow-wrap:anywhere]">
              <MarkdownRenderer content={content} />
              <span className="inline-block w-1.5 h-4 bg-accent animate-pulse ml-0.5 align-text-bottom" />
            </div>
          )}

          {/* Empty state while waiting — sized like the Thinking header and
              vertically centered against the avatar (h-7). */}
          {!content && !thinking && toolCalls.size === 0 && (
            <div className="flex h-7 items-center gap-2 text-sm text-dim">
              <Loader2 size={12} className="animate-spin" />
              Waiting for response...
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
