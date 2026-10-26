import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import type { QuickChatBinding, QuickChatContext, QuickChatSnapshot, QuickChatUpdate } from '../../shared/quick-chat'
import { QUICK_CHAT_CHANNELS } from '../../shared/quick-chat'
import { IPC_CHANNELS, promptRefusal, SUPPORTED_IMAGE_EXTENSIONS, type AttachmentReadResult, type ModelInfo, type PiExtensionUiRequest, type PiRpcEvent, type PromptImage, type SessionRuntimeInfo, type Workspace } from '../../shared/ipc-contracts'
import { buildPlanningPrompt } from '../../shared/planning-prompt'
import { pathsEqual } from '../../shared/path-compare'
import { t } from '../../shared/i18n'
import type { PiRpcManager } from '../pi-rpc-manager'
import type { PiEventRouter, PiEventRouterDeps } from '../pi-event-router'
import { getQuickChatWindow, hideQuickChatWindow, markQuickChatNativeModal, setQuickChatPinned, setQuickChatVisibilityHandler } from '../quick-chat-window'
import { getI18nEnvironment } from '../i18n'
import { getGuiDataDir } from '../app-data-paths'
import { listUserThemes } from '../theme-store'
import { isWithinSessionRoots } from '../pi-paths'
import { assertTrustedSender, isObject, isString } from './validation'
import { createListSessions } from './session-handlers'
import { loadAppSettings } from './settings'
import { ensureSessionRuntimeStarted, queryModelCatalog, readRuntimeMessages, readStoppedRuntimeMessages } from './session-runtime-io'
import { readAttachment } from '../attachment-reader'
import { requestWorkspaceActivation, type WindowControls } from './workspace-activity-wiring'
import type { IpcContext } from './context'

export interface QuickChatWindowAccess {
  getWindow: () => Electron.BrowserWindow | null
  hide: () => void
  onVisibility: (handler: (visible: boolean) => void) => void
  setPinned?: (value: boolean) => void
}

/** Main owns the only binding. No popup operation changes the main active session. */
export function createQuickChatHandlers(
  ctx: IpcContext,
  windowControls: WindowControls,
  windowAccess: QuickChatWindowAccess = {
    getWindow: getQuickChatWindow,
    hide: hideQuickChatWindow,
    onVisibility: setQuickChatVisibilityHandler,
    setPinned: setQuickChatPinned,
  },
): {
  routing: Pick<PiEventRouterDeps, 'getSecondaryManager' | 'preferSecondaryView' | 'sendSecondaryEvent' | 'sendSecondaryApproval'>
  register(router: PiEventRouter): void
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
  const listSessions = createListSessions(wm)
  // Recency stamp for each runtime, bumped on any runtime change (creation,
  // activity, status, session file). Drives the popup's recent-task ordering;
  // the renderer never needs the raw timestamps beyond ordering, so wall clock
  // is enough here.
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
    if (createdRuntimeId && !live.has(createdRuntimeId)) createdRuntimeId = null
    send({ type: 'runtimes', runtimes, updatedAt: runtimeTimestamps() })
  }

  function bind(runtime: SessionRuntimeInfo | null): void {
    release?.()
    release = runtime ? wm.retainSessionRuntime(runtime.runtimeId) : null
    binding = runtime ? { version: ++version, runtime } : null
    persistedPath = runtime?.sessionPath && existsSync(runtime.sessionPath) ? runtime.sessionPath : null
    if (!runtime) version++
    selection++
    send({ type: 'binding', binding })
    router?.refreshOwners()
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
    const manager = wm.getSessionRuntimeManager(current.runtime.runtimeId)
    if (!manager) throw new Error(t('quickChat.errors.targetUnavailable'))
    return { binding: current, manager }
  }

  async function changeRuntimeConfig(inputVersion: unknown, command: Record<string, unknown>) {
    const captured = requireBinding(inputVersion)
    const manager = wm.getSessionRuntimeManager(captured.runtime.runtimeId)
    if (!manager) throw new Error(t('quickChat.errors.targetUnavailable'))
    // A config pick never starts a stopped runtime or interrupts work/approval.
    if (manager.getStatus().status !== 'running') throw new Error(t('quickChat.errors.runtimeBusy'))
    const current = wm.getSessionRuntime(captured.runtime.runtimeId)
    if (current?.activity === 'working' || current?.activity === 'needs-approval' || router!.getSecondaryRequest()) {
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
      preferSecondaryView: () => windowAccess.getWindow()?.isVisible() ?? false,
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
    register(eventRouter) {
      router = eventRouter
      windowAccess.onVisibility((visible) => {
        send({ type: 'visibility', visible })
        router?.refreshOwners()
      })
      const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => {
        ipcMain.handle(channel, async (event, ...args: unknown[]) => {
          assertPopup(event)
          return handler(...args)
        })
      }
      handle(QUICK_CHAT_CHANNELS.context, async (): Promise<QuickChatContext> => {
        const [sessions, settings, themeList] = await Promise.all([
          listSessions(''), loadAppSettings(wm), listUserThemes(join(getGuiDataDir(), 'themes')),
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
          // Active workspace when there is one; otherwise the most recently
          // active folder. The controller remembers the user's own selection
          // afterward, so this is only the initial default.
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
          runtime = wm.openSessionRuntime(workspace.id, target.sessionPath)
        } else throw new Error('Invalid Quick Chat target')
        if (!runtime || runtime.closed) throw new Error(t('quickChat.errors.targetUnavailable'))
        if (attempt !== targetAttempt) throw new Error(t('quickChat.errors.staleBinding'))
        createdRuntimeId = null
        bind(runtime)
        return binding!
      })
      handle(QUICK_CHAT_CHANNELS.snapshot, async (input): Promise<QuickChatSnapshot> => {
        const captured = requireBinding(input)
        const manager = wm.getSessionRuntimeManager(captured.runtime.runtimeId)
        if (!manager) throw new Error(t('quickChat.errors.targetUnavailable'))
        const capturedSelection = selection
        // A snapshot is a passive read: it must never start a stopped runtime.
        // Only the user's own submit/steer resumes one, so a status change, an
        // agent end or a hide/show refill cannot defeat the live-process budget
        // or retry a startup that keeps failing. History comes from the session
        // file; a starting runtime still waits on its in-flight start.
        if (manager.getStatus().status !== 'running' && manager.getStatus().status !== 'starting') {
          const messages = await readStoppedRuntimeMessages(captured.runtime)
          if (selection !== capturedSelection || !binding || binding.version !== captured.version) throw new Error(t('quickChat.errors.staleBinding'))
          // The runtime is not answering: the model/thinking it used last are
          // unconfirmed, and the permission mode stays the one it last started
          // with (null when it never started through the app's startup path).
          return {
            binding: requireBinding(binding.version), messages, streaming: null, request: router!.getSecondaryRequest(),
            model: null, thinkingLevel: null, permissionMode: wm.getSessionRuntimePermissionMode(captured.runtime.runtimeId),
          }
        }
        const target = await ready(captured)
        const [response, state] = await Promise.all([
          readRuntimeMessages(wm, target.manager), target.manager.sendCommand({ type: 'get_state' }),
        ])
        if (selection !== capturedSelection || !binding || binding.version !== target.binding.version) throw new Error(t('quickChat.errors.staleBinding'))
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
        const rawImages = isObject(input) && Array.isArray((input as Record<string, unknown>).images)
          ? ((input as Record<string, unknown>).images as unknown[])
          : undefined
        let images: PromptImage[] | undefined
        if (rawImages && rawImages.length > 0) {
          for (const img of rawImages) {
            if (!isObject(img) || img.type !== 'image' || typeof img.mimeType !== 'string' || typeof img.data !== 'string') {
              throw new Error('Invalid Quick Chat image payload')
            }
          }
          images = rawImages as PromptImage[]
        }
        const hasText = isObject(input) && typeof input.text === 'string' && input.text.trim().length > 0
        const hasImages = Array.isArray(images) && images.length > 0
        if (!isObject(input) || typeof input.text !== 'string' || (!hasText && !hasImages) || input.text.length > 1_000_000 || (input.mode !== 'prompt' && input.mode !== 'steer')) throw new Error('Invalid Quick Chat submission')
        // A draft-selected config is optional; when present it must be well
        // formed, and a model change is never smuggled into a busy steer.
        const modelChoice = input.model
        const thinkingChoice = input.thinkingLevel
        const hasModel = modelChoice !== undefined && modelChoice !== null
        const hasThinking = typeof thinkingChoice === 'string' && thinkingChoice.length > 0
        if (hasModel && (!isObject(modelChoice) || typeof modelChoice.provider !== 'string' || typeof modelChoice.modelId !== 'string')) {
          throw new Error('Invalid Quick Chat model config')
        }
        const captured = requireBinding(input.version)
        const id = captured.runtime.runtimeId
        if (submitting.has(id)) throw new Error(t('quickChat.errors.submitting'))
        submitting.add(id)
        let promptStarted = false
        try {
          const target = await ready(captured)
          const capturedSelection = selection
          const [state, settings] = await Promise.all([target.manager.sendCommand({ type: 'get_state' }), loadAppSettings(wm)])
          if (selection !== capturedSelection || !binding || binding.version !== target.binding.version) throw new Error(t('quickChat.errors.staleBinding'))
          const stateData = isObject(state?.data) ? state.data : null
          if (typeof stateData?.isStreaming !== 'boolean') throw new Error(t('quickChat.errors.stateUnavailable'))
          // The renderer's cached intent (input.mode) can race the session's real
          // state: a turn may have started since an idle draft, or ended since a
          // steer. The authoritative snapshot routes the send instead of
          // rejecting, so the text always lands once on the intended runtime.
          const streaming = stateData.isStreaming
          const message = !streaming && settings.permissionMode === 'plan-readonly' ? buildPlanningPrompt(input.text) : input.text
          if (streaming) return target.manager.sendCommand({ type: 'steer', message, ...(images ? { images } : {}) })
          // Apply a draft-selected model/thinking level now that the runtime is
          // live: the choice was made while the session was stopped or before
          // its first send, and it must not be silently dropped.
          if (hasModel) {
            const applied = await target.manager.sendCommand({ type: 'set_model', provider: modelChoice.provider, modelId: modelChoice.modelId })
            if (!applied?.success) throw new Error(applied?.error ?? t('quickChat.errors.stateUnavailable'))
          }
          if (hasThinking) {
            await target.manager.sendCommand({ type: 'set_thinking_level', level: thinkingChoice })
          }
          wm.setSessionRuntimeActivity(id, 'working')
          promptStarted = true
          return await wm.promptSessionRuntime(id, message, images ? { images } : undefined)
        } catch (error) {
          const current = wm.getSessionRuntime(id)
          if (promptStarted && current?.activity === 'working') wm.setSessionRuntimeActivity(id, 'failed')
          throw error
        } finally { submitting.delete(id) }
      })
      handle(QUICK_CHAT_CHANNELS.listModels, async (input): Promise<ModelInfo[]> => {
        // The renderer passes the popup's own draft target (null = the
        // no-project home bucket); anything else must be a workspace that
        // exists. It decides whose config and custom models the query sees.
        let draftWorkspaceId: string | null = null
        if (input === undefined || input === null) draftWorkspaceId = null
        else if (isString(input)) draftWorkspaceId = input
        else throw new Error('Invalid Quick Chat model query target')
        const draftWorkspace = draftWorkspaceId
          ? wm.getWorkspaces().find((ws) => ws.id === draftWorkspaceId) ?? null
          : null
        if (draftWorkspaceId && !draftWorkspace) throw new Error(t('quickChat.errors.targetUnavailable'))
        // Prefer the bound runtime's own catalog when it is live: same engine,
        // same config context. Only when there is no live runtime does the
        // popup start the short-lived metadata query process.
        const manager = binding ? wm.getSessionRuntimeManager(binding.runtime.runtimeId) : null
        if (manager && manager.getStatus().status === 'running') {
          const response = await manager.sendCommand({ type: 'get_available_models' })
          const data = isObject(response?.data) ? response.data : null
          const models = data?.models
          if (Array.isArray(models)) return models as ModelInfo[]
        }
        const settings = await loadAppSettings(wm)
        const engine = manager?.getEngineKind()
        // Query from the popup's own target, never main's active workspace.
        // A draft names its project explicitly; a session being resumed has
        // no draft yet, so the runtime the popup owns decides.
        const targetRuntime = manager
          ? binding!.runtime
          : createdRuntimeId ? wm.getSessionRuntime(createdRuntimeId) : null
        const targetWorkspace = draftWorkspace
          ?? (targetRuntime ? wm.getWorkspaces().find((ws) => ws.id === targetRuntime.workspaceId) ?? null : null)
        return queryModelCatalog(wm, {
          engine,
          cwd: targetWorkspace?.path,
          provider: settings.defaultProvider ?? undefined,
          model: settings.defaultModel ?? undefined,
          thinkingLevel: settings.defaultThinkingLevel ?? undefined,
        })
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
        bind(runtime)
        return binding!
      })
      handle(QUICK_CHAT_CHANNELS.newDraft, () => {
        ++targetAttempt
        createdRuntimeId = null
        // Unbind without aborting, closing, denying or creating anything: the
        // runtime stays alive and owned by nothing, and any pending approval
        // remains unanswered rather than implicitly denied.
        if (binding) bind(null)
      })
      handle(QUICK_CHAT_CHANNELS.pickWorkspace, async (): Promise<Workspace | null> => {
        const window = windowAccess.getWindow()
        if (!window || window.isDestroyed()) throw new Error('Quick Chat window unavailable')
        // The parented native dialog steals OS focus from the popup; the blur
        // guard treats that as an owned interaction while it is open.
        markQuickChatNativeModal(true)
        let result: Electron.OpenDialogReturnValue
        try {
          result = await dialog.showOpenDialog(window, {
            title: t('dialogs.openProject.title'),
            properties: ['openDirectory', 'createDirectory'],
          })
        } finally {
          markQuickChatNativeModal(false)
        }
        if (result.canceled || result.filePaths.length === 0) return null
        const path = result.filePaths[0]
        if (!path) return null
        // Opening a project in the popup must not activate it in main.
        const created = await wm.createWorkspace(basename(path) || path, path, { activate: false })
        emitRuntimes()
        return created
      })
      handle(QUICK_CHAT_CHANNELS.pickAttachment, async (): Promise<AttachmentReadResult[]> => {
        const window = windowAccess.getWindow()
        if (!window || window.isDestroyed()) throw new Error('Quick Chat window unavailable')
        markQuickChatNativeModal(true)
        try {
          const result = await dialog.showOpenDialog(window, {
            title: t('common.attachFile'),
            properties: ['openFile', 'multiSelections'],
            filters: [
              { name: t('chat.attach.imagesFilter'), extensions: [...SUPPORTED_IMAGE_EXTENSIONS] },
              { name: t('chat.attach.allFilesFilter'), extensions: ['*'] },
            ],
          })
          if (result.canceled || result.filePaths.length === 0) return []
          const attachments: AttachmentReadResult[] = []
          for (const filePath of result.filePaths) {
            attachments.push(await readAttachment(filePath))
          }
          return attachments
        } finally {
          markQuickChatNativeModal(false)
        }
      })
      handle(QUICK_CHAT_CHANNELS.resolveHomeWorkspace, async (): Promise<Workspace | null> => {
        const home = app.getPath('home')
        if (!home) return null
        // "No project" sends the task from the home directory. The workspace
        // materializes only when the user actually sends, and never activates
        // in main — the popup must not move main's active-project pointer.
        return wm.createWorkspace('Home', home, { activate: false })
      })
      handle(QUICK_CHAT_CHANNELS.stop, async (input) => {
        const captured = requireBinding(input)
        const manager = wm.getSessionRuntimeManager(captured.runtime.runtimeId)
        if (!manager) throw new Error(t('quickChat.errors.targetUnavailable'))
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
      handle(QUICK_CHAT_CHANNELS.setPinned, (input) => {
        if (isObject(input) && typeof input.pinned === 'boolean') {
          windowAccess.setPinned?.(input.pinned)
        }
      })
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
