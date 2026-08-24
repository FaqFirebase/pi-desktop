import { spawnSync } from 'child_process'

/**
 * Moving a deleted session to the desktop trash instead of destroying it.
 *
 * Pi's own session selector shells out to the `trash` CLI, and the GUI
 * followed it. But `trash` (trash-cli) is a separate package that most
 * distributions do not install, and the only fallback was `unlink`. On any
 * machine without trash-cli every confirmed delete was therefore permanent,
 * with no undo, while the code read as if deletion were recoverable.
 *
 * So more than one helper is tried. `gio trash` ships with GLib and is
 * present on essentially every desktop Linux install, which restores a real
 * trash bin on the machines trash-cli misses.
 */

/** Trash helpers in preference order; the first one installed that succeeds wins. */
const TRASH_HELPERS: ReadonlyArray<{ command: string; leadingArgs: readonly string[] }> = [
  // trash-cli, matching what Pi itself invokes.
  { command: 'trash', leadingArgs: [] },
  // GLib's file mover, part of the `libglib2.0-bin` package every GTK desktop pulls in.
  { command: 'gio', leadingArgs: ['trash'] },
]

/** Exit status of a helper that completed successfully. */
const TRASH_EXIT_OK = 0

export interface TrashSpawnResult {
  status: number | null
  /** Set when the helper could not be executed at all, e.g. ENOENT when it is not installed. */
  error?: Error
}

export type TrashSpawn = (command: string, args: string[]) => TrashSpawnResult

function runTrashHelper(command: string, args: string[]): TrashSpawnResult {
  const result = spawnSync(command, args, { encoding: 'utf-8' })
  return { status: result.status, error: result.error }
}

/**
 * Arguments for one helper. `--` is added only for a path that could be read
 * as an option, because not every minimal `trash` build accepts the separator.
 */
export function buildTrashArgs(leadingArgs: readonly string[], targetPath: string): string[] {
  return targetPath.startsWith('-')
    ? [...leadingArgs, '--', targetPath]
    : [...leadingArgs, targetPath]
}

/**
 * Try every trash helper in turn. Returns true once one reports success.
 * A helper that is not installed is skipped, not treated as a refusal to
 * delete, so a missing trash-cli falls through to `gio` rather than to
 * permanent removal.
 */
export function moveToTrash(targetPath: string, spawn: TrashSpawn = runTrashHelper): boolean {
  for (const { command, leadingArgs } of TRASH_HELPERS) {
    const result = spawn(command, buildTrashArgs(leadingArgs, targetPath))
    // No status at all means the helper never ran (not installed); try the next.
    if (result.error) continue
    if (result.status === TRASH_EXIT_OK) return true
  }
  return false
}
