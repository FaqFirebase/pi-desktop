import { app, BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC_CHANNELS, type ComputerAgentEvent, type ComputerBackend } from '../shared/ipc-contracts'
import {
  closeComputerSession,
  execComputerCommand,
  getComputerSessionState,
  openComputerSession,
} from './ipc/computer-handlers'
import { judgeCuaUseRequest } from './jev-cua'
import { typeSafeKeyStore } from './typesafe-key-store'
import { MAX_CONTROL_BODY_BYTES, handleControlRequest, type ControlOps } from './cua-control-routes'
import { appLog } from './app-log'

/**
 * Serveur HTTP de contrôle CUA : la porte d'entrée de l'agent OMP qui veut
 * montrer/cacher le panneau Computer ou exécuter du shell dans le space.
 * Lié STRICTEMENT à 127.0.0.1 sur un port libre aléatoire ; chaque requête
 * doit présenter `Authorization: Bearer <token>`. Le couple {port, token}
 * est publié dans <userData>/cua-control.json pour que l'extension OMP le
 * découvre, et le fichier est supprimé à l'extinction. Le token ne doit
 * JAMAIS être loggué.
 */

let server: Server | null = null
let authToken: string | null = null
let controlFilePath: string | null = null

/** Pousser un événement au renderer : le store synchronise le panneau. */
function notifyRenderer(event: ComputerAgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.COMPUTER_AGENT_EVENT, event)
  }
}

/**
 * Résoudre 'auto' côté main pour les appels agent : pas de prompt utilisateur
 * sous la main, donc Jev juge une demande générique ; sans clé ni réponse,
 * judgeCuaUseRequest retombe déjà sur le backend historique (confidence 0).
 */
async function resolveAutoBackend(): Promise<Exclude<ComputerBackend, 'auto'>> {
  const judgment = await judgeCuaUseRequest(
    'The coding agent asks to show the Computer Use desktop panel. No user request text is available; pick the most suitable default backend.',
    typeSafeKeyStore.getSavedKey()
  )
  return judgment.backend === 'auto' ? 'docker-vm' : judgment.backend
}

const ops: ControlOps = {
  open: async (backend) => {
    const resolved = backend === 'auto' ? await resolveAutoBackend() : backend
    const result = await openComputerSession(resolved)
    if (result.success && result.sessionId && result.viewerUrl) {
      notifyRenderer({
        type: 'opened',
        sessionId: result.sessionId,
        viewerUrl: result.viewerUrl,
        backend: result.backend ?? resolved,
      })
    }
    return result
  },
  close: async () => {
    const state = getComputerSessionState()
    if (!state.open || !state.sessionId) {
      return { success: false, error: 'Aucune session CUA ouverte.' }
    }
    const result = await closeComputerSession(state.sessionId)
    if (result.success) {
      notifyRenderer({ type: 'closed' })
    }
    return result
  },
  status: () => getComputerSessionState(),
  exec: (command) => execComputerCommand(command),
}

/** Collecter le corps brut, capped ; rejette au-delà de MAX_CONTROL_BODY_BYTES. */
function readRawBody(req: IncomingMessage): Promise<string> {
  // Le lib target du process main n'inclut pas es2024 : forme executor nécessaire.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_CONTROL_BODY_BYTES) {
        reject(new Error('payload_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

function onControlRequest(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const token = authToken
    if (!token) {
      sendJson(res, 503, { error: 'Serveur de contrôle CUA en cours d’arrêt.' })
      return
    }
    let bodyText: string
    try {
      bodyText = await readRawBody(req)
    } catch {
      sendJson(res, 413, { error: `Corps limité à ${MAX_CONTROL_BODY_BYTES} octets.` })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const rawAuth = req.headers.authorization
    const response = await handleControlRequest(
      {
        method: req.method ?? 'GET',
        path: pathname,
        authorization: Array.isArray(rawAuth) ? rawAuth[0] : rawAuth,
        body: bodyText,
      },
      token,
      ops
    )
    sendJson(res, response.status, response.body)
  })().catch((err: unknown) => {
    // Ne jamais inclure le token : seul le message de l'erreur remonte.
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'Erreur interne du serveur de contrôle.' })
  })
}

/**
 * Démarrer le serveur de contrôle et publier <userData>/cua-control.json.
 * Appeler depuis app.whenReady() ; idempotent.
 */
export async function startCuaControlServer(): Promise<void> {
  if (server) return
  // Token aléatoire par lancement : jamais persisté ailleurs que dans le
  // fichier userData, jamais loggué.
  authToken = randomBytes(32).toString('hex')
  const listener = createServer(onControlRequest)
  listener.on('error', (err) => {
    appLog.error('cua', 'Control server socket error', err)
  })
  // Le lib target du process main n'inclut pas es2024 : forme executor nécessaire.
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.once('listening', () => {
      listener.removeListener('error', reject)
      resolve()
    })
    // Bind explicite 127.0.0.1 + port 0 = port libre attribué par l'OS.
    listener.listen(0, '127.0.0.1')
  })
  const address = listener.address()
  if (!address || typeof address === 'string') {
    listener.close()
    authToken = null
    throw new Error('Serveur de contrôle CUA : port non attribué.')
  }
  server = listener
  controlFilePath = join(app.getPath('userData'), 'cua-control.json')
  writeFileSync(controlFilePath, JSON.stringify({ port: address.port, token: authToken }))
  appLog.info('cua', `Control server listening on 127.0.0.1:${address.port}`)
}

/**
 * Fermer le serveur et retirer cua-control.json. Appeler depuis will-quit.
 */
export function stopCuaControlServer(): void {
  if (controlFilePath) {
    try {
      if (existsSync(controlFilePath)) unlinkSync(controlFilePath)
    } catch (err) {
      appLog.warn('cua', 'Control file removal failed', err)
    }
    controlFilePath = null
  }
  authToken = null
  if (server) {
    server.close()
    server = null
  }
}
