import { ipcMain } from 'electron'
import { IPC_CHANNELS, type OmpUsageResult } from '../../shared/ipc-contracts'
import { t } from '../../shared/i18n'
import { OMP_USAGE_ARGS, parseOmpUsage } from '../omp-usage'
import { activeEngineKind } from './active-engine'
import { runPiCli } from './run-pi-cli'
import type { IpcContext } from './context'

// OMP caches reports, but a cold fetch calls every provider's usage endpoint.
const USAGE_TIMEOUT_MS = 30_000

export function registerOmpUsageHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx
  // Opening the status popover and pressing Refresh share one CLI run.
  let inFlight: Promise<OmpUsageResult> | null = null

  // Null when the engine in view is Pi, which has no usage command.
  ipcMain.handle(IPC_CHANNELS.OMP_USAGE_GET, async (): Promise<OmpUsageResult | null> => {
    if (activeEngineKind(workspaceManager) !== 'omp') return null
    if (!inFlight) {
      const cwd = workspaceManager.getActiveWorkspace()?.path ?? process.cwd()
      inFlight = readOmpUsage(cwd).finally(() => {
        inFlight = null
      })
    }
    return inFlight
  })
}

async function readOmpUsage(cwd: string): Promise<OmpUsageResult> {
  const result = await runPiCli(OMP_USAGE_ARGS, cwd, USAGE_TIMEOUT_MS, 'omp')
  if (!result.success) return { ok: false, error: result.output }
  const report = parseOmpUsage(result.output)
  return report ? { ok: true, report } : { ok: false, error: t('errors.ompUsage.unreadable') }
}
