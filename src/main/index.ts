import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'path'
import { WorkspaceManager } from './workspace-manager'
import { registerIpcHandlers } from './ipc-handlers'

// Suppress EPIPE errors from closed subprocess pipes
process.on('uncaughtException', (err) => {
  if (err.message?.includes('EPIPE') || (err as NodeJS.ErrnoException).code === 'EPIPE') {
    // Ignore EPIPE - happens when PI process exits
    return
  }
  console.error('Uncaught exception:', err)
})

// ─── Constants ───────────────────────────────────────────────────────────────

const WINDOW_WIDTH = 1400
const WINDOW_HEIGHT = 900
const MIN_WINDOW_WIDTH = 800
const MIN_WINDOW_HEIGHT = 600
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL
const PRELOAD_PATH = join(__dirname, '../preload/index.js')

// ─── Workspace Manager (singleton) ───────────────────────────────────────────

const workspaceManager = new WorkspaceManager()

// ─── Window Creation ─────────────────────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'PI Desktop',
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  })

  // Graceful show (avoid white flash)
  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })

  // Open external links in default browser
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Block navigation to external URLs
  window.webContents.on('will-navigate', (event, url) => {
    if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return
    if (!DEV_SERVER_URL && url.startsWith('file://')) return
    event.preventDefault()
  })

  // Load renderer
  if (DEV_SERVER_URL) {
    window.loadURL(DEV_SERVER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Dev tools in development
  if (process.env.NODE_ENV === 'development') {
    window.webContents.openDevTools({ mode: 'detach' })
  }

  return window
}

// ─── Application Menu ────────────────────────────────────────────────────────

function createApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow()
            focusedWindow?.webContents.send('menu:new-session')
          },
        },
        {
          label: 'New Workspace...',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow()
            focusedWindow?.webContents.send('menu:new-workspace')
          },
        },
        {
          label: 'Open Project...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow()
            focusedWindow?.webContents.send('menu:open-project')
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Initialize workspace manager
  await workspaceManager.initialize()

  // Register IPC handlers before creating windows
  registerIpcHandlers(workspaceManager)

  // Create application menu
  createApplicationMenu()

  // Create main window
  createMainWindow()

  // macOS: re-create window when dock icon clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

// Quit when all windows closed (except macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Cleanup on quit
app.on('before-quit', () => {
  workspaceManager.stopAll()
})

// Security: prevent new window creation
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })
})
