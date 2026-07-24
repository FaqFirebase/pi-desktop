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

  // Follow the thinking tail only when the user is already at/near the bottom,
  // so scrolling up mid-stream to re-read is not yanked back down.
  useEffect(() => {
    const el = thinkingScrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
    if (distanceFromBottom <= 48) {
      el.scrollTop = el.scrollHeight
    }
  }, [thinking])

  return (
    <div className="mb-4 animate-fade-in">
      <div className="flex items-start gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-bg">
          <Bot size={14} className="text-accent-fg animate-pulse" />
        </div>

        <div className="min-w-0 flex-1">
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

          {toolCalls.size > 0 && (
            <div className="mb-2 space-y-1">
              {Array.from(toolCalls.entries()).map(([id, tc]) => {
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

          {content && (
            // streaming-md places the caret ::after the last markdown block so it
            // sits at the end of the current chunk (not on a line below it).
            <div className="markdown-body streaming-md min-w-0 text-sm break-words [overflow-wrap:anywhere]">
              <MarkdownRenderer content={content} />
            </div>
          )}

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
