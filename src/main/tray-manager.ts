import { Tray, Menu, Notification, nativeImage, type BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { trayIsSupported, parseDbusBoolean } from './tray-decision'

// System-tray lifecycle for "minimize to tray on close" (Windows/Linux; macOS
// is excluded — see tray-decision.ts). Owns the single Tray instance, the
// one-time "still running" hint, and — critically for cross-platform
// robustness — a check of whether a usable tray actually exists this session.
// Deps are injected once via setupTray so this module imports neither index.ts
// nor ipc-handlers.ts (no cycles).

// D-Bus well-known name a StatusNotifierItem host claims when a system tray is
// available (KDE, GNOME's AppIndicator extension, sni-qt, snixembed, etc.).
const SNI_WATCHER_NAME = 'org.kde.StatusNotifierWatcher'
const SNI_WATCHER_PATH = '/StatusNotifierWatcher'
// Bound the D-Bus probe so a missing/slow session bus can't hang enabling.
const DBUS_PROBE_TIMEOUT_MS = 2_000

interface TrayDeps {
  getWindow: () => BrowserWindow | null
  quit: () => void
  iconPath: string
  // Whether the one-time hint has already been shown in a previous run.
  hasSeenHint: boolean
  // Persist that the hint has now been shown (fire-and-forget).
  onHintShown: () => void
}

let deps: TrayDeps | null = null
let tray: Tray | null = null
let enabled = false
// Whether a usable tray icon actually exists this session. Defaults false and
// is only set true once confirmed, so the close handler never hides the window
// to a tray that isn't really there.
let trayAvailable = false
let hintSeen = false
let warnedNoTray = false

export function setupTray(injected: TrayDeps): void {
  deps = injected
  hintSeen = injected.hasSeenHint
}

function showWindow(): void {
  const win = deps?.getWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Create the tray icon. Returns whether it was created (false on failure). */
function createTray(): boolean {
  if (tray) return true // idempotent
  if (!deps || !trayIsSupported(process.platform)) return false

  try {
    const image = nativeImage.createFromPath(deps.iconPath)
    tray = new Tray(image)
    tray.setToolTip('Pi Desktop')

    const menu = Menu.buildFromTemplate([
      { label: 'Show Pi Desktop', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit Pi Desktop', click: () => deps?.quit() },
    ])
    // setContextMenu is the primary interface on Linux, where left-click
    // activation is unreliable across desktop environments.
    tray.setContextMenu(menu)
    // Windows: a left-click restores the window directly.
    tray.on('click', () => showWindow())
    return true
  } catch (err) {
    console.error('[tray] Failed to create tray icon:', err)
    tray = null
    return false
  }
}

/** Run a `dbus-send --print-reply` and resolve its stdout, or null on error. */
function dbusSend(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('dbus-send', args, { timeout: DBUS_PROBE_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

/**
 * Probe the session bus for a StatusNotifierItem host. Resolves false when no
 * host is present (GNOME without the AppIndicator extension, a minimal WM), when
 * there is no session bus, or when `dbus-send` is unavailable — all cases where
 * an Electron tray icon would silently not appear.
 *
 * Two-step check: the watcher name must be owned, AND — when the watcher exposes
 * it — `IsStatusNotifierHostRegistered` must not be false. That property is the
 * definitive "a host is actually attached to render icons" signal, catching the
 * rare case where the watcher name is owned but no host registered. If the
 * property can't be read (null), we trust the owned name rather than risk a
 * false negative that needlessly disables a working tray.
 */
async function detectLinuxTrayHost(): Promise<boolean> {
  const ownerReply = await dbusSend([
    '--session',
    '--print-reply',
    '--dest=org.freedesktop.DBus',
    '/org/freedesktop/DBus',
    'org.freedesktop.DBus.NameHasOwner',
    `string:${SNI_WATCHER_NAME}`,
  ])
  if (parseDbusBoolean(ownerReply ?? '') !== true) return false

  const hostReply = await dbusSend([
    '--session',
    '--print-reply',
    `--dest=${SNI_WATCHER_NAME}`,
    SNI_WATCHER_PATH,
    'org.freedesktop.DBus.Properties.Get',
    `string:${SNI_WATCHER_NAME}`,
    'string:IsStatusNotifierHostRegistered',
  ])
  // Only a definitive `false` disqualifies; true or unknown (null) → available.
  return parseDbusBoolean(hostReply ?? '') !== false
}

/** Warn once (best-effort) when the feature is on but no tray is available. */
function warnNoTrayOnce(): void {
  if (warnedNoTray) return
  warnedNoTray = true
  console.warn(
    '[tray] No system-tray host detected; "Minimize to tray on close" will fall back to closing normally.',
  )
  if (Notification.isSupported()) {
    new Notification({
      title: 'System tray unavailable',
      body: 'This desktop has no system tray, so Pi Desktop will close normally instead of minimizing to the tray.',
    }).show()
  }
}

/** Fully release the tray icon (on quit, or when the feature is turned off). */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

/**
 * Turn the feature on/off. Creates/destroys the icon, determines whether the
 * tray is actually usable, and records the flags read by the window `close`
 * handler. Turning it off while the window is hidden re-shows the window so the
 * user is never stranded with no window and no icon.
 */
export function setTrayEnabled(next: boolean): void {
  enabled = next
  if (!next) {
    const hadTray = tray !== null
    destroyTray()
    trayAvailable = false
    if (hadTray) showWindow()
    return
  }

  const created = createTray()
  if (!created) {
    trayAvailable = false
    warnNoTrayOnce()
    return
  }

  if (process.platform !== 'linux') {
    // Windows: the notification area is always present.
    trayAvailable = true
    return
  }

  // Linux: the icon only truly appears if a StatusNotifierItem host exists.
  // Stay false until confirmed so a close during the probe won't strand us.
  trayAvailable = false
  void detectLinuxTrayHost().then((ok) => {
    trayAvailable = ok
    if (!ok) warnNoTrayOnce()
  })
}

/** Current setting value, for the close-decision helper. */
export function isTrayEnabled(): boolean {
  return enabled
}

/** Whether a usable tray icon actually exists this session. */
export function isTrayAvailable(): boolean {
  return trayAvailable
}

/** Show the one-time "still running in the tray" hint, at most once ever. */
export function notifyFirstHide(): void {
  if (hintSeen) return
  hintSeen = true
  deps?.onHintShown()
  if (Notification.isSupported()) {
    new Notification({
      title: 'Pi Desktop is still running',
      body: 'The window was hidden to the system tray. Click the tray icon to reopen it, or use Quit to exit.',
    }).show()
  }
}
