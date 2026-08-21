import { readdir, stat, readFile, writeFile, rename, mkdir } from 'fs/promises'
import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from 'fs'
import { basename, dirname, join } from 'path'
import { getSessionsRoot } from './pi-paths'
import { getPiCli } from './pi-rpc-manager'
import { getGuiDataPath } from './app-data-paths'
import type {
  ActivityStatsResult,
  ActivityRangeStats,
  ActivityRangeKey,
} from '../shared/ipc-contracts'

export const WINDOW_DAYS = 365 // trailing window shown as "1 Y"
const RETENTION_DAYS = 400 // prune per-session data older than this (~13 months)
const RANGE_DAYS: Record<ActivityRangeKey, number> = {
  '365': 365,
  '180': 180,
  '90': 90,
  '30': 30,
  '7': 7,
}
const STORE_FILE_NAME = 'activity-stats.json'
const STORE_VERSION = 1
const JSONL_EXTENSION = '.jsonl'
const MESSAGE_RECORD_TYPE = 'message'
const MS_PER_DAY = 86_400_000
const SAVE_DEBOUNCE_MS = 2000

/**
 * Per-day rollup for one session. Kept minimal but at day granularity so the
 * front-end range toggle (1 Y / 30d / 7d) stays exact — a session that spans a
 * range boundary only contributes the days inside the range.
 */
interface DayBucket {
  messages: number // all message records that day (user + assistant)
  models: Record<string, { input: number; output: number }> // assistant token usage by model
  hours: Record<string, number> // local hour (0..23, as string) -> message count
}

/** One session's persisted aggregate. Retained even after its file is deleted. */
interface SessionEntry {
  filePath: string
  mtimeMs: number
  days: Record<string, DayBucket> // YYYY-MM-DD -> bucket
}

interface StoreShape {
  version: number
  sessions: Record<string, SessionEntry> // sessionId -> entry
  // modelId -> latest display name seen in models.json. Retained even after a
  // model is removed from models.json, so historical stats keep a real name.
  modelNames: Record<string, string>
}

interface StatsStoreDeps {
  sessionsRoot?: string
  storePath?: string
  modelsConfigPath?: string
}

/** Local-time YYYY-MM-DD for a Date. */
function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function toFiniteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function sessionIdFromPath(filePath: string): string {
  const base = basename(filePath)
  return base.endsWith(JSONL_EXTENSION) ? base.slice(0, -JSONL_EXTENSION.length) : base
}

/** Reduce one session file's JSONL content into a per-day bucket map. */
function parseSessionContent(content: string): Record<string, DayBucket> {
  const days: Record<string, DayBucket> = {}
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const rec = record as { type?: unknown; timestamp?: unknown; message?: unknown }
    if (rec.type !== MESSAGE_RECORD_TYPE || typeof rec.timestamp !== 'string') continue
    const when = new Date(rec.timestamp)
    if (Number.isNaN(when.getTime())) continue

    const dayKey = localDayKey(when)
    const bucket = (days[dayKey] ??= { messages: 0, models: {}, hours: {} })
    bucket.messages += 1
    const hourKey = String(when.getHours())
    bucket.hours[hourKey] = (bucket.hours[hourKey] ?? 0) + 1

    const msg = rec.message as
      | { role?: unknown; model?: unknown; usage?: { input?: unknown; output?: unknown } }
      | undefined
    if (
      msg &&
      typeof msg === 'object' &&
      msg.role === 'assistant' &&
      typeof msg.model === 'string' &&
      msg.usage &&
      typeof msg.usage === 'object'
    ) {
      const model = (bucket.models[msg.model] ??= { input: 0, output: 0 })
      model.input += toFiniteNumber(msg.usage.input)
      model.output += toFiniteNumber(msg.usage.output)
    }
  }
  return days
}

/** Newest day key present in an entry, or '' if it has no days. */
function newestDay(entry: SessionEntry): string {
  let max = ''
  for (const key of Object.keys(entry.days)) if (key > max) max = key
  return max
}

/**
 * Persisted activity-stats store.
 *
 * The source of truth is Pi's session `.jsonl` files, but this store keeps a
 * per-session reduced aggregate on disk so stats survive session deletion:
 * present files are re-parsed when their mtime changes, files that vanish keep
 * their last-known aggregate. All totals sum over every retained entry.
 *
 * Capture points (see main/index.ts + ipc-handlers.ts):
 *  - startup baseline scan
 *  - each getStats() call (home screen)
 *  - synchronously before a session delete (preservation guarantee)
 *  - synchronously on app quit (all sessions touched this run)
 */
export class ActivityStatsStore {
  private readonly sessionsRoot?: string
  private readonly storePathOverride?: string
  private readonly modelsConfigPathOverride?: string
  private resolvedStorePath: string | null = null
  private store: StoreShape = { version: STORE_VERSION, sessions: {}, modelNames: {} }
  private loaded = false
  private dirty = false
  private saveTimer: NodeJS.Timeout | null = null

  constructor(deps: StatsStoreDeps = {}) {
    this.sessionsRoot = deps.sessionsRoot
    this.storePathOverride = deps.storePath
    this.modelsConfigPathOverride = deps.modelsConfigPath
  }

  private root(): string {
    return this.sessionsRoot ?? getSessionsRoot()
  }

  private modelsPath(): string {
    if (this.modelsConfigPathOverride) return this.modelsConfigPathOverride
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const root = getPiCli().kind === 'omp' ? join(homeDir, '.omp', 'agent') : join(homeDir, '.pi', 'agent')
    return join(root, 'models.json')
  }

  // Resolved lazily: the production singleton is constructed at import time,
  // before index.ts calls configureGuiDataDir() to set the userData path — so
  // resolving in the constructor would pick the legacy fallback dir.
  private storePath(): string {
    if (this.storePathOverride) return this.storePathOverride
    return (this.resolvedStorePath ??= getGuiDataPath(STORE_FILE_NAME))
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const path = this.storePath()
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as StoreShape).sessions === 'object' &&
          (parsed as StoreShape).sessions !== null
        ) {
          const p = parsed as StoreShape
          this.store = {
            version: STORE_VERSION,
            sessions: p.sessions,
            modelNames: p.modelNames && typeof p.modelNames === 'object' ? p.modelNames : {},
          }
        }
      }
    } catch {
      this.store = { version: STORE_VERSION, sessions: {}, modelNames: {} }
    }
  }

  /**
   * Refresh id→name mappings from models.json (last-one-wins across providers).
   * Overwrites with current names (so the latest label wins) but never deletes,
   * so a model removed from models.json keeps its last-known name. Returns true
   * if anything changed.
   */
  private updateModelNames(): boolean {
    let changed = false
    try {
      const parsed = JSON.parse(readFileSync(this.modelsPath(), 'utf-8')) as {
        providers?: Record<string, { models?: { id?: unknown; name?: unknown }[] }>
      }
      const providers = parsed.providers
      if (providers && typeof providers === 'object') {
        for (const provider of Object.values(providers)) {
          if (!provider || !Array.isArray(provider.models)) continue
          for (const m of provider.models) {
            if (typeof m?.id === 'string' && typeof m?.name === 'string' && m.name.length > 0) {
              if (this.store.modelNames[m.id] !== m.name) {
                this.store.modelNames[m.id] = m.name
                changed = true
              }
            }
          }
        }
      }
    } catch {
      // No models.json (or unreadable): keep whatever names we already have.
    }
    return changed
  }

  // ─── Scanning ──────────────────────────────────────────────────────────────

  /** Async incremental scan; parses only new/changed files. Marks dirty. */
  async refresh(now: Date = new Date()): Promise<void> {
    this.ensureLoaded()
    const files: string[] = []
    await collectFilesAsync(this.root(), files)
    for (const file of files) {
      const id = sessionIdFromPath(file)
      let mtimeMs: number
      try {
        mtimeMs = (await stat(file)).mtimeMs
      } catch {
        continue
      }
      const existing = this.store.sessions[id]
      if (existing && existing.filePath === file && existing.mtimeMs === mtimeMs) continue
      try {
        const content = await readFile(file, 'utf-8')
        this.store.sessions[id] = { filePath: file, mtimeMs, days: parseSessionContent(content) }
        this.dirty = true
      } catch {
        // Unreadable now; keep any prior aggregate rather than dropping it.
      }
    }
    if (this.updateModelNames()) this.dirty = true
    if (this.prune(now)) this.dirty = true
    this.scheduleSave()
  }

  /** Synchronous incremental scan + save. Used before delete and on quit. */
  flushSync(now: Date = new Date()): void {
    this.ensureLoaded()
    const files: string[] = []
    collectFilesSync(this.root(), files)
    for (const file of files) {
      const id = sessionIdFromPath(file)
      let mtimeMs: number
      try {
        mtimeMs = statSync(file).mtimeMs
      } catch {
        continue
      }
      const existing = this.store.sessions[id]
      if (existing && existing.filePath === file && existing.mtimeMs === mtimeMs) continue
      try {
        const content = readFileSync(file, 'utf-8')
        this.store.sessions[id] = { filePath: file, mtimeMs, days: parseSessionContent(content) }
        this.dirty = true
      } catch {
        // ignore
      }
    }
    if (this.updateModelNames()) this.dirty = true
    if (this.prune(now)) this.dirty = true
    this.saveSync()
  }

  /**
   * Roll up a single session file into the store synchronously, then persist.
   * Called just before the file is deleted so its final state is preserved.
   */
  captureBeforeDelete(sessionPath: string): void {
    this.ensureLoaded()
    const id = sessionIdFromPath(sessionPath)
    try {
      const mtimeMs = statSync(sessionPath).mtimeMs
      const content = readFileSync(sessionPath, 'utf-8')
      this.store.sessions[id] = { filePath: sessionPath, mtimeMs, days: parseSessionContent(content) }
      this.dirty = true
      this.saveSync()
    } catch {
      // If the file can't be read, leave any existing aggregate intact.
    }
  }

  /** Async scan then compute the result payload for the home screen. */
  async computeStats(now: Date = new Date()): Promise<ActivityStatsResult> {
    await this.refresh(now)
    return this.aggregate(now)
  }

  // ─── Retention ───────────────────────────────────────────────────────────

  /** Drop entries whose newest day is older than the retention window. */
  private prune(now: Date): boolean {
    const cutoff = localDayKey(new Date(now.getTime() - RETENTION_DAYS * MS_PER_DAY))
    let changed = false
    for (const [id, entry] of Object.entries(this.store.sessions)) {
      const newest = newestDay(entry)
      if (newest === '' || newest < cutoff) {
        delete this.store.sessions[id]
        changed = true
      }
    }
    return changed
  }

  // ─── Aggregation ───────────────────────────────────────────────────────────

  private aggregate(now: Date): ActivityStatsResult {
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const todayKey = localDayKey(todayMidnight)
    const windowStartKey = localDayKey(new Date(todayMidnight.getTime() - (WINDOW_DAYS - 1) * MS_PER_DAY))

    // Pool every retained session into one per-day view over the window.
    interface PooledDay {
      messages: number
      tokens: number
      models: Map<string, { input: number; output: number }>
      hours: number[]
      sessions: Set<string>
    }
    const perDay = new Map<string, PooledDay>()
    const dayOf = (key: string): PooledDay => {
      let d = perDay.get(key)
      if (!d) {
        d = { messages: 0, tokens: 0, models: new Map(), hours: new Array(24).fill(0), sessions: new Set() }
        perDay.set(key, d)
      }
      return d
    }

    for (const [id, entry] of Object.entries(this.store.sessions)) {
      for (const [dayKey, bucket] of Object.entries(entry.days)) {
        if (dayKey < windowStartKey || dayKey > todayKey) continue
        const d = dayOf(dayKey)
        d.messages += bucket.messages
        d.sessions.add(id)
        for (const [model, usage] of Object.entries(bucket.models)) {
          d.tokens += usage.input + usage.output
          const m = d.models.get(model) ?? { input: 0, output: 0 }
          m.input += usage.input
          m.output += usage.output
          d.models.set(model, m)
        }
        for (const [hourKey, count] of Object.entries(bucket.hours)) {
          const h = Number(hourKey)
          if (h >= 0 && h < 24) d.hours[h] += count
        }
      }
    }

    // Zero-filled ascending day series for the heatmap + token chart.
    const days: ActivityStatsResult['days'] = []
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const key = localDayKey(new Date(todayMidnight.getTime() - i * MS_PER_DAY))
      const d = perDay.get(key)
      const tokensByModel: Record<string, number> = {}
      if (d) for (const [model, u] of d.models) tokensByModel[model] = u.input + u.output
      days.push({ date: key, messages: d?.messages ?? 0, tokens: d?.tokens ?? 0, tokensByModel })
    }

    const ranges = {} as Record<ActivityRangeKey, ActivityRangeStats>
    for (const key of Object.keys(RANGE_DAYS) as ActivityRangeKey[]) {
      ranges[key] = this.aggregateRange(perDay, todayMidnight, RANGE_DAYS[key])
    }

    return { days, ranges }
  }

  private aggregateRange(
    perDay: Map<
      string,
      {
        messages: number
        tokens: number
        models: Map<string, { input: number; output: number }>
        hours: number[]
        sessions: Set<string>
      }
    >,
    todayMidnight: Date,
    rangeDays: number
  ): ActivityRangeStats {
    const startKey = localDayKey(new Date(todayMidnight.getTime() - (rangeDays - 1) * MS_PER_DAY))
    const todayKey = localDayKey(todayMidnight)

    let messages = 0
    let totalTokens = 0
    let activeDays = 0
    const sessions = new Set<string>()
    const models = new Map<string, { input: number; output: number }>()
    const hours = new Array(24).fill(0)
    const activeDayKeys = new Set<string>()

    for (const [dayKey, d] of perDay) {
      if (dayKey < startKey || dayKey > todayKey) continue
      if (d.messages > 0) {
        activeDays += 1
        activeDayKeys.add(dayKey)
      }
      messages += d.messages
      totalTokens += d.tokens
      for (const id of d.sessions) sessions.add(id)
      for (const [model, usage] of d.models) {
        const m = models.get(model) ?? { input: 0, output: 0 }
        m.input += usage.input
        m.output += usage.output
        models.set(model, m)
      }
      for (let h = 0; h < 24; h++) hours[h] += d.hours[h]
    }

    // Peak hour: busiest local hour, null if no activity.
    let peakHour: number | null = null
    let peakCount = 0
    for (let h = 0; h < 24; h++) {
      if (hours[h] > peakCount) {
        peakCount = hours[h]
        peakHour = h
      }
    }

    const modelList = [...models.entries()]
      .map(([model, u]) => ({
        model,
        name: this.store.modelNames[model] ?? null,
        input: u.input,
        output: u.output,
      }))
      .sort((a, b) => b.input + b.output - (a.input + a.output))

    const { currentStreak, longestStreak } = computeStreaks(activeDayKeys, todayMidnight, rangeDays)

    return {
      sessions: sessions.size,
      messages,
      totalTokens,
      activeDays,
      currentStreak,
      longestStreak,
      peakHour,
      models: modelList,
    }
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  private scheduleSave(): void {
    if (!this.dirty) return
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveAsync()
    }, SAVE_DEBOUNCE_MS)
    // Don't let the debounce timer keep the process alive on its own; Electron's
    // app lifecycle keeps main running, and quit does a synchronous flush.
    this.saveTimer.unref?.()
  }

  private async saveAsync(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const path = this.storePath()
    try {
      const dir = dirname(path)
      if (!existsSync(dir)) await mkdir(dir, { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(this.store), 'utf-8')
      await rename(tmp, path)
    } catch (err) {
      this.dirty = true // retry on next change
      console.error('Failed to save activity stats:', err)
    }
  }

  /** Synchronous atomic write (delete / quit paths). */
  private saveSync(): void {
    if (!this.dirty) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.dirty = false
    const path = this.storePath()
    try {
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.store), 'utf-8')
      renameSync(tmp, path)
    } catch (err) {
      this.dirty = true
      console.error('Failed to save activity stats:', err)
    }
  }
}

/** Longest and current (ending today) run of consecutive active days in range. */
function computeStreaks(
  activeDayKeys: Set<string>,
  todayMidnight: Date,
  rangeDays: number
): { currentStreak: number; longestStreak: number } {
  let currentStreak = 0
  for (let i = 0; i < rangeDays; i++) {
    const key = localDayKey(new Date(todayMidnight.getTime() - i * MS_PER_DAY))
    if (activeDayKeys.has(key)) currentStreak += 1
    else break
  }

  let longestStreak = 0
  let run = 0
  for (let i = rangeDays - 1; i >= 0; i--) {
    const key = localDayKey(new Date(todayMidnight.getTime() - i * MS_PER_DAY))
    if (activeDayKeys.has(key)) {
      run += 1
      if (run > longestStreak) longestStreak = run
    } else {
      run = 0
    }
  }

  return { currentStreak, longestStreak }
}

async function collectFilesAsync(dir: string, out: string[]): Promise<void> {
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    const full = join(dir, item.name)
    if (item.isDirectory()) await collectFilesAsync(full, out)
    else if (item.isFile() && item.name.endsWith(JSONL_EXTENSION)) out.push(full)
  }
}

function collectFilesSync(dir: string, out: string[]): void {
  let items
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    const full = join(dir, item.name)
    if (item.isDirectory()) collectFilesSync(full, out)
    else if (item.isFile() && item.name.endsWith(JSONL_EXTENSION)) out.push(full)
  }
}

/** Production singleton; retains its in-memory store across IPC calls. */
export const activityStatsStore = new ActivityStatsStore()
