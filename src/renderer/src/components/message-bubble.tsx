import { memo, useState, useRef } from 'react'
import { useAppStore, type DisplayMessage } from '../store'
import { MarkdownRenderer } from './markdown-renderer'
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
  FileText,
  Send,
  Terminal,
  Search,
  Globe,
  Pencil,
  FilePlus,
  List,
  type LucideIcon,
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

  const handleExport = async () => {
    const exportContent = formatMessageForExport(message)
    await navigator.clipboard.writeText(exportContent)
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
            className="w-full rounded-2xl rounded-br-md bg-blue-600 px-4 py-2.5 text-sm text-white resize-none min-h-[40px] max-h-48 outline-none"
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
        <div className="rounded-2xl rounded-br-md bg-blue-600 px-4 py-2.5 text-sm text-white">
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
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
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
            <div className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
              <span>{message.provider}</span>
              <span className="text-neutral-700">·</span>
              <span>{message.model}</span>
              {message.cost !== undefined && (
                <>
                  <span className="text-neutral-700">·</span>
                  <span>${message.cost.toFixed(4)}</span>
                </>
              )}
            </div>
          )}

          {/* Thinking block */}
          {message.thinking && (
            <div className="mb-2">
              <button
                onClick={onToggleThinking}
                className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-400 transition-colors"
              >
                <Brain size={12} />
                {showThinking ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Thinking
              </button>
              {showThinking && (
                <div className="mt-1 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
                  <MarkdownRenderer content={message.thinking} />
                </div>
              )}
            </div>
          )}

          {/* Text content */}
          {message.content && (
            <div className="markdown-body">
              <MarkdownRenderer content={message.content} />
            </div>
          )}

          {/* Tool calls */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="mt-2 space-y-1">
              {message.toolCalls.map((tc) => (
                <ToolCallBadge key={tc.id} toolCall={tc} />
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="mt-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <ActionButton
              icon={copied ? <Check size={11} /> : <Copy size={11} />}
              onClick={onCopy}
              title={copied ? 'Copied' : 'Copy'}
              label={copied ? 'Copied' : 'Copy'}
            />
            <ActionButton icon={<Download size={11} />} onClick={onExport} title="Export" />
          </div>
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
  const Icon = toolIcon(toolCall.name)

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-neutral-400 hover:text-neutral-300 transition-colors"
      >
        <Icon size={12} className="shrink-0" />
        <span className="font-medium">{toolCall.name}</span>
        {toolCall.durationMs !== undefined && !toolCall.isExecuting && (
          <span className="text-[10px] text-neutral-600">{formatDuration(toolCall.durationMs)}</span>
        )}
        {toolCall.isError !== undefined && (
          <span className={clsx(
            'ml-auto rounded px-1.5 py-0.5 text-[10px]',
            toolCall.isError ? 'bg-red-900/30 text-red-400' : 'bg-emerald-900/30 text-emerald-400'
          )}>
            {toolCall.isError ? 'error' : 'done'}
          </span>
        )}
        {toolCall.isExecuting && (
          <span className="ml-auto text-yellow-500 animate-pulse">running</span>
        )}
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && (
        <div className="border-t border-neutral-800 px-3 py-2">
          <pre className="overflow-x-auto text-xs text-neutral-500">
            {formatToolCallArgs(toolCall.arguments)}
          </pre>
          {toolCall.result && (
            <div className="mt-2 border-t border-neutral-800 pt-2">
              <pre className="overflow-x-auto text-xs text-neutral-400">
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
  return (
    <div className="mb-4 animate-fade-in">
      <div className="flex items-start gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-800">
          <Wrench size={14} className="text-neutral-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
            <pre className="overflow-x-auto text-xs text-neutral-400">
              {message.content.slice(0, 500)}
              {message.content.length > 500 && '...'}
            </pre>
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

// Map common Pi tool names to a representative icon; falls back to a wrench.
function toolIcon(name: string): LucideIcon {
  const n = name.toLowerCase()
  if (n.includes('bash') || n.includes('shell') || n.includes('exec') || n.includes('terminal')) return Terminal
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return Search
  if (n.includes('web') || n.includes('fetch') || n.includes('http') || n.includes('url')) return Globe
  if (n.includes('edit') || n.includes('replace') || n.includes('patch')) return Pencil
  if (n.includes('write') || n.includes('create')) return FilePlus
  if (n.includes('list') || n.startsWith('ls') || n.includes('tree') || n.includes('dir')) return List
  if (n.includes('read') || n.includes('view') || n.includes('cat') || n.includes('file')) return FileText
  return Wrench
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

function formatMessageForExport(message: DisplayMessage): string {
  const lines: string[] = []

  if (message.role === 'user') {
    lines.push(`## User`)
    lines.push(message.content)
  } else if (message.role === 'assistant') {
    lines.push(`## Assistant`)
    if (message.model) {
      lines.push(`*Model: ${message.provider}/${message.model}*`)
    }
    if (message.thinking) {
      lines.push(`\n<details><summary>Thinking</summary>\n\n${message.thinking}\n\n</details>\n`)
    }
    lines.push(message.content)
  } else if (message.role === 'toolResult') {
    lines.push(`## Tool Result`)
    lines.push('```')
    lines.push(message.content.slice(0, 1000))
    lines.push('```')
  }

  return lines.join('\n')
}
