/**
 * Subagent rows shown by the Tasks panel, the rail badge and the strip above
 * the composer.
 *
 * Two sources feed one list. OMP reports its own subagents over RPC
 * (`subagent_lifecycle` / `subagent_progress` events and `get_subagents`).
 * Pi has no built-in subagents: the `pi-subagents` extension reports
 * background runs as a JSON widget line and foreground runs through the spawn
 * tool's details. Everything here is pure, so main, the renderer and the
 * tests share one reading of those payloads.
 */

export type SubagentTaskSource = 'omp' | 'pi-subagents'

export type SubagentTaskStatus = 'running' | 'done' | 'failed' | 'stopped'

/** How a row's transcript is fetched. `none`: this row has no live view. */
export type SubagentTranscriptRef =
  | { kind: 'omp'; subagentId: string }
  | { kind: 'pi-async'; asyncId: string; childId?: string }
  | { kind: 'pi-foreground'; sessionFile?: string }
  | { kind: 'none' }

export interface SubagentTask {
  id: string
  source: SubagentTaskSource
  agent: string
  label: string
  status: SubagentTaskStatus
  currentTool?: string
  toolCount?: number
  tokens?: number
  durationMs?: number
  /** Last output lines a foreground run streams before its transcript exists. */
  recentOutput?: string[]
  /** The spawn tool call, set only on rows derived from tool events. */
  toolCallId?: string
  transcriptRef: SubagentTranscriptRef
}

export const DEFAULT_SUBAGENT_AGENT = 'subagent'
const MAX_LABEL_CHARS = 160
const MAX_RECENT_OUTPUT_LINES = 5

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-blank string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** A finite, non-negative number, or undefined. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function clip(value: string): string {
  return value.length > MAX_LABEL_CHARS ? value.slice(0, MAX_LABEL_CHARS) : value
}

/**
 * Every status word the two sources use. OMP: started/completed/failed/
 * aborted, plus its progress words. pi-subagents: queued/running/complete/
 * failed/partial/paused/stopped/rejected, plus foreground pending/detached.
 * A Map, so an unknown word such as "constructor" never hits a prototype key.
 */
const STATUS_BY_WORD: ReadonlyMap<string, SubagentTaskStatus> = new Map<string, SubagentTaskStatus>([
  ['started', 'running'], ['pending', 'running'], ['queued', 'running'], ['starting', 'running'],
  ['running', 'running'], ['paused', 'running'], ['detached', 'running'], ['active', 'running'],
  ['completed', 'done'], ['complete', 'done'], ['done', 'done'],
  ['failed', 'failed'], ['error', 'failed'], ['partial', 'failed'], ['rejected', 'failed'],
  ['aborted', 'stopped'], ['stopped', 'stopped'],
])

export function normalizeSubagentStatus(value: unknown): SubagentTaskStatus | null {
  return typeof value === 'string' ? STATUS_BY_WORD.get(value) ?? null : null
}

export function countRunningSubagentTasks(tasks: readonly SubagentTask[]): number {
  return tasks.filter((task) => task.status === 'running').length
}

/**
 * Rows the composer strip shows: every running row, plus rows that are not in
 * `knownAtTurnStart` (the ids the chat had when the current turn began).
 * Older finished rows stay in the Tasks panel only.
 */
export function stripSubagentTasks(tasks: readonly SubagentTask[], knownAtTurnStart: ReadonlySet<string>): SubagentTask[] {
  return tasks.filter((task) => task.status === 'running' || !knownAtTurnStart.has(task.id))
}

/**
 * Tool names that spawn a subagent.
 *
 * Pi delegates through the `pi-subagents` package, which registers `subagent`
 * and `subagent_wait`. OMP has delegation built in and groups it under
 * coordination as `task` (delegate one) and `hub` (fan out to several); `hub`
 * is what a plain "use the reviewer agent" request actually calls, observed on
 * the wire.
 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['subagent', 'subagent_wait', 'task', 'hub'])

export function isSubagentTool(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName)
}

/**
 * First non-empty string among `keys`, or null.
 *
 * The two engines label a spawn with different argument names, so the label
 * is resolved by trying the plausible keys rather than hard-coding one
 * engine's spelling. A miss costs a generic label, never a missing row.
 */
function firstStringArg(args: UnknownRecord | undefined, keys: readonly string[]): string | null {
  if (!args) return null
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** Which agent a spawn targets. Both engines have used `agent`; the rest are fallbacks. */
export function subagentAgentName(args: UnknownRecord | undefined): string {
  return firstStringArg(args, ['agent', 'agentType', 'subagent_type', 'name', 'type']) ?? DEFAULT_SUBAGENT_AGENT
}

/** The instruction given to the spawn, used as the row's caption. */
export function subagentTaskText(args: UnknownRecord | undefined): string {
  return firstStringArg(args, ['task', 'prompt', 'description', 'instructions', 'message']) ?? ''
}

function currentToolOf(progress: UnknownRecord): string | undefined {
  const direct = text(progress.currentTool) ?? text(progress.tool)
  if (direct) return direct
  const recent: unknown[] = Array.isArray(progress.recentTools) ? progress.recentTools : []
  const last = recent[recent.length - 1]
  if (isRecord(last)) return text(last.name) ?? text(last.tool)
  return text(last)
}

function recentOutputOf(progress: UnknownRecord): string[] | undefined {
  if (!Array.isArray(progress.recentOutput)) return undefined
  const lines = (progress.recentOutput as unknown[]).filter((line): line is string => typeof line === 'string')
  return lines.length > 0 ? lines.slice(-MAX_RECENT_OUTPUT_LINES) : undefined
}

/** The live numbers a progress record carries, without undefined keys. */
function progressFields(progress: UnknownRecord): Partial<SubagentTask> {
  const currentTool = currentToolOf(progress)
  const toolCount = count(progress.toolCount)
  const tokens = count(progress.tokens)
  const durationMs = count(progress.durationMs)
  const recentOutput = recentOutputOf(progress)
  return {
    ...(currentTool ? { currentTool } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(recentOutput ? { recentOutput } : {}),
  }
}

export function upsertSubagentTask(tasks: SubagentTask[], task: SubagentTask): SubagentTask[] {
  const index = tasks.findIndex((existing) => existing.id === task.id)
  if (index === -1) return [...tasks, task]
  const next = tasks.slice()
  next[index] = task
  return next
}

/** Swap the rows of one spawn for `next`, keeping their place in the list. */
function replaceToolCallTasks(tasks: SubagentTask[], toolCallId: string, next: SubagentTask[]): SubagentTask[] {
  const first = tasks.findIndex((task) => task.toolCallId === toolCallId)
  const kept = tasks.filter((task) => task.toolCallId !== toolCallId)
  if (first === -1) return [...kept, ...next]
  return [...kept.slice(0, first), ...next, ...kept.slice(first)]
}

export interface SubagentToolEvent {
  source: SubagentTaskSource
  toolCallId: string
  args: UnknownRecord | undefined
  details: unknown
  phase: 'start' | 'update' | 'end'
  isError: boolean
}

/** pi-subagents reports status, list, stop and similar calls with this details mode. */
const MANAGEMENT_DETAILS_MODE = 'management'

/**
 * A call of the spawn tool that manages runs instead of starting one
 * (`subagent({action: "status"})` and the like). It must add no row: the rows
 * stay for the whole chat, so each such call would leave a blank one.
 */
function isManagementCall(event: SubagentToolEvent): boolean {
  if (typeof event.args?.action === 'string') return true
  return isRecord(event.details) && event.details.mode === MANAGEMENT_DETAILS_MODE
}

function endStatus(isError: boolean): SubagentTaskStatus {
  return isError ? 'failed' : 'done'
}

/** OMP tool rows exist only when OMP has no subagent RPC, so they have no live view. */
function toolRowRef(source: SubagentTaskSource, sessionFile?: string): SubagentTranscriptRef {
  if (source === 'omp') return { kind: 'none' }
  return sessionFile ? { kind: 'pi-foreground', sessionFile } : { kind: 'pi-foreground' }
}

function argsTask(event: SubagentToolEvent, status: SubagentTaskStatus): SubagentTask {
  return {
    id: event.toolCallId,
    source: event.source,
    agent: subagentAgentName(event.args),
    label: clip(subagentTaskText(event.args)),
    status,
    toolCallId: event.toolCallId,
    transcriptRef: toolRowRef(event.source),
  }
}

/** Rows from structured spawn details, or null when the details carry none. */
function tasksFromToolDetails(event: SubagentToolEvent): SubagentTask[] | null {
  const details = event.details
  if (!isRecord(details)) return null
  const asyncId = event.source === 'pi-subagents' ? text(details.asyncId) : undefined
  if (asyncId) {
    // A background launch: the run goes on after the tool returns, so the row
    // stays running until the extension's widget or transcript says otherwise.
    return [{ ...argsTask(event, 'running'), transcriptRef: { kind: 'pi-async', asyncId } }]
  }
  const progress: unknown[] = Array.isArray(details.progress) ? details.progress : []
  const results: unknown[] = Array.isArray(details.results) ? details.results : []
  const total = Math.max(progress.length, results.length)
  if (total === 0) return null

  const tasks: SubagentTask[] = []
  for (let index = 0; index < total; index++) {
    const resultValue = results[index]
    const result = isRecord(resultValue) ? resultValue : undefined
    const progressValue = progress[index]
    const entry = isRecord(progressValue) ? progressValue : isRecord(result?.progress) ? result.progress : {}
    const reported = normalizeSubagentStatus(entry.status) ?? normalizeSubagentStatus(result?.status) ?? 'running'
    const status = event.phase === 'end' && reported === 'running' ? endStatus(event.isError) : reported
    const label = text(entry.description) ?? text(entry.task) ?? text(result?.task) ?? subagentTaskText(event.args)
    tasks.push({
      id: text(entry.id) ?? `${event.toolCallId}:${index}`,
      source: event.source,
      agent: text(entry.agent) ?? text(result?.agent) ?? subagentAgentName(event.args),
      label: clip(label),
      status,
      ...progressFields(entry),
      ...(status !== 'running' ? { currentTool: undefined } : {}),
      toolCallId: event.toolCallId,
      transcriptRef: toolRowRef(event.source, text(result?.sessionFile)),
    })
  }
  return tasks
}

/**
 * Fold one spawn-tool event into the rows. Returns `tasks` itself when the
 * event changes nothing, so the store can skip the update.
 */
export function applySubagentToolEvent(tasks: SubagentTask[], event: SubagentToolEvent): SubagentTask[] {
  if (isManagementCall(event)) {
    return tasks.some((task) => task.toolCallId === event.toolCallId) ? replaceToolCallTasks(tasks, event.toolCallId, []) : tasks
  }
  const derived = tasksFromToolDetails(event)
  if (derived) return replaceToolCallTasks(tasks, event.toolCallId, derived)
  if (event.phase === 'update') return tasks

  const own = tasks.filter((task) => task.toolCallId === event.toolCallId)
  // A call that failed without ever reporting a run (rejected arguments)
  // started nothing: its argument row goes instead of staying as a blank row.
  if (event.phase === 'end' && event.isError && own.every((task) => task.id === event.toolCallId)) {
    return own.length > 0 ? replaceToolCallTasks(tasks, event.toolCallId, []) : tasks
  }
  if (event.phase === 'start' || own.length === 0) {
    const status = event.phase === 'end' ? endStatus(event.isError) : 'running'
    return replaceToolCallTasks(tasks, event.toolCallId, [argsTask(event, status)])
  }
  if (!own.some((task) => task.status === 'running')) return tasks
  return tasks.map((task) =>
    task.toolCallId === event.toolCallId && task.status === 'running'
      ? { ...task, status: endStatus(event.isError), currentTool: undefined }
      : task
  )
}

// ─── Constants (spec: "Named constants") ────────────────────────────────────

export const OMP_SUBAGENT_SUBSCRIPTION_LEVEL = 'progress'
export const PI_ASYNC_WIDGET_KEY = 'subagent-async'
export const PI_ASYNC_WIDGET_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:'
export const PI_INSPECT_WIDGET_KEY = 'subagent-inspect'
export const PI_INSPECT_WIDGET_PREFIX = 'PI_SUBAGENT_INSPECT_JSON:'
export const PI_INSPECT_COMMAND_NAME = 'subagents-inspect-rpc'
export const PI_INSPECT_COMMAND = `/${PI_INSPECT_COMMAND_NAME}`
export const PI_INSPECT_LINES = 200
export const PI_INSPECT_TIMEOUT_MS = 5000
export const OMP_TRANSCRIPT_POLL_MS = 1000
export const PI_INSPECT_POLL_MS = 2000
export const MAX_TRANSCRIPT_MESSAGES = 500

const PI_ASYNC_SNAPSHOT_KIND = 'pi-subagents.async-status-snapshot'
const PI_INSPECT_REPLY_KIND = 'pi-subagents.inspect-reply'
/** Snapshots are capped by the extension; this only stops a malformed cycle. */
const MAX_SNAPSHOT_DEPTH = 8
const HOST_STEP_KIND = 'host-step'
const WHITESPACE = /\s/

// ─── OMP ────────────────────────────────────────────────────────────────────

/** A finished row keeps its result: a late running report never revives it. */
function keepFinished(existing: SubagentTask | undefined, status: SubagentTaskStatus): SubagentTaskStatus {
  return existing && existing.status !== 'running' ? existing.status : status
}

function ompTask(
  id: string,
  fields: { agent: string | undefined; label: string | undefined; status: SubagentTaskStatus },
  progress: UnknownRecord | undefined,
  existing: SubagentTask | undefined
): SubagentTask {
  return {
    ...existing,
    id,
    source: 'omp',
    agent: fields.agent ?? existing?.agent ?? DEFAULT_SUBAGENT_AGENT,
    label: fields.label !== undefined ? clip(fields.label) : existing?.label ?? '',
    status: fields.status,
    ...(progress ? progressFields(progress) : {}),
    ...(fields.status !== 'running' ? { currentTool: undefined } : {}),
    transcriptRef: { kind: 'omp', subagentId: id },
  }
}

/** `subagent_lifecycle` payload: `{id, agent, description, status, ...}`. */
export function applyOmpLifecycle(tasks: SubagentTask[], payload: unknown): SubagentTask[] {
  if (!isRecord(payload)) return tasks
  const id = text(payload.id)
  const status = normalizeSubagentStatus(payload.status)
  if (!id || !status) return tasks
  const existing = tasks.find((task) => task.id === id)
  return upsertSubagentTask(tasks, ompTask(id, { agent: text(payload.agent), label: text(payload.description), status }, undefined, existing))
}

/** `subagent_progress` payload: `{agent, task, progress: {id, status, ...}}`. */
export function applyOmpProgress(tasks: SubagentTask[], payload: unknown): SubagentTask[] {
  if (!isRecord(payload) || !isRecord(payload.progress)) return tasks
  const progress = payload.progress
  const id = text(progress.id)
  if (!id) return tasks
  const existing = tasks.find((task) => task.id === id)
  const status = keepFinished(existing, normalizeSubagentStatus(progress.status) ?? 'running')
  // The task text is the long assignment: a fallback for a row with no label
  // yet, never a replacement for the lifecycle's short description.
  const label = text(progress.description) ?? (existing ? undefined : text(payload.task))
  return upsertSubagentTask(
    tasks,
    ompTask(id, { agent: text(payload.agent), label, status }, status === 'running' ? progress : undefined, existing)
  )
}

/** `get_subagents` response data: `{subagents: [...]}`, active subagents only. */
export function tasksFromOmpSubagents(data: unknown): SubagentTask[] {
  if (!isRecord(data) || !Array.isArray(data.subagents)) return []
  const tasks: SubagentTask[] = []
  for (const entry of data.subagents as unknown[]) {
    if (!isRecord(entry)) continue
    const id = text(entry.id)
    if (!id) continue
    const status = normalizeSubagentStatus(entry.status) ?? 'running'
    const label = text(entry.description) ?? text(entry.task)
    const progress = isRecord(entry.progress) ? entry.progress : undefined
    tasks.push(ompTask(id, { agent: text(entry.agent), label, status }, progress, undefined))
  }
  return tasks
}

/**
 * Merge a `get_subagents` listing. OMP answering it means its events drive the
 * rows, so the tool-event fallback rows (OMP rows with no live view) go.
 */
export function applyOmpSubagentList(tasks: SubagentTask[], listed: SubagentTask[]): SubagentTask[] {
  let next = tasks.filter((task) => !(task.source === 'omp' && task.transcriptRef.kind === 'none'))
  for (const task of listed) {
    const existing = next.find((row) => row.id === task.id)
    next = upsertSubagentTask(next, existing && existing.status !== 'running' ? existing : task)
  }
  return next
}

// ─── pi-subagents ───────────────────────────────────────────────────────────

/** The JSON after `prefix` on the first line that carries it, or undefined. */
function prefixedJson(lines: unknown, prefix: string): unknown {
  if (!Array.isArray(lines)) return undefined
  for (const line of lines as unknown[]) {
    if (typeof line !== 'string' || !line.startsWith(prefix)) continue
    try {
      return JSON.parse(line.slice(prefix.length))
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Child nodes with no children of their own; host steps are gates, not agents. */
function snapshotLeaves(node: UnknownRecord, depth: number, out: UnknownRecord[]): void {
  if (depth > MAX_SNAPSHOT_DEPTH || !Array.isArray(node.children)) return
  for (const child of node.children as unknown[]) {
    if (!isRecord(child) || child.kind === HOST_STEP_KIND) continue
    const before = out.length
    snapshotLeaves(child, depth + 1, out)
    if (out.length === before) out.push(child)
  }
}

function snapshotDuration(node: UnknownRecord): number | undefined {
  const startedAt = count(node.startedAt)
  if (startedAt === undefined) return undefined
  const end = count(node.endedAt) ?? count(node.updatedAt)
  return end !== undefined && end >= startedAt ? end - startedAt : undefined
}

function piAsyncTask(asyncId: string, node: UnknownRecord, childId: string | undefined, runLabel: string | undefined): SubagentTask {
  const activity = isRecord(node.activity) ? node.activity : {}
  const status = normalizeSubagentStatus(node.state) ?? 'running'
  const currentTool = status === 'running' ? text(activity.currentTool) : undefined
  const toolCount = count(activity.toolCount)
  const durationMs = snapshotDuration(node)
  return {
    id: childId ? `${asyncId}:${childId}` : asyncId,
    source: 'pi-subagents',
    agent: clip(text(node.label) ?? DEFAULT_SUBAGENT_AGENT),
    label: childId && runLabel ? clip(runLabel) : '',
    status,
    ...(currentTool ? { currentTool } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    transcriptRef: childId ? { kind: 'pi-async', asyncId, childId } : { kind: 'pi-async', asyncId },
  }
}

/**
 * Rows from the `subagent-async` widget line, or null when the lines carry no
 * snapshot. Each snapshot is the extension's full current state.
 */
export function tasksFromPiAsyncWidget(lines: unknown): SubagentTask[] | null {
  const snapshot = prefixedJson(lines, PI_ASYNC_WIDGET_PREFIX)
  if (!isRecord(snapshot) || snapshot.kind !== PI_ASYNC_SNAPSHOT_KIND || !Array.isArray(snapshot.runs)) return null
  const tasks: SubagentTask[] = []
  for (const run of snapshot.runs as unknown[]) {
    if (!isRecord(run)) continue
    const asyncId = text(run.id)
    if (!asyncId) continue
    const leaves: UnknownRecord[] = []
    snapshotLeaves(run, 0, leaves)
    if (leaves.length === 0) {
      tasks.push(piAsyncTask(asyncId, run, undefined, undefined))
      continue
    }
    for (const leaf of leaves) tasks.push(piAsyncTask(asyncId, leaf, text(leaf.id), text(run.label)))
  }
  return tasks
}

/**
 * Apply a snapshot: its runs replace every older row of the same run (the
 * launch row included). Runs the snapshot no longer lists keep their last
 * state, so finished runs stay in the Finished group.
 */
export function replacePiAsyncRuns(tasks: SubagentTask[], snapshot: SubagentTask[]): SubagentTask[] {
  const runIds = new Set<string>()
  for (const task of snapshot) {
    if (task.transcriptRef.kind === 'pi-async') runIds.add(task.transcriptRef.asyncId)
  }
  const snapshotIds = new Set(snapshot.map((task) => task.id))
  let next = tasks.filter((task) =>
    !(task.transcriptRef.kind === 'pi-async' && runIds.has(task.transcriptRef.asyncId) && !snapshotIds.has(task.id))
  )
  for (const task of snapshot) next = upsertSubagentTask(next, task)
  return next
}

export interface SubagentInspectLine {
  role: string
  kind: 'text' | 'toolCall' | 'toolResult'
  text: string
  name?: string
  isError?: boolean
}

export interface SubagentInspectReply {
  requestId: string
  lines: SubagentInspectLine[]
  status?: SubagentTaskStatus
  finalOutput?: string
  errorCode?: string
}

function isInspectLineKind(value: unknown): value is SubagentInspectLine['kind'] {
  return value === 'text' || value === 'toolCall' || value === 'toolResult'
}

/** The `subagent-inspect` widget reply, or null when the lines carry none. */
export function parseInspectReply(lines: unknown): SubagentInspectReply | null {
  const reply = prefixedJson(lines, PI_INSPECT_WIDGET_PREFIX)
  if (!isRecord(reply) || reply.kind !== PI_INSPECT_REPLY_KIND) return null
  const requestId = text(reply.requestId)
  if (!requestId) return null
  const parsed: SubagentInspectLine[] = []
  const messages: unknown[] = Array.isArray(reply.messages) ? reply.messages : []
  for (const message of messages) {
    if (!isRecord(message) || typeof message.text !== 'string' || !isInspectLineKind(message.kind)) continue
    const name = text(message.name)
    parsed.push({
      role: text(message.role) ?? 'assistant',
      kind: message.kind,
      text: message.text,
      ...(name ? { name } : {}),
      ...(message.isError === true ? { isError: true } : {}),
    })
  }
  const status = normalizeSubagentStatus(reply.status)
  const finalOutput = text(reply.finalOutput)
  const errorCode = isRecord(reply.error) ? text(reply.error.code) : undefined
  return {
    requestId,
    ...(status ? { status } : {}),
    ...(finalOutput ? { finalOutput } : {}),
    ...(errorCode ? { errorCode } : {}),
    lines: parsed,
  }
}

/**
 * The inspect command line. The extension splits its arguments on
 * whitespace, so an id that contains whitespace cannot be sent safely: null.
 */
export function buildInspectCommand(requestId: string, ref: { asyncId: string; childId?: string }): string | null {
  const parts = [requestId, ref.asyncId, ...(ref.childId !== undefined ? [ref.childId] : [])]
  if (parts.some((part) => !part || WHITESPACE.test(part))) return null
  return [PI_INSPECT_COMMAND, ...parts, '--lines', String(PI_INSPECT_LINES)].join(' ')
}

// ─── Transcript IPC shapes ──────────────────────────────────────────────────

export type SubagentTranscriptErrorCode = 'unavailable' | 'not-found' | 'timeout' | 'failed'

export type SubagentTranscriptResult =
  | { kind: 'messages'; messages: unknown[]; nextCursor: number; reset: boolean }
  | { kind: 'lines'; lines: SubagentInspectLine[]; finalOutput?: string; status?: SubagentTaskStatus }
  | { kind: 'error'; code: SubagentTranscriptErrorCode }

export interface SubagentListResult {
  supported: boolean
  tasks: SubagentTask[]
}

/** Validate a transcript ref that crossed IPC from the renderer. */
export function parseTranscriptRef(value: unknown): SubagentTranscriptRef | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case 'omp': {
      const subagentId = text(value.subagentId)
      return subagentId ? { kind: 'omp', subagentId } : null
    }
    case 'pi-async': {
      const asyncId = text(value.asyncId)
      if (!asyncId) return null
      if (value.childId === undefined) return { kind: 'pi-async', asyncId }
      const childId = text(value.childId)
      return childId ? { kind: 'pi-async', asyncId, childId } : null
    }
    case 'pi-foreground': {
      if (value.sessionFile === undefined) return { kind: 'pi-foreground' }
      const sessionFile = text(value.sessionFile)
      return sessionFile ? { kind: 'pi-foreground', sessionFile } : null
    }
    case 'none':
      return { kind: 'none' }
    default:
      return null
  }
}

/** `previous` followed by `page`, keeping only the newest `cap` items. */
export function appendCapped<T>(previous: readonly T[], page: readonly T[], cap: number = MAX_TRANSCRIPT_MESSAGES): T[] {
  const combined = [...previous, ...page]
  return combined.length > cap ? combined.slice(combined.length - cap) : combined
}
