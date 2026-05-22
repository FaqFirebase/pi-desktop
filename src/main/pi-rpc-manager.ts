import { ChildProcess, SpawnOptions, spawn } from 'child_process'
import { existsSync } from 'fs'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import type {
  PiRpcEvent,
  PiStartOptions,
  PiProcessStatus,
  PiStatus,
  PiResponseEvent,
} from '../shared/ipc-contracts'

/**
 * Manages a PI RPC child process.
 *
 * Responsibilities:
 * - Spawn/kill PI in --mode rpc
 * - Parse JSONL from stdout (LF-delimited, no Unicode line separators)
 * - Route events to subscribers
 * - Correlate request/response via id field
 * - Handle extension UI request/response sub-protocol
 */

const JSONL_NEWLINE = '\n'
const RPC_MODE = 'rpc'
const NO_SESSION_FLAG = '--no-session'
const MODE_FLAG = '--mode'
const PROVIDER_FLAG = '--provider'
const MODEL_FLAG = '--model'
const SESSION_FLAG = '--session'
const PI_FALLBACK_BINARY = 'pi'
const DEFAULT_NODE_BINARY = '/usr/bin/node'
const SPAWN_STARTUP_TIMEOUT_MS = 15_000
const FORCE_KILL_TIMEOUT_MS = 3_000

function findPiBinary(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const candidates = [
    `${home}/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`,
    `${home}/.npm-global/bin/pi`,
    '/usr/local/bin/pi',
    '/usr/bin/pi',
    `${home}/.local/bin/pi`,
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return PI_FALLBACK_BINARY
}

const PI_SCRIPT = findPiBinary()
const USE_NODE = PI_SCRIPT.endsWith('.js')
const NODE_BINARY = process.env.NODE || process.env.npm_node_execpath || DEFAULT_NODE_BINARY
console.log('[PI] Using:', USE_NODE ? `${NODE_BINARY} ${PI_SCRIPT}` : PI_SCRIPT)

// Exported so ipc-handlers can run `pi install/remove/update` with the same
// binary that was resolved here — Electron's PATH won't have `pi` directly.
export const PI_CLI = { script: PI_SCRIPT, node: NODE_BINARY, useNode: USE_NODE } as const

const MAX_PENDING_RESPONSES = 64
const RESPONSE_TIMEOUT_MS = 30_000

interface PendingResponse {
  resolve: (event: PiResponseEvent) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PiRpcManager extends EventEmitter {
  private process: ChildProcess | null = null
  private status: PiProcessStatus = 'stopped'
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private pendingResponses = new Map<string, PendingResponse>()
  private nextRequestId = 1
  private decoder = new StringDecoder('utf8')
  private startInFlight: Promise<PiStatus> | null = null

  getStatus(): PiStatus {
    return {
      status: this.status,
      pid: this.process?.pid ?? null,
      error: this.stderrBuffer || null,
    }
  }

  async start(options: PiStartOptions = {}): Promise<PiStatus> {
    if (this.status === 'running') {
      return this.getStatus()
    }
    // Coalesce concurrent starts during the 'starting' window so we never
    // spawn duplicate child processes when two callers race.
    if (this.startInFlight) {
      return this.startInFlight
    }

    this.startInFlight = this.doStart(options).finally(() => {
      this.startInFlight = null
    })
    return this.startInFlight
  }

  private async doStart(options: PiStartOptions): Promise<PiStatus> {
    this.kill()
    this.setStatus('starting')
    this.stderrBuffer = ''

    const args = this.buildArgs(options)

    try {
      const spawnOptions: SpawnOptions = {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: { ...process.env },
      }

      console.log('[PI] Spawning with cwd:', options.cwd)
      const proc = USE_NODE
        ? spawn(NODE_BINARY, [PI_SCRIPT, ...args], spawnOptions)
        : spawn(PI_SCRIPT, args, spawnOptions)
      this.process = proc

      proc.on('error', (err) => {
        console.error('[PI] Spawn error:', err.message)
      })

      proc.on('exit', (code, signal) => {
        console.log('[PI] Process exited with code:', code, 'signal:', signal, 'pid:', proc.pid)
      })

      this.setupStreams()

      return new Promise<PiStatus>((resolve) => {
        const onFirstData = (): void => {
          this.process?.stdout?.removeListener('data', onFirstData)
          this.setStatus('running')
          resolve(this.getStatus())
        }

        this.process!.stdout?.on('data', onFirstData)

        this.process!.on('error', (err) => {
          this.setStatus('error')
          this.stderrBuffer = err.message
          resolve(this.getStatus())
        })

        this.process!.on('exit', (code, signal) => {
          this.setStatus('stopped')
          this.emit('exit', { code, signal })
          this.rejectAllPending('PI process exited')
        })

        // Timeout for startup
        setTimeout(() => {
          if (this.status === 'starting') {
            this.setStatus('error')
            this.stderrBuffer = 'PI startup timeout'
            resolve(this.getStatus())
          }
        }, SPAWN_STARTUP_TIMEOUT_MS)
      })
    } catch (err) {
      this.setStatus('error')
      this.stderrBuffer = err instanceof Error ? err.message : String(err)
      return this.getStatus()
    }
  }

  stop(): void {
    this.kill()
    this.setStatus('stopped')
  }

  restart(options: PiStartOptions = {}): Promise<PiStatus> {
    this.kill()
    return this.start(options)
  }

  /**
   * Send a command to the PI RPC process.
   * Returns a correlated response if an id is provided.
   */
  async sendCommand(command: Record<string, unknown>): Promise<PiResponseEvent | null> {
    if (!this.process?.stdin || this.status !== 'running') {
      throw new Error('PI process is not running')
    }

    const id = `req-${this.nextRequestId++}`
    const cmdWithId = { ...command, id }
    const line = JSON.stringify(cmdWithId) + JSONL_NEWLINE

    return new Promise<PiResponseEvent | null>((resolve, reject) => {
      // Check capacity BEFORE allocating a slot so the limit is exact.
      if (this.pendingResponses.size >= MAX_PENDING_RESPONSES) {
        reject(new Error('Too many pending responses'))
        return
      }

      const timer = setTimeout(() => {
        this.pendingResponses.delete(id)
        reject(new Error(`Command ${command.type} timed out after ${RESPONSE_TIMEOUT_MS}ms`))
      }, RESPONSE_TIMEOUT_MS)

      this.pendingResponses.set(id, { resolve, reject, timer })

      this.process!.stdin!.write(line, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pendingResponses.delete(id)
          reject(err)
        }
      })
    })
  }

  /**
   * Send a command without waiting for a correlated response.
   */
  sendCommandFireAndForget(command: Record<string, unknown>): void {
    if (!this.process?.stdin || this.status !== 'running') {
      return // Silently ignore if PI isn't running
    }

    const line = JSON.stringify(command) + JSONL_NEWLINE
    try {
      this.process.stdin.write(line)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EPIPE') {
        throw err
      }
      // EPIPE means PI process exited
      this.setStatus('stopped')
    }
  }

  /**
   * Respond to an extension UI request.
   */
  sendExtensionUiResponse(id: string, response: Record<string, unknown>): void {
    this.sendCommandFireAndForget({
      type: 'extension_ui_response',
      id,
      ...response,
    })
  }

  private buildArgs(options: PiStartOptions): string[] {
    const args: string[] = [MODE_FLAG, RPC_MODE]

    if (options.noSession) {
      args.push(NO_SESSION_FLAG)
    }

    if (options.provider) {
      args.push(PROVIDER_FLAG, options.provider)
    }

    if (options.model) {
      args.push(MODEL_FLAG, options.model)
    }

    if (options.sessionPath) {
      args.push(SESSION_FLAG, options.sessionPath)
    }

    if (options.args) {
      args.push(...options.args)
    }

    return args
  }

  private setupStreams(): void {
    if (!this.process) return

    // stdout: JSONL events
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += this.decoder.write(chunk)

      while (true) {
        const newlineIndex = this.stdoutBuffer.indexOf('\n')
        if (newlineIndex === -1) break

        let line = this.stdoutBuffer.slice(0, newlineIndex)
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)

        // Strip optional \r
        if (line.endsWith('\r')) {
          line = line.slice(0, -1)
        }

        if (line.length > 0) {
          this.handleLine(line)
        }
      }
    })

    this.process.stdout?.on('end', () => {
      this.stdoutBuffer += this.decoder.end()
      if (this.stdoutBuffer.length > 0) {
        let line = this.stdoutBuffer
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.length > 0) this.handleLine(line)
      }
      this.stdoutBuffer = ''
    })

    // stderr: capture for diagnostics
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrBuffer += text
      this.emit('stderr', text)
      console.log('[PI STDERR]:', text.slice(0, 200))
    })
  }

  private handleLine(line: string): void {
    let event: PiRpcEvent
    try {
      event = JSON.parse(line) as PiRpcEvent
    } catch {
      this.emit('parse-error', line)
      return
    }

    // Correlate responses with pending requests
    if (event.type === 'response') {
      const responseEvent = event as PiResponseEvent
      if (responseEvent.id) {
        const pending = this.pendingResponses.get(responseEvent.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingResponses.delete(responseEvent.id)
          pending.resolve(responseEvent)
          return
        }
      }
    }

    // Emit all events for subscribers
    this.emit('event', event)
    this.emit(event.type, event)
  }

  private setStatus(status: PiProcessStatus): void {
    if (this.status !== status) {
      this.status = status
      this.emit('status-change', status)
    }
  }

  private kill(): void {
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer)
      pending.reject(new Error('PI process killed'))
    }
    this.pendingResponses.clear()

    if (this.process) {
      const proc = this.process
      proc.removeAllListeners()
      proc.stdout?.removeAllListeners()
      proc.stderr?.removeAllListeners()
      proc.stdin?.end()

      // Kill entire process group (negative PID)
      try {
        if (proc.pid) {
          process.kill(-proc.pid, 'SIGTERM')
        }
      } catch {
        proc.kill('SIGTERM')
      }

      // Force kill after timeout
      setTimeout(() => {
        try {
          if (proc.pid && !proc.killed) {
            process.kill(-proc.pid, 'SIGKILL')
          }
        } catch {
          try { proc.kill('SIGKILL') } catch { /* already dead */ }
        }
      }, FORCE_KILL_TIMEOUT_MS)

      this.process = null
    }

    this.stdoutBuffer = ''
    this.decoder = new StringDecoder('utf8')
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pendingResponses.clear()
  }
}
