import { app, BrowserWindow, Menu, nativeImage, shell } from 'electron'
import { existsSync } from 'fs'
import { basename, join, resolve as resolvePath } from 'path'
import { WorkspaceManager } from './workspace-manager'
import { registerIpcHandlers } from './ipc-handlers'

// Env var honored on startup: if set, the named directory becomes the active
// workspace (created on first run, switched to on subsequent runs). The CLI
// launcher in bin/pi-desktop.js sets this from `pi-desktop <path>`.
const WORKSPACE_ENV_VAR = 'PI_DESKTOP_WORKSPACE'

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

// In dev: resources/ sits at the project root (app.getAppPath()).
// In packaged: extraResources config copies resources/ into process.resourcesPath/resources/.
// Computed lazily: `app` is undefined at module-eval time under electron-vite preview,
// so reading `app.isPackaged` at top level crashes before whenReady().
let cachedAppIconPath: string | null = null
function getAppIconPath(): string {
  if (cachedAppIconPath !== null) return cachedAppIconPath
  const base = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  cachedAppIconPath = join(base, 'icons', 'icon.png')
  return cachedAppIconPath
}

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
    icon: getAppIconPath(),
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
  // Set macOS dock icon (no-op on other platforms)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(getAppIconPath()))
  }

  // Initialize workspace manager
  await workspaceManager.initialize()

  // Honor PI_DESKTOP_WORKSPACE if set: switch to (or create) the named workspace.
  await applyWorkspaceFromEnv(workspaceManager)

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

async function applyWorkspaceFromEnv(manager: WorkspaceManager): Promise<void> {
  const raw = process.env[WORKSPACE_ENV_VAR]
  if (!raw) return

  const path = resolvePath(raw)
  if (!existsSync(path)) {
    console.warn(`[PI Desktop] ${WORKSPACE_ENV_VAR}=${raw} does not exist; ignoring`)
    return
  }

  const existing = manager.getWorkspaces().find((w) => w.path === path)
  if (existing) {
    await manager.setActiveWorkspace(existing.id)
    return
  }

  const name = basename(path) || path
  const created = await manager.createWorkspace(name, path)
  await manager.setActiveWorkspace(created.id)
}
