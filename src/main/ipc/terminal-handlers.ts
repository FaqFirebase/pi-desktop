import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { assertTrustedSender, isString, isObject } from './validation'
import type { IpcContext } from './context'

export function registerTerminalHandlers(ctx: IpcContext): void {
  const { workspaceManager, terminalService, broadcast } = ctx

  function workspace(id: unknown) {
    if (!isString(id)) throw new Error('workspaceId must be a string')
    const result = workspaceManager.getWorkspaces().find((item) => item.id === id)
    if (!result) throw new Error('Unknown terminal workspace')
    return result
  }

  function dimension(value: unknown, fallback: number): number {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 10000) {
      throw new Error('Invalid terminal size')
    }
    return value
  }

  ipcMain.handle(IPC_CHANNELS.TERMINAL_START, async (event, id: unknown, options: unknown) => {
    assertTrustedSender(event)
    const project = workspace(id)
    const opts = isObject(options) ? options : {}
    return terminalService.start(
      project.id,
      {
        cwd: project.path,
        cols: dimension(opts.cols, 80),
        rows: dimension(opts.rows, 24),
      },
      (data) => broadcast(IPC_CHANNELS.EVENT_TERMINAL_DATA, { workspaceId: project.id, data }),
      (event) => broadcast(IPC_CHANNELS.EVENT_TERMINAL_EXIT, { ...event, workspaceId: project.id })
    )
  })

  ipcMain.handle(IPC_CHANNELS.TERMINAL_INPUT, async (event, id: unknown, data: unknown) => {
    assertTrustedSender(event)
    const project = workspace(id)
    if (!isString(data)) throw new Error('terminal input must be a string')
    terminalService.write(project.id, data)
  })

  ipcMain.handle(IPC_CHANNELS.TERMINAL_RESIZE, async (event, id: unknown, size: unknown) => {
    assertTrustedSender(event)
    const project = workspace(id)
    if (!isObject(size)) throw new Error('terminal size must be an object')
    terminalService.resize(project.id, dimension(size.cols, 80), dimension(size.rows, 24))
  })

  ipcMain.handle(IPC_CHANNELS.TERMINAL_STOP, async (event, id: unknown) => {
    assertTrustedSender(event)
    // Cleanup may arrive after the workspace has already been removed.
    if (!isString(id)) throw new Error('workspaceId must be a string')
    terminalService.stop(id)
  })
}
