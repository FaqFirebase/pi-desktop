import { memo, useState, useRef } from 'react'
import { useAppStore, type DisplayMessage } from '../store'
import { modelDisplayName } from '../../../shared/models-config'
import { MarkdownRenderer } from './markdown-renderer'
import { CopyButton } from './copy-button'
import { useContextMenu, buildMessageContextMenu } from './context-menu'
import { clsx } from 'clsx'
import {
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Wrench,
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
}: {
  message: DisplayMessage
  onRetry?: (messageId: string) => void
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
      <div onContextMenu={handleMessageContextMenu}>
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
}: {
  message: DisplayMessage
  onCopy: () => void
  copied: boolean
  showThinking: boolean
  onToggleThinking: () => void
  onExport: () => void
}): React.JSX.Element {
  const customModels = useAppStore((state) => state.customModels)
  const thinkingEnabled = useAppStore(
    (state) => state.settings?.showThinking ?? false
  )

  // With thinking off, a thinking-only turn (no text, no tool calls) would
  // collapse to just an orphaned model/provider header. Suppress it entirely so
  // the header doesn't appear to repeat. Only applies when thinking is hidden —
  // with thinking on, the block itself gives the header something to sit above.
  const hasVisibleBody = message.content.trim().length > 0 || (message.toolCalls?.length ?? 0) > 0
  if (!thinkingEnabled && !hasVisibleBody) {
    return <></>
  }

  return (
    <div className="group mb-4 animate-fade-in">
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-800">
          <Bot size={14} className="text-neutral-400" />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Model info */}
          {message.model && (
            <div className="flex h-7 items-center gap-2 text-sm text-neutral-500">
              <span>{message.provider}</span>
              <span className="text-neutral-700">·</span>
              <span>{modelDisplayName(message.model, customModels)}</span>
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
            <div className={clsx(
              'markdown-body text-sm',
              // Sit just below the model/provider header — 6px, 2px tighter than
              // the tool-call box's 8px top gap.
              (message.model || message.thinking) && 'mt-1.5'
            )}>
              <MarkdownRenderer content={message.content} />
            </div>
          )}

          {/* Tool calls */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className={clsx(
              'space-y-1',
              // Only pad the top when something sits above; otherwise the box
              // should top-align with the avatar.
              (message.model || message.thinking || message.content) && 'mt-2'
            )}>
              {message.toolCalls.map((tc) => (
                <ToolCallBadge key={tc.id} toolCall={tc} />
              ))}
            </div>
          )}

          {/* Actions — only when there is real response text (a tool-only
              message's content is just whitespace/newlines, which is truthy but
              has nothing to copy/export). Always visible when shown. */}
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

  return (
    <div className="relative rounded-lg border border-neutral-800 bg-neutral-900/50">
      <CopyButton text={toolCallCopyText(toolCall)} className="absolute right-1.5 top-1.5" />
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 py-2 pl-3 pr-9 text-xs text-neutral-400 hover:text-neutral-300 transition-colors"
      >
        <span className="font-jetbrains">{toolLabel(toolCall.name)}</span>
        {toolCall.durationMs !== undefined && !toolCall.isExecuting && (
          <span className="text-neutral-600">{formatDuration(toolCall.durationMs)}</span>
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
          <pre className="font-jetbrains overflow-x-auto text-xs text-neutral-500">
            {formatToolCallArgs(toolCall.arguments)}
          </pre>
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

// ─── Tool Result Message ─────────────────────────────────────────────────────

function ToolResultMessage({ message }: { message: DisplayMessage }): React.JSX.Element {
  // Collapsed by default — tool results can be huge and otherwise dominate the
  // scrollback. Mirrors ToolCallBadge's expand/collapse affordance.
  const [expanded, setExpanded] = useState(false)
  const newlineIdx = message.content.indexOf('\n')
  const firstLine = newlineIdx === -1 ? message.content : message.content.slice(0, newlineIdx)
  // Everything after the first line; that line already shows in the header row.
  const rest = newlineIdx === -1 ? '' : message.content.slice(newlineIdx + 1)

  return (
    <div className="mb-4 animate-fade-in">
      <div className="flex items-start gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-800">
          <Wrench size={14} className="text-neutral-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative rounded-lg border border-neutral-800 bg-neutral-900/50">
            <CopyButton text={message.content} className="absolute right-1.5 top-1.5" />
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex w-full items-center gap-2 py-2 pl-3 pr-9 text-xs text-neutral-400 hover:text-neutral-300 transition-colors"
            >
              <span className="font-jetbrains min-w-0 flex-1 truncate text-left">
                {firstLine}
              </span>
              {expanded ? (
                <ChevronDown size={12} className="shrink-0" />
              ) : (
                <ChevronRight size={12} className="shrink-0" />
              )}
            </button>
            {expanded && rest.trim() && (
              <div className="px-3 pb-2">
                <pre className="font-jetbrains overflow-x-auto text-xs text-neutral-400">
                  {rest.slice(0, 2000)}
                  {rest.length > 2000 && '\n…'}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

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

// Map common Pi tool names to a friendly, user-facing label; falls back to the
// raw name so custom/unknown tools still show something. Keyword matching
// mirrors toolIcon() so the label and icon stay in sync.
export function toolLabel(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('bash') || n.includes('shell') || n.includes('exec') || n.includes('terminal')) return 'Run command'
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'Search'
  if (n.includes('web') || n.includes('fetch') || n.includes('http') || n.includes('url')) return 'Fetch URL'
  if (n.includes('edit') || n.includes('replace') || n.includes('patch')) return 'Edit file'
  if (n.includes('write') || n.includes('create')) return 'Write file'
  if (n.includes('list') || n.startsWith('ls') || n.includes('tree') || n.includes('dir')) return 'List files'
  if (n.includes('read') || n.includes('view') || n.includes('cat') || n.includes('file')) return 'Read file'
  return name
}

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
