import { app, session } from 'electron'
import { URL } from 'url'
import { readCuaSettingsSync } from './cua-settings'

/**
 * Configuration de sécurité pour le webview CUA
 *
 * Sécurité en 3 couches :
 * 1. Partition Electron isolée (persist:cua-viewer)
 * 2. Validation stricte des URLs (whitelist) sur toutes les requêtes réseau
 * 3. Blocage de navigation externe, popups et permissions sur les webContents
 */

// URLs autorisées pour le viewer CUA : le tunnel SSH local (docker-vm,
// proxmox-vm) sur le port des settings, le port du conteneur docker-host, le
// cua-spacesd local de ce PC (main-os, port 3211) et le relay Cua (backends
// relay). Figé au setup ; changer un port demande un redémarrage (la partition
// est installée à ce moment-là).
let allowedOrigins: ReadonlySet<string> = new Set()

/**
 * Vérifie si une URL est autorisée
 */
export function isUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url)
    const origin = `${parsed.protocol}//${parsed.host}`
    return allowedOrigins.has(origin)
  } catch {
    return false
  }
}

/**
 * Configure un webContents de webview CUA : navigation, popups, menus.
 */
function configureWebContentsForCua(contents: Electron.WebContents): void {
  contents.on('context-menu', (event) => {
    event.preventDefault()
  })

  contents.setWindowOpenHandler(({ url }) => {
    if (!isUrlAllowed(url)) {
      console.warn('[CUA Security] Blocked new window:', url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    if (!isUrlAllowed(url)) {
      event.preventDefault()
      console.warn('[CUA Security] Blocked navigation:', url)
    }
  })
}

/**
 * Configure la sécurité pour la partition CUA. Appeler une fois, au démarrage.
 */
export function setupCuaWebviewSecurity(): void {
  const { tunnelPort, dockerHostPort } = readCuaSettingsSync()
  allowedOrigins = new Set([
    `http://127.0.0.1:${tunnelPort}`,
    `http://localhost:${tunnelPort}`,
    `http://127.0.0.1:${dockerHostPort}`,
    `http://localhost:${dockerHostPort}`,
    // cua-spacesd du service Cua local (backend main-os).
    'http://127.0.0.1:3211',
    'http://localhost:3211',
    // Machines relay Cua (desktops et Spaces distants).
    'https://relay.cua.ai',
  ])

  const cuaSession = session.fromPartition('persist:cua-viewer')

  // Bloquer les requêtes vers des domaines non autorisés
  cuaSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (isUrlAllowed(details.url)) {
      callback({})
    } else {
      console.warn('[CUA Security] Blocked request to:', details.url)
      callback({ cancel: true })
    }
  })

  // Refuser toutes les demandes de permission dans le viewer
  cuaSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })

  // Appliquer les garde-fous aux webviews attachés à la partition CUA
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview' && contents.session === cuaSession) {
      configureWebContentsForCua(contents)
    }
  })
}
