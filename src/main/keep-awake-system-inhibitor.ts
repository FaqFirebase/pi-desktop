export const SYSTEMD_INHIBIT_COMMAND = 'systemd-inhibit'

/**
 * The helper holds the lock for as long as it runs, and `cat` runs until its
 * stdin closes. The caller keeps that stdin pipe open and never writes to it,
 * so the lock is released when the helper is killed and also when this app
 * dies without cleanup (the OS closes the pipe).
 */
const HOLD_OPEN_COMMAND = 'cat'

/** "sleep" stops a suspend request; "idle" tells idle daemons the session is busy. */
const INHIBIT_WHAT = 'sleep:idle'

/** "block" refuses the operation; "delay" would only postpone it for a few seconds. */
const INHIBIT_MODE = 'block'

/** A refused lock (no permission) makes the helper exit at once; this long without an exit means it holds. */
const DEFAULT_SETTLE_MS = 500

/** The part of a Node `ChildProcess` this module needs. */
export interface InhibitorChild {
  on(event: 'spawn', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'exit', listener: (code: number | null) => void): this
  kill(): boolean
}

export interface SystemInhibitorDeps {
  spawn(command: string, args: readonly string[]): InhibitorChild
  /** Shown by `systemd-inhibit --list` as the lock owner. */
  who: string
  /** Shown by `systemd-inhibit --list` as the reason. */
  why: string
  settleMs?: number
  /** The helper ended while the lock was held, without a release() call. */
  onLost(): void
}

export interface SystemInhibitor {
  /** Take the lock. Resolves false when systemd-inhibit is missing or refuses. */
  acquire(): Promise<boolean>
  release(): void
  isHeld(): boolean
}

/**
 * A systemd-logind sleep lock, for Linux desktops that have no power manager
 * of their own (sway, i3, Hyprland and other bare window managers). It works
 * below the desktop, so it holds on every systemd system.
 *
 * Electron-free: the process spawn is injected, so this runs under node:test.
 */
export function createSystemInhibitor(deps: SystemInhibitorDeps): SystemInhibitor {
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS
  let heldChild: InhibitorChild | null = null

  const args = [
    `--what=${INHIBIT_WHAT}`,
    `--who=${deps.who}`,
    `--why=${deps.why}`,
    `--mode=${INHIBIT_MODE}`,
    HOLD_OPEN_COMMAND,
  ]

  return {
    isHeld: () => heldChild !== null,

    acquire() {
      if (heldChild) return Promise.resolve(true)

      return new Promise<boolean>((resolve) => {
        const child = deps.spawn(SYSTEMD_INHIBIT_COMMAND, args)
        let settleTimer: ReturnType<typeof setTimeout> | null = null
        let settled = false

        const settle = (acquired: boolean): void => {
          if (settled) return
          settled = true
          if (settleTimer) clearTimeout(settleTimer)
          if (acquired) heldChild = child
          resolve(acquired)
        }

        child.on('error', () => settle(false))
        child.on('spawn', () => {
          settleTimer = setTimeout(() => settle(true), settleMs)
        })
        child.on('exit', () => {
          if (!settled) {
            settle(false)
            return
          }
          // A release() clears heldChild before the kill, so only a helper
          // that ended by itself is still the held one here.
          if (heldChild !== child) return
          heldChild = null
          deps.onLost()
        })
      })
    },

    release() {
      const child = heldChild
      if (!child) return
      heldChild = null
      child.kill()
    },
  }
}
