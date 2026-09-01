import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import type { IpcContext } from './context'
import { getPiCli } from '../pi-rpc-manager'
import { listSkills, mergeRpcSkills } from '../skills-discovery'

export function registerSkillsMcpHandlers(ctx: IpcContext): void {
  const { workspaceManager } = ctx

  // ─── Skills ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SKILLS_LIST, async () => {
    const ws = workspaceManager.getActiveWorkspace()
    const cwd = ws?.path ?? process.cwd()
    const pi = workspaceManager.getActivePiManager()
    const engine = pi?.getEngineKind() ?? getPiCli().kind ?? 'pi'
    const skills = await listSkills(cwd, engine)
    // The disk scan cannot see skills shipped by installed packages/plugins,
    // but the running engine reports them in its command catalog — merge those
    // in so the panel matches what the agent can actually invoke.
    if (pi && pi.getStatus().status === 'running') {
      mergeRpcSkills(skills, await fetchCommands(pi))
    }
    return skills
  })

  ipcMain.handle(IPC_CHANNELS.COMMANDS_LIST, async () => {
    const pi = workspaceManager.getActivePiManager()
    if (!pi || pi.getStatus().status !== 'running') return []
    return fetchCommands(pi)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVERS_LIST, async () => {
    const ws = workspaceManager.getActiveWorkspace()
    return listMcpServers(ws?.path)
  })
}

// ─── Command Catalog ─────────────────────────────────────────────────────────

/** Command catalog from the running engine (Pi and OMP name the request differently). */
async function fetchCommands(pi: {
  getEngineKind(): 'pi' | 'omp'
  sendCommand(command: Record<string, unknown>): Promise<unknown>
}): Promise<unknown[]> {
  try {
    const command = pi.getEngineKind() === 'omp' ? 'get_available_commands' : 'get_commands'
    const response = (await pi.sendCommand({ type: command })) as {
      success?: boolean
      data?: { commands?: unknown[] }
    } | null
    if (response?.success && Array.isArray(response.data?.commands)) {
      return response.data.commands
    }
    return []
  } catch {
    return []
  }
}

// ─── MCP Server Discovery ────────────────────────────────────────────────────

interface McpServerInfo {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  source: 'global' | 'project'
  status: 'configured' | 'unknown'
}

async function listMcpServers(wsPath?: string): Promise<McpServerInfo[]> {
  const servers: McpServerInfo[] = []
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const omp = getPiCli().kind === 'omp'
  const globalSettingsPaths = omp
    ? [
        join(homeDir, '.omp', 'agent', 'mcp.json'),
        join(homeDir, '.omp', 'agent', '.mcp.json'),
        join(homeDir, '.pi', 'agent', 'settings.json'),
      ]
    : [
        join(homeDir, '.pi', 'agent', 'settings.json'),
        join(homeDir, '.omp', 'agent', 'mcp.json'),
        join(homeDir, '.omp', 'agent', '.mcp.json'),
      ]
  for (const settingsPath of globalSettingsPaths) {
    await collectMcpServers(settingsPath, servers, 'global')
  }

  if (wsPath) {
    const projectSettingsPaths = omp
      ? [
          join(wsPath, '.omp', 'mcp.json'),
          join(wsPath, '.omp', '.mcp.json'),
          join(wsPath, '.pi', 'settings.json'),
        ]
      : [
          join(wsPath, '.pi', 'settings.json'),
          join(wsPath, '.omp', 'mcp.json'),
          join(wsPath, '.omp', '.mcp.json'),
        ]
    for (const settingsPath of projectSettingsPaths) {
      await collectMcpServers(settingsPath, servers, 'project')
    }
  }

  const mcpConfigPaths = [
    join(homeDir, '.config', 'claude', 'claude_desktop_config.json'),
    join(homeDir, '.cursor', 'mcp.json'),
    join(homeDir, '.codeium', 'mcp.json'),
  ]
  for (const configPath of mcpConfigPaths) {
    await collectMcpServersFromConfig(configPath, servers)
  }

  const unique = new Map<string, McpServerInfo>()
  for (const server of servers) {
    const existing = unique.get(server.name)
    if (!existing || (existing.source === 'global' && server.source === 'project')) {
      unique.set(server.name, server)
    }
  }
  return [...unique.values()]
}

async function collectMcpServers(
  settingsPath: string,
  servers: McpServerInfo[],
  source: 'global' | 'project'
): Promise<void> {
  try {
    if (!existsSync(settingsPath)) return
    const content = await readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(content)

    // Pi settings may have mcpServers under various keys
    const mcpServers = settings.mcpServers ?? settings.mcp?.servers ?? {}

    for (const [name, config] of Object.entries(mcpServers)) {
      if (typeof config === 'object' && config !== null) {
        const cfg = config as Record<string, unknown>
        servers.push({
          name,
          command: String(cfg.command ?? ''),
          args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
          env: typeof cfg.env === 'object' && cfg.env !== null ? cfg.env as Record<string, string> : {},
          source,
          status: 'configured',
        })
      }
    }
  } catch {
    // Skip unreadable files
  }
}

async function collectMcpServersFromConfig(
  configPath: string,
  servers: McpServerInfo[]
): Promise<void> {
  try {
    if (!existsSync(configPath)) return
    const content = await readFile(configPath, 'utf-8')
    const config = JSON.parse(content)

    // Claude Desktop format: { mcpServers: { name: { command, args } } }
    const mcpServers = config.mcpServers ?? {}

    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      if (typeof serverConfig === 'object' && serverConfig !== null) {
        const cfg = serverConfig as Record<string, unknown>
        // Avoid duplicates
        if (!servers.some((s) => s.name === name)) {
          servers.push({
            name,
            command: String(cfg.command ?? ''),
            args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
            env: typeof cfg.env === 'object' && cfg.env !== null ? cfg.env as Record<string, string> : {},
            source: 'global',
            status: 'configured',
          })
        }
      }
    }
  } catch {
    // Skip unreadable files
  }
}
