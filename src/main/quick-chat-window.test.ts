import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { before, test } from 'node:test'
import { RENDERER_INDEX_URL } from './renderer-origin'
import type { WindowRectangle } from './quick-chat-window-behavior'
import type * as PopupModule from './quick-chat-window'

const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const electronModule = require.cache[electronPath]!
const originalExports = electronModule.exports
const switches = new Map<string, string>()
const windows: PopupWindow[] = []
const area = { x: 0, y: 0, width: 1280, height: 800 }

class PopupWindow extends EventEmitter {
  static getFocusedWindow(): PopupWindow | null { return null }
  readonly webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: () => {}, focus: () => {},
  })
  readonly urls: string[] = []
  visible = false
  destroyed = false
  shows = 0
  bounds: WindowRectangle
  constructor(options: WindowRectangle) {
    super()
    this.bounds = options
    windows.push(this)
  }
  isDestroyed(): boolean { return this.destroyed }
  isVisible(): boolean { return this.visible }
  isFocused(): boolean { return this.visible }
  getParentWindow(): null { return null }
  getBounds(): WindowRectangle { return this.bounds }
  setBounds(bounds: WindowRectangle): void { this.bounds = bounds }
  setMinimumSize(): void {}
  setMenuBarVisibility(): void {}
  setVisibleOnAllWorkspaces(): void {}
  focus(): void {}
  show(): void { this.visible = true; this.shows++; this.emit('show') }
  hide(): void { this.visible = false; this.emit('hide') }
  destroy(): void { this.destroyed = true; this.emit('closed') }
  async loadURL(url: string): Promise<void> { this.urls.push(url) }
}

const app = Object.assign(new EventEmitter(), {
  commandLine: { getSwitchValue: (name: string) => switches.get(name) ?? '' },
  dock: { isVisible: () => true },
})
const screen = Object.assign(new EventEmitter(), {
  getDisplayNearestPoint: () => ({ workArea: area }),
  getDisplayMatching: () => ({ workArea: area }),
  getCursorScreenPoint: () => ({ x: 100, y: 100 }),
})
electronModule.exports = { app, screen, BrowserWindow: PopupWindow, Menu: { getApplicationMenu: () => null } }
// The actual window module must bind Electron only after the native boundary stub.
let popup: typeof PopupModule
before(async () => { popup = await import('./quick-chat-window') })

function reset(): void {
  popup.destroyQuickChatWindow()
  popup.setQuickChatQuittingHandler(() => false)
  popup.setQuickChatVisibilityHandler(() => {})
  switches.clear()
  windows.length = 0
}

test('production popup loads the canonical trusted URL and waits for readiness', (t) => {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  delete process.env.ELECTRON_RENDERER_URL
  t.after(() => {
    reset()
    if (devUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = devUrl
    electronModule.exports = originalExports
  })
  popup.openQuickChatWindow()
  const window = windows[0]
  assert.deepEqual(window.urls, [`${RENDERER_INDEX_URL}#quick-chat`])
  assert.equal(window.shows, 0)
  popup.hideQuickChatWindow()
  window.emit('ready-to-show')
  assert.equal(window.shows, 0, 'readiness cannot resurrect a hidden popup')
  popup.openQuickChatWindow()
  assert.equal(window.shows, 1)
  window.emit('ready-to-show')
  assert.equal(window.shows, 1, 'native readiness is consumed only once')
  const navigation = (url: string): boolean => {
    let prevented = false
    window.webContents.emit('will-navigate', { preventDefault: () => { prevented = true } }, url)
    return prevented
  }
  assert.equal(navigation(`${RENDERER_INDEX_URL}#quick-chat`), false)
  assert.equal(navigation(`${RENDERER_INDEX_URL}#main`), true)
  assert.equal(navigation('https://untrusted.example/#quick-chat'), true)
})

test('Wayland load readiness is first-wins and pinning remains unavailable unless X11 is explicit', (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const display = process.env.WAYLAND_DISPLAY
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  process.env.WAYLAND_DISPLAY = 'wayland-0'
  t.after(() => {
    reset()
    Object.defineProperty(process, 'platform', platform)
    if (display === undefined) delete process.env.WAYLAND_DISPLAY
    else process.env.WAYLAND_DISPLAY = display
  })
  popup.setQuickChatPinned(true)
  assert.equal(popup.canPinQuickChatWindow(), false)
  assert.equal(popup.isQuickChatPinned(), false)
  popup.openQuickChatWindow()
  const window = windows[0]
  window.webContents.emit('did-finish-load')
  assert.equal(window.shows, 1)
  window.emit('ready-to-show')
  assert.equal(window.shows, 1)
  popup.destroyQuickChatWindow()
  popup.openQuickChatWindow()
  const hidden = windows[1]
  popup.hideQuickChatWindow()
  hidden.webContents.emit('did-finish-load')
  hidden.emit('ready-to-show')
  assert.equal(hidden.shows, 0)
  popup.destroyQuickChatWindow()
  switches.set('ozone-platform', 'x11')
  assert.equal(popup.canPinQuickChatWindow(), true)
  popup.setQuickChatPinned(true)
  assert.equal(popup.isQuickChatPinned(), true)
  popup.openQuickChatWindow()
  const x11 = windows[2]
  x11.webContents.emit('did-finish-load')
  assert.equal(x11.shows, 0, 'X11 waits for native readiness rather than the Wayland fallback')
  x11.emit('ready-to-show')
  assert.equal(x11.shows, 1)
})
