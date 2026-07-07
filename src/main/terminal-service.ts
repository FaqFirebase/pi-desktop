import { existsSync } from 'fs'
import os from 'os'
import pty, { type IPty } from 'node-pty'
import type { TerminalStartOptions, TerminalStartResult } from '../shared/ipc-contracts'

type TerminalDataHandler = (data: string) => void
type TerminalExitHandler = (event: { exitCode: number; signal?: number }) => void

export class TerminalService {
  private terminal: IPty | null = null
  private disposables: { dispose(): void }[] = []
  private cwd = os.homedir()

  start(
    options: TerminalStartOptions,
    onData: TerminalDataHandler,
    onExit: TerminalExitHandler
  ): TerminalStartResult {
    this.stop()

    const shell = getShell()
    const cwd = getCwd(options.cwd)
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
    } as Record<string, string>

    this.cwd = cwd
    // node-pty's `encoding` option calls setEncoding() under the hood,
    // which Windows (conpty/winpty) does not support and logs a warning
    // for. Only pass it on POSIX platforms.
    const terminal = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd,
      env,
      ...(process.platform === 'win32' ? {} : { encoding: 'utf8' }),
    })
    this.terminal = terminal

    this.disposables.push(terminal.onData(onData))
    this.disposables.push(
      terminal.onExit(({ exitCode, signal }) => {
        // Guard against a stale exit from a killed pty clobbering a terminal
        // that has since been recreated (e.g. after a view round-trip).
        if (this.terminal === terminal) this.terminal = null
        onExit({ exitCode, signal })
      })
    )

    return {
      pid: terminal.pid,
      shell,
      cwd,
    }
  }

  write(data: string): void {
    this.terminal?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) {
      this.terminal?.resize(cols, rows)
    }
  }

  stop(): void {
    if (!this.terminal) return
    // Detach handlers before killing so the resulting exit event neither
    // broadcasts a spurious "process exited" into a freshly-created terminal
    // nor nulls it out. See the identity guard in start().
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    const terminal = this.terminal
    this.terminal = null
    terminal.kill()
  }

  getCwd(): string {
    return this.cwd
  }
}

function getShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'powershell.exe'
  }
  return process.env.SHELL ?? '/bin/bash'
}

function getCwd(cwd?: string): string {
  if (cwd && existsSync(cwd)) return cwd
  return os.homedir()
}
