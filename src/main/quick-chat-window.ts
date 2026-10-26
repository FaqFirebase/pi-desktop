import { app, BrowserWindow, Menu, screen } from 'electron'
import { join } from 'path'
import { isTrustedRendererUrl, RENDERER_INDEX_PATH } from './renderer-origin'
import { adaptiveQuickChatSize, clampQuickChatBounds, positionQuickChatBounds, resolveQuickChatBounds, shouldHideQuickChatOnBlur, type WindowRectangle } from './quick-chat-window-behavior'

let quickChatWindow: BrowserWindow | null = null
let visibleRequested = false
let readyWindow: BrowserWindow | null = null
let visibilityHandler: (visible: boolean) => void = () => {}
let quittingHandler: () => boolean = () => false
// While a native modal parented to the popup is open (the folder picker), the
// popup loses OS focus but that focus transfer is owned, not an outside click.
let nativeModalOpen = 0

let userPositioned = false
let lastCustomBounds: WindowRectangle | null = null
let automaticBounds: WindowRectangle | null = null
let applyingBounds = false
let pinned = false

export function setQuickChatPinned(value: boolean): void {
  pinned = value
}

export function isQuickChatPinned(): boolean {
  return pinned
}

export function getQuickChatWindow(): BrowserWindow | null {
  return quickChatWindow && !quickChatWindow.isDestroyed() ? quickChatWindow : null
}

/** Mark a parented native modal (folder picker) open/closed around its await. */
export function markQuickChatNativeModal(open: boolean): void {
  nativeModalOpen = open ? nativeModalOpen + 1 : Math.max(0, nativeModalOpen - 1)
}

/** Shares the main lifecycle's real-quit flag, including cancelled editor guards. */
export function setQuickChatQuittingHandler(handler: () => boolean): void {
  quittingHandler = handler
}

export function setQuickChatVisibilityHandler(handler: (visible: boolean) => void): void {
  visibilityHandler = handler
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

export function toggleQuickChatWindow(): void {
  if (quittingHandler()) return
  const window = getQuickChatWindow()
  if (visibleRequested || window?.isVisible()) {
    hideQuickChatWindow()
    return
  }
  openQuickChatWindow()
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
  automaticBounds = next
  applyingBounds = true
  try {
    window.setMinimumSize(Math.min(480, workArea.width), Math.min(320, workArea.height))
    window.setBounds(next)
  } finally {
    applyingBounds = false
  }
  window.show()
  window.focus()
  window.webContents.focus()
}

function createQuickChatWindow(): void {
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const initialSize = adaptiveQuickChatSize(workArea)
  const window = new BrowserWindow({
    ...positionQuickChatBounds(initialSize, workArea),
    minWidth: Math.min(480, workArea.width),
    minHeight: Math.min(320, workArea.height),
    title: 'Pi Desktop',
    backgroundColor: '#0a0a0a',
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
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
  if (process.platform === 'darwin') {
    // setVisibleOnAllWorkspaces transforms the process type between
    // UIElementApplication and ForegroundApplication to set the window's
    // collection behavior; that transform also hides the app's Dock icon even
    // though the main window still exists. Capture the prior state and restore
    // the Dock so a normal app keeps its entry (observed on Electron 43).
    const dockWasVisible = app.dock?.isVisible() ?? true
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    if (dockWasVisible && app.dock && !app.dock.isVisible()) app.dock.show()
  }
  quickChatWindow = window
  window.setMenuBarVisibility(false)

  let composing = false
  let menuOpen = false
  let reportedVisible = false
  let blurTimer: NodeJS.Timeout | undefined
  const cancelBlur = (): void => {
    clearTimeout(blurTimer)
    blurTimer = undefined
  }
  const checkBlur = (applicationDeactivated = false): void => {
    if (window.isDestroyed() || nativeModalOpen > 0) return
    const focused = BrowserWindow.getFocusedWindow()
    const ownsFocusedWindow = focused?.getParentWindow() === window
    if (shouldHideQuickChatOnBlur({
      visible: window.isVisible(),
      focused: window.isFocused(),
      ownedInteraction: menuOpen || ownsFocusedWindow,
      composing,
      applicationDeactivated,
      pinned,
    })) hideQuickChatWindow()
  }
  const scheduleBlur = (): void => {
    cancelBlur()
    // A short focus transfer (native menus, IME candidates, child dialogs) must
    // settle before deciding whether this was a real click outside the popup.
    blurTimer = setTimeout(() => {
      blurTimer = undefined
      checkBlur()
    }, 120)
  }
  const onApplicationDeactivated = (): void => checkBlur(true)
  const onOtherWindowFocused = (_event: Electron.Event, focused: BrowserWindow): void => {
    // Same rule as the blur path: a pinned popup stays up even when another
    // window (main included) takes focus.
    if (!pinned && nativeModalOpen === 0 && focused !== window && focused.getParentWindow() !== window) hideQuickChatWindow()
  }
  const onMenuShow = (): void => { menuOpen = window.isFocused() || menuOpen }
  const onMenuClose = (): void => { menuOpen = false; scheduleBlur() }
  const menus: Menu[] = []
  const unwatchMenus = (): void => {
    for (const menu of menus) {
      menu.removeListener('menu-will-show', onMenuShow)
      menu.removeListener('menu-will-close', onMenuClose)
    }
    menus.length = 0
  }
  const watchMenu = (menu: Menu): void => {
    menus.push(menu)
    menu.on('menu-will-show', onMenuShow)
    menu.on('menu-will-close', onMenuClose)
    for (const item of menu.items) if (item.submenu) watchMenu(item.submenu)
  }
  const menu = Menu.getApplicationMenu()
  if (menu) watchMenu(menu)

  window.on('blur', scheduleBlur)
  window.on('focus', () => {
    cancelBlur()
    // A language change rebuilds the application menu while this window is hidden.
    const currentMenu = Menu.getApplicationMenu()
    if (currentMenu === menus[0]) return
    unwatchMenus()
    if (currentMenu) watchMenu(currentMenu)
  })
  window.on('show', () => {
    reportedVisible = true
    visibilityHandler(true)
  })
  window.on('hide', () => {
    reportedVisible = false
    menuOpen = false
    visibleRequested = false
    composing = false
    cancelBlur()
    visibilityHandler(false)
  })
  window.on('close', (event) => {
    if (quittingHandler()) return
    event.preventDefault()
    hideQuickChatWindow()
  })
  app.on('did-resign-active', onApplicationDeactivated)
  app.on('browser-window-focus', onOtherWindowFocused)

  window.webContents.on('before-input-event', (_event, input) => {
    const wasComposing = composing
    composing = input.isComposing || input.key === 'Process'
    if (wasComposing && !composing && !window.isFocused()) scheduleBlur()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const restrictNavigation = (event: Electron.Event, url: string): void => {
    if (!isTrustedRendererUrl(url, {
      devServerUrl: process.env.ELECTRON_RENDERER_URL,
      rendererIndexPath: RENDERER_INDEX_PATH,
    }) || new URL(url).hash !== '#quick-chat') event.preventDefault()
  }
  window.webContents.on('will-navigate', restrictNavigation)
  window.webContents.on('will-redirect', restrictNavigation)
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const clampToDisplay = (rememberUserChange = false): void => {
    if (window.isDestroyed()) return
    const bounds = window.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const changed = !automaticBounds || bounds.x !== automaticBounds.x || bounds.y !== automaticBounds.y
      || bounds.width !== automaticBounds.width || bounds.height !== automaticBounds.height
    if (rememberUserChange && changed && window.isVisible()) userPositioned = true
    const next = !rememberUserChange && !userPositioned
      ? positionQuickChatBounds(adaptiveQuickChatSize(area), area)
      : clampQuickChatBounds(bounds, area)
    automaticBounds = next
    applyingBounds = true
    try {
      window.setMinimumSize(Math.min(480, area.width), Math.min(320, area.height))
      if (bounds.x !== next.x || bounds.y !== next.y || bounds.width !== next.width || bounds.height !== next.height) window.setBounds(next)
    } finally {
      applyingBounds = false
    }
    if (userPositioned) lastCustomBounds = next
  }
  const onDisplayChanged = (): void => clampToDisplay()
  const onBoundsChanged = (): void => { if (!applyingBounds) clampToDisplay(true) }
  screen.on('display-metrics-changed', onDisplayChanged)
  screen.on('display-removed', onDisplayChanged)
  window.on('move', onBoundsChanged)
  window.on('resize', onBoundsChanged)
  window.on('closed', () => {
    cancelBlur()
    if (reportedVisible) visibilityHandler(false)
    app.removeListener('did-resign-active', onApplicationDeactivated)
    app.removeListener('browser-window-focus', onOtherWindowFocused)
    screen.removeListener('display-metrics-changed', onDisplayChanged)
    screen.removeListener('display-removed', onDisplayChanged)
    unwatchMenus()
    if (quickChatWindow === window) {
      quickChatWindow = null
      readyWindow = null
      visibleRequested = false
    }
  })
  window.once('ready-to-show', () => {
    readyWindow = window
    showQuickChatWindow(window)
  })
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    const url = new URL(devServerUrl)
    url.hash = 'quick-chat'
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(RENDERER_INDEX_PATH, { hash: 'quick-chat' })
  }
}
