import { app } from 'electron'
import type { AgentEngineKind, PiStartOptions, AppSettings, PermissionMode } from '../../shared/ipc-contracts'
import { getGuiDataPath } from '../app-data-paths'
import { workspaceTrustStore } from '../workspace-trust'
import { join } from 'path'
import { existsSync } from 'fs'
import { PERMISSION_RULES_FILE_NAME } from '../../../resources/permission-rules'
import { isString, isObject, isOptionalString, isOptionalBoolean, isOptionalStringArray } from './validation'
import { getPiCli } from '../pi-rpc-manager'
import { engineForBoundSession } from '../pi-paths'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from '../../shared/agent-engine-label'

const READ_ONLY_TOOLS = 'read,grep,find,ls'
const OMP_READ_ONLY_TOOLS = 'read,grep,glob'

const PERMISSIONS_EXTENSION_PATH = app.isPackaged
  ? join(process.resourcesPath, 'resources', 'pi-desktop-permissions.ts')
  : join(app.getAppPath(), 'resources', 'pi-desktop-permissions.ts')

export function getGlobalPermissionRulesPath(): string {
  return getGuiDataPath(PERMISSION_RULES_FILE_NAME)
}

function removeToolArgs(args: string[]): string[] {
  const filtered: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--tools' || arg === '-t') {
      i++
      continue
    }
    if (arg.startsWith('--tools=') || arg.startsWith('-t=')) continue
    if (arg === '--no-tools' || arg === '-nt' || arg === '--no-builtin-tools' || arg === '-nbt') continue
    filtered.push(arg)
  }
  return filtered
}

/**
 * The engine this start will actually run under. Plan mode names concrete
 * tools and the two engines name them differently, so reading the configured
 * default would hand OMP Pi's tool list whenever a session belonging to the
 * other engine is opened — and Pi's `find`/`ls` do not exist in OMP, which
 * silently strips plan mode of the tools it is meant to allow.
 */
function engineForStartOptions(options: PiStartOptions): AgentEngineKind {
  return options.engine ?? engineForBoundSession(options) ?? getPiCli().kind ?? 'pi'
}

function toolsForPermissionMode(mode: PermissionMode, runtime: AgentEngineKind = 'pi'): string | null {
  switch (mode) {
    case 'plan-readonly':
      return runtime === 'omp' ? OMP_READ_ONLY_TOOLS : READ_ONLY_TOOLS
    case 'ask-commands':
    case 'ask-edits':
    case 'trusted':
      return null
  }
}

/**
 * Opt into resuming the most recent session on launch (Pi's --continue) when
 * the user setting is enabled and the caller hasn't requested a specific
 * session or an ephemeral (no-session) run.
 */
export function applyResumePreference(options: PiStartOptions, settings: AppSettings): PiStartOptions {
  if (settings.resumeLastSession && !options.sessionPath && !options.forkSessionPath && !options.noSession) {
    return { ...options, continueSession: true }
  }
  return options
}

export function applyPermissionModeToStartOptions(
  options: PiStartOptions,
  settings: AppSettings
): PiStartOptions {
  const engine = engineForStartOptions(options)
  const toolList = toolsForPermissionMode(settings.permissionMode, engine)
  const args = toolList
    ? [...removeToolArgs(options.args ?? []), '--tools', toolList]
    : [...(options.args ?? [])]
  const globalRulesPath = getGlobalPermissionRulesPath()
  if (existsSync(PERMISSIONS_EXTENSION_PATH)) {
    args.push('-e', PERMISSIONS_EXTENSION_PATH)
  }

  return {
    ...options,
    args,
    env: {
      ...options.env,
      PI_DESKTOP_PERMISSION_MODE: settings.permissionMode,
      // The extension raises the approval prompt from inside the agent, so it
      // has no other way to know which CLI it is running in. Without this the
      // prompt says "Pi wants to run..." during an OMP session.
      PI_DESKTOP_AGENT_LABEL: agentEngineLabel(engine) ?? DEFAULT_AGENT_ENGINE_LABEL,
      // Resolved here because the extension cannot re-derive the GUI data
      // dir (env override / canonical appData / legacy fallback).
      PI_DESKTOP_PERMISSION_RULES_PATH: globalRulesPath,
      // Gates whether this workspace's own permission-rules.json allow rules
      // take effect. Untrusted repos may only tighten (deny) — the user grants
      // trust explicitly (see workspace-trust.ts).
      PI_DESKTOP_WORKSPACE_TRUSTED:
        options.cwd && workspaceTrustStore.isTrusted(options.cwd) ? '1' : '0',
    },
  }
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

export function validateStartOptions(value: unknown): PiStartOptions {
  if (value === undefined || value === null) return {}

  if (!isObject(value)) throw new Error('Start options must be an object')

  const opts: PiStartOptions = {}

  if (!isOptionalString(value.cwd)) throw new Error('cwd must be a string')
  if (!isOptionalString(value.model)) throw new Error('model must be a string')
  if (!isOptionalString(value.provider)) throw new Error('provider must be a string')
  if (!isOptionalString(value.sessionPath)) throw new Error('sessionPath must be a string')
  if (!isOptionalString(value.forkSessionPath)) throw new Error('forkSessionPath must be a string')
  if (!isOptionalBoolean(value.noSession)) throw new Error('noSession must be a boolean')
  if (!isOptionalStringArray(value.args)) throw new Error('args must be a string array')
  if (value.env !== undefined && !isObject(value.env)) throw new Error('env must be an object')

  if (isString(value.cwd)) opts.cwd = value.cwd
  if (isString(value.model)) opts.model = value.model
  if (isString(value.provider)) opts.provider = value.provider
  if (isString(value.sessionPath)) opts.sessionPath = value.sessionPath
  if (isString(value.forkSessionPath)) opts.forkSessionPath = value.forkSessionPath
  if (value.noSession === true) opts.noSession = true
  if (Array.isArray(value.args)) opts.args = value.args as string[]
  if (isObject(value.env)) {
    opts.env = Object.fromEntries(
      Object.entries(value.env).filter((entry): entry is [string, string] => isString(entry[1]))
    )
  }

  return opts
}
