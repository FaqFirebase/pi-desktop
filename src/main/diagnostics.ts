import { app } from 'electron'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import type { DiagnosticsReport, DiagnosticsWorkspaceInfo } from '../shared/ipc-contracts'
import {
  countPathEntries,
  extractVersionLine,
  sanitizeProvidersError,
  summarizeProviders,
} from './diagnostics-report'
import type { WorkspaceManager } from './workspace-manager'
import { getConfiguredEngineKind, getPiCli, getPiResolution } from './pi-rpc-manager'
import { workspaceTrustStore } from './workspace-trust'
import { getOmpSessionsRoot, getSessionsRoot } from './pi-paths'
import { getGuiDataDir } from './app-data-paths'
import { appLog } from './app-log'
import { validatePermissionRulesFile } from '../../resources/permission-rules'
import { runPiCli } from './ipc/run-pi-cli'
import { getGlobalPermissionRulesPath } from './ipc/pi-start-options'
import { getSettingsPath, loadAppSettings } from './ipc/settings'
import { buildWorkspaceRulesStatus } from './ipc/permission-rules-handlers'
import { readModelsConfigFile } from './ipc/models-config-handlers'

const PI_VERSION_TIMEOUT_MS = 10_000

async function readGlobalRuleCount(): Promise<{ count: number | null; error: string | null }> {
  const rulesPath = getGlobalPermissionRulesPath()
  if (!existsSync(rulesPath)) return { count: 0, error: null }
  try {
    const parsed: unknown = JSON.parse(await readFile(rulesPath, 'utf-8'))
    return { count: validatePermissionRulesFile(parsed).rules.length, error: null }
  } catch (err) {
    return { count: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function collectDiagnostics(
  workspaceManager: WorkspaceManager,
): Promise<DiagnosticsReport> {
  const settings = await loadAppSettings(workspaceManager)
  const cli = getPiCli()
  const resolution = getPiResolution()

  const activeWorkspace = workspaceManager.getActiveWorkspace()
  // A stale workspace path (folder deleted/renamed outside the app) would make
  // the spawn itself fail on cwd — fall back rather than reporting no version.
  const versionCwd =
    activeWorkspace && existsSync(activeWorkspace.path)
      ? activeWorkspace.path
      : (process.env.HOME ?? process.cwd())
  const piVersionResult = cli.found
    ? await runPiCli(['--version'], versionCwd, PI_VERSION_TIMEOUT_MS)
    : { success: false, output: '' }

  const workspaces: DiagnosticsWorkspaceInfo[] = workspaceManager.getWorkspaces().map((ws) => ({
    id: ws.id,
    name: ws.name,
    path: ws.path,
    pathExists: existsSync(ws.path),
    trusted: workspaceTrustStore.isTrusted(ws.path),
    piStatus: workspaceManager.getPiManager(ws.id)?.getStatus().status ?? 'stopped',
  }))

  const modelsRead = await readModelsConfigFile(getConfiguredEngineKind())
  const providers = 'config' in modelsRead ? summarizeProviders(modelsRead.config, process.env) : null
  const providersError = 'error' in modelsRead ? sanitizeProvidersError(modelsRead.error) : null

  const globalRules = await readGlobalRuleCount()
  const sessionsRoot = getConfiguredEngineKind() === 'omp' ? getOmpSessionsRoot() : getSessionsRoot()

  return {
    generatedAt: Date.now(),
    app: {
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      platform: process.platform,
    },
    piBinary: {
      found: cli.found,
      script: cli.script,
      source: resolution.source,
      useNode: cli.useNode,
      nodeBinary: cli.node,
      nodeFound: cli.nodeFound,
      needsShell: cli.needsShell,
      rejectedOverride: resolution.rejectedOverride,
      failureReason: cli.failureReason,
      pathEntryCount: countPathEntries(resolution.pathEnv, process.platform === 'win32'),
    },
    piVersion: piVersionResult.success ? extractVersionLine(piVersionResult.output) : null,
    workspaces,
    providers,
    providersError,
    permissions: {
      mode: settings.permissionMode,
      globalRuleCount: globalRules.count,
      globalRulesError: globalRules.error,
      workspace: await buildWorkspaceRulesStatus(workspaceManager),
    },
    storage: {
      guiDataDir: getGuiDataDir(),
      settingsPath: getSettingsPath(),
      sessionsRoot,
      sessionsRootExists: existsSync(sessionsRoot),
    },
    recentErrors: appLog.getRecent().filter((entry) => entry.level !== 'info'),
  }
}
