import { createHash, randomUUID } from 'crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { pathGroupKey } from '../shared/path-compare'

/**
 * Session claims across Pi Desktop instances.
 *
 * Inside one app, WorkspaceManager keeps one runtime per session file. Apps
 * started on different data folders (see usesOwnInstanceLock) can still read
 * the same session store, and two agent processes on one session file split
 * the conversation. So while an app runs an agent on a session file, it holds
 * a claim on that file in a folder every instance shares, and another app does
 * not start an agent on a file that a live claim names.
 *
 * A claim is one small file named after the session path, holding the owner's
 * pid. It is held while that pid is alive and the owner keeps refreshing it, so
 * a crashed owner (or a pid the system reused) stops blocking within
 * CLAIM_STALE_MS. A claim file is created complete in one step (written under a
 * private name, then hard-linked into place), so a reader never sees a partial one.
 */

/** How often an owner marks its claims as still in use. */
export const CLAIM_REFRESH_MS = 20_000
/** A claim not refreshed for this long is stale, whatever its pid. */
export const CLAIM_STALE_MS = 3 * CLAIM_REFRESH_MS

const CLAIM_FILE_EXTENSION = '.json'
const TEMPORARY_FILE_EXTENSION = '.tmp'
const STALE_FILE_EXTENSION = '.stale'
const HASH_ALGORITHM = 'sha256'
const ALREADY_EXISTS = 'EEXIST'
const NOT_FOUND = 'ENOENT'
const NO_PERMISSION = 'EPERM'

interface ClaimRecord {
  pid: number
  sessionPath: string
}

/** A claim file as read once: its owner, and which file it was. */
interface FoundClaim {
  owner: ClaimRecord | null
  inode: bigint
  mtimeMs: number
}

export interface SessionClaimDeps {
  pid: number
  now: () => number
  isProcessAlive: (pid: number) => boolean
}

/** True while a process with `pid` exists, including one this user cannot signal. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === NO_PERMISSION
  }
}

const DEFAULT_DEPS: SessionClaimDeps = { pid: process.pid, now: Date.now, isProcessAlive }

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code
}

export class SessionClaimStore {
  /** Claim files this process holds, by session key. */
  private readonly held = new Map<string, string>()
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly dir: string, private readonly deps: SessionClaimDeps = DEFAULT_DEPS) {}

  /**
   * Claim `sessionPath` for this process. False when another live instance
   * holds it; a claim this process already holds is claimed again at no cost.
   */
  claim(sessionPath: string): boolean {
    const key = this.key(sessionPath)
    if (this.held.has(key)) return true
    mkdirSync(this.dir, { recursive: true })
    const file = this.claimFile(key)
    if (!this.create(file, sessionPath)) {
      const found = this.inspect(file)
      if (found === 'replaced') return false
      if (found === null) {
        if (!this.create(file, sessionPath)) return false
      } else {
        if (found.owner?.pid === this.deps.pid) {
          this.hold(key, file)
          return true
        }
        if (found.owner && this.isLive(found)) return false
        if (!this.removeStale(file, found.inode) || !this.create(file, sessionPath)) return false
      }
    }
    this.hold(key, file)
    return true
  }

  /** Give up the claim on `sessionPath` when this process holds it. */
  release(sessionPath: string): void {
    const key = this.key(sessionPath)
    const file = this.held.get(key)
    if (!file) return
    this.held.delete(key)
    if (this.read(file)?.pid === this.deps.pid) this.remove(file)
    if (this.held.size === 0) this.stopRefreshing()
  }

  /** Mark every claim this process holds as still in use. */
  refresh(): void {
    const now = new Date(this.deps.now())
    for (const [key, file] of this.held) {
      try {
        utimesSync(file, now, now)
      } catch (err) {
        // Removed from outside: nothing is left to keep alive. Any other
        // failure is tried again on the next tick, while the claim is still fresh.
        if (errorCode(err) === NOT_FOUND) this.held.delete(key)
      }
    }
  }

  private key(sessionPath: string): string {
    return pathGroupKey(resolve(sessionPath))
  }

  private claimFile(key: string): string {
    return join(this.dir, `${createHash(HASH_ALGORITHM).update(key).digest('hex')}${CLAIM_FILE_EXTENSION}`)
  }

  private hold(key: string, file: string): void {
    this.held.set(key, file)
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => this.refresh(), CLAIM_REFRESH_MS)
    this.refreshTimer.unref()
  }

  private stopRefreshing(): void {
    if (!this.refreshTimer) return
    clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  /** Create `file` complete, or return false when it already exists. */
  private create(file: string, sessionPath: string): boolean {
    const temporary = `${file}.${randomUUID()}${TEMPORARY_FILE_EXTENSION}`
    const record: ClaimRecord = { pid: this.deps.pid, sessionPath }
    writeFileSync(temporary, JSON.stringify(record), 'utf-8')
    try {
      linkSync(temporary, file)
      return true
    } catch (err) {
      if (errorCode(err) === ALREADY_EXISTS) return false
      throw err
    } finally {
      this.remove(temporary)
    }
  }

  private read(file: string): ClaimRecord | null {
    try {
      const record = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ClaimRecord>
      return typeof record.pid === 'number' && typeof record.sessionPath === 'string'
        ? { pid: record.pid, sessionPath: record.sessionPath }
        : null
    } catch {
      // Missing or unreadable: no owner to respect.
      return null
    }
  }

  /**
   * Read a claim file together with which file it is. Null when there is none;
   * 'replaced' when another instance swapped it while it was read.
   */
  private inspect(file: string): FoundClaim | null | 'replaced' {
    const before = this.stat(file)
    if (before === null) return null
    const owner = this.read(file)
    const after = this.stat(file)
    if (after === null || after.ino !== before.ino) return 'replaced'
    return { owner, inode: before.ino, mtimeMs: Number(before.mtimeMs) }
  }

  private stat(file: string): { ino: bigint; mtimeMs: bigint } | null {
    try {
      return statSync(file, { bigint: true })
    } catch (err) {
      if (errorCode(err) === NOT_FOUND) return null
      throw err
    }
  }

  /**
   * Remove the stale claim file `staleInode`, unless another instance replaced
   * it since it was read: the file is moved aside in one step, and only that
   * same file is deleted. A newer claim moved aside by mistake is put back.
   */
  private removeStale(file: string, staleInode: bigint): boolean {
    const aside = `${file}.${randomUUID()}${STALE_FILE_EXTENSION}`
    try {
      renameSync(file, aside)
    } catch (err) {
      // Another instance moved it first: whatever it creates next wins.
      if (errorCode(err) === NOT_FOUND) return true
      throw err
    }
    if (statSync(aside, { bigint: true }).ino === staleInode) {
      this.remove(aside)
      return true
    }
    try {
      linkSync(aside, file)
    } catch (err) {
      if (errorCode(err) !== ALREADY_EXISTS) throw err
    } finally {
      this.remove(aside)
    }
    return false
  }

  private isLive(found: FoundClaim): boolean {
    const age = this.deps.now() - found.mtimeMs
    return found.owner !== null && age < CLAIM_STALE_MS && this.deps.isProcessAlive(found.owner.pid)
  }

  private remove(file: string): void {
    try {
      unlinkSync(file)
    } catch (err) {
      if (errorCode(err) !== NOT_FOUND) throw err
    }
  }
}

/** Folder of the shared claims, inside the canonical data folder every instance knows. */
export const SESSION_CLAIMS_DIR_NAME = 'session-claims'

/** The store of this process; none until the app names the shared folder. */
let store: SessionClaimStore | null = null

/** Use `dir` for the claims every Pi Desktop instance of this user shares. */
export function configureSessionClaims(dir: string | null): void {
  store = dir === null ? null : new SessionClaimStore(dir)
}

/** Claim a session for this app. Always true while no claim folder is configured. */
export function claimSession(sessionPath: string): boolean {
  return store?.claim(sessionPath) ?? true
}

/** Give up this app's claim on a session. */
export function releaseSession(sessionPath: string): void {
  store?.release(sessionPath)
}
