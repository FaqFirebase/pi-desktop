import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { ipcMain, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { isOpenPathAction, type DetectedEditor, type OpenPathRequest } from '../../shared/editors'
import { terminalKey } from '../../shared/terminal-slot'
import { isMissingPathError, resolveRealPath } from '../../../resources/path-within'
import { appLog } from '../app-log'
import { escapeCmdSpawn } from '../cmd-escape'
import { detectEditorInstalls, toDetectedEditor, type EditorInstall } from '../editor-detection'
import { openPathRoots, type PathFacts } from '../open-path-policy'
import { createPathOpener } from '../path-opener'
import { isCmdShim } from '../pi-binary-resolution'
import { getSessionRoots } from '../pi-paths'
import { getPiResolution, RESOLUTION_DEPS } from '../pi-rpc-manager'
import { terminalProgramFor } from '../terminal-program'
import { childProcessEnv } from '../windows-exe-search'
import type { IpcContext } from './context'
import { loadAppSettings } from './settings'
import { isObject, isString } from './validation'

const IS_WINDOWS = process.platform === 'win32'
const WINDOWS_CMD = 'cmd.exe'
const MIN_LINE = 1
const LOG_SCOPE = 'editor'

function parseOpenPathRequest(value: unknown): OpenPathRequest {
  if (!isObject(value)) throw new Error('open-path request must be an object')
  const { action, path, line } = value
  if (!isOpenPathAction(action)) throw new Error('Invalid open-path action')
  if (!isString(path) || path.trim() === '') throw new Error('open-path path must be a non-empty string')
  if (line === undefined) return { action, path }
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < MIN_LINE) throw new Error('Invalid open-path line')
  return { action, path, line }
}

async function pathFacts(path: string): Promise<PathFacts | null> {
  try {
    const facts = await stat(path)
    return { isFile: facts.isFile(), mode: facts.mode }
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

function launchDetached(executable: string, args: string[], cwd: string, pathEnv: string): Promise<boolean> {
  const viaCmd = isCmdShim(IS_WINDOWS, executable)
  const command = escapeCmdSpawn(viaCmd, executable, args)
  return new Promise((resolve) => {
    const child = spawn(command.file, command.args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: viaCmd,
      env: childProcessEnv(viaCmd, { ...process.env, PATH: pathEnv }),
    })
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
    child.once('error', (error) => {
      appLog.warn(LOG_SCOPE, `Could not start the editor ${executable}`, error)
      resolve(false)
    })
  })
}

export function registerEditorHandlers(ctx: IpcContext): void {
  const { workspaceManager, terminalService } = ctx
  let cachedInstalls: EditorInstall[] | null = null

  function installs(): EditorInstall[] {
    cachedInstalls ??= detectEditorInstalls(RESOLUTION_DEPS, process.platform, getPiResolution().pathEnv)
    return cachedInstalls
  }

  const openPath = createPathOpener({
    platform: process.platform,
    roots: () => openPathRoots(workspaceManager.getWorkspaces(), getSessionRoots(), ctx.knownSessionFolders),
    baseDir: () => workspaceManager.getActivePanelRoot(),
    stat: pathFacts,
    realPath: resolveRealPath,
    preferredEditor: async () => (await loadAppSettings(workspaceManager)).preferredEditor,
    installs,
    forgetInstalls: () => { cachedInstalls = null },
    launch: (executable, args, cwd) => launchDetached(executable, args, cwd, getPiResolution().pathEnv),
    activeWorkspaceId: () => workspaceManager.getActiveWorkspace()?.id ?? null,
    isEditorTerminalRunning: (workspaceId) => terminalService.isRunning(terminalKey(workspaceId, 'editor')),
    prepareEditorTerminal: (workspaceId, program) => terminalService.prepare(terminalKey(workspaceId, 'editor'), program),
    terminalProgram: (executable, args) =>
      terminalProgramFor(executable, args, IS_WINDOWS, process.env.ComSpec ?? process.env.COMSPEC ?? WINDOWS_CMD),
    openWithSystem: async (path) => (await shell.openPath(path)) === '',
    reveal: (path) => shell.showItemInFolder(path),
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_PATH, async (event, request: unknown) => {
    ctx.assertMainSender(event)
    return openPath(parseOpenPathRequest(request))
  })

  ipcMain.handle(IPC_CHANNELS.EDITORS_DETECT, async (event, force: unknown): Promise<DetectedEditor[]> => {
    ctx.assertMainSender(event)
    if (force === true) cachedInstalls = null
    return installs().map(toDetectedEditor)
  })
}
