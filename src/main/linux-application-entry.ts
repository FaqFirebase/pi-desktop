import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  LINUX_ICON_NAME,
  buildLinuxApplicationEntry,
  linuxApplicationEntryPath,
  linuxIconInstallPath,
  linuxLaunchExec,
  linuxSystemApplicationEntryPaths,
  shouldWriteLinuxApplicationEntry,
} from './autostart-linux'
import { appIconPath } from './startup-launch'

// Linux only. The desktop portal gives an unsandboxed app its id only when an
// installed entry matches the app's systemd scope name, which Electron takes
// from package.json `desktopName`. Without that entry the portal refuses every
// system-wide shortcut ("An app id is required"), while globalShortcut.register
// still reports success on Wayland. An AppImage installs no entry, so the app
// installs its own.
//
// The portal fixes an app's id at that app's first portal call, which Chromium
// makes during startup, so this runs synchronously before the app is ready.
//
// Only in packaged builds, like the autostart entry: in development the
// executable is the Electron binary inside node_modules.

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Installs or refreshes the per-user application entry and its icon. Idempotent. */
export function installLinuxApplicationEntry(): void {
  if (process.platform !== 'linux' || !app.isPackaged) return
  const target = linuxApplicationEntryPath()
  const wanted = buildLinuxApplicationEntry({ exec: linuxLaunchExec(), icon: LINUX_ICON_NAME })
  if (!shouldWriteLinuxApplicationEntry({
    userEntry: readIfPresent(target),
    systemEntryExists: linuxSystemApplicationEntryPaths().some((path) => existsSync(path)),
    wanted,
  })) return
  const icon = linuxIconInstallPath()
  mkdirSync(dirname(icon), { recursive: true })
  copyFileSync(appIconPath(), icon)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, wanted, 'utf-8')
}
