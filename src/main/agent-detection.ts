import { existsSync } from 'fs'
import { join, delimiter as PATH_DELIMITER } from 'path'
import { spawnSync } from 'child_process'
import type { CouncilAgentId } from '../shared/council-config'
import { COUNCIL_AGENT_IDS } from '../shared/council-config'

const IS_WINDOWS = process.platform === 'win32'

/** Base executable name per council agent. */
export const AGENT_BINARIES: Record<CouncilAgentId, string> = {
  pi: 'pi',
  claude: 'claude',
  codex: 'codex',
}

export interface DetectedAgent {
  id: CouncilAgentId
  found: boolean
  path: string | null
}

interface PlatformInfo {
  isWindows: boolean
  home: string
  env: NodeJS.ProcessEnv
}

/** Common install locations to probe, ordered most- to least-likely. Pure. */
export function candidatePaths(id: CouncilAgentId, platform: PlatformInfo): string[] {
  const base = AGENT_BINARIES[id]
  const { isWindows, home, env } = platform
  const out: string[] = []
  if (isWindows) {
    const appData = env.APPDATA ?? ''
    const localAppData = env.LOCALAPPDATA ?? ''
    if (appData) out.push(join(appData, 'npm', `${base}.cmd`))
    if (localAppData) out.push(join(localAppData, 'npm', `${base}.cmd`))
    out.push(join('C:\\Program Files', 'nodejs', `${base}.cmd`))
  } else {
    out.push(join('/opt/homebrew/bin', base))
    out.push(join('/usr/local/bin', base))
    out.push(join('/usr/bin', base))
    out.push(join(home, '.local/bin', base))
    out.push(join(home, '.npm-global/bin', base))
  }
  return out
}

function whichInPath(name: string): string | null {
  const pathDirs = (process.env.PATH ?? '').split(PATH_DELIMITER).filter(Boolean)
  const exts = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
    : ['']
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function npmGlobalPrefix(): string | null {
  try {
    const result = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
      encoding: 'utf-8',
      shell: IS_WINDOWS,
      timeout: 5000,
    })
    if (result.status === 0 && result.stdout) {
      const prefix = result.stdout.trim()
      if (prefix && existsSync(prefix)) return prefix
    }
  } catch {
    // npm not on PATH — ignore
  }
  return null
}

function resolveAgent(id: CouncilAgentId): string | null {
  const base = AGENT_BINARIES[id]
  // 1. PATH (respects PATHEXT on Windows)
  const fromPath = whichInPath(base)
  if (fromPath) return fromPath
  // 2. npm global prefix
  const prefix = npmGlobalPrefix()
  if (prefix) {
    const candidates = IS_WINDOWS
      ? [join(prefix, `${base}.cmd`)]
      : [join(prefix, 'bin', base)]
    for (const c of candidates) if (existsSync(c)) return c
  }
  // 3. common locations
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  for (const c of candidatePaths(id, { isWindows: IS_WINDOWS, home, env: process.env })) {
    if (existsSync(c)) return c
  }
  return null
}

/** Detect every known consultant agent on this machine. */
export function detectAgents(): DetectedAgent[] {
  return COUNCIL_AGENT_IDS.map((id) => {
    const path = resolveAgent(id)
    return { id, found: path !== null, path }
  })
}
