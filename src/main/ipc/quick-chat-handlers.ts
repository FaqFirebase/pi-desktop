import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'fs'
import { basename } from 'path'
import type { QuickChatAttachmentBatch, QuickChatBinding, QuickChatContext, QuickChatSnapshot, QuickChatUpdate } from '../../shared/quick-chat'
import { QUICK_CHAT_CHANNELS } from '../../shared/quick-chat'
import { IPC_CHANNELS, isRuntimeBusy, promptRefusal, type ModelInfo, type PiExtensionUiRequest, type PiResponseEvent, type PiRpcEvent, type PromptImage, type SessionRuntimeInfo, type UserThemeRecord, type Workspace } from '../../shared/ipc-contracts'
import { buildPlanningPrompt } from '../../shared/planning-prompt'
import { pathsEqual } from '../../shared/path-compare'
import { t } from '../../shared/i18n'
import { getConfiguredEngineKind, type PiRpcManager } from '../pi-rpc-manager'
import type { PiEventRouter, PiEventRouterDeps } from '../pi-event-router'
import { getQuickChatWindow, hideQuickChatWindow, setQuickChatFocusHandler, setQuickChatVisibilityHandler } from '../quick-chat-window'
import { getI18nEnvironment } from '../i18n'
import { listUserThemes } from '../theme-store'
import { engineForBoundSession, isWithinSessionRoots } from '../pi-paths'
import { assertTrustedSender, isObject, isString } from './validation'
import { createListSessions } from './session-handlers'
import { loadAppSettings } from './settings'
import { themesDir } from './theme-handlers'
import { ensureSessionRuntimeStarted, readRuntimeMessages, readStoppedRuntimeMessages } from './session-runtime-io'
import { queryModelCatalog } from './model-catalog-query'
import { attachmentDialogOptions } from '../../shared/attachment-dialog'
import { fetchCommands } from './skills-mcp-handlers'
import { buildVoiceStatus } from './voice-handlers'
import { readAttachment } from '../attachment-reader'
import { requestWorkspaceActivation, type WindowControls } from './workspace-activity-wiring'
import type { IpcContext } from './context'

export interface QuickChatWindowAccess {
  getWindow: () => Electron.BrowserWindow | null
  hide: () => void
  onVisibility: (handler: (visible: boolean) => void) => void
  onFocusChange: (handler: () => void) => void
}

interface ResolvedQueryTarget {
  workspace: Workspace
  runtime: QuickChatBinding | null
  manager: PiRpcManager | null
}

const MAX_SUBMISSION_TEXT_LENGTH = 1_000_000
const MENU_SETTINGS_CHANNEL = 'menu:settings'

interface Submission {
  version: unknown
  text: string
  images: PromptImage[] | undefined
  /** A draft-selected config rides only a prompt, never a busy steer. */
  model: { provider: string; modelId: string } | null
  thinkingLevel: string | null
}

function parseSubmission(input: unknown): Submission {
  if (!isObject(input)) throw new Error('Invalid Quick Chat submission')
  const rawImages = Array.isArray(input.images) ? input.images as unknown[] : []
  if (rawImages.some((image) => !isObject(image) || image.type !== 'image' || typeof image.mimeType !== 'string' || typeof image.data !== 'string')) {
    throw new Error('Invalid Quick Chat image payload')
  }
  const images = rawImages.length > 0 ? rawImages as PromptImage[] : undefined
  const { text, mode, model, thinkingLevel } = input
  if (typeof text !== 'string' || (!text.trim() && !images) || text.length > MAX_SUBMISSION_TEXT_LENGTH || (mode !== 'prompt' && mode !== 'steer')) {
    throw new Error('Invalid Quick Chat submission')
  }
  let modelChoice: Submission['model'] = null
  if (isObject(model) && typeof model.provider === 'string' && typeof model.modelId === 'string') {
    modelChoice = { provider: model.provider, modelId: model.modelId }
  } else if (model !== undefined && model !== null) throw new Error('Invalid Quick Chat model config')
  return {
    version: input.version, text, images, model: modelChoice,
    thinkingLevel: typeof thinkingLevel === 'string' && thinkingLevel.length > 0 ? thinkingLevel : null,
  }
}

/** A draft's model or thinking choice must reach the engine before its prompt does. */
function requireApplied(response: PiResponseEvent | null): void {
  if (!response?.success) throw new Error(response?.error ?? t('quickChat.errors.stateUnavailable'))
}

/** Main owns the only binding. No popup operation changes the main active session. */
export function createQuickChatHandlers(
  ctx: IpcContext,
  windowControls: WindowControls,
  windowAccess: QuickChatWindowAccess = {
    getWindow: getQuickChatWindow,
    hide: hideQuickChatWindow,
    onVisibility: setQuickChatVisibilityHandler,
    onFocusChange: setQuickChatFocusHandler,
  },
): {
  routing: Pick<PiEventRouterDeps, 'getSecondaryManager' | 'preferSecondaryView' | 'sendSecondaryEvent' | 'sendSecondaryApproval'>
  register(router: PiEventRouter): void
  updateThemes(themes: UserThemeRecord[]): void
} {
  const wm = ctx.workspaceManager
  let binding: QuickChatBinding | null = null
  let version = 0
  let release: (() => void) | null = null
  let router: PiEventRouter | null = null
  let selection = 0
  let targetAttempt = 0
  let persistedPath: string | null = null
  const submitting = new Set<string>()
  let createdRuntimeId: string | null = null
  // Runtimes the popup opened itself, and of those, the ones it sent work to.
  const popupOpened = new Set<string>()
  const popupPrompted = new Set<string>()
  const listSessions = createListSessions(wm)
  // Recency per runtime for the popup's recent-task order; wall clock is enough for ordering.
  const runtimeUpdatedAt = new Map<string, number>()
  for (const runtime of wm.getSessionRuntimes()) stampRuntime(runtime)

  function send(update: QuickChatUpdate): void {
    const window = windowAccess.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(QUICK_CHAT_CHANNELS.update, update)
  }

  function runtimeTimestamps(): Record<string, number> {
    return Object.fromEntries(runtimeUpdatedAt)
  }

  function stampRuntime(runtime: SessionRuntimeInfo): void {
    runtimeUpdatedAt.set(runtime.runtimeId, Date.now())
  }

  function emitRuntimes(): void {
    const runtimes = wm.getSessionRuntimes()
    const live = new Set(runtimes.map((runtime) => runtime.runtimeId))
    for (const id of runtimeUpdatedAt.keys()) {
      if (!live.has(id)) runtimeUpdatedAt.delete(id)
    }
    for (const ids of [popupOpened, popupPrompted]) {
      for (const id of ids) if (!live.has(id)) ids.delete(id)
    }
    if (createdRuntimeId && !live.has(createdRuntimeId)) createdRuntimeId = null
    send({ type: 'runtimes', runtimes, updatedAt: runtimeTimestamps() })
  }

  /**
   * A runtime the popup opened only to look at, or a new task that never got a
   * session, would otherwise stay behind as a main tab. Real work stays open,
   * and so does whatever main is showing.
   */
  function closeIfOnlyViewed(runtimeId: string): void {
    if (!popupOpened.delete(runtimeId)) return
    const prompted = popupPrompted.delete(runtimeId)
    const runtime = wm.getSessionRuntime(runtimeId)
    if (!runtime || runtime.closed || runtime.active) return
    const emptyNewTask = runtime.sessionPath === null && runtime.status !== 'running' && runtime.status !== 'starting'
    if (!emptyNewTask && (prompted || runtime.activity !== null)) return
    void wm.closeSessionRuntime(runtimeId)
      .catch((error: unknown) => console.error('[quick-chat] Failed to close a runtime the popup opened:', error))
  }

  function bind(runtime: SessionRuntimeInfo | null): void {
    const left = binding && binding.runtime.runtimeId !== runtime?.runtimeId ? binding.runtime.runtimeId : null
    release?.()
    release = runtime ? wm.retainSessionRuntime(runtime.runtimeId) : null
    binding = runtime ? { version: ++version, runtime } : null
    persistedPath = runtime?.sessionPath && existsSync(runtime.sessionPath) ? runtime.sessionPath : null
    if (!runtime) version++
    selection++
    send({ type: 'binding', binding })
    router?.refreshOwners()
    if (left) closeIfOnlyViewed(left)
  }

  function requireBinding(input: unknown): QuickChatBinding {
    if (!Number.isSafeInteger(input) || !binding || input !== binding.version) {
      throw new Error(t('quickChat.errors.staleBinding'))
    }
    const runtime = wm.getSessionRuntime(binding.runtime.runtimeId)
    if (!runtime || runtime.closed || !wm.getWorkspaces().some((ws) => ws.id === runtime.workspaceId)) {
      bind(null)
      throw new Error(t('quickChat.errors.targetUnavailable'))
    }
    if (runtime.sessionPath && !existsSync(runtime.sessionPath) &&
      (persistedPath === runtime.sessionPath || (runtime.status !== 'running' && runtime.status !== 'starting'))) {
      bind(null)
      throw new Error(t('quickChat.errors.targetUnavailable'))
    }
    return { version: binding.version, runtime }
  }

  function resolveQueryTarget(input: unknown): ResolvedQueryTarget {
    if (!isObject(input) || Object.keys(input).length !== 2) throw new Error('Invalid Quick Chat query target')
    const runtime = input.kind === 'runtime' ? requireBinding(input.version) : null
    if (!runtime && (input.kind !== 'draft' || !isString(input.workspaceId))) throw new Error('Invalid Quick Chat query target')
    const workspaceId = runtime ? runtime.runtime.workspaceId : input.workspaceId
    const workspace = wm.getWorkspaces().find((item) => item.id === workspaceId)
    if (!workspace) throw new Error(t('quickChat.errors.targetUnavailable'))
    return { workspace, runtime, manager: runtime ? wm.getSessionRuntimeManager(runtime.runtime.runtimeId) : draftManager(workspace.id) }
  }

  /**
   * A new task starts on the configured engine, so main's runtime in the
   * project can answer for a draft only when it runs that same engine.
   */
  function draftManager(workspaceId: string): PiRpcManager | null {
    const manager = wm.getPiManager(workspaceId)
    return manager?.getEngineKind() === getConfiguredEngineKind() ? manager : null
  }

  function assertQueryCurrent(target: ResolvedQueryTarget): void {
    if (target.runtime) requireBinding(target.runtime.version)
    else if (!wm.getWorkspaces().some((item) => item.id === target.workspace.id)) throw new Error(t('quickChat.errors.targetUnavailable'))
  }

  function requireManager(runtimeId: string): PiRpcManager {
    const manager = wm.getSessionRuntimeManager(runtimeId)
    if (!manager) throw new Error(t('quickChat.errors.targetUnavailable'))
    return manager
  }

  /** The popup moved on (another target, or a rebind) since `capturedSelection`. */
  function isStale(capturedSelection: number, capturedVersion: number): boolean {
    return selection !== capturedSelection || !binding || binding.version !== capturedVersion
  }

  async function ready(captured: QuickChatBinding): Promise<{ binding: QuickChatBinding; manager: PiRpcManager }> {
    const targetSelection = selection
    await ensureSessionRuntimeStarted(wm, captured.runtime)
    if (selection !== targetSelection || !binding || binding.runtime.runtimeId !== captured.runtime.runtimeId) {
      throw new Error(t('quickChat.errors.staleBinding'))
    }
    const current = requireBinding(binding.version)
    if (captured.runtime.status === 'running' && current.version !== captured.version) {
      throw new Error(t('quickChat.errors.staleBinding'))
    }
    return { binding: current, manager: requireManager(current.runtime.runtimeId) }
  }

  async function changeRuntimeConfig(inputVersion: unknown, command: Record<string, unknown>) {
    const captured = requireBinding(inputVersion)
    const manager = requireManager(captured.runtime.runtimeId)
    // A config pick never starts a stopped runtime or interrupts work/approval.
    if (manager.getStatus().status !== 'running') throw new Error(t('quickChat.errors.runtimeBusy'))
    const current = wm.getSessionRuntime(captured.runtime.runtimeId)
    if (isRuntimeBusy(current?.activity) || router!.getSecondaryRequest()) {
      throw new Error(t('quickChat.errors.runtimeBusy'))
    }
    const response = await manager.sendCommand(command)
    if (!response?.success) throw new Error(response?.error ?? t('quickChat.errors.stateUnavailable'))
    ctx.broadcast(IPC_CHANNELS.EVENT_RUNTIME_STATE_CHANGED, { runtimeId: captured.runtime.runtimeId })
    return response
  }

  function assertPopup(event: IpcMainInvokeEvent): void {
    assertTrustedSender(event)
    const window = windowAccess.getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Unauthorized Quick Chat sender')
    }
  }

  wm.onSessionRuntime((runtime) => {
    if (runtime.closed) {
      runtimeUpdatedAt.delete(runtime.runtimeId)
      if (createdRuntimeId === runtime.runtimeId) createdRuntimeId = null
    } else stampRuntime(runtime)
    emitRuntimes()
    if (runtime.closed) {
      if (binding && runtime.runtimeId === binding.runtime.runtimeId) bind(null)
      return
    }
    if (!binding || runtime.runtimeId !== binding.runtime.runtimeId) return
    // A process replacement invalidates requests from its previous incarnation.
    if (runtime.status === 'starting' && binding.runtime.status !== 'starting') version++
    binding = { version, runtime }
    if (runtime.sessionPath && existsSync(runtime.sessionPath)) persistedPath = runtime.sessionPath
    send({ type: 'binding', binding })
  })
  wm.onWorkspaceRemoved((id) => {
    if (id === binding?.runtime.workspaceId) bind(null)
    emitRuntimes()
  })
  wm.onSessionRuntimeState((runtimeId) => {
    send({ type: 'runtime-state', runtimeId })
  })

  return {
    routing: {
      getSecondaryManager: () => binding ? wm.getSessionRuntimeManager(binding.runtime.runtimeId) : null,
      // The window in use owns a shared runtime's approval, so a popup behind
      // the main window never takes a dialog the user cannot see.
      preferSecondaryView: () => {
        const window = windowAccess.getWindow()
        return !!window && window.isVisible() && window.isFocused()
      },
      sendSecondaryEvent: (manager: PiRpcManager, event: PiRpcEvent) => {
        if (binding && wm.runtimeIdFor(manager) === binding.runtime.runtimeId) {
          send({ type: 'event', version: binding.version, runtimeId: binding.runtime.runtimeId, event })
        }
      },
      sendSecondaryApproval: (manager: PiRpcManager, request: PiExtensionUiRequest | null) => {
        if (binding && wm.runtimeIdFor(manager) === binding.runtime.runtimeId) {
          send({ type: 'approval', version: binding.version, request })
        }
      },
    },
    updateThemes: (themes: UserThemeRecord[]) => send({ type: 'themes', themes }),
    register(eventRouter) {
      router = eventRouter
      windowAccess.onVisibility((visible) => {
        send({ type: 'visibility', visible })
        router?.refreshOwners()
      })
      windowAccess.onFocusChange(() => router?.refreshOwners())
      const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => {
        ipcMain.handle(channel, async (event, ...args: unknown[]) => {
          assertPopup(event)
          return handler(...args)
        })
      }
      handle(QUICK_CHAT_CHANNELS.context, async (): Promise<QuickChatContext> => {
        const [sessions, settings, themeList] = await Promise.all([
          listSessions(''), loadAppSettings(wm), listUserThemes(themesDir()),
        ])
        const workspaces = wm.getWorkspaces()
        const defaultWorkspace = wm.getActiveWorkspace() ?? workspaces.reduce<Workspace | null>(
          (latest, workspace) => !latest || workspace.lastActiveAt > latest.lastActiveAt ? workspace : latest, null,
        )
        return {
          binding,
          runtimes: wm.getSessionRuntimes(),
          sessions: sessions.filter((session) => workspaces.some((ws) => pathsEqual(ws.path, session.projectPath))),
          workspaces,
          // Initial default only: the controller keeps the user's own pick afterward.
          defaultWorkspaceId: defaultWorkspace?.id ?? null,
          runtimeUpdatedAt: runtimeTimestamps(),
          settings,
          i18nEnvironment: getI18nEnvironment(),
          themes: themeList.themes,
        }
      })
      handle(QUICK_CHAT_CHANNELS.select, async (target): Promise<QuickChatBinding> => {
        if (!isObject(target)) throw new Error('Invalid Quick Chat target')
        const attempt = ++targetAttempt
        let runtime: SessionRuntimeInfo | null
        if (typeof target.runtimeId === 'string' && Object.keys(target).length === 1) {
          runtime = wm.getSessionRuntime(target.runtimeId)
        } else if (typeof target.workspaceId === 'string' && typeof target.sessionPath === 'string' && Object.keys(target).length === 2) {
          const workspace = wm.getWorkspaces().find((ws) => ws.id === target.workspaceId)
          if (!workspace || !isWithinSessionRoots(target.sessionPath) || !existsSync(target.sessionPath)) {
            throw new Error(t('quickChat.errors.targetUnavailable'))
          }
          const sessions = await listSessions('')
          if (attempt !== targetAttempt) throw new Error(t('quickChat.errors.staleBinding'))
          if (!sessions.some((session) => pathsEqual(session.path, target.sessionPath as string) && pathsEqual(session.projectPath, workspace.path))) {
            throw new Error(t('quickChat.errors.targetUnavailable'))
          }
          const sessionPath = target.sessionPath
          const alreadyOpen = wm.getSessionRuntimes().some((item) => item.sessionPath !== null && pathsEqual(item.sessionPath, sessionPath))
          runtime = wm.openSessionRuntime(workspace.id, sessionPath)
          if (!alreadyOpen) popupOpened.add(runtime.runtimeId)
        } else throw new Error('Invalid Quick Chat target')
        if (!runtime || runtime.closed) throw new Error(t('quickChat.errors.targetUnavailable'))
        if (attempt !== targetAttempt) throw new Error(t('quickChat.errors.staleBinding'))
        createdRuntimeId = null
        bind(runtime)
        return binding!
      })
      // A snapshot is a background read, so a selection change while it is in
      // flight is normal: it answers null (nothing to apply), not an error.
      handle(QUICK_CHAT_CHANNELS.snapshot, async (input): Promise<QuickChatSnapshot | null> => {
        if (!binding || input !== binding.version) return null
        const captured = requireBinding(input)
        const manager = requireManager(captured.runtime.runtimeId)
        const capturedSelection = selection
        // A passive read never starts a stopped runtime: that would bypass the live-process budget or retry a failing start. History comes from the session file.
        if (manager.getStatus().status !== 'running' && manager.getStatus().status !== 'starting') {
          const messages = await readStoppedRuntimeMessages(captured.runtime)
          if (isStale(capturedSelection, captured.version)) return null
          // A silent runtime's last model and thinking level are unconfirmed; its permission mode is the one it last started with.
          return {
            binding: requireBinding(binding.version), messages, streaming: null, request: router!.getSecondaryRequest(),
            model: null, thinkingLevel: null, permissionMode: wm.getSessionRuntimePermissionMode(captured.runtime.runtimeId),
          }
        }
        let target: Awaited<ReturnType<typeof ready>>
        try {
          target = await ready(captured)
        } catch (error) {
          if (isStale(capturedSelection, captured.version)) return null
          throw error
        }
        const [response, state] = await Promise.all([
          readRuntimeMessages(wm, target.manager), target.manager.sendCommand({ type: 'get_state' }),
        ])
        if (isStale(capturedSelection, target.binding.version)) return null
        const data = isObject(response) && isObject(response.data) ? response.data : null
        const stateData = isObject(state?.data) ? state.data : null
        return {
          binding: requireBinding(binding.version), messages: Array.isArray(data?.messages) ? data.messages : [], streaming: stateData?.isStreaming === true ? target.manager.getStreamingText() : null, request: router!.getSecondaryRequest(),
          model: isObject(stateData?.model) ? (stateData.model as unknown as ModelInfo) : null,
          thinkingLevel: typeof stateData?.thinkingLevel === 'string' ? stateData.thinkingLevel : null,
          permissionMode: wm.getSessionRuntimePermissionMode(captured.runtime.runtimeId),
        }
      })
      handle(QUICK_CHAT_CHANNELS.submit, async (input) => {
        const { version: inputVersion, text, images, model: modelChoice, thinkingLevel: thinkingChoice } = parseSubmission(input)
        const captured = requireBinding(inputVersion)
        const id = captured.runtime.runtimeId
        if (submitting.has(id)) throw new Error(t('quickChat.errors.submitting'))
        submitting.add(id)
        let promptStarted = false
        try {
          const target = await ready(captured)
          const capturedSelection = selection
          const [state, settings] = await Promise.all([target.manager.sendCommand({ type: 'get_state' }), loadAppSettings(wm)])
          if (isStale(capturedSelection, target.binding.version)) throw new Error(t('quickChat.errors.staleBinding'))
          const stateData = isObject(state?.data) ? state.data : null
          if (typeof stateData?.isStreaming !== 'boolean') throw new Error(t('quickChat.errors.stateUnavailable'))
          // input.mode can be stale; the engine's own state picks prompt or steer, so the text lands once.
          const streaming = stateData.isStreaming
          const message = !streaming && settings.permissionMode === 'plan-readonly' ? buildPlanningPrompt(text) : text
          if (streaming) return target.manager.sendCommand({ type: 'steer', message, ...(images ? { images } : {}) })
          // A choice made while stopped or before the first send applies now that the engine is live.
          if (modelChoice) {
            requireApplied(await target.manager.sendCommand({ type: 'set_model', provider: modelChoice.provider, modelId: modelChoice.modelId }))
          }
          if (thinkingChoice) {
            requireApplied(await target.manager.sendCommand({ type: 'set_thinking_level', level: thinkingChoice }))
          }
          wm.setSessionRuntimeActivity(id, 'working')
          promptStarted = true
          if (popupOpened.has(id)) popupPrompted.add(id)
          return await wm.promptSessionRuntime(id, message, images ? { images } : undefined)
        } catch (error) {
          const current = wm.getSessionRuntime(id)
          if (promptStarted && current?.activity === 'working') wm.setSessionRuntimeActivity(id, 'failed')
          throw error
        } finally { submitting.delete(id) }
      })
      handle(QUICK_CHAT_CHANNELS.listModels, async (input): Promise<ModelInfo[]> => {
        const target = resolveQueryTarget(input)
        const live = target.manager?.getStatus().status === 'running' ? target.manager : null
        if (live) {
          const response = await live.sendCommand({ type: 'get_available_models' })
          assertQueryCurrent(target)
          const data = isObject(response?.data) ? response.data : null
          if (Array.isArray(data?.models)) return data.models as ModelInfo[]
        }
        const models = await queryModelCatalog(wm, {
          cwd: target.workspace.path,
          engine: live?.getEngineKind() ?? engineForBoundSession({ sessionPath: target.runtime?.runtime.sessionPath ?? undefined }) ?? undefined,
        })
        assertQueryCurrent(target)
        return models
      })
      handle(QUICK_CHAT_CHANNELS.searchFiles, async (input) => {
        if (!isObject(input) || !isString(input.query)) throw new Error('Invalid Quick Chat file query')
        const target = resolveQueryTarget(input.target)
        const files = wm.getFileService(target.workspace.id)
        if (!files) throw new Error(t('quickChat.errors.targetUnavailable'))
        const results = await files.searchFiles(input.query)
        assertQueryCurrent(target)
        return results
      })
      handle(QUICK_CHAT_CHANNELS.listCommands, async (input): Promise<unknown[]> => {
        const target = resolveQueryTarget(input)
        // A stopped target has no available RPC catalog; passive completion
        // never starts or resumes an agent.
        if (!target.manager || target.manager.getStatus().status !== 'running') return []
        const commands = await fetchCommands(target.manager)
        assertQueryCurrent(target)
        return commands
      })
      handle(QUICK_CHAT_CHANNELS.voiceStatus, () => buildVoiceStatus(wm))
      handle(QUICK_CHAT_CHANNELS.openSettings, () => {
        windowControls.showWindow()
        const window = windowControls.getWindow()
        if (!window || window.isDestroyed()) return
        if (window.webContents.isLoadingMainFrame()) {
          window.webContents.once('did-finish-load', () => {
            if (!window.isDestroyed()) window.webContents.send(MENU_SETTINGS_CHANNEL)
          })
        } else window.webContents.send(MENU_SETTINGS_CHANNEL)
      })
      handle(QUICK_CHAT_CHANNELS.setRuntimeModel, async (input) => {
        if (!isObject(input) || typeof input.provider !== 'string' || typeof input.modelId !== 'string') throw new Error('Invalid Quick Chat model config')
        return changeRuntimeConfig(input.version, { type: 'set_model', provider: input.provider, modelId: input.modelId })
      })
      handle(QUICK_CHAT_CHANNELS.setRuntimeThinking, async (input) => {
        if (!isObject(input) || typeof input.level !== 'string' || !input.level.trim()) throw new Error('Invalid Quick Chat thinking level')
        return changeRuntimeConfig(input.version, { type: 'set_thinking_level', level: input.level })
      })
      handle(QUICK_CHAT_CHANNELS.createSession, async (workspaceId): Promise<QuickChatBinding> => {
        if (!isString(workspaceId)) throw new Error('Invalid Quick Chat workspace')
        if (!wm.getWorkspaces().some((ws) => ws.id === workspaceId)) throw new Error(t('quickChat.errors.targetUnavailable'))
        ++targetAttempt
        const owned = createdRuntimeId && binding?.runtime.runtimeId === createdRuntimeId
          ? wm.getSessionRuntime(createdRuntimeId) : null
        const runtime = owned && owned.status === 'stopped' && owned.workspaceId === workspaceId && owned.sessionPath === null && !owned.closed
          ? owned : wm.createInactiveSessionRuntime(workspaceId)
        createdRuntimeId = runtime.runtimeId
        popupOpened.add(runtime.runtimeId)
        bind(runtime)
        return binding!
      })
      handle(QUICK_CHAT_CHANNELS.newDraft, () => {
        ++targetAttempt
        createdRuntimeId = null
        // Unbind only: the runtime keeps running and a pending approval stays unanswered.
        if (binding) bind(null)
      })
      handle(QUICK_CHAT_CHANNELS.pickWorkspace, async (): Promise<Workspace | null> => {
        const window = windowAccess.getWindow()
        if (!window || window.isDestroyed()) throw new Error('Quick Chat window unavailable')
        const result = await dialog.showOpenDialog(window, {
          title: t('dialogs.openProject.title'),
          properties: ['openDirectory', 'createDirectory'],
        })
        if (result.canceled || result.filePaths.length === 0) return null
        const path = result.filePaths[0]
        if (!path) return null
        // Opening a project in the popup must not activate it in main.
        const created = await wm.createWorkspace(basename(path) || path, path, { activate: false })
        emitRuntimes()
        return created
      })
      handle(QUICK_CHAT_CHANNELS.pickAttachment, async (): Promise<QuickChatAttachmentBatch> => {
        const window = windowAccess.getWindow()
        if (!window || window.isDestroyed()) throw new Error('Quick Chat window unavailable')
        const result = await dialog.showOpenDialog(window, { ...attachmentDialogOptions(), properties: ['openFile', 'multiSelections'] })
        const batch: QuickChatAttachmentBatch = { attachments: [], errors: [] }
        if (result.canceled) return batch
        for (const filePath of result.filePaths) {
          try {
            batch.attachments.push({ ...await readAttachment(filePath), path: filePath })
          } catch (error) {
            batch.errors.push(`${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return batch
      })
      handle(QUICK_CHAT_CHANNELS.stop, async (input) => {
        const captured = requireBinding(input)
        const manager = requireManager(captured.runtime.runtimeId)
        if (manager.getStatus().status !== 'running') return
        const response = await manager.sendCommand({ type: 'abort' })
        const refusal = promptRefusal(response)
        if (refusal) throw new Error(refusal.reason || t('quickChat.stopFailed'))
      })
      handle(QUICK_CHAT_CHANNELS.respond, (input) => {
        if (!isObject(input) || typeof input.id !== 'string' || !isObject(input.response)) throw new Error('Invalid Quick Chat response')
        requireBinding(input.version)
        const request = router!.getSecondaryRequest()
        if (!request || request.id !== input.id) throw new Error(t('quickChat.errors.staleApproval'))
        router!.respond(input.id, input.response, 'secondary')
      })
      handle(QUICK_CHAT_CHANNELS.hide, () => windowAccess.hide())
      handle(QUICK_CHAT_CHANNELS.openInMain, () => {
        if (binding) {
          const current = requireBinding(binding.version)
          requestWorkspaceActivation(ctx, windowControls, { workspaceId: current.runtime.workspaceId, runtimeId: current.runtime.runtimeId, ...(current.runtime.sessionPath ? { sessionPath: current.runtime.sessionPath } : {}) })
        } else windowControls.showWindow()
        windowAccess.hide()
      })
    },
  }
}
