// Rules of the Browser pane (components/browser-pane.tsx): which addresses it
// loads, its fixed keys and its zoom steps. Main applies the same URL rule to
// the guest (main/browser-pane-session.ts), so both sides read this module.

import { matchesShortcut, type ShortcutKeyEvent } from './keyboard-shortcuts'

const BROWSER_PANE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])
const HTTP_PREFIX = 'http://'
const HTTPS_PREFIX = 'https://'

const WHITESPACE = /\s/
// A scheme is letters, digits, `+`, `.` or `-` after a first letter, then `:`.
// A digit right after that `:` makes it a port instead (`localhost:5173`).
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:(?!\d)/i
// The host part of an address with no scheme ends at the first `/`, `?` or `#`.
const HOST_PART_END = /[/?#]/
const LOCALHOST_HOST = /^localhost(?::\d+)?$/i
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/
const IPV6_HOST = /^\[[^\]]+\](?::\d+)?$/
const PORT_SUFFIX = /:\d+$/

/** True when `url` parses as an http or https URL. */
export function isBrowserPaneUrl(url: string): boolean {
  const parsed = URL.parse(url)
  return parsed !== null && BROWSER_PANE_PROTOCOLS.has(parsed.protocol)
}

/** Local and `host:port` addresses are usually dev servers without TLS. */
function isPlainHttpHost(host: string): boolean {
  return LOCALHOST_HOST.test(host) || IPV4_HOST.test(host) || IPV6_HOST.test(host) || PORT_SUFFIX.test(host)
}

/**
 * The URL an address-bar entry opens, or null when the pane refuses it. An
 * entry with no scheme gets `http://` for localhost, an IP literal or a
 * `host:port`, else `https://`. Only http and https URLs with a host pass.
 */
export function normalizeAddressInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed || WHITESPACE.test(trimmed)) return null
  let candidate = trimmed
  if (!SCHEME_PREFIX.test(trimmed)) {
    const hostEnd = trimmed.search(HOST_PART_END)
    const host = hostEnd === -1 ? trimmed : trimmed.slice(0, hostEnd)
    candidate = (isPlainHttpHost(host) ? HTTP_PREFIX : HTTPS_PREFIX) + trimmed
  }
  const parsed = URL.parse(candidate)
  if (!parsed || !parsed.hostname || !isBrowserPaneUrl(parsed.href)) return null
  return parsed.href
}

export type BrowserPaneKeyAction = 'reload' | 'focusAddress' | 'zoomIn' | 'zoomOut' | 'zoomReset'

/** Fixed keys while the pane's page has focus. They are not rebindable. */
export const BROWSER_PANE_KEY_BINDINGS: readonly { binding: string; action: BrowserPaneKeyAction }[] = [
  { binding: 'Mod+R', action: 'reload' },
  { binding: 'Mod+L', action: 'focusAddress' },
  { binding: 'Mod+Equal', action: 'zoomIn' },
  { binding: 'Mod+Shift+Equal', action: 'zoomIn' },
  { binding: 'Mod+Minus', action: 'zoomOut' },
  { binding: 'Mod+0', action: 'zoomReset' },
]

/** The pane action a key press asks for, or null when it is not a pane key. */
export function browserPaneKeyAction(event: ShortcutKeyEvent, platform: string): BrowserPaneKeyAction | null {
  return BROWSER_PANE_KEY_BINDINGS.find(({ binding }) => matchesShortcut(event, binding, platform))?.action ?? null
}

export const BROWSER_PANE_ZOOM_STEP = 0.5
export const BROWSER_PANE_MIN_ZOOM_LEVEL = -4
export const BROWSER_PANE_MAX_ZOOM_LEVEL = 4
const BROWSER_PANE_DEFAULT_ZOOM_LEVEL = 0

/** The page zoom level after a zoom key, kept between the bounds. */
export function nextZoomLevel(current: number, action: 'zoomIn' | 'zoomOut' | 'zoomReset'): number {
  if (action === 'zoomReset') return BROWSER_PANE_DEFAULT_ZOOM_LEVEL
  const next = current + (action === 'zoomIn' ? BROWSER_PANE_ZOOM_STEP : -BROWSER_PANE_ZOOM_STEP)
  return Math.min(BROWSER_PANE_MAX_ZOOM_LEVEL, Math.max(BROWSER_PANE_MIN_ZOOM_LEVEL, next))
}

/** What happened in a Browser pane guest: a pane key, or a download main refused. */
export type BrowserPaneGuestSignal = { kind: 'key'; action: BrowserPaneKeyAction } | { kind: 'download-refused' }

/** What main tells the app window about a Browser pane guest. */
export type BrowserPaneGuestEvent = { webContentsId: number } & BrowserPaneGuestSignal

/** The saved last page per workspace path, with every non-http/https entry dropped. */
export function normalizeBrowserPaneUrls(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && isBrowserPaneUrl(entry[1])),
  )
}
