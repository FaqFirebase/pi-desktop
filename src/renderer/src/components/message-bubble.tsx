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
import { RelativeTime } from '../utils/relative-time'
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
            className="font-chat w-full rounded-2xl rounded-br-md bg-card px-4 py-2.5 text-sm text-primary resize-none min-h-[40px] max-h-48 outline-none"
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
              className="rounded px-2 py-1 text-xs text-muted hover:text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onSaveEdit}
              className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-xs text-white hover:bg-accent-hover transition-colors"
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
        <div className="rounded-2xl rounded-br-md bg-card px-4 py-2.5 text-sm text-primary">
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

  // A grouped thinking-only turn (thinking, no text, no tool calls). It sits
  // between the call/result rows of a serial run; with the default mb-4 rhythm it
  // ends up 16px from its neighbours, which reads as too airy for a bare
  // "Thinking" toggle. Tighten it to 8px on both sides: pull it up 8px against the
  // previous row's mb-4 (-mt-2) and give it an 8px bottom (mb-2) instead of mb-4.
  const isGroupedPureThinking =
    hideModelHeader &&
    !!message.thinking &&
    thinkingEnabled &&
    message.content.trim().length === 0 &&
    (message.toolCalls?.length ?? 0) === 0

  // A pure-tool turn (body is only tool calls): render every call on its own row
  // behind its own operation icon, so each call — including parallel calls in a
  // single turn — is labelled with the right glyph. Standalone (attributed) turns
  // also show a Bot avatar + provider·model header; grouped turns omit the header
  // (the group's shared header stands in) but keep the same per-row-icon layout so
  // a single-call and a multi-call turn align identically.
  if (ToolIcon) {
    const showThinkingBlock = !!message.thinking && thinkingEnabled
    const hasHeaderArea = showModelHeader || showThinkingBlock
    // The collapsible thinking block, reused in the attributed (header) layout and
    // the grouped (padded-block) layout below.
    const thinkingBlock = showThinkingBlock ? (
      <div className="thinking-hover">
        <div className="flex h-7 items-center gap-1">
          <button
            onClick={onToggleThinking}
            className="flex items-center gap-1 text-sm text-dim hover:text-muted transition-colors"
          >
            <Brain size={12} />
            {showThinking ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Thinking
          </button>
          <CopyButton text={message.thinking!} className="thinking-copy-btn" />
        </div>
        {showThinking && (
          <div className="markdown-body min-w-0 font-sans italic text-sm text-muted break-words [overflow-wrap:anywhere]">
            <MarkdownRenderer content={message.thinking!} />
          </div>
        )}
      </div>
    ) : null
    return (
      <div className="group mb-4 animate-fade-in">
        {/* Attributed (standalone) turn: Bot avatar + provider·model header, with
            the thinking block tucked under it. */}
        {showModelHeader && (
          <div className="flex items-start gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card">
              <Bot size={14} className="text-muted" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex h-7 items-center gap-2 text-sm text-dim">
                <span>{message.provider}</span>
                <span className="text-ghost">·</span>
                <span>{modelDisplayName(message.model!, customModels)}</span>
                {message.cost !== undefined && (
                  <>
                    <span className="text-ghost">·</span>
                    <span>${message.cost.toFixed(4)}</span>
                  </>
                )}
                <span className="text-ghost">·</span>
                <RelativeTime timestamp={message.timestamp} />
              </div>
              {thinkingBlock && <div className="mt-2">{thinkingBlock}</div>}
            </div>
          </div>
        )}
        {/* Grouped turn: no header (the group's shared header stands in). Render the
            thinking block as a plain padded block — pl-10 aligns it with the tool
            badges (w-7 icon + gap-3), and controlling its own margins directly
            (-mt-2 above vs the group's mt-4, the tool row's mt-2 below) keeps it
            evenly 8px on both sides whether collapsed or expanded. Nesting it in the
            icon-row flex (as the tool rows do) let the 28px icon spacer floor the
            row height, so the gap below collapsed once the expanded text outgrew it. */}
        {!showModelHeader && thinkingBlock && (
          <div className="-mt-2 pl-10">{thinkingBlock}</div>
        )}
        {/* One row per tool-call box, each behind its own operation icon. mt-2 sets
            the gap under the header/thinking area; space-y-4 keeps the box-to-box gap
            equal to the mb-4 rhythm between separate call/result rows. */}
        <div className={clsx('space-y-4', hasHeaderArea && 'mt-2')}>
          {message.toolCalls!.map((tc) => {
            const RowIcon = toolCallIconFor(tc.name)
            return (
              <div key={tc.id} className="flex items-start gap-3">
                {/* Center the icon on the box's header row (h-8 ≈ py-2 + text-xs). */}
                <div className="flex h-8 w-7 shrink-0 items-center justify-center">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-card">
                    <RowIcon size={14} className="text-dim" />
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
    <div className={clsx('group animate-fade-in', isGroupedPureThinking ? '-mt-2 mb-2' : 'mb-4')}>
      <div className="flex items-start gap-3">
        {/* Avatar — the Bot avatar for a prose turn, except inside a tool group
            (the group shows one shared header above) where it keeps an empty
            spacer so its body stays aligned with the icon-avatared rows.
            Pure-tool turns are handled earlier (each call gets its own icon). */}
        {hideModelHeader ? (
          <div className="h-7 w-7 shrink-0" />
        ) : (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card">
            <Bot size={14} className="text-muted" />
          </div>
        )}

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Model info */}
          {showModelHeader && (
            <div className="flex h-7 items-center gap-2 text-sm text-dim">
              <span>{message.provider}</span>
              <span className="text-ghost">·</span>
              <span>{modelDisplayName(message.model!, customModels)}</span>
              {message.cost !== undefined && (
                <>
                  <span className="text-ghost">·</span>
                  <span>${message.cost.toFixed(4)}</span>
                </>
              )}
              <span className="text-ghost">·</span>
              <RelativeTime timestamp={message.timestamp} />
            </div>
          )}

          {/* Thinking block — gated by the Show Thinking setting. mb-2 only when a
              body (text/tool calls) follows it; on a pure-thinking turn there's
              nothing below, so the mb-2 would stack on the message's own mb-4 and
              leave the block with a bigger gap below than above. */}
          {message.thinking && thinkingEnabled && (
            <div
              className={clsx(
                'thinking-hover',
                (message.content.trim().length > 0 || (message.toolCalls?.length ?? 0) > 0) && 'mb-2'
              )}
            >
              <div className="flex h-7 items-center gap-1">
                <button
                  onClick={onToggleThinking}
                  className="flex items-center gap-1 text-sm text-dim hover:text-muted transition-colors"
                >
                  <Brain size={12} />
                  {showThinking ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Thinking
                </button>
                <CopyButton text={message.thinking} className="thinking-copy-btn" />
              </div>
              {showThinking && (
                <div className="markdown-body min-w-0 font-sans italic text-sm text-muted break-words [overflow-wrap:anywhere]">
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
              to copy/export. Shown on hover only, matching the user-message actions. */}
          {message.content.trim() && (
            <div className="mt-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
              // space-y-4 so parallel calls in one turn (multiple badges here) keep
              // the same 16px rhythm as separate call/result rows (each mb-4),
              // rather than bunching up ~4px apart.
              'space-y-4',
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
  // Edit calls render their edits as a diff (old lines out / new lines in) plus
  // a +N −M summary, instead of the raw JSON args. Open expanded by default so
  // the change is visible in chat without an extra success/failure pill.
  const edits = toolLabel(toolCall.name) === 'Edit file' ? parseEdits(toolCall.arguments) : null
  const stats = edits ? editStats(edits) : null
  const editFile = edits ? toolCallFile(toolCall.name, toolCall.arguments) : null
  const editLang = editFile ? getCodeEditorLanguageName(editFile) : 'plain text'
  const [expanded, setExpanded] = useState(() => Boolean(edits))

  const status = toolCall.isExecuting
    ? 'running'
    : toolCall.isError === true
      ? 'error'
      : toolCall.isError === false || toolCall.result !== undefined
        ? 'done'
        : null

  return (
    <div className="relative min-w-0 overflow-hidden rounded-lg border border-border bg-surface/50">
      <CopyButton text={toolCallCopyText(toolCall)} className="absolute right-1.5 top-1.5 z-10" />
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full min-w-0 items-center gap-2 py-2 pl-3 pr-9 text-xs text-muted hover:text-secondary transition-colors"
      >
        <span className="font-jetbrains min-w-0 truncate">
          {toolCallLabel(toolCall.name, toolCall.arguments)}
        </span>
        {stats && (
          <span className="shrink-0 font-jetbrains">
            <span className="text-success">+{stats.added}</span>{' '}
            <span className="text-error">-{stats.removed}</span>
          </span>
        )}
        {toolCall.durationMs !== undefined && !toolCall.isExecuting && (
          <span className="shrink-0 text-faint">{formatDuration(toolCall.durationMs)}</span>
        )}
        {status && (
          <span
            className={clsx(
              'shrink-0 capitalize',
              status === 'running' && 'text-warning animate-pulse',
              status === 'error' && 'text-error',
              status === 'done' && 'text-success'
            )}
          >
            {status}
          </span>
        )}
        {expanded ? (
          <ChevronDown size={12} className="ml-auto shrink-0" />
        ) : (
          <ChevronRight size={12} className="ml-auto shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2">
          {edits ? (
            <EditDiff blocks={edits} lang={editLang} />
          ) : (
            <pre className="font-jetbrains overflow-x-auto text-xs text-dim">
              {formatToolCallArgs(toolCall.arguments)}
            </pre>
          )}
          {toolCall.result && (
            <div className="mt-2 border-t border-border pt-2">
              <pre className="font-jetbrains overflow-x-auto text-xs text-muted">
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
    <div className="overflow-x-auto font-jetbrains text-xs leading-relaxed text-secondary">
      {blocks.map((b, i) => (
        <div key={i} className={i > 0 ? 'mt-2 border-t border-border pt-2' : ''}>
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
  const rowBg = kind === 'add' ? 'bg-success-bg' : 'bg-error-bg'
  const markColor = kind === 'add' ? 'text-success' : 'text-error'
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
          <div className="relative rounded-lg border border-border bg-surface/50">
            <CopyButton text={message.content} className="absolute right-1.5 top-1.5" />
            {!expandable ? (
              // Single line of content — nothing to expand, so no chevron.
              <div className="flex w-full items-center py-2 pl-3 pr-9 text-xs text-muted">
                <span className="font-jetbrains min-w-0 flex-1 truncate text-left">{firstLine}</span>
              </div>
            ) : expanded && isCode ? (
              // Code view: no header row (its first line repeats as line 1 of the
              // body). Float the collapse control top-right, beside copy, so the
              // code sits flush at the top.
              <button
                onClick={() => setExpanded(false)}
                className="absolute right-8 top-1.5 rounded p-1 text-dim transition-colors hover:text-secondary"
                title="Collapse"
                aria-label="Collapse"
              >
                <ChevronDown size={12} />
              </button>
            ) : (
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex w-full items-center gap-2 py-2 pl-3 pr-9 text-xs text-muted hover:text-secondary transition-colors"
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
                    <pre className="font-jetbrains overflow-x-auto text-xs text-muted">
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
    <div className="overflow-x-auto font-jetbrains text-xs leading-relaxed text-secondary">
      <LineNumberedCode content={code} lang={lang} onFirstLineClick={onCollapse} />
      {note && <div className="mt-2 italic text-dim">{note}</div>}
      {clipped && <div className="mt-1 text-faint">…</div>}
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
  const groupTimestamp = messages[messages.length - 1]?.timestamp

  return (
    <div className="group mb-4 animate-fade-in">
      <div className="flex items-start gap-3">
        {/* Bot avatar + model header so a grouped run reads like any other
            assistant message, not a distinct kind of block. */}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card">
          <Bot size={14} className="text-muted" />
        </div>
        <div className="min-w-0 flex-1">
          {showSharedHeader && (
            <div className="flex h-7 items-center gap-2 text-sm text-dim">
              <span>{sharedProvider}</span>
              <span className="text-ghost">·</span>
              <span>{modelDisplayName(sharedModel as string, customModels)}</span>
              {groupTimestamp !== undefined && (
                <>
                  <span className="text-ghost">·</span>
                  <RelativeTime timestamp={groupTimestamp} />
                </>
              )}
            </div>
          )}
          <div
            className={clsx(
              'relative rounded-lg border border-border bg-surface/50',
              showSharedHeader && 'mt-1.5'
            )}
          >
            <CopyButton text={groupCopyText(messages)} className="absolute right-1.5 top-1.5" />
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex w-full items-center gap-2 py-2 pl-3 pr-9 text-xs text-muted hover:text-secondary transition-colors"
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
      <div className="rounded-full bg-surface px-3 py-1 text-xs text-dim">
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
      className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
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
