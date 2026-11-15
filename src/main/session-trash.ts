import { existsSync } from 'fs'
import { unlink } from 'fs/promises'
import type { SessionDeleteResult } from '../shared/ipc-contracts'

/**
 * Deleting a session moves it to the operating system trash instead of
 * destroying it.
 *
 * The trash call is injected: production passes Electron's `shell.trashItem`,
 * which uses the Recycle Bin on Windows, the Trash on macOS, and the desktop's
 * own trash on Linux (gio, or kioclient on KDE). Tests pass a fake, so this
 * module never loads Electron.
 */
export type TrashItem = (targetPath: string) => Promise<void>

/** Resolves true once the trash call reports success; a rejection is a failure. */
export async function moveToTrash(targetPath: string, trashItem: TrashItem): Promise<boolean> {
  try {
    await trashItem(targetPath)
    return true
  } catch {
    return false
  }
}

/**
 * Delete a session file. Mirrors Pi's own session-selector deletion path:
 * move it to the trash (recoverable), and only destroy it with `unlink` when
 * the trash refuses it.
 *
 * Why this lives in the GUI and not in Pi: Pi's RPC mode exposes no
 * delete_session command (verified against pi.dev/docs/latest/rpc).
 * The official guidance is "Sessions can be removed by deleting their
 * .jsonl files" — that's what this does.
 */
export async function deleteSessionFile(sessionPath: string, trashItem: TrashItem): Promise<SessionDeleteResult> {
  // A trash call that moved the file but still reported an error leaves the
  // session in the trash either way, not destroyed.
  if (await moveToTrash(sessionPath, trashItem) || !existsSync(sessionPath)) {
    return { ok: true, method: 'trash' }
  }

  try {
    await unlink(sessionPath)
    return { ok: true, method: 'unlink' }
  } catch (err) {
    return {
      ok: false,
      method: 'unlink',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
