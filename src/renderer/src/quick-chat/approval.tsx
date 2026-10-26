import { useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { t } from '../../../shared/i18n'
import type { PiExtensionUiRequest } from '../../../shared/ipc-contracts'
import type { QuickChatController } from './controller'

export function Approval({
  request,
  answering,
  controller,
}: {
  request: PiExtensionUiRequest
  answering: boolean
  controller: QuickChatController
}): React.JSX.Element {
  const [value, setValue] = useState(request.prefill ?? '')
  const input = useRef<HTMLTextAreaElement | HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])

  return (
    <section
      className="mx-3 my-2 p-3.5 rounded-xl border border-warning/40 bg-surface shadow-xl flex flex-col gap-2.5 animate-fade-in shrink-0"
      aria-label={t('quickChat.needsApproval')}
    >
      <div className="flex items-center gap-2 text-warning font-semibold text-xs">
        <ShieldAlert size={15} className="shrink-0" />
        <h2>{request.title || t('quickChat.needsApproval')}</h2>
      </div>
      {(request.message || request.instructions) && (
        <div className="max-h-44 overflow-y-auto -mr-1 pr-1 space-y-2">
          {request.message && (
            <p className="text-xs text-primary whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]">
              {request.message}
            </p>
          )}
          {request.instructions && (
            <p className="text-[11px] text-muted leading-normal">{request.instructions}</p>
          )}
        </div>
      )}

      {request.method === 'select' ? (
        <div className="flex flex-wrap gap-1.5 my-1">
          {request.options?.map((option, index) => (
            <button
              disabled={answering}
              key={`${index}:${option}`}
              onClick={() => {
                void controller.answer({ value: option })
              }}
              className="px-2.5 py-1 rounded-md text-xs border border-border bg-card hover:bg-surface-hover text-primary transition-colors disabled:opacity-50"
            >
              {option}
            </button>
          ))}
        </div>
      ) : request.method === 'input' ? (
        <input
          ref={(element) => {
            input.current = element
          }}
          value={value}
          placeholder={request.placeholder}
          disabled={answering}
          aria-label={request.title || t('quickChat.answer')}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault()
              void controller.answer({ value })
            }
          }}
          className="w-full px-2.5 py-1.5 rounded-md border border-border-strong bg-card text-xs text-primary focus:border-focus outline-none"
        />
      ) : request.method === 'editor' ? (
        <textarea
          ref={(element) => {
            input.current = element
          }}
          rows={4}
          value={value}
          placeholder={request.placeholder}
          disabled={answering}
          aria-label={request.title || t('quickChat.answer')}
          onChange={(event) => setValue(event.target.value)}
          className="w-full px-2.5 py-1.5 rounded-md border border-border-strong bg-card text-xs text-primary focus:border-focus outline-none resize-y"
        />
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1 border-t border-border/40">
        <button
          disabled={answering}
          onClick={() => {
            void controller.cancelRequest()
          }}
          className="px-3 py-1 rounded-md text-xs border border-border bg-card hover:bg-surface-hover text-secondary transition-colors disabled:opacity-50"
        >
          {request.method === 'confirm' ? t('quickChat.deny') : t('quickChat.cancel')}
        </button>
        {request.method === 'confirm' && (
          <button
            disabled={answering}
            onClick={() => {
              void controller.answer({ confirmed: true })
            }}
            className="px-3 py-1 rounded-md text-xs bg-accent hover:bg-accent-hover text-white font-medium shadow-xs transition-colors disabled:opacity-50"
          >
            {t('quickChat.allow')}
          </button>
        )}
        {(request.method === 'input' || request.method === 'editor') && (
          <button
            disabled={answering}
            onClick={() => {
              void controller.answer({ value })
            }}
            className="px-3 py-1 rounded-md text-xs bg-accent hover:bg-accent-hover text-white font-medium shadow-xs transition-colors disabled:opacity-50"
          >
            {t('quickChat.answer')}
          </button>
        )}
      </div>
      <p className="text-[10px] text-muted text-right">{t('quickChat.escapeDoesNotDeny')}</p>
    </section>
  )
}
