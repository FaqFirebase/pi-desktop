import type { PermissionMode, SessionRuntimeInfo } from './ipc-contracts'

/** Every permission mode, in the order the UI lists them. */
export const PERMISSION_MODES: readonly PermissionMode[] = ['plan-readonly', 'ask-edits', 'ask-commands', 'trusted']

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

/**
 * A live process keeps the mode it started with, so it holds the wrong tool
 * set once the setting moves on. Only a running process can be wrong: a
 * stopped one reads the setting when it next starts.
 */
export function runtimeNeedsPermissionRestart(
  runtime: Pick<SessionRuntimeInfo, 'status' | 'permissionMode'>,
  mode: PermissionMode
): boolean {
  return runtime.status === 'running' && !!runtime.permissionMode && runtime.permissionMode !== mode
}
