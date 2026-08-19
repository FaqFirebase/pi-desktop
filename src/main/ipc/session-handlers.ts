import { ipcMain } from 'electron'
import { WorkspaceManager } from '../workspace-manager'
import { getSessionsRoot } from '../pi-paths'
import {
  sanitizePath,
  sessionDirName,
  desanitizeSessionDir,
  projectNameFromPath,
  JSONL_EXTENSION,
} from '../session-paths'
import { pathGroupKey as workspaceMatchKey, pathsEqual } from '../../shared/path-compare'
import { readSessionMetadataCached } from '../session-metadata'
import { mapWithConcurrency } from '../map-concurrent'
import { readSessionLineage } from '../session-lineage-reader'
import { trimGetMessagesResponse } from '../get-messages-trim'
import { activityStatsStore } from '../activity-stats'
import type { SessionDeleteResult, SessionListItem, SessionRuntimeInfo } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { readdir, stat, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { isPathWithin } from '../path-authorization'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { assertTrustedSender, isString } from './validation'
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
 * try the `trash` CLI first (recoverable), fall back to `unlink` (permanent).
 *
 * Why this lives in the GUI and not in Pi: Pi's RPC mode exposes no
 * delete_session command (verified against pi.dev/docs/latest/rpc).
 * The official guidance is "Sessions can be removed by deleting their
 * .jsonl files" — that's what this does.
 */
async function deleteSessionFile(sessionPath: string): Promise<SessionDeleteResult> {
  const trashArgs = sessionPath.startsWith('-') ? ['--', sessionPath] : [sessionPath]
  const trashResult = spawnSync('trash', trashArgs, { encoding: 'utf-8' })
  if (trashResult.status === 0 || !existsSync(sessionPath)) {
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

  const activateSession = async (sessionPath: string, cwd?: string): Promise<SessionRuntimeInfo> => {
    if (!isPathWithin(getSessionsRoot(), sessionPath) || !existsSync(sessionPath)) {
      throw new Error('sessionPath must point to an existing Pi session file')
    }
    const workspace = workspaceManager.getActiveWorkspace()
    if (!workspace) throw new Error('No active workspace')
    if (cwd && !pathsEqual(workspace.path, cwd)) throw new Error('Session project does not match the active workspace')
    const runtime = await workspaceManager.activateSession(workspace.id, sessionPath)
    if (runtime.status !== 'running') void startRuntime(runtime, sessionPath).catch(() => undefined)
    return runtime
  }

  ipcMain.handle(IPC_CHANNELS.SESSION_SWITCH, async (_event, sessionPath: unknown, cwd?: unknown) => {
    if (!isString(sessionPath)) throw new Error('sessionPath must be a string')
    if (cwd !== undefined && !isString(cwd)) throw new Error('cwd must be a string')
    return activateSession(sessionPath, isString(cwd) ? cwd : undefined)
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_RUNTIMES, async () => {
    return workspaceManager.getSessionRuntimes()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_FORK, async (_event, entryId?: unknown) => {
    const cmd: Record<string, unknown> = { type: 'fork' }
    if (isString(entryId)) cmd.entryId = entryId
    return getActivePi().sendCommand(cmd)
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_CLONE, async () => {
    return getActivePi().sendCommand({ type: 'clone' })
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
    return getActivePi().sendCommand({ type: 'get_fork_messages' })
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (event, sessionPath: unknown): Promise<SessionDeleteResult> => {
    assertTrustedSender(event)
    if (!isString(sessionPath)) throw new Error('sessionPath must be a string')
    if (!sessionPath.endsWith(SESSION_FILE_EXTENSION)) {
      throw new Error('sessionPath must point to a .jsonl session file')
    }
    // Confine deletion to Pi's session store so a renderer cannot delete an
    // arbitrary .jsonl file elsewhere on disk.
    if (!isPathWithin(getSessionsRoot(), sessionPath)) {
      throw new Error('sessionPath must be inside the Pi sessions directory')
    }

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
    return result
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
 */
async function fillSessionLabels(entries: SessionEntry[]): Promise<void> {
  await mapWithConcurrency(entries, SESSION_NAME_READ_CONCURRENCY, async (entry) => {
    const { name, preview, header } = await readSessionMetadataCached(entry.path, entry.lastModified)
    entry.name = name
    entry.preview = preview
    entry.piSessionId = header?.id
    // The session header's cwd is authoritative: session directory names are
    // lossy decodes of real paths (hyphens vs separators collide), so the
    // workspace-match/desanitize values from collectSessionFiles can point at
    // a phantom path. Repair the project from the header so opening the
    // session creates/activates the REAL workspace and never re-persists a
    // phantom one. The filename-stem sessionId (tags/archive key) is untouched.
    if (header?.cwd) {
      entry.projectPath = header.cwd
      entry.projectName = projectNameFromPath(header.cwd)
    }
  })
}

function createListSessions(wm: WorkspaceManager) {
  return async function listSessions(_cwd: string): Promise<SessionEntry[]> {
    try {
      const sessionsDir = getSessionsRoot()
      const entries: SessionEntry[] = []
      // Precompute workspace match map once (was O(workspaces) per file).
      // Keys use pathsEqual semantics: case-fold only on win32.
      const workspaceBySanitized = new Map(
        wm.getWorkspaces().map((ws) => [workspaceMatchKey(sanitizePath(ws.path)), ws] as const)
      )
      await collectSessionFiles(entries, sessionsDir, workspaceBySanitized)
      entries.sort((a, b) => b.lastModified - a.lastModified)
      // Only read names for the sessions we actually return (avoids reading the
      // whole store), then surface each session's latest session_info name.
      const top = entries.slice(0, MAX_SESSION_LIST)
      await fillSessionLabels(top)
      return top
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
 */
async function collectSessionFiles(
  entries: SessionEntry[],
  sessionsRoot: string,
  workspaceBySanitized: Map<string, { path: string; name: string }>
): Promise<void> {
  try {
    const projectDirs = await readdir(sessionsRoot, { withFileTypes: true })
    await Promise.all(
      projectDirs
        .filter((d) => d.isDirectory())
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
              entries.push({
                path: fullPath,
                name: null,
                preview: null,
                sessionId: item.name.replace(JSONL_EXTENSION, ''),
                lastModified: fileStat.mtimeMs,
                messageCount: 0,
                projectPath,
                projectName,
              })
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
