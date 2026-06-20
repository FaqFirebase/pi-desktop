#!/usr/bin/env node
/**
 * Pi Desktop postinstall — runs electron-rebuild for native modules and
 * verifies that Electron's binary was actually placed on disk.
 *
 * Steps:
 *   1. Run electron-builder install-app-deps to rebuild native modules
 *      against Electron's ABI.
 *   2. Verify the Electron binary was actually placed in
 *      node_modules/electron/dist. If the download was silently skipped,
 *      automatically re-run Electron's own install.js. If that still
 *      doesn't work, surface a clear error with next steps.
 *
 * Windows note: node-pty's bundled conpty requires Microsoft's
 * Spectre-mitigated libraries. If the rebuild fails with MSB8040,
 * install the matching Spectre libs from the Visual Studio Installer
 * (Individual components -> search "Spectre"). VS Build Tools 2022
 * stable ships them for the v143 toolset; some newer preview channels
 * with the v180 toolset do not yet, so prefer 2022 stable.
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const IS_WINDOWS = process.platform === 'win32'

function log(msg) {
  console.log(`[postinstall] ${msg}`)
}

function rebuildNativeModules() {
  log('running electron-builder install-app-deps...')
  const result = spawnSync('npx', ['electron-builder', 'install-app-deps'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS,
  })
  if (result.status !== 0) {
    if (IS_WINDOWS) {
      console.error('')
      console.error('[postinstall] native rebuild failed on Windows.')
      console.error('Most common cause: missing Spectre-mitigated libs for node-pty.')
      console.error('Fix: open Visual Studio Installer -> Modify -> Individual components,')
      console.error('search "Spectre", and install the libs for your toolset (v143 is the')
      console.error('VS 2022 stable toolset). Then re-run `npm install`.')
      console.error('')
    }
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

rebuildNativeModules()
verifyElectronBinary()
