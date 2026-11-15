import { posix as posixPath, win32 as win32Path } from 'node:path'
import { isPathWithin } from '../../resources/path-within'
import type { Workspace } from '../shared/ipc-contracts'

/** File types that run as a program or script when the system opens them. */
export const RUNNABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.hta', '.cpl', '.msc', '.lnk', '.url', '.jar', '.app', '.command', '.tool', '.terminal', '.workflow',
  '.action', '.pkg', '.mpkg', '.scpt', '.applescript', '.desktop', '.appimage', '.sh',
  // More Windows types that run code when opened.
  '.pif', '.scf', '.application', '.appref-ms', '.vb', '.ws', '.wsc', '.msp', '.reg',
  '.settingcontent-ms', '.library-ms',
  // More macOS types that run code when opened.
  '.fileloc', '.prefpane',
])

// Any of the owner, group or other execute bits.
const EXECUTE_BITS = 0o111
// Windows drops trailing dots and spaces from a file name, so `run.bat.` runs `run.bat`.
const TRAILING_DOTS_AND_SPACES = /[. ]+$/
// On Windows, text after a colon names an NTFS stream (`run.bat::$DATA` runs
// `run.bat`); elsewhere a colon is a plain name character. Both readings are
// checked on every OS.
const STREAM_SEPARATOR = ':'

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

function extensionOf(name: string): string {
  return win32Path.extname(name.replace(TRAILING_DOTS_AND_SPACES, '')).toLowerCase()
}

/**
 * The lower-case extensions a path's last part can run as: that of the full
 * name, and that of the part before a colon (a stream name), each read the way
 * Windows reads it (trailing dots and spaces dropped). Both separators count,
 * so a Windows path is read the same on every OS.
 */
export function extensionsForPolicy(path: string): string[] {
  const name = win32Path.basename(path)
  const extensions = [extensionOf(name)]
  if (name.includes(STREAM_SEPARATOR)) {
    const beforeStream = extensionOf(name.split(STREAM_SEPARATOR)[0])
    if (!extensions.includes(beforeStream)) extensions.push(beforeStream)
  }
  return extensions
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
  if (paths.some((path) => extensionsForPolicy(path).some((extension) => RUNNABLE_EXTENSIONS.has(extension)))) return true
  return platform !== 'win32' && facts.isFile && (facts.mode & EXECUTE_BITS) !== 0
}
