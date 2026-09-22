import { useAppStore } from '../store'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, AlertCircle, HelpCircle, EyeOff, Eye } from 'lucide-react'
import { clsx } from 'clsx'
import {
  DIALOG_TOGGLE_LABEL,
  isDialogToggleKey,
  splitPromptText,
} from './extension-ui-dialog-helpers'
import { isImeComposing } from '../utils/ime-composing'

// Stacking tiers for the two extension-UI surfaces, which can be on screen at
// the same time. The toast MUST outrank the dialog's full-screen backdrop: at
// an equal tier the backdrop paints over the toast, and the click aimed at the
// toast lands on the backdrop instead — cancelling the blocking prompt, which
// answers the asking tool with a permanent deny.
export const DIALOG_OVERLAY_Z_INDEX = 50
export const NOTIFY_TOAST_Z_INDEX = 60

// How long a notification stays up before it dismisses itself.
const NOTIFY_TOAST_TIMEOUT_MS = 5000

const KEY_LISTENER_OPTIONS: AddEventListenerOptions = { capture: true }

export function ExtensionUiDialog(): React.JSX.Element | null {
  const request = useAppStore((state) => state.extensionUiRequest)
  const notify = useAppStore((state) => state.extensionNotify)
  const respondExtensionUi = useAppStore((state) => state.respondExtensionUi)
  const dismissExtensionUi = useAppStore((state) => state.dismissExtensionUi)
  const dismissExtensionNotify = useAppStore((state) => state.dismissExtensionNotify)

  // Temporary hide (issue #61): the prompt stays unanswered in the store while
  // the user reads the chat behind it. Keyed by request id so a new prompt is
  // always shown, and a hidden one reappears via the pill, Escape/Alt+O, or
  // any click on the pill.
  const [hiddenRequestId, setHiddenRequestId] = useState<string | null>(null)
  const hidden = request !== null && hiddenRequestId === request.id
  const hide = (): void => setHiddenRequestId(request?.id ?? null)
  const show = (): void => setHiddenRequestId(null)

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent): void => {
      if (isImeComposing(e)) return
      if (isDialogToggleKey(e)) {
        e.preventDefault()
        setHiddenRequestId((current) => (current === request.id ? null : request.id))
      } else if (e.key === 'Escape' && hiddenRequestId !== request.id) {
        e.preventDefault()
        setHiddenRequestId(request.id)
      }
    }
    // Capture phase: the chat's own Escape handler (abort the turn) runs
    // later in the bubble phase and skips a press this handler consumed.
    window.addEventListener('keydown', onKey, KEY_LISTENER_OPTIONS)
    return () => window.removeEventListener('keydown', onKey, KEY_LISTENER_OPTIONS)
  }, [request, hiddenRequestId])

  // The toast lives in its own store slot so it can coexist with a blocking
  // dialog instead of clobbering it; dismissal only touches the toast slot.
  // Keyed by request id so a notification arriving mid-countdown remounts the
  // toast — otherwise it inherits the previous one's remaining time (and its
  // already-finished fade-in) and can vanish on arrival.
  const toast = notify ? (
    <NotifyToast key={notify.id} request={notify} onDismiss={dismissExtensionNotify} />
  ) : null

  // Dialog slot: the store routes only select/confirm/input/editor here. A
  // hidden prompt stays mounted (only its overlay is display:none) so text the
  // user already typed into an input or editor survives the hide.
  const dialog = ((): React.JSX.Element | null => {
    if (!request) return null
    const frame = { onCancel: dismissExtensionUi, onHide: hide, hidden }
    switch (request.method) {
      case 'select':
        return (
          <SelectDialog
            request={request}
            onSelect={(value) => respondExtensionUi(request.id, { value })}
            {...frame}
          />
        )
      case 'confirm':
        return (
          <ConfirmDialog
            request={request}
            onConfirm={() => respondExtensionUi(request.id, { confirmed: true })}
            onDeny={() => respondExtensionUi(request.id, { confirmed: false })}
            {...frame}
          />
        )
      case 'input':
        return (
          <InputDialog
            request={request}
            onSubmit={(value) => respondExtensionUi(request.id, { value })}
            {...frame}
          />
        )
      case 'editor':
        return (
          <EditorDialog
            request={request}
            onSubmit={(value) => respondExtensionUi(request.id, { value })}
            {...frame}
          />
        )
      default:
        return null
    }
  })()

  if (!toast && !dialog) return null

  return (
    <>
      {toast}
      {dialog}
      {hidden && <HiddenPromptPill onShow={show} />}
    </>
  )
}

// ─── Hidden Prompt Pill ──────────────────────────────────────────────────────

// Stand-in for a temporarily hidden prompt. Bottom-centre keeps it clear of
// the bottom-right notify toast.
function HiddenPromptPill({ onShow }: { onShow: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="fixed bottom-10 left-1/2 -translate-x-1/2 animate-fade-in"
      style={{ zIndex: DIALOG_OVERLAY_Z_INDEX }}
    >
      <button
        onClick={onShow}
        className="flex items-center gap-2 rounded-full border border-border-strong bg-surface px-4 py-2 text-sm text-primary shadow-lg hover:bg-surface-hover transition-colors"
      >
        <Eye size={14} className="text-accent-fg" />
        {t('chat.extensionUi.waitingForAnswer')}
        <span className="text-xs text-dim">{t('chat.extensionUi.showWithShortcut', { shortcut: DIALOG_TOGGLE_LABEL })}</span>
      </button>
    </div>
  )
}

// ─── Notify Toast ────────────────────────────────────────────────────────────

function NotifyToast({
  request,
  onDismiss,
}: {
  request: { id: string; message?: string; notifyType?: string }
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  useEffect(() => {
    const timer = setTimeout(onDismiss, NOTIFY_TOAST_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [onDismiss])

  const iconMap: Record<string, React.ReactNode> = {
    info: <AlertCircle size={16} className="text-accent-fg" />,
    warning: <AlertCircle size={16} className="text-warning" />,
    error: <AlertCircle size={16} className="text-error" />,
  }

  return (
    <div className="fixed bottom-10 right-4 animate-fade-in" style={{ zIndex: NOTIFY_TOAST_Z_INDEX }}>
      <div className="flex items-center gap-3 rounded-lg border border-border-strong bg-surface px-4 py-3 shadow-lg">
        {iconMap[request.notifyType ?? 'info'] ?? iconMap.info}
        <span className="text-sm text-primary">{request.message ?? t('chat.extensionUi.notificationFallback')}</span>
        <button onClick={onDismiss} className="ml-2 text-dim hover:text-secondary">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

// ─── Select Dialog ───────────────────────────────────────────────────────────

/** Cancel answers the prompt with a deny; hide keeps it pending off-screen. */
interface DialogFrameProps {
  onCancel: () => void
  onHide: () => void
  hidden: boolean
}

function SelectDialog({
  request,
  onSelect,
  onCancel,
  onHide,
  hidden,
}: DialogFrameProps & {
  request: { id: string; title?: string; options?: string[]; timeout?: number }
  onSelect: (value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <DialogOverlay hidden={hidden} onBackdropClick={onHide}>
      <DialogBox prompt={request.title ?? t('chat.extensionUi.selectFallbackTitle')} onCancel={onCancel} onHide={onHide}>
        <div className="space-y-1">
          {(request.options ?? []).map((option) => (
            <button
              key={option}
              onClick={() => onSelect(option)}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-primary hover:bg-elevated transition-colors"
            >
              <HelpCircle size={14} className="text-dim" />
              {option}
            </button>
          ))}
        </div>
      </DialogBox>
    </DialogOverlay>
  )
}

// ─── Confirm Dialog ──────────────────────────────────────────────────────────

function ConfirmDialog({
  request,
  onConfirm,
  onDeny,
  onCancel,
  onHide,
  hidden,
}: DialogFrameProps & {
  request: { id: string; title?: string; message?: string }
  onConfirm: () => void
  onDeny: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <DialogOverlay hidden={hidden} onBackdropClick={onHide}>
      <DialogBox prompt={request.title ?? t('common.confirm')} onCancel={onCancel} onHide={onHide}>
        {request.message && <PromptBody text={request.message} />}
        <div className="flex justify-end gap-2">
          <button
            onClick={onDeny}
            className="rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors"
          >
            {t('common.confirm')}
          </button>
        </div>
      </DialogBox>
    </DialogOverlay>
  )
}

// ─── Input Dialog ────────────────────────────────────────────────────────────

function InputDialog({
  request,
  onSubmit,
  onCancel,
  onHide,
  hidden,
}: DialogFrameProps & {
  request: { id: string; title?: string; placeholder?: string }
  onSubmit: (value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')

  return (
    <DialogOverlay hidden={hidden} onBackdropClick={onHide}>
      <DialogBox prompt={request.title ?? t('chat.extensionUi.inputFallbackTitle')} onCancel={onCancel} onHide={onHide}>
        <input
          type="text"
          placeholder={request.placeholder ?? ''}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          className="mb-4 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-primary placeholder:text-faint focus:border-focus focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isImeComposing(e.nativeEvent)) onSubmit(value)
          }}
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => onSubmit(value)}
            className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors"
          >
            {t('common.submit')}
          </button>
        </div>
      </DialogBox>
    </DialogOverlay>
  )
}

// ─── Editor Dialog ───────────────────────────────────────────────────────────

function EditorDialog({
  request,
  onSubmit,
  onCancel,
  onHide,
  hidden,
}: DialogFrameProps & {
  request: { id: string; title?: string; prefill?: string }
  onSubmit: (value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(request.prefill ?? '')

  return (
    <DialogOverlay hidden={hidden} onBackdropClick={onHide}>
      <DialogBox prompt={request.title ?? t('chat.extensionUi.editFallbackTitle')} onCancel={onCancel} onHide={onHide} wide>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          rows={12}
          className="mb-4 w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm text-primary focus:border-focus focus:outline-none resize-y"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => onSubmit(value)}
            className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors"
          >
            {t('common.save')}
          </button>
        </div>
      </DialogBox>
    </DialogOverlay>
  )
}

// ─── App Confirmation Dialog ─────────────────────────────────────────────────

// Themed replacement for window.confirm(), driven by store.requestConfirm().
// Using a real in-app modal (instead of the native dialog) also avoids an
// Electron quirk where window.confirm leaves the window without keyboard focus.
export function AppConfirmDialog(): React.JSX.Element | null {
  const { t } = useTranslation()
  const request = useAppStore((state) => state.confirmRequest)
  const resolveConfirm = useAppStore((state) => state.resolveConfirm)

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !isImeComposing(e)) {
        e.preventDefault()
        resolveConfirm(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, resolveConfirm])

  if (!request) return null

  return (
    <DialogOverlay hidden={false} onBackdropClick={() => resolveConfirm(false)}>
      <DialogBox prompt={request.title ?? t('common.confirm')} onCancel={() => resolveConfirm(false)}>
        <PromptBody text={request.message} />
        <div className="flex justify-end gap-2">
          <button
            onClick={() => resolveConfirm(false)}
            autoFocus={request.danger}
            className="rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
          >
            {request.cancelLabel ?? t('common.cancel')}
          </button>
          <button
            onClick={() => resolveConfirm(true)}
            autoFocus={!request.danger}
            className={clsx(
              'rounded-md px-4 py-2 text-sm text-white transition-colors',
              request.danger ? 'bg-error hover:bg-error-hover' : 'bg-accent hover:bg-accent-hover'
            )}
          >
            {request.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </DialogBox>
    </DialogOverlay>
  )
}

// ─── Shared Dialog Components ────────────────────────────────────────────────

// Body text keeps the extension's own line breaks (issue #61).
function PromptBody({ text }: { text: string }): React.JSX.Element {
  return <p className="mb-4 whitespace-pre-wrap break-words text-sm text-muted">{text}</p>
}

function DialogOverlay({
  children,
  hidden,
  onBackdropClick,
}: {
  children: React.ReactNode
  hidden: boolean
  onBackdropClick: () => void
}): React.JSX.Element {
  return (
    <div
      className={clsx(
        'fixed inset-0 items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in',
        hidden ? 'hidden' : 'flex'
      )}
      style={{ zIndex: DIALOG_OVERLAY_Z_INDEX }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onBackdropClick()
      }}
    >
      {children}
    </div>
  )
}

// The prompt's first line is the heading; any further lines become body text
// above the children so multi-line questions read as the extension wrote them.
function DialogBox({
  prompt,
  children,
  onCancel,
  onHide,
  wide,
}: {
  prompt: string
  children: React.ReactNode
  onCancel: () => void
  onHide?: () => void
  wide?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { heading, body } = splitPromptText(prompt)
  return (
    <div
      className={clsx(
        'mx-4 flex max-h-[85vh] flex-col rounded-xl border border-border-strong bg-surface shadow-2xl',
        wide ? 'w-full max-w-2xl' : 'w-full max-w-md'
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <h3 className="min-w-0 break-words text-sm font-medium text-primary">{heading}</h3>
        <div className="flex shrink-0 items-center gap-2">
          {onHide && (
            <button
              onClick={onHide}
              title={t('chat.extensionUi.hideForNowWithShortcut', { shortcut: DIALOG_TOGGLE_LABEL })}
              className="text-dim hover:text-secondary"
            >
              <EyeOff size={14} />
            </button>
          )}
          <button onClick={onCancel} title={t('common.cancel')} className="text-dim hover:text-secondary">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 overflow-y-auto p-4">
        {body && <PromptBody text={body} />}
        {children}
      </div>
    </div>
  )
}
