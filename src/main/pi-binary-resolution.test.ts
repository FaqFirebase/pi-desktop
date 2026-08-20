import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, sep } from 'node:path'
import {
  PI_CLI_REL,
  PI_FALLBACK_BINARY_POSIX,
  PI_FALLBACK_BINARY_WINDOWS,
  SHELL_PATH_END,
  SHELL_PATH_START,
  buildLoginShellArgs,
  compareVersionsDesc,
  describePiResolutionFailure,
  loginShellPath,
  mergePathEntries,
  normalizeOverride,
  parseShellPath,
  resolvePiBinary,
  versionManagerPrefixes,
} from './pi-binary-resolution'
import type { CaptureOptions, ResolutionDeps } from './pi-binary-resolution'

const POSIX_HOME = '/Users/tester'
const WINDOWS_HOME = 'C:\\Users\\tester'
const NVM_VERSION_OLD = 'v20.11.0'
const NVM_VERSION_NEW = 'v24.14.1'

interface FakeFs {
  /** Absolute file paths that exist. */
  files?: string[]
  /** Absolute directory paths that exist. */
  dirs?: string[]
}

interface FakeDepsInit extends FakeFs {
  isWindows?: boolean
  env?: NodeJS.ProcessEnv
  /** Keyed by `${command} ${args.join(' ')}`; value is stdout or null. */
  captures?: Record<string, string | null>
  /** Records every capture invocation for assertions. */
  captureLog?: Array<{ command: string; args: string[]; options: CaptureOptions }>
}

function fakeDeps(init: FakeDepsInit): ResolutionDeps {
  const files = new Set(init.files ?? [])
  const dirs = new Set(init.dirs ?? [])
  const captures = init.captures ?? {}
  return {
    isWindows: init.isWindows ?? false,
    env: init.env ?? { HOME: POSIX_HOME },
    exists: (p) => files.has(p) || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    // Separator follows path.join on the host, since that is what builds both
    // the fixture paths and the paths under test.
    listDir: (p) => {
      const prefix = /[/\\]$/.test(p) ? p : p + sep
      const children = new Set<string>()
      for (const entry of [...files, ...dirs]) {
        if (!entry.startsWith(prefix)) continue
        const head = entry.slice(prefix.length).split(/[/\\]/)[0]
        if (head) children.add(head)
      }
      return [...children]
    },
    capture: (command, args, options) => {
      init.captureLog?.push({ command, args, options })
      const key = [command, ...args].join(' ')
      return key in captures ? captures[key] : null
    },
  }
}

function markerOutput(path: string, noise = ''): string {
  return `${noise}${SHELL_PATH_START}${path}${SHELL_PATH_END}`
}

// ─── normalizeOverride ───────────────────────────────────────────────────────

test('normalizeOverride treats blank values as absent', () => {
  assert.equal(normalizeOverride(undefined, POSIX_HOME), null)
  assert.equal(normalizeOverride('', POSIX_HOME), null)
  assert.equal(normalizeOverride('   ', POSIX_HOME), null)
})

test('normalizeOverride treats the bare binary name as auto-detect', () => {
  assert.equal(normalizeOverride('pi', POSIX_HOME), null)
  assert.equal(normalizeOverride('  pi  ', POSIX_HOME), null)
  assert.equal(normalizeOverride('pi.cmd', POSIX_HOME), null)
  assert.equal(normalizeOverride('PI.CMD', POSIX_HOME), null)
})

test('normalizeOverride keeps omp as an explicit engine selector', () => {
  assert.equal(normalizeOverride('omp', POSIX_HOME), 'omp')
  assert.equal(normalizeOverride('OMP.EXE', POSIX_HOME), 'OMP.EXE')
})

test('normalizeOverride strips surrounding quotes pasted from a file manager', () => {
  assert.equal(normalizeOverride('"/opt/pi/cli.js"', POSIX_HOME), '/opt/pi/cli.js')
  assert.equal(normalizeOverride("'/opt/pi/cli.js'", POSIX_HOME), '/opt/pi/cli.js')
})

test('normalizeOverride expands a leading tilde to the home directory', () => {
  assert.equal(normalizeOverride('~/bin/pi', POSIX_HOME), join(POSIX_HOME, 'bin/pi'))
  // A bare tilde inside the path is not a home reference and stays literal.
  assert.equal(normalizeOverride('/opt/~backup/pi', POSIX_HOME), '/opt/~backup/pi')
})

test('normalizeOverride keeps an explicit absolute path intact', () => {
  const p = join(POSIX_HOME, '.nvm/versions/node', NVM_VERSION_NEW, 'lib', PI_CLI_REL)
  assert.equal(normalizeOverride(p, POSIX_HOME), p)
})

// ─── Login-shell PATH probe ──────────────────────────────────────────────────

test('parseShellPath extracts the PATH between the sentinel markers', () => {
  assert.equal(parseShellPath(markerOutput('/a:/b')), '/a:/b')
})

test('parseShellPath ignores rc-file noise printed around the markers', () => {
  const noisy = `Welcome to zsh\n${markerOutput('/a:/b')}\nsome trailing chatter`
  assert.equal(parseShellPath(noisy), '/a:/b')
})

test('parseShellPath returns null when the markers are missing', () => {
  assert.equal(parseShellPath('/a:/b'), null)
  assert.equal(parseShellPath(''), null)
  assert.equal(parseShellPath(SHELL_PATH_START + '/a'), null)
})

test('buildLoginShellArgs uses interactive login flags for POSIX shells', () => {
  const args = buildLoginShellArgs('/bin/zsh')
  assert.deepEqual(args.slice(0, 3), ['-i', '-l', '-c'])
  assert.match(args[3], /\$PATH/)
  assert.ok(args[3].includes(SHELL_PATH_START))
})

test('buildLoginShellArgs joins the PATH list for fish', () => {
  const args = buildLoginShellArgs('/usr/local/bin/fish')
  assert.deepEqual(args.slice(0, 3), ['-i', '-l', '-c'])
  assert.match(args[3], /string join : \$PATH/)
})

test('loginShellPath returns null on Windows without spawning a shell', () => {
  const captureLog: FakeDepsInit['captureLog'] = []
  const deps = fakeDeps({ isWindows: true, env: { USERPROFILE: WINDOWS_HOME }, captureLog })
  assert.equal(loginShellPath(deps), null)
  assert.equal(captureLog.length, 0)
})

test('loginShellPath returns the PATH reported by the user login shell', () => {
  const shellPath = `${POSIX_HOME}/.nvm/versions/node/${NVM_VERSION_NEW}/bin:/usr/bin`
  const deps = fakeDeps({
    env: { HOME: POSIX_HOME, SHELL: '/bin/zsh' },
    captures: {
      [['/bin/zsh', ...buildLoginShellArgs('/bin/zsh')].join(' ')]: markerOutput(shellPath),
    },
  })
  assert.equal(loginShellPath(deps), shellPath)
})

test('loginShellPath returns null when the shell probe produces no markers', () => {
  const deps = fakeDeps({ env: { HOME: POSIX_HOME, SHELL: '/bin/zsh' }, captures: {} })
  assert.equal(loginShellPath(deps), null)
})

test('mergePathEntries appends unseen entries and drops duplicates', () => {
  assert.equal(mergePathEntries('/usr/bin:/bin', '/bin:/opt/new:/usr/bin', false), '/usr/bin:/bin:/opt/new')
})

test('mergePathEntries handles an empty current PATH', () => {
  assert.equal(mergePathEntries('', '/opt/new', false), '/opt/new')
  assert.equal(mergePathEntries('/usr/bin', '', false), '/usr/bin')
})

test('mergePathEntries uses the Windows separator', () => {
  assert.equal(mergePathEntries('C:\\a', 'C:\\a;C:\\b', true), 'C:\\a;C:\\b')
})

// ─── Version-manager discovery ───────────────────────────────────────────────

test('compareVersionsDesc orders semantic versions newest first', () => {
  const sorted = ['v20.11.0', 'v24.14.1', 'v8.9.0', 'v24.2.0'].sort(compareVersionsDesc)
  assert.deepEqual(sorted, ['v24.14.1', 'v24.2.0', 'v20.11.0', 'v8.9.0'])
})

test('versionManagerPrefixes lists nvm node versions newest first', () => {
  const nvmRoot = join(POSIX_HOME, '.nvm', 'versions', 'node')
  const deps = fakeDeps({
    dirs: [nvmRoot, join(nvmRoot, NVM_VERSION_OLD), join(nvmRoot, NVM_VERSION_NEW)],
  })
  const prefixes = versionManagerPrefixes(deps)
  assert.deepEqual(
    prefixes.filter((p) => p.startsWith(nvmRoot)),
    [join(nvmRoot, NVM_VERSION_NEW), join(nvmRoot, NVM_VERSION_OLD)]
  )
})

test('versionManagerPrefixes covers fnm, volta, asdf, mise, nodenv and n', () => {
  const roots = {
    fnmLinux: join(POSIX_HOME, '.local', 'share', 'fnm', 'node-versions'),
    fnmMac: join(POSIX_HOME, 'Library', 'Application Support', 'fnm', 'node-versions'),
    volta: join(POSIX_HOME, '.volta', 'tools', 'image', 'node'),
    asdf: join(POSIX_HOME, '.asdf', 'installs', 'nodejs'),
    mise: join(POSIX_HOME, '.local', 'share', 'mise', 'installs', 'node'),
    nodenv: join(POSIX_HOME, '.nodenv', 'versions'),
    n: join('/usr/local/n', 'versions', 'node'),
  }
  const dirs: string[] = []
  for (const root of Object.values(roots)) {
    dirs.push(root, join(root, NVM_VERSION_NEW))
  }
  const prefixes = versionManagerPrefixes(fakeDeps({ dirs }))
  assert.ok(prefixes.includes(join(roots.fnmLinux, NVM_VERSION_NEW, 'installation')))
  assert.ok(prefixes.includes(join(roots.fnmMac, NVM_VERSION_NEW, 'installation')))
  assert.ok(prefixes.includes(join(roots.volta, NVM_VERSION_NEW)))
  assert.ok(prefixes.includes(join(roots.asdf, NVM_VERSION_NEW)))
  assert.ok(prefixes.includes(join(roots.mise, NVM_VERSION_NEW)))
  assert.ok(prefixes.includes(join(roots.nodenv, NVM_VERSION_NEW)))
  assert.ok(prefixes.includes(join(roots.n, NVM_VERSION_NEW)))
})

test('versionManagerPrefixes honors FNM_DIR and ASDF_DATA_DIR overrides', () => {
  const fnmDir = '/opt/fnm'
  const asdfDir = '/opt/asdf'
  const deps = fakeDeps({
    env: { HOME: POSIX_HOME, FNM_DIR: fnmDir, ASDF_DATA_DIR: asdfDir },
    dirs: [
      join(fnmDir, 'node-versions'),
      join(fnmDir, 'node-versions', NVM_VERSION_NEW),
      join(asdfDir, 'installs', 'nodejs'),
      join(asdfDir, 'installs', 'nodejs', NVM_VERSION_NEW),
    ],
  })
  const prefixes = versionManagerPrefixes(deps)
  assert.ok(prefixes.includes(join(fnmDir, 'node-versions', NVM_VERSION_NEW, 'installation')))
  assert.ok(prefixes.includes(join(asdfDir, 'installs', 'nodejs', NVM_VERSION_NEW)))
})

test('versionManagerPrefixes covers nvm-windows, fnm and volta on Windows', () => {
  const appData = join(WINDOWS_HOME, 'AppData', 'Roaming')
  const localAppData = join(WINDOWS_HOME, 'AppData', 'Local')
  const nvmRoot = join(appData, 'nvm')
  const fnmRoot = join(appData, 'fnm', 'node-versions')
  const voltaRoot = join(localAppData, 'Volta', 'tools', 'image', 'node')
  const deps = fakeDeps({
    isWindows: true,
    env: { USERPROFILE: WINDOWS_HOME, APPDATA: appData, LOCALAPPDATA: localAppData },
    dirs: [
      nvmRoot,
      join(nvmRoot, NVM_VERSION_NEW),
      fnmRoot,
      join(fnmRoot, NVM_VERSION_NEW),
      voltaRoot,
      join(voltaRoot, NVM_VERSION_NEW),
    ],
  })
  const prefixes = versionManagerPrefixes(deps)
  assert.ok(prefixes.includes(join(nvmRoot, NVM_VERSION_NEW)))
  assert.ok(prefixes.includes(join(fnmRoot, NVM_VERSION_NEW, 'installation')))
  assert.ok(prefixes.includes(join(voltaRoot, NVM_VERSION_NEW)))
})

test('versionManagerPrefixes returns nothing when no manager is installed', () => {
  assert.deepEqual(versionManagerPrefixes(fakeDeps({})), [])
})

// ─── resolvePiBinary: configured override ────────────────────────────────────

test('resolvePiBinary resolves the omp engine selector from PATH', () => {
  const deps = fakeDeps({ env: { HOME: POSIX_HOME, PATH: '/opt/omp' }, files: ['/opt/omp/omp'] })
  const resolution = resolvePiBinary(deps, 'omp')
  assert.deepEqual(resolution, {
    script: '/opt/omp/omp',
    useNode: false,
    needsShell: false,
    source: 'override',
    found: true,
    rejectedOverride: null,
    pathEnv: '/opt/omp',
  })
})

test('resolvePiBinary auto-detects OMP when Pi is not installed', () => {
  const deps = fakeDeps({ env: { HOME: POSIX_HOME, PATH: '/opt/omp' }, files: ['/opt/omp/omp'] })
  const resolution = resolvePiBinary(deps, null)
  assert.equal(resolution.script, '/opt/omp/omp')
  assert.equal(resolution.source, 'omp')
})

test('resolvePiBinary uses a configured cli.js override ahead of auto-detection', () => {
  const override = join(POSIX_HOME, '.nvm/versions/node', NVM_VERSION_NEW, 'lib', PI_CLI_REL)
  const deps = fakeDeps({ files: [override, '/usr/local/bin/pi'] })
  const resolution = resolvePiBinary(deps, override)
  assert.equal(resolution.script, override)
  assert.equal(resolution.source, 'override')
  assert.equal(resolution.useNode, true)
  assert.equal(resolution.needsShell, false)
  assert.equal(resolution.found, true)
  assert.equal(resolution.rejectedOverride, null)
})

test('resolvePiBinary resolves cli.js when the override points at a directory', () => {
  const installDir = join(POSIX_HOME, '.nvm/versions/node', NVM_VERSION_NEW)
  const cliJs = join(installDir, 'lib', PI_CLI_REL)
  const deps = fakeDeps({ files: [cliJs], dirs: [installDir] })
  const resolution = resolvePiBinary(deps, installDir)
  assert.equal(resolution.script, cliJs)
  assert.equal(resolution.source, 'override')
  assert.equal(resolution.useNode, true)
})

test('resolvePiBinary accepts a shim override and does not use node for it', () => {
  const override = join(POSIX_HOME, '.nvm/versions/node', NVM_VERSION_NEW, 'bin', 'pi')
  const deps = fakeDeps({ files: [override] })
  const resolution = resolvePiBinary(deps, override)
  assert.equal(resolution.script, override)
  assert.equal(resolution.useNode, false)
  assert.equal(resolution.source, 'override')
})

test('resolvePiBinary reports a missing override and still auto-detects', () => {
  const missing = '/does/not/exist/cli.js'
  const detected = '/usr/local/bin/pi'
  const deps = fakeDeps({ files: [detected] })
  const resolution = resolvePiBinary(deps, missing)
  assert.equal(resolution.rejectedOverride, missing)
  assert.equal(resolution.script, detected)
  assert.equal(resolution.found, true)
  assert.notEqual(resolution.source, 'override')
})

test('resolvePiBinary marks a Windows .cmd override as needing a shell', () => {
  const override = join(WINDOWS_HOME, 'AppData', 'Roaming', 'npm', 'pi.cmd')
  const deps = fakeDeps({
    isWindows: true,
    env: { USERPROFILE: WINDOWS_HOME },
    files: [override],
  })
  const resolution = resolvePiBinary(deps, override)
  assert.equal(resolution.script, override)
  assert.equal(resolution.needsShell, true)
  assert.equal(resolution.useNode, false)
})

// ─── resolvePiBinary: auto-detection order ───────────────────────────────────

test('resolvePiBinary prefers the npm global prefix', () => {
  const prefix = '/opt/homebrew'
  const cliJs = join(prefix, 'lib', PI_CLI_REL)
  const deps = fakeDeps({
    env: { HOME: POSIX_HOME, PATH: '/usr/bin' },
    files: [cliJs, '/usr/bin/pi'],
    dirs: [prefix],
    captures: { 'npm prefix -g': `${prefix}\n` },
  })
  const resolution = resolvePiBinary(deps, null)
  assert.equal(resolution.script, cliJs)
  assert.equal(resolution.source, 'npm-prefix')
})

test('resolvePiBinary falls back to a PATH hit when npm is unavailable', () => {
  const onPath = '/usr/bin/pi'
  const deps = fakeDeps({ env: { HOME: POSIX_HOME, PATH: '/usr/bin' }, files: [onPath] })
  const resolution = resolvePiBinary(deps, null)
  assert.equal(resolution.script, onPath)
  assert.equal(resolution.source, 'path')
})

test('resolvePiBinary prefers cli.js over a Windows shim found on PATH', () => {
  const shimDir = join(WINDOWS_HOME, 'AppData', 'Roaming', 'npm')
  const shim = join(shimDir, 'pi.cmd')
  const cliJs = join(shimDir, PI_CLI_REL)
  const deps = fakeDeps({
    isWindows: true,
    env: { USERPROFILE: WINDOWS_HOME, PATH: shimDir, PATHEXT: '.EXE;.CMD' },
    files: [shim, cliJs],
  })
  const resolution = resolvePiBinary(deps, null)
  assert.equal(resolution.script, cliJs)
  assert.equal(resolution.useNode, true)
  assert.equal(resolution.needsShell, false)
})

test('resolvePiBinary finds an nvm install when npm and PATH are both unreachable', () => {
  // Issue #45: a macOS app launched from Finder gets a minimal PATH, so neither
  // `npm prefix -g` nor a PATH search can see an nvm-managed global install.
  const versionDir = join(POSIX_HOME, '.nvm', 'versions', 'node', NVM_VERSION_NEW)
  const cliJs = join(versionDir, 'lib', PI_CLI_REL)
  const deps = fakeDeps({
    env: { HOME: POSIX_HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    files: [cliJs],
    dirs: [join(POSIX_HOME, '.nvm', 'versions', 'node'), versionDir],
  })
  const resolution = resolvePiBinary(deps, null)
  assert.equal(resolution.script, cliJs)
  assert.equal(resolution.source, 'version-manager')
  assert.equal(resolution.useNode, true)
  assert.equal(resolution.found, true)
})

test('resolvePiBinary picks the newest nvm version that actually has Pi installed', () => {
  const root = join(POSIX_HOME, '.nvm', 'versions', 'node')
  const oldCli = join(root, NVM_VERSION_OLD, 'lib', PI_CLI_REL)
  const deps = fakeDeps({
    env: { HOME: POSIX_HOME, PATH: '/usr/bin' },
    files: [oldCli],
    dirs: [root, join(root, NVM_VERSION_OLD), join(root, NVM_VERSION_NEW)],
  })
  const resolution = resolvePiBinary(deps, null)
  assert.equal(resolution.script, oldCli)
  assert.equal(resolution.source, 'version-manager')
})

test('resolvePiBinary falls back to a common install location', () => {
  const cliJs = join('/usr/local/lib', PI_CLI_REL)
  const deps = fakeDeps({ env: { HOME: POSIX_HOME, PATH: '/nowhere' }, files: [cliJs] })
  const resolution = resolvePiBinary(deps, null)
  assert.equal(resolution.script, cliJs)
  assert.equal(resolution.source, 'common-location')
})

test('resolvePiBinary reports not-found instead of pretending the fallback exists', () => {
  const deps = fakeDeps({ env: { HOME: POSIX_HOME, PATH: '/nowhere' } })
  const resolution = resolvePiBinary(deps, null)
  assert.equal(resolution.script, PI_FALLBACK_BINARY_POSIX)
  assert.equal(resolution.source, 'fallback')
  assert.equal(resolution.found, false)
})

test('resolvePiBinary falls back to the .cmd name on Windows', () => {
  const deps = fakeDeps({ isWindows: true, env: { USERPROFILE: WINDOWS_HOME, PATH: '' } })
  const resolution = resolvePiBinary(deps, null)
  assert.equal(resolution.script, PI_FALLBACK_BINARY_WINDOWS)
  assert.equal(resolution.found, false)
})

// ─── resolvePiBinary: PATH augmentation ──────────────────────────────────────

test('resolvePiBinary merges the login-shell PATH into the environment it reports', () => {
  const nvmBin = join(POSIX_HOME, '.nvm', 'versions', 'node', NVM_VERSION_NEW, 'bin')
  const shell = '/bin/zsh'
  const deps = fakeDeps({
    env: { HOME: POSIX_HOME, SHELL: shell, PATH: '/usr/bin:/bin' },
    files: [join(nvmBin, 'pi')],
    captures: {
      [[shell, ...buildLoginShellArgs(shell)].join(' ')]: markerOutput(`${nvmBin}:/usr/bin`),
    },
  })
  const resolution = resolvePiBinary(deps, null)
  assert.equal(resolution.pathEnv, `/usr/bin:/bin:${nvmBin}`)
  assert.equal(resolution.script, join(nvmBin, 'pi'))
  assert.equal(resolution.source, 'path')
})

test('resolvePiBinary runs npm with the augmented PATH so version-managed npm is reachable', () => {
  const nvmBin = join(POSIX_HOME, '.nvm', 'versions', 'node', NVM_VERSION_NEW, 'bin')
  const shell = '/bin/zsh'
  const captureLog: FakeDepsInit['captureLog'] = []
  const deps = fakeDeps({
    env: { HOME: POSIX_HOME, SHELL: shell, PATH: '/usr/bin' },
    captureLog,
    captures: {
      [[shell, ...buildLoginShellArgs(shell)].join(' ')]: markerOutput(nvmBin),
    },
  })
  resolvePiBinary(deps, null)
  const npmCall = captureLog.find((c) => c.args.includes('prefix'))
  assert.ok(npmCall, 'expected npm prefix -g to be attempted')
  assert.equal(npmCall.options.pathEnv, `/usr/bin:${nvmBin}`)
})

test('resolvePiBinary leaves PATH untouched when the shell probe fails', () => {
  const deps = fakeDeps({ env: { HOME: POSIX_HOME, SHELL: '/bin/zsh', PATH: '/usr/bin' } })
  assert.equal(resolvePiBinary(deps, null).pathEnv, '/usr/bin')
})

// ─── Failure messaging ───────────────────────────────────────────────────────

test('describePiResolutionFailure calls out a configured path that does not exist', () => {
  const deps = fakeDeps({ env: { HOME: POSIX_HOME, PATH: '/nowhere' } })
  const message = describePiResolutionFailure(resolvePiBinary(deps, '/bad/cli.js'))
  assert.match(message, /\/bad\/cli\.js/)
  assert.match(message, /Settings/)
  // The stale "not installed" advice must not be the headline when the user
  // did configure a path -- that is what made issue #45 confusing.
  assert.ok(!message.startsWith('Pi binary not found at resolved path'))
})

test('describePiResolutionFailure gives install guidance when nothing was configured', () => {
  const deps = fakeDeps({ env: { HOME: POSIX_HOME, PATH: '/nowhere' } })
  const message = describePiResolutionFailure(resolvePiBinary(deps, null))
  assert.match(message, /npm install -g @earendil-works\/pi-coding-agent/)
  assert.match(message, /Settings/)
})
