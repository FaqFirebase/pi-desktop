import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { collectDiagnostics } from '../diagnostics'
import type { IpcContext } from './context'

export function registerDiagnosticsHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.DIAGNOSTICS_GET, async () => collectDiagnostics(ctx.workspaceManager))
}
