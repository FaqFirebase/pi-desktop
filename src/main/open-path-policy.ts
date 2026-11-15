import { posix as posixPath, win32 as win32Path } from 'node:path'
import { isPathWithin } from '../../resources/path-within'
import type { Workspace } from '../shared/ipc-contracts'

/** File types that run as a program or script when the system opens them. */
export const RUNNABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.hta', '.cpl', '.msc', '.lnk', '.url', '.jar', '.app', '.command', '.tool', '.terminal', '.workflow',
  '.action', '.pkg', '.mpkg', '.scpt', '.applescript', '.desktop', '.appimage', '.sh',
])

// Any of the owner, group or other execute bits.
const EXECUTE_BITS = 0o111
// Windows drops trailing dots and spaces from a file name, so `run.bat.` runs `run.bat`.
const TRAILING_DOTS_AND_SPACES = /[. ]+$/

/** Folders "Open in editor", "Open with system app" and "Show in folder" may act in. */
export function openPathRoots(
  workspaces: readonly Workspace[],
  sessionRoots: readonly string[],
  sessionFolders: Iterable<string>,
): string[] {
  const roots: string[] = []
  for (const workspace of workspaces) {
    roots.push(workspace.path)
    for (const repo of workspace.linkedTask?.repos ?? []) roots.push(repo.workPath)
  }
  return [...roots, ...sessionRoots, ...sessionFolders]
}

/**
 * The absolute path `raw` names, when it lies inside one of `roots`. A
 * relative path resolves against `baseDir`; with no `baseDir` it is refused.
 */
export function resolveOpenPathTarget(
  raw: string,
  baseDir: string | null,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const { isAbsolute, resolve } = platform === 'win32' ? win32Path : posixPath
  const trimmed = raw.trim()
  if (!isAbsolute(trimmed) && baseDir === null) return null
  const resolved = baseDir === null ? resolve(trimmed) : resolve(baseDir, trimmed)
  return roots.some((root) => isPathWithin(root, resolved, platform)) ? resolved : null
}

/**
 * The lower-case extension of a path's last part, read the way Windows reads
 * it (trailing dots and spaces dropped). Both separators count, so a Windows
 * path is read the same on every OS.
 */
export function extensionForPolicy(path: string): string {
  const name = win32Path.basename(path).replace(TRAILING_DOTS_AND_SPACES, '')
  return win32Path.extname(name).toLowerCase()
}

export interface PathFacts {
  isFile: boolean
  mode: number
}

/**
 * True when the system app would run the target as a program: a runnable
 * extension on any of `paths` (the given path and its real path), or, on
 * macOS and Linux, a regular file with an execute bit. Folders always carry
 * execute bits, so the bit rule skips them; bundle folders (`.app`) still
 * match by extension.
 */
export function isRunnableTarget(paths: readonly string[], facts: PathFacts, platform: NodeJS.Platform): boolean {
  if (paths.some((path) => RUNNABLE_EXTENSIONS.has(extensionForPolicy(path)))) return true
  return platform !== 'win32' && facts.isFile && (facts.mode & EXECUTE_BITS) !== 0
}
