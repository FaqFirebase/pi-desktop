#!/usr/bin/env node
/**
 * PI Desktop postinstall — handles the cross-platform sharp edges so a
 * fresh `npm install` actually works without manual intervention.
 *
 * Steps:
 *   1. On Windows: strip SpectreMitigation from node-pty's binding.gyp
 *      so electron-rebuild doesn't fail with MSB8040 on toolsets that
 *      don't ship Microsoft's Spectre-mitigated libraries (e.g. newer
 *      VS Build Tools releases like 17.14.x with the v180 toolset).
 *   2. Run electron-builder install-app-deps to rebuild native modules
 *      against Electron's ABI.
 *   3. Verify the Electron binary was actually placed in
 *      node_modules/electron/dist. If the download was silently skipped,
 *      automatically re-run Electron's own install.js. If that still
 *      doesn't work, surface a clear error with next steps.
 */

const { execSync, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const IS_WINDOWS = process.platform === 'win32'

function log(msg) {
  console.log(`[postinstall] ${msg}`)
}

function patchNodePtyForWindows() {
  if (!IS_WINDOWS) return

  const bindingPath = path.join(ROOT, 'node_modules', 'node-pty', 'binding.gyp')
  if (!fs.existsSync(bindingPath)) {
    log('node-pty binding.gyp not found, skipping Spectre patch')
    return
  }

  const original = fs.readFileSync(bindingPath, 'utf-8')
  const patched = original.replace(/,?\s*"SpectreMitigation"\s*:\s*"[^"]*"/g, '')

  if (original === patched) {
    log('node-pty already patched (or no SpectreMitigation directive present)')
    return
  }

  fs.writeFileSync(bindingPath, patched, 'utf-8')
  log('patched node-pty/binding.gyp to drop SpectreMitigation requirement')
  log('  (this allows building on Windows toolsets that ship without Spectre libs)')
  log('  (release builds should be done on a system with Spectre libs installed)')
}

function rebuildNativeModules() {
  log('running electron-builder install-app-deps...')
  const result = spawnSync('npx', ['electron-builder', 'install-app-deps'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS,
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function verifyElectronBinary() {
  const pathTxt = path.join(ROOT, 'node_modules', 'electron', 'path.txt')
  const distDir = path.join(ROOT, 'node_modules', 'electron', 'dist')

  if (fs.existsSync(pathTxt) && fs.existsSync(distDir)) {
    log('electron binary present')
    return
  }

  log('electron binary missing — re-running electron/install.js')
  const installJs = path.join(ROOT, 'node_modules', 'electron', 'install.js')
  if (!fs.existsSync(installJs)) {
    console.error('[postinstall] electron package not installed at all; run `npm install electron` and retry')
    process.exit(1)
  }

  const result = spawnSync(process.execPath, [installJs], {
    cwd: path.dirname(installJs),
    stdio: 'inherit',
  })

  if (result.status !== 0 || !fs.existsSync(pathTxt)) {
    console.error('')
    console.error('[postinstall] electron binary still missing after install.js retry.')
    console.error('Common causes:')
    console.error('  - Antivirus blocking the extraction (add the repo and ~/AppData/Local/electron to exclusions)')
    console.error('  - Corporate proxy blocking github.com (set ELECTRON_MIRROR to your internal mirror)')
    console.error('  - Disk space or permission issues')
    console.error('')
    console.error('Manual recovery:')
    console.error('  cd node_modules/electron && node install.js')
    process.exit(1)
  }

  log('electron binary downloaded and extracted')
}

patchNodePtyForWindows()
rebuildNativeModules()
verifyElectronBinary()
