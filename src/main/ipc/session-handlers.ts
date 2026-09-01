import { ipcMain } from 'electron'
import { isDisposableSessionFile, WorkspaceManager } from '../workspace-manager'
import { engineForSessionPath, getSessionRoots, isWithinSessionRoots } from '../pi-paths'
import {
  sanitizePath,
  sessionDirName,
  desanitizeSessionDir,
  isSessionArtifactDir,
  projectNameFromPath,
  JSONL_EXTENSION,
} from '../session-paths'
import { pathGroupKey as workspaceMatchKey, pathsEqual } from '../../shared/path-compare'
import { readSessionMetadataCached } from '../session-metadata'
import { readForkPointsCached } from '../omp-fork-points'
import { mapWithConcurrency } from '../map-concurrent'
import { readSessionLineage } from '../session-lineage-reader'
import { trimGetMessagesResponse } from '../get-messages-trim'
import { activityStatsStore } from '../activity-stats'
import type { SessionDeleteResult, SessionListItem, SessionRuntimeCloseResult, SessionRuntimeInfo } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { readdir, stat, unlink } from 'fs/promises'
import { basename, join, resolve } from 'path'
import { existsSync } from 'fs'
import { moveToTrash } from '../session-trash'
import { assertTrustedSender, isObject, isString } from './validation'
import { applyResumePreference, applyPermissionModeToStartOptions } from './pi-start-options'
import { loadAppSettings } from './settings'
import type { IpcContext } from './context'

const MAX_SESSION_LIST = 100

const SESSION_FILE_EXTENSION = '.jsonl'

function sessionIdFromPath(sessionPath: string): string {
  const base = basename(sessionPath)
  return base.endsWith(SESSION_FILE_EXTENSION)
    ? base.slice(0, -SESSION_FILE_EXTENSION.length)
    : base
}

/**
 * Delete a session file. Mirrors Pi's own session-selector deletion path:
 * move it to the desktop trash (recoverable), and only destroy it with
 * `unlink` when no trash helper is available — see session-trash.ts for why
 * more than one helper is tried.
 *
 * Why this lives in the GUI and not in Pi: Pi's RPC mode exposes no
 * delete_session command (verified against pi.dev/docs/latest/rpc).
 * The official guidance is "Sessions can be removed by deleting their
 * .jsonl files" — that's what this does.
 */
async function deleteSessionFile(sessionPath: string): Promise<SessionDeleteResult> {
  // The second test covers a helper that moved the file but still reported a
  // non-zero status; the session is in the trash either way, not destroyed.
  if (moveToTrash(sessionPath) || !existsSync(sessionPath)) {
    return { ok: true, method: 'trash' }
  }

  try {
    await unlink(sessionPath)
    return { ok: true, method: 'unlink' }
  } catch (err) {
    return {
      ok: false,
      method: 'unlink',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function registerSessionHandlers(ctx: IpcContext): void {
  const { workspaceManager, getActivePi, tagManager, archivedSessions } = ctx

  const startRuntime = async (runtime: SessionRuntimeInfo, sessionPath?: string): Promise<void> => {
    const settings = await loadAppSettings(workspaceManager)
    const workspace = workspaceManager.getWorkspaces().find((item) => item.id === runtime.workspaceId)
    if (!workspace) return
    const options = {
      cwd: workspace.path,
      ...(sessionPath ? { sessionPath } : {}),
      provider: settings.defaultProvider ?? undefined,
      model: settings.defaultModel ?? undefined,
    }
    await workspaceManager.startSessionRuntime(runtime.runtimeId, applyPermissionModeToStartOptions(
      sessionPath ? applyResumePreference(options, settings) : options,
      settings
    ))
  }

  // ─── Session Management ─────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SESSION_NEW, async (): Promise<SessionRuntimeInfo> => {
    const workspace = workspaceManager.getActiveWorkspace()
    if (!workspace) throw new Error('No active workspace')
    const runtime = await workspaceManager.createNewSessionRuntime(workspace.id)
    // Navigation must not wait for Pi startup. The runtime event marks it
    // starting/running and hydrates the renderer when ready.
    void startRuntime(runtime).catch(() => undefined)
    return runtime
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LAUNCH_TASK, async (_event, input: unknown): Promise<SessionRuntimeInfo> => {
    if (!isObject(input) || !isString(input.workspaceId) || !isString(input.prompt) || !input.prompt.trim()) {
      throw new Error('workspaceId and a non-empty prompt are required')
    }
    const workspace = workspaceManager.getWorkspaces().find((item) => item.id === input.workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    const runtime = await workspaceManager.createNewSessionRuntime(workspace.id)
    // Reserve the runtime while startup and prompt delivery are asynchronous;
    // list polling must not classify its header-only file as disposable.
    workspaceManager.setSessionRuntimeActivity(runtime.runtimeId, 'working')
    // Keep the prompt attached to this runtime. It must not go through the
    // renderer's active-manager shortcut because the user can switch away
    // before Pi finishes starting.
    void startRuntime(runtime)
      .then(() => workspaceManager.sendCommandToSessionRuntime(runtime.runtimeId, {
        type: 'prompt',
        message: input.prompt,
      }))
      .catch(() => workspaceManager.setSessionRuntimeActivity(runtime.runtimeId, 'failed'))
    return runtime
  })

  const activateSession = async (sessionPath: string, cwd?: string): Promise<SessionRuntimeInfo> => {
    if (!isWithinSessionRoots(sessionPath) || !existsSync(sessionPath)) {
      throw new Error('sessionPath must point to an existing Pi session file')
    }
    const workspace = workspaceManager.getActiveWorkspace()
    if (!workspace) throw new Error('No active workspace')
    if (cwd && !pathsEqual(workspace.path, cwd)) throw new Error('Session project does not match the active workspace')
    const runtime = await workspaceManager.activateSession(workspace.id, sessionPath)
    if (runtime.status !== 'running') void startRuntime(runtime, sessionPath).catch(() => undefined)
    return runtime
  }

  ipcMain.handle(IPC_CHANNELS.SESSION_CLOSE_RUNTIME, async (_event, runtimeId: unknown): Promise<SessionRuntimeCloseResult | null> => {
    if (!isString(runtimeId)) throw new Error('runtimeId must be a string')
    const result = await workspaceManager.closeSessionRuntime(runtimeId)
    if (!result) return null

    let deleted = false
    // Closing a tab may discard the throwaway session that tab just created,
    // and nothing else. isDisposableSessionFile carries the full rule.
    if (isDisposableSessionFile(result)) {
      activityStatsStore.captureBeforeDelete(result.sessionPath)
      const deleteResult = await deleteSessionFile(result.sessionPath)
      deleted = deleteResult.ok
      if (deleted) {
        const sessionId = sessionIdFromPath(result.sessionPath)
        await archivedSessions.forget(sessionId)
        await tagManager.setTags(sessionId, [])
        await tagManager.forgetAuto(sessionId)
      }
    }
    return { ...result, deleted }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_SWITCH, async (_event, sessionPath: unknown, cwd?: unknown) => {
    if (!isString(sessionPath)) throw new Error('sessionPath must be a string')
    if (cwd !== undefined && !isString(cwd)) throw new Error('cwd must be a string')
    return activateSession(sessionPath, isString(cwd) ? cwd : undefined)
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_RUNTIMES, async () => {
    await workspaceManager.pruneEmptySessionRuntimes()
    return workspaceManager.getSessionRuntimes()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_FORK, async (_event, entryId?: unknown) => {
    const pi = getActivePi()
    // OMP renamed Pi's `fork` command to `branch`; the entry-id argument and
    // semantics (move the session's leaf pointer to that entry) are the same.
    const cmd: Record<string, unknown> = { type: pi.getEngineKind() === 'omp' ? 'branch' : 'fork' }
    if (isString(entryId)) cmd.entryId = entryId
    const response = await pi.sendCommand(cmd)
    const runtimeId = workspaceManager.runtimeIdFor(pi)
    if (runtimeId) await workspaceManager.refreshSessionRuntime(runtimeId).catch(() => null)
    return response
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_CLONE, async () => {
    const pi = getActivePi()
    // OMP has no `clone` command; the renderer hides the action, this is the
    // backstop for any other caller.
    if (pi.getEngineKind() === 'omp') {
      return { success: false, error: 'The OMP engine does not support cloning a session' }
    }
    const response = await pi.sendCommand({ type: 'clone' })
    const runtimeId = workspaceManager.runtimeIdFor(pi)
    if (runtimeId) await workspaceManager.refreshSessionRuntime(runtimeId).catch(() => null)
    return response
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async (_event, cwd?: unknown) => {
    const ws = workspaceManager.getActiveWorkspace()
    const listSessions = createListSessions(workspaceManager)
    return listSessions(isString(cwd) ? cwd : ws?.path ?? process.cwd())
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_ALL, async (_event, cwd?: unknown) => {
    const ws = workspaceManager.getActiveWorkspace()
    const listAllSessions = createListAllSessions(workspaceManager)
    return listAllSessions(isString(cwd) ? cwd : ws?.path ?? process.cwd())
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_STATE, async () => {
    const pi = workspaceManager.getActivePiManager()
    if (!pi || pi.getStatus().status !== 'running') return null
    return pi.sendCommand({ type: 'get_state' })
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_MESSAGES, async () => {
    const pi = workspaceManager.getActivePiManager()
    if (!pi || pi.getStatus().status !== 'running') return null
    const response = await pi.sendCommand({ type: 'get_messages' })
    // Bound IPC payload size so multi‑MB histories don't freeze the renderer.
    return trimGetMessagesResponse(response)
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_STATS, async () => {
    const pi = workspaceManager.getActivePiManager()
    if (!pi || pi.getStatus().status !== 'running') return null
    return pi.sendCommand({ type: 'get_session_stats' })
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_SET_NAME, async (_event, name: unknown) => {
    if (!isString(name)) throw new Error('name must be a string')
    return getActivePi().sendCommand({ type: 'set_session_name', name })
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_EXPORT_HTML, async (_event, outputPath?: unknown) => {
    const cmd: Record<string, unknown> = { type: 'export_html' }
    if (isString(outputPath)) cmd.outputPath = outputPath
    return getActivePi().sendCommand(cmd)
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_FORK_MESSAGES, async () => {
    const pi = getActivePi()
    // OMP removed `get_fork_messages`; its session files keep Pi's entry
    // layout, so the candidates are read from the active session file instead.
    if (pi.getEngineKind() === 'omp') {
      const sessionPath = workspaceManager.sessionPathFor(pi)
      return sessionPath ? readForkPointsCached(sessionPath) : []
    }
    const response = await pi.sendCommand({ type: 'get_fork_messages' })
    // The renderer expects the bare candidate list, not the RPC envelope.
    const data = (response as { data?: { messages?: unknown } } | null)?.data
    return Array.isArray(data?.messages) ? data.messages : []
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (event, sessionPath: unknown): Promise<SessionDeleteResult> => {
    assertTrustedSender(event)
    if (!isString(sessionPath)) throw new Error('sessionPath must be a string')
    if (!sessionPath.endsWith(SESSION_FILE_EXTENSION)) {
      throw new Error('sessionPath must point to a .jsonl session file')
    }
    // Confine deletion to Pi's session store so a renderer cannot delete an
    // arbitrary .jsonl file elsewhere on disk.
    if (!isWithinSessionRoots(sessionPath)) {
      throw new Error('sessionPath must be inside the Pi sessions directory')
    }

    // Detach any live tab first. Otherwise deleting an active/session-tab file
    // leaves a runtime pointing at a path that SESSION_SWITCH can no longer
    // validate, producing a stale "existing Pi session file" error. Closing an
    // active runtime promotes a sibling in the same workspace and broadcasts
    // it as active, so the renderer needs that path back to follow the
    // promotion instead of creating a competing session.
    const runtime = workspaceManager.getSessionRuntimeForPath(sessionPath)
    const closed = runtime ? await workspaceManager.closeSessionRuntime(runtime.runtimeId) : null

    // Roll this session into the persisted stats store *before* removing the
    // file, so its activity survives the deletion (see activity-stats.ts).
    activityStatsStore.captureBeforeDelete(sessionPath)

    const result = await deleteSessionFile(sessionPath)
    if (result.ok) {
      const sessionId = sessionIdFromPath(sessionPath)
      // Clean up registries so deleted sessions don't accumulate stale entries
      await archivedSessions.forget(sessionId)
      await tagManager.setTags(sessionId, [])
      await tagManager.forgetAuto(sessionId)
    }
    return { ...result, replacementSessionPath: closed?.replacementSessionPath ?? null }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_ARCHIVE, async (_event, sessionId: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    await archivedSessions.archive(sessionId)
    return archivedSessions.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_UNARCHIVE, async (_event, sessionId: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    await archivedSessions.unarchive(sessionId)
    return archivedSessions.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_ARCHIVED, async () => {
    return archivedSessions.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_LINEAGE, async () => {
    return readSessionLineage()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_COMPACT, async (_event, customInstructions?: unknown) => {
    const cmd: Record<string, unknown> = { type: 'compact' }
    if (isString(customInstructions) && customInstructions.length > 0) {
      cmd.customInstructions = customInstructions
    }
    return getActivePi().sendCommand(cmd)
  })
}

// ─── Session Listing ─────────────────────────────────────────────────────────

// Rows the renderer lists; the wire type is the single source of truth.
type SessionEntry = SessionListItem

// How many session files to read labels from in parallel. Each read is bounded
// (head+tail only), so we can run more without freezing main.
const SESSION_NAME_READ_CONCURRENCY = 24

/**
 * Populate each row's label fields from its session file: the latest
 * `session_info` name, plus a preview of the first user message so an unnamed
 * session is identifiable without opening it.
 *
 * `workspaceMatched` holds the rows `collectSessionFiles` resolved to a
 * registered workspace; their project stays exactly as that workspace records
 * it (see below).
 */
async function fillSessionLabels(
  entries: SessionEntry[],
  workspaceMatched: ReadonlySet<SessionEntry>
): Promise<void> {
  await mapWithConcurrency(entries, SESSION_NAME_READ_CONCURRENCY, async (entry) => {
    const { name, preview, contentState, header } = await readSessionMetadataCached(entry.path, entry.lastModified)
    entry.name = name
    entry.preview = preview
    entry.contentState = contentState
    entry.piSessionId = header?.id
    // For an UNMATCHED row the session header's cwd is authoritative: session
    // directory names are lossy decodes of real paths (hyphens vs separators
    // collide, Windows drive letters do not survive), so the desanitized value
    // can point at a phantom path. Repair the project from the header so
    // opening the session creates/activates the REAL workspace and never
    // re-persists a phantom one.
    //
    // A matched row keeps its workspace's own path. `pathsEqual` compares
    // lexically, with no symlink resolution: a workspace registered at a
    // symlinked path never matches the resolved cwd Pi records, so overwriting
    // here empties the project-scoped session list and makes openSessionItem
    // register a second workspace for the same physical project.
    //
    // The filename-stem sessionId (tags/archive key) is untouched either way.
    if (header?.cwd && !workspaceMatched.has(entry)) {
      entry.projectPath = resolve(header.cwd)
      entry.projectName = projectNameFromPath(entry.projectPath)
    }
  })
}

function createListSessions(wm: WorkspaceManager) {
  return async function listSessions(_cwd: string): Promise<SessionEntry[]> {
    try {
      await wm.pruneEmptySessionRuntimes()
      const entries: SessionEntry[] = []
      // Rows whose project came from a registered workspace rather than from a
      // desanitized directory name. fillSessionLabels must not overwrite those.
      const workspaceMatched = new Set<SessionEntry>()
      // Precompute workspace match map once (was O(workspaces) per file).
      // Keys use pathsEqual semantics: case-fold only on win32.
      const workspaceBySanitized = new Map(
        wm.getWorkspaces().map((ws) => [workspaceMatchKey(sanitizePath(ws.path)), ws] as const)
      )
      // Pi and OMP each keep their sessions in their own store, so a single
      // root would hide every session started under the other engine.
      for (const root of getSessionRoots()) {
        await collectSessionFiles(entries, root, workspaceBySanitized, workspaceMatched)
      }
      entries.sort((a, b) => b.lastModified - a.lastModified)
      // Only read names for the sessions we actually return (avoids reading the
      // whole store), then surface each session's latest session_info name.
      const top = entries.slice(0, MAX_SESSION_LIST)
      await fillSessionLabels(top, workspaceMatched)
      // Pi creates the JSONL header before the first user turn. Only hide rows
      // proven to be header-only; image-only, unreadable, malformed, and
      // over-budget sessions remain openable and recoverable.
      return top.filter((entry) => entry.contentState !== 'empty')
    } catch {
      return []
    }
  }
}

function createListAllSessions(wm: WorkspaceManager) {
  const listSessions = createListSessions(wm)
  return async function listAllSessions(cwd: string): Promise<SessionEntry[]> {
    return listSessions(cwd)
  }
}

/**
 * Collect top-level parent sessions only.
 *
 * Layout under the Pi session store:
 *   sessions/<sanitized-project>/<timestamp>_<id>.jsonl     ← parent (list these)
 *   sessions/<sanitized-project>/<timestamp>_<id>/<child>…  ← subagent runs
 *
 * Extensions like pi-subagents nest each run under the parent session folder.
 * Recursing into those folders flooded Recent Sessions with ephemeral child
 * runs. We only index `.jsonl` files that sit directly in a project directory.
 *
 * Rows resolved to a registered workspace are also recorded in
 * `workspaceMatched`, which fillSessionLabels reads to leave their project
 * path alone.
 *
 * Every row is stamped with the engine that owns this root, so the UI can
 * label it and opening it can relaunch that engine instead of the configured
 * default.
 */
async function collectSessionFiles(
  entries: SessionEntry[],
  sessionsRoot: string,
  workspaceBySanitized: Map<string, { path: string; name: string }>,
  workspaceMatched: Set<SessionEntry>
): Promise<void> {
  const engine = engineForSessionPath(sessionsRoot) ?? undefined
  try {
    const projectDirs = await readdir(sessionsRoot, { withFileTypes: true })
    await Promise.all(
      projectDirs
        // A session's own artifact directory is not a project; its contents are
        // subagent transcripts, not chats the user can open.
        .filter((d) => d.isDirectory() && !isSessionArtifactDir(d.name))
        .map(async (projectDir) => {
          const projectFull = join(sessionsRoot, projectDir.name)
          const relativeToRoot = sessionDirName(projectFull, sessionsRoot) || projectDir.name

          const matched =
            workspaceBySanitized.get(workspaceMatchKey(relativeToRoot)) ??
            workspaceBySanitized.get(workspaceMatchKey(sanitizePath(relativeToRoot)))
          const projectPath = matched
            ? matched.path
            : desanitizeSessionDir(relativeToRoot)
          const projectName = matched
            ? matched.name
            : projectNameFromPath(projectPath)

          let items: Array<{ name: string; isFile: () => boolean }>
          try {
            items = await readdir(projectFull, { withFileTypes: true })
          } catch {
            return
          }

          for (const item of items) {
            // Parent sessions only — skip directories (subagent nests) and non-jsonl.
            if (!item.isFile() || !item.name.endsWith(JSONL_EXTENSION)) continue
            const fullPath = join(projectFull, item.name)
            try {
              const fileStat = await stat(fullPath)
              const entry: SessionEntry = {
                path: fullPath,
                name: null,
                preview: null,
                sessionId: item.name.replace(JSONL_EXTENSION, ''),
                engine,
                lastModified: fileStat.mtimeMs,
                messageCount: 0,
                projectPath,
                projectName,
              }
              entries.push(entry)
              if (matched) workspaceMatched.add(entry)
            } catch {
              // Skip unreadable files
            }
          }
        })
    )
  } catch {
    // Directory doesn't exist or isn't readable
  }
}

// Session lineage lives in ./session-lineage-reader — it needs bounded, cached
// reads over the whole store and an injectable root to be testable.
