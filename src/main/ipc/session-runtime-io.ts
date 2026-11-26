import type { SessionRuntimeInfo } from '../../shared/ipc-contracts'
import type { WorkspaceManager } from '../workspace-manager'
import { PiRpcManager } from '../pi-rpc-manager'
import { trimGetMessagesResponse, trimMessagesForUi } from '../get-messages-trim'
import { withStoppedAnswers } from '../omp-stopped-answers'
import { readSessionEntries } from '../session-jsonl'
import { isObject } from './validation'
import { applyModelDefaults, applyResumePreference, applyPermissionModeToStartOptions } from './pi-start-options'
import { loadAppSettings } from './settings'
import { existsSync } from 'fs'
import { t } from '../../shared/i18n'

/** A stopped session larger than this is not loaded for a passive secondary read. */
const MAX_STOPPED_SESSION_BYTES = 8 * 1024 * 1024

const starts = new WeakMap<PiRpcManager, Promise<void>>()


/** All views share the same engine-owner, permission and linked-task startup path. */
export async function ensureSessionRuntimeStarted(wm: WorkspaceManager, runtime: SessionRuntimeInfo): Promise<void> {
  const manager = wm.getSessionRuntimeManager(runtime.runtimeId)
  if (!manager) throw new Error(t('errors.session.runtimeNotFound', { runtimeId: runtime.runtimeId }))
  const inFlight = starts.get(manager)
  if (inFlight) return inFlight
  if (manager.getStatus().status === 'running') return
  const start = (async () => {
    const settings = await loadAppSettings(wm)
    const workspace = wm.getWorkspaces().find((item) => item.id === runtime.workspaceId)
    if (!workspace || !wm.getSessionRuntime(runtime.runtimeId)) throw new Error(t('errors.session.runtimeNotFound', { runtimeId: runtime.runtimeId }))
    const sessionPath = runtime.sessionPath && existsSync(runtime.sessionPath) ? runtime.sessionPath : undefined
    const options = applyModelDefaults({
      cwd: workspace.path,
      ...(sessionPath ? { sessionPath } : { continueSession: false }),
      args: settings.defaultArgs,
    }, settings)
    const started = await wm.startSessionRuntime(runtime.runtimeId, applyPermissionModeToStartOptions(
      sessionPath ? applyResumePreference(options, settings) : options, settings,
    ))
    if (started.closed || started.status !== 'running') throw new Error(started.error ?? t('errors.pi.processExited'))
  })()
  starts.set(manager, start)
  try { await start } finally { if (starts.get(manager) === start) starts.delete(manager) }
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
  return trimMessagesForUi(entries.filter((entry) => entry.type === 'message' && isObject(entry.message)).map((entry) => entry.message))
}
