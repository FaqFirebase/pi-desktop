import { SessionTimestampStore } from './session-timestamp-store'

/**
 * Archived-session registry.
 *
 * Pi itself has no archive concept, so archive is a GUI-only annotation:
 * archived-sessions.json in the GUI data dir, { "<sessionId>": <archivedAtEpochMs> }.
 */

const ARCHIVED_FILE_NAME = 'archived-sessions.json'

export class ArchivedSessionsManager extends SessionTimestampStore {
  constructor() {
    super(ARCHIVED_FILE_NAME)
  }

  async isArchived(sessionId: string): Promise<boolean> {
    return this.has(sessionId)
  }

  async archive(sessionId: string): Promise<void> {
    await this.add(sessionId)
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.remove(sessionId)
  }

  /** Drop the entry of a deleted session, so the registry keeps no stale IDs. */
  async forget(sessionId: string): Promise<void> {
    await this.remove(sessionId)
  }
}
