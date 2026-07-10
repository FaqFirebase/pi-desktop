import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron'
import { PiRpcManager, PI_CLI } from './pi-rpc-manager'
import { WorkspaceManager } from './workspace-manager'
import { SessionTagManager } from './session-tags'
import { ArchivedSessionsManager } from './archived-sessions'
import { TerminalService } from './terminal-service'
import { NotesManager } from './notes-manager'
import { getGuiDataPath } from './app-data-paths'
import { getSessionsRoot } from './pi-paths'
import {
  sanitizePath,
  sessionDirName,
  desanitizeSessionDir,
  projectNameFromPath,
  pathsEqual,
} from './session-paths'
import { readSessionName } from './session-name'
import { activityStatsStore } from './activity-stats'
import type {
  PiStartOptions,
  PiRpcEvent,
  AppSettings,
  PermissionMode,
  SessionDeleteResult,
  NoteInput,
  NoteUpdate,
  NoteScope,
  UpdateCheckResult,
  ModelsConfig,
  ModelsReadResult,
  CouncilRunResult,
  CouncilDetectResult,
  ActivityStatsResult,
} from '../shared/ipc-contracts'
import { IPC_CHANNELS } from '../shared/ipc-contracts'
import { COUNCIL_AGENT_IDS, clampTimeoutSeconds } from '../shared/council-config'
import { DEFAULT_SETTINGS } from '../shared/default-settings'
import type { CouncilAgentId, ConsensusMode } from '../shared/council-config'
import { detectAgents } from './agent-detection'
import { readAttachment } from './attachment-reader'
import { runConsultants, defaultSpawnConsultant } from './council-manager'
import { fetchPackageCatalog } from './package-catalog'
import type { SessionLineageRecord } from '../shared/session-lineage'
import { readdir, stat, readFile, writeFile, mkdir, access, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { existsSync } from 'fs'
import { execFile, spawnSync } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * Registers all IPC handlers that the renderer can invoke.
 *
 * Security: every handler validates its input types before processing.
 * The preload bridge is the only path from renderer to these handlers.
 */

const JSONL_EXTENSION = '.jsonl'
const MAX_SESSION_LIST = 100
const READ_ONLY_TOOLS = 'read,grep,find,ls'
const PERMISSIONS_EXTENSION_PATH = app.isPackaged
  ? join(process.resourcesPath, 'resources', 'pi-desktop-permissions.ts')
  : join(app.getAppPath(), 'resources', 'pi-desktop-permissions.ts')

// Type guard helpers
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map(String)
}

/** Validate the shape of a NoteInput from the renderer (content checks happen in NotesManager). */
function parseNoteInput(value: unknown): NoteInput {
  if (!isObject(value)) throw new Error('note must be an object')
  if (!isString(value.title)) throw new Error('note.title must be a string')
  if (!isString(value.body)) throw new Error('note.body must be a string')
  if (!isString(value.scope)) throw new Error('note.scope must be a string')
  return {
    title: value.title,
    body: value.body,
    scope: value.scope as NoteScope,
    tags: parseStringArray(value.tags, 'note.tags'),
  }
}

/** Validate a partial NoteUpdate; only supplied fields are carried through. */
function parseNoteUpdate(value: unknown): NoteUpdate {
  if (!isObject(value)) throw new Error('patch must be an object')
  const patch: NoteUpdate = {}
  if (value.title !== undefined) {
    if (!isString(value.title)) throw new Error('note.title must be a string')
    patch.title = value.title
  }
  if (value.body !== undefined) {
    if (!isString(value.body)) throw new Error('note.body must be a string')
    patch.body = value.body
  }
  if (value.scope !== undefined) {
    if (!isString(value.scope)) throw new Error('note.scope must be a string')
    patch.scope = value.scope as NoteScope
  }
  if (value.tags !== undefined) {
    patch.tags = parseStringArray(value.tags, 'note.tags')
  }
  return patch
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isString))
}

const SESSION_FILE_EXTENSION = '.jsonl'

function sessionIdFromPath(sessionPath: string): string {
  const base = basename(sessionPath)
  return base.endsWith(SESSION_FILE_EXTENSION)
    ? base.slice(0, -SESSION_FILE_EXTENSION.length)
    : base
}

function removeToolArgs(args: string[]): string[] {
  const filtered: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--tools' || arg === '-t') {
      i++
      continue
    }
    if (arg.startsWith('--tools=') || arg.startsWith('-t=')) continue
    if (arg === '--no-tools' || arg === '-nt' || arg === '--no-builtin-tools' || arg === '-nbt') continue
    filtered.push(arg)
  }
  return filtered
}

function toolsForPermissionMode(mode: PermissionMode): string | null {
  switch (mode) {
    case 'plan-readonly':
      return READ_ONLY_TOOLS
    case 'ask-commands':
    case 'ask-edits':
    case 'trusted':
      return null
  }
}

/**
 * Opt into resuming the most recent session on launch (Pi's --continue) when
 * the user setting is enabled and the caller hasn't requested a specific
 * session or an ephemeral (no-session) run.
 */
function applyResumePreference(options: PiStartOptions, settings: AppSettings): PiStartOptions {
  if (settings.resumeLastSession && !options.sessionPath && !options.noSession) {
    return { ...options, continueSession: true }
  }
  return options
}

function applyPermissionModeToStartOptions(
  options: PiStartOptions,
  settings: AppSettings
): PiStartOptions {
  const toolList = toolsForPermissionMode(settings.permissionMode)
  const args = toolList
    ? [...removeToolArgs(options.args ?? []), '--tools', toolList]
    : [...(options.args ?? [])]
  const needsApprovalExtension = settings.permissionMode === 'ask-edits' || settings.permissionMode === 'ask-commands'
  if (needsApprovalExtension && existsSync(PERMISSIONS_EXTENSION_PATH)) {
    args.push('-e', PERMISSIONS_EXTENSION_PATH)
  }

  return {
    ...options,
    args,
    env: {
      ...options.env,
      PI_DESKTOP_PERMISSION_MODE: settings.permissionMode,
    },
  }
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

const UPDATE_REPO = 'FaqFirebase/pi-desktop'
const UPDATE_CHECK_TIMEOUT_MS = 8000

interface GithubRelease {
  tag_name: string
  html_url: string
  name: string | null
  draft: boolean
  prerelease: boolean
}

/** Parse a version like "0.0.5-alpha" into numeric core + prerelease tag. */
function parseVersion(version: string): { core: number[]; pre: string } {
  const clean = version.replace(/^v/, '').trim()
  const [core, pre = ''] = clean.split('-')
  const nums = core.split('.').map((n) => parseInt(n, 10) || 0)
  while (nums.length < 3) nums.push(0)
  return { core: nums.slice(0, 3), pre }
}

/**
 * True when `latest` is a newer version than `current`. Handles the project's
 * `x.y.z-prerelease` scheme: a release with no prerelease tag outranks one with
 * the same core that has a tag; two prerelease tags compare lexically
 * (alpha < beta < rc).
 */
function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i]
  }
  if (a.pre === b.pre) return false
  if (!a.pre) return true
  if (!b.pre) return false
  return a.pre > b.pre
}

/** Check GitHub releases (including prereleases) for a version newer than this build. */
async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const noUpdate: UpdateCheckResult = { updateAvailable: false, currentVersion, latestVersion: currentVersion, url: '' }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Pi-Desktop' },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return noUpdate

    const releases = (await res.json()) as GithubRelease[]
    const published = releases.filter((r) => !r.draft)
    if (published.length === 0) return noUpdate

    // Pick the highest version among published releases (not just newest by date).
    let latest = published[0]
    for (const r of published) {
      if (isNewerVersion(r.tag_name.replace(/^v/, ''), latest.tag_name.replace(/^v/, ''))) latest = r
    }

    const latestVersion = latest.tag_name.replace(/^v/, '')
    return {
      updateAvailable: isNewerVersion(latestVersion, currentVersion),
      currentVersion,
      latestVersion,
      url: latest.html_url,
      name: latest.name ?? latest.tag_name,
    }
  } catch {
    return noUpdate
  }
}

export function registerIpcHandlers(workspaceManager: WorkspaceManager): void {
  const tagManager = new SessionTagManager()
  const archivedSessions = new ArchivedSessionsManager()
  const terminalService = new TerminalService()
  const notesManager = new NotesManager()

  // Helper: get Pi manager for active workspace
  function getActivePi(): PiRpcManager {
    const pi = workspaceManager.getActivePiManager()
    if (!pi) throw new Error('No active workspace or Pi not running')
    return pi
  }

  // Helper: broadcast to all renderer windows
  function broadcast(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data)
      }
    }
  }

  // ─── Pi Process Lifecycle ───────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PI_START, async (_event, options?: unknown) => {
    const opts = validateStartOptions(options)
    const settings = await loadAppSettings(workspaceManager)
    const activeWs = workspaceManager.getActiveWorkspace()
    if (!activeWs) throw new Error('No active workspace')

    // Validate cwd exists; fall back to home directory if not
    let cwd = activeWs.path
    try {
      await access(cwd)
    } catch {
      cwd = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
    }

    await workspaceManager.startPiForWorkspace(
      activeWs.id,
      applyPermissionModeToStartOptions(applyResumePreference({ ...opts, cwd }, settings), settings)
    )
    const pi = workspaceManager.getPiManager(activeWs.id)
    if (!pi) throw new Error('Failed to create Pi manager')

    return pi.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.PI_STOP, async () => {
    const activeWs = workspaceManager.getActiveWorkspace()
    if (activeWs) {
      workspaceManager.stopPiForWorkspace(activeWs.id)
    }
    return { status: 'stopped', pid: null, error: null }
  })

  ipcMain.handle(IPC_CHANNELS.PI_RESTART, async (_event, options?: unknown) => {
    const opts = validateStartOptions(options)
    const settings = await loadAppSettings(workspaceManager)
    const activeWs = workspaceManager.getActiveWorkspace()
    if (!activeWs) throw new Error('No active workspace')

    const pi = workspaceManager.getPiManager(activeWs.id)
    if (!pi) throw new Error('No Pi manager for workspace')

    pi.stop()
    return pi.start(
      applyPermissionModeToStartOptions(
        applyResumePreference({ cwd: activeWs.path, ...opts }, settings),
        settings
      )
    )
  })

  ipcMain.handle(IPC_CHANNELS.PI_STATUS, async () => {
    const pi = workspaceManager.getActivePiManager()
    if (!pi) return { status: 'stopped', pid: null, error: null }
    return pi.getStatus()
  })

  // ─── Pi Commands ────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PI_PROMPT, async (_event, message: unknown, options?: unknown) => {
    if (!isString(message)) throw new Error('message must be a string')
    const cmd: Record<string, unknown> = { type: 'prompt', message }
    if (isObject(options)) {
      if (options.images) cmd.images = options.images
      if (options.streamingBehavior) cmd.streamingBehavior = options.streamingBehavior
    }
    return getActivePi().sendCommand(cmd)
  })

  ipcMain.handle(IPC_CHANNELS.PI_STEER, async (_event, message: unknown, images?: unknown) => {
    if (!isString(message)) throw new Error('message must be a string')
    const cmd: Record<string, unknown> = { type: 'steer', message }
    if (Array.isArray(images) && images.length > 0) cmd.images = images
    return getActivePi().sendCommand(cmd)
  })

  ipcMain.handle(IPC_CHANNELS.PI_FOLLOW_UP, async (_event, message: unknown) => {
    if (!isString(message)) throw new Error('message must be a string')
    return getActivePi().sendCommand({ type: 'follow_up', message })
  })

  ipcMain.handle(IPC_CHANNELS.PI_ABORT, async () => {
    return getActivePi().sendCommand({ type: 'abort' })
  })

  ipcMain.handle(IPC_CHANNELS.PI_BASH, async (_event, command: unknown) => {
    if (!isString(command)) throw new Error('command must be a string')
    return getActivePi().sendCommand({ type: 'bash', command })
  })

  ipcMain.handle(IPC_CHANNELS.PI_ABORT_BASH, async () => {
    return getActivePi().sendCommand({ type: 'abort_bash' })
  })

  // ─── Terminal ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.TERMINAL_START, async (_event, options: unknown) => {
    const opts = isObject(options) ? options : {}
    return terminalService.start(
      {
        cwd: isString(opts.cwd) ? opts.cwd : workspaceManager.getActiveWorkspace()?.path,
        cols: typeof opts.cols === 'number' ? opts.cols : undefined,
        rows: typeof opts.rows === 'number' ? opts.rows : undefined,
      },
      (data) => broadcast(IPC_CHANNELS.EVENT_TERMINAL_DATA, data),
      (event) => broadcast(IPC_CHANNELS.EVENT_TERMINAL_EXIT, event)
    )
  })

  ipcMain.handle(IPC_CHANNELS.TERMINAL_INPUT, async (_event, data: unknown) => {
    if (!isString(data)) throw new Error('terminal input must be a string')
    terminalService.write(data)
  })

  ipcMain.handle(IPC_CHANNELS.TERMINAL_RESIZE, async (_event, size: unknown) => {
    if (!isObject(size)) throw new Error('terminal size must be an object')
    const cols = typeof size.cols === 'number' ? size.cols : 80
    const rows = typeof size.rows === 'number' ? size.rows : 24
    terminalService.resize(cols, rows)
  })

  ipcMain.handle(IPC_CHANNELS.TERMINAL_STOP, async () => {
    terminalService.stop()
  })

  // ─── Session Management ─────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SESSION_NEW, async () => {
    const pi = workspaceManager.getActivePiManager()
    if (!pi || pi.getStatus().status !== 'running') {
      return { success: false, error: 'Pi not running. Start Pi first.' }
    }
    return pi.sendCommand({ type: 'new_session' })
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_SWITCH, async (_event, sessionPath: unknown) => {
    if (!isString(sessionPath)) throw new Error('sessionPath must be a string')
    const pi = workspaceManager.getActivePiManager()
    if (!pi || pi.getStatus().status !== 'running') {
      // Pi not running — just store the path for when it starts
      return { success: false, error: 'Pi not running. Start Pi first.' }
    }
    return pi.sendCommand({ type: 'switch_session', sessionPath })
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
    return pi.sendCommand({ type: 'get_messages' })
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

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionPath: unknown): Promise<SessionDeleteResult> => {
    if (!isString(sessionPath)) throw new Error('sessionPath must be a string')
    if (!sessionPath.endsWith(SESSION_FILE_EXTENSION)) {
      throw new Error('sessionPath must point to a .jsonl session file')
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

  // ─── Model Management ───────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.MODEL_SET, async (_event, provider: unknown, modelId: unknown) => {
    if (!isString(provider)) throw new Error('provider must be a string')
    if (!isString(modelId)) throw new Error('modelId must be a string')
    return getActivePi().sendCommand({ type: 'set_model', provider, modelId })
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_CYCLE, async () => {
    return getActivePi().sendCommand({ type: 'cycle_model' })
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_LIST_AVAILABLE, async () => {
    return getActivePi().sendCommand({ type: 'get_available_models' })
  })

  ipcMain.handle(IPC_CHANNELS.THINKING_SET_LEVEL, async (_event, level: unknown) => {
    if (!isString(level)) throw new Error('level must be a string')
    return getActivePi().sendCommand({ type: 'set_thinking_level', level })
  })

  ipcMain.handle(IPC_CHANNELS.THINKING_CYCLE_LEVEL, async () => {
    return getActivePi().sendCommand({ type: 'cycle_thinking_level' })
  })

  // ─── Settings ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, async () => {
    return loadAppSettings(workspaceManager)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SAVE, async (_event, settings: unknown) => {
    if (!isObject(settings)) throw new Error('settings must be an object')
    await saveAppSettings(settings as Partial<AppSettings>)
    return loadAppSettings(workspaceManager)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_THEME, async () => {
    const settings = await loadAppSettings(workspaceManager)
    return settings.theme
  })

  // ─── Workspace Management ───────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, async () => {
    return workspaceManager.getWorkspaces()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE, async (_event, name: unknown, path: unknown) => {
    if (!isString(name)) throw new Error('name must be a string')
    if (!isString(path)) throw new Error('path must be a string')
    return workspaceManager.createWorkspace(name, path)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_REMOVE, async (_event, workspaceId: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    await workspaceManager.removeWorkspace(workspaceId)
    // Notes scoped to the removed workspace fall back to global so they survive.
    await notesManager.reassignToGlobal(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_RENAME, async (_event, workspaceId: unknown, name: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    if (!isString(name)) throw new Error('name must be a string')
    await workspaceManager.renameWorkspace(workspaceId, name)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CHANGE_PATH, async (_event, workspaceId: unknown, newPath: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    if (!isString(newPath)) throw new Error('newPath must be a string')
    await workspaceManager.changeWorkspacePath(workspaceId, newPath)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_PATH_EXISTS, async (): Promise<boolean> => {
    return workspaceManager.activeWorkspacePathExists()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SET_ACTIVE, async (_event, workspaceId: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    return workspaceManager.setActiveWorkspace(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_ACTIVE, async () => {
    return workspaceManager.getActiveWorkspace()
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_START_PI, async (_event, workspaceId: unknown, options?: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    const opts = validateStartOptions(options)
    const settings = await loadAppSettings(workspaceManager)
    await workspaceManager.startPiForWorkspace(workspaceId, applyPermissionModeToStartOptions(opts, settings))
    const pi = workspaceManager.getPiManager(workspaceId)
    return pi?.getStatus() ?? { status: 'stopped', pid: null, error: null }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_STOP_PI, async (_event, workspaceId: unknown) => {
    if (!isString(workspaceId)) throw new Error('workspaceId must be a string')
    workspaceManager.stopPiForWorkspace(workspaceId)
    return { status: 'stopped', pid: null, error: null }
  })

  // ─── Package Management ─────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PACKAGE_LIST_INSTALLED, async () => {
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return listInstalledPackages(cwd)
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_INSTALL, async (_event, packageSpec: unknown) => {
    if (!isString(packageSpec)) throw new Error('packageSpec must be a string')
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return installPackage(packageSpec, cwd)
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_REMOVE, async (_event, packageSpec: unknown) => {
    if (!isString(packageSpec)) throw new Error('packageSpec must be a string')
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return removePackage(packageSpec, cwd)
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_UPDATE, async (_event, packageSpec?: unknown) => {
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return updatePackage(isString(packageSpec) ? packageSpec : undefined, cwd)
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_CATALOG_FETCH, async (_event, query?: unknown) => {
    return fetchPackageCatalog(isString(query) ? query : undefined)
  })

  // ─── Skills ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SKILLS_LIST, async () => {
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return listSkills(cwd)
  })

  ipcMain.handle(IPC_CHANNELS.COMMANDS_LIST, async () => {
    const pi = workspaceManager.getActivePiManager()
    if (!pi || pi.getStatus().status !== 'running') return []
    try {
      const response = await pi.sendCommand({ type: 'get_commands' }) as { success?: boolean; data?: { commands?: unknown[] } } | null
      if (response?.success && response.data?.commands) {
        return response.data.commands
      }
      return []
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_LIST, async () => {
    const ws = workspaceManager.getActiveWorkspace()
    return listMcpServers(ws?.path)
  })

  // ─── Models Config ──────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.MODELS_READ, async (): Promise<ModelsReadResult> => {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const file = join(homeDir, '.pi', 'agent', 'models.json')
    if (!existsSync(file)) return { config: { providers: {} } }
    let raw: string
    try {
      raw = await readFile(file, 'utf-8')
    } catch (err) {
      return { error: `Could not read models.json: ${err instanceof Error ? err.message : String(err)}`, raw: '' }
    }
    try {
      const parsed = JSON.parse(raw) as ModelsConfig
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.providers !== 'object') {
        return { error: 'models.json is not a valid models config (missing "providers")', raw }
      }
      return { config: parsed }
    } catch (err) {
      return { error: `models.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, raw }
    }
  })

  ipcMain.handle(IPC_CHANNELS.MODELS_WRITE, async (_event, config: unknown): Promise<{ success: boolean; error?: string }> => {
    if (typeof config !== 'object' || config === null || typeof (config as ModelsConfig).providers !== 'object') {
      return { success: false, error: 'Invalid models config' }
    }
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const dir = join(homeDir, '.pi', 'agent')
    const file = join(dir, 'models.json')
    try {
      if (!existsSync(dir)) await mkdir(dir, { recursive: true })
      await writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.COUNCIL_DETECT, async (): Promise<CouncilDetectResult> => {
    const agents = detectAgents().map((a) => ({ id: a.id, found: a.found }))
    return { agents }
  })

  ipcMain.handle(
    IPC_CHANNELS.COUNCIL_RUN_CONSULTANTS,
    async (_event, payload: unknown): Promise<CouncilRunResult> => {
      // Validate the payload before spawning any child processes.
      if (!isObject(payload)) throw new Error('Council run payload must be an object')
      if (!isString(payload.request) || payload.request.trim().length === 0) {
        throw new Error('Council run request must be a non-empty string')
      }
      if (
        !Array.isArray(payload.members) ||
        payload.members.length === 0 ||
        !payload.members.every((m): m is CouncilAgentId => COUNCIL_AGENT_IDS.includes(m as CouncilAgentId))
      ) {
        throw new Error('Council run members must be a non-empty list of known agents')
      }
      if (payload.consensusMode !== 'arbiter' && payload.consensusMode !== 'debate') {
        throw new Error('Council run consensusMode must be "arbiter" or "debate"')
      }
      const members = payload.members as CouncilAgentId[]
      const consensusMode = payload.consensusMode as ConsensusMode
      const timeoutSeconds = clampTimeoutSeconds(Number(payload.timeoutSeconds))

      // The working directory is the active workspace, never the renderer's
      // input — consultants must plan against the real project tree.
      const activeWs = workspaceManager.getActiveWorkspace()
      if (!activeWs) throw new Error('No active workspace')
      let cwd = activeWs.path
      try {
        await access(cwd)
      } catch {
        cwd = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
      }

      const results = await runConsultants(
        { request: payload.request, members, cwd, timeoutSeconds, consensusMode },
        {
          spawnConsultant: defaultSpawnConsultant,
          onProgress: (id, chunk) => broadcast(IPC_CHANNELS.EVENT_COUNCIL_PROGRESS, { id, chunk }),
        },
      )
      return { results }
    },
  )

  // ─── Session Tags ───────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.TAG_GET, async (_event, sessionId: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    return tagManager.getTags(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.TAG_SET, async (_event, sessionId: unknown, tags: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    if (!Array.isArray(tags)) throw new Error('tags must be an array')
    await tagManager.setTags(sessionId, tags.map(String))
    return tagManager.getTags(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.TAG_ADD, async (_event, sessionId: unknown, tag: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    if (!isString(tag)) throw new Error('tag must be a string')
    return tagManager.addTag(sessionId, tag)
  })

  ipcMain.handle(IPC_CHANNELS.TAG_REMOVE, async (_event, sessionId: unknown, tag: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    if (!isString(tag)) throw new Error('tag must be a string')
    return tagManager.removeTag(sessionId, tag)
  })

  ipcMain.handle(IPC_CHANNELS.TAG_GET_ALL, async () => {
    return tagManager.getAllTags()
  })

  ipcMain.handle(IPC_CHANNELS.TAG_GET_ALL_USED, async () => {
    return tagManager.getAllUsedTags()
  })

  ipcMain.handle(IPC_CHANNELS.TAG_AUTO_GET_ALL, async () => {
    return tagManager.getAutoTags()
  })

  ipcMain.handle(IPC_CHANNELS.TAG_AUTO_ENSURE, async (_event, sessions: unknown) => {
    if (!Array.isArray(sessions)) throw new Error('sessions must be an array')
    const refs: Array<{ sessionId: string; path: string }> = []
    for (const s of sessions) {
      if (
        typeof s === 'object' && s !== null &&
        isString((s as { sessionId?: unknown }).sessionId) &&
        isString((s as { path?: unknown }).path)
      ) {
        refs.push({
          sessionId: (s as { sessionId: string }).sessionId,
          path: (s as { path: string }).path,
        })
      }
    }
    return tagManager.ensureAutoTags(refs)
  })

  ipcMain.handle(IPC_CHANNELS.TAG_AUTO_REMOVE, async (_event, sessionId: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    await tagManager.removeAutoTag(sessionId)
  })

  // ─── Notes (reusable prompts / commands) ──────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.NOTES_LIST, async () => {
    return notesManager.list()
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_CREATE, async (_event, input: unknown) => {
    return notesManager.create(parseNoteInput(input))
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_UPDATE, async (_event, id: unknown, patch: unknown) => {
    if (!isString(id)) throw new Error('id must be a string')
    return notesManager.update(id, parseNoteUpdate(patch))
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_REMOVE, async (_event, id: unknown) => {
    if (!isString(id)) throw new Error('id must be a string')
    await notesManager.remove(id)
  })

  // ─── File Operations ────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.FILE_TREE, async (_event, maxDepth?: unknown) => {
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.getFileTree(typeof maxDepth === 'number' ? maxDepth : 4)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_SEARCH, async (_event, query: unknown) => {
    if (!isString(query)) throw new Error('query must be a string')
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.searchFiles(query)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_SEARCH_CONTENT, async (_event, query: unknown) => {
    if (!isString(query)) throw new Error('query must be a string')
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.searchContent(query)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_event, filePath: unknown) => {
    if (!isString(filePath)) throw new Error('filePath must be a string')
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.readFileContent(filePath)
  })

  // Reads a user-selected attachment by absolute path (chosen via the native
  // open dialog, so it may live outside the workspace).
  ipcMain.handle(IPC_CHANNELS.FILE_READ_ATTACHMENT, async (_event, filePath: unknown) => {
    if (!isString(filePath)) throw new Error('filePath must be a string')
    return readAttachment(filePath)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_WRITE, async (_event, filePath: unknown, content: unknown) => {
    if (!isString(filePath)) throw new Error('filePath must be a string')
    if (!isString(content)) throw new Error('content must be a string')
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    await fs.writeFileContent(filePath, content)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_DIFF, async (_event, filePath?: unknown) => {
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.getFileDiff(isString(filePath) ? filePath : undefined)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_STAGED_DIFF, async (_event, filePath?: unknown) => {
    const fs = workspaceManager.getActiveFileService()
    if (!fs) throw new Error('No active workspace')
    return fs.getStagedDiff(isString(filePath) ? filePath : undefined)
  })

  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, async () => {
    const fs = workspaceManager.getActiveFileService()
    // No active workspace (e.g. the home screen before any workspace is opened)
    // is an expected state, not an error — report no changes rather than throwing
    // (which Electron would log as an unhandled handler error every poll).
    if (!fs) return {}
    const statusMap = await fs.getGitStatus()
    // Convert Map to plain object for IPC
    const result: Record<string, unknown> = {}
    for (const [key, value] of statusMap) {
      result[key] = value
    }
    return result
  })

  ipcMain.handle(IPC_CHANNELS.GIT_BRANCH, async () => {
    const fs = workspaceManager.getActiveFileService()
    // No active workspace: report "no branch" rather than throwing (matches the
    // Promise<string | null> contract; keeps the no-workspace state error-free).
    if (!fs) return null
    return fs.getGitBranch()
  })

  // ─── System ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_DIALOG, async (_event, options?: unknown) => {
    // Default to directory selection for back-compat with workspace pickers;
    // callers pass mode: 'file' (and optional filters) to attach files.
    const pickFile = isObject(options) && options.mode === 'file'
    const dialogOptions: Electron.OpenDialogOptions = {
      properties: [pickFile ? 'openFile' : 'openDirectory'],
    }
    if (isObject(options)) {
      if (isString(options.title)) dialogOptions.title = options.title
      if (Array.isArray(options.filters)) {
        dialogOptions.filters = options.filters as Electron.FileFilter[]
      }
    }
    const result = await dialog.showOpenDialog(dialogOptions)
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_PATH, async (_event, name: unknown) => {
    if (!isString(name)) throw new Error('name must be a string')
    const validPaths = ['home', 'appData', 'userData', 'temp', 'desktop', 'documents'] as const
    if (validPaths.includes(name as (typeof validPaths)[number])) {
      return app.getPath(name as 'home' | 'appData' | 'userData' | 'temp' | 'desktop' | 'documents')
    }
    throw new Error(`Invalid path name: ${name}`)
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, async (_event, url: unknown) => {
    if (!isString(url)) throw new Error('url must be a string')
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      throw new Error('Only http(s) URLs are allowed')
    }
    await shell.openExternal(url)
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_VERSION, async () => {
    return app.getVersion()
  })

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_GET_STATS, async (): Promise<ActivityStatsResult> => {
    return activityStatsStore.computeStats()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async (): Promise<UpdateCheckResult> => {
    return checkForUpdate()
  })

  // ─── Extension UI Responses ─────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.UI_SELECT_RESPONSE, async (_event, id: unknown, value: unknown) => {
    if (!isString(id)) throw new Error('id must be a string')
    getActivePi().sendExtensionUiResponse(id, { value })
  })

  ipcMain.handle(IPC_CHANNELS.UI_CONFIRM_RESPONSE, async (_event, id: unknown, confirmed: unknown) => {
    if (!isString(id)) throw new Error('id must be a string')
    getActivePi().sendExtensionUiResponse(id, { confirmed: !!confirmed })
  })

  ipcMain.handle(IPC_CHANNELS.UI_INPUT_RESPONSE, async (_event, id: unknown, value: unknown) => {
    if (!isString(id)) throw new Error('id must be a string')
    getActivePi().sendExtensionUiResponse(id, { value })
  })

  ipcMain.handle(IPC_CHANNELS.UI_EDITOR_RESPONSE, async (_event, id: unknown, value: unknown) => {
    if (!isString(id)) throw new Error('id must be a string')
    getActivePi().sendExtensionUiResponse(id, { value })
  })

  // ─── Event Forwarding ───────────────────────────────────────────────────

  // Forward Pi events ONLY from the currently-active workspace's Pi manager.
  // Why: each workspace has its own PiRpcManager. If we forwarded events from
  // every manager, the renderer (whose piStatus is a single global) would see
  // status from inactive workspaces and the green dot would lie about whether
  // the *active* workspace's Pi is running. Filtering here keeps the renderer's
  // view of "Pi" aligned with the active workspace it's looking at.
  const isActiveManager = (manager: PiRpcManager): boolean =>
    manager === workspaceManager.getActivePiManager()

  workspaceManager.onPiManager((piManager: PiRpcManager) => {
    piManager.on('event', (event: PiRpcEvent) => {
      if (isActiveManager(piManager)) {
        broadcast(IPC_CHANNELS.EVENT_PI, event)
      }
    })

    piManager.on('status-change', () => {
      if (isActiveManager(piManager)) {
        broadcast(IPC_CHANNELS.EVENT_PI, {
          type: 'status_change',
          ...piManager.getStatus(),
        })
      }
    })
  })

  // Push the active workspace's Pi status to the renderer whenever the active
  // workspace changes, so the status indicator reflects the new workspace
  // even if its Pi manager hasn't emitted any events recently.
  const broadcastActiveStatus = (): void => {
    const pi = workspaceManager.getActivePiManager()
    if (!pi) return
    broadcast(IPC_CHANNELS.EVENT_PI, {
      type: 'status_change',
      ...pi.getStatus(),
    })
  }
  workspaceManager.onActiveWorkspaceChanged(broadcastActiveStatus)

  // Forward debounced file-change events from the active workspace's watcher
  // so the renderer can refresh the file tree and git status live. The
  // WorkspaceManager only watches the active workspace, so no filtering here.
  workspaceManager.onFileChange((event) => {
    broadcast(IPC_CHANNELS.EVENT_FILE_CHANGE, event)
  })
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

function validateStartOptions(value: unknown): PiStartOptions {
  if (value === undefined || value === null) return {}

  if (!isObject(value)) throw new Error('Start options must be an object')

  const opts: PiStartOptions = {}

  if (!isOptionalString(value.cwd)) throw new Error('cwd must be a string')
  if (!isOptionalString(value.model)) throw new Error('model must be a string')
  if (!isOptionalString(value.provider)) throw new Error('provider must be a string')
  if (!isOptionalString(value.sessionPath)) throw new Error('sessionPath must be a string')
  if (!isOptionalBoolean(value.noSession)) throw new Error('noSession must be a boolean')
  if (!isOptionalStringArray(value.args)) throw new Error('args must be a string array')
  if (value.env !== undefined && !isObject(value.env)) throw new Error('env must be an object')

  if (isString(value.cwd)) opts.cwd = value.cwd
  if (isString(value.model)) opts.model = value.model
  if (isString(value.provider)) opts.provider = value.provider
  if (isString(value.sessionPath)) opts.sessionPath = value.sessionPath
  if (value.noSession === true) opts.noSession = true
  if (Array.isArray(value.args)) opts.args = value.args as string[]
  if (isObject(value.env)) {
    opts.env = Object.fromEntries(
      Object.entries(value.env).filter((entry): entry is [string, string] => isString(entry[1]))
    )
  }

  return opts
}

// ─── Session Listing ─────────────────────────────────────────────────────────

interface SessionEntry {
  path: string
  name: string | null
  sessionId: string
  lastModified: number
  messageCount: number
  projectPath: string
  projectName: string
}

// How many session files to read names from in parallel. Mirrors Pi's own
// bounded concurrency so a large session store doesn't spawn hundreds of reads.
const SESSION_NAME_READ_CONCURRENCY = 10

/** Populate `entry.name` from each session file's latest `session_info`, bounded. */
async function fillSessionNames(entries: SessionEntry[]): Promise<void> {
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const entry = entries[cursor++]
      entry.name = await readSessionName(entry.path)
    }
  }
  const workers = Array.from(
    { length: Math.min(SESSION_NAME_READ_CONCURRENCY, entries.length) },
    () => worker()
  )
  await Promise.all(workers)
}

function createListSessions(wm: WorkspaceManager) {
  return async function listSessions(_cwd: string): Promise<SessionEntry[]> {
    try {
      const sessionsDir = getSessionsRoot()
      const entries: SessionEntry[] = []
      await collectSessionFiles(sessionsDir, entries, sessionsDir, wm)
      entries.sort((a, b) => b.lastModified - a.lastModified)
      // Only read names for the sessions we actually return (avoids reading the
      // whole store), then surface each session's latest session_info name.
      const top = entries.slice(0, MAX_SESSION_LIST)
      await fillSessionNames(top)
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

async function collectSessionFiles(
  dir: string,
  entries: SessionEntry[],
  sessionsRoot: string,
  wm: WorkspaceManager
): Promise<void> {
  try {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const fullPath = join(dir, item.name)
      if (item.isDirectory()) {
        await collectSessionFiles(fullPath, entries, sessionsRoot, wm)
      } else if (item.isFile() && item.name.endsWith(JSONL_EXTENSION)) {
        try {
          const fileStat = await stat(fullPath)

          // Determine project path from the directory structure. Normalized so
          // Windows session dirs (backslash-separated) compare correctly.
          const relativeToRoot = sessionDirName(dir, sessionsRoot)
          let projectPath = ''
          let projectName = 'Unknown'

          if (relativeToRoot) {
            // Try to match against known workspace paths
            const workspaces = wm.getWorkspaces()
            const matched = workspaces.find((ws) => pathsEqual(sanitizePath(ws.path), relativeToRoot))

            if (matched) {
              projectPath = matched.path
              projectName = matched.name
            } else {
              // Fallback: desanitize (lossy) and derive a clean basename.
              projectPath = desanitizeSessionDir(relativeToRoot)
              projectName = projectNameFromPath(projectPath)
            }
          }

          entries.push({
            path: fullPath,
            name: null,
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
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
}

// ─── Package Management ──────────────────────────────────────────────────────

interface InstalledPackage {
  name: string
  source: string
  type: string
  version: string | null
  path: string
}

async function listInstalledPackages(cwd: string): Promise<InstalledPackage[]> {
  try {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const globalSettingsPath = join(homeDir, '.pi', 'agent', 'settings.json')
    const projectSettingsPath = join(cwd, '.pi', 'settings.json')

    const packages: InstalledPackage[] = []

    // Read global settings
    const globalPackages = await readPackagesFromSettings(globalSettingsPath)
    packages.push(...globalPackages.map((p) => ({ ...p, scope: 'global' })))

    // Read project settings
    const projectPackages = await readPackagesFromSettings(projectSettingsPath)
    packages.push(...projectPackages.map((p) => ({ ...p, scope: 'project' })))

    return packages
  } catch {
    return []
  }
}

async function readPackagesFromSettings(settingsPath: string): Promise<InstalledPackage[]> {
  try {
    if (!existsSync(settingsPath)) return []
    const content = await readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(content)
    const packageEntries = settings.packages ?? []

    return packageEntries.map((entry: unknown) => {
      if (typeof entry === 'string') {
        return {
          name: extractPackageName(entry),
          source: entry,
          type: 'package',
          version: extractVersion(entry),
          path: settingsPath,
        }
      }
      if (typeof entry === 'object' && entry !== null) {
        const e = entry as Record<string, unknown>
        return {
          name: extractPackageName(String(e.source ?? '')),
          source: String(e.source ?? ''),
          type: 'package',
          version: extractVersion(String(e.source ?? '')),
          path: settingsPath,
        }
      }
      return { name: 'unknown', source: String(entry), type: 'package', version: null, path: settingsPath }
    })
  } catch {
    return []
  }
}

function extractPackageName(source: string): string {
  // npm:@scope/name@1.0.0 -> @scope/name
  // npm:name@1.0.0 -> name
  // git:github.com/user/repo -> user/repo
  const npmMatch = source.match(/^npm:(@?[^@]+)/)
  if (npmMatch) return npmMatch[1]

  const gitMatch = source.match(/github\.com\/([^/]+\/[^/@]+)/)
  if (gitMatch) return gitMatch[1]

  return source.split('/').pop() ?? source
}

function extractVersion(source: string): string | null {
  const match = source.match(/@([^/]+)$/)
  return match ? match[1] : null
}

// Run a `pi <subcommand>` using the same binary resolved at startup.
// Electron's child processes don't inherit the user's shell PATH, so bare
// `execFileAsync('pi', ...)` would fail with ENOENT on most systems.
async function runPiCli(
  args: string[],
  cwd: string,
  timeout: number
): Promise<{ success: boolean; output: string }> {
  try {
    const [cmd, cmdArgs]: [string, string[]] = PI_CLI.useNode
      ? [PI_CLI.node, [PI_CLI.script, ...args]]
      : [PI_CLI.script, args]
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      cwd,
      timeout,
      env: { ...process.env },
      // Windows .cmd/.bat shims require shell:true to be invoked.
      shell: PI_CLI.needsShell,
    })
    return { success: true, output: stdout + stderr }
  } catch (err) {
    // execFile rejections carry the child's stdout/stderr alongside the
    // message; surface all of it so the CLI's actual error reaches the user
    // instead of a bare "Command failed".
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim()
    return {
      success: false,
      output: output || 'Command failed',
    }
  }
}

async function installPackage(spec: string, cwd: string): Promise<{ success: boolean; output: string }> {
  return runPiCli(['install', spec], cwd, 120_000)
}

async function removePackage(spec: string, cwd: string): Promise<{ success: boolean; output: string }> {
  return runPiCli(['remove', spec], cwd, 30_000)
}

async function updatePackage(spec: string | undefined, cwd: string): Promise<{ success: boolean; output: string }> {
  return runPiCli(spec ? ['update', spec] : ['update'], cwd, 120_000)
}

// ─── Session Lineage Reader ──────────────────────────────────────────────────

async function readSessionLineage(): Promise<SessionLineageRecord[]> {
  const sessionsDir = getSessionsRoot()
  const records: SessionLineageRecord[] = []
  if (!existsSync(sessionsDir)) return records

  let projectDirs: string[]
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true })
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsDir, e.name))
  } catch {
    return records
  }

  for (const dir of projectDirs) {
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const full = join(dir, file)
      try {
        const content = await readFile(full, 'utf-8')
        const newlineIdx = content.indexOf('\n')
        const firstLine = newlineIdx === -1 ? content : content.slice(0, newlineIdx)
        const header = JSON.parse(firstLine) as Record<string, unknown>
        if (header.type !== 'session' || typeof header.id !== 'string') continue
        records.push({
          sessionId: header.id,
          path: full,
          name: typeof header.cwd === 'string' ? header.cwd.split('/').pop() ?? null : null,
          parentPath: typeof header.parentSession === 'string' ? header.parentSession : null,
        })
      } catch {
        // Skip unreadable / malformed session files.
      }
    }
  }
  return records
}

// ─── Skills Listing ──────────────────────────────────────────────────────────

interface InstalledSkill {
  name: string
  description: string
  path: string
  source: string
  enabled: boolean
}

async function listSkills(cwd: string): Promise<InstalledSkill[]> {
  const skills: InstalledSkill[] = []
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''

  // Global skills
  const globalPaths = [
    join(homeDir, '.pi', 'agent', 'skills'),
    join(homeDir, '.agents', 'skills'),
  ]

  for (const skillsDir of globalPaths) {
    await collectSkills(skillsDir, skills, 'global')
  }

  // Project skills
  const projectPaths = [
    join(cwd, '.pi', 'skills'),
    join(cwd, '.agents', 'skills'),
  ]

  for (const skillsDir of projectPaths) {
    await collectSkills(skillsDir, skills, 'project')
  }

  return skills
}

async function collectSkills(
  dir: string,
  skills: InstalledSkill[],
  source: string
): Promise<void> {
  try {
    if (!existsSync(dir)) return

    const items = await readdir(dir, { withFileTypes: true })

    for (const item of items) {
      const fullPath = join(dir, item.name)

      if (item.isFile() && item.name.endsWith('.md') && item.name !== 'SKILL.md') {
        // Root .md file as individual skill
        try {
          const content = await readFile(fullPath, 'utf-8')
          const parsed = parseSkillFrontmatter(content)
          if (parsed) {
            skills.push({
              name: parsed.name,
              description: parsed.description,
              path: fullPath,
              source,
              enabled: true,
            })
          }
        } catch {
          // Skip unreadable files
        }
      } else if (item.isDirectory()) {
        // Directory with SKILL.md
        const skillFile = join(fullPath, 'SKILL.md')
        if (existsSync(skillFile)) {
          try {
            const content = await readFile(skillFile, 'utf-8')
            const parsed = parseSkillFrontmatter(content)
            if (parsed) {
              skills.push({
                name: parsed.name,
                description: parsed.description,
                path: skillFile,
                source,
                enabled: true,
              })
            }
          } catch {
            // Skip unreadable files
          }
        }

        // Recurse into subdirectories
        await collectSkills(fullPath, skills, source)
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
}

function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return null

  const frontmatter = frontmatterMatch[1]
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

  if (!nameMatch || !descMatch) return null

  return {
    name: nameMatch[1].trim(),
    description: descMatch[1].trim(),
  }
}

// ─── App Settings Persistence ────────────────────────────────────────────────

const SETTINGS_FILE_NAME = 'settings.json'

function getSettingsPath(): string {
  return getGuiDataPath(SETTINGS_FILE_NAME)
}

async function loadAppSettings(workspaceManager: WorkspaceManager): Promise<AppSettings> {
  try {
    const settingsPath = getSettingsPath()
    if (existsSync(settingsPath)) {
      const data = await readFile(settingsPath, 'utf-8')
      const saved = JSON.parse(data)
      return { ...DEFAULT_SETTINGS, ...saved }
    }
  } catch {
    // Fall through to defaults
  }

  return {
    ...DEFAULT_SETTINGS,
    defaultCwd: workspaceManager.getActiveWorkspace()?.path ?? (process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()),
  }
}

async function saveAppSettings(settings: Partial<AppSettings>): Promise<void> {
  const settingsPath = getSettingsPath()
  const dir = join(settingsPath, '..')

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  // Merge with existing
  let existing: AppSettings = { ...DEFAULT_SETTINGS }
  try {
    if (existsSync(settingsPath)) {
      const data = await readFile(settingsPath, 'utf-8')
      existing = { ...DEFAULT_SETTINGS, ...JSON.parse(data) }
    }
  } catch {
    // Use defaults
  }

  const merged = { ...existing, ...settings }
  await writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf-8')
}

// ─── MCP Server Discovery ────────────────────────────────────────────────────

interface McpServerInfo {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  source: 'global' | 'project'
  status: 'configured' | 'unknown'
}

async function listMcpServers(wsPath?: string): Promise<McpServerInfo[]> {
  const servers: McpServerInfo[] = []
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''

  // Check Pi global settings for mcpServers
  const globalSettingsPath = join(homeDir, '.pi', 'agent', 'settings.json')
  await collectMcpServers(globalSettingsPath, servers, 'global')

  // Check project settings
  if (wsPath) {
    const projectSettingsPath = join(wsPath, '.pi', 'settings.json')
    await collectMcpServers(projectSettingsPath, servers, 'project')
  }

  // Also check common MCP config locations
  const mcpConfigPaths = [
    join(homeDir, '.config', 'claude', 'claude_desktop_config.json'),
    join(homeDir, '.cursor', 'mcp.json'),
    join(homeDir, '.codeium', 'mcp.json'),
  ]

  for (const configPath of mcpConfigPaths) {
    await collectMcpServersFromConfig(configPath, servers)
  }

  return servers
}

async function collectMcpServers(
  settingsPath: string,
  servers: McpServerInfo[],
  source: 'global' | 'project'
): Promise<void> {
  try {
    if (!existsSync(settingsPath)) return
    const content = await readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(content)

    // Pi settings may have mcpServers under various keys
    const mcpServers = settings.mcpServers ?? settings.mcp?.servers ?? {}

    for (const [name, config] of Object.entries(mcpServers)) {
      if (typeof config === 'object' && config !== null) {
        const cfg = config as Record<string, unknown>
        servers.push({
          name,
          command: String(cfg.command ?? ''),
          args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
          env: typeof cfg.env === 'object' && cfg.env !== null ? cfg.env as Record<string, string> : {},
          source,
          status: 'configured',
        })
      }
    }
  } catch {
    // Skip unreadable files
  }
}

async function collectMcpServersFromConfig(
  configPath: string,
  servers: McpServerInfo[]
): Promise<void> {
  try {
    if (!existsSync(configPath)) return
    const content = await readFile(configPath, 'utf-8')
    const config = JSON.parse(content)

    // Claude Desktop format: { mcpServers: { name: { command, args } } }
    const mcpServers = config.mcpServers ?? {}

    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      if (typeof serverConfig === 'object' && serverConfig !== null) {
        const cfg = serverConfig as Record<string, unknown>
        // Avoid duplicates
        if (!servers.some((s) => s.name === name)) {
          servers.push({
            name,
            command: String(cfg.command ?? ''),
            args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
            env: typeof cfg.env === 'object' && cfg.env !== null ? cfg.env as Record<string, string> : {},
            source: 'global',
            status: 'configured',
          })
        }
      }
    }
  } catch {
    // Skip unreadable files
  }
}
