import { homedir } from 'os'
import { join, posix, win32 } from 'path'
import { fileURLToPath } from 'url'
import { isPathWithin } from '../../resources/path-within'
import type { AgentEngineKind } from '../shared/ipc-contracts'
import { currentOmpProfile, ompAgentDirIn } from './omp-paths'

/** Relocates Pi's whole agent directory, as Pi's own getAgentDir reads it. */
export const PI_AGENT_DIR_ENV_VAR = 'PI_CODING_AGENT_DIR'
const PI_HOME_DIR_NAME = '.pi'
const PI_AGENT_DIR_NAME = 'agent'
const SESSIONS_DIR_NAME = 'sessions'
const WINDOWS_PLATFORM: NodeJS.Platform = 'win32'
const HOME_TILDE = '~'
const HOME_PREFIX_LENGTH = 2
const FILE_URL_PATTERN = /^file:\/\//
/** A Git Bash, MSYS, Cygwin, or WSL drive path: `/c/x`, `/mnt/c/x`, `/cygdrive/c/x`. */
const WINDOWS_SHELL_DRIVE_PATH = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i

/** A shell-style drive path as native Windows APIs take it, as Pi's normalizeWindowsShellPath does. */
function windowsShellPathToNative(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return path
  const match = WINDOWS_SHELL_DRIVE_PATH.exec(path)
  if (!match) return path
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`
}

/**
 * A path from Pi's environment, read the way Pi's expandTildePath reads it:
 * on Windows a shell drive path becomes a native one, a leading `~` or `~/`
 * (also `~\\` on Windows) is the home directory, and a `file://` URL becomes
 * its path. Anything else is kept as it is.
 */
export function expandPiPath(path: string, home: string, platform: NodeJS.Platform = process.platform): string {
  const isWindows = platform === WINDOWS_PLATFORM
  const normalized = isWindows ? windowsShellPathToNative(path) : path
  if (normalized === HOME_TILDE) return home
  if (normalized.startsWith(`${HOME_TILDE}/`) || (isWindows && normalized.startsWith(`${HOME_TILDE}\\`))) {
    return (isWindows ? win32 : posix).join(home, normalized.slice(HOME_PREFIX_LENGTH))
  }
  if (FILE_URL_PATTERN.test(normalized)) return fileURLToPath(normalized)
  return normalized
}

/**
 * Pi's agent directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set,
 * expanded by expandPiPath), resolved the way Pi resolves it so every file the
 * app reads or writes for Pi (settings, models, skills, packages, sessions) is
 * the one Pi itself uses. The home directory is `os.homedir()`, as in Pi:
 * `HOME` on POSIX (which is what tests override), `USERPROFILE` on Windows.
 * `home` replaces it for a caller that scans a given home. Read per call
 * because tests change the environment.
 */
export function getPiAgentDir(home: string = homedir()): string {
  const configured = process.env[PI_AGENT_DIR_ENV_VAR]
  return configured ? expandPiPath(configured, home) : join(home, PI_HOME_DIR_NAME, PI_AGENT_DIR_NAME)
}

/**
 * Absolute path to Pi's on-disk session store (`~/.pi/agent/sessions`).
 * Centralized so session listing, lineage, and activity aggregation agree.
 */
export function getSessionsRoot(): string {
  return join(getPiAgentDir(), SESSIONS_DIR_NAME)
}

/**
 * Absolute path to OMP's session store (`~/.omp/agent/sessions`, or
 * `~/.omp/profiles/<name>/agent/sessions` when OMP runs under a named profile
 * via `OMP_PROFILE` or a `--profile` in the default args; see omp-paths.ts).
 *
 * Each engine keeps its own sessions: OMP writes here, Pi writes under
 * `~/.pi`, and neither is pointed at the other's tree. Both stores use the
 * same per-project directory naming and the same JSONL record shape, so the
 * index can read them side by side. `OMP_CODING_AGENT_DIR` relocates the
 * default profile's store only.
 */
export function getOmpSessionsRoot(): string {
  const profile = currentOmpProfile()
  const agentDir = (!profile && process.env.OMP_CODING_AGENT_DIR) || ompAgentDirIn(homedir(), profile)
  return join(agentDir, SESSIONS_DIR_NAME)
}

/**
 * Every store the session index reads, Pi's first so its rows win a tie.
 * Duplicates are dropped so an env var pointing both engines at one directory
 * cannot list the same session twice.
 */
export function getSessionRoots(): string[] {
  return [...new Set([getSessionsRoot(), getOmpSessionsRoot()])]
}

/**
 * The engine that owns a session file: the store it lives in. Pi's store is
 * checked first so a directory shared by both engines (one env var pointing at
 * the other's) resolves the way getSessionRoots orders it. Null means the path
 * is in no store at all, which is also what makes it unauthorized.
 */
export function engineForSessionPath(candidate: string): AgentEngineKind | null {
  if (isPathWithin(getSessionsRoot(), candidate)) return 'pi'
  if (isPathWithin(getOmpSessionsRoot(), candidate)) return 'omp'
  return null
}

/**
 * The engine a start must use, taken from the session file that start is bound
 * to. A fork source outranks a session path because the fork reads the source
 * before it writes anything. Null when the start creates a new session and so
 * has no owner yet, leaving the caller free to use the configured engine.
 *
 * Shared by the runtime launcher and the permission-mode options so both agree
 * on which engine a start belongs to — the tool names differ per engine, so a
 * disagreement sends OMP Pi's tool list.
 */
export function engineForBoundSession(
  bound: { sessionPath?: string; forkSessionPath?: string }
): AgentEngineKind | null {
  const boundSessionPath = bound.forkSessionPath ?? bound.sessionPath
  return boundSessionPath ? engineForSessionPath(boundSessionPath) : null
}

/**
 * Authorization gate for a session path the renderer supplied. A path is
 * acceptable when it sits inside any store the index itself reads; anything
 * else is refused, which is what keeps resume/fork/delete inside the stores.
 */
export function isWithinSessionRoots(candidate: string): boolean {
  return engineForSessionPath(candidate) !== null
}
