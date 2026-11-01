import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  IPC_CHANNELS,
  type ComputerBackend,
  type ComputerOpenSessionResult,
  type ComputerGetViewerResult,
  type ComputerCloseSessionResult,
} from '../../shared/ipc-contracts'
import { readCuaSettingsSync, type CuaSettings } from '../cua-settings'

// The Cua CLI lives on the remote host (Settings > Behavior > CUA); the viewer
// listens on that host's loopback, so each session gets a local SSH tunnel on
// the configured port.
const CUA_SSH_USER = 'cua'
const CUA_SSH_KEY = join(homedir(), '.ssh', 'id_pve')
const REMOTE_PATH_EXPORT = 'export PATH=$HOME/.local/bin:$PATH;'

// Local binaries on this PC: the Cua Spaces app ships the CLI, Docker Desktop
// ships docker.exe (used by the docker-host backend).
const LOCAL_CUA_EXE = join(homedir(), 'AppData', 'Local', 'Programs', 'Cua', 'bin', 'cua.exe')
const LOCAL_DOCKER_EXE = join(homedir(), 'AppData', 'Local', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe')
// The host service's cua-spacesd (Cua Spaces app) listens on this loopback
// port on both this PC and the CUA VM; it serves the desktop viewer there.
const HOST_SPACESD_PORT = 3211
// Inside a trycua/linux container, cua-spacesd serves the viewer on this port.
const CONTAINER_SPACESD_PORT = 3211
const DOCKER_IMAGE = 'ghcr.io/trycua/linux:24.04'
// Written by the image's entrypoint hook once the guest is ready.
const CONTAINER_TOKEN_PATH = '/run/cua/env-token'

/** A backend that can actually run a session ('auto' is resolved in the renderer). */
type SessionBackend = Exclude<ComputerBackend, 'auto'>

interface CuaSession {
  spaceName: string
  backend: SessionBackend
  tunnel: ChildProcess | null
  tunnelPort: number
  viewerUrl: string
  expiresAtUnix: number
}

// One Cua host is configured; a single live session at a time.
let currentSession: CuaSession | null = null

// Serialize all session operations: concurrent opens (double UI actions, a
// backend switch racing a panel open) must never both pass the currentSession
// check and create two spaces/containers — the loser would orphan its guest.
let sessionOpQueue: Promise<unknown> = Promise.resolve()
function enqueueSessionOp<T>(fn: () => Promise<T>): Promise<T> {
  const run = sessionOpQueue.then(fn, fn)
  sessionOpQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function generateSpaceName(): string {
  return `pi-desktop-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

/** One-shot remote command over SSH; resolves with stdout/exit code. */
function runRemoteShell(remoteCmd: string, settings: CuaSettings): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Le lib target du process main n'inclut pas es2024 : forme executor nécessaire.
  return new Promise((resolve) => {
    const proc = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'IdentitiesOnly=yes',
      '-i', CUA_SSH_KEY,
      `${CUA_SSH_USER}@${settings.host}`,
      remoteCmd,
    ])

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })
    proc.on('error', (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 })
    })
  })
}

/** One-shot remote `cua <args>` over SSH. */
function runCuaCommand(args: string[], settings: CuaSettings): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runRemoteShell(`${REMOTE_PATH_EXPORT} cua ${args.join(' ')}`, settings)
}

/** One-shot local executable (docker.exe, cua.exe) with captured output. */
function runLocalCommand(exe: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(exe, args, { windowsHide: true })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })
    proc.on('error', (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 })
    })
  })
}

/** Persistent `ssh -N -L` tunnel exposing the remote loopback viewer locally. */
function startTunnel(remotePort: number, settings: CuaSettings): ChildProcess {
  const proc = spawn('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ServerAliveInterval=30',
    '-N',
    '-L', `${settings.tunnelPort}:127.0.0.1:${remotePort}`,
    '-i', CUA_SSH_KEY,
    `${CUA_SSH_USER}@${settings.host}`,
  ])
  proc.on('error', (err) => {
    console.error('[CUA] tunnel error:', err.message)
  })
  return proc
}

function stopTunnel(session: CuaSession | null): void {
  if (session?.tunnel && session.tunnel.exitCode === null && !session.tunnel.killed) {
    session.tunnel.kill()
  }
}

/** Parse the JSON line printed by `cua sb view --no-open --json`. */
function parseViewerJson(stdout: string): { url: string; expiresAtUnix: number } | null {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as { url?: string; expires_at_unix?: number }
      if (parsed.url && parsed.expires_at_unix) {
        return { url: parsed.url, expiresAtUnix: parsed.expires_at_unix }
      }
    } catch {
      // Try the previous line.
    }
  }
  return null
}

/** Rewrite the remote-loopback viewer URL onto the local tunnel port. */
function localizeViewerUrl(url: string, tunnelPort: number): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return null
    parsed.port = String(tunnelPort)
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * Register a loopback spacesd as a `direct:` sandbox and mint its viewer ticket.
 * Shared by docker-host, main-os and proxmox-vm (the last one through SSH).
 */
async function mintDirectViewer(
  name: string,
  spacesdUrl: string,
  token: string,
  run: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
): Promise<{ viewerUrl: string; expiresAtUnix: number } | { error: string }> {
  const create = await run(['sb', 'create', '--on', `direct:${spacesdUrl}`, '--token', token, '--name', name])
  if (create.exitCode !== 0) {
    return { error: `Enregistrement du desktop direct impossible : ${firstLine(create.stderr) || firstLine(create.stdout)}` }
  }
  const view = await run(['sb', 'view', name, '--no-open', '--json'])
  const parsed = parseViewerJson(view.stdout)
  if (!parsed) {
    await run(['sb', 'rm', '--force', name])
    return { error: `Impossible de délivrer le ticket du viewer : ${firstLine(view.stderr) || firstLine(view.stdout)}` }
  }
  return { viewerUrl: parsed.url, expiresAtUnix: parsed.expiresAtUnix }
}

/** Poll the container's spacesd token file; null when the container died or stalls. */
async function waitForContainerToken(containerName: string): Promise<string | null> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const res = await runLocalCommand(LOCAL_DOCKER_EXE, ['exec', containerName, 'cat', CONTAINER_TOKEN_PATH])
    const token = res.stdout.trim()
    if (res.exitCode === 0 && token) return token
    const running = await runLocalCommand(LOCAL_DOCKER_EXE, ['inspect', '-f', '{{.State.Running}}', containerName])
    if (running.exitCode !== 0 || running.stdout.trim() !== 'true') return null
    await sleep(1500)
  }
  return null
}

/** Poll the container viewer endpoint until it answers (spacesd is up). */
async function waitForLocalViewer(port: number): Promise<boolean> {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const status = await Promise.race([
      fetch(`http://127.0.0.1:${port}/viewer/`).then((res) => res.status).catch(() => 0),
      sleep(2500).then(() => -1),
    ])
    if (status > 0 && status < 500) return true
    await sleep(750)
  }
  return false
}

async function removeLocalContainer(containerName: string): Promise<void> {
  await runLocalCommand(LOCAL_DOCKER_EXE, ['rm', '-f', containerName])
}

/**
 * Best-effort wait for the guest's PipeWire Pulse socket. The viewer opens the
 * desktop audio monitor on first connect; if it lands before pipewire-pulse
 * binds `/run/cua-desktop/pulse/native`, spacesd returns "Connection refused"
 * and the viewer drops to a Reconnect prompt. Gating readiness on the socket
 * makes the first load clean; we still proceed if audio never comes up (video
 * is independent of it).
 */
async function waitForContainerAudio(containerName: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const probe = await runLocalCommand(LOCAL_DOCKER_EXE, ['exec', containerName, 'test', '-S', '/run/cua-desktop/pulse/native'])
    if (probe.exitCode === 0) return
    await sleep(1000)
  }
}

// ─── Per-backend open flows ─────────────────────────────────────────────────

/** docker-vm : conteneur Linux créé par le Cua CLI sur la VM (flux historique). */
async function openDockerVmSession(settings: CuaSettings): Promise<ComputerOpenSessionResult> {
  const spaceName = generateSpaceName()
  const create = await runCuaCommand(['spaces', 'create', '--name', spaceName, 'linux'], settings)
  if (create.exitCode !== 0) {
    return { success: false, error: `Échec de création du space : ${create.stderr.trim() || create.stdout.trim()}` }
  }

  const view = await runCuaCommand(['sb', 'view', spaceName, '--no-open', '--json'], settings)
  const parsed = parseViewerJson(view.stdout)
  if (!parsed) {
    await runCuaCommand(['spaces', 'delete', spaceName, '--force'], settings)
    return { success: false, error: 'Impossible de récupérer l’URL du viewer Cua.' }
  }

  const viewerUrl = localizeViewerUrl(parsed.url, settings.tunnelPort)
  if (!viewerUrl) {
    await runCuaCommand(['spaces', 'delete', spaceName, '--force'], settings)
    return { success: false, error: 'URL du viewer inattendue (attendu 127.0.0.1 sur l’hôte Cua).' }
  }

  stopTunnel(currentSession)
  currentSession = {
    spaceName,
    backend: 'docker-vm',
    tunnel: startTunnel(Number(new URL(parsed.url).port), settings),
    tunnelPort: settings.tunnelPort,
    viewerUrl,
    expiresAtUnix: parsed.expiresAtUnix,
  }

  return { success: true, sessionId: spaceName, viewerUrl, backend: 'docker-vm' }
}

/** docker-host : conteneur trycua/linux lancé par le Docker local de ce PC. */
async function openDockerHostSession(settings: CuaSettings): Promise<ComputerOpenSessionResult> {
  if (!existsSync(LOCAL_DOCKER_EXE)) {
    return { success: false, error: `docker-host non supporté pour l'instant : Docker Desktop introuvable (${LOCAL_DOCKER_EXE}).` }
  }
  if (!existsSync(LOCAL_CUA_EXE)) {
    return { success: false, error: `docker-host non supporté pour l'instant : CLI Cua introuvable (${LOCAL_CUA_EXE}), indispensable pour délivrer le ticket du viewer.` }
  }

  const name = generateSpaceName()
  const port = settings.dockerHostPort
  const run = await runLocalCommand(LOCAL_DOCKER_EXE, [
    'run', '-d', '--name', name,
    '-p', `127.0.0.1:${port}:${CONTAINER_SPACESD_PORT}`,
    DOCKER_IMAGE,
  ])
  if (run.exitCode !== 0) {
    return { success: false, error: `docker-host : « docker run ${DOCKER_IMAGE} » a échoué : ${firstLine(run.stderr) || firstLine(run.stdout)}` }
  }

  const token = await waitForContainerToken(name)
  if (!token) {
    await removeLocalContainer(name)
    return { success: false, error: 'docker-host : cua-spacesd n’a pas exposé de jeton (/run/cua/env-token) dans le conteneur — bureau indisponible.' }
  }
  if (!(await waitForLocalViewer(port))) {
    await removeLocalContainer(name)
    return { success: false, error: `docker-host : le viewer du conteneur ne répond pas sur 127.0.0.1:${port}.` }
  }
  await waitForContainerAudio(name)

  const minted = await mintDirectViewer(name, `http://127.0.0.1:${port}`, token, (args) => runLocalCommand(LOCAL_CUA_EXE, args))
  if ('error' in minted) {
    await removeLocalContainer(name)
    return { success: false, error: `docker-host : ${minted.error}` }
  }
  const viewerUrl = localizeViewerUrl(minted.viewerUrl, port)
  if (!viewerUrl) {
    await runLocalCommand(LOCAL_CUA_EXE, ['sb', 'rm', '--force', name])
    await removeLocalContainer(name)
    return { success: false, error: 'docker-host : URL du viewer inattendue (attendu 127.0.0.1).' }
  }

  stopTunnel(currentSession)
  currentSession = {
    spaceName: name,
    backend: 'docker-host',
    tunnel: null,
    tunnelPort: port,
    viewerUrl,
    expiresAtUnix: minted.expiresAtUnix,
  }
  return { success: true, sessionId: name, viewerUrl, backend: 'docker-host' }
}

/** main-os : le desktop de ce PC, via le cua-spacesd du service Cua local. */
async function openMainOsSession(): Promise<ComputerOpenSessionResult> {
  if (!existsSync(LOCAL_CUA_EXE)) {
    return { success: false, error: `main-os non supporté pour l'instant : CLI Cua introuvable (${LOCAL_CUA_EXE}) — installez l’app Cua Spaces.` }
  }
  const tokenPath = join(homedir(), '.cua', 'host', 'env-token')
  if (!existsSync(tokenPath)) {
    return { success: false, error: 'main-os non supporté pour l\'instant : le service Cua local n’est pas configuré (~/.cua/host/env-token absent) — lancez « Set up for access » dans Cua Spaces.' }
  }
  const token = readFileSync(tokenPath, 'utf-8').trim()

  const probe = await runLocalCommand(LOCAL_CUA_EXE, ['spacesd', 'targets', `http://127.0.0.1:${HOST_SPACESD_PORT}`, '--token', token])
  if (probe.exitCode !== 0) {
    if (/no desktop provider/i.test(probe.stderr)) {
      return { success: false, error: 'main-os non supporté pour l\'instant : le build cua-spacesd de ce PC n’expose pas de desktop provider (flux du bureau indisponible).' }
    }
    return { success: false, error: `main-os : le service Cua local (127.0.0.1:${HOST_SPACESD_PORT}) ne répond pas : ${firstLine(probe.stderr) || firstLine(probe.stdout)}` }
  }

  const name = generateSpaceName()
  const minted = await mintDirectViewer(name, `http://127.0.0.1:${HOST_SPACESD_PORT}`, token, (args) => runLocalCommand(LOCAL_CUA_EXE, args))
  if ('error' in minted) {
    return { success: false, error: `main-os : ${minted.error}` }
  }
  const viewerUrl = localizeViewerUrl(minted.viewerUrl, HOST_SPACESD_PORT)
  if (!viewerUrl) {
    await runLocalCommand(LOCAL_CUA_EXE, ['sb', 'rm', '--force', name])
    return { success: false, error: 'main-os : URL du viewer inattendue (attendu 127.0.0.1).' }
  }

  stopTunnel(currentSession)
  currentSession = {
    spaceName: name,
    backend: 'main-os',
    tunnel: null,
    tunnelPort: HOST_SPACESD_PORT,
    viewerUrl,
    expiresAtUnix: minted.expiresAtUnix,
  }
  return { success: true, sessionId: name, viewerUrl, backend: 'main-os' }
}

/** proxmox-vm : le desktop de la VM CUA, via son cua-spacesd d’hôte (port 3211). */
async function openProxmoxVmSession(settings: CuaSettings): Promise<ComputerOpenSessionResult> {
  const probe = await runRemoteShell(
    `TOK=$(cat "$HOME/.cua/host/env-token" 2>/dev/null); ${REMOTE_PATH_EXPORT} cua spacesd targets http://127.0.0.1:${HOST_SPACESD_PORT} --token "$TOK"`,
    settings
  )
  if (probe.exitCode !== 0) {
    if (/no desktop provider/i.test(probe.stderr)) {
      return { success: false, error: 'proxmox-vm non supporté pour l\'instant : le build cua-spacesd de l’hôte de la VM n’expose pas de desktop provider (flux du bureau indisponible).' }
    }
    return { success: false, error: `proxmox-vm : le cua-spacesd de l’hôte de la VM est injoignable : ${firstLine(probe.stderr) || firstLine(probe.stdout)}` }
  }

  const name = generateSpaceName()
  const minted = await mintDirectViewer(
    name,
    `http://127.0.0.1:${HOST_SPACESD_PORT}`,
    `$(cat "$HOME/.cua/host/env-token")`,
    async (args) => runRemoteShell(`${REMOTE_PATH_EXPORT} cua ${args.map((a) => (a.includes('$') ? a : `'${a}'`)).join(' ')}`, settings)
  )
  if ('error' in minted) {
    return { success: false, error: `proxmox-vm : ${minted.error}` }
  }
  const viewerUrl = localizeViewerUrl(minted.viewerUrl, settings.tunnelPort)
  if (!viewerUrl) {
    await runRemoteShell(`${REMOTE_PATH_EXPORT} cua sb rm --force '${name}'`, settings)
    return { success: false, error: 'proxmox-vm : URL du viewer inattendue (attendu 127.0.0.1 sur l’hôte Cua).' }
  }

  stopTunnel(currentSession)
  currentSession = {
    spaceName: name,
    backend: 'proxmox-vm',
    tunnel: startTunnel(HOST_SPACESD_PORT, settings),
    tunnelPort: settings.tunnelPort,
    viewerUrl,
    expiresAtUnix: minted.expiresAtUnix,
  }
  return { success: true, sessionId: name, viewerUrl, backend: 'proxmox-vm' }
}

// ─── Per-backend refresh / close ────────────────────────────────────────────

async function refreshViewer(session: CuaSession, settings: CuaSettings): Promise<ComputerGetViewerResult> {
  if (session.backend === 'docker-vm') {
    const view = await runCuaCommand(['sb', 'view', session.spaceName, '--no-open', '--json'], settings)
    const parsed = parseViewerJson(view.stdout)
    if (!parsed) {
      return { success: false, error: 'Impossible de rafraîchir l’URL du viewer.' }
    }
    const viewerUrl = localizeViewerUrl(parsed.url, settings.tunnelPort)
    if (!viewerUrl) {
      return { success: false, error: 'URL du viewer inattendue.' }
    }
    const remotePort = Number(new URL(parsed.url).port)
    const tunnelDown = !session.tunnel || session.tunnel.exitCode !== null
    const portMoved = session.tunnelPort !== settings.tunnelPort
    if (tunnelDown || portMoved) {
      stopTunnel(session)
      session.tunnel = startTunnel(remotePort, settings)
      session.tunnelPort = settings.tunnelPort
    }
    session.viewerUrl = viewerUrl
    session.expiresAtUnix = parsed.expiresAtUnix
    return { success: true, viewerUrl }
  }

  if (session.backend === 'proxmox-vm') {
    const view = await runCuaCommand(['sb', 'view', session.spaceName, '--no-open', '--json'], settings)
    const parsed = parseViewerJson(view.stdout)
    if (!parsed) {
      return { success: false, error: 'Impossible de rafraîchir le ticket du viewer proxmox-vm.' }
    }
    const viewerUrl = localizeViewerUrl(parsed.url, settings.tunnelPort)
    if (!viewerUrl) {
      return { success: false, error: 'URL du viewer inattendue.' }
    }
    const tunnelDown = !session.tunnel || session.tunnel.exitCode !== null
    const portMoved = session.tunnelPort !== settings.tunnelPort
    if (tunnelDown || portMoved) {
      stopTunnel(session)
      session.tunnel = startTunnel(HOST_SPACESD_PORT, settings)
      session.tunnelPort = settings.tunnelPort
    }
    session.viewerUrl = viewerUrl
    session.expiresAtUnix = parsed.expiresAtUnix
    return { success: true, viewerUrl }
  }

  // docker-host / main-os : ticket délivré par le CLI local, sans tunnel.
  if (session.backend === 'docker-host') {
    const running = await runLocalCommand(LOCAL_DOCKER_EXE, ['inspect', '-f', '{{.State.Running}}', session.spaceName])
    if (running.exitCode !== 0 || running.stdout.trim() !== 'true') {
      return { success: false, error: 'Le conteneur docker-host ne tourne plus — fermez la session puis rouvrez-la.' }
    }
  }
  const view = await runLocalCommand(LOCAL_CUA_EXE, ['sb', 'view', session.spaceName, '--no-open', '--json'])
  const parsed = parseViewerJson(view.stdout)
  if (!parsed) {
    return { success: false, error: `Impossible de rafraîchir le ticket du viewer (${session.backend}).` }
  }
  const viewerUrl = localizeViewerUrl(parsed.url, session.tunnelPort)
  if (!viewerUrl) {
    return { success: false, error: 'URL du viewer inattendue.' }
  }
  session.viewerUrl = viewerUrl
  session.expiresAtUnix = parsed.expiresAtUnix
  return { success: true, viewerUrl }
}

async function closeSession(session: CuaSession, settings: CuaSettings): Promise<string | null> {
  let error: string | null = null
  switch (session.backend) {
    case 'docker-vm': {
      const del = await runCuaCommand(['spaces', 'delete', session.spaceName, '--force'], settings)
      if (del.exitCode !== 0) error = `Space supprimé localement mais l’hôte a refusé : ${firstLine(del.stderr)}`
      break
    }
    case 'proxmox-vm': {
      const del = await runCuaCommand(['sb', 'rm', '--force', session.spaceName], settings)
      if (del.exitCode !== 0) error = `Sandbox direct supprimé localement mais l’hôte a refusé : ${firstLine(del.stderr)}`
      break
    }
    case 'docker-host': {
      const del = await runLocalCommand(LOCAL_CUA_EXE, ['sb', 'rm', '--force', session.spaceName])
      await removeLocalContainer(session.spaceName)
      if (del.exitCode !== 0) error = `Conteneur supprimé mais l’enregistrement direct a refusé : ${firstLine(del.stderr)}`
      break
    }
    case 'main-os': {
      // Ne touche jamais au service Cua local : seulement le sandbox direct enregistré.
      const del = await runLocalCommand(LOCAL_CUA_EXE, ['sb', 'rm', '--force', session.spaceName])
      if (del.exitCode !== 0) error = `La suppression du sandbox direct a échoué : ${firstLine(del.stderr)}`
      break
    }
  }
  stopTunnel(session)
  currentSession = null
  return error
}

/**
 * Enregistre les handlers IPC pour le panneau Computer (Cua)
 */
export function registerComputerHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.COMPUTER_OPEN_SESSION,
    async (_event: IpcMainInvokeEvent, backend: ComputerBackend): Promise<ComputerOpenSessionResult> =>
      enqueueSessionOp(async () => {
        const settings = readCuaSettingsSync()
        // 'auto' est résolu par le renderer (jugement Jev) avant l'appel ; par
        // sécurité on retombe sur le backend historique.
        const resolved: SessionBackend = backend === 'auto' || !backend ? 'docker-vm' : backend
        if (currentSession) {
          if (currentSession.backend !== resolved) {
            return { success: false, error: `Une session ${currentSession.backend} est déjà ouverte — fermez-la avant d’ouvrir un autre backend.` }
          }
          return { success: true, sessionId: currentSession.spaceName, viewerUrl: currentSession.viewerUrl, backend: currentSession.backend }
        }
        try {
          switch (resolved) {
            case 'docker-vm':
              return await openDockerVmSession(settings)
            case 'docker-host':
              return await openDockerHostSession(settings)
            case 'main-os':
              return await openMainOsSession()
            case 'proxmox-vm':
              return await openProxmoxVmSession(settings)
            default:
              return { success: false, error: `Backend inconnu : ${String(resolved)}` }
          }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Erreur inconnue' }
        }
      })
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPUTER_GET_VIEWER,
    async (_event: IpcMainInvokeEvent, sessionId: string): Promise<ComputerGetViewerResult> => {
      if (!currentSession || currentSession.spaceName !== sessionId) {
        return { success: false, error: 'Session Cua introuvable.' }
      }
      const settings = readCuaSettingsSync()
      try {
        return await refreshViewer(currentSession, settings)
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Erreur inconnue' }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPUTER_CLOSE_SESSION,
    async (_event: IpcMainInvokeEvent, sessionId: string): Promise<ComputerCloseSessionResult> =>
      enqueueSessionOp(async () => {
        if (!currentSession || currentSession.spaceName !== sessionId) {
          return { success: false, error: 'Session Cua introuvable.' }
        }
        const settings = readCuaSettingsSync()
        try {
          const error = await closeSession(currentSession, settings)
          return error ? { success: false, error } : { success: true }
        } catch (err) {
          stopTunnel(currentSession)
          currentSession = null
          return { success: false, error: err instanceof Error ? err.message : 'Erreur inconnue' }
        }
      })
  )
}

/** Ferme le tunnel SSH résiduel quand l'app quitte. Appeler depuis index.ts (will-quit). */
export function shutdownCuaSession(): void {
  stopTunnel(currentSession)
  currentSession = null
}
