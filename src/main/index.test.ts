import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createEditorGuard } from './editor-guard'
import { createAppShutdown } from './app-shutdown'

function quitEvent(): { defaultPrevented: boolean; preventDefault(): void } {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
}

// The lifecycle under test is the real app-shutdown.ts module, wired to a
// fake `app` that mirrors Electron's quit sequence: before-quit may prevent;
// the renderer closes; will-quit may prevent; exit completes. The fake app
// records every transition so the tests can assert the exact production order
// (popup destroy synchronously in before-quit, drain in will-quit, final
// teardown after the drain) without extracting source text from index.ts.
function setup(stopAll?: () => Promise<void>) {
  const calls: string[] = []
  let rendererOpen = true
  let exited = false
  let quitting = false
  let resolveExit!: () => void
  const exit = new Promise<void>((resolve) => { resolveExit = resolve })
  const app = Object.assign(new EventEmitter(), {
    quit() {
      const before = quitEvent()
      app.emit('before-quit', before)
      if (before.defaultPrevented) return
      if (rendererOpen) {
        rendererOpen = false
        calls.push('close-renderer')
      }
      const will = quitEvent()
      app.emit('will-quit', will)
      if (!will.defaultPrevented) {
        exited = true
        resolveExit()
      }
    },
  })
  let finish!: () => void
  let fail!: (error: Error) => void
  const pending = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
  const editorGuard = createEditorGuard()
  let discard = false
  const appShutdown = createAppShutdown({
    app,
    isQuitting: () => quitting,
    setQuitting: (value: boolean) => { quitting = value; calls.push('mark-quitting') },
    editorGuard,
    confirmEditorDiscard: async () => { calls.push('confirm'); return discard },
    getMainWindow: () => null,
    destroyAuxWindows: () => calls.push('destroy-quick-chat'),
    stopAll: stopAll ?? (() => { calls.push('stop-all'); return pending }),
    warnShutdown: () => { calls.push('warn') },
    finalizeTeardown: () => {
      calls.push('destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp')
    },
  })
  appShutdown.wire()
  return {
    app, calls, finish, fail, editorGuard, exit,
    discard: () => { discard = true },
    isQuitting: () => quitting,
    rendererOpen: () => rendererOpen,
    exited: () => exited,
  }
}

test('one native macOS quit exits even when shutdown resolves immediately', {
  skip: process.platform !== 'darwin',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-native-quit-'))
  try {
    const probe = join(dir, 'quit.cjs')
    const require = createRequire(import.meta.url)
    const tsxRegister = require.resolve('tsx/cjs')
    const appShutdownPath = fileURLToPath(new URL('./app-shutdown.ts', import.meta.url))
    writeFileSync(probe, `
      const { app, BrowserWindow, Menu } = require('electron');
      const assert = require('node:assert/strict');
      app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
      // Load the real lifecycle module (TypeScript) inside Electron via tsx's
      // require hook, exactly as the unit harness exercises it.
      require(${JSON.stringify(tsxRegister)});
      const { createAppShutdown } = require(${JSON.stringify(appShutdownPath)});
      const calls = [];
      let quitting = false;
      const appShutdown = createAppShutdown({
        app,
        isQuitting: () => quitting,
        setQuitting: (value) => { quitting = value },
        editorGuard: { needsPrompt: () => false },
        confirmEditorDiscard: async () => true,
        getMainWindow: () => null,
        destroyAuxWindows: () => calls.push('destroy-quick-chat'),
        stopAll: () => { calls.push('stop-all'); },
        warnShutdown: () => calls.push('warn'),
        finalizeTeardown: () => {
          calls.push('destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp');
        },
      });
      appShutdown.wire();
      app.on('quit', () => {
        assert.deepEqual(calls, [
          'destroy-quick-chat', 'close-renderer', 'stop-all',
          'destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp',
        ]);
        process.stdout.write('quit-complete');
      });
      app.whenReady().then(async () => {
        Menu.setApplicationMenu(Menu.buildFromTemplate([
          { label: 'App', submenu: [{ role: 'quit' }] }
        ]));
        const mainWindow = new BrowserWindow({ show: false });
        mainWindow.on('closed', () => calls.push('close-renderer'));
        await mainWindow.loadURL('about:blank');
        setImmediate(() => Menu.sendActionToFirstResponder('terminate:'));
      });
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron = require('electron') as string
    const result = spawnSync(electron, [probe], {
      env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
    })
    assert.equal(result.error, undefined, `native quit did not exit: ${result.error?.message}\n${result.stdout}\n${result.stderr}`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'quit-complete')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a single quit closes the renderer, drains pending writes and exits', { timeout: 1000 }, async () => {
  const state = setup()
  state.app.quit()
  // The quick-chat popup is destroyed synchronously in before-quit, before the
  // renderer closes and the workspace drain starts.
  assert.deepEqual(state.calls, ['mark-quitting', 'destroy-quick-chat', 'close-renderer', 'stop-all'])
  assert.equal(state.rendererOpen(), false)
  assert.equal(state.exited(), false)

  state.finish()
  await state.exit
  assert.equal(state.exited(), true, 'no second user quit should be needed')
  assert.deepEqual(state.calls, [
    'mark-quitting', 'destroy-quick-chat', 'close-renderer', 'stop-all',
    'destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp',
  ])
})

test('repeated quits share the drain and cannot reopen the window during shutdown', { timeout: 1000 }, async () => {
  const state = setup()
  state.app.quit()
  state.app.quit()
  // The second quit must not re-destroy the popup or start a second drain.
  assert.deepEqual(state.calls, ['mark-quitting', 'destroy-quick-chat', 'close-renderer', 'stop-all'])
  assert.equal(state.isQuitting(), true, 'a real quit must be in progress')
  assert.equal(state.exited(), false)

  state.finish()
  await state.exit
  assert.equal(state.exited(), true)
  assert.deepEqual(state.calls, [
    'mark-quitting', 'destroy-quick-chat', 'close-renderer', 'stop-all',
    'destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp',
  ])
})

test('cancelled unsaved-edit confirmation leaves the renderer and workspaces intact', { timeout: 1000 }, async () => {
  const state = setup()
  state.editorGuard.setDirty(true, 'code.ts')
  state.app.quit()
  await setImmediate()
  assert.deepEqual(state.calls, ['confirm'])
  assert.equal(state.rendererOpen(), true)
  assert.equal(state.exited(), false)
  assert.equal(state.isQuitting(), false, 'cancel must not mark the app as quitting')

  state.discard()
  state.app.quit()
  await setImmediate()
  // Second prompt confirms, then the quit proceeds: popup destroyed in
  // before-quit, renderer closed, drain started.
  assert.deepEqual(state.calls.slice(-4), ['mark-quitting', 'destroy-quick-chat', 'close-renderer', 'stop-all'])
  state.finish()
  await state.exit
  assert.equal(state.exited(), true)
})

test('a failed shutdown flush is logged and does not require another quit', { timeout: 1000 }, async () => {
  const state = setup()
  state.app.quit()
  state.fail(new Error('write failed'))
  await state.exit
  assert.equal(state.exited(), true)
  assert.deepEqual(state.calls, [
    'mark-quitting', 'destroy-quick-chat', 'close-renderer', 'stop-all', 'warn',
    'destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp',
  ])
})

test('a synchronous shutdown failure is logged and does not hang the quit', { timeout: 1000 }, async () => {
  const state = setup(() => { throw new Error('stop failed') })
  state.app.quit()
  await state.exit
  assert.equal(state.exited(), true)
  assert.deepEqual(state.calls, [
    'mark-quitting', 'destroy-quick-chat', 'close-renderer', 'warn',
    'destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp',
  ])
})
