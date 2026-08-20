import { basename, join, posix as posixPath } from 'path'
import { buildNpmPrefixCommand } from './cmd-escape'

/**
 * Locating the Pi CLI is the single most failure-prone step at startup, and the
 * failures are all environmental rather than logical: a GUI app started from
 * Finder or a desktop launcher inherits a minimal PATH, version managers hide
 * global installs under per-version directories, and Windows ships shims that
 * cannot be spawned without a shell.
 *
 * Everything here is pure with respect to injected `ResolutionDeps`, so the
 * whole search order is unit-testable without touching the real filesystem.
 */

export const PI_PACKAGE = '@earendil-works/pi-coding-agent'
export const PI_CLI_REL = join('node_modules', PI_PACKAGE, 'dist', 'cli.js')
export const PI_FALLBACK_BINARY_POSIX = 'pi'
export const PI_FALLBACK_BINARY_WINDOWS = 'pi.cmd'
export const OMP_FALLBACK_BINARY_POSIX = 'omp'
export const OMP_FALLBACK_BINARY_WINDOWS = 'omp.exe'
export const DEFAULT_LOGIN_SHELL = '/bin/bash'
export const FISH_SHELL_NAME = 'fish'
/** Sentinels bracket the PATH so rc-file chatter can be discarded. */
export const SHELL_PATH_START = '__PI_PATH_START__'
export const SHELL_PATH_END = '__PI_PATH_END__'
/** A login shell sources the user's whole rc chain; give it room but bound it. */
export const SHELL_PROBE_TIMEOUT_MS = 5_000
export const NPM_PREFIX_TIMEOUT_MS = 5_000
const WINDOWS_PATH_DELIMITER = ';'
const POSIX_PATH_DELIMITER = ':'
const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD'
const JS_EXTENSION = '.js'
const SHELL_SCRIPT_PATTERN = /\.(cmd|bat|ps1)$/i
const VERSION_NUMBER_PATTERN = /\d+/g
const OMP_BINARY_PATTERN = /(?:^|[\\/])omp(?:\.(?:cmd|exe|bat|ps1))?$/i

/** Where a resolved path came from, for logging and error messaging. */
export type PiResolutionSource =
  | 'override'
  | 'npm-prefix'
  | 'path'
  | 'version-manager'
  | 'common-location'
  | 'omp'
  | 'fallback'

export interface CaptureOptions {
  shell: boolean
  timeoutMs: number
  /** PATH to hand the child, so probes see version-manager shims too. */
  pathEnv: string
}

/** Filesystem and process access, injected so the search order can be tested. */
export interface ResolutionDeps {
  isWindows: boolean
  env: NodeJS.ProcessEnv
  exists(path: string): boolean
  isDirectory(path: string): boolean
  /** Immediate child names of a directory; empty when unreadable. */
  listDir(path: string): string[]
  /** Run a command and return trimmed stdout, or null if it failed. */
  capture(command: string, args: string[], options: CaptureOptions): string | null
}

export type PiEngine = 'auto' | 'pi' | 'omp'

export interface PiResolution {
  /** Path to spawn: either a cli.js (with node) or an executable/shim. */
  script: string
  /** True when `script` is a .js entry point that needs a Node binary. */
  useNode: boolean
  /** True when `script` is a Windows shim that spawn cannot invoke directly. */
  needsShell: boolean
  source: PiResolutionSource
  /** False when nothing was found and `script` is only a hopeful fallback. */
  found: boolean
  /** A configured override that pointed at nothing; null when unset or valid. */
  rejectedOverride: string | null
  /** PATH with the login shell's entries merged in, for spawned children. */
  pathEnv: string
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? env.USERPROFILE ?? ''
}

function pathDelimiterFor(isWindows: boolean): string {
  return isWindows ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER
}

/**
 * Turn the raw `piExecutablePath` setting into a usable path, or null when it
 * carries no information. Blank values and the bare binary name both mean
 * "auto-detect"; quotes and a leading `~` are normalized away because both are
 * common in hand-entered or pasted paths.
 */
export function normalizeOverride(raw: string | undefined | null, home: string): string | null {
  if (!raw) return null
  let value = raw.trim()
  if (!value) return null
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  if (quoted && value.length >= 2) value = value.slice(1, -1).trim()
  if (!value) return null

  const lower = value.toLowerCase()
  if (lower === PI_FALLBACK_BINARY_POSIX || lower === PI_FALLBACK_BINARY_WINDOWS) return null
  // `omp` is an intentional engine selector, not a filesystem path. Keep it
  // for resolvePiBinary() so the Settings field can switch runtimes without
  // requiring the user to find the installed executable.
  if (lower === OMP_FALLBACK_BINARY_POSIX || lower === OMP_FALLBACK_BINARY_WINDOWS) return value

  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(home, value.slice(2))
  }
  return value
}

/** Extract the PATH the login shell printed between our sentinels. */
export function parseShellPath(stdout: string): string | null {
  const start = stdout.indexOf(SHELL_PATH_START)
  if (start < 0) return null
  const from = start + SHELL_PATH_START.length
  const end = stdout.indexOf(SHELL_PATH_END, from)
  if (end < 0) return null
  const value = stdout.slice(from, end).trim()
  return value || null
}

/**
 * Args that make a login shell print its PATH. Interactive (`-i`) *and* login
 * (`-l`) because nvm/fnm/asdf initialization lives in `.bashrc`/`.zshrc` for
 * some users and in the profile files for others.
 */
export function buildLoginShellArgs(shellPath: string): string[] {
  // fish stores PATH as a list, so `$PATH` interpolates space-separated.
  const pathExpression =
    basename(shellPath) === FISH_SHELL_NAME ? '(string join : $PATH)' : '"$PATH"'
  return [
    '-i',
    '-l',
    '-c',
    `printf '%s%s%s' '${SHELL_PATH_START}' ${pathExpression} '${SHELL_PATH_END}'`,
  ]
}

/**
 * Ask the user's login shell for its PATH. Returns null on Windows (where the
 * GUI already inherits the full user PATH) or when the probe yields nothing.
 */
export function loginShellPath(deps: ResolutionDeps): string | null {
  if (deps.isWindows) return null
  const shell = deps.env.SHELL ?? DEFAULT_LOGIN_SHELL
  const stdout = deps.capture(shell, buildLoginShellArgs(shell), {
    shell: false,
    timeoutMs: SHELL_PROBE_TIMEOUT_MS,
    pathEnv: deps.env.PATH ?? '',
  })
  if (!stdout) return null
  return parseShellPath(stdout)
}

/** Append entries from `incoming` that `current` does not already contain. */
export function mergePathEntries(current: string, incoming: string, isWindows: boolean): string {
  const delimiter = pathDelimiterFor(isWindows)
  const existing = current.split(delimiter).filter(Boolean)
  const seen = new Set(existing)
  for (const entry of incoming.split(delimiter).filter(Boolean)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    existing.push(entry)
  }
  return existing.join(delimiter)
}

/** Sort comparator putting the highest version-like directory name first. */
export function compareVersionsDesc(a: string, b: string): number {
  const left = a.match(VERSION_NUMBER_PATTERN)?.map(Number) ?? []
  const right = b.match(VERSION_NUMBER_PATTERN)?.map(Number) ?? []
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0)
    if (diff !== 0) return diff
  }
  return b.localeCompare(a)
}

/** A directory whose children are node versions, plus the prefix inside one. */
interface VersionRoot {
  root: string
  /** Path segments appended to a version directory to reach its npm prefix. */
  prefixSuffix: string[]
}

function posixVersionRoots(env: NodeJS.ProcessEnv): VersionRoot[] {
  const home = homeDir(env)
  const fnmDir = env.FNM_DIR ?? ''
  const asdfDir = env.ASDF_DATA_DIR ?? join(home, '.asdf')
  const roots: VersionRoot[] = [
    { root: join(home, '.nvm', 'versions', 'node'), prefixSuffix: [] },
    { root: join(home, '.local', 'share', 'fnm', 'node-versions'), prefixSuffix: ['installation'] },
    {
      root: join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
      prefixSuffix: ['installation'],
    },
    { root: join(home, '.volta', 'tools', 'image', 'node'), prefixSuffix: [] },
    { root: join(asdfDir, 'installs', 'nodejs'), prefixSuffix: [] },
    { root: join(home, '.local', 'share', 'mise', 'installs', 'node'), prefixSuffix: [] },
    { root: join(home, '.nodenv', 'versions'), prefixSuffix: [] },
    { root: join('/usr/local/n', 'versions', 'node'), prefixSuffix: [] },
  ]
  if (fnmDir) {
    roots.push({ root: join(fnmDir, 'node-versions'), prefixSuffix: ['installation'] })
  }
  return roots
}

function windowsVersionRoots(env: NodeJS.ProcessEnv): VersionRoot[] {
  const appData = env.APPDATA ?? ''
  const localAppData = env.LOCALAPPDATA ?? ''
  const nvmHome = env.NVM_HOME ?? ''
  const roots: VersionRoot[] = []
  if (nvmHome) roots.push({ root: nvmHome, prefixSuffix: [] })
  if (appData) {
    roots.push({ root: join(appData, 'nvm'), prefixSuffix: [] })
    roots.push({ root: join(appData, 'fnm', 'node-versions'), prefixSuffix: ['installation'] })
  }
  if (localAppData) {
    roots.push({ root: join(localAppData, 'fnm', 'node-versions'), prefixSuffix: ['installation'] })
    roots.push({ root: join(localAppData, 'Volta', 'tools', 'image', 'node'), prefixSuffix: [] })
  }
  return roots
}

/**
 * Every per-version npm prefix a node version manager may have created, newest
 * version first. These are the installs a bare PATH search can never see.
 */
export function versionManagerPrefixes(deps: ResolutionDeps): string[] {
  const roots = deps.isWindows ? windowsVersionRoots(deps.env) : posixVersionRoots(deps.env)
  const prefixes: string[] = []
  const seen = new Set<string>()
  for (const { root, prefixSuffix } of roots) {
    if (!deps.exists(root)) continue
    const versions = deps
      .listDir(root)
      .filter((name) => deps.isDirectory(join(root, name)))
      .sort(compareVersionsDesc)
    for (const version of versions) {
      const prefix = join(root, version, ...prefixSuffix)
      if (seen.has(prefix)) continue
      seen.add(prefix)
      prefixes.push(prefix)
    }
  }
  return prefixes
}

/**
 * Look for the Pi cli.js under a directory that behaves like an npm prefix.
 * Covers the three global-install layouts: Windows (`<prefix>/node_modules`),
 * POSIX (`<prefix>/lib/node_modules`), and shim-adjacent installs where the
 * shim sits one level below the prefix.
 */
export function findCliJsNear(deps: ResolutionDeps, dir: string): string | null {
  const candidates = [
    join(dir, PI_CLI_REL),
    join(dir, 'lib', PI_CLI_REL),
    join(dir, '..', PI_CLI_REL),
    join(dir, '..', 'lib', PI_CLI_REL),
  ]
  for (const candidate of candidates) {
    if (deps.exists(candidate)) return candidate
  }
  return null
}

/** Executable shim names an npm prefix may expose, per platform. */
function shimCandidates(deps: ResolutionDeps, prefix: string): string[] {
  return deps.isWindows
    ? [join(prefix, 'pi.cmd'), join(prefix, 'pi.ps1'), join(prefix, 'pi.exe')]
    : [join(prefix, 'bin', 'pi'), join(prefix, 'pi')]
}

/**
 * Resolve a prefix to a spawnable Pi path, preferring the JS entry point so we
 * can run it with our own Node and skip the shell wrapper entirely.
 */
function resolveFromPrefix(deps: ResolutionDeps, prefix: string): string | null {
  const cliJs = findCliJsNear(deps, prefix)
  if (cliJs) return cliJs
  for (const shim of shimCandidates(deps, prefix)) {
    if (deps.exists(shim)) return shim
  }
  return null
}

/** Search PATH for an executable, honoring PATHEXT on Windows. */
export function whichInPath(deps: ResolutionDeps, name: string, pathEnv: string): string | null {
  const dirs = pathEnv.split(pathDelimiterFor(deps.isWindows)).filter(Boolean)
  const pathJoin = deps.isWindows ? join : posixPath.join
  const extensions = deps.isWindows
    ? (deps.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT).split(';').map((e) => e.toLowerCase())
    : ['']
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = pathJoin(dir, name + extension)
      if (deps.exists(candidate)) return candidate
      // Tests inject a platform independent `isWindows` flag while running on
      // the host OS. Accept the host join spelling as a fallback in that seam;
      // real processes always take the first branch for their native platform.
      if (!deps.isWindows) {
        const hostCandidate = join(dir, name + extension)
        if (hostCandidate !== candidate && deps.exists(hostCandidate)) return hostCandidate
      }
    }
  }
  return null
}

/** Ask npm where its global prefix is; null when npm is unreachable. */
function npmGlobalPrefix(deps: ResolutionDeps, pathEnv: string): string | null {
  const command = buildNpmPrefixCommand(deps.isWindows)
  const stdout = deps.capture(command.file, command.args, {
    shell: deps.isWindows,
    timeoutMs: NPM_PREFIX_TIMEOUT_MS,
    pathEnv,
  })
  if (!stdout) return null
  const prefix = stdout.trim()
  if (!prefix || !deps.exists(prefix)) return null
  return prefix
}

/** Hardcoded install locations, used only after every dynamic probe fails. */
function ompShimCandidates(deps: ResolutionDeps, prefix: string): string[] {
  return deps.isWindows
    ? [join(prefix, 'omp.cmd'), join(prefix, 'omp.ps1'), join(prefix, 'omp.exe')]
    : [join(prefix, 'bin', 'omp'), join(prefix, 'omp')]
}

function ompLocations(deps: ResolutionDeps): string[] {
  const { env } = deps
  const home = homeDir(env)
  if (deps.isWindows) {
    const appData = env.APPDATA ?? ''
    const localAppData = env.LOCALAPPDATA ?? ''
    const userProfile = env.USERPROFILE ?? home
    return [
      appData ? join(appData, 'npm', OMP_FALLBACK_BINARY_WINDOWS) : '',
      localAppData ? join(localAppData, 'npm', OMP_FALLBACK_BINARY_WINDOWS) : '',
      localAppData ? join(localAppData, 'omp', OMP_FALLBACK_BINARY_WINDOWS) : '',
      join(userProfile, '.bun', 'bin', OMP_FALLBACK_BINARY_WINDOWS),
    ].filter(Boolean)
  }
  return [
    join(home, '.local', 'bin', OMP_FALLBACK_BINARY_POSIX),
    join(home, '.bun', 'bin', OMP_FALLBACK_BINARY_POSIX),
    join(home, '.npm-global', 'bin', OMP_FALLBACK_BINARY_POSIX),
    join(home, '.npm-packages', 'bin', OMP_FALLBACK_BINARY_POSIX),
    '/opt/homebrew/bin/omp',
    '/usr/local/bin/omp',
    '/usr/bin/omp',
  ]
}

function resolveOmpBinary(deps: ResolutionDeps, pathEnv: string): string | null {
  const onPath = whichInPath(deps, OMP_FALLBACK_BINARY_POSIX, pathEnv)
  if (onPath) return onPath
  for (const candidate of ompLocations(deps)) {
    if (deps.exists(candidate)) return candidate
  }
  const prefix = npmGlobalPrefix(deps, pathEnv)
  if (prefix) {
    for (const candidate of ompShimCandidates(deps, prefix)) {
      if (deps.exists(candidate)) return candidate
    }
  }
  return null
}

export function isOmpExecutable(script: string): boolean {
  return OMP_BINARY_PATTERN.test(script)
}

function commonLocations(deps: ResolutionDeps): string[] {
  const { env } = deps
  const home = homeDir(env)
  if (deps.isWindows) {
    const appData = env.APPDATA ?? ''
    const localAppData = env.LOCALAPPDATA ?? ''
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const paths: string[] = []
    if (appData) paths.push(join(appData, 'npm', PI_CLI_REL), join(appData, 'npm', 'pi.cmd'))
    if (localAppData) {
      paths.push(join(localAppData, 'npm', PI_CLI_REL), join(localAppData, 'npm', 'pi.cmd'))
    }
    paths.push(join(programFiles, 'nodejs', PI_CLI_REL))
    return paths
  }
  return [
    join(home, '.npm-global', PI_CLI_REL),
    join(home, '.npm-packages', PI_CLI_REL),
    join('/opt/homebrew/lib', PI_CLI_REL),
    join('/usr/local/lib', PI_CLI_REL),
    join('/usr/lib', PI_CLI_REL),
    join(home, '.npm-global', 'bin', 'pi'),
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi',
    '/usr/bin/pi',
    join(home, '.local/bin/pi'),
  ]
}

function finalize(
  deps: ResolutionDeps,
  script: string,
  source: PiResolutionSource,
  found: boolean,
  rejectedOverride: string | null,
  pathEnv: string
): PiResolution {
  const useNode = script.toLowerCase().endsWith(JS_EXTENSION)
  return {
    script,
    useNode,
    needsShell: deps.isWindows && !useNode && SHELL_SCRIPT_PATTERN.test(script),
    source,
    found,
    rejectedOverride,
    pathEnv,
  }
}

/**
 * Find the Pi CLI. Order, most authoritative first:
 *
 *   0. Merge the login shell's PATH into ours, so every later probe sees what
 *      the user's terminal sees. A GUI process started from Finder or a desktop
 *      launcher otherwise gets a minimal PATH with no version-manager shims.
 *   1. The path configured in Settings, if it exists. A directory is accepted
 *      and searched; a stale value is reported rather than silently obeyed.
 *   2. npm's own global prefix.
 *   3. A PATH search.
 *   4. Per-version prefixes created by node version managers.
 *   5. Hardcoded common install locations.
 *   6. OMP fallback when Pi is not installed.
 *   7. The bare binary name, flagged as not found.
 */
export function resolvePiBinary(
  deps: ResolutionDeps,
  overridePath: string | null,
  engine: PiEngine = 'auto'
): PiResolution {
  const basePath = deps.env.PATH ?? ''
  const shellPath = loginShellPath(deps)
  const pathEnv = shellPath ? mergePathEntries(basePath, shellPath, deps.isWindows) : basePath

  let rejectedOverride: string | null = null
  if (engine === 'omp') {
    const omp = resolveOmpBinary(deps, pathEnv)
    return omp
      ? finalize(deps, omp, 'omp', true, null, pathEnv)
      : finalize(
          deps,
          deps.isWindows ? OMP_FALLBACK_BINARY_WINDOWS : OMP_FALLBACK_BINARY_POSIX,
          'fallback',
          false,
          null,
          pathEnv
        )
  }
  if (overridePath && (overridePath.toLowerCase() === OMP_FALLBACK_BINARY_POSIX || overridePath.toLowerCase() === OMP_FALLBACK_BINARY_WINDOWS)) {
    const omp = resolveOmpBinary(deps, pathEnv)
    if (omp) return finalize(deps, omp, 'override', true, null, pathEnv)
    return finalize(
      deps,
      deps.isWindows ? OMP_FALLBACK_BINARY_WINDOWS : OMP_FALLBACK_BINARY_POSIX,
      'fallback',
      false,
      overridePath,
      pathEnv
    )
  }
  if (overridePath) {
    if (deps.isDirectory(overridePath)) {
      const fromDir = resolveFromPrefix(deps, overridePath)
      if (fromDir) return finalize(deps, fromDir, 'override', true, null, pathEnv)
      rejectedOverride = overridePath
    } else if (deps.exists(overridePath)) {
      return finalize(deps, overridePath, 'override', true, null, pathEnv)
    } else {
      rejectedOverride = overridePath
    }
  }

  const prefix = npmGlobalPrefix(deps, pathEnv)
  if (prefix) {
    const fromPrefix = resolveFromPrefix(deps, prefix)
    if (fromPrefix) return finalize(deps, fromPrefix, 'npm-prefix', true, rejectedOverride, pathEnv)
  }

  const onPath = whichInPath(deps, PI_FALLBACK_BINARY_POSIX, pathEnv)
  if (onPath) {
    // A .cmd/.ps1 shim is spawnable only through a shell, which breaks the
    // JSONL stdio piping RPC mode needs. Prefer the cli.js it wraps.
    if (SHELL_SCRIPT_PATTERN.test(onPath)) {
      const cliJs = findCliJsNear(deps, join(onPath, '..'))
      if (cliJs) return finalize(deps, cliJs, 'path', true, rejectedOverride, pathEnv)
    }
    return finalize(deps, onPath, 'path', true, rejectedOverride, pathEnv)
  }

  for (const versionPrefix of versionManagerPrefixes(deps)) {
    const fromVersion = resolveFromPrefix(deps, versionPrefix)
    if (fromVersion) {
      return finalize(deps, fromVersion, 'version-manager', true, rejectedOverride, pathEnv)
    }
  }

  for (const candidate of commonLocations(deps)) {
    if (deps.exists(candidate)) {
      return finalize(deps, candidate, 'common-location', true, rejectedOverride, pathEnv)
    }
  }

  // Keep the historical Pi-first preference, but make an OMP-only machine
  // work without forcing the user to discover the Agent Executable field.
  if (engine === 'auto') {
    const omp = resolveOmpBinary(deps, pathEnv)
    if (omp) return finalize(deps, omp, 'omp', true, rejectedOverride, pathEnv)
  }

  const fallback = deps.isWindows ? PI_FALLBACK_BINARY_WINDOWS : PI_FALLBACK_BINARY_POSIX
  return finalize(deps, fallback, 'fallback', false, rejectedOverride, pathEnv)
}

const SETTINGS_HINT = 'Settings > Agent Configuration > Agent Installation'
const INSTALL_HINT =
  'Install Pi with:\n  npm install -g @earendil-works/pi-coding-agent\nor install OMP with:\n  bun install -g @oh-my-pi/pi-coding-agent'

/**
 * Explain a failed resolution. A stale configured path is the headline when
 * one exists, because "Pi is not installed" is actively misleading to someone
 * who did point the app at their install.
 */
export function describePiResolutionFailure(resolution: PiResolution): string {
  if (resolution.rejectedOverride) {
    return (
      `The Pi executable path set in ${SETTINGS_HINT} does not exist:\n  ${resolution.rejectedOverride}\n\n` +
      'Point it at Pi\'s cli.js (or its install directory), or clear the field to auto-detect. ' +
      `Auto-detection also found nothing.\n\n${INSTALL_HINT}`
    )
  }
  return (
    `Pi binary not found. Searched the login shell PATH, npm's global prefix, node version managers ` +
    `(nvm, fnm, volta, asdf, mise, nodenv, n) and common install locations.\n\n${INSTALL_HINT}\n\n` +
    `Already installed? Set the full path to Pi's cli.js in ${SETTINGS_HINT}.`
  )
}
