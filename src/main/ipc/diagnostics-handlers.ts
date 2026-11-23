import { dialog, ipcMain } from 'electron'
import { writeFile } from 'fs/promises'
import { IPC_CHANNELS, type LogExportResult } from '../../shared/ipc-contracts'
import { t } from '../../shared/i18n'
import { appLog } from '../app-log'
import { collectDiagnostics } from '../diagnostics'
import { agentEnv } from '../pi-dotenv'
import { buildLogExport, LOG_EXPORT_EXTENSION, logExportFileName, serializeLogExport } from '../log-export'
import { secretValuesFromEnv } from '../log-redaction'
import type { IpcContext } from './context'

export function registerDiagnosticsHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.DIAGNOSTICS_GET, async () => collectDiagnostics(ctx.workspaceManager))

  ipcMain.handle(IPC_CHANNELS.DIAGNOSTICS_EXPORT_LOGS, async (event): Promise<LogExportResult> => {
    ctx.assertMainSender(event)
    const result = await dialog.showSaveDialog({
      title: t('dialogs.logExport.title'),
      defaultPath: logExportFileName(new Date()),
      filters: [{ name: t('dialogs.logExport.fileFilterName'), extensions: [LOG_EXPORT_EXTENSION] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      const [diagnostics, logFiles] = await Promise.all([collectDiagnostics(ctx.workspaceManager), appLog.readLogFiles()])
      const file = buildLogExport({
        diagnostics,
        ...logFiles,
        secretValues: secretValuesFromEnv(agentEnv()),
        exportedAt: Date.now(),
      })
      await writeFile(result.filePath, serializeLogExport(file), 'utf-8')
      return { ok: true, path: result.filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
