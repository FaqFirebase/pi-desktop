import { copyFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { isPathWithin } from '../../resources/path-within'

export const GUI_DATA_ENV_VAR = 'PI_DESKTOP_USER_DATA_DIR'
export const CANONICAL_GUI_DATA_DIR_NAME = 'pi-desktop'
export const LEGACY_GUI_DATA_DIR_NAME = '.pi-desktop-gui'
export const LEGACY_ELECTRON_GUI_DATA_DIR_NAMES = ['PI Desktop', 'pi-desktop-gui'] as const

export const GUI_DATA_FILES = [
  'archived-sessions.json',
  'notes.json',
  'session-auto-tags.json',
  'session-tags.json',
  'settings.json',
  'workspaces.json',
] as const

export type GuiDataFileName = typeof GUI_DATA_FILES[number]

interface PathOptions {
  homeDir?: string
  appDataDir?: string
  userDataDir?: string
}

interface MigrationOptions extends PathOptions {
  files?: readonly string[]
}

function getHomeDir(options?: PathOptions): string {
  return options?.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? ''
}

export function configureGuiDataDir(userDataDir: string): void {
  process.env[GUI_DATA_ENV_VAR] = userDataDir
}

// Startup reads this before configureGuiDataDir() overwrites the env var, so
// an override set by the launching process (test harness, portable install)
// wins over the canonical appData-derived directory.
export function getExternalGuiDataDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const external = env[GUI_DATA_ENV_VAR]
  return external ? resolve(external) : undefined
}

export function getCanonicalUserDataDir(appDataDir: string): string {
  return join(appDataDir, CANONICAL_GUI_DATA_DIR_NAME)
}

/**
 * Whether this launch takes a single-instance lock of its own data folder.
 * Electron keys the lock on the userData path at the moment it is requested,
 * so startup applies the folder before the lock when this is true.
 *
 * A data folder set by the launching process (PI_DESKTOP_USER_DATA_DIR) gets
 * its own lock: launches on different folders run side by side (for example
 * one per account, started by a launcher), and launches on the same folder
 * still fold into one. Every other launch, including one pointed at the
 * canonical folder itself, shares the one lock it always had, so a running
 * copy of the default folder is never joined by a second process. The rule
 * reads only how the app was launched, never a stored setting, so a running
 * copy and a new launch always agree on the lock.
 */
export function usesOwnInstanceLock(
  externalDir: string | undefined,
  canonicalDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!externalDir) return false
  const sameFolder = isPathWithin(canonicalDir, externalDir, platform) && isPathWithin(externalDir, canonicalDir, platform)
  return !sameFolder
}

export function getLegacyGuiDataDirs(options?: PathOptions): string[] {
  const dirs = [join(getHomeDir(options), LEGACY_GUI_DATA_DIR_NAME)]

  if (options?.appDataDir) {
    for (const dirName of LEGACY_ELECTRON_GUI_DATA_DIR_NAMES) {
      dirs.push(join(options.appDataDir, dirName))
    }
  }

  return dirs
}

export function getGuiDataDir(options?: PathOptions): string {
  const configured = options?.userDataDir ?? process.env[GUI_DATA_ENV_VAR]
  if (configured) return configured
  return join(getHomeDir(options), LEGACY_GUI_DATA_DIR_NAME)
}

export function getGuiDataPath(fileName: string, options?: PathOptions): string {
  return join(getGuiDataDir(options), fileName)
}

export function getLegacyGuiDataPath(fileName: string, options?: PathOptions): string {
  return join(getHomeDir(options), LEGACY_GUI_DATA_DIR_NAME, fileName)
}

export async function migrateLegacyGuiData(options: MigrationOptions): Promise<void> {
  const userDataDir = getGuiDataDir(options)
  await mkdir(userDataDir, { recursive: true })

  for (const fileName of options.files ?? GUI_DATA_FILES) {
    const targetPath = getGuiDataPath(fileName, options)

    if (existsSync(targetPath)) continue

    for (const legacyDir of getLegacyGuiDataDirs(options)) {
      const legacyPath = join(legacyDir, fileName)
      if (!existsSync(legacyPath)) continue

      await mkdir(dirname(targetPath), { recursive: true })
      await copyFile(legacyPath, targetPath)
      break
    }
  }
}
