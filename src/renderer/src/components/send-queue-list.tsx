import { useTranslation } from 'react-i18next'
import { ListOrdered, Paperclip, Pencil, SendHorizontal, X } from 'lucide-react'
import type { QueuedPrompt } from '../send-queue'

interface SendQueueListProps {
  prompts: readonly QueuedPrompt[]
  /** The queue waits for the user (the last turn was stopped, refused or failed). */
  held: boolean
  onSendNow: (prompt: QueuedPrompt) => void
  onEdit: (prompt: QueuedPrompt) => void
  onRemove: (prompt: QueuedPrompt) => void
}

/** Messages sent while the agent works, at the top of the composer, oldest first. */
export function SendQueueList({ prompts, held, onSendNow, onEdit, onRemove }: SendQueueListProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (prompts.length === 0) return null
  return (
    <div className="border-b border-border px-3 pb-2 pt-2" role="region" aria-label={t('chat.sendQueue.title')}>
      <div className="mb-1 flex items-center gap-1.5 text-xs text-dim">
        <ListOrdered size={12} className="shrink-0" />
        <span>{t('chat.sendQueue.count', { count: prompts.length })}</span>
        <span className="text-faint">·</span>
        <span className="min-w-0 truncate text-faint">{held ? t('chat.sendQueue.held') : t('chat.sendQueue.next')}</span>
      </div>
      <ul className="max-h-28 space-y-1 overflow-y-auto">
        {prompts.map((prompt) => (
          <li key={prompt.id} className="group flex min-w-0 items-center gap-2 rounded-md bg-card px-2 py-1 text-xs text-secondary">
            <span className="min-w-0 flex-1 truncate" title={prompt.text}>{prompt.text}</span>
            {prompt.attachments.length > 0 && (
              <span className="flex shrink-0 items-center gap-0.5 text-faint" title={t('chat.sendQueue.files', { count: prompt.attachments.length })}>
                <Paperclip size={11} />
                {prompt.attachments.length}
              </span>
            )}
            <button
              type="button"
              onClick={() => onSendNow(prompt)}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-accent-fg transition-colors hover:bg-highlight-strong"
              title={t('chat.sendQueue.sendNowHint')}
            >
              <SendHorizontal size={12} />
              {t('chat.sendQueue.sendNow')}
            </button>
            <button
              type="button"
              onClick={() => onEdit(prompt)}
              className="shrink-0 rounded p-0.5 text-dim transition-colors hover:bg-highlight-strong hover:text-secondary"
              aria-label={t('chat.sendQueue.edit')}
              title={t('chat.sendQueue.edit')}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              onClick={() => onRemove(prompt)}
              className="shrink-0 rounded p-0.5 text-dim transition-colors hover:bg-highlight-strong hover:text-secondary"
              aria-label={t('common.remove')}
              title={t('common.remove')}
            >
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
