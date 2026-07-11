import { useRef, useCallback, useState, useEffect } from 'react'
import { useAppStore } from '../store'
import { useChatKeyboard } from '../hooks'
import { CornerDownLeft, Square, Paperclip, X, FileText, NotebookPen, Users } from 'lucide-react'
import { SUPPORTED_IMAGE_EXTENSIONS, type PromptImage } from '../../../shared/ipc-contracts'

// Max height (px) the auto-growing input expands to before scrolling.
const MAX_INPUT_HEIGHT = 192

// A staged attachment: either inlined as text or sent to Pi as an image block.
type Attachment =
  | { kind: 'text'; name: string; path: string; content: string }
  | { kind: 'image'; name: string; path: string; image: PromptImage }

export function ChatInput(): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendPrompt = useAppStore((state) => state.sendPrompt)
  const abort = useAppStore((state) => state.abort)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const piStatus = useAppStore((state) => state.piStatus)
  const pendingInsert = useAppStore((state) => state.pendingInsert)
  const clearPendingInsert = useAppStore((state) => state.clearPendingInsert)
  const setNotePickerOpen = useAppStore((state) => state.setNotePickerOpen)
  const councilEnabled = useAppStore((s) => s.settings?.council?.enabled ?? false)
  const runCouncil = useAppStore((s) => s.runCouncil)
  const recordPrompt = useAppStore((s) => s.recordPrompt)

  // Prompt-history recall (shell-style ↑/↓). `historyIndex` is -1 when editing a
  // fresh draft; while navigating it points into store.promptHistory and `draft`
  // holds the text that was in the box before recall started (restored on ↓ past
  // the newest entry).
  const historyIndex = useRef(-1)
  const draft = useRef('')

  // Apply a note inserted from the panel or picker: drop the text at the
  // cursor, refocus, resize, then clear so the same note can be inserted again.
  useEffect(() => {
    if (!pendingInsert) return
    const ta = textareaRef.current
    if (!ta) return

    let caret: number
    if (pendingInsert.replace) {
      // Replace the whole composer (used by the slash palette, which fires
      // only when the entire input is a "/..." query).
      ta.value = pendingInsert.text
      caret = pendingInsert.text.length
    } else {
      const start = ta.selectionStart ?? ta.value.length
      const end = ta.selectionEnd ?? ta.value.length
      ta.value = ta.value.slice(0, start) + pendingInsert.text + ta.value.slice(end)
      caret = start + pendingInsert.text.length
    }
    ta.focus()
    ta.setSelectionRange(caret, caret)
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_INPUT_HEIGHT)}px`

    clearPendingInsert()
  }, [pendingInsert, clearPendingInsert])

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)

  // Clear the composer and collapse it back to a single row. The textarea is
  // uncontrolled and auto-grows in onInput, so clearing the value alone leaves it
  // at its expanded height until the next keystroke.
  const resetComposer = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.value = ''
    ta.style.height = 'auto'
  }, [])

  const handleSend = useCallback(
    async (message: string) => {
      // Record the raw prompt (pre-attachment-inlining) for ↑/↓ recall, and
      // reset any in-progress history navigation.
      recordPrompt(message)
      historyIndex.current = -1
      draft.current = ''

      // Text attachments are inlined into the prompt; image attachments are
      // sent as Pi image blocks so the model actually sees them.
      const textAttachments = attachments.filter((a) => a.kind === 'text')
      const imageAttachments = attachments.filter(
        (a): a is Extract<Attachment, { kind: 'image' }> => a.kind === 'image'
      )
      const images = imageAttachments.map((a) => a.image)
      const displayAttachments = imageAttachments.map((a) => ({
        kind: 'image' as const,
        name: a.name,
        mimeType: a.image.mimeType,
        data: a.image.data,
      }))

      let fullMessage = message
      if (textAttachments.length > 0) {
        fullMessage += textAttachments
          .map((a) => `\n\n--- File: ${a.name} ---\n${a.content}`)
          .join('')
      }

      sendPrompt(
        fullMessage,
        images.length > 0 ? { images, attachments: displayAttachments } : undefined
      )
      setAttachments([])
      resetComposer()
    },
    [sendPrompt, attachments, recordPrompt, resetComposer]
  )

  const handleAbort = useCallback(() => {
    abort()
  }, [abort])

  // Drop a recalled prompt into the box: set value, regrow height, caret to end.
  const applyHistory = useCallback((text: string) => {
    const ta = textareaRef.current
    if (!ta) return
    ta.value = text
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_INPUT_HEIGHT)}px`
    ta.setSelectionRange(text.length, text.length)
  }, [])

  const handleAttachFile = useCallback(async () => {
    setAttachError(null)
    try {
      const path = await window.piDesktop.system.openDialog({
        title: 'Attach file',
        mode: 'file',
        filters: [
          { name: 'Images', extensions: [...SUPPORTED_IMAGE_EXTENSIONS] },
          { name: 'All Files', extensions: ['*'] },
        ],
      })
      if (!path) return
      const result = await window.piDesktop.files.readAttachment(path)
      const next: Attachment =
        result.kind === 'image'
          ? { kind: 'image', name: result.name, path, image: result.image }
          : { kind: 'text', name: result.name, path, content: result.content }
      setAttachments((prev) => (prev.some((a) => a.path === path) ? prev : [...prev, next]))
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Could not attach file')
    }
  }, [])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  useChatKeyboard(handleSend, handleAbort, textareaRef)

  const isDisabled = piStatus !== 'running'

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4">
      {/* Attachment error */}
      {attachError && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-red-400">
          <X size={12} className="shrink-0" />
          <span>{attachError}</span>
        </div>
      )}

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {attachments.map((att, i) => (
            <div
              key={att.path}
              className="flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300"
            >
              {att.kind === 'image' ? (
                <img
                  src={`data:${att.image.mimeType};base64,${att.image.data}`}
                  alt={att.name}
                  className="h-5 w-5 shrink-0 rounded object-cover"
                />
              ) : (
                <FileText size={12} className="text-neutral-500" />
              )}
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

      <div className="relative flex items-center rounded-xl border border-neutral-700 bg-neutral-900 focus-within:border-neutral-600 transition-colors">
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
          className="flex shrink-0 items-center justify-center py-3 pr-3 text-neutral-500 hover:text-neutral-300 transition-colors"
          title="Insert a saved note (Ctrl+Shift+P)"
          aria-label="Insert a saved note"
        >
          <NotebookPen size={16} />
        </button>

        {/* Plan with Council button */}
        {councilEnabled && (
          <button
            onClick={() => {
              const value = textareaRef.current?.value.trim()
              if (value) {
                recordPrompt(value)
                historyIndex.current = -1
                draft.current = ''
                void runCouncil(value)
                resetComposer()
              }
            }}
            disabled={isDisabled || isStreaming}
            className="flex shrink-0 items-center justify-center py-3 pr-1 text-neutral-500 hover:text-neutral-300 transition-colors disabled:opacity-50"
            title="Plan with Council"
            aria-label="Plan with Council"
          >
            <Users size={16} />
          </button>
        )}

        {/* Text input */}
        <textarea
          ref={textareaRef}
          placeholder={
            isDisabled
              ? 'Pi agent is not running...'
              : isStreaming
                ? 'Type to steer the agent...'
                : 'Ask Pi anything... (Enter to send, Shift+Enter for newline)'
          }
          disabled={isDisabled}
          rows={1}
          className="font-chat max-h-48 min-h-[24px] flex-1 resize-none bg-transparent py-3 text-sm text-neutral-200 placeholder:text-neutral-600 outline-none disabled:opacity-50"
          onInput={(e) => {
            const target = e.currentTarget
            target.style.height = 'auto'
            target.style.height = `${Math.min(target.scrollHeight, MAX_INPUT_HEIGHT)}px`
            // Any real edit ends history navigation; the box is a fresh draft again.
            historyIndex.current = -1
            const value = target.value
            if (value.startsWith('/')) {
              useAppStore.getState().setCommandPalette(true, value, true)
            } else {
              useAppStore.getState().setCommandPalette(false)
            }
          }}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'p') {
              e.preventDefault()
              useAppStore.getState().cycleModel()
            }
            // Ctrl+Shift+F (file search) is handled at the window level in
            // ChatPanel so it works regardless of composer focus.
            // ↑/↓: shell-style prompt-history recall. Only kicks in at the text
            // edge (↑ on the first line, ↓ on the last) with no selection and no
            // modifiers, so ordinary multi-line cursor movement is untouched. Left
            // to the command palette when it's driving the arrows.
            if (
              (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
              !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey &&
              !useAppStore.getState().commandPaletteOpen
            ) {
              const ta = e.currentTarget
              if (ta.selectionStart !== ta.selectionEnd) return
              const history = useAppStore.getState().promptHistory
              if (e.key === 'ArrowUp') {
                const onFirstLine = ta.value.slice(0, ta.selectionStart).indexOf('\n') === -1
                if (!onFirstLine || history.length === 0) return
                e.preventDefault()
                if (historyIndex.current === -1) {
                  draft.current = ta.value
                  historyIndex.current = history.length - 1
                } else if (historyIndex.current > 0) {
                  historyIndex.current -= 1
                }
                applyHistory(history[historyIndex.current])
              } else {
                const onLastLine = ta.value.slice(ta.selectionEnd).indexOf('\n') === -1
                if (!onLastLine || historyIndex.current === -1) return
                e.preventDefault()
                if (historyIndex.current < history.length - 1) {
                  historyIndex.current += 1
                  applyHistory(history[historyIndex.current])
                } else {
                  historyIndex.current = -1
                  applyHistory(draft.current)
                }
              }
            }
          }}
        />

        {/* Send/Abort button */}
        <div className="flex shrink-0 items-center p-2">
          {isStreaming ? (
            <button
              onClick={handleAbort}
              className="flex items-center justify-center rounded-lg p-2 text-neutral-500 hover:text-neutral-300 transition-colors"
              title="Stop (Esc)"
              aria-label="Stop generating"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              onClick={() => {
                const value = textareaRef.current?.value.trim()
                if (value) {
                  handleSend(value)
                }
              }}
              disabled={isDisabled}
              className="flex items-center justify-center rounded-lg p-2 text-neutral-500 hover:text-neutral-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Send (Enter)"
              aria-label="Send message"
            >
              <CornerDownLeft size={16} />
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
