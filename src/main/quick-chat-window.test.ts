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
const windows: PopupWindow[] = []
const area = { x: 0, y: 0, width: 1280, height: 800 }

class PopupWindow extends EventEmitter {
  static getFocusedWindow(): PopupWindow | null { return null }
  readonly webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: () => {}, focus: () => {},
  })
  readonly urls: string[] = []
  visible = false
  focused = true
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
  isFocused(): boolean { return this.visible && this.focused }
  getBounds(): WindowRectangle { return this.bounds }
  setBounds(bounds: WindowRectangle): void { this.bounds = bounds }
  setMinimumSize(): void {}
  setMenuBarVisibility(): void {}
  focus(): void { this.focused = true }
  show(): void { this.visible = true; this.shows++; this.emit('show') }
  hide(): void { this.visible = false; this.emit('hide') }
  destroy(): void { this.destroyed = true; this.emit('closed') }
  async loadURL(url: string): Promise<void> { this.urls.push(url) }
}

const screen = Object.assign(new EventEmitter(), {
  getDisplayNearestPoint: () => ({ workArea: area }),
  getDisplayMatching: () => ({ workArea: area }),
  getCursorScreenPoint: () => ({ x: 100, y: 100 }),
})
electronModule.exports = { screen, BrowserWindow: PopupWindow }
// The actual window module must bind Electron only after the native boundary stub.
let popup: typeof PopupModule
before(async () => { popup = await import('./quick-chat-window') })

function reset(): void {
  popup.destroyQuickChatWindow()
  popup.setQuickChatQuittingHandler(() => false)
  popup.setQuickChatVisibilityHandler(() => {})
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

test('load readiness is first-wins on every platform and respects hide', (t) => {
  t.after(reset)
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
})

test('the popup is an ordinary window: focus loss never hides it, and the shortcut raises it from behind', (t) => {
  t.after(reset)
  popup.openQuickChatWindow()
  const window = windows[0]
  window.emit('ready-to-show')
  window.focused = false
  window.emit('blur')
  assert.equal(window.isVisible(), true, 'a click outside leaves the popup open')
  popup.toggleQuickChatWindow()
  assert.equal(window.isVisible(), true, 'the shortcut brings a popup behind other windows to the front')
  assert.equal(window.isFocused(), true)
  popup.toggleQuickChatWindow()
  assert.equal(window.isVisible(), false, 'the shortcut hides a popup that is in front')
})
