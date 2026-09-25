import { resolve, basename } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync, copyFileSync, mkdirSync, existsSync } from 'fs'
import type { Plugin } from 'vite'

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

// The voice engines (transformers.js and parakeet.js) run onnxruntime-web,
// which loads its WebAssembly runtime by URL. Ship those files with the
// renderer under `voice-wasm/` and serve them in dev, so speech-to-text works
// offline without fetching WASM from a CDN (which the locked CSP forbids).
const ORT_DIST = resolve(__dirname, 'node_modules/onnxruntime-web/dist')
const VOICE_WASM_DIR = 'voice-wasm'

// Only the runtime builds the engines load. parakeet.js uses the shared
// onnxruntime-web bundle, which loads the JSEP build (WebGPU + WASM);
// transformers.js carries its own copy of the same version, which loads the
// asyncify build. The other builds in the package (about 100 MB) are unused.
const ORT_RUNTIME_FILES = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
]

// Both engine bundles also point at their .wasm next to themselves, so the
// bundler emits a second copy (about 55 MB). The engines load from
// `voice-wasm/` instead (their wasmPaths), so those copies are dropped.
const BUNDLED_ORT_WASM = /(^|\/)ort-wasm-[\w.-]+\.wasm$/

function ortWasmAssets(): { name: string; path: string }[] {
  return ORT_RUNTIME_FILES.map((file) => {
    const path = resolve(ORT_DIST, file)
    // Fail the build rather than ship voice dictation that cannot start.
    if (!existsSync(path)) throw new Error(`onnxruntime-web runtime file missing: ${path}`)
    return { name: file, path }
  })
}

/** Drop the bundler's unused copies of the onnxruntime .wasm files. */
function dropBundledOrtWasmPlugin(): Plugin {
  return {
    name: 'pi-drop-bundled-ort-wasm',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (BUNDLED_ORT_WASM.test(fileName)) delete bundle[fileName]
      }
    },
  }
}

function voiceWasmPlugin(): Plugin {
  const assets = ortWasmAssets()
  return {
    name: 'pi-voice-wasm',
    // Dev: serve the runtime files straight from node_modules.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        const match = assets.find((asset) => url.includes(`${VOICE_WASM_DIR}/${asset.name}`))
        if (!match) return next()
        res.setHeader('Content-Type', match.name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        res.end(readFileSync(match.path))
      })
    },
    // Build: copy them next to the bundled renderer.
    writeBundle(options) {
      const outDir = options.dir ?? resolve(__dirname, 'out/renderer')
      const targetDir = resolve(outDir, VOICE_WASM_DIR)
      mkdirSync(targetDir, { recursive: true })
      for (const asset of assets) {
        copyFileSync(asset.path, resolve(targetDir, basename(asset.name)))
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react(), tailwindcss(), voiceWasmPlugin(), dropBundledOrtWasmPlugin()],
    // The voice worker loads its speech engines with dynamic import(), which
    // needs an ES module worker (the default IIFE format cannot code-split).
    worker: {
      format: 'es',
      plugins: () => [dropBundledOrtWasmPlugin()],
    },
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    resolve: {
      alias: [
        { find: '@', replacement: resolve(__dirname, 'src/renderer/src') },
        // Force one onnxruntime-web instance for both voice engines. parakeet.js
        // bundles its own copy and only loads WASM from a CDN (blocked by the
        // CSP); sharing the top-level copy lets the local WASM path we set apply
        // to it too. Anchored so subpath imports (onnxruntime-web/webgpu) still
        // resolve through the package's own exports.
        {
          find: /^onnxruntime-web$/,
          replacement: resolve(__dirname, 'node_modules/onnxruntime-web'),
        },
      ]
    }
  }
})
