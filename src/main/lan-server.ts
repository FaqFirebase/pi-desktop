/**
 * LAN remote access: HTTP + SSE so phones/other devices on the network can
 * chat with the active Pi session. Static UI is served from resources/lan-web.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { randomBytes } from 'crypto'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname, join, normalize } from 'path'
import { app } from 'electron'
import type { WorkspaceManager } from './workspace-manager'
import type { PiRpcManager } from './pi-rpc-manager'
import type { PiRpcEvent } from '../shared/ipc-contracts'

export const DEFAULT_LAN_PORT = 4747

export interface LanServerConfig {
  enabled: boolean
  port: number
  /** Shared secret; clients send Authorization: Bearer <token> or ?token= */
  token: string
}

export interface LanServerStatus {
  running: boolean
  port: number
  token: string
  urls: string[]
  error: string | null
}

type SseClient = {
  res: ServerResponse
  id: number
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

export function generateLanToken(): string {
  return randomBytes(18).toString('base64url')
}

/** IPv4 addresses on non-internal interfaces (LAN-facing). */
export function listLanAddresses(): string[] {
  const nets = networkInterfaces()
  const out: string[] = []
  for (const entries of Object.values(nets)) {
    if (!entries) continue
    for (const e of entries) {
      if (e.family === 'IPv4' && !e.internal) out.push(e.address)
    }
  }
  return out
}

export function buildLanUrls(port: number): string[] {
  const addrs = listLanAddresses()
  const hosts = addrs.length > 0 ? addrs : ['127.0.0.1']
  return hosts.map((h) => `http://${h}:${port}`)
}

export function resolveLanWebRoot(): string {
  // Packaged: extraResources → resources/lan-web
  // Dev: repo resources/lan-web
  const candidates = [
    join(process.resourcesPath ?? '', 'resources', 'lan-web'),
    join(app.getAppPath(), 'resources', 'lan-web'),
    join(__dirname, '../../resources/lan-web'),
    join(process.cwd(), 'resources', 'lan-web'),
  ]
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'index.html'))) return dir
  }
  return candidates[candidates.length - 1]
}

function readBody(req: IncomingMessage, limit = 2_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

export class LanServer {
  private server: Server | null = null
  private config: LanServerConfig = {
    enabled: false,
    port: DEFAULT_LAN_PORT,
    token: '',
  }
  private error: string | null = null
  private sseClients = new Map<number, SseClient>()
  private nextSseId = 1
  private webRoot = resolveLanWebRoot()

  constructor(private readonly workspaceManager: WorkspaceManager) {}

  getStatus(): LanServerStatus {
    const running = this.server !== null
    return {
      running,
      port: this.config.port,
      token: this.config.token,
      urls: running ? buildLanUrls(this.config.port) : [],
      error: this.error,
    }
  }

  /** Apply settings; start/stop/restart as needed. */
  async applyConfig(partial: Partial<LanServerConfig>): Promise<LanServerStatus> {
    const next: LanServerConfig = {
      enabled: partial.enabled ?? this.config.enabled,
      port: partial.port ?? this.config.port,
      token: partial.token ?? this.config.token,
    }
    if (!next.token) next.token = generateLanToken()
    if (next.port < 1 || next.port > 65535) next.port = DEFAULT_LAN_PORT

    const wasRunning = this.server !== null
    const changed =
      next.enabled !== this.config.enabled ||
      next.port !== this.config.port ||
      next.token !== this.config.token

    this.config = next

    if (!next.enabled) {
      await this.stop()
      return this.getStatus()
    }

    if (wasRunning && changed) await this.stop()
    if (!this.server) await this.start()
    return this.getStatus()
  }

  async start(): Promise<void> {
    if (this.server) return
    this.error = null
    this.webRoot = resolveLanWebRoot()

    const server = createServer((req, res) => {
      void this.handle(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.message
        this.server = null
        reject(err)
      })
      server.listen(this.config.port, '0.0.0.0', () => {
        this.server = server
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients.values()) {
      try {
        client.res.end()
      } catch {
        // ignore
      }
    }
    this.sseClients.clear()

    const server = this.server
    this.server = null
    if (!server) return

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  /** Forward active-workspace Pi events to SSE clients. */
  publishPiEvent(event: PiRpcEvent | Record<string, unknown>): void {
    if (this.sseClients.size === 0) return
    const payload = `event: pi\ndata: ${JSON.stringify(event)}\n\n`
    for (const [id, client] of this.sseClients) {
      try {
        client.res.write(payload)
      } catch {
        this.sseClients.delete(id)
      }
    }
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const token = this.config.token
    if (!token) return false
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ') && header.slice(7) === token) return true
    if (url.searchParams.get('token') === token) return true
    // Cookie set by /api/login for browser convenience
    const cookie = req.headers.cookie ?? ''
    if (cookie.split(';').some((c) => c.trim() === `pi_lan_token=${token}`)) return true
    return false
  }

  private getActivePi(): PiRpcManager | null {
    return this.workspaceManager.getActivePiManager()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const host = req.headers.host ?? `127.0.0.1:${this.config.port}`
      const url = new URL(req.url ?? '/', `http://${host}`)
      const path = url.pathname

      // CORS for API (LAN browsers)
      if (path.startsWith('/api/')) {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }
      }

      if (path === '/api/health') {
        sendJson(res, 200, { ok: true })
        return
      }

      // Login page always public; sets cookie then redirects
      if (path === '/api/login' && req.method === 'POST') {
        const raw = await readBody(req)
        let body: { token?: string } = {}
        try {
          body = JSON.parse(raw) as { token?: string }
        } catch {
          body = {}
        }
        if (body.token !== this.config.token) {
          sendJson(res, 401, { error: 'Invalid token' })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `pi_lan_token=${this.config.token}; Path=/; SameSite=Lax; HttpOnly`,
        })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (path.startsWith('/api/') && path !== '/api/login') {
        if (!this.isAuthorized(req, url)) {
          sendJson(res, 401, { error: 'Unauthorized' })
          return
        }
      }

      if (path === '/api/status' && req.method === 'GET') {
        const pi = this.getActivePi()
        const ws = this.workspaceManager.getActiveWorkspace()
        sendJson(res, 200, {
          pi: pi?.getStatus() ?? { status: 'stopped', pid: null, error: null },
          workspace: ws ? { name: ws.name, path: ws.path } : null,
        })
        return
      }

      if (path === '/api/messages' && req.method === 'GET') {
        const pi = this.getActivePi()
        if (!pi) {
          sendJson(res, 503, { error: 'Pi not running' })
          return
        }
        try {
          const result = await pi.sendCommand({ type: 'get_messages' })
          sendJson(res, 200, result)
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }

      if (path === '/api/prompt' && req.method === 'POST') {
        const pi = this.getActivePi()
        if (!pi) {
          sendJson(res, 503, { error: 'Pi not running' })
          return
        }
        const raw = await readBody(req)
        let message = ''
        try {
          const body = JSON.parse(raw) as { message?: string }
          message = typeof body.message === 'string' ? body.message : ''
        } catch {
          message = ''
        }
        if (!message.trim()) {
          sendJson(res, 400, { error: 'message required' })
          return
        }
        try {
          const result = await pi.sendCommand({ type: 'prompt', message })
          sendJson(res, 200, result ?? { ok: true })
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }

      if (path === '/api/abort' && req.method === 'POST') {
        const pi = this.getActivePi()
        if (!pi) {
          sendJson(res, 503, { error: 'Pi not running' })
          return
        }
        try {
          const result = await pi.sendCommand({ type: 'abort' })
          sendJson(res, 200, result ?? { ok: true })
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }

      if (path === '/api/events' && req.method === 'GET') {
        if (!this.isAuthorized(req, url)) {
          sendJson(res, 401, { error: 'Unauthorized' })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        })
        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        const id = this.nextSseId++
        this.sseClients.set(id, { res, id })
        req.on('close', () => {
          this.sseClients.delete(id)
        })
        return
      }

      // Static files (mobile UI). Auth optional for HTML shell so login can load;
      // API still protected. Prefer requiring token for static in production LAN —
      // we allow public static + cookie after login.
      await this.serveStatic(req, res, path)
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  private async serveStatic(
    _req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<void> {
    let rel = pathname === '/' ? '/index.html' : pathname
    rel = normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
    if (rel.includes('..')) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    const root = normalize(this.webRoot)
    const filePath = normalize(join(root, rel))
    const rootPrefix = root.endsWith('\\') || root.endsWith('/') ? root : root + (process.platform === 'win32' ? '\\' : '/')
    const rootOk =
      process.platform === 'win32'
        ? filePath.toLowerCase().startsWith(rootPrefix.toLowerCase())
        : filePath.startsWith(rootPrefix)
    if (!rootOk) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA fallback
      const index = join(this.webRoot, 'index.html')
      if (existsSync(index)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        createReadStream(index).pipe(res)
        return
      }
      res.writeHead(404)
      res.end('LAN web UI not found. Ensure resources/lan-web is packaged.')
      return
    }

    const ext = extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
    createReadStream(filePath).pipe(res)
  }
}

let lanServerSingleton: LanServer | null = null

export function getLanServer(): LanServer | null {
  return lanServerSingleton
}

export function createLanServer(workspaceManager: WorkspaceManager): LanServer {
  lanServerSingleton = new LanServer(workspaceManager)
  return lanServerSingleton
}
