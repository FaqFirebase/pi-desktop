import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { QUICK_CHAT_CHANNELS } from '../../shared/quick-chat'
import { appLog } from '../app-log'
import { RendererErrorLog } from '../renderer-error-log'
import { assertTrustedSender } from './validation'

const rendererErrorLog = new RendererErrorLog({ log: appLog })

/** The main window and the Quick Chat window each report on their own channel, into one rate-limited log. */
export function registerRendererErrorHandlers(): void {
  const report = async (event: IpcMainInvokeEvent, record: unknown): Promise<void> => {
    assertTrustedSender(event)
    rendererErrorLog.record(record)
  }
  ipcMain.handle(IPC_CHANNELS.RENDERER_ERROR_REPORT, report)
  ipcMain.handle(QUICK_CHAT_CHANNELS.rendererError, report)
}
