import { readdir, realpath, stat } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import type { AgentEngineKind } from '../shared/ipc-contracts'
import { getOmpSessionsRoot, getSessionsRoot } from './pi-paths'
import { JSONL_EXTENSION, ompSessionDirName, sanitizePath } from './session-paths'
import { inspectSessionContent } from './session-metadata'

interface SessionFileCandidate {
  path: string
  modifiedAt: number
}

async function projectSessionFiles(projectDir: string): Promise<SessionFileCandidate[]> {
  let items: Array<{ name: string; isFile: () => boolean }>
  try {
    items = await readdir(projectDir, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates: SessionFileCandidate[] = []
  for (const item of items) {
    // Parent sessions only; directories hold subagent runs.
    if (!item.isFile() || !item.name.endsWith(JSONL_EXTENSION)) continue
    const path = join(projectDir, item.name)
    try {
      candidates.push({ path, modifiedAt: (await stat(path)).mtimeMs })
    } catch {
      // Skip a file removed or unreadable since the directory read.
    }
  }
  return candidates
}

/** The path with symlinks resolved, as OMP resolves it; the path itself when it cannot be resolved. */
async function resolvedPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

/**
 * The directories where `engine` keeps the sessions of `projectPath`. Pi names
 * the directory after the path itself; OMP names home and temporary-directory
 * projects its own way and may still hold a directory in Pi's naming from
 * before it adopted that scheme.
 */
export async function engineProjectSessionDirs(engine: AgentEngineKind, projectPath: string): Promise<string[]> {
  if (engine === 'pi') return [join(getSessionsRoot(), sanitizePath(projectPath))]
  const [project, home, tmp] = await Promise.all([resolvedPath(projectPath), resolvedPath(homedir()), resolvedPath(tmpdir())])
  const names = new Set([ompSessionDirName(project, home, tmp), sanitizePath(projectPath)])
  return [...names].map((name) => join(getOmpSessionsRoot(), name))
}

/**
 * The session "Resume Last Session" reopens: the most recently written session
 * file in the given project directories (one engine's store). A header-only
 * file (a session that never got a prompt) is skipped, the same rows the
 * session list hides.
 */
export async function findLatestProjectSession(projectDirs: readonly string[]): Promise<string | null> {
  const candidates = (await Promise.all(projectDirs.map(projectSessionFiles))).flat()
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)
  for (const candidate of candidates) {
    if (await inspectSessionContent(candidate.path) !== 'empty') return candidate.path
  }
  return null
}
