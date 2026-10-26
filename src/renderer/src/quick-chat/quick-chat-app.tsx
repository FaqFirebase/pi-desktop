import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { clsx } from 'clsx'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import {
  AlertCircle,
  ArrowDown,
  Check,
  ChevronDown,
  ExternalLink,
  Folder,
  FolderPlus,
  Home,
  Loader2,
  MessageSquare,
  Pin,
  Paperclip,
  Plus,
  Radio,
  Search,
  ShieldAlert,
  Square,
  X,
} from 'lucide-react'
import { isFileDrag } from '../../../shared/folder-drop'
import { droppedAttachmentFiles, readDroppedAttachment } from '../utils/dropped-attachments'
import { availableLanguages, i18n } from '../../../shared/i18n'
import { useTranslation } from 'react-i18next'
import { resolveLanguage } from '../../../shared/i18n/resolve'
import type { QuickChatApi } from '../../../shared/quick-chat'
import { groupToolMessages, prepareChatMessages } from '../message-grouping'
import { applyThemeSettings, setUserThemes } from '../utils/theme'
import { applyUiFont } from '../utils/ui-font'
import { formatRelativeTime } from '../utils/format-relative-time'
import { formatShortcut } from '../../../shared/keyboard-shortcuts'
import { QuickChatController } from './controller'
import { composerKeyAction, selectedTarget, targetOptions, targetStatusLabel } from './presentation'
import { ModelPicker } from './model-picker'
import { MessageBubble, ToolGroupBubble } from '../components/message-bubble'
import { StreamingBubble } from '../components/streaming-bubble'
import { ReadOnlyChatContext } from '../components/read-only-chat-context'
import { Approval } from './approval'
import { ActionPills, QuickChatComposer } from './composer'
import './quick-chat.css'

export function QuickChatApp({ api = window.piQuickChat }: { api?: QuickChatApi }): React.JSX.Element {
  const controller = useMemo(() => new QuickChatController(api), [api])
  const state = useSyncExternalStore(controller.subscribe, controller.getState)
  const { t } = useTranslation()
  const [dropdown, setDropdown] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelPickerTab, setModelPickerTab] = useState<'model' | 'thinking'>('model')
  const [filter, setFilter] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [isAtBottom, setIsAtBottom] = useState(true)
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
  const pinned = context?.pinned ?? false
  const platform = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? 'darwin' : 'win32'
  const options = useMemo(() => (context ? targetOptions(context, t) : []), [context, t])
  const selected = selectedTarget(options, state.binding)
  const workspace =
    state.mode === 'session'
      ? context?.workspaces.find((item) => item.id === state.binding?.runtime.workspaceId)
      : state.workspaceId
        ? context?.workspaces.find((item) => item.id === state.workspaceId)
        : undefined
  const matching = options.filter((option) =>
    `${option.title} ${option.workspace} ${option.path}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
  )
  const renderItems = useMemo(
    () => groupToolMessages(prepareChatMessages(state.messages), t, state.busy),
    [state.messages, state.busy, t]
  )
  const renderView = useMemo(
    () => ({
      showThinking: context?.settings.showThinking ?? DEFAULT_SETTINGS.showThinking,
      provider: state.model?.provider,
    }),
    [context?.settings.showThinking, state.model?.provider]
  )
  const liveTools = useMemo(
    () =>
      new Map(
        Object.entries(state.tools).map(([id, tool]) => [
          id,
          { name: tool.name, args: '', isExecuting: tool.running, isError: tool.error },
        ])
      ),
    [state.tools]
  )
  const activeRuntimes = useMemo(() => {
    return (
      context?.runtimes.filter(
        (r) => !r.closed && (r.activity === 'working' || r.activity === 'needs-approval')
      ) ?? []
    )
  }, [context?.runtimes])

  useEffect(() => {
    controller.start()
    return () => controller.dispose()
  }, [controller])


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

  const handleAttachFiles = (files: File[]): Promise<void> =>
    controller.readAttachments(
      files.map((file) => ({ label: file.name, path: file.name, read: () => readDroppedAttachment(file) }))
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
    const applySystem = (): void => {
      if (theme === 'system') applyThemeSettings(themeSettings)
    }
    media.addEventListener('change', applySystem)
    return () => media.removeEventListener('change', applySystem)
  }, [themes, theme, systemLightTheme, systemDarkTheme])

  useEffect(() => {
    if (fontFamily !== undefined) applyUiFont(fontFamily)
    if (fontSize !== undefined) document.documentElement.style.fontSize = `${fontSize}px`
  }, [fontFamily, fontSize])

  useEffect(() => {
    if (!environment || !languageSetting) return
    const language = resolveLanguage(
      languageSetting,
      environment.systemLanguages,
      availableLanguages(environment.pseudoLanguageEnabled)
    )
    void i18n.changeLanguage(language)
    document.documentElement.lang = language
  }, [environment, languageSetting])

  useEffect(() => {
    const handleFocus = (): void => {
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
    void controller.hide()
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

  const toggleSessionDropdown = (): void => {
    setDropdown((open) => {
      const next = !open
      setProjectPickerOpen(false)
      setFilter('')
      setHighlight(0)
      if (next) void controller.refreshContext()
      return next
    })
  }

  const handleKeys = (event: KeyboardEvent<HTMLElement>): void => {
    const action = composerKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
      },
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
      defaultModel={
        state.mode === 'new' && context?.settings.defaultProvider && context.settings.defaultModel
          ? { provider: context.settings.defaultProvider, modelId: context.settings.defaultModel }
          : null
      }
      defaultThinkingLevel={state.mode === 'new' ? context?.settings.defaultThinkingLevel ?? null : null}
      thinkingLevel={state.thinkingLevel}
      preparedThinkingLevel={state.preparedThinkingLevel}
      locked={state.busy || !!state.request || state.stopping || state.switching}
      onPickModel={(model) => {
        void controller.setModelChoice(model)
      }}
      onPickThinking={(level) => {
        void controller.setThinkingChoice(level)
      }}
      anchorRef={pickerAnchor}
      workspaceId={state.mode === 'new' ? state.workspaceId : state.binding?.runtime.workspaceId ?? null}
    />
  )

  const composer = (
    <QuickChatComposer
      state={state}
      controller={controller}
      editor={editor}
      onAttachFiles={handleAttachFiles}
      picker={picker}
      pickerOpen={modelPickerOpen}
    >
      <ActionPills
        state={state}
        anchorRef={pickerAnchor}
        modelPickerOpen={modelPickerOpen}
        modelPickerTab={modelPickerTab}
        openPicker={(tab) => {
          setModelPickerTab(tab)
          setModelPickerOpen(true)
        }}
        onPickAttachment={() => {
          void controller.pickAttachment()
        }}
        onSubmit={() => {
          void controller.submit()
        }}
      />
    </QuickChatComposer>
  )

  return (
    <ReadOnlyChatContext.Provider value={renderView}>
      <main
        className="quick-chat"
        onKeyDown={handleKeys}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
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
            <span
              className="text-xs font-semibold text-primary truncate select-none shrink-0"
              title={state.mode === 'new' ? t('quickChat.newTaskDescription') : t('quickChat.title')}
            >
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
                  <span
                    className="truncate leading-none"
                    title={
                      workspace?.name ||
                      (state.workspaceId === null ? t('quickChat.noProject') : t('quickChat.chooseProject'))
                    }
                  >
                    {workspace?.name ||
                      (state.workspaceId === null ? t('quickChat.noProject') : t('quickChat.chooseProject'))}
                  </span>
                  <ChevronDown
                    size={10}
                    className={clsx(
                      'text-dim group-hover:text-muted transition-transform shrink-0 ml-0.5',
                      projectPickerOpen && 'rotate-180'
                    )}
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
                  onClick={toggleSessionDropdown}
                  title={t('quickChat.chooseSession')}
                >
                  <MessageSquare size={11} className="text-dim group-hover:text-primary transition-colors shrink-0" />
                  <span>{t('quickChat.sessions')}</span>
                  <ChevronDown
                    size={10}
                    className={clsx('text-dim transition-transform shrink-0 ml-0.5', dropdown && 'rotate-180')}
                  />
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
                onClick={toggleSessionDropdown}
              >
                <span className="shrink-0 flex items-center justify-center" title={runtimeStatusTitle}>
                  {statusIndicator}
                </span>

                <span className="text-muted truncate max-w-[90px]" title={workspace?.name}>
                  {workspace?.name}
                </span>
                <span className="text-dim/60 shrink-0">/</span>
                <span
                  className="truncate max-w-[140px] font-semibold text-primary"
                  title={selected?.title || t('quickChat.untitledSession')}
                >
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
                title={
                  activeRuntimes.some((r) => r.activity === 'needs-approval')
                    ? t('quickChat.needsApproval')
                    : t('quickChat.viewActive')
                }
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
                      ? context?.sessions.find((s) => s.path === activeRuntimes[0].sessionPath)?.name ||
                        activeRuntimes[0].sessionId ||
                        t('quickChat.working')
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
                onClick={() => {
                  void controller.stop()
                }}
              >
                {state.stopping ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Square size={11} className="fill-current" />
                )}
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
              disabled={!context}
              aria-pressed={pinned}
              onClick={() => { void controller.togglePinned() }}
            >
              <Pin size={13} className={pinned ? 'fill-current' : ''} />
            </button>

            <button
              className="qc-no-drag flex items-center justify-center h-7 w-7 rounded-lg text-dim hover:text-primary hover:bg-surface-hover transition-colors"
              title={t('quickChat.openInMain')}
              aria-label={t('quickChat.open')}
              onClick={() => {
                void controller.openInMain()
              }}
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
        {state.busy && <div className="h-px w-full bg-accent/60 shrink-0" />}

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
                        const next = Math.max(
                          0,
                          Math.min(matching.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))
                        )
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
                    onClick={() => {
                      setFilter('')
                      setHighlight(0)
                    }}
                    className="text-muted hover:text-primary transition-colors p-0.5"
                    aria-label={t('common.close')}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>

              <div
                role="listbox"
                aria-label={t('quickChat.chooseSession')}
                className="max-h-60 overflow-y-auto space-y-0.5 pr-0.5"
              >
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
                      ref={(el) => {
                        optionRefs.current[index] = el
                      }}
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
                        {option.status === 'working' || option.status === 'needs-approval' ? (
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
                          </span>
                        ) : option.live ? (
                          <Radio
                            size={13}
                            className={clsx(
                              option.status === 'failed'
                                ? 'text-error'
                                : option.status === 'starting'
                                  ? 'text-accent'
                                  : 'text-success'
                            )}
                          />
                        ) : (
                          <MessageSquare size={13} className="text-dim" />
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-xs font-medium text-primary">{option.title}</div>
                        <div className="truncate text-[10px] text-muted flex items-center gap-1.5 mt-0.5">
                          <span className="truncate">{option.workspace}</span>
                          <span>·</span>
                          <span className="shrink-0">{targetStatusLabel(option.status, t)}</span>
                          {option.updatedAt > 0 && (
                            <time
                              className="ml-auto shrink-0 text-faint"
                              dateTime={new Date(option.updatedAt).toISOString()}
                            >
                              {formatRelativeTime(option.updatedAt, Date.now())}
                            </time>
                          )}
                        </div>
                      </div>
                      {isSelected && <Check size={13} className="text-accent shrink-0 ml-1.5" />}
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
                  <div className="px-2 py-3 text-center text-xs text-muted">{t('quickChat.noWorkspaces')}</div>
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
          <div
            className="px-3 py-1 bg-surface-hover/50 border-b border-border text-[11px] text-muted flex items-center justify-between gap-2 shrink-0"
            role="status"
          >
            <div className="flex items-center gap-1.5 min-w-0 truncate">
              <Loader2 size={10} className="animate-spin text-muted shrink-0" />
              <span className="truncate">{state.status}</span>
            </div>
            {state.busy && (
              <button
                onClick={() => {
                  void controller.stop()
                }}
                className="text-[10px] text-error hover:underline shrink-0"
              >
                {t('quickChat.stop')}
              </button>
            )}
          </div>
        )}

        {state.error && (
          <div
            className="flex items-center justify-between gap-2 px-3 py-2 bg-error-bg/60 border-b border-error/30 text-xs text-error shrink-0"
            role="alert"
          >
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle size={14} className="shrink-0" />
              <span className="truncate">{state.error}</span>
            </div>
            <button
              onClick={() => {
                void controller.retry()
              }}
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
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">{composer}</div>
        ) : (
          /* ═══════════════════════════════════════════════════════════════
             MODE 2: SESSION CONVERSATION VIEW
             ═══════════════════════════════════════════════════════════════ */
          <>
            <div
              className={clsx(
                'flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3 relative',
                modelPickerOpen && 'hidden'
              )}
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
                  <p className="text-xs text-muted max-w-xs leading-relaxed pointer-events-none">
                    {t('quickChat.startConversation')}
                  </p>
                </div>
              )}

              {/* Messages */}
              {renderItems.map((item) =>
                item.kind === 'toolGroup' ? (
                  <ToolGroupBubble key={item.id} title={item.title} messages={item.messages} />
                ) : (
                  <MessageBubble key={item.message.id} message={item.message} readOnly />
                )
              )}

              {(state.busy || state.content || state.thinking || liveTools.size > 0) && (
                <StreamingBubble content={state.content} thinking={state.thinking} toolCalls={liveTools} />
              )}

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
            <div
              className={clsx(
                'px-3.5 py-2.5 bg-surface/30 border-t border-border/30 backdrop-blur-md',
                modelPickerOpen ? 'flex-1 min-h-0 flex flex-col' : 'shrink-0'
              )}
            >
              {composer}
            </div>
          </>
        )}
      </main>
    </ReadOnlyChatContext.Provider>
  )
}
