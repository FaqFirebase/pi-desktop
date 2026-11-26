/**
 * Electron prefixes errors thrown by ipcMain.handle with
 * "Error invoking remote method '<channel>': <ErrorName>: " before they reach
 * the renderer's rejected promise. The name is the error class, such as
 * `Error` or `GitNotInstalledError`. Strip that plumbing so users see the
 * message the main process actually wrote.
 */
const IPC_ERROR_PREFIX_RE = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/

export function formatIpcError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(IPC_ERROR_PREFIX_RE, '')
}
