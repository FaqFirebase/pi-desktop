import { join } from 'path'
import { normalizeOmpProfile } from '../shared/omp-profile'

/**
 * OMP's on-disk layout for the profile OMP itself runs under.
 *
 * OMP picks its profile from the environment: `OMP_PROFILE` when it is defined
 * (even empty), else the legacy `PI_PROFILE`; `default` or empty means the
 * default profile. Agent processes inherit the app's environment, so they run
 * under that profile; every OMP file the app reads (sessions, models, MCP
 * servers, skills, plugins) is resolved here so the panels show the same
 * account the agent uses. A named profile relocates OMP's whole tree to
 * `~/.omp/profiles/<name>`.
 *
 * `OMP_CODING_AGENT_DIR` keeps relocating the default profile's session store
 * (see pi-paths.ts), as before; OMP ignores agent-dir overrides for named
 * profiles, and so does the app.
 */

const OMP_HOME_DIR_NAME = '.omp'
const OMP_PROFILES_DIR_NAME = 'profiles'
const OMP_AGENT_DIR_NAME = 'agent'
const OMP_PLUGINS_DIR_NAME = 'plugins'

export interface OmpProfileSelection {
  /** The named profile; undefined is the default profile. */
  profile: string | undefined
  /** The name from the environment when OMP would refuse it (the app then reads the default profile). */
  invalid?: string
}

/** The profile OMP runs under for `env`, by OMP's own precedence. */
export function ompProfileFromEnv(env: NodeJS.ProcessEnv = process.env): OmpProfileSelection {
  const raw = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE
  const profile = normalizeOmpProfile(raw)
  if (profile === null) return { profile: undefined, invalid: String(raw) }
  return { profile }
}

/** The named profile OMP runs under; undefined is the default profile. */
export function currentOmpProfile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return ompProfileFromEnv(env).profile
}

/** The root of a profile's tree under `home`: `~/.omp` or `~/.omp/profiles/<name>`. */
export function ompProfileRootIn(home: string, profile: string | undefined): string {
  const ompHome = join(home, OMP_HOME_DIR_NAME)
  return profile ? join(ompHome, OMP_PROFILES_DIR_NAME, profile) : ompHome
}

/** A profile's agent directory under `home` (`models.yml`, `mcp.json`, `skills/`, `sessions/`). */
export function ompAgentDirIn(home: string, profile: string | undefined): string {
  return join(ompProfileRootIn(home, profile), OMP_AGENT_DIR_NAME)
}

/** A profile's plugin store under `home`. */
export function ompPluginsDirIn(home: string, profile: string | undefined): string {
  return join(ompProfileRootIn(home, profile), OMP_PLUGINS_DIR_NAME)
}
