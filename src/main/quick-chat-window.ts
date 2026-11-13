import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { isTrustedRendererUrl, RENDERER_INDEX_PATH, RENDERER_INDEX_URL } from './renderer-origin'
import { WINDOW_BACKGROUND_COLOR } from './window-appearance'
import {
  adaptiveQuickChatSize,
  clampQuickChatBounds,
  positionQuickChatBounds,
  resolveQuickChatBounds,
  sameRectangle,
  type WindowRectangle,
} from './quick-chat-window-behavior'

/** Must match the hash src/renderer/src/main.tsx checks to render the popup. */
const QUICK_CHAT_ROUTE = 'quick-chat'
const QUICK_CHAT_MIN_WIDTH = 480
const QUICK_CHAT_MIN_HEIGHT = 320

let quickChatWindow: BrowserWindow | null = null
let visibleRequested = false
let readyWindow: BrowserWindow | null = null
let visibilityHandler: (visible: boolean) => void = () => {}
let focusHandler: () => void = () => {}
let quittingHandler: () => boolean = () => false

let userPositioned = false
let lastCustomBounds: WindowRectangle | null = null
let automaticBounds: WindowRectangle | null = null
let applyingBounds = false

export function getQuickChatWindow(): BrowserWindow | null {
  return quickChatWindow && !quickChatWindow.isDestroyed() ? quickChatWindow : null
}

export function isQuickChatOpenRequested(): boolean {
  return visibleRequested
}

/** Shares the main lifecycle's real-quit flag, including cancelled editor guards. */
export function setQuickChatQuittingHandler(handler: () => boolean): void {
  quittingHandler = handler
}

export function setQuickChatVisibilityHandler(handler: (visible: boolean) => void): void {
  visibilityHandler = handler
}

export function setQuickChatFocusHandler(handler: () => void): void {
  focusHandler = handler
}

export function hideQuickChatWindow(): void {
  visibleRequested = false
  getQuickChatWindow()?.hide()
}

export function destroyQuickChatWindow(): void {
  visibleRequested = false
  userPositioned = false
  lastCustomBounds = null
  automaticBounds = null
  const window = getQuickChatWindow()
  if (!window) return
  // destroy() bypasses the user-close-to-hide listener during real teardown.
  if (window.isVisible()) window.hide()
  window.destroy()
}

export function openQuickChatWindow(): void {
  if (quittingHandler()) return
  visibleRequested = true
  const window = getQuickChatWindow()
  if (!window) createQuickChatWindow()
  else if (readyWindow === window) showQuickChatWindow(window)
}

/**
 * The popup is an ordinary window on every platform: it never floats on top
 * and never hides on its own. The shortcut hides it only when it is in front;
 * behind other windows, the shortcut brings it back.
 */
export function toggleQuickChatWindow(): void {
  if (quittingHandler()) return
  const window = getQuickChatWindow()
  if (window?.isVisible() && window.isFocused()) {
    hideQuickChatWindow()
    return
  }
  if (window?.isVisible()) {
    bringToFront(window)
    return
  }
  openQuickChatWindow()
}

function bringToFront(window: BrowserWindow): void {
  window.show()
  window.focus()
  window.webContents.focus()
}

function minimumSizeWithin(workArea: WindowRectangle): { width: number; height: number } {
  return {
    width: Math.min(QUICK_CHAT_MIN_WIDTH, workArea.width),
    height: Math.min(QUICK_CHAT_MIN_HEIGHT, workArea.height),
  }
}

/** Programmatic bounds changes must not count as the user moving the popup. */
function applyBounds(window: BrowserWindow, current: WindowRectangle, next: WindowRectangle, workArea: WindowRectangle): void {
  automaticBounds = next
  applyingBounds = true
  try {
    const minimum = minimumSizeWithin(workArea)
    window.setMinimumSize(minimum.width, minimum.height)
    if (!sameRectangle(current, next)) window.setBounds(next)
  } finally {
    applyingBounds = false
  }
}

function showQuickChatWindow(window: BrowserWindow): void {
  if (!visibleRequested || quittingHandler() || window.isDestroyed()) return
  const currentBounds = window.getBounds()
  const display = userPositioned && lastCustomBounds
    ? screen.getDisplayMatching(lastCustomBounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const workArea = display.workArea
  const next = resolveQuickChatBounds({
    currentBounds,
    lastCustomBounds,
    userPositioned,
    workArea,
  })
  applyBounds(window, currentBounds, next, workArea)
  bringToFront(window)
}

function createQuickChatWindow(): void {
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const initialSize = adaptiveQuickChatSize(workArea)
  const minimumSize = minimumSizeWithin(workArea)
  const window = new BrowserWindow({
    ...positionQuickChatBounds(initialSize, workArea),
    minWidth: minimumSize.width,
    minHeight: minimumSize.height,
    title: 'Pi Desktop',
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: -100, y: -100 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/quick-chat.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    },
  })
  quickChatWindow = window
  window.setMenuBarVisibility(false)

  let reportedVisible = false
  window.on('show', () => {
    reportedVisible = true
    visibilityHandler(true)
  })
  window.on('hide', () => {
    reportedVisible = false
    visibleRequested = false
    visibilityHandler(false)
  })
  window.on('focus', () => focusHandler())
  window.on('blur', () => focusHandler())
  window.on('close', (event) => {
    if (quittingHandler()) return
    event.preventDefault()
    hideQuickChatWindow()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const restrictNavigation = (event: Electron.Event, url: string): void => {
    if (!isTrustedRendererUrl(url, {
      devServerUrl: process.env.ELECTRON_RENDERER_URL,
      rendererIndexPath: RENDERER_INDEX_PATH,
    }) || new URL(url).hash !== `#${QUICK_CHAT_ROUTE}`) event.preventDefault()
  }
  window.webContents.on('will-navigate', restrictNavigation)
  window.webContents.on('will-redirect', restrictNavigation)
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const clampToDisplay = (rememberUserChange = false): void => {
    if (window.isDestroyed()) return
    const bounds = window.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const changed = !automaticBounds || !sameRectangle(bounds, automaticBounds)
    if (rememberUserChange && changed && window.isVisible()) userPositioned = true
    const next = !rememberUserChange && !userPositioned
      ? positionQuickChatBounds(adaptiveQuickChatSize(area), area)
      : clampQuickChatBounds(bounds, area)
    applyBounds(window, bounds, next, area)
    if (userPositioned) lastCustomBounds = next
  }
  const onDisplayChanged = (): void => clampToDisplay()
  const onBoundsChanged = (): void => { if (!applyingBounds) clampToDisplay(true) }
  screen.on('display-metrics-changed', onDisplayChanged)
  screen.on('display-removed', onDisplayChanged)
  window.on('move', onBoundsChanged)
  window.on('resize', onBoundsChanged)
  window.on('closed', () => {
    if (reportedVisible) visibilityHandler(false)
    screen.removeListener('display-metrics-changed', onDisplayChanged)
    screen.removeListener('display-removed', onDisplayChanged)
    if (quickChatWindow === window) {
      quickChatWindow = null
      readyWindow = null
      visibleRequested = false
    }
  })
  const markReadyAndShow = (): void => {
    if (window.isDestroyed() || readyWindow === window) return
    readyWindow = window
    showQuickChatWindow(window)
  }
  window.once('ready-to-show', markReadyAndShow)
  // Some Wayland compositors never emit ready-to-show (electron/electron#48859).
  // Every platform takes the same first-wins path; the shared readiness guard
  // also respects hide and quit.
  window.webContents.once('did-finish-load', markReadyAndShow)
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    const url = new URL(devServerUrl)
    url.hash = QUICK_CHAT_ROUTE
    void window.loadURL(url.toString())
  } else {
    void window.loadURL(`${RENDERER_INDEX_URL}#${QUICK_CHAT_ROUTE}`)
  }
}
