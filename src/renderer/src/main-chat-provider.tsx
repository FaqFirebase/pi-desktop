import { useMemo, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore, EMPTY_COMPOSER_DRAFT, type ComposerAttachment, type ComposerDraft } from './store'
import { ChatSessionContext, type ChatSessionBindings } from './chat-session-context'
import { isChatVisible, useCommandCatalog } from './hooks'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import { t } from '../../shared/i18n'
import { SUPPORTED_IMAGE_EXTENSIONS } from '../../shared/ipc-contracts'
import { composePrompt } from './utils/compose-prompt'
import { readAttachmentBatch, type AttachmentBatch } from './utils/attachment-batch'
import { TurnActivityLine } from './components/turn-activity-line'
import { SubagentProgress } from './components/subagent-progress'

const mainVoice: ChatSessionBindings['voice'] = {
  loadStatus: () => window.piDesktop.voice.status(),
  openSettings: () => useAppStore.getState().setCurrentView('settings'),
  globalShortcuts: true,
}

export function MainChatProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const state = useAppStore(useShallow((s) => ({
    workspaceId: s.activeWorkspace?.id ?? '', runtimeId: s.activeSessionRuntimeId,
    visible: isChatVisible(s), settings: s.settings, settingsDraft: s.settingsDraft,
    engine: s.piEngine, status: s.piStatus, session: s.sessionState,
    loading: s.sessionLoading, streaming: s.isStreaming,
    focusRequested: s.composerFocusRequested, pendingInsert: s.pendingInsert,
    history: s.promptHistory, historyBlocked: s.commandPaletteOpen,
    modelPickerOpen: s.modelPickerOpen, request: s.extensionUiRequest, notify: s.extensionNotify,
    queues: s.sendQueues, heldQueues: s.heldSendQueues,
  })))
  const { builtins, allCommands } = useCommandCatalog()
  const owner = useMemo(() => {
    const workspaceId = state.workspaceId
    return {
      readDraft: () => useAppStore.getState().composerDrafts[workspaceId] ?? EMPTY_COMPOSER_DRAFT,
      saveDraft: (draft: ComposerDraft) =>
        useAppStore.getState().saveComposerDraft(workspaceId, draft),
      submit: async (text: string, attachments: ComposerAttachment[], intent: 'send' | 'send-now'): Promise<boolean> => {
        const current = useAppStore.getState()
        if ((current.activeWorkspace?.id ?? '') !== workspaceId) return false
        if (intent === 'send' && current.isStreaming) {
          current.queuePrompt(workspaceId, text, attachments)
        } else {
          const prompt = composePrompt(text, attachments)
          await current.sendPrompt(prompt.message, prompt.options)
        }
        return true
      },
      pickAttachments: async (): Promise<AttachmentBatch> => {
        const paths = await window.piDesktop.system.openAttachmentDialog({
          title: t('common.attachFile'),
          filters: [
            { name: t('chat.attach.imagesFilter'), extensions: [...SUPPORTED_IMAGE_EXTENSIONS] },
            { name: t('chat.attach.allFilesFilter'), extensions: ['*'] },
          ],
        })
        const batch = await readAttachmentBatch(paths.map((path) => ({
          label: path, path, read: () => window.piDesktop.files.readAttachment(path),
        })), () => (useAppStore.getState().activeWorkspace?.id ?? '') === workspaceId)
        return batch ?? { attachments: [], errors: [] }
      },
    }
  }, [state.workspaceId])
  const bindings = useMemo<ChatSessionBindings>(() => {
    const settings = { ...DEFAULT_SETTINGS, ...state.settings, ...state.settingsDraft }
    const actions = useAppStore.getState()
    return {
      engine: state.engine ?? 'pi', settings, permissionMode: settings.permissionMode,
      setPermissionMode: actions.setPermissionMode,
      models: {
        scopeKey: state.runtimeId ?? state.workspaceId, status: state.status,
        model: state.session?.model ?? null, thinkingLevel: state.session?.thinkingLevel ?? null,
        pendingModel: null, pendingThinkingLevel: null, useDefaults: true, locked: false,
        open: state.modelPickerOpen,
        setOpen: (open) => useAppStore.setState({ modelPickerOpen: open }),
        list: actions.listModels,
        select: async (model) => {
          if (!(await useAppStore.getState().setModel(model.provider, model.id))) {
            throw new Error(t('store.messages.unknownError'))
          }
        },
        selectThinking: async (level) => {
          if (!(await useAppStore.getState().setThinkingLevel(level))) {
            throw new Error(t('store.messages.unknownError'))
          }
        },
        cycle: actions.cycleModel,
      },
      approval: {
        request: state.request, notify: state.notify, answering: false,
        respond: actions.respondExtensionUi, cancel: actions.dismissExtensionUi,
        dismissNotify: actions.dismissExtensionNotify,
      },
      composer: {
        scopeKey: state.workspaceId, active: state.visible, loading: state.loading,
        streaming: state.streaming, sending: false, focusRequested: state.focusRequested,
        requestFocus: () => useAppStore.setState({ composerFocusRequested: true }),
        clearFocusRequest: () => useAppStore.setState({ composerFocusRequested: false }),
        pendingInsert: state.pendingInsert, clearPendingInsert: actions.clearPendingInsert,
        ...owner,
        history: state.history, historyBlocked: state.historyBlocked, recordPrompt: actions.recordPrompt,
        stop: actions.abort, escape: 'abort',
        searchFiles: (query) => window.piDesktop.files.search(query),
        getPathForFile: (file) => window.piDesktop.system.getPathForFile(file),
        commands: allCommands, guiCommands: builtins,
        queue: {
          prompts: state.queues[state.workspaceId] ?? [], held: state.heldQueues.includes(state.workspaceId),
          remove: (id) => useAppStore.getState().removeQueuedPrompt(state.workspaceId, id),
          sendNow: (id) => useAppStore.getState().sendQueuedPromptNow(state.workspaceId, id),
        },
        openNotes: () => useAppStore.getState().setNotePickerOpen(true),
        searchWorkspace: actions.toggleFileSearch,
        runCouncil: settings.council.enabled ? actions.runCouncil : undefined,
        adornment: <>
          <TurnActivityLine onStop={actions.abort} />
          <div className="pointer-events-auto absolute bottom-full left-[5%] right-[5%] z-20 mb-0">
            <SubagentProgress />
          </div>
        </>,
      },
      voice: mainVoice,
    }
  }, [state, owner, builtins, allCommands])
  return <ChatSessionContext.Provider value={bindings}>{children}</ChatSessionContext.Provider>
}
