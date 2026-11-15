import { randomUUID } from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir, realpath, rename, rm, stat } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { isPathWithin } from '../../resources/path-within'
import type {
  ChatImportFailureCode,
  ChatImportProgress,
  ChatImportRequest,
  ChatImportResult,
  ChatImportSource,
} from '../shared/chat-import'
import type { AgentEngineKind } from '../shared/ipc-contracts'
import { appLog } from './app-log'
import { ClaudeCodeScanner, claudeCodeRecordEvents } from './chat-import-claude-code'
import { codexRecordEvents } from './chat-import-codex'
import { chatImportKey, type ChatImportIndex } from './chat-import-index'
import { isImportableSourcePath, readCodexSessionMeta, readCodexTitles, sourceSessionIdFor } from './chat-import-sources'
import { ImportTurnAssembler, type ImportEvent } from './chat-import-turns'
import { createSessionRecordWriter, sessionFileName, type SessionRecordWriter } from './chat-import-writer'
import { engineProjectSessionDirs } from './latest-project-session'
import { getOmpSessionsRoot, getSessionsRoot } from './pi-paths'
import { streamJsonlRecords } from './session-jsonl'

/**
 * Imports chat files one at a time. Each source file is streamed twice at
 * most (Claude Code needs its active branch first), never held in memory,
 * and only read. The session is written to a temp file next to its target
 * and renamed into the engine's store once it is complete.
 */

export interface ChatImportRunOptions {
  request: ChatImportRequest
  sourceRoot: string
  codexIndexPath: string
  index: ChatImportIndex
  onProgress: (progress: ChatImportProgress) => void
}

const TEMP_SUFFIX = '.tmp'
const EXCLUSIVE_WRITE_FLAG = 'wx'
const LOG_SCOPE = 'chat-import'

interface SourceMeta {
  title: string | null
  cwd: string | null
  startedAt: string | null
  /** Claude Code: the active-branch lines; Codex: every line is kept. */
  keptLines: ReadonlySet<number> | null
}

type FileOutcome =
  | { kind: 'imported'; title: string | null; sessionPath: string }
  | { kind: 'skipped'; title: string | null }
  | { kind: 'failed'; title: string | null; code: ChatImportFailureCode }

/** A failure to read the source, so it reports as unreadable rather than as a write failure. */
class SourceReadError extends Error {}

/** The folder with symlinks resolved, as the engines resolve a project path; null when it is not a folder. */
async function realFolder(path: string | null): Promise<string | null> {
  if (path === null) return null
  try {
    const real = await realpath(path)
    return (await stat(real)).isDirectory() ? real : null
  } catch {
    return null
  }
}

function isoTime(value: string | null): string {
  const time = value === null ? Number.NaN : Date.parse(value)
  return new Date(Number.isFinite(time) ? time : Date.now()).toISOString()
}

function engineSessionsRoot(engine: AgentEngineKind): string {
  return engine === 'pi' ? getSessionsRoot() : getOmpSessionsRoot()
}

async function readClaudeCodeMeta(sourcePath: string): Promise<SourceMeta> {
  const scanner = new ClaudeCodeScanner()
  for await (const { record, line } of streamJsonlRecords(sourcePath)) scanner.add(record, line)
  return scanner.result()
}

/** Session lines for the source: the preamble, then each turn as soon as it is complete. */
async function* sessionLines(
  source: ChatImportSource,
  sourcePath: string,
  keptLines: ReadonlySet<number> | null,
  writer: SessionRecordWriter,
): AsyncGenerator<string> {
  for (const line of writer.preamble()) yield `${line}\n`
  const convert: (record: Record<string, unknown>) => ImportEvent[] = source === 'claude-code' ? claudeCodeRecordEvents : codexRecordEvents
  const assembler = new ImportTurnAssembler()
  const records = streamJsonlRecords(sourcePath)
  try {
    for (;;) {
      let next: IteratorResult<{ record: Record<string, unknown>; line: number }>
      try {
        next = await records.next()
      } catch (error) {
        throw new SourceReadError(error instanceof Error ? error.message : String(error))
      }
      if (next.done) break
      if (keptLines && !keptLines.has(next.value.line)) continue
      for (const event of convert(next.value.record)) {
        for (const turn of assembler.push(event)) for (const line of writer.appendTurn(turn)) yield `${line}\n`
      }
    }
  } finally {
    // Closes the source when the write side stops early.
    await records.return(undefined)
  }
  for (const turn of assembler.finish()) for (const line of writer.appendTurn(turn)) yield `${line}\n`
}

export async function runChatImport(options: ChatImportRunOptions): Promise<ChatImportResult> {
  const { request, sourceRoot, codexIndexPath, index, onProgress } = options
  const { source, engine, sourcePaths } = request
  const total = sourcePaths.length
  const result: ChatImportResult = { imported: [], skipped: [], failed: [] }
  let codexTitles: Map<string, string> | null = null

  async function readMeta(sourcePath: string): Promise<SourceMeta | null> {
    if (source === 'claude-code') return readClaudeCodeMeta(sourcePath)
    const meta = await readCodexSessionMeta(sourcePath)
    if (!meta) return null
    codexTitles ??= await readCodexTitles(codexIndexPath)
    return { title: codexTitles.get(meta.id) ?? null, cwd: meta.cwd, startedAt: meta.startedAt, keptLines: null }
  }

  async function importFile(sourcePath: string, done: number): Promise<FileOutcome> {
    if (!isImportableSourcePath(source, sourceRoot, sourcePath)) return { kind: 'failed', title: null, code: 'invalid-path' }
    const sourceSessionId = await sourceSessionIdFor(source, sourcePath)
    if (sourceSessionId === null) return { kind: 'failed', title: null, code: 'unreadable' }
    const key = chatImportKey(engine, source, sourceSessionId)
    if ((await index.importedPath(key)) !== null) return { kind: 'skipped', title: null }

    const meta = await readMeta(sourcePath).catch(() => null)
    if (!meta) return { kind: 'failed', title: null, code: 'unreadable' }
    const { title } = meta
    onProgress({ done, total, currentTitle: title })
    const cwd = await realFolder(meta.cwd)
    if (cwd === null) return { kind: 'failed', title, code: 'folder-missing' }

    const sessionId = randomUUID()
    const startedAt = isoTime(meta.startedAt)
    const [targetDir] = await engineProjectSessionDirs(engine, cwd)
    const targetPath = join(targetDir, sessionFileName(startedAt, sessionId))
    if (!isPathWithin(engineSessionsRoot(engine), targetPath)) return { kind: 'failed', title, code: 'invalid-path' }

    const tempPath = `${targetPath}${TEMP_SUFFIX}`
    const writer = createSessionRecordWriter(engine, { sessionId, cwd, startedAt, title, writtenAt: new Date().toISOString() })
    try {
      await mkdir(targetDir, { recursive: true })
      await pipeline(
        Readable.from(sessionLines(source, sourcePath, meta.keptLines, writer)),
        createWriteStream(tempPath, { flags: EXCLUSIVE_WRITE_FLAG }),
      )
      if (writer.messageCount === 0) {
        await rm(tempPath, { force: true })
        return { kind: 'failed', title, code: 'no-messages' }
      }
      // Recorded first: an entry whose file never appears reads as not imported.
      await index.record(key, targetPath)
      await rename(tempPath, targetPath)
      return { kind: 'imported', title, sessionPath: targetPath }
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {})
      if (error instanceof SourceReadError) return { kind: 'failed', title, code: 'unreadable' }
      appLog.warn(LOG_SCOPE, `Could not write an imported session: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'failed', title, code: 'write-failed' }
    }
  }

  for (const [done, sourcePath] of sourcePaths.entries()) {
    onProgress({ done, total, currentTitle: null })
    const outcome = await importFile(sourcePath, done)
    if (outcome.kind === 'imported') result.imported.push({ sourcePath, title: outcome.title, sessionPath: outcome.sessionPath })
    else if (outcome.kind === 'skipped') result.skipped.push({ sourcePath, title: outcome.title })
    else result.failed.push({ sourcePath, title: outcome.title, code: outcome.code })
  }
  onProgress({ done: total, total, currentTitle: null })
  return result
}
