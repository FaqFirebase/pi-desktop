import { useAppStore } from '../store'
import { useState, useEffect } from 'react'
import { X, AlertCircle, HelpCircle } from 'lucide-react'
import { clsx } from 'clsx'

export function ExtensionUiDialog(): React.JSX.Element | null {
  const request = useAppStore((state) => state.extensionUiRequest)
  const respondExtensionUi = useAppStore((state) => state.respondExtensionUi)
  const dismissExtensionUi = useAppStore((state) => state.dismissExtensionUi)

  if (!request) return null

  // Notify method is fire-and-forget, just show a toast
  if (request.method === 'notify') {
    return <NotifyToast request={request} onDismiss={dismissExtensionUi} />
  }

  // setStatus, setWidget, setTitle, set_editor_text are fire-and-forget
  if (['setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(request.method)) {
    return null
  }

  // Dialog methods: select, confirm, input, editor
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
    const timer = setTimeout(onDismiss, 5000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  const iconMap: Record<string, React.ReactNode> = {
    info: <AlertCircle size={16} className="text-blue-400" />,
    warning: <AlertCircle size={16} className="text-yellow-400" />,
    error: <AlertCircle size={16} className="text-red-400" />,
  }

  return (
    <div className="fixed bottom-10 right-4 z-50 animate-fade-in">
      <div className="flex items-center gap-3 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 shadow-lg">
        {iconMap[request.notifyType ?? 'info'] ?? iconMap.info}
        <span className="text-sm text-neutral-200">{request.message ?? 'Notification'}</span>
        <button onClick={onDismiss} className="ml-2 text-neutral-500 hover:text-neutral-300">
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
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
            >
              <HelpCircle size={14} className="text-neutral-500" />
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
          <p className="mb-4 text-sm text-neutral-400">{request.message}</p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onDeny}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:bg-neutral-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 transition-colors"
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
          className="mb-4 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(value)
          }}
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:bg-neutral-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(value)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 transition-colors"
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
          className="mb-4 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-200 focus:border-blue-500 focus:outline-none resize-y"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:bg-neutral-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(value)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 transition-colors"
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
        <p className="mb-4 whitespace-pre-line text-sm text-neutral-400">{request.message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => resolveConfirm(false)}
            autoFocus={request.danger}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:bg-neutral-800 transition-colors"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            onClick={() => resolveConfirm(true)}
            autoFocus={!request.danger}
            className={clsx(
              'rounded-md px-4 py-2 text-sm text-white transition-colors',
              request.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
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
        'mx-4 rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl',
        wide ? 'w-full max-w-2xl' : 'w-full max-w-md'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h3 className="text-sm font-medium text-neutral-200">{title}</h3>
        <button onClick={onCancel} className="text-neutral-500 hover:text-neutral-300">
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="p-4">{children}</div>
    </div>
  )
}
