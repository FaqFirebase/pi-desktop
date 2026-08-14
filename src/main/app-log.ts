import { appendFile, rename, readFile, mkdir, stat } from 'fs/promises'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { getGuiDataPath } from './app-data-paths'
import type { AppLogEntry } from '../shared/ipc-contracts'

export const LOG_FILE_NAME = 'app-log.jsonl'
/** Entries kept in memory (and read back from the file tail) for diagnostics. */
export const RECENT_LIMIT = 200
const SAVE_DEBOUNCE_MS = 2000
/** When the log file grows past this, it is rotated to `<name>.1`. */
export const MAX_LOG_BYTES = 512 * 1024

interface AppLogDeps {
  /** Test override; production resolves lazily via getGuiDataPath. */
  logPath?: string
  now?: () => number
  /** Test override for the write debounce. */
  flushDelayMs?: number
}

function isAppLogEntry(value: unknown): value is AppLogEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.ts === 'number' &&
    (entry.level === 'info' || entry.level === 'warn' || entry.level === 'error') &&
    typeof entry.scope === 'string' &&
    typeof entry.message === 'string' &&
    (entry.detail === undefined || typeof entry.detail === 'string')
  )
}

/** Stringify arbitrary thrown values / extra context for the detail field. */
export function describeLogDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined
  if (detail instanceof Error) return detail.stack ?? detail.message
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

function parseLogLines(text: string): AppLogEntry[] {
  const entries: AppLogEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isAppLogEntry(parsed)) entries.push(parsed)
    } catch {
      // Skip lines corrupted by a crash mid-append.
    }
  }
  return entries
}

/**
 * Main-process application log: bounded in-memory ring for the diagnostics
 * view plus a debounced JSONL file in the GUI data dir so errors survive into
 * packaged builds (where the launching terminal's console output is lost).
 */
export class AppLog {
  private readonly logPathOverride?: string
  private readonly now: () => number
  private readonly flushDelayMs: number
  // Resolved lazily: the production singleton is constructed at import time,
  // before index.ts calls configureGuiDataDir() to set the userData path.
  private resolvedLogPath: string | null = null
  private recent: AppLogEntry[] = []
  private pending: AppLogEntry[] = []
  private seeded = false
  private flushTimer: NodeJS.Timeout | null = null

  constructor(deps: AppLogDeps = {}) {
    this.logPathOverride = deps.logPath
    this.now = deps.now ?? Date.now
    this.flushDelayMs = deps.flushDelayMs ?? SAVE_DEBOUNCE_MS
  }

  private logPath(): string {
    if (this.logPathOverride) return this.logPathOverride
    return (this.resolvedLogPath ??= getGuiDataPath(LOG_FILE_NAME))
  }

  info(scope: string, message: string, detail?: unknown): void {
    this.log('info', scope, message, detail)
  }

  warn(scope: string, message: string, detail?: unknown): void {
    this.log('warn', scope, message, detail)
  }

  error(scope: string, message: string, detail?: unknown): void {
    this.log('error', scope, message, detail)
  }

  log(level: AppLogEntry['level'], scope: string, message: string, detail?: unknown): void {
    this.ensureSeeded()
    const entry: AppLogEntry = { ts: this.now(), level, scope, message }
    const described = describeLogDetail(detail)
    if (described !== undefined) entry.detail = described
    this.recent.push(entry)
    if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT)
    this.pending.push(entry)
    this.scheduleFlush()
  }

  /** Recent entries, oldest first, including the previous run's file tail. */
  getRecent(): AppLogEntry[] {
    this.ensureSeeded()
    return [...this.recent]
  }

  // Seed the ring from the existing file's tail so diagnostics can show what
  // happened before a crash/restart, not just the current run.
  private ensureSeeded(): void {
    if (this.seeded) return
    this.seeded = true
    try {
      const text = readFileSync(this.logPath(), 'utf-8')
      this.recent = parseLogLines(text).slice(-RECENT_LIMIT)
    } catch {
      // No prior log file (or unreadable) — start empty.
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushAsync()
    }, this.flushDelayMs)
    // The debounce timer must never keep the process alive; quit paths call
    // flushSync explicitly.
    this.flushTimer.unref?.()
  }

  private async flushAsync(): Promise<void> {
    if (this.pending.length === 0) return
    // Entries stay in `pending` until the write completes, so a quit-time
    // flushSync landing mid-write can still persist them (a rare duplicate
    // batch beats losing the final errors of a run).
    const batch = this.pending.length
    const lines = this.pending.slice(0, batch).map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    const path = this.logPath()
    try {
      const dir = dirname(path)
      if (!existsSync(dir)) await mkdir(dir, { recursive: true })
      await this.rotateIfNeeded()
      await appendFile(path, lines, 'utf-8')
      this.pending.splice(0, batch)
    } catch (err) {
      // Nowhere better to report a log-write failure than the console; the
      // entries stay pending and ride the next flush.
      console.error('[app-log] Failed to write log file:', err)
    }
  }

  /** Synchronous flush for quit paths. */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending.length === 0) return
    const lines = this.pending.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    const path = this.logPath()
    try {
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      this.rotateIfNeededSync()
      appendFileSync(path, lines, 'utf-8')
      this.pending = []
    } catch (err) {
      console.error('[app-log] Failed to write log file:', err)
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    const path = this.logPath()
    try {
      if ((await stat(path)).size > MAX_LOG_BYTES) await rename(path, `${path}.1`)
    } catch {
      // Missing file — nothing to rotate.
    }
  }

  private rotateIfNeededSync(): void {
    const path = this.logPath()
    try {
      if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // Missing file — nothing to rotate.
    }
  }

  /** Test hook: read the persisted file (post-flush) as parsed entries. */
  async readPersisted(): Promise<AppLogEntry[]> {
    try {
      return parseLogLines(await readFile(this.logPath(), 'utf-8'))
    } catch {
      return []
    }
  }
}

export const appLog = new AppLog()
