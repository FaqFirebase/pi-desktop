// Pure decisions for the Browser pane <webview> guest (components/browser-pane.tsx).
// Kept free of any runtime `electron` import so they can be unit-tested under a
// plain Node runtime; browser-pane-session.ts and index.ts apply them.

import { isBrowserPaneUrl } from '../shared/browser-pane'

const MAIN_FRAME_RESOURCE_TYPE = 'mainFrame'

type BrowserPaneGuestPreferences = Pick<
  Electron.WebPreferences,
  'preload' | 'nodeIntegration' | 'nodeIntegrationInSubFrames' | 'contextIsolation' | 'sandbox'
  | 'webSecurity' | 'allowRunningInsecureContent' | 'plugins' | 'javascript'
>

/**
 * The web preferences of every Browser pane guest: our picker preload, no Node
 * in any frame, isolated and sandboxed, web security on, no plugins. Pages run
 * their own scripts, since the pane shows ordinary web pages.
 */
export function browserPaneGuestPreferences(preloadPath: string): BrowserPaneGuestPreferences {
  return {
    preload: preloadPath,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    plugins: false,
    javascript: true,
  }
}

/** How long after the user's last mouse-down or key-down in the page a pop-up counts as clicked. */
export const USER_GESTURE_WINDOW_MS = 1000

export type BrowserPanePopupAction = 'open-in-pane' | 'deny'

/**
 * What a pop-up (window.open, target=_blank) does. Electron gives no
 * user-gesture flag in the window-open details, so main tracks the guest's
 * last mouse-down or key-down and passes the time since it. A clicked http or
 * https pop-up loads in the pane; any other is denied without a word, so a
 * page cannot open windows or the default browser on its own.
 */
export function browserPanePopupAction(url: string, msSinceUserInput: number): BrowserPanePopupAction {
  if (!isBrowserPaneUrl(url)) return 'deny'
  return msSinceUserInput <= USER_GESTURE_WINDOW_MS ? 'open-in-pane' : 'deny'
}

/**
 * Whether the Browser pane partition cancels a request: a top-level load of
 * anything but http or https. Subresources (data: images, for example) load
 * as in any browser.
 */
export function isBlockedBrowserPaneRequest(url: string, resourceType: string): boolean {
  return resourceType === MAIN_FRAME_RESOURCE_TYPE && !isBrowserPaneUrl(url)
}
