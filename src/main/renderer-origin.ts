import { join } from 'path'
import { pathToFileURL } from 'url'

/**
 * The only file the main window is allowed to load/navigate to in production,
 * and the only frame URL that privileged IPC accepts as a sender. Its preload
 * exposes terminal + full IPC, so this must stay pinned to the packaged renderer.
 */
export const RENDERER_INDEX_PATH = join(__dirname, '../renderer/index.html')

/**
 * True when `frameUrl` belongs to the app's own renderer: the dev server's exact
 * origin in development, or the packaged index file (ignoring hash/query used by
 * client-side routing) in production. Parses the URL so a look-alike host or a
 * sibling local file cannot pass a naive string-prefix check.
 */
export function isTrustedRendererUrl(
  frameUrl: string,
  opts: { devServerUrl?: string; rendererIndexPath: string }
): boolean {
  let parsed: URL
  try {
    parsed = new URL(frameUrl)
  } catch {
    return false
  }
  if (opts.devServerUrl) {
    try {
      return parsed.origin === new URL(opts.devServerUrl).origin
    } catch {
      return false
    }
  }
  return parsed.protocol === 'file:' && parsed.pathname === pathToFileURL(opts.rendererIndexPath).pathname
}
