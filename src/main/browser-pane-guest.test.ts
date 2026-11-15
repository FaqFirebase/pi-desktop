import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  USER_GESTURE_WINDOW_MS,
  browserPaneGuestPreferences,
  browserPanePopupAction,
  isBlockedBrowserPaneRequest,
} from './browser-pane-guest'

test('browser pane guests get our preload and the locked-down flags', () => {
  assert.deepEqual(browserPaneGuestPreferences('/app/out/preload/browser-pane.js'), {
    preload: '/app/out/preload/browser-pane.js', nodeIntegration: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    plugins: false, javascript: true,
  })
})

test('a clicked http/https pop-up opens in the pane', () => {
  assert.equal(browserPanePopupAction('https://a.b/', 0), 'open-in-pane')
  assert.equal(browserPanePopupAction('http://localhost:3000/', USER_GESTURE_WINDOW_MS), 'open-in-pane')
})

test('a pop-up with no recent user click is denied, never opened outside', () => {
  assert.equal(browserPanePopupAction('https://a.b/', USER_GESTURE_WINDOW_MS + 1), 'deny')
  assert.equal(browserPanePopupAction('http://localhost:3000/', Number.POSITIVE_INFINITY), 'deny')
})

test('a pop-up to any other scheme is denied', () => {
  for (const url of ['file:///x', 'javascript:alert(1)', 'data:text/html,x', 'custom://x']) {
    assert.equal(browserPanePopupAction(url, 0), 'deny')
  }
})

test('only main-frame requests outside http/https are blocked', () => {
  assert.equal(isBlockedBrowserPaneRequest('file:///etc/passwd', 'mainFrame'), true)
  assert.equal(isBlockedBrowserPaneRequest('data:text/html,x', 'mainFrame'), true)
  assert.equal(isBlockedBrowserPaneRequest('https://a.b/', 'mainFrame'), false)
  assert.equal(isBlockedBrowserPaneRequest('data:image/png;base64,AA', 'image'), false)
})
