import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { AlertCircle, ArrowDown, Check, ChevronDown, ExternalLink, Folder, FolderPlus, Loader2, MessageSquare, Pin, Plus, Search, ShieldAlert, X } from 'lucide-react'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { availableLanguages, i18n } from '../../../shared/i18n'
import { resolveLanguage } from '../../../shared/i18n/resolve'
import { matchesShortcut } from '../../../shared/keyboard-shortcuts'
import { normalizePiCommands, withGuiCommands, type PiCommand } from '../../../shared/pi-command'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import type { QuickChatApi, QuickChatQueryTarget } from '../../../shared/quick-chat'
import { ChatSessionContext, type ChatSessionBindings } from '../chat-session-context'
import { ChatInput } from '../components/chat-input'
import { ExtensionUiDialog } from '../components/extension-ui-dialog'
import { MessageBubble, ToolGroupBubble } from '../components/message-bubble'
import { ReadOnlyChatContext } from '../components/read-only-chat-context'
import { StreamingBubble } from '../components/streaming-bubble'
import { groupToolMessages, prepareChatMessages } from '../message-grouping'
import { applyThemeSettings, setUserThemes } from '../utils/theme'
import { applyUiFont } from '../utils/ui-font'
import { isImeComposing } from '../utils/ime-composing'
import type { ComposerAttachment, ComposerDraft } from '../store'
import { QuickChatController } from './controller'
import { selectedTarget, targetOptions, targetStatusLabel, transcriptMessages } from './presentation'
import './quick-chat.css'

export function QuickChatApp({ api = window.piQuickChat }: { api?: QuickChatApi }): React.JSX.Element {
  const { t } = useTranslation()
  const controller = useMemo(() => new QuickChatController(api), [api])
  const state = useSyncExternalStore(controller.subscribe, controller.getState)
  const context = state.context
  const settings = context?.settings ?? DEFAULT_SETTINGS
  const scopeKey = controller.getScopeKey()
  const runtime = state.binding?.runtime
  const version = state.binding?.version
  const [picker, setPicker] = useState<'sessions' | 'projects' | null>(null)
  const [filter, setFilter] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [focusRequested, setFocusRequested] = useState(true)
  const [commands, setCommands] = useState<PiCommand[]>([])
  const [atBottom, setAtBottom] = useState(true)
  const dropZone = useRef<HTMLElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const sessionSearch = useRef<HTMLInputElement>(null)
  const followTail = useRef(true)
  const platform = /Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : 'linux'
  const workspace = context?.workspaces.find((item) => item.id === state.workspaceId)
  const options = useMemo(() => context ? targetOptions(context, t) : [], [context, t])
  const selected = selectedTarget(options, state.binding)
  const matching = options.filter((item) => `${item.title} ${item.workspace} ${item.path}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  const activeTasks = context?.runtimes.filter((item) => !item.closed && (item.activity === 'working' || item.activity === 'needs-approval')) ?? []
  const target = useMemo<QuickChatQueryTarget | null>(() => version !== undefined
    ? { kind: 'runtime', version }
    : state.mode === 'new' && state.workspaceId ? { kind: 'draft', workspaceId: state.workspaceId } : null,
  [version, state.mode, state.workspaceId])
  const query = useMemo(() => ({
    list: () => target ? api.listModels(target) : Promise.resolve([]),
    searchFiles: (text: string) => target ? api.searchFiles({ target, query: text }) : Promise.resolve([]),
  }), [api, target])
  const voice = useMemo<ChatSessionBindings['voice']>(() => ({
    loadStatus: () => api.voiceStatus(),
    openSettings: () => api.openSettings(),
    globalShortcuts: false,
  }), [api])
  const requestFocus = useCallback(() => setFocusRequested(true), [])
  const clearFocusRequest = useCallback(() => setFocusRequested(false), [])
  const newTask = useCallback(() => {
    setPicker(null)
    setModelPickerOpen(false)
    void controller.newTask().then(requestFocus)
  }, [controller, requestFocus])
  const guiCommands = useMemo<ChatSessionBindings['composer']['guiCommands']>(() => [
    { name: 'new', description: t('commands.new.description'), run: newTask },
    { name: 'model', description: t('commands.model.description'), run: () => { if (target) setModelPickerOpen(true) } },
    { name: 'resume', description: t('commands.resume.description'), run: () => { setPicker('sessions'); void controller.refreshContext() } },
    { name: 'settings', description: t('commands.settings.description'), run: () => { void api.openSettings() } },
  ], [t, newTask, target, controller, api])
  const allCommands = useMemo(() => withGuiCommands(commands, guiCommands), [commands, guiCommands])
  const owner = useMemo(() => ({
    readDraft: () => controller.readDraft(),
    saveDraft: (draft: ComposerDraft) => controller.saveDraft(draft, scopeKey),
    submit: async (text: string, attachments: ComposerAttachment[]) => {
      if (controller.getScopeKey() !== scopeKey) return false
      controller.saveDraft({ text, attachments }, scopeKey)
      return controller.submit()
    },
    pickAttachments: () => api.pickAttachment(),
  }), [api, controller, scopeKey])
  const bindings: ChatSessionBindings = {
    engine: runtime?.engine ?? (settings.piEngine === 'omp' ? 'omp' : 'pi'),
    settings,
    permissionMode: state.permissionMode ?? (state.mode === 'new' ? settings.permissionMode : null),
    models: {
      scopeKey: `${scopeKey}:${version ?? ''}`, status: runtime?.status ?? 'stopped',
      model: state.model, thinkingLevel: state.thinkingLevel,
      pendingModel: state.preparedModel, pendingThinkingLevel: state.preparedThinkingLevel,
      useDefaults: state.mode === 'new',
      locked: !target || state.busy || !!state.request || state.stopping || state.switching || state.sending || state.selecting,
      open: modelPickerOpen, setOpen: setModelPickerOpen, list: query.list,
      select: async (model) => {
        if (!await controller.setModelChoice(model)) throw new Error(controller.getState().error ?? t('quickChat.errors.runtimeBusy'))
      },
      selectThinking: async (level) => {
        if (!await controller.setThinkingChoice(level)) throw new Error(controller.getState().error ?? t('quickChat.errors.runtimeBusy'))
      },
      cycle: async () => {
        if (bindings.models.locked) return
        const current = controller.getState()
        if (current.busy || current.request || current.sending || current.switching) return
        let models: ModelInfo[]
        try {
          models = await query.list()
        } catch {
          if (controller.getScopeKey() === scopeKey) {
            setModelPickerOpen(true)
          }
          return
        }
        if (!models.length || controller.getScopeKey() !== scopeKey) return
        const now = controller.getState()
        if (now.busy || now.request || now.sending || now.switching) return
        const provider = now.preparedModel?.provider ?? now.model?.provider ?? settings.defaultProvider
        const modelId = now.preparedModel?.modelId ?? now.model?.id ?? settings.defaultModel
        const index = models.findIndex((model) => model.provider === provider && model.id === modelId)
        await controller.setModelChoice(models[(index + 1) % models.length])
      },
    },
    approval: {
      request: state.request, notify: state.notify, answering: state.answering,
      respond: async (id, response) => {
        if (controller.getState().request?.id !== id || !await controller.answer(response)) {
          throw new Error(controller.getState().error ?? t('quickChat.errors.staleApproval'))
        }
      },
      cancel: async () => {
        if (!await controller.cancelRequest()) throw new Error(controller.getState().error ?? t('quickChat.errors.staleApproval'))
      },
      dismissNotify: () => controller.dismissNotify(), hideSurface: () => { void controller.hide() },
    },
    composer: {
      scopeKey, active: state.visible, loading: state.loading || state.selecting,
      streaming: state.busy, sending: state.sending,
      focusRequested, requestFocus, clearFocusRequest,
      pendingInsert: null,
      ...owner, draftVersion: state.draftVersion,
      history: state.history, historyBlocked: picker !== null,
      recordPrompt: (text) => controller.recordPrompt(text),
      stop: () => controller.stop(), escape: 'hide', hide: () => controller.hide(),
      searchFiles: query.searchFiles, commands: allCommands, guiCommands,
    },
    voice,
  }
  const renderView = useMemo(() => ({
    showThinking: settings.showThinking, singleDollarMath: settings.singleDollarMath,
    provider: state.model?.provider,
  }), [settings.showThinking, settings.singleDollarMath, state.model?.provider])
  const renderItems = useMemo(() => groupToolMessages(prepareChatMessages(transcriptMessages(state.messages, state.tools)), t, state.busy), [state.messages, state.tools, state.busy, t])

  useEffect(() => { controller.start(); return () => controller.dispose() }, [controller])
  useEffect(() => {
    let current = true
    setCommands([])
    if (target && runtime?.status === 'running') {
      void api.listCommands(target).then((raw) => { if (current) setCommands(normalizePiCommands(raw)) }).catch(() => {})
    }
    return () => { current = false }
  }, [api, target, runtime?.status])
  useEffect(() => {
    setModelPickerOpen(false)
    requestFocus()
    followTail.current = true
    setAtBottom(true)
  }, [scopeKey, requestFocus])
  useEffect(() => { if (state.visible) requestFocus() }, [state.visible, requestFocus])
  useEffect(() => {
    const focus = (): void => { if (!state.request && !picker && !modelPickerOpen) requestFocus() }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [state.request, picker, modelPickerOpen, requestFocus])
  useEffect(() => { if (picker === 'sessions') sessionSearch.current?.focus() }, [picker])
  useEffect(() => {
    if (settings.autoScroll && followTail.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight
  }, [settings.autoScroll, state.messages, state.content, state.thinking, state.tools, state.request])
  const themes = context?.themes
  const { theme, systemLightTheme, systemDarkTheme, uiFontFamily, fontSize, language } = settings
  const environment = context?.i18nEnvironment
  useEffect(() => {
    if (!themes) return
    setUserThemes(themes)
    const themeSettings = { theme, systemLightTheme, systemDarkTheme }
    applyThemeSettings(themeSettings)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applySystem = (): void => { if (theme === 'system') applyThemeSettings(themeSettings) }
    media.addEventListener('change', applySystem)
    return () => media.removeEventListener('change', applySystem)
  }, [themes, theme, systemLightTheme, systemDarkTheme])
  useEffect(() => {
    applyUiFont(uiFontFamily)
    document.documentElement.style.fontSize = `${fontSize}px`
  }, [uiFontFamily, fontSize])
  useEffect(() => {
    if (!environment) return
    const resolved = resolveLanguage(language, environment.systemLanguages, availableLanguages(environment.pseudoLanguageEnabled))
    void i18n.changeLanguage(resolved)
    document.documentElement.lang = resolved
  }, [environment, language])

  const toggleSessions = (): void => {
    setFilter(''); setHighlight(0)
    setPicker((current) => current === 'sessions' ? null : 'sessions')
    void controller.refreshContext()
  }
  const status = state.request ? t('quickChat.needsApproval') : state.busy ? t('quickChat.working')
    : runtime?.status === 'starting' ? t('quickChat.starting') : runtime?.status === 'error' ? t('quickChat.failed')
      : runtime?.status === 'stopped' ? t('quickChat.stopped') : t('quickChat.ready')
  return (
    <ChatSessionContext.Provider value={bindings}>
      <ReadOnlyChatContext.Provider value={renderView}>
        <main ref={dropZone} className="quick-chat" onKeyDown={(event) => {
          if (event.defaultPrevented || isImeComposing(event.nativeEvent)) return
          if (event.key === 'Escape' && picker) { event.preventDefault(); setPicker(null); requestFocus() }
          else if (matchesShortcut(event, settings.shortcuts.newSession, platform)) { event.preventDefault(); newTask() }
          else if (matchesShortcut(event, settings.shortcuts.modelSelector, platform) && !bindings.models.locked) {
            event.preventDefault(); setModelPickerOpen((open) => !open)
          }
        }}>
          <header className="qc-drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
            <span className="shrink-0 font-semibold">{t('quickChat.title')}</span>
            {state.mode === 'new' && <button className="qc-no-drag flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-secondary hover:bg-surface-hover" disabled={state.sending || state.selecting || state.pickingWorkspace} aria-haspopup="listbox" aria-expanded={picker === 'projects'} onClick={() => setPicker((value) => value === 'projects' ? null : 'projects')}>
              <Folder size={12} /><span className="truncate">{workspace?.name ?? t('quickChat.noProject')}</span><ChevronDown size={12} />
            </button>}
            <button className="qc-no-drag flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-secondary hover:bg-surface-hover" disabled={state.sending || state.selecting} title={t('quickChat.chooseSession')} aria-label={t('quickChat.chooseSession')} aria-haspopup="listbox" aria-expanded={picker === 'sessions'} onClick={toggleSessions}>
              <MessageSquare size={12} /><span className="truncate">{state.mode === 'new' ? t('quickChat.sessions') : selected?.title ?? t('quickChat.untitledSession')}</span><ChevronDown size={12} />
            </button>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {state.mode === 'session' && <button className="qc-no-drag rounded p-1 text-muted hover:bg-surface-hover" title={t('quickChat.newTask')} aria-label={t('quickChat.newTask')} disabled={state.sending || state.selecting} onClick={newTask}><Plus size={14} /></button>}
              {context?.canPin && <button className={clsx('qc-no-drag rounded p-1 hover:bg-surface-hover', context.pinned ? 'text-accent' : 'text-muted')} title={context.pinned ? t('quickChat.unpin') : t('quickChat.pin')} aria-label={context.pinned ? t('quickChat.unpin') : t('quickChat.pin')} aria-pressed={context.pinned} onClick={() => { void controller.togglePinned() }}><Pin size={14} /></button>}
              <button className="qc-no-drag rounded p-1 text-muted hover:bg-surface-hover" title={t('quickChat.openInMain')} aria-label={t('quickChat.open')} onClick={() => { void controller.openInMain() }}><ExternalLink size={14} /></button>
              <button className="qc-no-drag rounded p-1 text-muted hover:bg-surface-hover" title={t('quickChat.hide')} aria-label={t('quickChat.hide')} onClick={() => { void controller.hide() }}><X size={14} /></button>
            </div>
          </header>
          {picker && <>
            <div className="absolute inset-0 top-10 z-20" onMouseDown={() => { setPicker(null); requestFocus() }} />
            <section className="absolute left-3 right-3 top-11 z-30 rounded-xl border border-border-strong bg-surface p-2 shadow-xl">
              {picker === 'sessions' ? <>
                <button className="mb-2 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-accent hover:bg-surface-hover" onClick={newTask}><Plus size={14} />{t('quickChat.newTask')}</button>
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-border px-2"><Search size={13} className="text-muted" />
                  <input ref={sessionSearch} className="w-full bg-transparent py-2 text-xs outline-none" aria-label={t('quickChat.searchSessions')} placeholder={t('quickChat.searchSessions')} value={filter} onChange={(event) => { setFilter(event.target.value); setHighlight(0) }} onKeyDown={(event) => {
                    if (isImeComposing(event.nativeEvent)) return
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault(); setHighlight((index) => Math.max(0, Math.min(matching.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
                    } else if (event.key === 'Enter' && matching[highlight]) {
                      event.preventDefault(); void controller.select(matching[highlight].target).then(requestFocus); setPicker(null)
                    }
                  }} />
                </div>
                <div className="max-h-60 overflow-y-auto" role="listbox" aria-label={t('quickChat.chooseSession')}>
                  {matching.map((option, index) => <button key={option.key} role="option" aria-selected={selected?.key === option.key} title={option.path} className={clsx('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left', index === highlight ? 'bg-card' : 'hover:bg-surface-hover')} onMouseEnter={() => setHighlight(index)} onClick={() => { setPicker(null); void controller.select(option.target).then(requestFocus) }}>
                    <MessageSquare size={13} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-xs">{option.title}</span><span className="block truncate text-[10px] text-muted">{option.workspace} · {targetStatusLabel(option.status, t)}</span></span>
                    {selected?.key === option.key && <Check size={13} className="text-success" />}
                  </button>)}
                  {!matching.length && <p className="p-4 text-center text-xs text-muted">{t('quickChat.noMatchingSessions')}</p>}
                </div>
              </> : <div role="listbox" aria-label={t('quickChat.chooseProject')} className="max-h-60 overflow-y-auto">
                <button role="option" aria-selected={state.workspaceId === null} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-surface-hover" onClick={() => { controller.setNoProject(); setPicker(null); requestFocus() }}><Folder size={13} />{t('quickChat.noProject')}</button>
                {context?.workspaces.map((item) => <button key={item.id} role="option" aria-selected={item.id === state.workspaceId} title={item.path} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-surface-hover" onClick={() => { controller.setWorkspace(item.id); setPicker(null); requestFocus() }}><Folder size={13} /><span className="truncate">{item.name}</span></button>)}
                <button className="mt-1 flex w-full items-center gap-2 border-t border-border px-2 py-2 text-left text-xs text-accent hover:bg-surface-hover" onClick={() => { setPicker(null); void controller.pickWorkspace().then(requestFocus) }}><FolderPlus size={13} />{t('quickChat.pickWorkspace')}</button>
              </div>}
            </section>
          </>}
          {activeTasks.length > 0 && <button className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-left text-xs text-accent hover:bg-surface-hover" onClick={() => {
            const task = activeTasks.find((item) => item.activity === 'needs-approval') ?? (activeTasks.length === 1 ? activeTasks[0] : null)
            if (task) void controller.select({ runtimeId: task.runtimeId }).then(requestFocus)
            else toggleSessions()
          }}><ShieldAlert size={12} />{t('quickChat.activeTasksCount', { count: activeTasks.length })}</button>}
          {(state.status || state.mode === 'session') && <div role="status" className="shrink-0 px-3 py-1 text-[11px] text-muted">{state.status || status}</div>}
          {state.error && <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-error/30 bg-error-bg px-3 py-2 text-xs text-error"><AlertCircle size={14} className="shrink-0" /><span className="min-w-0 flex-1 break-words">{state.error}</span><button className="shrink-0 underline" onClick={() => { void controller.retry() }}>{t('quickChat.retry')}</button></div>}
          <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" onScroll={(event) => {
            const element = event.currentTarget
            followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
            setAtBottom(followTail.current)
          }}>
            {state.loading && <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={14} className="animate-spin" />{t('quickChat.loading')}</div>}
            {state.mode === 'new' && <div className="flex h-full flex-col items-center justify-center gap-2 py-6 text-center"><MessageSquare size={24} className="text-accent" /><h1 className="font-medium">{t('quickChat.newTask')}</h1><p className="max-w-sm text-xs text-muted">{t('quickChat.newTaskDescription')}</p>{!state.workspaceId && <p className="max-w-sm text-xs text-muted">{t('quickChat.chooseProjectFirst')}</p>}</div>}
            {state.mode === 'session' && !state.binding && !state.loading && <p className="py-6 text-center text-xs text-muted">{t('quickChat.targetUnavailable')}</p>}
            {state.mode === 'session' && state.binding && !state.loading && !state.messages.length && !state.busy && <p className="py-6 text-center text-xs text-muted">{t('quickChat.startConversation')}</p>}
            {renderItems.map((item) => item.kind === 'toolGroup' ? <ToolGroupBubble key={item.id} title={item.title} messages={item.messages} /> : <MessageBubble key={item.message.id} message={item.message} readOnly />)}
            {(state.busy || state.content || state.thinking || state.tools.size > 0) && <StreamingBubble content={state.content} thinking={state.thinking} toolCalls={state.tools} />}
            {!atBottom && <button className="sticky bottom-1 mx-auto flex rounded-full border border-border bg-surface p-2 text-secondary shadow-md" title={t('chat.scrollToBottom')} aria-label={t('chat.scrollToBottom')} onClick={() => { if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; followTail.current = true; setAtBottom(true) }}><ArrowDown size={14} /></button>}
          </div>
          <div className="shrink-0 pb-3 pt-2">
            {state.busy && <p className="px-4 pb-2 text-xs text-muted">{t('quickChat.steerHint')}</p>}
            <ChatInput dropZoneRef={dropZone} />
          </div>
          <ExtensionUiDialog />
        </main>
      </ReadOnlyChatContext.Provider>
    </ChatSessionContext.Provider>
  )
}
