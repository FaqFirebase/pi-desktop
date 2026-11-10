import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isTrustedRendererUrl, rendererIndexUrl } from './renderer-origin'

const INDEX = '/opt/app/resources/renderer/index.html'
const NATIVE_PROBE_TIMEOUT_MS = 20_000
// windows short names (ZERONO~1) and other chars chromium writes its own way
const AWKWARD_FOLDER_NAMES = ['ZERONO~1', 'a[b]', 'a%41', 'sp ace', '中文用户', "a'b!$&()+,;=@", 'a#b']

test('dev: accepts the dev server origin (any path/hash)', () => {
  const opts = { devServerUrl: 'http://localhost:5173', rendererIndexPath: INDEX }
  assert.equal(isTrustedRendererUrl('http://localhost:5173/', opts), true)
  assert.equal(isTrustedRendererUrl('http://localhost:5173/#/chat', opts), true)
})

test('dev: rejects a look-alike host that only shares a prefix', () => {
  const opts = { devServerUrl: 'http://localhost:5173', rendererIndexPath: INDEX }
  assert.equal(isTrustedRendererUrl('http://localhost:5173.evil.com/', opts), false)
  assert.equal(isTrustedRendererUrl('http://evil.com/localhost:5173', opts), false)
})

test('prod: accepts the packaged index file, ignoring hash routing', () => {
  const opts = { rendererIndexPath: INDEX }
  assert.equal(isTrustedRendererUrl('file:///opt/app/resources/renderer/index.html', opts), true)
  assert.equal(isTrustedRendererUrl('file:///opt/app/resources/renderer/index.html#/settings', opts), true)
})

test('prod: rejects any other local file', () => {
  const opts = { rendererIndexPath: INDEX }
  assert.equal(isTrustedRendererUrl('file:///opt/app/resources/renderer/evil.html', opts), false)
  assert.equal(isTrustedRendererUrl('file:///etc/passwd', opts), false)
})

test('rejects unparseable input', () => {
  assert.equal(isTrustedRendererUrl('not a url', { rendererIndexPath: INDEX }), false)
})

test('prod: the loaded index url passes the check for awkward folder names', () => {
  for (const name of AWKWARD_FOLDER_NAMES) {
    const indexPath = join('/opt', name, 'renderer', 'index.html')
    assert.equal(isTrustedRendererUrl(rendererIndexUrl(indexPath), { rendererIndexPath: indexPath }), true, name)
  }
})

test('native: electron reports the loaded index url as the trusted frame url', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-renderer-origin-'))
  try {
    const indexPaths = AWKWARD_FOLDER_NAMES.map((name) => {
      mkdirSync(join(dir, name))
      const indexPath = join(dir, name, 'index.html')
      writeFileSync(indexPath, '<!doctype html>')
      return indexPath
    })
    const probe = join(dir, 'probe.cjs')
    writeFileSync(probe, `
      const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
      app.on('window-all-closed', () => {});
      app.whenReady().then(async () => {
        const frameUrls = [];
        for (const url of ${JSON.stringify(indexPaths.map(rendererIndexUrl))}) {
          const window = new BrowserWindow({ show: false });
          await window.loadURL(url);
          frameUrls.push(window.webContents.getURL());
          window.destroy();
        }
        process.stdout.write(JSON.stringify(frameUrls));
        app.quit();
      });
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron = createRequire(import.meta.url)('electron') as string
    // ci runners have no root-owned chrome-sandbox, and the probe only loads local files
    const platformArgs = process.platform === 'linux' ? ['--ozone-platform=headless', '--no-sandbox'] : []
    const result = spawnSync(electron, [...platformArgs, probe], {
      env, encoding: 'utf8', timeout: NATIVE_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
    })
    assert.equal(result.error, undefined, `electron probe did not exit: ${result.error?.message}\n${result.stderr}`)
    assert.equal(result.status, 0, result.stderr)
    const frameUrls = JSON.parse(result.stdout) as string[]
    indexPaths.forEach((indexPath, index) => {
      assert.equal(isTrustedRendererUrl(frameUrls[index], { rendererIndexPath: indexPath }), true, frameUrls[index])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
