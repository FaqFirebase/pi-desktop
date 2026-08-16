import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { assertTrustedSender, isString, isObject } from './validation'
import type { IpcContext } from './context'

export function registerTerminalHandlers(ctx: IpcContext): void {
  const { workspaceManager, terminalService, broadcast } = ctx

  // ─── Terminal ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.TERMINAL_START, async (event, options: unknown) => {
    assertTrustedSender(event)
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

  ipcMain.handle(IPC_CHANNELS.TERMINAL_INPUT, async (event, data: unknown) => {
    assertTrustedSender(event)
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
}
