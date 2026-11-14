import { join } from 'path'
import { normalizeOmpProfile } from '../shared/omp-profile'
import { loadPiDotenv } from './pi-dotenv'

/**
 * OMP's on-disk layout for the profile OMP itself runs under.
 *
 * OMP picks its profile from its own arguments first (`--profile <name>` or
 * `--profile=<name>`, the last one before `--`), else from the environment:
 * `OMP_PROFILE` when it is defined (even empty), else the legacy `PI_PROFILE`;
 * `default` or empty means the default profile. Agent processes inherit the
 * app's environment with ~/.pi/.env under it, and get the "default args" setting, so every OMP file the
 * app reads (sessions, models, MCP servers, skills, plugins) is resolved here
 * from both, and the panels show the same account the agent uses. A named
 * profile relocates OMP's whole tree to `~/.omp/profiles/<name>`.
 *
 * `OMP_CODING_AGENT_DIR` keeps relocating the default profile's session store
 * (see pi-paths.ts), as before; OMP ignores agent-dir overrides for named
 * profiles, and so does the app.
 */

const OMP_HOME_DIR_NAME = '.omp'
const OMP_PROFILES_DIR_NAME = 'profiles'
const OMP_AGENT_DIR_NAME = 'agent'
const OMP_PLUGINS_DIR_NAME = 'plugins'

const PROFILE_FLAG = '--profile'
const PROFILE_FLAG_PREFIX = `${PROFILE_FLAG}=`
const END_OF_OPTIONS = '--'
const OPTION_PREFIX = '-'
const OMP_PROFILE_ENV_VAR = 'OMP_PROFILE'

export interface OmpProfileSelection {
  /** The named profile; undefined is the default profile. */
  profile: string | undefined
  /** The name OMP would refuse (the app then reads the default profile). */
  invalid?: string
}

/** The agent arguments from the "default args" setting; see setOmpLaunchArgs. */
let launchArgs: readonly string[] = []

/** The environment every OMP child gets: ~/.pi/.env under the app's own (see buildPiRunEnv). */
function agentEnv(): NodeJS.ProcessEnv {
  return { ...loadPiDotenv(), ...process.env }
}

/**
 * The profile name `--profile` gives in `args`, read the way OMP reads its own
 * argv: the last one before `--` wins. A flag with no name, or with a name that
 * starts with a dash, is the empty string, which OMP refuses. Undefined when
 * `args` names no profile.
 */
export function ompProfileArg(args: readonly string[]): string | undefined {
  let value: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === END_OF_OPTIONS) break
    if (arg === PROFILE_FLAG) {
      const next = args[index + 1]
      const named = next !== undefined && !next.startsWith(OPTION_PREFIX)
      value = named ? next : ''
      if (named) index += 1
    } else if (arg.startsWith(PROFILE_FLAG_PREFIX)) {
      value = arg.slice(PROFILE_FLAG_PREFIX.length)
    }
  }
  return value
}

/** The profile OMP runs under for `args` and `env`, by OMP's own precedence. */
export function ompProfileSelection(
  args: readonly string[] = launchArgs,
  env: NodeJS.ProcessEnv = agentEnv(),
): OmpProfileSelection {
  const fromArgs = ompProfileArg(args)
  if (fromArgs === '') return { profile: undefined, invalid: fromArgs }
  const raw = fromArgs ?? (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)
  const profile = normalizeOmpProfile(raw)
  if (profile === null) return { profile: undefined, invalid: String(raw) }
  return { profile }
}

/**
 * Record the "default args" setting, which every agent start passes to OMP.
 * Returns the profile those arguments and the environment now select.
 */
export function setOmpLaunchArgs(args: readonly string[]): OmpProfileSelection {
  launchArgs = [...args]
  return ompProfileSelection()
}

/** The named profile OMP runs under; undefined is the default profile. */
export function currentOmpProfile(
  env: NodeJS.ProcessEnv = agentEnv(),
  args: readonly string[] = launchArgs,
): string | undefined {
  return ompProfileSelection(args, env).profile
}

/**
 * Environment for an OMP child that does not get the "default args" (a CLI
 * command, a commit message, a council run), so it runs under the profile the
 * agent's `--profile` argument selects. Empty when the arguments name none.
 */
export function ompProfileArgEnv(args: readonly string[] = launchArgs): NodeJS.ProcessEnv {
  const value = ompProfileArg(args)
  return value === undefined ? {} : { [OMP_PROFILE_ENV_VAR]: value }
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
