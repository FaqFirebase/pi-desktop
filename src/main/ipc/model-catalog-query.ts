import { app } from 'electron'
import type { AgentEngineKind, ModelInfo } from '../../shared/ipc-contracts'
import type { WorkspaceManager } from '../workspace-manager'
import { PiRpcManager, getConfiguredEngineKind } from '../pi-rpc-manager'
import { loadAppSettings } from './settings'
import { isObject } from './validation'
import { t } from '../../shared/i18n'
import { pathsEqual } from '../../shared/path-compare'

// ─── Model Catalog ───────────────────────────────────────────────────────────

/** In-flight no-session metadata queries, merged by identical start context. */
const catalogQueries = new Map<string, Promise<ModelInfo[]>>()

/**
 * The engine's real model catalog without a running session. This spawns a
 * short-lived RPC process with no session, no tools and no extensions: it never
 * sends a prompt, never calls a model, never registers a WorkspaceManager
 * runtime, never touches an existing session, and is reaped on success, failure
 * and cancellation. Identical concurrent requests share one process.
 */
export async function queryModelCatalog(
  wm: WorkspaceManager,
  options: { cwd: string; engine?: AgentEngineKind },
): Promise<ModelInfo[]> {
  const engine = options.engine ?? getConfiguredEngineKind()
  const settings = await loadAppSettings(wm)
  const provider = settings.defaultProvider ?? undefined
  const model = settings.defaultModel ?? undefined
  const thinkingLevel = settings.defaultThinkingLevel ?? undefined
  // Callers must name a selected workspace; missing context never means Home.
  if (typeof options.cwd !== 'string' || !options.cwd) throw new Error('A model catalog workspace is required')
  const home = app.getPath('home')
  const cwd = options.cwd
  // The context a catalog is resolved in: a project's own config, custom
  // models and settings can change the list, so the cwd is part of the merge
  // key — two projects querying at once never share one process.
  const key = JSON.stringify([engine, cwd, provider, model, thinkingLevel])
  const existing = catalogQueries.get(key)
  if (existing) return existing
  const promise = (async () => {
    const manager = new PiRpcManager()
    try {
      await manager.start({
        cwd,
        engine,
        noSession: true,
        provider,
        model,
        defaultThinkingLevel: thinkingLevel,
        // A metadata query is a read-only probe. Extensions, skills, MCP and
        // context discovery all run engine-side startup hooks (session_start
        // can write files or hit the network) before the first response, so
        // every discoverable side channel is disabled for both engines; the
        // process only answers get_available_models and is reaped.
        // (--no-tools alone does not stop extension *execution*.) The flag
        // sets differ per engine: OMP 18 has no --no-mcp and exits 2 on it,
        // which would break every catalog load, so each engine gets only the
        // flags its CLI actually supports.
        args: [
          ...(engine === 'omp'
            ? ['--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-title', '--no-lsp']
            : ['--no-tools', '--no-extensions', '--no-skills', '--no-mcp', '--no-prompt-templates', '--no-context-files']),
          ...(engine === 'omp' && pathsEqual(cwd, home) ? ['--allow-home'] : []),
        ],
      })
      if (manager.getStatus().status !== 'running') throw new Error(t('errors.pi.processExited'))
      const response = await manager.sendCommand({ type: 'get_available_models' })
      const data = isObject(response?.data) ? response.data : null
      const models = data?.models
      if (!Array.isArray(models)) throw new Error('Failed to query models from engine')
      return models as ModelInfo[]
    } finally {
      manager.stop()
      catalogQueries.delete(key)
    }
  })()
  catalogQueries.set(key, promise)
  return promise
}
