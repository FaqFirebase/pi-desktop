import { existsSync } from 'fs'
import os from 'os'
import pty, { type IPty } from 'node-pty'
import type { TerminalStartOptions, TerminalStartResult } from '../shared/ipc-contracts'

type TerminalDataHandler = (data: string) => void
type TerminalExitHandler = (event: { exitCode: number; signal?: number }) => void

export class TerminalService {
  private terminal: IPty | null = null
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
    this.terminal = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd,
      env,
      encoding: 'utf8',
    })

    this.terminal.onData(onData)
    this.terminal.onExit(({ exitCode, signal }) => {
      this.terminal = null
      onExit({ exitCode, signal })
    })

    return {
      pid: this.terminal.pid,
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
    this.terminal.kill()
    this.terminal = null
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
