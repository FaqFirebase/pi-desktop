import type { TerminalService } from './terminal-service'
import type { TerminalProgram } from './terminal-program'
import type { TerminalStartResult } from '../shared/ipc-contracts'

type Terminal = Pick<TerminalService, 'start' | 'write' | 'resize' | 'stop'>

export const NO_EDITOR_PROGRAM_ERROR = 'No editor is waiting to start'

/** Owns PTYs independently of the currently visible project/panel. */
export class WorkspaceTerminals {
  private entries = new Map<string, { service: Terminal; result: TerminalStartResult }>()
  // Programs waiting for their slot's first start; the newest one wins.
  private pendingPrograms = new Map<string, TerminalProgram>()

  /**
   * `requiresProgram` names the keys that never start the default shell: they
   * start only a program `prepare` saved for them.
   */
  constructor(
    private readonly create: () => Terminal,
    private readonly requiresProgram: (key: string) => boolean,
  ) {}

  /** Save the program the next start of `key` runs. */
  prepare(key: string, program: TerminalProgram): void {
    this.pendingPrograms.set(key, program)
  }

  isRunning(key: string): boolean {
    return this.entries.has(key)
  }

  start(key: string, ...[options, onData, onExit]: Parameters<TerminalService['start']>): TerminalStartResult {
    const existing = this.entries.get(key)
    if (existing) return existing.result
    const program = this.pendingPrograms.get(key)
    if (!program && this.requiresProgram(key)) throw new Error(NO_EDITOR_PROGRAM_ERROR)
    const service = this.create()
    // Drop a shell that exited on its own (e.g. `exit`), so the next start
    // spawns a fresh one instead of returning the dead entry.
    const result = service.start(options, onData, (event) => {
      if (this.entries.get(key)?.service === service) this.entries.delete(key)
      onExit(event)
    }, program)
    this.pendingPrograms.delete(key)
    this.entries.set(key, { service, result })
    return result
  }

  write(key: string, data: string): void {
    this.entries.get(key)?.service.write(data)
  }

  resize(key: string, cols: number, rows: number): void {
    this.entries.get(key)?.service.resize(cols, rows)
  }

  stop(key: string): void {
    const entry = this.entries.get(key)
    this.entries.delete(key)
    this.pendingPrograms.delete(key)
    entry?.service.stop()
  }

  stopAll(): void {
    for (const key of this.entries.keys()) this.stop(key)
    this.pendingPrograms.clear()
  }
}
