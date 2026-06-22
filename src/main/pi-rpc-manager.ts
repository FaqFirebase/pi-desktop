import { ChildProcess, SpawnOptions, spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join, delimiter as PATH_DELIMITER } from 'path'
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
 * Manages a Pi RPC child process.
 *
 * Responsibilities:
 * - Spawn/kill Pi in --mode rpc
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
const CONTINUE_FLAG = '--continue'
const IS_WINDOWS = process.platform === 'win32'
const PI_FALLBACK_BINARY = IS_WINDOWS ? 'pi.cmd' : 'pi'
const SPAWN_STARTUP_TIMEOUT_MS = 15_000
// Pi's RPC mode is request/response — it emits nothing on connect. After this
// settle window, a still-alive process is considered ready.
const PROCESS_SETTLE_MS = 2_000
const FORCE_KILL_TIMEOUT_MS = 3_000
const PI_PACKAGE = '@earendil-works/pi-coding-agent'
const PI_CLI_REL = join('node_modules', PI_PACKAGE, 'dist', 'cli.js')

/**
 * Search PATH for an executable. Returns the absolute path or null.
 * On Windows, also tries PATHEXT extensions (.cmd, .exe, .ps1, .bat).
 */
function whichInPath(name: string): string | null {
  const pathDirs = (process.env.PATH ?? '').split(PATH_DELIMITER).filter(Boolean)
  const exts = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
    : ['']
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Ask npm itself where its global prefix is. Most reliable way to find npm
 * globals across every install method (default Node installer, fnm, nvm,
 * volta, custom prefixes). Returns null if npm isn't on PATH or errors out.
 */
function npmGlobalPrefix(): string | null {
  try {
    const result = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
      encoding: 'utf-8',
      shell: IS_WINDOWS,
      timeout: 5000,
    })
    if (result.status === 0 && result.stdout) {
      const prefix = result.stdout.trim()
      if (prefix && existsSync(prefix)) return prefix
    }
  } catch {
    // npm not on PATH or other error — fall back to env-based guesses
  }
  return null
}

/**
 * Given a directory that probably contains the Pi install (either an npm
 * prefix or the dirname of a pi.cmd shim), try to find the underlying
 * cli.js. Returns null if nothing matches.
 *
 * Why: spawning pi.cmd via shell:true on Windows is unreliable for RPC
 * mode — the cmd.exe wrapper interferes with stdio piping that Pi's
 * JSONL protocol needs. If we can find the cli.js the shim would invoke,
 * we can run it with node.exe directly and skip the shell entirely.
 */
function findCliJsNear(dir: string): string | null {
  const candidates = [
    join(dir, 'node_modules', PI_PACKAGE, 'dist', 'cli.js'),
    join(dir, 'lib', 'node_modules', PI_PACKAGE, 'dist', 'cli.js'),
    // pi-node managed install drops it one level up from the shim dir
    join(dir, '..', 'node_modules', PI_PACKAGE, 'dist', 'cli.js'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Locate the Pi coding agent CLI. Strategy (most reliable first):
 *
 *   1. Ask npm for its global prefix and look there. Works for default
 *      Node installs, fnm, nvm, volta, pnpm, custom prefixes — anything
 *      where `npm install -g` actually puts files.
 *   2. Search PATH for `pi` (respects PATHEXT on Windows for .cmd/.exe).
 *      If found as a .cmd/.ps1 shim, try to locate the underlying cli.js
 *      next to the shim so we can spawn Node directly.
 *   3. Fall back to OS-specific guesses for common install paths.
 *   4. Last resort: bare `pi`/`pi.cmd` (will likely fail with ENOENT).
 *
 * Prefers the JS entry point (cli.js) when present so we can spawn it
 * with our own Node binary — sidesteps the shell-required-for-shim
 * problem on Windows.
 */
function findPiBinary(): string {
  // 1. npm's actual global prefix
  const prefix = npmGlobalPrefix()
  if (prefix) {
    // Always try cli.js layouts first (any platform), then fall back to
    // shims. Spawning the JS entry directly with Node is more reliable
    // than the .cmd/.ps1 shim on Windows.
    const cliJs = findCliJsNear(prefix)
    if (cliJs) return cliJs
    const fromPrefixCandidates = IS_WINDOWS
      ? [join(prefix, 'pi.cmd'), join(prefix, 'pi.ps1')]
      : [join(prefix, 'bin', 'pi')]
    for (const c of fromPrefixCandidates) {
      if (existsSync(c)) return c
    }
  }

  // 2. PATH search (uses Windows PATHEXT for .cmd/.exe/.ps1). If it
  //    resolves to a .cmd/.ps1 shim, look next to the shim for the
  //    underlying cli.js so we can skip the shell wrapper.
  const fromPath = whichInPath('pi')
  if (fromPath) {
    if (/\.(cmd|bat|ps1)$/i.test(fromPath)) {
      const cliJs = findCliJsNear(join(fromPath, '..'))
      if (cliJs) return cliJs
    }
    return fromPath
  }

  // 3. OS-specific common locations as fallback
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const appData = process.env.APPDATA ?? ''
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'

  const candidates: string[] = []
  if (IS_WINDOWS) {
    if (appData) candidates.push(join(appData, 'npm', PI_CLI_REL))
    if (localAppData) candidates.push(join(localAppData, 'npm', PI_CLI_REL))
    candidates.push(join(programFiles, 'nodejs', PI_CLI_REL))
    if (appData) candidates.push(join(appData, 'npm', 'pi.cmd'))
    if (localAppData) candidates.push(join(localAppData, 'npm', 'pi.cmd'))
  } else {
    candidates.push(join(home, '.npm-global', PI_CLI_REL))
    candidates.push(join(home, '.npm-global', 'bin', 'pi'))
    candidates.push(join('/opt/homebrew/lib', PI_CLI_REL))
    candidates.push(join('/usr/local/lib', PI_CLI_REL))
    candidates.push(join('/usr/lib', PI_CLI_REL))
    candidates.push('/opt/homebrew/bin/pi')
    candidates.push('/usr/local/bin/pi')
    candidates.push('/usr/bin/pi')
    candidates.push(join(home, '.local/bin/pi'))
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }

  return PI_FALLBACK_BINARY
}

/**
 * Find a Node binary to run the Pi .js script with. Searches NODE env,
 * npm_node_execpath (set when running under npm), Electron's own process,
 * common install paths, and PATH.
 */
function findNodeBinary(): string {
  if (process.env.NODE && existsSync(process.env.NODE)) return process.env.NODE
  if (process.env.npm_node_execpath && existsSync(process.env.npm_node_execpath)) {
    return process.env.npm_node_execpath
  }

  if (IS_WINDOWS) {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA ?? ''
    const candidates = [
      // Pi's install.ps1 puts an auto-installed Node under
      // %LOCALAPPDATA%\pi-node\current\node.exe. Check the symlinked
      // 'current' path first; fall back to the bare pi-node dir for
      // older layouts.
      localAppData ? join(localAppData, 'pi-node', 'current', 'node.exe') : '',
      localAppData ? join(localAppData, 'pi-node', 'node.exe') : '',
      join(programFiles, 'nodejs', 'node.exe'),
      join(programFilesX86, 'nodejs', 'node.exe'),
      localAppData ? join(localAppData, 'fnm_multishells', 'node.exe') : '',
    ].filter(Boolean)
    for (const c of candidates) if (existsSync(c)) return c
    const fromPath = whichInPath('node')
    if (fromPath) return fromPath
    return 'node.exe'
  }

  for (const c of ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node']) {
    if (existsSync(c)) return c
  }
  const fromPath = whichInPath('node')
  if (fromPath) return fromPath
  return 'node'
}

const PI_SCRIPT = findPiBinary()
const USE_NODE = PI_SCRIPT.endsWith('.js')
const NODE_BINARY = findNodeBinary()
// On Windows, .cmd/.bat/.ps1 shims require shell:true to be invoked via spawn.
const NEEDS_SHELL = IS_WINDOWS && !USE_NODE && /\.(cmd|bat|ps1)$/i.test(PI_SCRIPT)
const PI_SCRIPT_EXISTS = existsSync(PI_SCRIPT)
const NODE_BINARY_EXISTS = !USE_NODE || existsSync(NODE_BINARY)
console.log('─── Pi binary resolution ────────────────────────────')
console.log('[Pi] PI_SCRIPT     :', PI_SCRIPT, PI_SCRIPT_EXISTS ? '(exists)' : '(MISSING)')
console.log('[Pi] USE_NODE      :', USE_NODE)
console.log('[Pi] NODE_BINARY   :', NODE_BINARY, USE_NODE ? (NODE_BINARY_EXISTS ? '(exists)' : '(MISSING)') : '(unused)')
console.log('[Pi] NEEDS_SHELL   :', NEEDS_SHELL)
console.log('[Pi] Spawn command :', USE_NODE ? `${NODE_BINARY} ${PI_SCRIPT}` : PI_SCRIPT, NEEDS_SHELL ? '(via shell)' : '')
console.log('─────────────────────────────────────────────────────')

// Exported so ipc-handlers can run `pi install/remove/update` with the same
// binary that was resolved here — Electron's PATH won't have `pi` directly.
export const PI_CLI = {
  script: PI_SCRIPT,
  node: NODE_BINARY,
  useNode: USE_NODE,
  needsShell: NEEDS_SHELL,
} as const

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
      // Only report captured stderr as an error when we're actually in the
      // 'error' state. Pi and its extensions (e.g. pi-ollama) log benign,
      // informational lines to stderr while running — surfacing those as an
      // error misleads the UI into showing healthy startup logs as ERROR.
      error: this.status === 'error' ? (this.stderrBuffer || null) : null,
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

    // Pre-flight: if the binary we resolved doesn't exist, fail fast with a
    // clear message instead of letting spawn die with a cryptic ENOENT.
    if (!PI_SCRIPT_EXISTS) {
      this.stderrBuffer = `Pi binary not found at resolved path:\n  ${PI_SCRIPT}\n\nSearched npm prefix, PATH, and common install locations. Make sure Pi is installed:\n  npm install -g @earendil-works/pi-coding-agent\nor on Windows:\n  irm https://pi.dev/install.ps1 | iex`
      this.setStatus('error')
      console.error('[Pi] Pre-flight failed:', this.stderrBuffer)
      return this.getStatus()
    }
    if (USE_NODE && !NODE_BINARY_EXISTS) {
      this.stderrBuffer = `Node binary not found at resolved path:\n  ${NODE_BINARY}\n\nPi's .js entry point requires Node. Install Node from https://nodejs.org or set the NODE env var to your Node binary path.`
      this.setStatus('error')
      console.error('[Pi] Pre-flight failed:', this.stderrBuffer)
      return this.getStatus()
    }

    const args = this.buildArgs(options)

    try {
      const spawnOptions: SpawnOptions = {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        // .cmd/.bat/.ps1 shims on Windows can't be invoked directly from
        // spawn — they need the cmd.exe interpreter via shell:true.
        shell: NEEDS_SHELL,
        // On POSIX, make the child its own process-group leader so kill()'s
        // negative-PID group kill reaps Pi and all its descendants. Skipped on
        // Windows, where it would spawn a detached console window with shell:true.
        detached: !IS_WINDOWS,
      }

      console.log('[Pi] Spawning with cwd:', options.cwd)
      console.log('[Pi] Spawn argv     :', USE_NODE ? [NODE_BINARY, PI_SCRIPT, ...args] : [PI_SCRIPT, ...args])
      const proc = USE_NODE
        ? spawn(NODE_BINARY, [PI_SCRIPT, ...args], spawnOptions)
        : spawn(PI_SCRIPT, args, spawnOptions)
      this.process = proc

      this.setupStreams()

      return new Promise<PiStatus>((resolve) => {
        let resolved = false
        const done = (): void => {
          if (resolved) return
          resolved = true
          resolve(this.getStatus())
        }

        // Mark running immediately if Pi sends stdout before the settle window.
        const onFirstData = (): void => {
          this.process?.stdout?.removeListener('data', onFirstData)
          if (this.status === 'starting') this.setStatus('running')
          done()
        }
        this.process!.stdout?.on('data', onFirstData)

        proc.on('error', (err) => {
          console.error('[Pi] Spawn error:', err.message)
          // Surface to the renderer status popover so users see something
          // useful instead of a blank 'error' state.
          this.stderrBuffer += `Spawn error: ${err.message}\n`
          this.setStatus('error')
          done()
        })

        proc.on('exit', (code, signal) => {
          console.log('[Pi] Process exited with code:', code, 'signal:', signal, 'pid:', proc.pid)
          // If Pi exited non-zero before reaching 'running', preserve that as
          // the error reason so the popover can show it; otherwise it stopped.
          if (this.status !== 'running' && code !== 0 && code !== null) {
            this.stderrBuffer = (this.stderrBuffer || '') + `Pi exited with code ${code} before becoming ready.`
            this.setStatus('error')
          } else {
            this.setStatus('stopped')
          }
          this.emit('exit', { code, signal })
          this.rejectAllPending('Pi process exited')
          done()
        })

        // Pi's RPC mode is pure request/response — it emits nothing on connect.
        // If the process is still alive after the settle window without erroring
        // or exiting, it is ready to receive commands.
        setTimeout(() => {
          if (this.status === 'starting') {
            this.process?.stdout?.removeListener('data', onFirstData)
            this.setStatus('running')
            done()
          }
        }, PROCESS_SETTLE_MS)

        // Hard deadline: something is seriously wrong if we're still stuck in
        // 'starting' after the full timeout (the settle timer should have fired).
        setTimeout(() => {
          if (this.status === 'starting') {
            const captured = this.stderrBuffer.trim()
            // Reap the hung process before flipping to 'error' so we don't
            // leave a zombie buffering on stdio. kill() resets buffers, so
            // build the message first and restore it after.
            this.kill()
            this.setStatus('error')
            this.stderrBuffer =
              `Pi did not respond within ${SPAWN_STARTUP_TIMEOUT_MS / 1000}s.\n\n` +
              (captured
                ? `Pi stderr captured during startup:\n${captured}`
                : 'No output captured. Likely causes: Pi launched but stdio piping is broken (common with shell:true on Windows), or Pi is waiting on input. Try running `pi --mode rpc` directly in cmd to see if RPC mode works standalone.')
            done()
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
   * Send a command to the Pi RPC process.
   * Returns a correlated response if an id is provided.
   */
  async sendCommand(command: Record<string, unknown>): Promise<PiResponseEvent | null> {
    if (!this.process?.stdin || this.status !== 'running') {
      throw new Error('Pi process is not running')
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
      return // Silently ignore if Pi isn't running
    }

    const line = JSON.stringify(command) + JSONL_NEWLINE
    try {
      this.process.stdin.write(line)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EPIPE') {
        throw err
      }
      // EPIPE means Pi process exited
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
    } else if (options.continueSession && !options.noSession) {
      // Resume the most recent session for the cwd. Pi falls back to a fresh
      // session when none exists, so this is safe on first run.
      args.push(CONTINUE_FLAG)
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
      console.log('[Pi STDERR]:', text.slice(0, 200))
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
      pending.reject(new Error('Pi process killed'))
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
