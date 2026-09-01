import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { isValidPackageSpec } from '../../shared/package-spec'
import { fetchPackageCatalog } from '../package-catalog'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { assertTrustedSender, isString } from './validation'
import { runPiCli } from './run-pi-cli'
import { activeEngineKind } from './active-engine'
import { parseOmpPluginList } from '../omp-plugin-list'
import type { AgentEngineKind, InstalledPackage } from '../../shared/ipc-contracts'
import type { IpcContext } from './context'

export function registerPackageHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx

  // ─── Package Management ─────────────────────────────────────────────────

  // Package actions target the engine the user is looking at, and run that
  // engine's own CLI — a session from the other store can be active while a
  // different engine is the configured default.
  const activeEngine = (): AgentEngineKind => activeEngineKind(workspaceManager)

  ipcMain.handle(IPC_CHANNELS.PACKAGE_LIST_INSTALLED, async () => {
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return listInstalledPackages(cwd, activeEngine())
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_INSTALL, async (event, packageSpec: unknown) => {
    assertTrustedSender(event)
    if (!isString(packageSpec)) throw new Error('packageSpec must be a string')
    if (!isValidPackageSpec(packageSpec)) throw new Error('Invalid package specification')
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return installPackage(packageSpec, cwd, activeEngine())
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_REMOVE, async (event, packageSpec: unknown) => {
    assertTrustedSender(event)
    if (!isString(packageSpec)) throw new Error('packageSpec must be a string')
    if (!isValidPackageSpec(packageSpec)) throw new Error('Invalid package specification')
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return removePackage(packageSpec, cwd, activeEngine())
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_UPDATE, async (event, packageSpec?: unknown) => {
    assertTrustedSender(event)
    if (isString(packageSpec) && !isValidPackageSpec(packageSpec)) {
      throw new Error('Invalid package specification')
    }
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    return updatePackage(isString(packageSpec) ? packageSpec : undefined, cwd, activeEngine())
  })

  ipcMain.handle(IPC_CHANNELS.PACKAGE_CATALOG_FETCH, async (_event, query?: unknown) => {
    return fetchPackageCatalog(isString(query) ? query : undefined)
  })
}

// ─── Package Management ──────────────────────────────────────────────────────

const LIST_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 120_000
const REMOVE_TIMEOUT_MS = 30_000
const UPDATE_TIMEOUT_MS = 120_000

async function listInstalledPackages(cwd: string, engine: AgentEngineKind): Promise<InstalledPackage[]> {
  try {
    if (engine === 'omp') return listOmpPlugins(cwd)
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const globalSettingsPath = join(homeDir, '.pi', 'agent', 'settings.json')
    const projectSettingsPath = join(cwd, '.pi', 'settings.json')

    const packages: InstalledPackage[] = []
    const globalPackages = await readPackagesFromSettings(globalSettingsPath)
    packages.push(...globalPackages.map((p) => ({ ...p, scope: 'global' })))
    const projectPackages = await readPackagesFromSettings(projectSettingsPath)
    packages.push(...projectPackages.map((p) => ({ ...p, scope: 'project' })))
    return packages
  } catch {
    return []
  }
}

/**
 * OMP does not track packages in a settings.json `packages` array — its plugin
 * store lives in `~/.omp/plugins/` — so the installed list comes from the CLI.
 */
async function listOmpPlugins(cwd: string): Promise<InstalledPackage[]> {
  const result = await runPiCli(['plugin', 'list', '--json'], cwd, LIST_TIMEOUT_MS, 'omp')
  if (!result.success) return []
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return parseOmpPluginList(result.output, join(homeDir, '.omp', 'plugins'))
}

async function readPackagesFromSettings(settingsPath: string): Promise<InstalledPackage[]> {
  try {
    if (!existsSync(settingsPath)) return []
    const content = await readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(content)
    const packageEntries = settings.packages ?? []

    return packageEntries.map((entry: unknown) => {
      if (typeof entry === 'string') {
        return {
          name: extractPackageName(entry),
          source: entry,
          type: 'package',
          version: extractVersion(entry),
          path: settingsPath,
        }
      }
      if (typeof entry === 'object' && entry !== null) {
        const e = entry as Record<string, unknown>
        return {
          name: extractPackageName(String(e.source ?? '')),
          source: String(e.source ?? ''),
          type: 'package',
          version: extractVersion(String(e.source ?? '')),
          path: settingsPath,
        }
      }
      return { name: 'unknown', source: String(entry), type: 'package', version: null, path: settingsPath }
    })
  } catch {
    return []
  }
}

function extractPackageName(source: string): string {
  // npm:@scope/name@1.0.0 -> @scope/name
  // npm:name@1.0.0 -> name
  // git:github.com/user/repo -> user/repo
  const npmMatch = source.match(/^npm:(@?[^@]+)/)
  if (npmMatch) return npmMatch[1]

  const gitMatch = source.match(/github\.com\/([^/]+\/[^/@]+)/)
  if (gitMatch) return gitMatch[1]

  return source.split('/').pop() ?? source
}

function extractVersion(source: string): string | null {
  const match = source.match(/@([^/]+)$/)
  return match ? match[1] : null
}

async function installPackage(spec: string, cwd: string, engine: AgentEngineKind): Promise<{ success: boolean; output: string }> {
  return runPiCli(['install', spec], cwd, INSTALL_TIMEOUT_MS, engine)
}

async function removePackage(spec: string, cwd: string, engine: AgentEngineKind): Promise<{ success: boolean; output: string }> {
  return runPiCli(['remove', spec], cwd, REMOVE_TIMEOUT_MS, engine)
}

async function updatePackage(spec: string | undefined, cwd: string, engine: AgentEngineKind): Promise<{ success: boolean; output: string }> {
  return runPiCli(spec ? ['update', spec] : ['update'], cwd, UPDATE_TIMEOUT_MS, engine)
}
