import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

// Exercise the mounted production component in Chromium, rather than extracting
// individual handlers from its source. Uses the same isolated native boundary
// as main/renderer-origin.test.ts; no preload, agent, or network is needed.
test('the shared model picker preserves selection, focus and session isolation in both engines', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-model-selector-'))
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: dir,
        emptyOutDir: false,
        lib: {
          entry: fileURLToPath(new URL('./model-selector.test-fixture.tsx', import.meta.url)),
          formats: ['iife'], name: 'ModelSelectorProbe', fileName: () => 'probe.js',
        },
      },
    })
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div><script src="probe.js"></script>')
    writeFileSync(join(dir, 'main.cjs'), `
      const { app, BrowserWindow, session } = require('electron');
      app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
      app.whenReady().then(async () => {
        session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
          (_details, callback) => callback({ cancel: true }));
        const window = new BrowserWindow({ show: false,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
        try {
          await window.loadFile(${JSON.stringify(join(dir, 'index.html'))});
          const results = await window.webContents.executeJavaScript('ModelSelectorProbe.run()');
          require('fs').writeFileSync(${JSON.stringify(join(dir, 'results.json'))}, JSON.stringify(results));
          app.exit(results.every(result => !result.error) ? 0 : 1);
        } catch (error) { console.error(error); app.exit(1); }
      });
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron = createRequire(import.meta.url)('electron') as string
    const platformArgs = process.platform === 'linux' ? ['--ozone-platform=headless', '--no-sandbox'] : []
    const result = spawnSync(electron, [...platformArgs, join(dir, 'main.cjs')], {
      env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    })
    assert.equal(result.error, undefined, `${result.error?.message}\n${result.stderr}`)
    const results = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')) as Array<{ name: string; error?: string }>
    assert.equal(results.length, 10)
    for (const scenario of results) {
      await t.test(scenario.name, () => assert.equal(scenario.error, undefined))
    }
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
