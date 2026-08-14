import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { appLog } from '../app-log'

export function registerLogHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.LOG_GET_RECENT, async () => appLog.getRecent())
}
