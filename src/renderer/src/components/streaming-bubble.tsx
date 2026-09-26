import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownRenderer } from './markdown-renderer'
import { toolLabel, toolCallLabel, toolCallStatusLabel } from '../message-grouping'
import { splitClaudeCliMarkers } from '../claude-cli-markers'
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

export function StreamingBubble({ content: rawContent, thinking, toolCalls }: StreamingBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const { content, toolCalls: markerCalls } = useMemo(() => splitClaudeCliMarkers(rawContent), [rawContent])
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
                <span>{t('common.thinking')}</span>
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
                    <span className="min-w-0 truncate font-jetbrains">{toolLabel(tc.name, t)}</span>
                    <span
                      className={clsx(
                        'ml-auto shrink-0 text-xs capitalize',
                        tc.isExecuting && 'text-warning animate-pulse',
                        !tc.isExecuting && tc.isError && 'text-error',
                        !tc.isExecuting && !tc.isError && 'text-success'
                      )}
                    >
                      {toolCallStatusLabel(tc.isExecuting ? 'running' : tc.isError ? 'error' : 'done', t)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {markerCalls.length > 0 && (
            <div className="mb-2 space-y-1">
              {markerCalls.map((tc) => {
                const Icon = toolCallIconFor(tc.name)
                const status = tc.result === undefined ? null : tc.isError ? 'error' : 'done'
                return (
                  <div
                    key={tc.id}
                    className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm text-muted"
                  >
                    <Icon size={12} className="shrink-0" />
                    <span className="min-w-0 truncate font-jetbrains">{toolCallLabel(tc.name, tc.arguments, t)}</span>
                    {status && (
                      <span
                        className={clsx(
                          'ml-auto shrink-0 text-xs capitalize',
                          status === 'error' ? 'text-error' : 'text-success'
                        )}
                      >
                        {toolCallStatusLabel(status, t)}
                      </span>
                    )}
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

          {!content && !thinking && toolCalls.size === 0 && markerCalls.length === 0 && (
            <div className="flex h-7 items-center gap-2 text-sm text-dim">
              <Loader2 size={12} className="animate-spin" />
              {t('chat.waitingForResponse')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
