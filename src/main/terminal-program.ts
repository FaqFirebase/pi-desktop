import { escapeCmdSpawn } from './cmd-escape'
import { isCmdShim } from './pi-binary-resolution'

/**
 * The program a PTY starts. A string `args` is the Windows command line,
 * which node-pty passes as is.
 */
export interface TerminalProgram {
  file: string
  args: string[] | string
}

// cmd.exe: no AutoRun commands, keep the quotes of the command, run it and exit.
const CMD_RUN_PREFIX = '/d /s /c'

/**
 * Start `executable` directly with `args`. A Windows `.cmd`/`.bat` shim cannot
 * start without cmd.exe, so it runs through `comspec` with escaped arguments.
 */
export function terminalProgramFor(executable: string, args: readonly string[], isWindows: boolean, comspec: string): TerminalProgram {
  if (!isCmdShim(isWindows, executable)) return { file: executable, args: [...args] }
  const escaped = escapeCmdSpawn(true, executable, args)
  return { file: comspec, args: `${CMD_RUN_PREFIX} "${[escaped.file, ...escaped.args].join(' ')}"` }
}
