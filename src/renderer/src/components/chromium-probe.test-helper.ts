import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'vite'

// Exercise mounted production components in Chromium, rather than extracting
// individual handlers from their source. Uses the same isolated native boundary
// as main/renderer-origin.test.ts; no preload, agent, or network is needed.

export interface ChromiumProbeResult {
  name: string
  error?: string
}

export interface ChromiumProbeRun {
  results: ChromiumProbeResult[]
  status: number | null
  stderr: string
  error?: Error
}

const PROBE_TIMEOUT_MS = 30_000
const PROBE_TEMP_PREFIX = 'pi-chromium-probe-'
const PROBE_SCRIPT = 'probe.js'
const RESULTS_FILE = 'results.json'
const EMPTY_MODULE_SOURCE = 'export {}'

/**
 * Probes never start a worker. Building the real voice worker pulls in the
 * speech libraries and took the composer probe from under 1 GB to 5.8 GB, so
 * every module of a worker build becomes an empty one.
 */
const emptyWorkerBuild: Plugin = {
  name: 'probe-empty-worker',
  enforce: 'pre',
  load: () => EMPTY_MODULE_SOURCE,
}

/**
 * Bundle `fixture` (a module exporting `run(): Promise<ChromiumProbeResult[]>`)
 * under the global `globalName`, run it in a hidden sandboxed Electron window
 * with all network requests blocked, and return its scenario results.
 */
export async function runChromiumProbe(fixture: URL, globalName: string): Promise<ChromiumProbeRun> {
  const dir = mkdtempSync(join(tmpdir(), PROBE_TEMP_PREFIX))
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      // The probe page is one IIFE script; a module worker it imports (voice) builds as its own, empty, ES file.
      worker: { format: 'es', plugins: () => [emptyWorkerBuild] },
      build: {
        outDir: dir,
        emptyOutDir: false,
        lib: {
          entry: fileURLToPath(fixture),
          formats: ['iife'], name: globalName, fileName: () => PROBE_SCRIPT,
        },
      },
    })
    const resultsPath = join(dir, RESULTS_FILE)
    // The bundle keeps non-ASCII source text (Unicode regex ranges), so the page must read it as UTF-8.
    writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><div id="root"></div><script src="${PROBE_SCRIPT}"></script>`)
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
          const results = await window.webContents.executeJavaScript(${JSON.stringify(`${globalName}.run()`)});
          require('fs').writeFileSync(${JSON.stringify(resultsPath)}, JSON.stringify(results));
          app.exit(results.every(result => !result.error) ? 0 : 1);
        } catch (error) { console.error(error); app.exit(1); }
      });
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron = createRequire(import.meta.url)('electron') as string
    const platformArgs = process.platform === 'linux' ? ['--ozone-platform=headless', '--no-sandbox'] : []
    const result = spawnSync(electron, [...platformArgs, join(dir, 'main.cjs')], {
      env, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
    })
    let results: ChromiumProbeResult[] = []
    try {
      results = JSON.parse(readFileSync(resultsPath, 'utf8')) as ChromiumProbeResult[]
    } catch {
      // No results file: the window failed before the probe ran; `stderr` says why.
    }
    return { results, status: result.status, stderr: result.stderr, error: result.error }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
