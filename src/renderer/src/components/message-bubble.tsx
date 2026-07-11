import { memo, useState, useRef } from 'react'
import { useAppStore, type DisplayMessage } from '../store'
import { modelDisplayName } from '../../../shared/models-config'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import {
  toolCallLabel,
  toolLabel,
  toolCallFile,
  parseEdits,
  editStats,
  splitReadTruncationNote,
  type EditBlock,
} from '../message-grouping'
import { toolCallIconFor } from './tool-call-icon'
import { getCodeEditorLanguageName } from './code-editor-language'
import { highlightCodeToHtml } from './chat-code-highlight'
import { LineNumberedCode } from './line-numbered-code'
import { MarkdownRenderer } from './markdown-renderer'
import { CopyButton } from './copy-button'
import { useContextMenu, buildMessageContextMenu } from './context-menu'
import { clsx } from 'clsx'
import {
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Brain,
  Bot,
  Edit3,
  GitBranch,
  RotateCcw,
  Download,
  Send,
} from 'lucide-react'

function MessageBubbleImpl({
  message,
  onRetry,
  hideModelHeader,
}: {
  message: DisplayMessage
  onRetry?: (messageId: string) => void
  // When rendered inside a tool group that shows a single shared model header,
  // suppress this message's own provider · model line to avoid repetition.
  hideModelHeader?: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [showThinking, setShowThinking] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleEdit = () => {
    setEditContent(message.content)
    setIsEditing(true)
  }

  const handleSaveEdit = async () => {
    if (editContent.trim() !== message.content) {
      // Resend the edited message
      await useAppStore.getState().sendPrompt(editContent.trim())
    }
    setIsEditing(false)
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
  }

  const handleBranch = () => {
    // Branch from this message's position
    useAppStore.getState().addMessage({
      id: `branch-${Date.now()}`,
      role: 'system',
      content: `Branched from: "${message.content.slice(0, 100)}${message.content.length > 100 ? '...' : ''}"`,
      timestamp: Date.now(),
    })
  }

  const handleExport = () => {
    const blob = new Blob([message.content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const label = message.role === 'assistant' ? 'desktop' : message.role
    const d = new Date(message.timestamp ?? Date.now())
    const p = (n: number): string => String(n).padStart(2, '0')
    // Format: yyyy-mm-ddThh-mm-ss (local time)
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
    a.download = `pi-${label}-${stamp}.md`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  // Context menu for message-specific actions
  const { show: showContextMenu, ContextMenuComponent: MessageContextMenu } = useContextMenu()

  const startNoteFromText = useAppStore((state) => state.startNoteFromText)

  const handleMessageContextMenu = (e: React.MouseEvent) => {
    showContextMenu(e, buildMessageContextMenu(message.content, startNoteFromText))
  }

  if (message.role === 'user') {
    return (
      <>
      <div data-scroll-anchor={message.id} onContextMenu={handleMessageContextMenu}>
      <UserMessage
        message={message}
        isEditing={isEditing}
        editContent={editContent}
        onEditContentChange={setEditContent}
        onCopy={handleCopy}
        onEdit={handleEdit}
        onSaveEdit={handleSaveEdit}
        onCancelEdit={handleCancelEdit}
        onBranch={handleBranch}
        onRetry={onRetry}
        onExport={handleExport}
      />
      </div>
      {MessageContextMenu}
      </>
    )
  }

  if (message.role === 'assistant') {
    return (
      <>
      <div onContextMenu={handleMessageContextMenu}>
      <AssistantMessage
        message={message}
        onCopy={handleCopy}
        copied={copied}
        showThinking={showThinking}
        onToggleThinking={() => setShowThinking(!showThinking)}
        onExport={handleExport}
        hideModelHeader={hideModelHeader}
      />
      </div>
      {MessageContextMenu}
      </>
    )
  }

  if (message.role === 'toolResult') {
    return (
      <>
      <div onContextMenu={handleMessageContextMenu}>
      <ToolResultMessage message={message} />
      </div>
      {MessageContextMenu}
      </>
    )
  }

  if (message.role === 'system') {
    return <SystemMessage message={message} />
  }

  return <></>
}

// Memoized so finalized messages don't re-parse markdown on every store update
// (e.g. during streaming of a later message). Relies on stable `message`
// references and a stable `onRetry` callback from the caller.
export const MessageBubble = memo(MessageBubbleImpl)

// ─── User Message ────────────────────────────────────────────────────────────

function UserMessage({
  message,
  isEditing,
  editContent,
  onEditContentChange,
  onCopy,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onBranch,
  onRetry,
  onExport,
}: {
  message: DisplayMessage
  isEditing: boolean
  editContent: string
  onEditContentChange: (v: string) => void
  onCopy: () => void
  onEdit: () => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onBranch: () => void
  onRetry?: (id: string) => void
  onExport: () => void
}): React.JSX.Element {
  const editRef = useRef<HTMLTextAreaElement>(null)

  if (isEditing) {
    return (
      <div className="group mb-4 flex justify-end animate-fade-in">
        <div className="w-full max-w-[80%]">
          <textarea
            ref={editRef}
            value={editContent}
            onChange={(e) => onEditContentChange(e.target.value)}
            className="font-chat w-full rounded-2xl rounded-br-md bg-[#323232] px-4 py-2.5 text-sm text-[#d7d7d7] resize-none min-h-[40px] max-h-48 outline-none"
            rows={1}
            onInput={(e) => {
              const t = e.currentTarget
              t.style.height = 'auto'
              t.style.height = `${Math.min(t.scrollHeight, 192)}px`
            }}
            autoFocus
          />
          <div className="flex items-center justify-end gap-1 mt-1">
            <button
              onClick={onCancelEdit}
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onSaveEdit}
              className="flex items-center gap-1 rounded bg-blue-500 px-2 py-1 text-xs text-white hover:bg-blue-400 transition-colors"
            >
              <Send size={10} />
              Send
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group mb-4 flex justify-end animate-fade-in">
      <div className="relative max-w-[80%]">
        <div className="rounded-2xl rounded-br-md bg-[#323232] px-4 py-2.5 text-sm text-[#d7d7d7]">
          {message.attachments && message.attachments.length > 0 && (
            <div className={clsx('flex flex-wrap gap-2', message.content && 'mb-2')}>
              {message.attachments.map((attachment, index) => (
                <div
                  key={`${attachment.name}-${index}`}
                  className="overflow-hidden rounded-md border border-white/20 bg-black/10"
                  title={attachment.name}
                >
                  <img
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    alt={attachment.name}
                    className="h-16 w-16 object-cover"
                  />
                </div>
              ))}
            </div>
          )}
          <div className="font-chat whitespace-pre-wrap break-words">{message.content}</div>
        </div>
        {/* Actions */}
        <div className="mt-1 flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <ActionButton icon={<Copy size={11} />} onClick={onCopy} title="Copy" />
          <ActionButton icon={<Edit3 size={11} />} onClick={onEdit} title="Edit & resend" />
          <ActionButton icon={<GitBranch size={11} />} onClick={onBranch} title="Branch from here" />
          {onRetry && (
            <ActionButton icon={<RotateCcw size={11} />} onClick={() => onRetry(message.id)} title="Retry" />
          )}
          <ActionButton icon={<Download size={11} />} onClick={onExport} title="Export" />
        </div>
      </div>
    </div>
  )
}

// ─── Assistant Message ───────────────────────────────────────────────────────

function AssistantMessage({
  message,
  onCopy,
  copied,
  showThinking,
  onToggleThinking,
  onExport,
  hideModelHeader,
}: {
  message: DisplayMessage
  onCopy: () => void
  copied: boolean
  showThinking: boolean
  onToggleThinking: () => void
  onExport: () => void
  hideModelHeader?: boolean
}): React.JSX.Element {
  const customModels = useAppStore((state) => state.customModels)
  const thinkingEnabled = useAppStore(
    (state) => state.settingsDraft.showThinking ?? state.settings?.showThinking ?? DEFAULT_SETTINGS.showThinking
  )

  // With thinking off, a thinking-only turn (no text, no tool calls) would
  // collapse to just an orphaned model/provider header. Suppress it entirely so
  // the header doesn't appear to repeat. Only applies when thinking is hidden —
  // with thinking on, the block itself gives the header something to sit above.
  const hasVisibleBody = message.content.trim().length > 0 || (message.toolCalls?.length ?? 0) > 0
  if (!thinkingEnabled && !hasVisibleBody) {
    return <></>
  }

  // A turn whose only body is tool calls (no prose) is a pure tool operation, so
  // its avatar mirrors the operation (globe for a fetch, document for a read, …)
  // instead of the Bot avatar / group spacer.
  const ToolIcon =
    message.content.trim().length === 0 && message.toolCalls && message.toolCalls.length > 0
      ? toolCallIconFor(message.toolCalls[0].name)
      : null

  // Show the provider · model header whenever Pi attributes the turn — including
  // a standalone tool call, so you can see who ran it. It's suppressed only
  // inside a group (hideModelHeader), where the group's one shared header stands
  // in and repeating it per row would just be noise.
  const showModelHeader = !!message.model && !hideModelHeader

  // Standalone tool call (attributed, not inside a group): render it like a group
  // reads — the Bot avatar carries the provider · model header on its own row, and
  // each tool-call box sits on its own row behind the operation icon. (Grouped
  // rows have no header and fall through to the single-avatar layout below; the
  // group already shows one shared Bot header above them.)
  if (ToolIcon && showModelHeader) {
    return (
      <div className="group mb-4 animate-fade-in">
        {/* Header row: Bot avatar + provider · model, matching a prose turn. */}
        <div className="flex items-start gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-800">
            <Bot size={14} className="text-neutral-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex h-7 items-center gap-2 text-sm text-neutral-500">
              <span>{message.provider}</span>
              <span className="text-neutral-700">·</span>
              <span>{modelDisplayName(message.model!, customModels)}</span>
              {message.cost !== undefined && (
                <>
                  <span className="text-neutral-700">·</span>
                  <span>${message.cost.toFixed(4)}</span>
                </>
              )}
            </div>
            {message.thinking && thinkingEnabled && (
              <div className="thinking-hover mt-2">
                <div className="flex h-7 items-center gap-1">
                  <button
                    onClick={onToggleThinking}
                    className="flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-400 transition-colors"
                  >
                    <Brain size={12} />
                    {showThinking ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Thinking
                  </button>
                  <CopyButton text={message.thinking} className="thinking-copy-btn" />
                </div>
                {showThinking && (
                  <div className="markdown-body font-sans italic text-sm text-neutral-400">
                    <MarkdownRenderer content={message.thinking} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {/* One row per tool-call box, each behind its own operation icon. mt-2
            sets the header→first-box gap; space-y-1 the box-to-box gap. */}
        <div className="mt-2 space-y-1">
          {message.toolCalls!.map((tc) => {
            const RowIcon = toolCallIconFor(tc.name)
            return (
              <div key={tc.id} className="flex items-start gap-3">
                {/* Center the icon on the box's header row (h-8 ≈ py-2 + text-xs). */}
                <div className="flex h-8 w-7 shrink-0 items-center justify-center">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-800">
                    <RowIcon size={14} className="text-neutral-500" />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <ToolCallBadge toolCall={tc} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="group mb-4 animate-fade-in">
      <div className="flex items-start gap-3">
        {/* Avatar — a grouped tool row shows its operation icon; otherwise the Bot
            avatar, except inside a tool group (the group shows one shared header
            above) where a prose/thinking turn keeps an empty spacer so its body
            stays aligned with the icon-avatared rows. */}
        {ToolIcon ? (
          // Center the icon on the tool-call box's header row (h-8 ≈ py-2 +
          // text-xs) instead of top-aligning, so it lines up with the box text.
          <div className="flex h-8 w-7 shrink-0 items-center justify-center">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-800">
              <ToolIcon size={14} className="text-neutral-500" />
            </div>
          </div>
        ) : hideModelHeader ? (
          <div className="h-7 w-7 shrink-0" />
        ) : (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-800">
            <Bot size={14} className="text-neutral-400" />
          </div>
        )}

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Model info */}
          {showModelHeader && (
            <div className="flex h-7 items-center gap-2 text-sm text-neutral-500">
              <span>{message.provider}</span>
              <span className="text-neutral-700">·</span>
              <span>{modelDisplayName(message.model!, customModels)}</span>
              {message.cost !== undefined && (
                <>
                  <span className="text-neutral-700">·</span>
                  <span>${message.cost.toFixed(4)}</span>
                </>
              )}
            </div>
          )}

          {/* Thinking block — gated by the Show Thinking setting */}
          {message.thinking && thinkingEnabled && (
            <div className="thinking-hover mb-2">
              <div className="flex h-7 items-center gap-1">
                <button
                  onClick={onToggleThinking}
                  className="flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-400 transition-colors"
                >
                  <Brain size={12} />
                  {showThinking ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Thinking
                </button>
                <CopyButton text={message.thinking} className="thinking-copy-btn" />
              </div>
              {showThinking && (
                <div className="markdown-body font-sans italic text-sm text-neutral-400">
                  <MarkdownRenderer content={message.thinking} />
                </div>
              )}
            </div>
          )}

          {/* Text content */}
          {message.content.trim() && (
            <div
              data-scroll-anchor={message.id}
              className={clsx(
              'markdown-body text-sm',
              // Sit just below the model/provider header — 6px, 2px tighter than
              // the tool-call box's 8px top gap.
              (message.model || message.thinking) && 'mt-1.5'
            )}>
              <MarkdownRenderer content={message.content} />
            </div>
          )}

          {/* Actions — copy/export the response text. Rendered directly beneath
              the text (before any tool calls) so on a turn that mixes prose with
              tool calls the buttons stay attached to the prose instead of landing
              under the tool-call box and splitting a run of grouped tool badges.
              Only shown when there's real response text — a tool-only message's
              content is just whitespace/newlines, which is truthy but has nothing
              to copy/export. Always visible when shown. */}
          {message.content.trim() && (
            <div className="mt-2 flex items-center gap-0.5">
              <ActionButton
                icon={copied ? <Check size={11} /> : <Copy size={11} />}
                onClick={onCopy}
                title={copied ? 'Copied' : 'Copy'}
                label={copied ? 'Copied' : 'Copy'}
              />
              <ActionButton icon={<Download size={11} />} onClick={onExport} title="Export" />
            </div>
          )}

          {/* Tool calls */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className={clsx(
              'space-y-1',
              // Pad the top only when something actually renders above the tool
              // box — a visible model header, a thinking block, or response text.
              // A grouped tool row has no header (showModelHeader is false), so it
              // top-aligns with its icon avatar; that also keeps the gap between
              // grouped call/result pairs equal to the gap within a pair (no stray
              // 8px from an mt-2 sitting under a suppressed header).
              (showModelHeader ||
                (message.thinking && thinkingEnabled) ||
                message.content.trim().length > 0) && 'mt-2'
            )}>
              {message.toolCalls.map((tc) => (
                <ToolCallBadge key={tc.id} toolCall={tc} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Tool Call Badge ─────────────────────────────────────────────────────────

function ToolCallBadge({
  toolCall,
}: {
  toolCall: NonNullable<DisplayMessage['toolCalls']>[number]
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  // Edit calls render their `edits` as a diff (old lines out / new lines in) plus
  // a +N −M summary, instead of the raw JSON args. The diff lines are syntax-
  // highlighted using the edited file's language.
  const edits = toolLabel(toolCall.name) === 'Edit file' ? parseEdits(toolCall.arguments) : null
  const stats = edits ? editStats(edits) : null
  const editFile = edits ? toolCallFile(toolCall.name, toolCall.arguments) : null
  const editLang = editFile ? getCodeEditorLanguageName(editFile) : 'plain text'

  return (
    <div className="relative rounded-lg border border-neutral-800 bg-neutral-900/50">
      <CopyButton text={toolCallCopyText(toolCall)} className="absolute right-1.5 top-1.5" />
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 py-2 pl-3 pr-9 text-xs text-neutral-400 hover:text-neutral-300 transition-colors"
      >
        <span className="font-jetbrains min-w-0 truncate">
          {toolCallLabel(toolCall.name, toolCall.arguments)}
        </span>
        {stats && (
          <span className="shrink-0 font-jetbrains">
            <span className="text-green-400">+{stats.added}</span>{' '}
            <span className="text-red-400">-{stats.removed}</span>
          </span>
        )}
        {toolCall.durationMs !== undefined && !toolCall.isExecuting && (
          <span className="shrink-0 text-neutral-600">{formatDuration(toolCall.durationMs)}</span>
        )}
        {toolCall.isError !== undefined && (
          <span className={clsx(
            'rounded px-1.5 py-0.5',
            toolCall.isError ? 'bg-red-900/30 text-red-400' : 'bg-emerald-900/30 text-emerald-400'
          )}>
            {toolCall.isError ? 'error' : 'done'}
          </span>
        )}
        {toolCall.isExecuting && (
          <span className="text-yellow-500 animate-pulse">running</span>
        )}
        {expanded ? (
          <ChevronDown size={12} className="ml-auto shrink-0" />
        ) : (
          <ChevronRight size={12} className="ml-auto shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-neutral-800 px-3 py-2">
          {edits ? (
            <EditDiff blocks={edits} lang={editLang} />
          ) : (
            <pre className="font-jetbrains overflow-x-auto text-xs text-neutral-500">
              {formatToolCallArgs(toolCall.arguments)}
            </pre>
          )}
          {toolCall.result && (
            <div className="mt-2 border-t border-neutral-800 pt-2">
              <pre className="font-jetbrains overflow-x-auto text-xs text-neutral-400">
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Renders an edit call's blocks as a diff: each block shows its old lines removed
// (red) then its new lines added (green), with the code syntax-highlighted. A
// block replacement, not a line-level diff — enough to read the change at a glance.
function EditDiff({ blocks, lang }: { blocks: EditBlock[]; lang: string }): React.JSX.Element {
  return (
    <div className="overflow-x-auto font-jetbrains text-xs leading-relaxed text-neutral-300">
      {blocks.map((b, i) => (
        <div key={i} className={i > 0 ? 'mt-2 border-t border-neutral-800 pt-2' : ''}>
          <DiffLines text={b.oldText} lang={lang} kind="remove" />
          <DiffLines text={b.newText} lang={lang} kind="add" />
        </div>
      ))}
    </div>
  )
}

// One side of a diff block (all removed, or all added), syntax-highlighted.
// highlightCodeToHtml emits newlines separately, so its output splits cleanly
// into per-line HTML; falls back to plain text when no parser matches.
function DiffLines({
  text,
  lang,
  kind,
}: {
  text: string
  lang: string
  kind: 'add' | 'remove'
}): React.JSX.Element | null {
  if (text === '') return null
  const html = highlightCodeToHtml(text, lang)
  const lines = (html ?? text).split('\n')
  const rowBg = kind === 'add' ? 'bg-green-950/30' : 'bg-red-950/30'
  const markColor = kind === 'add' ? 'text-green-400' : 'text-red-400'
  const sign = kind === 'add' ? '+ ' : '- '
  return (
    <>
      {lines.map((line, j) => (
        <div key={j} className={clsx('whitespace-pre', rowBg)}>
          <span className={clsx('select-none', markColor)}>{sign}</span>
          {html !== null ? (
            <span dangerouslySetInnerHTML={{ __html: line || ' ' }} />
          ) : (
            <span>{line || ' '}</span>
          )}
        </div>
      ))}
    </>
  )
}

// ─── Tool Result Message ─────────────────────────────────────────────────────

function ToolResultMessage({ message }: { message: DisplayMessage }): React.JSX.Element {
  // Collapsed by default — tool results can be huge and otherwise dominate the
  // scrollback. Mirrors ToolCallBadge's expand/collapse affordance.
  const [expanded, setExpanded] = useState(false)
  const newlineIdx = message.content.indexOf('\n')
  const firstLine = newlineIdx === -1 ? message.content : message.content.slice(0, newlineIdx)
  // Everything after the first line; that line already shows in the header row.
  const rest = newlineIdx === -1 ? '' : message.content.slice(newlineIdx + 1)
  // Nothing beyond the first line → nothing to expand, so no chevron.
  const expandable = rest.trim() !== ''

  // Only a file-read result is the file's content, so only it renders as
  // line-numbered, syntax-highlighted code. Everything else stays plain text —
  // notably writes/creates, whose result is a "wrote N bytes" success line (not
  // the file), plus CSV, command output, and fetches.
  const label = message.toolName ? toolLabel(message.toolName) : null
  const codeLang =
    label === 'Read file' && message.toolFile
      ? getCodeEditorLanguageName(message.toolFile)
      : 'plain text'
  const isCode = codeLang !== 'plain text'

  return (
    <div className="mb-4 animate-fade-in">
      <div className="flex items-start gap-3">
        {/* No result icon — an empty spacer (same width as a tool-call avatar)
            keeps the result box left-aligned with the tool-call box above it. */}
        <div className="w-7 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="relative rounded-lg border border-neutral-800 bg-neutral-900/50">
            <CopyButton text={message.content} className="absolute right-1.5 top-1.5" />
            {!expandable ? (
              // Single line of content — nothing to expand, so no chevron.
              <div className="flex w-full items-center py-2 pl-3 pr-9 text-xs text-neutral-400">
                <span className="font-jetbrains min-w-0 flex-1 truncate text-left">{firstLine}</span>
              </div>
            ) : expanded && isCode ? (
              // Code view: no header row (its first line repeats as line 1 of the
              // body). Float the collapse control top-right, beside copy, so the
              // code sits flush at the top.
              <button
                onClick={() => setExpanded(false)}
                className="absolute right-8 top-1.5 rounded p-1 text-neutral-500 transition-colors hover:text-neutral-300"
                title="Collapse"
                aria-label="Collapse"
              >
                <ChevronDown size={12} />
              </button>
            ) : (
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex w-full items-center gap-2 py-2 pl-3 pr-9 text-xs text-neutral-400 hover:text-neutral-300 transition-colors"
              >
                <span className="font-jetbrains min-w-0 flex-1 truncate text-left">{firstLine}</span>
                {expanded ? (
                  <ChevronDown size={12} className="shrink-0" />
                ) : (
                  <ChevronRight size={12} className="shrink-0" />
                )}
              </button>
            )}
            {expandable &&
              expanded &&
              (isCode ? (
                <div className="px-3 py-2">
                  <CodeResultView
                    content={message.content}
                    lang={codeLang}
                    onCollapse={() => setExpanded(false)}
                  />
                </div>
              ) : (
                rest.trim() && (
                  <div className="px-3 pb-2">
                    <pre className="font-jetbrains overflow-x-auto text-xs text-neutral-400">
                      {rest.slice(0, 2000)}
                      {rest.length > 2000 && '\n…'}
                    </pre>
                  </div>
                )
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// Guard against re-parsing a whole huge file for highlighting; the source is
// already truncated by Pi, this is just a ceiling.
const MAX_CODE_RESULT_CHARS = 20000

// Renders file content as line-numbered, syntax-highlighted code. highlightCodeToHtml
// emits newlines separately from its <span> runs, so splitting on '\n' yields
// self-contained per-line HTML; when no parser exists it falls back to plain text.
function CodeResultView({
  content,
  lang,
  onCollapse,
}: {
  content: string
  lang: string
  onCollapse: () => void
}): React.JSX.Element {
  const clipped = content.length > MAX_CODE_RESULT_CHARS
  const clippedContent = clipped ? content.slice(0, MAX_CODE_RESULT_CHARS) : content
  // Peel off Pi's "[N more lines in file…]" footer so it renders as a note, not code.
  const { code, note } = splitReadTruncationNote(clippedContent)

  return (
    // The first line doubles as a collapse trigger (a large click target, like the
    // collapsed header). A drag to select text isn't a click, so selection works.
    <div className="overflow-x-auto font-jetbrains text-xs leading-relaxed text-neutral-300">
      <LineNumberedCode content={code} lang={lang} onFirstLineClick={onCollapse} />
      {note && <div className="mt-2 italic text-neutral-500">{note}</div>}
      {clipped && <div className="mt-1 text-neutral-600">…</div>}
    </div>
  )
}

// ─── Tool Group ──────────────────────────────────────────────────────────────

// A run of consecutive tool-activity messages (tool calls + their results, plus
// any thinking-only turns among them) folded into one collapsed block. Collapsed
// by default to keep repetitive runs from dominating the scrollback; expanding
// reveals the original messages rendered exactly as they would appear ungrouped.
function ToolGroupBubbleImpl({
  title,
  messages,
  onRetry,
}: {
  title: string
  messages: DisplayMessage[]
  onRetry?: (messageId: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const customModels = useAppStore((state) => state.customModels)

  // If every assistant turn in the group used the same model, show one shared
  // provider · model header above the body and suppress the per-turn headers. If
  // they differ (a mid-run model switch), keep each turn's own header so the
  // distinction isn't lost.
  const modelKeys = new Set<string>()
  let sharedModel: string | undefined
  let sharedProvider: string | undefined
  for (const m of messages) {
    if (m.role === 'assistant' && m.model) {
      modelKeys.add(`${m.provider ?? ''}|${m.model}`)
      if (sharedModel === undefined) {
        sharedModel = m.model
        sharedProvider = m.provider
      }
    }
  }
  const showSharedHeader = modelKeys.size === 1 && sharedModel !== undefined

  return (
    <div className="group mb-4 animate-fade-in">
      <div className="flex items-start gap-3">
        {/* Bot avatar + model header so a grouped run reads like any other
            assistant message, not a distinct kind of block. */}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-800">
          <Bot size={14} className="text-neutral-400" />
        </div>
        <div className="min-w-0 flex-1">
          {showSharedHeader && (
            <div className="flex h-7 items-center gap-2 text-sm text-neutral-500">
              <span>{sharedProvider}</span>
              <span className="text-neutral-700">·</span>
              <span>{modelDisplayName(sharedModel as string, customModels)}</span>
            </div>
          )}
          <div
            className={clsx(
              'relative rounded-lg border border-neutral-800 bg-neutral-900/50',
              showSharedHeader && 'mt-1.5'
            )}
          >
            <CopyButton text={groupCopyText(messages)} className="absolute right-1.5 top-1.5" />
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex w-full items-center gap-2 py-2 pl-3 pr-9 text-xs text-neutral-400 hover:text-neutral-300 transition-colors"
            >
              <span className="font-jetbrains">{title}</span>
              {expanded ? (
                <ChevronDown size={12} className="ml-auto shrink-0" />
              ) : (
                <ChevronRight size={12} className="ml-auto shrink-0" />
              )}
            </button>
          </div>
          {/* Expanded body: the original messages, slightly indented to signal
              they belong to the group. Per-turn model headers are suppressed since
              the group already shows one above. mt-4 matches the mb-4 gap between
              the rows inside, so the header→first-row gap equals the row-to-row
              gap. Last child's bottom margin trimmed so it doesn't double up on
              the group's own mb-4. */}
          {expanded && (
            <div className="mt-4 pl-3 [&>*:last-child]:mb-0">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  onRetry={onRetry}
                  hideModelHeader={showSharedHeader}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const ToolGroupBubble = memo(ToolGroupBubbleImpl)

// ─── System Message ──────────────────────────────────────────────────────────

function SystemMessage({ message }: { message: DisplayMessage }): React.JSX.Element {
  return (
    <div className="mb-4 flex justify-center animate-fade-in">
      <div className="rounded-full bg-neutral-900 px-3 py-1 text-xs text-neutral-500">
        {message.content}
      </div>
    </div>
  )
}

// ─── Action Button ───────────────────────────────────────────────────────────

function ActionButton({
  icon,
  onClick,
  title,
  label,
}: {
  icon: React.ReactNode
  onClick: () => void
  title: string
  label?: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300 transition-colors"
      title={title}
      aria-label={title}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
}

function formatToolCallArgs(args: string): string {
  try {
    const parsed = JSON.parse(args)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return args
  }
}

// The group's copy button yields every call and result in order: each tool
// call's copy text (raw command / formatted args) followed by its result.
function groupCopyText(messages: DisplayMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) parts.push(toolCallCopyText(tc))
    } else if (m.role === 'toolResult') {
      parts.push(m.content)
    }
  }
  return parts.join('\n\n')
}

// What the copy button on a tool-call box yields: the raw command for
// shell-style tools (so it pastes cleanly), otherwise the formatted arguments.
function toolCallCopyText(toolCall: NonNullable<DisplayMessage['toolCalls']>[number]): string {
  try {
    const parsed = JSON.parse(toolCall.arguments)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ['command', 'cmd', 'script']) {
        const value = (parsed as Record<string, unknown>)[key]
        if (typeof value === 'string' && value.length > 0) return value
      }
    }
  } catch {
    // fall through to formatted args
  }
  return formatToolCallArgs(toolCall.arguments)
}
