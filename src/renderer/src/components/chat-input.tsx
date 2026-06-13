import { useRef, useCallback, useState, useEffect } from 'react'
import { useAppStore } from '../store'
import { useChatKeyboard } from '../hooks'
import { Send, Square, Paperclip, X, FileText, NotebookPen } from 'lucide-react'

// Max height (px) the auto-growing input expands to before scrolling.
const MAX_INPUT_HEIGHT = 192

export function ChatInput(): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendPrompt = useAppStore((state) => state.sendPrompt)
  const abort = useAppStore((state) => state.abort)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const piStatus = useAppStore((state) => state.piStatus)
  const pendingInsert = useAppStore((state) => state.pendingInsert)
  const clearPendingInsert = useAppStore((state) => state.clearPendingInsert)
  const setNotePickerOpen = useAppStore((state) => state.setNotePickerOpen)

  // Apply a note inserted from the panel or picker: drop the text at the
  // cursor, refocus, resize, then clear so the same note can be inserted again.
  useEffect(() => {
    if (!pendingInsert) return
    const ta = textareaRef.current
    if (!ta) return

    const start = ta.selectionStart ?? ta.value.length
    const end = ta.selectionEnd ?? ta.value.length
    ta.value = ta.value.slice(0, start) + pendingInsert.text + ta.value.slice(end)

    const caret = start + pendingInsert.text.length
    ta.focus()
    ta.setSelectionRange(caret, caret)
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_INPUT_HEIGHT)}px`

    clearPendingInsert()
  }, [pendingInsert, clearPendingInsert])

  const [attachments, setAttachments] = useState<Array<{ name: string; path: string; content: string }>>([])

  const handleSend = useCallback(
    async (message: string) => {
      // Include attachment context in the message
      let fullMessage = message
      if (attachments.length > 0) {
        const attachmentContext = attachments
          .map((a) => `\n\n--- File: ${a.name} ---\n${a.content}`)
          .join('')
        fullMessage = message + attachmentContext
      }

      sendPrompt(fullMessage)
      setAttachments([])
    },
    [sendPrompt, attachments]
  )

  const handleAbort = useCallback(() => {
    abort()
  }, [abort])

  const handleAttachFile = useCallback(async () => {
    try {
      const path = await window.piDesktop.system.openDialog({ title: 'Select file to attach' })
      if (path) {
        const content = await window.piDesktop.files.read(path)
        const name = path.split('/').pop() ?? path
        setAttachments((prev) =>
          prev.some((a) => a.path === path) ? prev : [...prev, { name, path, content }]
        )
      }
    } catch {
      // Silent failure
    }
  }, [])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  useChatKeyboard(handleSend, handleAbort, textareaRef)

  const isDisabled = piStatus !== 'running'

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4">
      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {attachments.map((att, i) => (
            <div
              key={att.path}
              className="flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300"
            >
              <FileText size={12} className="text-neutral-500" />
              <span className="max-w-[120px] truncate">{att.name}</span>
              <button
                onClick={() => removeAttachment(i)}
                className="rounded p-0.5 text-neutral-500 hover:text-neutral-300"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative flex items-end rounded-xl border border-neutral-700 bg-neutral-900 focus-within:border-neutral-600 transition-colors">
        {/* Attachment button */}
        <button
          onClick={handleAttachFile}
          disabled={isDisabled}
          className="flex shrink-0 items-center justify-center p-3 text-neutral-500 hover:text-neutral-300 transition-colors disabled:opacity-50"
          title="Attach file"
          aria-label="Attach file"
        >
          <Paperclip size={16} />
        </button>

        {/* Notes picker button */}
        <button
          onClick={() => setNotePickerOpen(true)}
          className="flex shrink-0 items-center justify-center py-3 pr-1 text-neutral-500 hover:text-neutral-300 transition-colors"
          title="Insert a saved note (Ctrl+Shift+P)"
          aria-label="Insert a saved note"
        >
          <NotebookPen size={16} />
        </button>

        {/* Text input */}
        <textarea
          ref={textareaRef}
          placeholder={
            isDisabled
              ? 'PI agent is not running...'
              : isStreaming
                ? 'Type to steer the agent...'
                : 'Ask PI anything... (Enter to send, Shift+Enter for newline)'
          }
          disabled={isDisabled}
          rows={1}
          className="max-h-48 min-h-[24px] flex-1 resize-none bg-transparent py-3 text-sm text-neutral-200 placeholder:text-neutral-600 outline-none disabled:opacity-50"
          onInput={(e) => {
            const target = e.currentTarget
            target.style.height = 'auto'
            target.style.height = `${Math.min(target.scrollHeight, MAX_INPUT_HEIGHT)}px`
          }}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'p') {
              e.preventDefault()
              useAppStore.getState().cycleModel()
            }
            // Ctrl+Shift+F: open file search
            if (e.ctrlKey && e.shiftKey && e.key === 'F') {
              e.preventDefault()
              useAppStore.getState().toggleFileSearch()
            }
          }}
        />

        {/* Send/Abort button */}
        <div className="flex shrink-0 items-center p-2">
          {isStreaming ? (
            <button
              onClick={handleAbort}
              className="flex items-center justify-center rounded-lg bg-red-600 p-2 text-white hover:bg-red-500 transition-colors"
              title="Stop (Esc)"
              aria-label="Stop generating"
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              onClick={() => {
                const value = textareaRef.current?.value.trim()
                if (value) {
                  handleSend(value)
                  if (textareaRef.current) textareaRef.current.value = ''
                }
              }}
              disabled={isDisabled}
              className="flex items-center justify-center rounded-lg bg-blue-600 p-2 text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Send (Enter)"
              aria-label="Send message"
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Keyboard shortcuts hint */}
      <div className="mt-2 flex items-center justify-between text-xs text-neutral-600">
        <div className="flex gap-3">
          <span>Enter: send</span>
          <span>Shift+Enter: newline</span>
          <span>Esc: stop</span>
          <span>Ctrl+P: model</span>
          <span>Ctrl+Shift+F: search</span>
          <span>Ctrl+Shift+P: notes</span>
        </div>
        {isStreaming && (
          <span className="text-yellow-500 animate-pulse">Streaming...</span>
        )}
      </div>
    </div>
  )
}
