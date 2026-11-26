import { ipcMain } from 'electron'
import { IPC_CHANNELS, type OmpUsageResult } from '../../shared/ipc-contracts'
import { t } from '../../shared/i18n'
import { OMP_USAGE_ARGS, OMP_USAGE_INVALIDATE_ARGS, createOmpUsageLoader, parseOmpUsage } from '../omp-usage'
import { activeEngineKind } from './active-engine'
import { accountCommandCwd, runPiCli } from './run-pi-cli'
import type { IpcContext } from './context'

// OMP caches reports, but a cold fetch calls every provider's usage endpoint.
const USAGE_TIMEOUT_MS = 30_000
// Dropping the cache is local to OMP's store.
const INVALIDATE_TIMEOUT_MS = 10_000

export function registerOmpUsageHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx
  // Usage belongs to the account, so a deleted workspace folder must not fail it.
  const cwd = (): string => accountCommandCwd(workspaceManager.getActiveWorkspace()?.path)
  const loadUsage = createOmpUsageLoader({
    read: () => readOmpUsage(cwd()),
    invalidate: async () => {
      await runPiCli(OMP_USAGE_INVALIDATE_ARGS, cwd(), INVALIDATE_TIMEOUT_MS, 'omp')
    },
  })

  // Null when the engine in view is Pi, which has no usage command. Only a
  // literal `true` asks for a refresh; any other payload reads the cache.
  ipcMain.handle(IPC_CHANNELS.OMP_USAGE_GET, async (_event, refresh: unknown): Promise<OmpUsageResult | null> => {
    if (activeEngineKind(workspaceManager) !== 'omp') return null
    return loadUsage(refresh === true)
  })
}

async function readOmpUsage(cwd: string): Promise<OmpUsageResult> {
  const result = await runPiCli(OMP_USAGE_ARGS, cwd, USAGE_TIMEOUT_MS, 'omp')
  if (!result.success) return { ok: false, error: result.output }
  const report = parseOmpUsage(result.output)
  return report ? { ok: true, report } : { ok: false, error: t('errors.ompUsage.unreadable') }
}
