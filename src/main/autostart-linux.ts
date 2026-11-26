import { homedir } from 'os'
import { join } from 'path'

// Pure helpers for the Linux freedesktop entries: the autostart entry that
// implements "Run on startup" (Electron's setLoginItemSettings is macOS/Windows
// only) and the application entry that gives the app its id. Kept free of any
// `electron` import so they can be unit-tested under a plain Node runtime. The
// electron-facing orchestration lives in startup-launch.ts and
// linux-application-entry.ts.

// Basename of both per-user entries we own. It must match package.json
// `desktopName`: Electron names its systemd scope after it, and the desktop
// portal accepts that id only when an entry with this name is installed.
// Stable across releases so an old entry is reused (not duplicated) after an update.
export const LINUX_DESKTOP_FILENAME = 'pi-desktop.desktop'

/** Icon theme name of the installed app icon. */
export const LINUX_ICON_NAME = 'pi-desktop'

/** Marks an application entry as written by the app, so it only ever rewrites its own file. */
export const LINUX_GENERATED_ENTRY_LINE = 'X-Pi-Desktop-Generated=true'

const APP_DISPLAY_NAME = 'Pi Desktop'
const AUTOSTART_COMMENT = 'Automatically start Pi Desktop at login'
const APPLICATION_COMMENT = 'Desktop GUI for the Pi coding agent'
const APPLICATION_CATEGORIES = 'Development;'
const ICON_SIZE = '512x512'
const DEFAULT_DATA_DIRS = '/usr/local/share:/usr/share'

function dataHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')
}

/**
 * Absolute path to the per-user autostart entry, honoring `$XDG_CONFIG_HOME`
 * per the freedesktop spec and falling back to `~/.config`.
 */
export function linuxAutostartPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return join(configHome, 'autostart', LINUX_DESKTOP_FILENAME)
}

/**
 * The command Linux should launch at login. Prefers `$APPIMAGE`: under an
 * AppImage, `process.execPath` points into a temporary mount that changes every
 * run, whereas `$APPIMAGE` is the real, persistent path to the AppImage file.
 */
export function linuxLaunchExec(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string {
  return env.APPIMAGE?.trim() || execPath
}

/**
 * Quote a path for a `.desktop` `Exec=` value. Wraps in double quotes and
 * escapes backslash and double-quote, so paths containing spaces are handled
 * per the freedesktop Desktop Entry spec.
 */
export function quoteDesktopExec(path: string): string {
  const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

function desktopEntry(opts: { exec: string; icon: string }, extraLines: string[]): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_DISPLAY_NAME}`,
    `Exec=${quoteDesktopExec(opts.exec)}`,
    `Icon=${opts.icon}`,
    'Terminal=false',
    ...extraLines,
    '',
  ].join('\n')
}

/** Build the full contents of the autostart `.desktop` file. */
export function buildLinuxDesktopEntry(opts: { exec: string; icon: string }): string {
  return desktopEntry(opts, ['X-GNOME-Autostart-enabled=true', `Comment=${AUTOSTART_COMMENT}`])
}

/** Build the application entry: the app menu item, and the app id for the desktop portal. */
export function buildLinuxApplicationEntry(opts: { exec: string; icon: string }): string {
  return desktopEntry(opts, [
    `Comment=${APPLICATION_COMMENT}`,
    `Categories=${APPLICATION_CATEGORIES}`,
    `StartupWMClass=${LINUX_ICON_NAME}`,
    LINUX_GENERATED_ENTRY_LINE,
  ])
}

/** Per-user application entry path, honoring `$XDG_DATA_HOME` and falling back to `~/.local/share`. */
export function linuxApplicationEntryPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(dataHome(env, home), 'applications', LINUX_DESKTOP_FILENAME)
}

/** Where the app icon is installed, so the entry keeps an icon after an AppImage's temporary mount is gone. */
export function linuxIconInstallPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(dataHome(env, home), 'icons', 'hicolor', ICON_SIZE, 'apps', `${LINUX_ICON_NAME}.png`)
}

/** Application entries a system install would provide, from `$XDG_DATA_DIRS` or its spec default. */
export function linuxSystemApplicationEntryPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = env.XDG_DATA_DIRS?.trim() || DEFAULT_DATA_DIRS
  return dirs.split(':').filter(Boolean).map((dir) => join(dir, 'applications', LINUX_DESKTOP_FILENAME))
}

/**
 * Whether to write the per-user application entry. A system install already gives the app
 * its id, and a file without our marker belongs to the user or another tool: both are left
 * alone. Our own file is rewritten when it is stale, for example after the AppImage moved.
 */
export function shouldWriteLinuxApplicationEntry(input: {
  userEntry: string | null
  systemEntryExists: boolean
  wanted: string
}): boolean {
  if (input.userEntry === null) return !input.systemEntryExists
  return input.userEntry.split('\n').includes(LINUX_GENERATED_ENTRY_LINE) && input.userEntry !== input.wanted
}
