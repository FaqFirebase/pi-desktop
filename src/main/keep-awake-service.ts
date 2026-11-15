import { powerSaveBlocker } from 'electron'
import { spawn } from 'child_process'
import type { KeepAwakeMode, KeepAwakeStatus } from '../shared/keep-awake'
import { PI_DESKTOP_PRODUCT_NAME } from '../shared/product-name'
import { createKeepAwake } from './keep-awake'
import { createSystemInhibitor } from './keep-awake-system-inhibitor'
import { createKeepAwakeCoordinator } from './keep-awake-coordinator'
import { createKeepAwakeController, KEEP_AWAKE_RELEASE_DELAY_MS } from './keep-awake-controller'
import { createAgentWorkTracker, type AgentWorkTracker } from './agent-work-tracker'
import { dbusNameHasOwner } from './dbus-probe'
import { appLog } from './app-log'

const LOG_SCOPE = 'power'

/** Shown by `systemd-inhibit --list` next to the lock. */
const INHIBITOR_REASON = 'Keep this computer awake is turned on'

/**
 * The session-bus services Electron's blocker asks on Linux. With neither
 * present (sway, i3, Hyprland and other bare window managers) the blocker
 * does nothing and reports no error.
 */
const DESKTOP_SLEEP_SERVICES = ['org.gnome.SessionManager', 'org.freedesktop.PowerManagement']

const statusListeners: ((status: KeepAwakeStatus) => void)[] = []

const systemInhibitor = createSystemInhibitor({
  // stdin stays an open pipe: the helper holds the lock until that pipe closes.
  spawn: (command, args) => spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'] }),
  who: PI_DESKTOP_PRODUCT_NAME,
  why: INHIBITOR_REASON,
  onLost: () => {
    coordinator.handleSystemInhibitorLost()
    controller.refreshStatus()
    appLog.warn(LOG_SCOPE, 'The system sleep lock ended unexpectedly')
  },
})

const coordinator = createKeepAwakeCoordinator({
  platform: process.platform,
  desktopBlocker: createKeepAwake(powerSaveBlocker),
  systemInhibitor,
  hasDesktopSleepService: async () =>
    (await Promise.all(DESKTOP_SLEEP_SERVICES.map(dbusNameHasOwner))).some(Boolean),
})

const controller = createKeepAwakeController({
  coordinator,
  releaseDelayMs: KEEP_AWAKE_RELEASE_DELAY_MS,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  onStatusChange: (status) => {
    // Holding and waiting flip on every turn, so only the failure is logged.
    if (status === 'unsupported') appLog.warn(LOG_SCOPE, 'Keep awake is on, but this system has no service that can block sleep')
    for (const listener of statusListeners) listener(status)
  },
})

/** Every agent work signal reports here; "While agents work" follows it. */
export const agentWork: AgentWorkTracker = createAgentWorkTracker((working) => void controller.setWorking(working))

/** Match the sleep block to the user's setting. Safe to call on every save. */
export async function applyKeepAwakeMode(mode: KeepAwakeMode): Promise<void> {
  await controller.setMode(mode)
}

export function getKeepAwakeStatus(): KeepAwakeStatus {
  return controller.getStatus()
}

export function onKeepAwakeStatusChange(listener: (status: KeepAwakeStatus) => void): void {
  statusListeners.push(listener)
}
