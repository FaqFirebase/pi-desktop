import { resolve } from 'path'
import { isPathWithin } from '../../resources/path-within'

/**
 * Authorize a path for the attachment reader. A path is allowed only if the user
 * picked it through the native open dialog (tracked in `approvedPaths`, stored
 * pre-resolved) or it lives inside the active workspace. This keeps a compromised
 * renderer from reading arbitrary files (e.g. `~/.ssh/id_rsa`) via the reader.
 */
export function isAuthorizedAttachmentPath(
  candidate: string,
  opts: { workspaceRoot: string | null; approvedPaths: ReadonlySet<string> }
): boolean {
  const resolved = resolve(candidate)
  if (opts.approvedPaths.has(resolved)) return true
  return opts.workspaceRoot ? isPathWithin(opts.workspaceRoot, resolved) : false
}
