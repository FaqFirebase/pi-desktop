import { app } from 'electron'
import { mkdir, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import {
  buildLinuxDesktopEntry,
  linuxAutostartPath,
  linuxLaunchExec,
} from './autostart-linux'

// Cross-platform "Run on startup": launch Pi Desktop automatically at login.
//   - macOS / Windows: Electron's native login-item support.
//   - Linux: a per-user freedesktop autostart entry (Electron has no Linux
//     support for setLoginItemSettings).
//
// Only effective in packaged builds. In development the executable is the
// Electron binary inside node_modules; registering that as a login item is
// meaningless and points at a path the user's real install won't have.

/** Absolute path to the app icon, mirroring index.ts's getAppIconPath logic. */
function appIconPath(): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  return join(base, 'icons', 'icon.png')
}

async function writeLinuxAutostart(): Promise<void> {
  const target = linuxAutostartPath()
  await mkdir(join(target, '..'), { recursive: true })
  const content = buildLinuxDesktopEntry({ exec: linuxLaunchExec(), icon: appIconPath() })
  await writeFile(target, content, 'utf-8')
}

async function removeLinuxAutostart(): Promise<void> {
  try {
    await unlink(linuxAutostartPath())
  } catch (err) {
    // Already absent → nothing to do. Surface anything else.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Apply the "run on startup" preference to the operating system. Idempotent:
 * safe to call on every change and on startup to reconcile drift (e.g. a stale
 * Linux Exec path after the AppImage is moved or updated).
 */
export async function applyRunOnStartup(enabled: boolean): Promise<void> {
  if (!app.isPackaged) return

  if (process.platform === 'linux') {
    if (enabled) {
      await writeLinuxAutostart()
    } else {
      await removeLinuxAutostart()
    }
    return
  }

  // macOS and Windows: defaults for path (process.execPath) and args ([]) are
  // correct for our dmg/NSIS builds.
  app.setLoginItemSettings({ openAtLogin: enabled })
}
