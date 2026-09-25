import type { TerminalService } from './terminal-service'
import type { TerminalStartResult } from '../shared/ipc-contracts'

type Terminal = Pick<TerminalService, 'start' | 'write' | 'resize' | 'stop'>

/** Owns PTYs independently of the currently visible project/panel. */
export class WorkspaceTerminals {
  private entries = new Map<string, { service: Terminal; result: TerminalStartResult }>()

  constructor(private readonly create: () => Terminal) {}

  start(workspaceId: string, ...args: Parameters<TerminalService['start']>): TerminalStartResult {
    const existing = this.entries.get(workspaceId)
    if (existing) return existing.result
    const service = this.create()
    const result = service.start(...args)
    this.entries.set(workspaceId, { service, result })
    return result
  }

  write(workspaceId: string, data: string): void {
    this.entries.get(workspaceId)?.service.write(data)
  }

  resize(workspaceId: string, cols: number, rows: number): void {
    this.entries.get(workspaceId)?.service.resize(cols, rows)
  }

  stop(workspaceId: string): void {
    const entry = this.entries.get(workspaceId)
    this.entries.delete(workspaceId)
    entry?.service.stop()
  }

  stopAll(): void {
    for (const id of this.entries.keys()) this.stop(id)
  }
}
