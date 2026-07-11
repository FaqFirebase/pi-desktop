import { homedir } from 'os'
import { join } from 'path'

// Pure helpers for the Linux freedesktop autostart entry that implements
// "Run on startup" on Linux (Electron's setLoginItemSettings is macOS/Windows
// only). Kept free of any `electron` import so they can be unit-tested under a
// plain Node runtime. The electron-facing orchestration lives in
// startup-launch.ts.

// Basename of the per-user autostart entry we own. Stable across releases so an
// old entry is reused (not duplicated) after an update.
export const LINUX_AUTOSTART_FILENAME = 'pi-desktop.desktop'

const APP_DISPLAY_NAME = 'Pi Desktop'
const APP_COMMENT = 'Automatically start Pi Desktop at login'

/**
 * Absolute path to the per-user autostart entry, honoring `$XDG_CONFIG_HOME`
 * per the freedesktop spec and falling back to `~/.config`.
 */
export function linuxAutostartPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return join(configHome, 'autostart', LINUX_AUTOSTART_FILENAME)
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

/** Build the full contents of the autostart `.desktop` file. */
export function buildLinuxDesktopEntry(opts: { exec: string; icon: string }): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_DISPLAY_NAME}`,
    `Exec=${quoteDesktopExec(opts.exec)}`,
    `Icon=${opts.icon}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    `Comment=${APP_COMMENT}`,
    '',
  ].join('\n')
}
