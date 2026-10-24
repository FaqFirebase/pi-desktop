import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { clsx } from 'clsx'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import {
  AlertCircle,
  ArrowDown,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Cpu,
  ExternalLink,
  FileText,
  Folder,
  FolderPlus,
  Home,
  ImageOff,
  Loader2,
  MessageSquare,
  Pin,
  Paperclip,
  Plus,
  Radio,
  Search,
  Send,
  Shield,
  ShieldAlert,
  Square,
  Wrench,
  X,
} from 'lucide-react'
import { isFileDrag } from '../../../shared/folder-drop'
import { splitAttachedFiles } from '../../../shared/untrusted-data'
import { droppedAttachmentFiles, readDroppedAttachment } from '../utils/dropped-attachments'
import { availableLanguages, i18n, t } from '../../../shared/i18n'
import { resolveLanguage } from '../../../shared/i18n/resolve'
import type { PiExtensionUiRequest } from '../../../shared/ipc-contracts'
import type { QuickChatApi } from '../../../shared/quick-chat'
import type { DisplayMessage } from '../message-parsing'
import { groupToolMessages, prepareChatMessages } from '../message-grouping'
import { applyThemeSettings, setUserThemes } from '../utils/theme'
import { applyUiFont } from '../utils/ui-font'
import { formatRelativeTime } from '../utils/format-relative-time'
import { formatShortcut } from '../../../shared/keyboard-shortcuts'
import { DEFAULT_PERMISSION_MODE, getPermissionModeDescription, getPermissionModeLabel } from '../components/permission-mode'
import { QuickChatController, type QuickChatState } from './controller'
import { composerKeyAction, modelShortName, selectedTarget, targetOptions, targetStatusLabel } from './presentation'
import { ModelPicker } from './model-picker'
import './quick-chat.css'

function CodeBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  const handleCopy = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const text = preRef.current?.textContent ?? ''
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="relative group/code my-2 rounded-lg border border-border bg-md-pre-bg overflow-hidden">
      <div className="absolute right-2 top-2 opacity-0 group-hover/code:opacity-100 transition-opacity z-10">
        <button
          type="button"
          onClick={handleCopy}
          className="p-1 rounded bg-surface/90 hover:bg-surface text-dim hover:text-primary transition-colors border border-border/50 shadow-xs"
          title={copied ? t('common.copied') : t('common.copy')}
        >
          {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
        </button>
      </div>
      <pre ref={preRef} className="p-3 overflow-x-auto text-xs font-mono text-secondary">
        {children}
      </pre>
    </div>
  )
}

// Component identity must survive re-renders or React remounts code blocks
// (and their horizontal scroll positions) on every message update. Module-level
// components are stable by identity, exactly as the main window's
// markdown-renderer does with useMemo.
const markdownComponents: Components = {
  // Links are deliberately inert. The popup has no file/external navigation API,
  // and must never resolve A's relative files through main's active workspace B.
  a: ({ children: label, href }) => (
    <span className="text-accent-fg font-medium cursor-default" title={href}>{label}</span>
  ),
  img: ({ alt }) => <span>{alt}</span>,
  code: ({ className, children: codeChildren, ...props }) => {
    const isInline = !className && typeof codeChildren === 'string' && !codeChildren.includes('\n')
    if (isInline) {
      return (
        <code className="px-1.5 py-0.5 rounded bg-surface border border-border text-[11px] font-mono text-secondary" {...props}>
          {codeChildren}
        </code>
      )
    }
    return <code className="font-mono text-[11px]" {...props}>{codeChildren}</code>
  },
  pre: ({ children: preChildren }) => (
    <CodeBlock>{preChildren}</CodeBlock>
  ),
  hr: () => <hr className="my-3 border-t border-border/40 border-b-0" />,
  h1: ({ children: h1Children }) => <h1 className="text-sm font-bold text-primary mt-3 mb-1.5 first:mt-0">{h1Children}</h1>,
  h2: ({ children: h2Children }) => <h2 className="text-xs font-bold text-primary mt-2.5 mb-1 first:mt-0">{h2Children}</h2>,
  h3: ({ children: h3Children }) => <h3 className="text-xs font-semibold text-primary mt-2 mb-1 first:mt-0">{h3Children}</h3>,
  p: ({ children: pChildren }) => <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed">{pChildren}</p>,
  ul: ({ children: ulChildren }) => <ul className="list-disc pl-4 my-1.5 space-y-0.5 leading-relaxed">{ulChildren}</ul>,
  ol: ({ children: olChildren }) => <ol className="list-decimal pl-4 my-1.5 space-y-0.5 leading-relaxed">{olChildren}</ol>,
  blockquote: ({ children: bChildren }) => (
    <blockquote className="border-l-2 border-border-strong pl-3 my-1.5 text-muted italic">
      {bChildren}
    </blockquote>
  ),
  table: ({ children: tChildren }) => (
    <div className="overflow-x-auto my-2 rounded-lg border border-border">
      <table className="w-full text-xs text-left border-collapse">{tChildren}</table>
    </div>
  ),
  th: ({ children: thChildren }) => (
    <th className="px-2.5 py-1.5 font-semibold bg-surface border-b border-border text-primary">{thChildren}</th>
  ),
  td: ({ children: tdChildren }) => (
    <td className="px-2.5 py-1.5 border-b border-border/50 text-secondary">{tdChildren}</td>
  ),
}

const Markdown = memo(function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  )
})

function ToolResultItem({ message }: { message: DisplayMessage }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const newlineIdx = message.content.indexOf('\n')
  const firstLine = newlineIdx === -1 ? message.content.trim() : message.content.slice(0, newlineIdx).trim()
  const rest = newlineIdx === -1 ? '' : message.content.slice(newlineIdx + 1).trim()
  const expandable = rest.length > 0

  return (
    <div className="my-1 text-xs animate-message-in">
      <div className="rounded-lg border border-border/60 bg-surface/30 overflow-hidden">
        <button
          type="button"
          onClick={() => { if (expandable) setExpanded(!expanded) }}
          className={clsx(
            'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] font-mono transition-colors',
            expandable ? 'hover:bg-surface-hover/50 cursor-pointer text-secondary' : 'cursor-default text-muted'
          )}
        >
          <div className="flex items-center gap-1.5 min-w-0 flex-1 truncate">
            <span className="font-semibold text-accent shrink-0">{message.toolName || t('quickChat.tool')}:</span>
            <span className="truncate text-muted">{firstLine || 'Done'}</span>
          </div>
          {expandable && (
            <span className="text-dim shrink-0">
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
          )}
        </button>
        {expanded && rest && (
          <div className="px-2.5 py-2 border-t border-border/40 font-mono text-[11px] text-muted overflow-x-auto max-h-48 bg-card/40">
            <pre className="whitespace-pre-wrap break-words">{rest}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

function ToolGroupItem({
  title,
  messages,
  showThinking,
}: {
  title: string
  messages: DisplayMessage[]
  showThinking: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="my-1.5 rounded-lg border border-border/60 bg-surface/30 overflow-hidden text-xs animate-message-in">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left text-dim hover:text-primary hover:bg-surface-hover/50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 font-medium text-[11px]">
          <Wrench size={12} className="text-accent shrink-0" />
          <span className="truncate">{title}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted shrink-0 text-[10px]">
          <span>{messages.length}</span>
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </div>
      </button>

      {expanded && (
        <div className="p-2.5 border-t border-border/40 space-y-2 bg-card/20">
          {messages.map((m) => (
            <Message key={m.id} message={m} showThinking={showThinking} />
          ))}
        </div>
      )}
    </div>
  )
}

function Message({
  message,
  showThinking,
}: {
  message: DisplayMessage
  showThinking: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [thinkingOpen, setThinkingOpen] = useState(message.initiallyShowThinking ?? false)

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (message.role === 'user') {
    const attached = splitAttachedFiles(message.content)
    const hasChips = (message.attachments?.length ?? 0) > 0 || attached.fileNames.length > 0
    return (
      <article className="flex justify-end group/user animate-message-in" aria-label={t('quickChat.you')}>
        <div className="relative max-w-[85%]">
          <div className="rounded-2xl rounded-br-sm bg-card border border-border px-3.5 py-2 text-xs text-primary leading-relaxed break-words font-chat shadow-xs">
            {hasChips && (
              <div className={clsx('flex flex-wrap gap-1.5', attached.text && 'mb-2')}>
                {message.attachments?.map((attachment, index) => (
                  <div
                    key={`${attachment.name}-${index}`}
                    className="overflow-hidden rounded-md border border-border bg-surface/60"
                    title={attachment.name}
                  >
                    {attachment.data ? (
                      <img
                        src={`data:${attachment.mimeType};base64,${attachment.data}`}
                        alt={attachment.name}
                        className="h-14 w-14 object-cover"
                      />
                    ) : (
                      <div className="flex h-14 w-14 items-center justify-center text-muted" aria-label={attachment.name}>
                        <ImageOff size={16} />
                      </div>
                    )}
                  </div>
                ))}
                {attached.fileNames.map((name, index) => (
                  <div
                    key={`${name}-${index}`}
                    className="flex max-w-56 items-center gap-1.5 rounded-md border border-border bg-surface/60 px-2 py-1 text-[11px] text-secondary"
                    title={name}
                  >
                    <FileText size={11} className="shrink-0 text-muted" aria-hidden="true" />
                    <span className="truncate">{name}</span>
                  </div>
                ))}
              </div>
            )}
            {attached.text && <div>{attached.text}</div>}
          </div>
          <div className="absolute right-0 top-full pt-0.5 opacity-0 group-hover/user:opacity-100 transition-opacity flex items-center justify-end z-10">
            <button
              type="button"
              onClick={handleCopy}
              className="p-1 rounded text-dim hover:text-primary hover:bg-surface transition-colors"
              title={copied ? t('common.copied') : t('common.copy')}
            >
              {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
            </button>
          </div>
        </div>
      </article>
    )
  }

  if (message.role === 'toolResult') {
    return <ToolResultItem message={message} />
  }

  const hasText = message.content.trim().length > 0
  const hasThinking = Boolean(showThinking && message.thinking)
  const hasTools = (message.toolCalls?.length ?? 0) > 0

  return (
    <article className="flex flex-col space-y-1.5 group/assistant max-w-full animate-message-in">
      {hasText && (
        <div className="flex items-center justify-between text-[11px] text-muted">
          <div className="flex items-center gap-1.5 font-medium text-dim">
            <Bot size={13} className="text-accent shrink-0" />
            <span>{message.role === 'assistant' ? t('quickChat.assistant') : t('quickChat.notice')}</span>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="opacity-0 group-hover/assistant:opacity-100 p-1 rounded text-dim hover:text-primary hover:bg-surface transition-all"
            title={copied ? t('common.copied') : t('common.copy')}
          >
            {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
          </button>
        </div>
      )}

      {hasThinking && (
        <div className="rounded-lg border border-border/60 bg-surface/40 p-2 text-xs">
          <button
            type="button"
            onClick={() => setThinkingOpen(!thinkingOpen)}
            className="flex items-center gap-1.5 font-medium text-dim hover:text-muted transition-colors w-full text-left"
          >
            <Brain size={12} className="text-special" />
            <span>{t('quickChat.thinking')}</span>
            {thinkingOpen ? <ChevronDown size={11} className="ml-auto" /> : <ChevronRight size={11} className="ml-auto" />}
          </button>
          {thinkingOpen && (
            <div className="mt-1.5 pt-1.5 border-t border-border/40 text-xs italic text-muted leading-relaxed font-chat">
              <Markdown>{message.thinking!}</Markdown>
            </div>
          )}
        </div>
      )}

      {hasText && (
        <div className="font-chat text-xs leading-relaxed text-primary break-words [overflow-wrap:anywhere]">
          <Markdown>{message.content}</Markdown>
        </div>
      )}

      {hasTools && message.toolCalls?.map((tool) => (
        <div
          key={tool.id || tool.name}
          className={clsx(
            'flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs font-mono my-0.5 transition-colors',
            tool.isExecuting
              ? 'bg-surface border-accent/40 text-primary'
              : tool.isError
                ? 'bg-error-bg/20 border-error/30 text-error'
                : 'bg-card/50 border-border text-muted'
          )}
        >
          {tool.isExecuting ? (
            <Loader2 size={11} className="animate-spin text-accent shrink-0" />
          ) : tool.isError ? (
            <AlertCircle size={11} className="text-error shrink-0" />
          ) : (
            <CheckCircle2 size={11} className="text-success shrink-0" />
          )}
          <span className="truncate">
            {tool.isExecuting
              ? t('quickChat.toolRunning', { name: tool.name })
              : tool.isError
                ? t('quickChat.toolError', { name: tool.name })
                : t('quickChat.toolCall', { name: tool.name })}
          </span>
        </div>
      ))}

      {message.isError && (
        <div className="text-xs text-error flex items-center gap-1.5 mt-1">
          <AlertCircle size={12} className="shrink-0" />
          <span>{t('quickChat.toolFailed')}</span>
        </div>
      )}

      {message.stopped && (
        <div className="text-[11px] text-muted flex items-center gap-1 mt-1">
          <Square size={10} className="shrink-0" />
          <span>{t('quickChat.stopped')}</span>
        </div>
      )}
    </article>
  )
}

function Approval({
  request,
  answering,
  controller,
}: {
  request: PiExtensionUiRequest
  answering: boolean
  controller: QuickChatController
}): React.JSX.Element {
  const [value, setValue] = useState(request.prefill ?? '')
  const input = useRef<HTMLTextAreaElement | HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])

  return (
    <section className="mx-3 my-2 p-3.5 rounded-xl border border-warning/40 bg-surface shadow-xl flex flex-col gap-2.5 animate-fade-in shrink-0" aria-label={t('quickChat.needsApproval')}>
      <div className="flex items-center gap-2 text-warning font-semibold text-xs">
        <ShieldAlert size={15} className="shrink-0" />
        <h2>{request.title || t('quickChat.needsApproval')}</h2>
      </div>
      {(request.message || request.instructions) && (
        <div className="max-h-44 overflow-y-auto -mr-1 pr-1 space-y-2">
          {request.message && (
            <p className="text-xs text-primary whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]">{request.message}</p>
          )}
          {request.instructions && <p className="text-[11px] text-muted leading-normal">{request.instructions}</p>}
        </div>
      )}

      {request.method === 'select' ? (
        <div className="flex flex-wrap gap-1.5 my-1">
          {request.options?.map((option, index) => (
            <button
              disabled={answering}
              key={`${index}:${option}`}
              onClick={() => { void controller.answer({ value: option }) }}
              className="px-2.5 py-1 rounded-md text-xs border border-border bg-card hover:bg-surface-hover text-primary transition-colors disabled:opacity-50"
            >
              {option}
            </button>
          ))}
        </div>
      ) : request.method === 'input' ? (
        <input
          ref={(element) => { input.current = element }}
          value={value}
          placeholder={request.placeholder}
          disabled={answering}
          aria-label={request.title || t('quickChat.answer')}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault()
              void controller.answer({ value })
            }
          }}
          className="w-full px-2.5 py-1.5 rounded-md border border-border-strong bg-card text-xs text-primary focus:border-focus outline-none"
        />
      ) : request.method === 'editor' ? (
        <textarea
          ref={(element) => { input.current = element }}
          rows={4}
          value={value}
          placeholder={request.placeholder}
          disabled={answering}
          aria-label={request.title || t('quickChat.answer')}
          onChange={(event) => setValue(event.target.value)}
          className="w-full px-2.5 py-1.5 rounded-md border border-border-strong bg-card text-xs text-primary focus:border-focus outline-none resize-y"
        />
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1 border-t border-border/40">
        <button
          disabled={answering}
          onClick={() => { void controller.cancelRequest() }}
          className="px-3 py-1 rounded-md text-xs border border-border bg-card hover:bg-surface-hover text-secondary transition-colors disabled:opacity-50"
        >
          {request.method === 'confirm' ? t('quickChat.deny') : t('quickChat.cancel')}
        </button>
        {request.method === 'confirm' && (
          <button
            disabled={answering}
            onClick={() => { void controller.answer({ confirmed: true }) }}
            className="px-3 py-1 rounded-md text-xs bg-accent hover:bg-accent-hover text-white font-medium shadow-xs transition-colors disabled:opacity-50"
          >
            {t('quickChat.allow')}
          </button>
        )}
        {(request.method === 'input' || request.method === 'editor') && (
          <button
            disabled={answering}
            onClick={() => { void controller.answer({ value }) }}
            className="px-3 py-1 rounded-md text-xs bg-accent hover:bg-accent-hover text-white font-medium shadow-xs transition-colors disabled:opacity-50"
          >
            {t('quickChat.answer')}
          </button>
        )}
      </div>
      <p className="text-[10px] text-muted text-right">{t('quickChat.escapeDoesNotDeny')}</p>
    </section>
  )
}

export function QuickChatApp({ api = window.piQuickChat }: { api?: QuickChatApi }): React.JSX.Element {
  const controller = useMemo(() => new QuickChatController(api), [api])
  const state = useSyncExternalStore(controller.subscribe, controller.getState)
  const [dropdown, setDropdown] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelPickerTab, setModelPickerTab] = useState<'model' | 'thinking'>('model')
  const [filter, setFilter] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [isEntering, setIsEntering] = useState(true)
  const [isExiting, setIsExiting] = useState(false)
  const [, languageChanged] = useState(0)
  const [pinned, setPinned] = useState(false)
  const composing = useRef(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const pickerAnchor = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const dropdownRef = useRef<HTMLDivElement>(null)
  const sessionButtonRef = useRef<HTMLButtonElement>(null)
  const projectPickerRef = useRef<HTMLDivElement>(null)
  const projectButtonRef = useRef<HTMLButtonElement>(null)
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const dragDepth = useRef(0)
  const scrollAtBottom = useRef(true)
  const context = state.context
  const platform = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? 'darwin' : 'win32'
  const options = useMemo(() => context ? targetOptions(context) : [], [context])
  const selected = selectedTarget(options, state.binding)
  const workspace = state.mode === 'session'
    ? context?.workspaces.find((item) => item.id === state.binding?.runtime.workspaceId)
    : state.workspaceId
      ? context?.workspaces.find((item) => item.id === state.workspaceId)
      : undefined
  const matching = options.filter((option) =>
    `${option.title} ${option.workspace} ${option.path}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
  )
  const renderItems = useMemo(
    () => groupToolMessages(prepareChatMessages(state.messages), t, state.busy),
    [state.messages, state.busy]
  )
  const activeRuntimes = useMemo(() => {
    return context?.runtimes.filter((r) => !r.closed && (r.activity === 'working' || r.activity === 'needs-approval')) ?? []
  }, [context?.runtimes])

  useEffect(() => {
    controller.start()
    return () => controller.dispose()
  }, [controller])

  useEffect(() => {
    const update = (): void => languageChanged((value) => value + 1)
    i18n.on('languageChanged', update)
    return () => { i18n.off('languageChanged', update) }
  }, [])
  useEffect(() => {
    if (!dropdown) return
    const handleOutside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        !sessionButtonRef.current?.contains(target)
      ) {
        setDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [dropdown])

  useEffect(() => {
    if (!projectPickerOpen) return
    const handleOutside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (
        projectPickerRef.current &&
        !projectPickerRef.current.contains(target) &&
        !projectButtonRef.current?.contains(target)
      ) {
        setProjectPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [projectPickerOpen])

  const handleAttachFiles = (files: File[]): Promise<void> => controller.readAttachments(
    files.map((file) => ({ label: file.name, path: file.name, read: () => readDroppedAttachment(file) })),
  )

  const handleDragEnter = (e: React.DragEvent): void => {
    if (!isFileDrag(e.dataTransfer)) return
    e.preventDefault()
    dragDepth.current++
    setIsDraggingFile(true)
  }
  const handleDragOver = (e: React.DragEvent): void => {
    if (!isFileDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (e: React.DragEvent): void => {
    if (!isFileDrag(e.dataTransfer)) return
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDraggingFile(false)
  }
  const handleDrop = (e: React.DragEvent): void => {
    dragDepth.current = 0
    setIsDraggingFile(false)
    if (!isFileDrag(e.dataTransfer)) return
    e.preventDefault()
    const files = droppedAttachmentFiles(e.dataTransfer)
    if (files.length > 0) void handleAttachFiles(files)
  }

  const settings = context?.settings
  const themes = context?.themes
  const environment = context?.i18nEnvironment
  const theme = settings?.theme
  const systemLightTheme = settings?.systemLightTheme
  const systemDarkTheme = settings?.systemDarkTheme
  const fontFamily = settings?.uiFontFamily
  const fontSize = settings?.fontSize
  const languageSetting = settings?.language

  useEffect(() => {
    if (!themes || !theme || !systemLightTheme || !systemDarkTheme) return
    setUserThemes(themes)
    const themeSettings = { theme, systemLightTheme, systemDarkTheme }
    applyThemeSettings(themeSettings)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applySystem = (): void => { if (theme === 'system') applyThemeSettings(themeSettings) }
    media.addEventListener('change', applySystem)
    return () => media.removeEventListener('change', applySystem)
  }, [themes, theme, systemLightTheme, systemDarkTheme])

  useEffect(() => {
    if (fontFamily !== undefined) applyUiFont(fontFamily)
    if (fontSize !== undefined) document.documentElement.style.fontSize = `${fontSize}px`
  }, [fontFamily, fontSize])

  useEffect(() => {
    if (!environment || !languageSetting) return
    const language = resolveLanguage(languageSetting, environment.systemLanguages, availableLanguages(environment.pseudoLanguageEnabled))
    void i18n.changeLanguage(language)
    document.documentElement.lang = language
  }, [environment, languageSetting])

  useEffect(() => {
    const timer = setTimeout(() => setIsEntering(false), 120)
    return () => clearTimeout(timer)
  }, [])


  const togglePin = (): void => {
    const next = !pinned
    setPinned(next)
    void api.setPinned(next)
  }

  useEffect(() => {
    const handleFocus = (): void => {
      setIsExiting(false)
      if (!state.request && !dropdown && !projectPickerOpen && !modelPickerOpen) {
        editor.current?.focus()
      }
    }
    window.addEventListener('focus', handleFocus)
    handleFocus()
    return () => {
      window.removeEventListener('focus', handleFocus)
    }
  }, [dropdown, projectPickerOpen, modelPickerOpen, state.request, state.mode])

  useEffect(() => {
    if (dropdown) search.current?.focus()
  }, [dropdown])

  useEffect(() => {
    if (dropdown && optionRefs.current[highlight]) {
      optionRefs.current[highlight]?.scrollIntoView({ block: 'nearest' })
    }
  }, [dropdown, highlight])

  useEffect(() => {
    if (scrollAtBottom.current && transcript.current) {
      transcript.current.scrollTop = transcript.current.scrollHeight
    }
  }, [state.messages, state.content, state.thinking, state.tools, state.request])


  const scrollToBottom = (): void => {
    if (transcript.current) {
      transcript.current.scrollTop = transcript.current.scrollHeight
      scrollAtBottom.current = true
      setIsAtBottom(true)
    }
  }

  const dismiss = (): void => {
    setIsExiting(true)
    setTimeout(() => {
      void controller.hide()
      setIsExiting(false)
    }, 100)
  }

  const beginNewTask = (): void => {
    setDropdown(false)
    setProjectPickerOpen(false)
    setModelPickerOpen(false)
    void controller.newTask().then(() => {
      scrollAtBottom.current = true
      editor.current?.focus()
    })
  }

  const handleKeys = (event: KeyboardEvent<HTMLElement>): void => {
    const action = composerKeyAction(
      { key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode },
      composing.current,
      dropdown || projectPickerOpen || modelPickerOpen,
      platform
    )
    if (action === 'hide' || action === 'close-dropdown' || action === 'new-task') {
      event.preventDefault()
      event.stopPropagation()
      if (action === 'close-dropdown') {
        setDropdown(false)
        setProjectPickerOpen(false)
        setModelPickerOpen(false)
      } else if (action === 'new-task') {
        beginNewTask()
      } else {
        dismiss()
      }
    } else if (action === 'submit' && event.target === editor.current) {
      event.preventDefault()
      void controller.submit()
    }
  }

  const runtime = state.binding?.runtime
  const isWorking = state.busy || runtime?.activity === 'working'
  const needsApproval = Boolean(state.request || runtime?.activity === 'needs-approval')
  const isFailed = runtime?.status === 'error' || runtime?.activity === 'failed'
  const isStopped = runtime?.status === 'stopped'
  const isStarting = runtime?.status === 'starting'
  const isReady = runtime?.status === 'running' && !isWorking && !needsApproval

  let statusIndicator: React.ReactNode
  let runtimeStatusTitle: string

  if (state.loading || state.selecting) {
    statusIndicator = <Loader2 size={10} className="animate-spin text-muted" />
    runtimeStatusTitle = t('quickChat.loading')
  } else if (needsApproval) {
    statusIndicator = <span className="inline-flex rounded-full h-1.5 w-1.5 bg-warning animate-pulse shadow-xs" />
    runtimeStatusTitle = t('quickChat.needsApproval')
  } else if (isWorking) {
    statusIndicator = (
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
      </span>
    )
    runtimeStatusTitle = t('quickChat.working')
  } else if (isFailed) {
    statusIndicator = <span className="inline-flex rounded-full h-1.5 w-1.5 bg-error shadow-xs" />
    runtimeStatusTitle = t('quickChat.failed')
  } else if (isStopped) {
    statusIndicator = <span className="inline-flex rounded-full h-1.5 w-1.5 bg-dim/80" />
    runtimeStatusTitle = t('quickChat.stopped')
  } else if (isStarting) {
    statusIndicator = <span className="inline-flex rounded-full h-1.5 w-1.5 bg-accent/60 animate-pulse" />
    runtimeStatusTitle = t('quickChat.starting')
  } else if (isReady) {
    statusIndicator = <span className="inline-flex rounded-full h-1.5 w-1.5 bg-success shadow-xs" />
    runtimeStatusTitle = t('quickChat.ready')
  } else {
    statusIndicator = <span className="inline-flex rounded-full h-1.5 w-1.5 bg-dim" />
    runtimeStatusTitle = t('quickChat.noSession')
  }

  const picker = (
    <ModelPicker
      api={api}
      open={modelPickerOpen}
      onClose={() => setModelPickerOpen(false)}
      tab={modelPickerTab}
      onTabChange={setModelPickerTab}
      currentModel={state.model}
      preparedModel={state.preparedModel}
      defaultModel={state.mode === 'new' && context?.settings.defaultProvider && context.settings.defaultModel
        ? { provider: context.settings.defaultProvider, modelId: context.settings.defaultModel }
        : null}
      defaultThinkingLevel={state.mode === 'new' ? context?.settings.defaultThinkingLevel ?? null : null}
      thinkingLevel={state.thinkingLevel}
      preparedThinkingLevel={state.preparedThinkingLevel}
      locked={state.busy || !!state.request || state.stopping || state.switching}
      onPickModel={(model) => { void controller.setModelChoice(model) }}
      onPickThinking={(level) => { void controller.setThinkingChoice(level) }}
      anchorRef={pickerAnchor}
      workspaceId={state.mode === 'new' ? state.workspaceId : state.binding?.runtime.workspaceId ?? null}
    />
  )

  const composer = (
    <QuickChatComposer state={state} controller={controller} editor={editor} onAttachFiles={handleAttachFiles} picker={picker} pickerOpen={modelPickerOpen}>
      <ActionPills
        state={state}
        anchorRef={pickerAnchor}
        modelPickerOpen={modelPickerOpen}
        modelPickerTab={modelPickerTab}
        openPicker={(tab) => { setModelPickerTab(tab); setModelPickerOpen(true) }}
        onPickAttachment={() => { void controller.pickAttachment() }}
        onSubmit={() => { void controller.submit() }}
      />
    </QuickChatComposer>
  )

  return (
    <main
      className={clsx('quick-chat', isExiting ? 'qc-exiting' : isEntering ? 'qc-entering' : '')}
      onKeyDown={handleKeys}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDraggingFile && (
        <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-xs border-2 border-dashed border-accent flex flex-col items-center justify-center gap-2 pointer-events-none animate-fade-in">
          <Paperclip size={28} className="text-accent animate-bounce" />
          <p className="text-sm font-medium text-primary">{t('chat.attach.dropHint')}</p>
        </div>
      )}
      {/* ─── Top Unified Navigation Bar ─── */}
      <header className="h-10 px-3 border-b border-border/40 bg-surface/30 backdrop-blur-md flex items-center justify-between gap-2 shrink-0 select-none qc-drag-region">
        <div className="flex flex-1 items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-primary truncate select-none shrink-0" title={state.mode === 'new' ? t('quickChat.newTaskDescription') : t('quickChat.title')}>
            {t('quickChat.title')}
          </span>
          {state.mode === 'new' ? (
            <>
              <button
                ref={projectButtonRef}
                className={clsx(
                  'qc-no-drag group flex items-center gap-1.5 min-w-0 max-w-[160px] h-6 px-2 rounded-full border text-left transition-all text-[11px] font-medium shadow-xs',
                  projectPickerOpen
                    ? 'bg-card border-accent/40 text-primary ring-1 ring-accent/30'
                    : 'bg-surface/60 border-border/60 hover:bg-surface hover:border-border text-secondary hover:text-primary'
                )}
                disabled={state.selecting || state.sending || state.pickingWorkspace}
                aria-expanded={projectPickerOpen}
                aria-haspopup="listbox"
                onClick={() => {
                  setProjectPickerOpen(!projectPickerOpen)
                  setDropdown(false)
                }}
              >
                {state.workspaceId === null ? (
                  <Home size={11} className="text-accent shrink-0" />
                ) : (
                  <Folder size={11} className="text-accent shrink-0" />
                )}
                <span className="truncate leading-none" title={workspace?.name || (state.workspaceId === null ? t('quickChat.noProject') : t('quickChat.chooseProject'))}>
                  {workspace?.name || (state.workspaceId === null ? t('quickChat.noProject') : t('quickChat.chooseProject'))}
                </span>
                <ChevronDown
                  size={10}
                  className={clsx('text-dim group-hover:text-muted transition-transform shrink-0 ml-0.5', projectPickerOpen && 'rotate-180')}
                  aria-hidden="true"
                />
              </button>

              <button
                ref={sessionButtonRef}
                className={clsx(
                  'qc-no-drag group flex items-center gap-1.5 h-6 px-2 rounded-full border text-left transition-all text-[11px] font-medium shadow-xs',
                  dropdown
                    ? 'bg-card border-accent/40 text-primary ring-1 ring-accent/30'
                    : 'bg-surface/60 border-border/60 hover:bg-surface hover:border-border text-secondary hover:text-primary'
                )}
                onClick={() => {
                  setDropdown(!dropdown)
                  setProjectPickerOpen(false)
                  setFilter('')
                  setHighlight(0)
                  if (!dropdown) void controller.refreshContext()
                }}
                title={t('quickChat.chooseSession')}
              >
                <MessageSquare size={11} className="text-dim group-hover:text-primary transition-colors shrink-0" />
                <span>{t('quickChat.sessions')}</span>
                <ChevronDown size={10} className={clsx('text-dim transition-transform shrink-0 ml-0.5', dropdown && 'rotate-180')} />
              </button>
            </>
          ) : (
            <button
              ref={sessionButtonRef}
              className={clsx(
                'qc-no-drag group flex items-center gap-1.5 min-w-0 max-w-[280px] h-6 px-2.5 rounded-full border text-left transition-all text-[11px] font-medium shadow-xs',
                dropdown
                  ? 'bg-card border-accent/40 text-primary ring-1 ring-accent/30'
                  : 'bg-surface/60 border-border/60 hover:bg-surface hover:border-border text-secondary hover:text-primary'
              )}
              disabled={state.selecting || state.sending || state.pickingWorkspace}
              aria-expanded={dropdown}
              aria-haspopup="listbox"
              onClick={() => {
                setDropdown(!dropdown)
                setProjectPickerOpen(false)
                setFilter('')
                setHighlight(0)
                if (!dropdown) void controller.refreshContext()
              }}
            >
              <span className="shrink-0 flex items-center justify-center" title={runtimeStatusTitle}>
                {statusIndicator}
              </span>

              <span className="text-muted truncate max-w-[90px]" title={workspace?.name}>
                {workspace?.name}
              </span>
              <span className="text-dim/60 shrink-0">/</span>
              <span className="truncate max-w-[140px] font-semibold text-primary" title={selected?.title || t('quickChat.untitledSession')}>
                {selected?.title || t('quickChat.untitledSession')}
              </span>

              <ChevronDown
                size={10}
                className={clsx(
                  'text-dim group-hover:text-muted transition-transform shrink-0 ml-0.5',
                  dropdown && 'rotate-180'
                )}
                aria-hidden="true"
              />
            </button>
          )}

          {activeRuntimes.length > 0 && (
            <button
              type="button"
              onClick={() => {
                const approvalTask = activeRuntimes.find((r) => r.activity === 'needs-approval')
                if (approvalTask) {
                  void controller.select({ runtimeId: approvalTask.runtimeId })
                } else if (activeRuntimes.length === 1) {
                  void controller.select({ runtimeId: activeRuntimes[0].runtimeId })
                } else {
                  setDropdown(true)
                }
              }}
              className={clsx(
                'qc-no-drag flex min-w-0 items-center gap-1.5 h-6 px-2 rounded-full border text-[11px] font-medium transition-all shadow-xs',
                activeRuntimes.some((r) => r.activity === 'needs-approval')
                  ? 'bg-warning/15 hover:bg-warning/25 border-warning/40 text-warning'
                  : 'bg-accent/15 hover:bg-accent/25 border-accent/40 text-accent'
              )}
              title={activeRuntimes.some((r) => r.activity === 'needs-approval') ? t('quickChat.needsApproval') : t('quickChat.viewActive')}
            >
              {activeRuntimes.some((r) => r.activity === 'needs-approval') ? (
                <ShieldAlert size={11} className="text-warning shrink-0" />
              ) : (
                <span className="relative flex h-1.5 w-1.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
                </span>
              )}
              <span className="truncate max-w-[130px]">
                {activeRuntimes.some((r) => r.activity === 'needs-approval')
                  ? t('quickChat.needsApproval')
                  : activeRuntimes.length === 1
                    ? (context?.sessions.find((s) => s.path === activeRuntimes[0].sessionPath)?.name || activeRuntimes[0].sessionId || t('quickChat.working'))
                    : t('quickChat.activeTasksCount', { count: activeRuntimes.length })}
              </span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {state.mode === 'session' && (
            <button
              type="button"
              className="qc-no-drag flex items-center justify-center h-7 w-7 rounded-lg text-dim hover:text-primary hover:bg-surface-hover transition-colors"
              title={t('quickChat.newTaskTitle', { shortcut: formatShortcut('Mod+N', platform) })}
              disabled={state.selecting || state.sending || state.pickingWorkspace}
              onClick={beginNewTask}
            >
              <Plus size={14} />
            </button>
          )}

          {(state.busy || state.request) && (
            <button
              type="button"
              className="qc-no-drag flex items-center gap-1 h-7 px-2 rounded-lg bg-error-bg/30 text-error hover:bg-error-bg/50 border border-error/40 text-xs font-medium transition-colors"
              disabled={state.stopping}
              title={t('quickChat.stopTask')}
              onClick={() => { void controller.stop() }}
            >
              {state.stopping ? <Loader2 size={11} className="animate-spin" /> : <Square size={11} className="fill-current" />}
              <span>{t('quickChat.stop')}</span>
            </button>
          )}
          <button
            type="button"
            className={clsx(
              'qc-no-drag flex items-center justify-center h-7 w-7 rounded-lg transition-colors',
              pinned
                ? 'text-accent bg-accent/15 border border-accent/30 shadow-xs'
                : 'text-dim hover:text-primary hover:bg-surface-hover'
            )}
            title={pinned ? t('quickChat.unpin') : t('quickChat.pin')}
            aria-label={pinned ? t('quickChat.unpin') : t('quickChat.pin')}
            onClick={togglePin}
          >
            <Pin size={13} className={pinned ? 'fill-current' : ''} />
          </button>


          <button
            className="qc-no-drag flex items-center justify-center h-7 w-7 rounded-lg text-dim hover:text-primary hover:bg-surface-hover transition-colors"
            title={t('quickChat.openInMain')}
            aria-label={t('quickChat.open')}
            onClick={() => { void controller.openInMain() }}
          >
            <ExternalLink size={13} />
          </button>
          <button
            className="qc-no-drag flex items-center justify-center h-7 w-7 rounded-lg text-dim hover:text-primary hover:bg-surface-hover transition-colors"
            title={t('quickChat.hide')}
            aria-label={t('quickChat.hide')}
            onClick={dismiss}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {/* ─── Running Accent Line ─── */}
      {state.busy && (
        <div className="h-px w-full bg-accent/60 shrink-0" />
      )}

      {/* ─── Target & Session Dropdown (Picker) ─── */}
      {dropdown && (
        <>
          <div
            className="fixed inset-0 z-20 qc-no-drag"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDropdown(false)
            }}
          />
          <div
            ref={dropdownRef}
            className="absolute top-12 left-3 right-3 z-30 flex flex-col rounded-xl border border-border-strong bg-surface/95 backdrop-blur-md shadow-2xl p-2 animate-dropdown-in qc-no-drag"
          >
            {/* New Task Action Item */}
            <button
              type="button"
              onClick={beginNewTask}
              className="group w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left bg-accent/10 hover:bg-accent/15 border border-accent/25 hover:border-accent/40 text-accent transition-all mb-1.5 shadow-xs"
            >
              <div className="flex items-center gap-2 font-medium text-xs">
                <div className="h-5 w-5 rounded-md bg-accent/15 flex items-center justify-center shrink-0 group-hover:bg-accent/25 transition-colors">
                  <Plus size={12} className="text-accent" />
                </div>
                <span>{t('quickChat.newTask')}</span>
              </div>
              <kbd className="px-1.5 py-0.5 rounded bg-surface/80 border border-accent/30 text-[10px] font-mono leading-none text-accent/90 shadow-xs">
                {formatShortcut('Mod+N', platform)}
              </kbd>
            </button>

            <div className="relative flex items-center mb-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-card focus-within:border-focus focus-within:ring-1 focus-within:ring-focus transition-all">
              <Search size={13} className="text-muted shrink-0 mr-2" />
              <input
                ref={search}
                aria-label={t('quickChat.searchSessions')}
                placeholder={t('quickChat.searchSessions')}
                value={filter}
                className="w-full bg-transparent text-xs text-primary placeholder:text-muted outline-none"
                onChange={(event) => {
                  setFilter(event.target.value)
                  setHighlight(0)
                }}
                onKeyDown={(event) => {
                  if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    setHighlight((value) => {
                      const next = Math.max(0, Math.min(matching.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)))
                      optionRefs.current[next]?.scrollIntoView({ block: 'nearest' })
                      return next
                    })
                  } else if (event.key === 'Enter' && matching[highlight]) {
                    event.preventDefault()
                    void controller.select(matching[highlight].target)
                    setDropdown(false)
                  }
                }}
              />
              {filter && (
                <button
                  type="button"
                  onClick={() => { setFilter(''); setHighlight(0) }}
                  className="text-muted hover:text-primary transition-colors p-0.5"
                  aria-label={t('common.close')}
                >
                  <X size={11} />
                </button>
              )}
            </div>

            <div role="listbox" aria-label={t('quickChat.chooseSession')} className="max-h-60 overflow-y-auto space-y-0.5 pr-0.5">
              {matching.some((item) => item.live) && (
                <div className="px-2 py-1 text-[10px] font-semibold text-muted uppercase tracking-wider">
                  {t('quickChat.recentSessions')}
                </div>
              )}
              {matching.map((option, index) => {
                const isSelected = selected?.key === option.key
                const isHighlighted = index === highlight
                return (
                  <button
                    key={option.key}
                    ref={(el) => { optionRefs.current[index] = el }}
                    role="option"
                    aria-selected={isSelected}
                    title={option.path}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => {
                      void controller.select(option.target)
                      setDropdown(false)
                    }}
                    className={clsx(
                      'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
                      isHighlighted ? 'bg-card text-primary' : 'hover:bg-surface-hover/70 text-secondary'
                    )}
                  >
                    <span className="shrink-0 flex items-center justify-center">
                      {(option.status === 'working' || option.status === 'needs-approval') ? (
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
                        </span>
                      ) : option.live ? (
                        <Radio size={13} className={clsx(option.status === 'failed' ? 'text-error' : option.status === 'starting' ? 'text-accent' : 'text-success')} />
                      ) : (
                        <MessageSquare size={13} className="text-dim" />
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-xs font-medium text-primary">
                        {option.title}
                      </div>
                      <div className="truncate text-[10px] text-muted flex items-center gap-1.5 mt-0.5">
                        <span className="truncate">{option.workspace}</span>
                        <span>·</span>
                        <span className="shrink-0">{targetStatusLabel(option.status)}</span>
                        {option.updatedAt > 0 && (
                          <time className="ml-auto shrink-0 text-faint" dateTime={new Date(option.updatedAt).toISOString()}>
                            {formatRelativeTime(option.updatedAt, Date.now())}
                          </time>
                        )}
                      </div>
                    </div>
                    {isSelected && (
                      <Check size={13} className="text-accent shrink-0 ml-1.5" />
                    )}
                  </button>
                )
              })}
              {!matching.length && (
                <div className="py-6 text-center text-xs text-muted flex flex-col items-center justify-center gap-1.5">
                  <Search size={16} className="text-dim" />
                  <span>{t('quickChat.noMatchingSessions')}</span>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {/* ─── Project Picker Dropdown (Anchored to Header Target Pill) ─── */}
      {projectPickerOpen && (
        <>
          <div
            className="fixed inset-0 z-20 qc-no-drag"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setProjectPickerOpen(false)
            }}
          />
          <div
            ref={projectPickerRef}
            className="absolute top-11 left-3 z-30 min-w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border-strong bg-surface/95 backdrop-blur-md shadow-2xl p-1.5 animate-dropdown-in qc-no-drag"
          >
          <div className="px-2 py-1 text-[10px] font-semibold text-muted uppercase tracking-wider">
            {t('quickChat.project')}
          </div>
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            <button
              type="button"
              onClick={() => {
                controller.setNoProject()
                setProjectPickerOpen(false)
              }}
              className={clsx(
                'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors',
                state.workspaceId === null
                  ? 'bg-card text-primary font-medium'
                  : 'hover:bg-surface-hover text-secondary'
              )}
            >
              <div className="flex items-center gap-2 truncate">
                <Home size={12} className="text-dim shrink-0" />
                <span className="truncate">{t('quickChat.noProject')}</span>
              </div>
              {state.workspaceId === null && <Check size={12} className="text-accent shrink-0" />}
            </button>
            {context?.workspaces.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  controller.setWorkspace(item.id)
                  setProjectPickerOpen(false)
                }}
                className={clsx(
                  'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors',
                  item.id === state.workspaceId
                    ? 'bg-card text-primary font-medium'
                    : 'hover:bg-surface-hover text-secondary'
                )}
              >
                <div className="flex items-center gap-2 truncate">
                  <Folder size={12} className="text-dim shrink-0" />
                  <span className="truncate">{item.name}</span>
                </div>
                {item.id === state.workspaceId && <Check size={12} className="text-accent shrink-0" />}
              </button>
            ))}
            {!context?.workspaces.length && (
              <div className="px-2 py-3 text-center text-xs text-muted">
                {t('quickChat.noWorkspaces')}
              </div>
            )}
          </div>
          <div className="border-t border-border mt-1 pt-1">
            <button
              type="button"
              onClick={() => {
                setProjectPickerOpen(false)
                void controller.pickWorkspace()
              }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs text-accent hover:bg-accent/10 transition-colors font-medium"
            >
              <FolderPlus size={13} />
              <span>{t('quickChat.pickWorkspace')}</span>
              <span className="text-dim text-[10px]">({t('quickChat.browse')})</span>
            </button>
          </div>
        </div>
      </>
    )}

      {/* ─── Status & Errors ─── */}
      {state.status && (
        <div className="px-3 py-1 bg-surface-hover/50 border-b border-border text-[11px] text-muted flex items-center justify-between gap-2 shrink-0" role="status">
          <div className="flex items-center gap-1.5 min-w-0 truncate">
            <Loader2 size={10} className="animate-spin text-muted shrink-0" />
            <span className="truncate">{state.status}</span>
          </div>
          {state.busy && (
            <button
              onClick={() => { void controller.stop() }}
              className="text-[10px] text-error hover:underline shrink-0"
            >
              {t('quickChat.stop')}
            </button>
          )}
        </div>
      )}

      {state.error && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-error-bg/60 border-b border-error/30 text-xs text-error shrink-0" role="alert">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle size={14} className="shrink-0" />
            <span className="truncate">{state.error}</span>
          </div>
          <button
            onClick={() => { void controller.retry() }}
            className="px-2 py-0.5 rounded bg-error/20 hover:bg-error/30 text-error font-medium text-[11px] shrink-0 transition-colors"
          >
            {t('quickChat.retry')}
          </button>
        </div>
      )}

      {/* ─── Main View Routing ─── */}
      {state.mode === 'new' ? (
        /* ═══════════════════════════════════════════════════════════════
           MODE 1: FOLDED NEW TASK LAUNCHER (Compact Capsule Card)
           ═══════════════════════════════════════════════════════════════ */
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {composer}
        </div>
      ) : (
        /* ═══════════════════════════════════════════════════════════════
           MODE 2: SESSION CONVERSATION VIEW
           ═══════════════════════════════════════════════════════════════ */
        <>
          <div
            className={clsx('flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3 relative', modelPickerOpen && 'hidden')}
            ref={transcript}
            onScroll={(event) => {
              const element = event.currentTarget
              const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60
              scrollAtBottom.current = atBottom
              setIsAtBottom(atBottom)
            }}
          >
            {/* Target Unavailable Banner */}
            {!state.binding && !state.loading && (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-xs text-muted">
                <p className="pointer-events-none">{t('quickChat.targetUnavailable')}</p>
                <p className="text-[11px] text-dim pointer-events-none">{t('quickChat.empty')}</p>
                <button
                  type="button"
                  className="qc-no-drag rounded-lg border border-border bg-card px-3 py-1.5 text-primary hover:bg-surface-hover transition-colors"
                  onClick={beginNewTask}
                >
                  {t('quickChat.newTask')}
                </button>
              </div>
            )}

            {/* Empty Session Placeholder */}
            {state.binding && !state.loading && !state.messages.length && !state.content && (
              <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8 text-muted select-none">
                <div className="h-10 w-10 rounded-full bg-surface border border-border flex items-center justify-center mb-3 text-accent pointer-events-none">
                  <MessageSquare size={18} />
                </div>
                <p className="text-xs text-muted max-w-xs leading-relaxed pointer-events-none">{t('quickChat.startConversation')}</p>
              </div>
            )}

            {/* Messages */}
            {renderItems.map((item) =>
              item.kind === 'toolGroup' ? (
                <ToolGroupItem
                  key={item.id}
                  title={item.title}
                  messages={item.messages}
                  showThinking={context?.settings.showThinking ?? DEFAULT_SETTINGS.showThinking}
                />
              ) : (
                <Message
                  key={item.message.id}
                  message={item.message}
                  showThinking={context?.settings.showThinking ?? DEFAULT_SETTINGS.showThinking}
                />
              )
            )}

            {/* Active Streaming Assistant Response */}
            {(state.content || state.thinking) && (
              <article className="flex flex-col space-y-1.5 max-w-full animate-fade-in" aria-live="off">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-dim">
                  <Bot size={13} className="text-accent shrink-0" />
                  <span>{t('quickChat.assistant')}</span>
                  <span className="h-1.5 w-1.5 rounded-full bg-accent ml-1" />
                </div>
                {context?.settings.showThinking && state.thinking && (
                  <div className="rounded-lg border border-border/60 bg-surface/40 p-2 text-xs">
                    <div className="flex items-center gap-1.5 font-medium text-dim">
                      <Brain size={12} className="text-special" />
                      <span>{t('quickChat.thinking')}</span>
                      <Loader2 size={10} className="animate-spin text-muted ml-auto" />
                    </div>
                    <div className="mt-1.5 pt-1.5 border-t border-border/40 text-xs italic text-muted leading-relaxed font-chat">
                      <Markdown>{state.thinking}</Markdown>
                    </div>
                  </div>
                )}
                {state.content && (
                  <div className="font-chat text-xs leading-relaxed text-primary break-words [overflow-wrap:anywhere]">
                    <Markdown>{state.content}</Markdown>
                  </div>
                )}
              </article>
            )}

            {/* Active Running Tools */}
            {Object.entries(state.tools).map(([id, tool]) => (
              <div
                key={id}
                className={clsx(
                  'flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs font-mono my-0.5 transition-colors',
                  tool.running
                    ? 'bg-surface border-accent/40 text-primary'
                    : tool.error
                      ? 'bg-error-bg/20 border-error/30 text-error'
                      : 'bg-card/50 border-border text-muted'
                )}
              >
                {tool.running ? (
                  <Loader2 size={11} className="animate-spin text-accent shrink-0" />
                ) : tool.error ? (
                  <AlertCircle size={11} className="text-error shrink-0" />
                ) : (
                  <CheckCircle2 size={11} className="text-success shrink-0" />
                )}
                <span className="truncate">
                  {tool.running
                    ? t('quickChat.toolRunning', { name: tool.name })
                    : tool.error
                      ? t('quickChat.toolError', { name: tool.name })
                      : t('quickChat.toolComplete', { name: tool.name })}
                </span>
              </div>
            ))}

            {/* Scroll to Bottom Floating Pill */}
            {!isAtBottom && (
              <button
                type="button"
                onClick={scrollToBottom}
                aria-label={t('chat.scrollToBottom')}
                title={t('chat.scrollToBottom')}
                className="sticky bottom-2 left-1/2 -translate-x-1/2 z-10 mx-auto flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-hover/90 border border-border shadow-md text-xs text-secondary hover:text-primary backdrop-blur-xs transition-all animate-fade-in"
              >
                <ArrowDown size={12} />
              </button>
            )}
          </div>

          {/* Pending Approval Request Card */}
          {state.request && (
            <Approval
              key={`${state.binding?.version}:${state.request.id}`}
              request={state.request}
              answering={state.answering}
              controller={controller}
            />
          )}

          {/* Bottom Docked Composer */}
          <div className={clsx('px-3.5 py-2.5 bg-surface/30 border-t border-border/30 backdrop-blur-md', modelPickerOpen ? 'flex-1 min-h-0 flex flex-col' : 'shrink-0')}>
            {composer}
          </div>
        </>
      )}
    </main>
  )
}

function QuickChatComposer({ state, controller, editor, onAttachFiles, picker, pickerOpen, children }: {
  state: QuickChatState
  controller: QuickChatController
  editor: RefObject<HTMLTextAreaElement | null>
  onAttachFiles: (files: File[]) => Promise<void>
  picker: React.ReactNode
  pickerOpen: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const newTask = state.mode === 'new'
  const minHeight = newTask ? 46 : 38
  const maxHeight = pickerOpen ? 80 : newTask ? 150 : 140
  useEffect(() => {
    const textarea = editor.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`
  }, [editor, state.draft, minHeight, maxHeight])

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = Array.from(e.clipboardData.items)
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      void onAttachFiles(files)
    }
  }

  const attachmentsNode = state.attachments.length > 0 && (
    <div className="flex max-h-20 overflow-y-auto flex-wrap gap-1.5 pb-2 shrink-0">
      {state.attachments.map((att, index) => (
        <div
          key={`${att.name}-${index}`}
          className="group/chip flex items-center gap-1.5 px-2 py-1 rounded-lg border border-border bg-surface text-xs text-primary max-w-56 shadow-2xs"
          title={att.name}
        >
          {att.kind === 'image' ? (
            <img
              src={`data:${att.image.mimeType};base64,${att.image.data}`}
              alt={att.name}
              className="h-4 w-4 rounded object-cover shrink-0"
            />
          ) : (
            <FileText size={12} className="text-muted shrink-0" />
          )}
          <span className="truncate text-[11px]">{att.name}</span>
          <button
            type="button"
            onClick={() => controller.removeAttachment(index)}
            className="text-dim hover:text-primary transition-colors ml-0.5 p-0.5"
            aria-label={t('common.delete')}
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  )

  const attachErrorNode = state.attachError && (
    <div className="mb-2 flex items-center justify-between gap-1.5 px-2.5 py-1 rounded-lg bg-error-bg/60 border border-error/30 text-[11px] text-error shrink-0">
      <div className="flex items-center gap-1.5 truncate">
        <AlertCircle size={12} className="shrink-0" />
        <span className="truncate">{state.attachError}</span>
      </div>
      <button
        type="button"
        onClick={() => controller.setAttachError(null)}
        className="text-error hover:text-primary p-0.5"
      >
        <X size={10} />
      </button>
    </div>
  )

  if (newTask) {
    return (
      <form
        className="flex-1 min-h-0 flex flex-col justify-between qc-no-drag overflow-hidden"
        onSubmit={(event) => { event.preventDefault(); void controller.submit() }}
      >
        <div className={clsx('px-4 pt-3 pb-1 flex flex-col min-h-0 overflow-y-auto', pickerOpen ? 'shrink-0' : 'flex-1')}>
          {attachmentsNode}
          {attachErrorNode}
          <textarea
            ref={editor}
            rows={2}
            value={state.draft}
            disabled={state.selecting || state.sending || state.pickingWorkspace}
            aria-label={t('quickChat.message')}
            placeholder={t('quickChat.taskPlaceholder')}
            style={{ minHeight, maxHeight }}
            className={clsx('font-chat w-full resize-none bg-transparent pt-0 pb-1 text-xs leading-relaxed text-primary placeholder:text-muted/60 outline-none disabled:opacity-50', !pickerOpen && 'flex-1')}
            onChange={(event) => controller.setDraft(event.target.value)}
            onPaste={handlePaste}
          />
        </div>
        {picker}
        <div className="px-3.5 py-2 border-t border-border/40 bg-surface/25 flex items-center justify-between select-none shrink-0">
          {children}
        </div>
      </form>
    )
  }

  return (
    <form
      className={clsx('rounded-xl border border-border/60 bg-card/85 shadow-xs focus-within:border-accent/40 focus-within:ring-1 focus-within:ring-accent/15 flex flex-col transition-all qc-no-drag p-2.5', pickerOpen && 'flex-1 min-h-0 overflow-hidden')}
      onSubmit={(event) => { event.preventDefault(); void controller.submit() }}
    >
      {attachmentsNode}
      {attachErrorNode}
      <textarea
        ref={editor}
        rows={1}
        value={state.draft}
        disabled={state.selecting || !state.binding}
        aria-label={t('quickChat.message')}
        placeholder={state.busy ? t('quickChat.steerPlaceholder') : t('quickChat.promptPlaceholder')}
        style={{ minHeight, maxHeight }}
        className="font-chat shrink-0 w-full resize-none bg-transparent pt-0.5 pb-2 text-xs leading-relaxed text-primary placeholder:text-muted/60 outline-none disabled:opacity-50"
        onChange={(event) => controller.setDraft(event.target.value)}
        onPaste={handlePaste}
      />
      {picker}
      <div className="pt-2 border-t border-border/40 flex items-center justify-between select-none">
        {children}
      </div>
    </form>
  )
}
/** Integrated action pills for model, thinking, permission, and submit directly inside composer card. */
function ActionPills({
  state, anchorRef, modelPickerOpen, modelPickerTab, openPicker, onPickAttachment, onSubmit,
}: {
  state: QuickChatState
  anchorRef: RefObject<HTMLDivElement | null>
  modelPickerOpen: boolean
  modelPickerTab: 'model' | 'thinking'
  openPicker: (tab: 'model' | 'thinking') => void
  onPickAttachment: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const locked = state.busy || !!state.request || state.stopping || state.switching
  const sendDisabled = state.sending || state.loading || state.selecting || state.pickingWorkspace || state.stopping || !!state.request
  const { mode, binding } = state
  const newTask = mode === 'new'
  const hasAttachments = state.attachments.length > 0
  const hasContent = Boolean(state.draft.trim() || hasAttachments)
  const canSend = newTask ? hasContent : Boolean(binding && hasContent)
  const defaultModel = newTask ? state.context?.settings.defaultModel : null
  const rawModelId = state.preparedModel?.modelId || state.model?.id || defaultModel
  const rawModelName = state.preparedModel?.name || state.model?.name
  const modelLabel = rawModelId
    ? modelShortName(rawModelId, rawModelName)
    : t('models.selector.selectModel')
  const modelTitle = state.preparedModel
    ? `${state.preparedModel.provider} · ${state.preparedModel.modelId} (${t('quickChat.pendingModelHint')})`
    : state.model
      ? `${state.model.provider} · ${state.model.id}`
      : defaultModel
        ? `${state.context?.settings.defaultProvider ?? ''} · ${defaultModel} (${t('quickChat.defaultModelHint')})`
        : t('quickChat.modelUnconfirmedHint')
  const effectiveThinkingLevel = state.preparedThinkingLevel ?? state.thinkingLevel ??
    (newTask ? state.context?.settings.defaultThinkingLevel : null)
  const thinkingDisplay = effectiveThinkingLevel
    ? effectiveThinkingLevel.charAt(0).toUpperCase() + effectiveThinkingLevel.slice(1)
    : null
  const thinkingLabel = thinkingDisplay ? `${t('quickChat.thinking')} · ${thinkingDisplay}` : t('quickChat.thinking')
  const thinkingTitle = thinkingDisplay
    ? t('thinking.effortWithLevel', { level: thinkingDisplay })
    : t('quickChat.modelUnconfirmedHint')
  const activeMode = (newTask ? state.context?.settings.permissionMode : state.permissionMode) ?? DEFAULT_PERMISSION_MODE
  const permissionLabel = getPermissionModeLabel(activeMode)
  const permissionTitle = newTask
    ? `${permissionLabel} · ${t('quickChat.permissionAppliesOnSend')}`
    : getPermissionModeDescription(t, activeMode, '')
  return (
    <div className="w-full flex items-center justify-between gap-2 select-none">
      <div ref={anchorRef} className="relative flex flex-1 flex-wrap items-center gap-1.5 min-w-0">
        <button
          type="button"
          disabled={locked}
          onClick={() => openPicker('model')}
          className={clsx(
            'flex items-center gap-1.5 max-w-[240px] px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors',
            modelPickerOpen && modelPickerTab === 'model'
              ? 'bg-card border-border-strong ring-1 ring-border-strong text-primary'
              : 'bg-surface/60 border-border hover:bg-surface-hover hover:border-border-strong text-secondary hover:text-primary',
            locked && 'opacity-50 cursor-not-allowed'
          )}
          title={modelTitle}
        >
          <Cpu size={12} className="text-accent shrink-0" />
          <span className="truncate">{modelLabel}</span>
          <ChevronDown size={10} className={clsx('text-dim transition-transform shrink-0', modelPickerOpen && modelPickerTab === 'model' && 'rotate-180')} />
        </button>

        <button
          type="button"
          disabled={locked}
          onClick={() => openPicker('thinking')}
          className={clsx(
            'flex items-center gap-1.5 max-w-36 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors',
            modelPickerOpen && modelPickerTab === 'thinking'
              ? 'bg-card border-border-strong ring-1 ring-border-strong text-primary'
              : 'bg-surface/60 border-border hover:bg-surface-hover hover:border-border-strong text-secondary hover:text-primary',
            locked && 'opacity-50 cursor-not-allowed'
          )}
          title={thinkingTitle}
        >
          <Brain size={11} className="text-accent shrink-0" />
          <span className="truncate">{thinkingLabel}</span>
          <ChevronDown size={10} className={clsx('text-dim transition-transform shrink-0', modelPickerOpen && modelPickerTab === 'thinking' && 'rotate-180')} />
        </button>

        <button
          type="button"
          disabled={locked}
          onClick={onPickAttachment}
          className={clsx(
            'flex items-center justify-center h-6 w-6 rounded-md border border-border bg-surface/60 hover:bg-surface-hover hover:border-border-strong text-secondary hover:text-primary transition-colors',
            locked && 'opacity-50 cursor-not-allowed'
          )}
          title={t('common.attachFile')}
          aria-label={t('common.attachFile')}
        >
          <Paperclip size={12} />
        </button>

        <span
          className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border border-border/40 bg-surface/40 text-muted shrink-0"
          title={permissionTitle}
        >
          <Shield size={11} className="shrink-0 text-muted/80" />
          <span className="truncate">{permissionLabel}</span>
        </span>

      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          disabled={!canSend || sendDisabled}
          onClick={onSubmit}
          title={state.busy ? t('quickChat.steerHint') : t('quickChat.enterHint')}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all shadow-xs shrink-0',
            state.busy
              ? 'bg-accent/90 hover:bg-accent text-white'
              : 'bg-accent hover:bg-accent-hover text-white',
            (!canSend || sendDisabled) && 'opacity-40 cursor-not-allowed'
          )}
        >
          {state.sending ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              <span>{t('quickChat.sending')}</span>
            </>
          ) : state.busy ? (
            <>
              <CornerDownLeft size={11} />
              <span>{t('quickChat.steer')}</span>
              <span className="opacity-70 font-mono text-[10px] ml-0.5">↵</span>
            </>
          ) : (
            <>
              <Send size={11} />
              <span>{t('quickChat.send')}</span>
              <span className="opacity-70 font-mono text-[10px] ml-0.5">↵</span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
