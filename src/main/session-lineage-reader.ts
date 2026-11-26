import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import type { SessionLineageRecord } from '../shared/session-lineage'
import { mapWithConcurrency } from './map-concurrent'
import { getSessionRoots } from './pi-paths'
import { JSONL_EXTENSION } from './session-paths'
import { readSessionMetadataCached } from './session-metadata'

/**
 * Reads every parent session's lineage link and label out of every session store
 * the session list reads: Pi's and OMP's.
 *
 * The Timeline needs one record per session to resolve fork parents, so this walk
 * touches the whole store. It previously `readFile`d each session in full to
 * consume a single header line — on a real store that is ~9 MB of I/O to extract
 * ~2 KB, serially, with no cache, on every Timeline mount. Now each file gets a
 * bounded read, files are read concurrently, and results are mtime-cached.
 */

/** Session files read at once. Matches the session-list reader's pool. */
const LINEAGE_READ_CONCURRENCY = 24
/**
 * Runaway guard. A store this large means the Timeline is unusable anyway, and an
 * unbounded walk would pin main; capping cannot be done by recency because every
 * header must be read to discover which sessions are parents. Truncating orphans
 * any child whose parent was cut — it renders as a root — so the cap is logged
 * rather than applied silently.
 */
const MAX_LINEAGE_SESSIONS = 2000

/**
 * Collect lineage records for parent sessions only.
 *
 * Layout under each session store (Pi and OMP use the same one; an OMP file
 * starts with its title slot line, which readSessionMetadata reads past):
 *   sessions/<sanitized-project>/<timestamp>_<id>.jsonl     ← parent (read these)
 *   sessions/<sanitized-project>/<timestamp>_<id>/<child>…  ← subagent runs
 *
 * The depth-2 restriction is deliberate and matches the session list: extensions
 * like pi-subagents nest ephemeral runs under the parent's folder, and surfacing
 * them would flood the tree.
 *
 * `sessionsRoots` is injectable so the walk can be tested without the real stores.
 */
export async function readSessionLineage(
  sessionsRoots: readonly string[] = getSessionRoots()
): Promise<SessionLineageRecord[]> {
  const files = await collectSessionFilePaths(sessionsRoots)

  const records = await mapWithConcurrency(files, LINEAGE_READ_CONCURRENCY, readRecord)
  return records.filter((record): record is SessionLineageRecord => record !== null)
}

/** Absolute paths of every parent session file across all stores, capped in total. */
async function collectSessionFilePaths(sessionsRoots: readonly string[]): Promise<string[]> {
  const files: string[] = []
  for (const sessionsRoot of sessionsRoots) {
    if (await collectStoreSessionFilePaths(sessionsRoot, files) === 'capped') break
  }
  return files
}

/** Appends one store's parent session files to `files`; 'capped' once the cap is hit. */
async function collectStoreSessionFilePaths(sessionsRoot: string, files: string[]): Promise<'done' | 'capped'> {
  let projectDirs: string[]
  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true })
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    // Store missing or unreadable — it adds nothing to the Timeline.
    return 'done'
  }

  for (const dirName of projectDirs) {
    const projectDir = join(sessionsRoot, dirName)
    let items
    try {
      items = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      // Parent sessions only: skip subagent nests, and skip a *directory* that
      // happens to end in .jsonl (which would otherwise be read as a file).
      if (!item.isFile() || !item.name.endsWith(JSONL_EXTENSION)) continue
      files.push(join(projectDir, item.name))
      if (files.length >= MAX_LINEAGE_SESSIONS) {
        console.warn(
          `[lineage] Session store exceeds ${MAX_LINEAGE_SESSIONS} sessions; ` +
            'the timeline is truncated and some forks will render as roots.'
        )
        return 'capped'
      }
    }
  }
  return 'done'
}

/** One lineage record, or null when the file is not a readable session. */
async function readRecord(filePath: string): Promise<SessionLineageRecord | null> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(filePath)).mtimeMs
  } catch {
    return null
  }

  const { header, name, preview } = await readSessionMetadataCached(filePath, mtimeMs)
  // No session header means this is not a Pi session file.
  if (!header) return null

  return {
    // The filename stem, not the header uuid: it carries the creation timestamp
    // the renderer formats when a session has neither a name nor a preview.
    sessionId: basename(filePath, JSONL_EXTENSION),
    path: filePath,
    name,
    preview,
    parentPath: header.parentSession,
  }
}
