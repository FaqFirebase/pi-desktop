import { execFile } from 'child_process'
import { parseDbusBoolean } from './tray-decision'

const DBUS_SEND_COMMAND = 'dbus-send'
// Bound the D-Bus probe so a missing/slow session bus can't hang the caller.
const DBUS_PROBE_TIMEOUT_MS = 2_000

/** Run a `dbus-send --print-reply` and resolve its stdout, or null on error. */
export function dbusSend(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(DBUS_SEND_COMMAND, args, { timeout: DBUS_PROBE_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

/**
 * Whether a session-bus name has an owner. Resolves false when it has none,
 * when there is no session bus, or when `dbus-send` is unavailable.
 */
export async function dbusNameHasOwner(name: string): Promise<boolean> {
  const reply = await dbusSend([
    '--session',
    '--print-reply',
    '--dest=org.freedesktop.DBus',
    '/org/freedesktop/DBus',
    'org.freedesktop.DBus.NameHasOwner',
    `string:${name}`,
  ])
  return parseDbusBoolean(reply ?? '') === true
}
