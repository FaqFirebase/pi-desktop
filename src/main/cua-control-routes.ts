import { createHash, timingSafeEqual } from 'crypto'
import type { ComputerBackend } from '../shared/ipc-contracts'

/**
 * Routage du serveur de contrôle CUA (agent OMP → panneau Computer).
 * Module pur : aucune dépendance Electron ni I/O, pour être testé sans réseau.
 * `cua-control-server.ts` branche ces fonctions sur un vrai serveur HTTP.
 */

/** Requête normalisée transmise au routeur. */
export interface ControlRequest {
  /** Méthode HTTP en majuscules (ex. 'POST'). */
  method: string
  /** chemin seul de l'URL (ex. '/computer/open'), sans query ni host. */
  path: string
  /** Valeur brute de l'en-tête Authorization, absente si omise. */
  authorization?: string
  /** Corps brut (chaîne), vide autorisé. */
  body: string
}

/** Réponse sérialisable produite par le routeur. */
export interface ControlResponse {
  status: number
  body: unknown
}

/** Résultats attendus des opérations injectées (formes JSON sur le fil). */
export interface ControlOpenResult {
  success: boolean
  sessionId?: string
  viewerUrl?: string
  backend?: ComputerBackend
  error?: string
}

export interface ControlCloseResult {
  success: boolean
  error?: string
}

export interface ControlStatusResult {
  open: boolean
  sessionId: string | null
  backend: string | null
}

export interface ControlExecResult {
  success: boolean
  stdout?: string
  stderr?: string
  exitCode?: number
  error?: string
}

/** Opérations que le serveur injecte (session handlers côté main). */
export interface ControlOps {
  open(backend: ComputerBackend): Promise<ControlOpenResult>
  close(): Promise<ControlCloseResult>
  status(): ControlStatusResult
  exec(command: string): Promise<ControlExecResult>
}

/** Backends acceptés par POST /computer/open (l'enum complet du panneau, 'auto' par défaut). */
const OPEN_BACKENDS: readonly ComputerBackend[] = ['main-os', 'proxmox-vm', 'docker-host', 'docker-vm', 'auto']

/** Corps maximal accepté (les commandes exec sont de simples chaînes de quelques ko). */
export const MAX_CONTROL_BODY_BYTES = 256 * 1024

function isComputerBackend(value: unknown): value is ComputerBackend {
  return typeof value === 'string' && (OPEN_BACKENDS as readonly string[]).includes(value)
}

/**
 * Comparaison en temps constant de l'en-tête Authorization avec le token
 * attendu. Les deux valeurs sont hachées d'abord pour ne pas fuiter la
 * longueur du token via timingSafeEqual (qui exige des buffers égaux).
 */
export function isAuthorized(authorization: string | undefined, token: string): boolean {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  const provided = createHash('sha256').update(authorization.slice('Bearer '.length)).digest()
  const expected = createHash('sha256').update(token).digest()
  return timingSafeEqual(provided, expected)
}

/** Parse le corps JSON ; '' / ' ' compte comme absent ({}). null = JSON invalide. */
export function parseControlBody(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null) return {}
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function json(status: number, body: unknown): ControlResponse {
  return { status, body }
}

/**
 * Route une requête du serveur de contrôle. Ordre : authentification (401),
 * reconnaissance du chemin (404), méthode (405), validation du corps (400),
 * puis appel de l'opération injectée (200 ; un échec métier reste un 200
 * avec success:false — le client agent lit le champ, pas le code HTTP).
 */
export async function handleControlRequest(
  request: ControlRequest,
  token: string,
  ops: ControlOps
): Promise<ControlResponse> {
  if (!isAuthorized(request.authorization, token)) {
    return json(401, { error: 'Authorization: Bearer <token> requis.' })
  }

  if (request.path === '/computer/status') {
    if (request.method !== 'GET') {
      return json(405, { error: 'GET requis pour /computer/status.' })
    }
    return json(200, ops.status())
  }

  let body: Record<string, unknown> | null
  if (request.path === '/computer/open') {
    if (request.method !== 'POST') {
      return json(405, { error: 'POST requis pour /computer/open.' })
    }
    body = parseControlBody(request.body)
    if (body === null) {
      return json(400, { error: 'Corps JSON invalide.' })
    }
    const requested = body.backend === undefined || body.backend === null ? 'auto' : body.backend
    if (!isComputerBackend(requested)) {
      return json(400, { error: `Backend inconnu : ${String(requested)}. Attendu : ${OPEN_BACKENDS.join(', ')}.` })
    }
    return json(200, await ops.open(requested))
  }

  if (request.path === '/computer/close') {
    if (request.method !== 'POST') {
      return json(405, { error: 'POST requis pour /computer/close.' })
    }
    body = parseControlBody(request.body)
    if (body === null) {
      return json(400, { error: 'Corps JSON invalide.' })
    }
    return json(200, await ops.close())
  }

  if (request.path === '/computer/exec') {
    if (request.method !== 'POST') {
      return json(405, { error: 'POST requis pour /computer/exec.' })
    }
    body = parseControlBody(request.body)
    if (body === null) {
      return json(400, { error: 'Corps JSON invalide.' })
    }
    const command = body.command
    if (typeof command !== 'string' || command.trim().length === 0) {
      return json(400, { error: 'Le champ "command" doit être une chaîne non vide.' })
    }
    return json(200, await ops.exec(command))
  }

  return json(404, { error: `Route inconnue : ${request.method} ${request.path}` })
}
