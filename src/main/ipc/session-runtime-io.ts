import { app } from 'electron'
import type { AgentEngineKind, ModelInfo, SessionRuntimeInfo } from '../../shared/ipc-contracts'
import type { WorkspaceManager } from '../workspace-manager'
import { PiRpcManager, getConfiguredEngineKind } from '../pi-rpc-manager'
import { trimGetMessagesResponse } from '../get-messages-trim'
import { withStoppedAnswers } from '../omp-stopped-answers'
import { readSessionEntries } from '../session-jsonl'
import { isObject } from './validation'
import { applyResumePreference, applyPermissionModeToStartOptions } from './pi-start-options'
import { loadAppSettings } from './settings'
import { existsSync } from 'fs'
import { t } from '../../shared/i18n'
import { pathsEqual } from '../../shared/path-compare'

/** A stopped session larger than this is not loaded for a passive popup read. */
const MAX_STOPPED_SESSION_BYTES = 8 * 1024 * 1024

const starts = new WeakMap<PiRpcManager, Promise<void>>()

// The permission mode a runtime started with lives in the shared store
// (runtime-permission-mode-store.ts), recorded where every start path
// converges: WorkspaceManager.startSessionRuntime. Re-exported here for the
// popup's snapshot handler.
export { getRuntimePermissionMode, forgetRuntimePermissionMode } from '../runtime-permission-mode-store'

/** All views share the same engine-owner, permission and linked-task startup path. */
export async function ensureSessionRuntimeStarted(wm: WorkspaceManager, runtime: SessionRuntimeInfo): Promise<void> {
  const manager = wm.getSessionRuntimeManager(runtime.runtimeId)
  if (!manager) throw new Error(t('quickChat.errors.targetUnavailable'))
  const inFlight = starts.get(manager)
  if (inFlight) return inFlight
  if (manager.getStatus().status === 'running') return
  const start = (async () => {
    const settings = await loadAppSettings(wm)
    const workspace = wm.getWorkspaces().find((item) => item.id === runtime.workspaceId)
    if (!workspace || !wm.getSessionRuntime(runtime.runtimeId)) throw new Error(t('quickChat.errors.targetUnavailable'))
    const sessionPath = runtime.sessionPath && existsSync(runtime.sessionPath) ? runtime.sessionPath : undefined
    const options = {
      cwd: workspace.path,
      ...(sessionPath ? { sessionPath } : { continueSession: false }),
      provider: settings.defaultProvider ?? undefined,
      model: settings.defaultModel ?? undefined,
      defaultThinkingLevel: settings.defaultThinkingLevel ?? undefined,
      args: settings.defaultArgs,
    }
    const started = await wm.startSessionRuntime(runtime.runtimeId, applyPermissionModeToStartOptions(
      sessionPath ? applyResumePreference(options, settings) : options, settings,
    ))
    if (started.closed || started.status !== 'running') throw new Error(started.error ?? t('quickChat.errors.startFailed'))
  })()
  starts.set(manager, start)
  try { await start } finally { if (starts.get(manager) === start) starts.delete(manager) }
}

// ─── Model Catalog ───────────────────────────────────────────────────────────

/** In-flight no-session metadata queries, merged by identical start context. */
const catalogQueries = new Map<string, Promise<ModelInfo[]>>()

/**
 * The engine's real model catalog without a running session. This spawns a
 * short-lived RPC process with no session, no tools and no extensions: it never
 * sends a prompt, never calls a model, never registers a WorkspaceManager
 * runtime, never touches an existing session, and is reaped on success, failure
 * and cancellation. Identical concurrent requests share one process.
 */
export async function queryModelCatalog(
  wm: WorkspaceManager,
  options: { engine?: AgentEngineKind; cwd?: string; provider?: string; model?: string; thinkingLevel?: string } = {},
): Promise<ModelInfo[]> {
  const engine = options.engine ?? getConfiguredEngineKind()
  const settings = await loadAppSettings(wm)
  const provider = options.provider ?? settings.defaultProvider ?? undefined
  const model = options.model ?? settings.defaultModel ?? undefined
  const thinkingLevel = options.thinkingLevel ?? settings.defaultThinkingLevel ?? undefined
  // An absent project means Home, never the main window's active workspace.
  const home = app.getPath('home')
  const cwd = options.cwd ?? home
  // The context a catalog is resolved in: a project's own config, custom
  // models and settings can change the list, so the cwd is part of the merge
  // key — two projects querying at once never share one process.
  const key = JSON.stringify([engine, cwd, provider, model, thinkingLevel])
  const existing = catalogQueries.get(key)
  if (existing) return existing
  const promise = (async () => {
    const manager = new PiRpcManager()
    try {
      await manager.start({
        cwd,
        engine,
        noSession: true,
        provider,
        model,
        defaultThinkingLevel: thinkingLevel,
        // A metadata query is a read-only probe. Extensions, skills, MCP and
        // context discovery all run engine-side startup hooks (session_start
        // can write files or hit the network) before the first response, so
        // every discoverable side channel is disabled for both engines; the
        // process only answers get_available_models and is reaped.
        // (--no-tools alone does not stop extension *execution*.) The flag
        // sets differ per engine: OMP 18 has no --no-mcp and exits 2 on it,
        // which would break every catalog load, so each engine gets only the
        // flags its CLI actually supports.
        args: [
          ...(engine === 'omp'
            ? ['--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-title', '--no-lsp']
            : ['--no-tools', '--no-extensions', '--no-skills', '--no-mcp', '--no-prompt-templates', '--no-context-files']),
          ...(engine === 'omp' && pathsEqual(cwd, home) ? ['--allow-home'] : []),
        ],
      })
      if (manager.getStatus().status !== 'running') throw new Error(t('quickChat.errors.startFailed'))
      const response = await manager.sendCommand({ type: 'get_available_models' })
      const data = isObject(response?.data) ? response.data : null
      const models = data?.models
      if (!Array.isArray(models)) throw new Error(t('quickChat.errors.stateUnavailable'))
      return models as ModelInfo[]
    } finally {
      manager.stop()
      catalogQueries.delete(key)
    }
  })()
  catalogQueries.set(key, promise)
  return promise
}

/** Preserve stopped OMP answers and the existing IPC history size bound for every view. */
export async function readRuntimeMessages(wm: WorkspaceManager, manager: PiRpcManager): Promise<unknown> {
  if (manager.getStatus().status !== 'running') return null
  const response = await manager.sendCommand({ type: 'get_messages' })
  const sessionPath = manager.getEngineKind() === 'omp' ? wm.sessionPathFor(manager) : null
  return trimGetMessagesResponse(sessionPath ? await withStoppedAnswers(response, sessionPath) : response)
}

/**
 * Messages of a stopped runtime, read from its session file. This is a passive
 * read: it never starts the engine, so a snapshot of a stopped session cannot
 * defeat the live-process budget or retry a failed startup. A runtime without
 * a session file (an empty new tab) or an unreadable/oversized file yields no
 * messages, mirroring what get_messages would report for a fresh session.
 */
export async function readStoppedRuntimeMessages(runtime: SessionRuntimeInfo): Promise<unknown[]> {
  if (!runtime.sessionPath) return []
  const entries = await readSessionEntries(runtime.sessionPath, MAX_STOPPED_SESSION_BYTES)
  if (!entries) return []
  const messages = entries
    .filter((entry) => entry.type === 'message' && isObject(entry.message))
    .map((entry) => entry.message)
  const trimmed = trimGetMessagesResponse({ data: { messages } })
  const data = isObject(trimmed) && isObject(trimmed.data) ? trimmed.data : null
  return Array.isArray(data?.messages) ? data.messages : []
}
