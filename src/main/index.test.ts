import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { createEditorGuard } from './editor-guard'

// Share the actual lifecycle wiring between the unit harness and native Electron probe.
const source = ts.createSourceFile(
  'index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
)
const lifecycle = source.statements.filter((node) => {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.some((declaration) =>
      ['isQuitting', 'shutdownPending', 'shutdownComplete'].includes(declaration.name.getText(source)))
  }
  if (ts.isFunctionDeclaration(node)) return node.name?.text === 'showMainWindow'
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false
  const call = node.expression
  return call.expression.getText(source) === 'app.on'
    && ts.isStringLiteral(call.arguments[0])
    && ['before-quit', 'will-quit', 'window-all-closed'].includes(call.arguments[0].text)
}).map((node) => node.getText(source)).join('\n')

function quitEvent(): { defaultPrevented: boolean; preventDefault(): void } {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
}

function setup(stopAll?: () => Promise<void>) {
  const calls: string[] = []
  let rendererOpen = true
  let exited = false
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
  const bindings = {
    app,
    process: { platform: 'darwin' },
    mainWindow: null,
    createMainWindow: () => { calls.push('create-window') },
    workspaceManager: { stopAll: stopAll ?? (() => { calls.push('stop-all'); return pending }) },
    workspaceTerminals: { stopAll: () => { calls.push('stop-terminals') } },
    editorGuard,
    confirmEditorDiscard: async () => { calls.push('confirm'); return discard },
    destroyTray: () => { calls.push('destroy-tray') },
    globalShortcut: { unregisterAll: () => { calls.push('release-shortcuts') } },
    activityStatsStore: { flushSync: () => { calls.push('flush-stats') } },
    appLog: {
      warn: () => { calls.push('warn') },
      flushSync: () => { calls.push('flush-log') },
    },
    cleanupPiChildTempDir: () => { calls.push('cleanup-temp') },
  }
  const code = ts.transpile(lifecycle, { target: ts.ScriptTarget.ES2022 })
  const showMainWindow = new Function(...Object.keys(bindings), `${code}; return showMainWindow`)(
    ...Object.values(bindings),
  ) as () => void
  return {
    app, calls, finish, fail, editorGuard, showMainWindow, exit,
    discard: () => { discard = true },
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
    writeFileSync(probe, `
      const { app, BrowserWindow, globalShortcut, Menu } = require('electron');
      const assert = require('node:assert/strict');
      app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
      const calls = [];
      let mainWindow;
      const editorGuard = { needsPrompt: () => false };
      const workspaceManager = {
        stopAll: () => { calls.push('stop-all'); }
      };
      const workspaceTerminals = { stopAll: () => calls.push('stop-terminals') };
      const destroyTray = () => calls.push('destroy-tray');
      const activityStatsStore = { flushSync: () => calls.push('flush-stats') };
      const appLog = {
        warn: () => calls.push('warn'),
        flushSync: () => calls.push('flush-log')
      };
      const cleanupPiChildTempDir = () => calls.push('cleanup-temp');
      ${ts.transpile(lifecycle, { target: ts.ScriptTarget.ES2022 })}
      app.on('quit', () => {
        assert.deepEqual(calls, [
          'close-renderer', 'stop-all', 'destroy-tray', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp'
        ]);
        process.stdout.write('quit-complete');
      });
      app.whenReady().then(async () => {
        Menu.setApplicationMenu(Menu.buildFromTemplate([
          { label: 'App', submenu: [{ role: 'quit' }] }
        ]));
        mainWindow = new BrowserWindow({ show: false });
        mainWindow.on('closed', () => calls.push('close-renderer'));
        await mainWindow.loadURL('about:blank');
        setImmediate(() => Menu.sendActionToFirstResponder('terminate:'));
      });
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron = createRequire(import.meta.url)('electron') as string
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
  assert.deepEqual(state.calls, ['close-renderer', 'stop-all'])
  assert.equal(state.rendererOpen(), false)
  assert.equal(state.exited(), false)

  state.finish()
  await state.exit
  assert.equal(state.exited(), true, 'no second user quit should be needed')
  assert.deepEqual(state.calls, [
    'close-renderer', 'stop-all', 'destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp',
  ])
})

test('repeated quits share the drain and cannot reopen the window during shutdown', { timeout: 1000 }, async () => {
  const state = setup()
  state.app.quit()
  state.app.quit()
  state.showMainWindow()
  assert.deepEqual(state.calls, ['close-renderer', 'stop-all'])
  assert.equal(state.exited(), false)

  state.finish()
  await state.exit
  assert.equal(state.exited(), true)
  assert.deepEqual(state.calls, [
    'close-renderer', 'stop-all', 'destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp',
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
  state.showMainWindow()
  assert.equal(state.calls.at(-1), 'create-window', 'cancel must not mark the app as quitting')

  state.discard()
  state.app.quit()
  await setImmediate()
  assert.deepEqual(state.calls.slice(-3), ['confirm', 'close-renderer', 'stop-all'])
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
    'close-renderer', 'stop-all', 'warn', 'destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp',
  ])
})

test('a synchronous shutdown failure is logged and does not hang the quit', { timeout: 1000 }, async () => {
  const state = setup(() => { throw new Error('stop failed') })
  state.app.quit()
  await state.exit
  assert.equal(state.exited(), true)
  assert.deepEqual(state.calls, [
    'close-renderer', 'warn', 'destroy-tray', 'release-shortcuts', 'flush-stats', 'flush-log', 'stop-terminals', 'cleanup-temp',
  ])
})
