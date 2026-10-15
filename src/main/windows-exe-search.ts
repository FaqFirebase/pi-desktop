/**
 * Windows looks for a program named without a folder (`git`, `gh`, `node`) in
 * the current folder before it searches PATH. The app starts most programs
 * with the workspace as the working folder, and those names must resolve from
 * PATH. The `NoDefaultCurrentDirectoryInExePath` variable turns the
 * current-folder step off, and two readers matter here:
 *
 *   - libuv (every spawn and execFile) reads the app's OWN environment, so the
 *     variable has to be in process.env before anything spawns.
 *   - cmd.exe (shell: true, which a `.cmd`/`.bat` shim needs) reads its own
 *     environment, which is the env the app hands that child. npm and pnpm
 *     shims start a bare `node` or `bun`, which cmd.exe would otherwise look
 *     for in the workspace first.
 *
 * Windows checks only that the variable exists; its value has no effect.
 */
export const NO_CWD_EXE_SEARCH_VARIABLE = 'NoDefaultCurrentDirectoryInExePath'
const NO_CWD_EXE_SEARCH_VALUE = '1'
const NO_CWD_EXE_SEARCH_KEY = NO_CWD_EXE_SEARCH_VARIABLE.toLowerCase()
const WINDOWS_PLATFORM: NodeJS.Platform = 'win32'

/**
 * True when startup added the variable. False off Windows, and when the user's
 * own environment already had it: that value is theirs, so it reaches every
 * child as it is.
 */
let addedAtStartup = false

/** Windows names match in any case; a plain-object copy of process.env does not. */
function variableNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => name.toLowerCase() === NO_CWD_EXE_SEARCH_KEY)
}

/**
 * Turn the current-folder search off for every program this process starts
 * by name. Call it once on process.env at startup, before anything spawns.
 * Only Windows searches the current folder on its own, so other platforms are
 * left as they are.
 */
export function disableCwdExecutableSearch(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  addedAtStartup = platform === WINDOWS_PLATFORM && variableNames(env).length === 0
  if (addedAtStartup) env[NO_CWD_EXE_SEARCH_VARIABLE] = NO_CWD_EXE_SEARCH_VALUE
}

/**
 * The environment for one child. `viaCmd` is the spawn's `shell` flag: true
 * when cmd.exe starts the child, which is how a Windows `.cmd`/`.bat` shim runs.
 *
 * A direct launch drops the variable that startup added, so the user's own
 * tools (the terminal, and the commands Pi, OMP and the consultants run) find
 * programs as they do outside the app. A cmd.exe launch keeps it, because
 * cmd.exe resolves the shim's bare `node` or `bun` with it. The trade-off: the
 * agent such a shim starts inherits the variable too, so a cmd.exe that agent
 * starts also skips its current folder. The result is `env` itself when there
 * is nothing to drop; `env` is never changed.
 */
export function childProcessEnv(viaCmd: boolean, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (viaCmd || !addedAtStartup) return env
  const childEnv = { ...env }
  for (const name of variableNames(childEnv)) delete childEnv[name]
  return childEnv
}
