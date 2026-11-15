import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BROWSER_PANE_KEY_BINDINGS,
  browserPaneKeyAction,
  isBrowserPaneUrl,
  nextZoomLevel,
  normalizeAddressInput,
  normalizeBrowserPaneUrls,
} from './browser-pane'
import { DEFAULT_KEYBOARD_SHORTCUTS, type ShortcutKeyEvent } from './keyboard-shortcuts'

test('normalizeAddressInput adds http:// to localhost, host:port and loopback literals', () => {
  assert.equal(normalizeAddressInput('localhost'), 'http://localhost/')
  assert.equal(normalizeAddressInput('  localhost:5173  '), 'http://localhost:5173/')
  assert.equal(normalizeAddressInput('127.0.0.1:3000/x?y=1'), 'http://127.0.0.1:3000/x?y=1')
  assert.equal(normalizeAddressInput('[::1]:8080'), 'http://[::1]:8080/')
  assert.equal(normalizeAddressInput('dev.box:8000'), 'http://dev.box:8000/')
})

test('normalizeAddressInput adds https:// to a bare domain with no port', () => {
  assert.equal(normalizeAddressInput('example.com/docs'), 'https://example.com/docs')
})

test('normalizeAddressInput keeps http and https URLs', () => {
  assert.equal(normalizeAddressInput('https://example.com'), 'https://example.com/')
  assert.equal(normalizeAddressInput('HTTP://Example.com/a'), 'http://example.com/a')
})

test('normalizeAddressInput refuses other schemes and junk', () => {
  for (const input of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://gpu',
    'about:blank', 'mailto:a@b.c', 'vscode://x', '', '   ', 'two words', 'http://']) {
    assert.equal(normalizeAddressInput(input), null, input)
  }
})

test('isBrowserPaneUrl accepts only http and https', () => {
  assert.equal(isBrowserPaneUrl('https://a.b/'), true)
  assert.equal(isBrowserPaneUrl('http://localhost:1/'), true)
  assert.equal(isBrowserPaneUrl('file:///x'), false)
  assert.equal(isBrowserPaneUrl('not a url'), false)
})

test('pane keys map to actions on both platforms', () => {
  const key = (code: string, extra: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent =>
    ({ key: '', code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra })
  assert.equal(browserPaneKeyAction(key('KeyR', { ctrlKey: true }), 'linux'), 'reload')
  assert.equal(browserPaneKeyAction(key('KeyR', { metaKey: true }), 'darwin'), 'reload')
  assert.equal(browserPaneKeyAction(key('KeyL', { ctrlKey: true }), 'win32'), 'focusAddress')
  assert.equal(browserPaneKeyAction(key('Equal', { ctrlKey: true }), 'linux'), 'zoomIn')
  assert.equal(browserPaneKeyAction(key('Equal', { ctrlKey: true, shiftKey: true }), 'linux'), 'zoomIn')
  assert.equal(browserPaneKeyAction(key('Minus', { ctrlKey: true }), 'linux'), 'zoomOut')
  assert.equal(browserPaneKeyAction(key('Digit0', { ctrlKey: true }), 'linux'), 'zoomReset')
  assert.equal(browserPaneKeyAction(key('KeyR'), 'linux'), null)
  assert.equal(browserPaneKeyAction(key('KeyR', { ctrlKey: true, isComposing: true }), 'linux'), null)
})

test('no pane key equals a default app shortcut', () => {
  for (const { binding } of BROWSER_PANE_KEY_BINDINGS) {
    for (const app of Object.values(DEFAULT_KEYBOARD_SHORTCUTS)) assert.notEqual(app, binding)
  }
})

test('nextZoomLevel steps and stays in bounds', () => {
  assert.equal(nextZoomLevel(0, 'zoomIn'), 0.5)
  assert.equal(nextZoomLevel(0, 'zoomOut'), -0.5)
  assert.equal(nextZoomLevel(4, 'zoomIn'), 4)
  assert.equal(nextZoomLevel(-4, 'zoomOut'), -4)
  assert.equal(nextZoomLevel(2.5, 'zoomReset'), 0)
})

test('normalizeBrowserPaneUrls keeps only string keys with http/https values', () => {
  assert.deepEqual(normalizeBrowserPaneUrls({ '/a': 'https://a.b/', '/b': 'file:///x', '/c': 3 }), { '/a': 'https://a.b/' })
  assert.deepEqual(normalizeBrowserPaneUrls(null), {})
  assert.deepEqual(normalizeBrowserPaneUrls(['https://a.b/']), {})
})
