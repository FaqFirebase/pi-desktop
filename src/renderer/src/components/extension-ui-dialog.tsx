import { useAppStore } from '../store'
import { useState, useEffect } from 'react'
import { X, AlertCircle, HelpCircle } from 'lucide-react'
import { clsx } from 'clsx'

// Stacking tiers for the two extension-UI surfaces, which can be on screen at
// the same time. The toast MUST outrank the dialog's full-screen backdrop: at
// an equal tier the backdrop paints over the toast, and the click aimed at the
// toast lands on the backdrop instead — cancelling the blocking prompt, which
// answers the asking tool with a permanent deny.
export const DIALOG_OVERLAY_Z_INDEX = 50
export const NOTIFY_TOAST_Z_INDEX = 60

// How long a notification stays up before it dismisses itself.
const NOTIFY_TOAST_TIMEOUT_MS = 5000

export function ExtensionUiDialog(): React.JSX.Element | null {
  const request = useAppStore((state) => state.extensionUiRequest)
  const notify = useAppStore((state) => state.extensionNotify)
  const respondExtensionUi = useAppStore((state) => state.respondExtensionUi)
  const dismissExtensionUi = useAppStore((state) => state.dismissExtensionUi)
  const dismissExtensionNotify = useAppStore((state) => state.dismissExtensionNotify)

  // The toast lives in its own store slot so it can coexist with a blocking
  // dialog instead of clobbering it; dismissal only touches the toast slot.
  // Keyed by request id so a notification arriving mid-countdown remounts the
  // toast — otherwise it inherits the previous one's remaining time (and its
  // already-finished fade-in) and can vanish on arrival.
  const toast = notify ? (
    <NotifyToast key={notify.id} request={notify} onDismiss={dismissExtensionNotify} />
  ) : null

  // Dialog slot: the store routes only select/confirm/input/editor here.
  const dialog = ((): React.JSX.Element | null => {
    if (!request) return null
    switch (request.method) {
      case 'select':
        return (
          <SelectDialog
            request={request}
            onSelect={(value) => respondExtensionUi(request.id, { value })}
            onCancel={() => dismissExtensionUi()}
          />
        )
      case 'confirm':
        return (
          <ConfirmDialog
            request={request}
            onConfirm={() => respondExtensionUi(request.id, { confirmed: true })}
            onDeny={() => respondExtensionUi(request.id, { confirmed: false })}
            onCancel={() => dismissExtensionUi()}
          />
        )
      case 'input':
        return (
          <InputDialog
            request={request}
            onSubmit={(value) => respondExtensionUi(request.id, { value })}
            onCancel={() => dismissExtensionUi()}
          />
        )
      case 'editor':
        return (
          <EditorDialog
            request={request}
            onSubmit={(value) => respondExtensionUi(request.id, { value })}
            onCancel={() => dismissExtensionUi()}
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
    </>
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
        <span className="text-sm text-primary">{request.message ?? 'Notification'}</span>
        <button onClick={onDismiss} className="ml-2 text-dim hover:text-secondary">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

// ─── Select Dialog ───────────────────────────────────────────────────────────

function SelectDialog({
  request,
  onSelect,
  onCancel,
}: {
  request: { id: string; title?: string; options?: string[]; timeout?: number }
  onSelect: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <DialogOverlay onCancel={onCancel}>
      <DialogBox title={request.title ?? 'Select'} onCancel={onCancel}>
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
}: {
  request: { id: string; title?: string; message?: string }
  onConfirm: () => void
  onDeny: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <DialogOverlay onCancel={onCancel}>
      <DialogBox title={request.title ?? 'Confirm'} onCancel={onCancel}>
        {request.message && (
          <p className="mb-4 text-sm text-muted">{request.message}</p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onDeny}
            className="rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors"
          >
            Confirm
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
}: {
  request: { id: string; title?: string; placeholder?: string }
  onSubmit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')

  return (
    <DialogOverlay onCancel={onCancel}>
      <DialogBox title={request.title ?? 'Input'} onCancel={onCancel}>
        <input
          type="text"
          placeholder={request.placeholder ?? ''}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          className="mb-4 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-primary placeholder:text-faint focus:border-focus focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(value)
          }}
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(value)}
            className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors"
          >
            Submit
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
}: {
  request: { id: string; title?: string; prefill?: string }
  onSubmit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(request.prefill ?? '')

  return (
    <DialogOverlay onCancel={onCancel}>
      <DialogBox title={request.title ?? 'Edit'} onCancel={onCancel} wide>
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
            Cancel
          </button>
          <button
            onClick={() => onSubmit(value)}
            className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors"
          >
            Save
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
  const request = useAppStore((state) => state.confirmRequest)
  const resolveConfirm = useAppStore((state) => state.resolveConfirm)

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        resolveConfirm(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, resolveConfirm])

  if (!request) return null

  return (
    <DialogOverlay onCancel={() => resolveConfirm(false)}>
      <DialogBox title={request.title ?? 'Confirm'} onCancel={() => resolveConfirm(false)}>
        <p className="mb-4 whitespace-pre-line text-sm text-muted">{request.message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => resolveConfirm(false)}
            autoFocus={request.danger}
            className="rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            onClick={() => resolveConfirm(true)}
            autoFocus={!request.danger}
            className={clsx(
              'rounded-md px-4 py-2 text-sm text-white transition-colors',
              request.danger ? 'bg-error hover:bg-error-hover' : 'bg-accent hover:bg-accent-hover'
            )}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </DialogBox>
    </DialogOverlay>
  )
}

// ─── Shared Dialog Components ────────────────────────────────────────────────

function DialogOverlay({
  children,
  onCancel,
}: {
  children: React.ReactNode
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      style={{ zIndex: DIALOG_OVERLAY_Z_INDEX }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      {children}
    </div>
  )
}

function DialogBox({
  title,
  children,
  onCancel,
  wide,
}: {
  title: string
  children: React.ReactNode
  onCancel: () => void
  wide?: boolean
}): React.JSX.Element {
  return (
    <div
      className={clsx(
        'mx-4 rounded-xl border border-border-strong bg-surface shadow-2xl',
        wide ? 'w-full max-w-2xl' : 'w-full max-w-md'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-primary">{title}</h3>
        <button onClick={onCancel} className="text-dim hover:text-secondary">
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="p-4">{children}</div>
    </div>
  )
}
