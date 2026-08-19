import { createHash } from 'crypto'
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'
import { pathGroupKey } from '../shared/path-compare'
import { pathsEqual, sanitizePath } from './session-paths'
import type {
  WorkflowAgentDetail,
  WorkflowAgentSummary,
  WorkflowAgentStatus,
  WorkflowHistoryEntry,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowRunSummary,
  Workspace,
} from '../shared/ipc-contracts'

const WORKFLOW_HOME = join(homedir(), '.pi', 'workflows')
const WORKFLOW_PROJECTS_DIR = join(WORKFLOW_HOME, 'projects')
const WORKFLOW_SETTINGS_PATH = join(WORKFLOW_HOME, 'settings.json')
const MAX_HISTORY_ENTRIES = 150
const MAX_ENTRY_CHARS = 20_000
const MAX_TRANSCRIPT_CHARS = 160_000
const MAX_SCRIPT_CHARS = 120_000
const MAX_LOG_LINES = 200
const MAX_LOG_CHARS = 4_000
// Bounds for the read-only workflow project discovery (see discoverWorkflowProjects).
const MAX_DISCOVERED_PROJECTS = 100
const MAX_SESSION_DIRS_SCANNED = 200
const MAX_SESSION_FILES_INDEXED = 500
const MAX_SESSION_HEADER_BYTES = 4 * 1024
const MAX_RUNS_READ_PER_PROJECT = 3
const MAX_RUN_FILE_BYTES = 2 * 1024 * 1024
// pi-dynamic-workflows names project dirs `<slug>-<sha256(cwd).slice(0,12)>`.
const WORKFLOW_PROJECT_KEY_RE = /^[a-z0-9._-]{1,60}-[0-9a-f]{12}$/
const RUN_STATUSES = new Set<WorkflowRunStatus>([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'aborted',
])
const AGENT_STATUSES = new Set<WorkflowAgentStatus>([
  'queued',
  'running',
  'done',
  'error',
  'skipped',
])

interface UnknownRecord {
  [key: string]: unknown
}

interface CachedRun {
  mtimeMs: number
  size: number
  ino: number
  value: UnknownRecord
}

const runCache = new Map<string, CachedRun>()

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function boundedString(value: unknown, max = 500): string | undefined {
  const text = stringValue(value)
  return text ? text.slice(0, max) : undefined
}

function jsonText(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value.slice(0, max)
  try {
    return JSON.stringify(value, null, 2).slice(0, max)
  } catch {
    return '[unserializable value]'
  }
}

function sanitizeProjectName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return sanitized || 'project'
}

/** Mirrors pi-dynamic-workflows' project key without importing the extension. */
function workflowProjectKey(cwd: string): string {
  const projectPath = resolve(cwd)
  const projectName = sanitizeProjectName(basename(projectPath) || 'project')
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 12)
  return `${projectName}-${hash}`
}

/**
 * Read-only workspace projection for workflow files of a project that is not
 * registered in workspaces.json. `key` is optional: pass it for projects whose
 * resolved cwd does not recompute to the wanted key (unresolved projects get a
 * display-only path under the projects dir; the id still pins the real key).
 */
export function workflowWorkspaceForPath(cwd: string, key?: string): Workspace {
  const path = resolve(cwd)
  const projectKey = key ?? workflowProjectKey(path)
  const name = key ? slugFromProjectKey(key) : basename(path) || path
  return {
    id: `workflow-${projectKey}`,
    name,
    path,
    createdAt: 0,
    lastActiveAt: 0,
    color: '#6b7280',
  }
}

/** `pi-desktop-273acbe828fd` -> `pi-desktop`; passthrough when malformed. */
function slugFromProjectKey(key: string): string {
  return key.length > 13 ? key.slice(0, key.length - 13) : key
}

/** The project key embedded in a `workflow-<key>` workspace id, or null. */
function workflowKeyFromId(workspaceId: string): string | null {
  if (!workspaceId.startsWith('workflow-')) return null
  const key = workspaceId.slice('workflow-'.length)
  return WORKFLOW_PROJECT_KEY_RE.test(key) ? key : null
}

function workflowRunDirs(workspace: Workspace): string[] {
  // A `workflow-<key>` projection pins its project key even when its path is
  // display-only (unresolved projects); registered workspaces derive the key
  // from their (possibly healed) path as before.
  const key = workflowKeyFromId(workspace.id) ?? workflowProjectKey(workspace.path)
  return [
    join(WORKFLOW_PROJECTS_DIR, key, 'runs'),
    join(resolve(workspace.path), '.pi', 'workflows', 'runs'),
  ]
}

function workflowSessionsDir(cwd: string): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  const resolvedCwd = resolve(cwd)
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(agentDir, 'sessions', safePath)
}

// ─── Workflow project discovery ─────────────────────────────────────────────

/**
 * Result of the bounded discovery walk over `~/.pi/workflows/projects`.
 *
 * `projects` maps every on-disk project key to its real cwd, or null when the
 * cwd could not be recovered from the session store. `sessionDirCwds` maps
 * sanitized session dir names to the header cwd of their newest session, so
 * registered workspaces holding a lossy/phantom path can be repaired.
 */
export interface WorkflowProjectDiscovery {
  projects: Map<string, string | null>
  sessionDirCwds: Map<string, string>
}

let projectDiscoveryCache: { cacheKey: string; value: WorkflowProjectDiscovery } | null = null

/** Test helper: drop the discovery cache between cases. */
export function clearWorkflowProjectDiscoveryCache(): void {
  projectDiscoveryCache = null
}

/** `E:\Projects\AI\pi-desktop` -> `--E--Projects-AI-pi-desktop--`. */
function sessionDirKey(cwd: string): string {
  return pathGroupKey(sanitizePath(cwd))
}

/**
 * Bounded read of the session header's cwd: first complete line, first 4 KB.
 * Never throws; null when the file is unreadable or the header lacks a cwd.
 */
async function readSessionHeaderCwd(filePath: string): Promise<string | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_SESSION_HEADER_BYTES, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString('utf-8').split('\n', 1)[0]
    const record: unknown = JSON.parse(firstLine)
    return isRecord(record) && typeof record.cwd === 'string' && record.cwd.length > 0
      ? record.cwd
      : null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/** sessionId (header uuid) from a run record, without parsing the whole file. */
async function sessionIdFromRunFile(filePath: string): Promise<string | null> {
  try {
    const file = await stat(filePath)
    if (file.size <= 0 || file.size > MAX_RUN_FILE_BYTES) return null
    const text = await readFile(filePath, 'utf8')
    const match = /"sessionId"\s*:\s*"([^"]+)"/.exec(text)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** All parent session files in one dir, newest first. */
async function sessionFilesNewestFirst(sessionDir: string): Promise<string[]> {
  try {
    const names = (await readdir(sessionDir)).filter((name) => name.endsWith('.jsonl'))
    // Pi names parent sessions `<ISO-timestamp>_<uuid>.jsonl`; the fixed-width
    // timestamp makes a descending sort the newest-first order with no stats.
    return names.sort().reverse().map((name) => join(sessionDir, name))
  } catch {
    return []
  }
}

/**
 * Discover every workflow project on disk and its real cwd.
 *
 * Never reconstructs a path from a sanitized session dir name (lossy). Instead:
 *  1. `workflowProjectKey` of every known path (registered workspaces + launch
 *     cwd) is matched against the on-disk project keys;
 *  2. one bounded pass over the session store reads the header cwd of the
 *     newest session per dir and verifies it recomputes to a project key;
 *  3. unresolved keys fall back to their newest run JSONs' `sessionId`, which
 *     is matched against session filenames (`<timestamp>_<uuid>.jsonl`) and
 *     verified against the session header cwd.
 *
 * Every read is bounded (caps above), and the whole walk is cached on the
 * projects + sessions directory mtimes, so the runs-list poll does not rescan
 * session files (or huge run files) on every tick.
 */
export async function discoverWorkflowProjects(
  knownPaths: readonly string[] = []
): Promise<WorkflowProjectDiscovery> {
  const cacheKey = await discoveryCacheKey(knownPaths)
  if (cacheKey === null) {
    projectDiscoveryCache = null
    return { projects: new Map(), sessionDirCwds: new Map() }
  }
  if (projectDiscoveryCache && projectDiscoveryCache.cacheKey === cacheKey) {
    return projectDiscoveryCache.value
  }

  const projects = new Map<string, string | null>()
  let projectDirs: string[]
  try {
    projectDirs = (await readdir(WORKFLOW_PROJECTS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && WORKFLOW_PROJECT_KEY_RE.test(entry.name))
      .slice(0, MAX_DISCOVERED_PROJECTS)
      .map((entry) => entry.name)
  } catch {
    projectDirs = []
  }

  // (1) Known paths: exact key match, no reads. This is what keeps registered
  // workspace ids authoritative — a registered path that resolves here is never
  // shadowed by a projection.
  for (const dir of projectDirs) {
    projects.set(dir, null)
  }
  for (const known of knownPaths) {
    const key = workflowProjectKey(known)
    if (projects.has(key) && projects.get(key) === null) projects.set(key, resolve(known))
  }

  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  const sessionsRoot = join(agentDir, 'sessions')
  const sessionDirCwds = new Map<string, string>()
  const sessionUuidToFile = new Map<string, string>()
  let sessionDirsScanned = 0
  let filesIndexed = 0

  // (2) One bounded pass over the session store.
  let sessionDirNames: string[]
  try {
    sessionDirNames = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    sessionDirNames = []
  }
  for (const dirName of sessionDirNames) {
    if (sessionDirsScanned >= MAX_SESSION_DIRS_SCANNED) break
    sessionDirsScanned++
    const sessionDir = join(sessionsRoot, dirName)
    // One readdir per dir serves both the header scan and the uuid index.
    const files = await sessionFilesNewestFirst(sessionDir)

    const headerCwd = await readSessionHeaderCwd(files[0])
    if (headerCwd) {
      sessionDirCwds.set(pathGroupKey(dirName), headerCwd)
      const key = workflowProjectKey(headerCwd)
      if (projects.has(key) && projects.get(key) === null) projects.set(key, resolve(headerCwd))
    }

    // Index parent session uuids from filenames alone (no reads) for the
    // run-sessionId fallback below.
    for (const name of files) {
      if (filesIndexed >= MAX_SESSION_FILES_INDEXED) break
      const stem = basename(name, '.jsonl')
      const underscore = stem.lastIndexOf('_')
      if (underscore > 0 && underscore < stem.length - 1) {
        sessionUuidToFile.set(stem.slice(underscore + 1), name)
        filesIndexed++
      }
    }
  }

  // (3) Run-sessionId fallback for keys the header scan could not resolve.
  for (const [key, cwd] of [...projects]) {
    if (cwd !== null) continue
    const runsDir = join(WORKFLOW_PROJECTS_DIR, key, 'runs')
    let runFiles: string[]
    try {
      const names = (await readdir(runsDir)).filter((name) => name.endsWith('.json'))
      const newest = await Promise.all(
        names.map(async (name) => {
          try {
            return { name, mtimeMs: (await stat(join(runsDir, name))).mtimeMs }
          } catch {
            return null
          }
        })
      )
      runFiles = newest
        .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_RUNS_READ_PER_PROJECT)
        .map((entry) => join(runsDir, entry.name))
    } catch {
      continue
    }
    for (const runFile of runFiles) {
      const sessionId = await sessionIdFromRunFile(runFile)
      if (!sessionId) continue
      const sessionFile = sessionUuidToFile.get(sessionId)
      if (!sessionFile) continue
      const headerCwd = await readSessionHeaderCwd(sessionFile)
      if (headerCwd && workflowProjectKey(headerCwd) === key) {
        projects.set(key, resolve(headerCwd))
        break
      }
    }
  }

  const value: WorkflowProjectDiscovery = { projects, sessionDirCwds }
  projectDiscoveryCache = { cacheKey, value }
  return value
}

/** mtime+size of both store roots; null when the projects dir is missing. */
async function discoveryCacheKey(knownPaths: readonly string[]): Promise<string | null> {
  try {
    const [projects, sessions] = await Promise.all([
      stat(WORKFLOW_PROJECTS_DIR),
      stat(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions')),
    ])
    // Known paths are cheap to fold in and change only with workspace state.
    const known = knownPaths.map((p) => workflowProjectKey(p)).join(',')
    return `${projects.mtimeMs}:${projects.size}:${sessions.mtimeMs}:${sessions.size}:${known}`
  } catch {
    return null
  }
}

/**
 * The single workspace projection shared by workflow list, getRun and control.
 *
 * Registered workspaces keep their ids and (on-disk) paths. A registered path
 * whose key has no project dir is checked against the session-store scan: if
 * its sanitized session dir's headers point at a real project (the lossy-decode
 * phantom case), the returned projection carries the healed real cwd in memory
 * only — workspaces.json is never rewritten and no sidebar workspace is created.
 * Unregistered projects get a read-only `workflow-<key>` projection (real cwd
 * when discovered, display-only path otherwise) that never spawns a Pi manager.
 */
export async function resolveWorkflowWorkspaces(
  registered: readonly Workspace[]
): Promise<Workspace[]> {
  const knownPaths = [...registered.map((ws) => ws.path), process.cwd()]
  const discovery = await discoverWorkflowProjects(knownPaths)
  const out: Workspace[] = []
  const coveredKeys = new Set<string>()

  for (const ws of registered) {
    const key = workflowProjectKey(ws.path)
    coveredKeys.add(key)
    let effective = ws
    if (!discovery.projects.has(key)) {
      // No runs at the registered path. If it is a phantom (lossy session-dir
      // decode), the session headers reveal the real cwd of the project whose
      // runs exist on disk — heal the projection in memory, keeping the id.
      const headerCwd = discovery.sessionDirCwds.get(sessionDirKey(ws.path))
      if (headerCwd && !pathsEqual(headerCwd, ws.path)) {
        const healedKey = workflowProjectKey(headerCwd)
        if (discovery.projects.has(healedKey)) {
          effective = { ...ws, path: headerCwd, name: basename(headerCwd) || headerCwd }
          coveredKeys.add(healedKey)
        }
      }
    }
    out.push(effective)
  }

  // Read-only projections for every project dir without a registered workspace.
  for (const [key, cwd] of discovery.projects) {
    if (coveredKeys.has(key)) continue
    coveredKeys.add(key)
    out.push(
      cwd
        ? workflowWorkspaceForPath(cwd)
        : workflowWorkspaceForPath(join(WORKFLOW_PROJECTS_DIR, key), key)
    )
  }

  // The launch cwd must stay visible even before its first run is persisted.
  const launchKey = workflowProjectKey(process.cwd())
  if (!coveredKeys.has(launchKey)) {
    out.push(workflowWorkspaceForPath(process.cwd()))
  }

  return out
}

function toStatus(value: unknown): WorkflowRunStatus {
  return typeof value === 'string' && RUN_STATUSES.has(value as WorkflowRunStatus)
    ? (value as WorkflowRunStatus)
    : 'pending'
}

function toAgentStatus(value: unknown): WorkflowAgentStatus {
  return typeof value === 'string' && AGENT_STATUSES.has(value as WorkflowAgentStatus)
    ? (value as WorkflowAgentStatus)
    : 'queued'
}

function toTokenUsage(value: unknown): WorkflowRunSummary['tokenUsage'] | undefined {
  if (!isRecord(value)) return undefined
  const input = numberValue(value.input)
  const output = numberValue(value.output)
  const total = numberValue(value.total)
  if (input === undefined || output === undefined || total === undefined) return undefined
  const cost = numberValue(value.cost)
  const cacheRead = numberValue(value.cacheRead)
  const cacheWrite = numberValue(value.cacheWrite)
  return {
    input,
    output,
    total,
    ...(cost === undefined ? {} : { cost }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  }
}

function normalizeHistoryEntry(value: unknown): WorkflowHistoryEntry | null {
  if (!isRecord(value)) return null
  const text = boundedString(value.text, MAX_ENTRY_CHARS) ?? ''
  const role = stringValue(value.role) ?? 'system'
  const kind = stringValue(value.kind) ?? 'text'
  const entry: WorkflowHistoryEntry = { role, kind, text }
  const id = stringValue(value.id)
  const timestamp = stringValue(value.timestamp)
  const toolName = stringValue(value.toolName)
  const path = stringValue(value.path)
  const diff = boundedString(value.diff, MAX_ENTRY_CHARS)
  if (id) entry.id = id
  if (timestamp) entry.timestamp = timestamp
  if (toolName) entry.toolName = toolName
  if (path) entry.path = path
  if (diff) entry.diff = diff
  if (typeof value.isError === 'boolean') entry.isError = value.isError
  return entry
}

function normalizeHistory(value: unknown): WorkflowHistoryEntry[] {
  if (!Array.isArray(value)) return []
  const result: WorkflowHistoryEntry[] = []
  let chars = 0
  for (const item of value.slice(-MAX_HISTORY_ENTRIES)) {
    const entry = normalizeHistoryEntry(item)
    if (!entry) continue
    chars += entry.text.length + (entry.diff?.length ?? 0)
    if (chars > MAX_TRANSCRIPT_CHARS) break
    result.push(entry)
  }
  return result
}

function projectRun(workspace: Workspace, raw: UnknownRecord): WorkflowRunSummary | null {
  const runId = stringValue(raw.runId)
  const workflowName = stringValue(raw.workflowName)
  const startedAt = stringValue(raw.startedAt)
  const updatedAt = stringValue(raw.updatedAt)
  if (!runId || !workflowName || !startedAt || !updatedAt) return null

  const phases = Array.isArray(raw.phases)
    ? raw.phases.filter((phase): phase is string => typeof phase === 'string')
    : []
  const agents = Array.isArray(raw.agents)
    ? raw.agents.flatMap((value): WorkflowRunSummary['agents'] => {
        if (!isRecord(value)) return []
        const id = numberValue(value.id)
        const label = stringValue(value.label)
        if (id === undefined || !label) return []
        const error = boundedString(value.error)
        const resultPreview = boundedString(value.resultPreview, 4_000)
        const tokens = numberValue(value.tokens)
        const model = stringValue(value.model)
        const started = stringValue(value.startedAt)
        const ended = stringValue(value.endedAt)
        const callId = stringValue(value.callId)
        const errorCode = stringValue(value.errorCode)
        const tokenUsage = toTokenUsage(value.tokenUsage)
        return [{
          id,
          ...(callId ? { callId } : {}),
          label,
          ...(stringValue(value.phase) ? { phase: value.phase as string } : {}),
          status: toAgentStatus(value.status),
          ...(error ? { error } : {}),
          ...(errorCode ? { errorCode } : {}),
          ...(typeof value.recoverable === 'boolean' ? { recoverable: value.recoverable } : {}),
          hasHistory: Array.isArray(value.history) && value.history.length > 0,
          ...(resultPreview ? { resultPreview } : {}),
          ...(tokens === undefined ? {} : { tokens }),
          ...(model ? { model } : {}),
          ...(started ? { startedAt: started } : {}),
          ...(ended ? { endedAt: ended } : {}),
          ...(tokenUsage ? { tokenUsage } : {}),
        }]
      })
    : []
  const tokenUsage = toTokenUsage(raw.tokenUsage)
  const sessionId = stringValue(raw.sessionId)
  const pauseReason = boundedString(raw.pauseReason)
  const resetHint = boundedString(raw.resetHint)

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    cwd: workspace.path,
    runId,
    workflowName,
    ...(sessionId ? { sessionId } : {}),
    status: toStatus(raw.status),
    ...(pauseReason ? { pauseReason } : {}),
    ...(resetHint ? { resetHint } : {}),
    phases,
    ...(stringValue(raw.currentPhase) ? { currentPhase: raw.currentPhase as string } : {}),
    agents,
    startedAt,
    updatedAt,
    ...(numberValue(raw.durationMs) === undefined ? {} : { durationMs: raw.durationMs as number }),
    ...(tokenUsage ? { tokenUsage } : {}),
  }
}

async function readJson(path: string): Promise<UnknownRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

async function readRunFiles(dir: string): Promise<UnknownRecord[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const values = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
    const filePath = join(dir, name)
    try {
      const file = await stat(filePath)
      const cached = runCache.get(filePath)
      if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size && cached.ino === file.ino) {
        return cached.value
      }
      const value = await readJson(filePath)
      if (value) runCache.set(filePath, { mtimeMs: file.mtimeMs, size: file.size, ino: file.ino, value })
      else runCache.delete(filePath)
      return value
    } catch {
      runCache.delete(filePath)
      return null
    }
  }))
  return values.filter((value): value is UnknownRecord => value !== null)
}

async function readRunRecord(workspace: Workspace, runId: string): Promise<UnknownRecord | null> {
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(runId)) return null
  for (const dir of workflowRunDirs(workspace)) {
    const primary = await readJson(join(dir, `${runId}.json`))
    if (primary) return primary
    const backup = await readJson(join(dir, `${runId}.json.bak`))
    if (backup) return backup
  }
  return null
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((block) => {
      if (!isRecord(block)) return ''
      if (typeof block.text === 'string') return block.text
      if (typeof block.thinking === 'string') return block.thinking
      if (block.type === 'toolCall') return jsonText(block, MAX_ENTRY_CHARS) ?? ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function sessionHistory(entries: UnknownRecord[]): WorkflowHistoryEntry[] {
  const result: WorkflowHistoryEntry[] = []
  for (const entry of entries) {
    if (entry.type !== 'message' || !isRecord(entry.message)) continue
    const message = entry.message
    const role = stringValue(message.role) ?? 'system'
    const timestamp = stringValue(entry.timestamp)
    const content = Array.isArray(message.content) ? message.content : [message.content]
    if (role === 'assistant') {
      for (const block of content) {
        if (!isRecord(block)) continue
        const kind = block.type === 'thinking' ? 'thinking' : block.type === 'toolCall' ? 'toolCall' : 'text'
        const text = block.type === 'toolCall'
          ? jsonText(block, MAX_ENTRY_CHARS) ?? ''
          : contentText([block])
        if (text) result.push({
          role,
          kind,
          text: text.slice(0, MAX_ENTRY_CHARS),
          ...(timestamp ? { timestamp } : {}),
          ...(stringValue(block.name) ? { toolName: block.name as string } : {}),
        })
      }
      continue
    }
    const text = contentText(message.content).slice(0, MAX_ENTRY_CHARS)
    if (!text) continue
    result.push({
      role,
      kind: role === 'toolResult' ? 'toolResult' : 'text',
      text,
      ...(timestamp ? { timestamp } : {}),
      ...(stringValue(message.toolName) ? { toolName: message.toolName as string } : {}),
      ...(message.isError === true ? { isError: true } : {}),
    })
  }
  return normalizeHistory(result)
}

interface PersistedSessionMatch {
  history: WorkflowHistoryEntry[]
  sessionName: string
}

async function findPersistedSession(cwd: string, runId: string, agent: UnknownRecord): Promise<PersistedSessionMatch | null> {
  let names: string[]
  try {
    names = (await readdir(workflowSessionsDir(cwd))).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return null
  }

  const expected = `workflow:${runId} `
  const prompt = stringValue(agent.prompt)
  const matches: PersistedSessionMatch[] = []
  for (const name of names) {
    let lines: string[]
    try {
      lines = (await readFile(join(workflowSessionsDir(cwd), name), 'utf8')).split(/\r?\n/)
    } catch {
      continue
    }
    const entries: UnknownRecord[] = []
    let sessionName: string | undefined
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const value: unknown = JSON.parse(line)
        if (!isRecord(value)) continue
        if (value.type === 'session_info') sessionName = stringValue(value.name)
        entries.push(value)
      } catch {
        // A live session can end with a partial JSONL line; keep the readable prefix.
      }
    }
    if (!sessionName?.startsWith(expected)) continue
    // The header cwd is authoritative: session dir names are lossy decodes of
    // real paths (hyphens vs separators collide), so a caller holding a
    // phantom/decoded path still lands on the same physical dir — the
    // runId-prefixed name, not the cwd, is what uniquely identifies this
    // run's transcript. Rejecting on a cwd mismatch is what silently degraded
    // transcripts to run-history for hyphenated projects.
    const history = sessionHistory(entries)
    const matchesPrompt = prompt && history.some((item) => item.role === 'user' && item.text.includes(prompt))
    const match = { history, sessionName }
    if (matchesPrompt) return match
    matches.push(match)
  }
  return matches[0] ?? null
}

async function projectAgentDetail(
  workspace: Workspace,
  runId: string,
  value: UnknownRecord,
  summary: WorkflowAgentSummary
): Promise<WorkflowAgentDetail> {
  const runHistory = normalizeHistory(value.history)
  const persisted = await findPersistedSession(workspace.path, runId, value)
  const history = persisted?.history.length ? persisted.history : runHistory
  const resultText = jsonText(value.result ?? value.resultPreview, MAX_ENTRY_CHARS)
  const prompt = stringValue(value.prompt)
  return {
    ...summary,
    ...(prompt ? { prompt: prompt.slice(0, MAX_ENTRY_CHARS) } : {}),
    ...(resultText ? { resultText } : {}),
    history,
    transcriptSource: persisted?.history.length ? 'persisted-session' : runHistory.length ? 'run-history' : 'none',
    transcriptComplete: !!persisted?.history.length,
  }
}

async function readWorkspaceRuns(workspace: Workspace): Promise<WorkflowRunSummary[]> {
  const byId = new Map<string, WorkflowRunSummary>()
  // Primary storage wins over the legacy project-local directory if both exist.
  for (const dir of workflowRunDirs(workspace)) {
    for (const raw of await readRunFiles(dir)) {
      const run = projectRun(workspace, raw)
      if (run && !byId.has(run.runId)) byId.set(run.runId, run)
    }
  }
  return [...byId.values()]
}

export async function listWorkflowRuns(workspaces: Workspace[]): Promise<WorkflowRunSummary[]> {
  const runs = (await Promise.all(workspaces.map(readWorkspaceRuns))).flat()
  return runs.sort((a, b) => {
    const time = (value: string): number => Date.parse(value) || 0
    return time(b.updatedAt) - time(a.updatedAt)
  })
}

export async function setWorkflowPersistence(enabled: boolean): Promise<void> {
  let existing: UnknownRecord = {}
  try {
    const value: unknown = JSON.parse(await readFile(WORKFLOW_SETTINGS_PATH, 'utf8'))
    if (isRecord(value)) existing = value
  } catch {
    // Missing or malformed settings are replaced with the one safe preference.
  }
  await mkdir(WORKFLOW_HOME, { recursive: true })
  const tempPath = `${WORKFLOW_SETTINGS_PATH}.tmp`
  await writeFile(tempPath, `${JSON.stringify({ ...existing, persistAgentSessions: enabled }, null, 2)}\n`, 'utf8')
  await rename(tempPath, WORKFLOW_SETTINGS_PATH)
}

export async function getWorkflowRun(workspace: Workspace, runId: string): Promise<WorkflowRunDetail | null> {
  const raw = await readRunRecord(workspace, runId)
  if (!raw) return null
  const summary = projectRun(workspace, raw)
  if (!summary) return null
  const rawAgents = Array.isArray(raw.agents) ? raw.agents.filter(isRecord) : []
  const agents = await Promise.all(rawAgents.map(async (agent) => {
    const id = numberValue(agent.id)
    const fallback = summary.agents.find((candidate) => candidate.id === id)
    if (id === undefined || !fallback) return null
    return projectAgentDetail(workspace, runId, agent, fallback)
  }))
  const logs = Array.isArray(raw.logs)
    ? raw.logs
        .filter((line): line is string => typeof line === 'string')
        .slice(-MAX_LOG_LINES)
        .map((line) => line.slice(0, MAX_LOG_CHARS))
    : []
  return {
    ...summary,
    ...(boundedString(raw.script, MAX_SCRIPT_CHARS) ? { script: boundedString(raw.script, MAX_SCRIPT_CHARS) } : {}),
    ...(raw.args === undefined ? {} : { argsText: jsonText(raw.args, MAX_ENTRY_CHARS) }),
    ...(raw.result === undefined ? {} : { resultText: jsonText(raw.result, MAX_TRANSCRIPT_CHARS) }),
    logs,
    agents: agents.filter((agent): agent is WorkflowAgentDetail => agent !== null),
  }
}
