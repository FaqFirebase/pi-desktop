import { open, readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join, relative, resolve, sep } from 'path'
import { isPathWithin } from '../../resources/path-within'
import type { ChatImportListItem, ChatImportSource } from '../shared/chat-import'
import { ClaudeCodeScanner } from './chat-import-claude-code'
import { codexSessionMeta, codexTitlesFromIndex, type CodexSessionMeta } from './chat-import-codex'
import { mapWithConcurrency } from './map-concurrent'
import { TAIL_SCAN_BYTES } from './session-metadata'
import { parseSessionLines, streamJsonlRecords } from './session-jsonl'
import { JSONL_EXTENSION, sessionIdFromPath } from './session-paths'

/**
 * Where Claude Code and Codex keep their chats, and the chat list the import
 * page shows. Every read here opens the source read-only.
 */

export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'
export const CODEX_HOME_ENV = 'CODEX_HOME'
/** Bytes read from the start of a chat file for the list (cwd, Codex meta). */
export const LISTING_HEAD_BYTES = 64 * 1024

const CLAUDE_CONFIG_DIR_NAME = '.claude'
const CLAUDE_PROJECTS_DIR_NAME = 'projects'
const CODEX_HOME_DIR_NAME = '.codex'
const CODEX_SESSIONS_DIR_NAME = 'sessions'
const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'
const CODEX_ROLLOUT_PREFIX = 'rollout-'
/** `<project folder>/<chat>.jsonl` below the Claude Code root. */
const CLAUDE_CODE_PATH_DEPTH = 2
/** `YYYY/MM/DD/rollout-*.jsonl` below the Codex root. */
const CODEX_PATH_DEPTH = 4
const LISTING_CONCURRENCY = 8

export function chatImportSourceRoot(source: ChatImportSource, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (source === 'claude-code') return join(env[CLAUDE_CONFIG_DIR_ENV] || join(home, CLAUDE_CONFIG_DIR_NAME), CLAUDE_PROJECTS_DIR_NAME)
  return join(codexHome(env, home), CODEX_SESSIONS_DIR_NAME)
}

function codexHome(env: NodeJS.ProcessEnv, home: string): string {
  return env[CODEX_HOME_ENV] || join(home, CODEX_HOME_DIR_NAME)
}

export function codexSessionIndexPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(codexHome(env, home), CODEX_SESSION_INDEX_FILE)
}

function isSourceFileName(source: ChatImportSource, name: string): boolean {
  return name.endsWith(JSONL_EXTENSION) && (source === 'claude-code' || name.startsWith(CODEX_ROLLOUT_PREFIX))
}

/** True when `candidate` is a chat file in the source's own layout under `root`. */
export function isImportableSourcePath(source: ChatImportSource, root: string, candidate: string): boolean {
  const resolved = resolve(candidate)
  if (!isPathWithin(root, resolved) || !isSourceFileName(source, basename(resolved))) return false
  const depth = relative(resolve(root), resolved).split(sep).length
  return depth === (source === 'claude-code' ? CLAUDE_CODE_PATH_DEPTH : CODEX_PATH_DEPTH)
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

async function chatFilesIn(source: ChatImportSource, dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && isSourceFileName(source, entry.name)).map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

/**
 * Chat files in the source layout. Claude Code keeps subagent runs in
 * `<chat>/subagents/`; only files directly in a project folder are chats.
 */
export async function listSourceFiles(source: ChatImportSource, root: string): Promise<string[]> {
  let dirs = [root]
  for (let level = 1; level < (source === 'claude-code' ? CLAUDE_CODE_PATH_DEPTH : CODEX_PATH_DEPTH); level++) {
    dirs = (await Promise.all(dirs.map(subdirectories))).flat()
  }
  return (await Promise.all(dirs.map((dir) => chatFilesIn(source, dir)))).flat()
}

export async function readCodexTitles(indexPath: string): Promise<Map<string, string>> {
  try {
    return codexTitlesFromIndex((await readFile(indexPath, { encoding: 'utf8', flag: 'r' })).split('\n'))
  } catch {
    return new Map()
  }
}

/** The meta in a Codex file's first record; null when it has none. Rejects when the file cannot be read. */
export async function readCodexSessionMeta(filePath: string): Promise<CodexSessionMeta | null> {
  for await (const { record } of streamJsonlRecords(filePath)) return codexSessionMeta(record)
  return null
}

/** Claude Code: the file name; Codex: the id in the first record's meta. Null when unknown. */
export async function sourceSessionIdFor(source: ChatImportSource, filePath: string): Promise<string | null> {
  if (source === 'claude-code') return sessionIdFromPath(filePath)
  return (await readCodexSessionMeta(filePath).catch(() => null))?.id ?? null
}

/** Whole records from the head and the tail of a file, without the cut edge lines. */
async function headAndTailRecords(filePath: string, size: number): Promise<{ head: Record<string, unknown>[]; tail: Record<string, unknown>[] }> {
  const handle = await open(filePath, 'r')
  try {
    const read = async (position: number, length: number): Promise<string> => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      return buffer.subarray(0, bytesRead).toString('utf8')
    }
    if (size <= LISTING_HEAD_BYTES + TAIL_SCAN_BYTES) return { head: parseSessionLines(await read(0, size)), tail: [] }
    const head = await read(0, LISTING_HEAD_BYTES)
    const tail = await read(size - TAIL_SCAN_BYTES, TAIL_SCAN_BYTES)
    return {
      head: parseSessionLines(head.slice(0, head.lastIndexOf('\n') + 1)),
      tail: parseSessionLines(tail.slice(tail.indexOf('\n') + 1)),
    }
  } finally {
    await handle.close()
  }
}

async function isDirectory(path: string | null): Promise<boolean> {
  if (!path) return false
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

interface ListedChat {
  sourceSessionId: string
  title: string | null
  cwd: string | null
}

function claudeCodeListing(filePath: string, records: Record<string, unknown>[]): ListedChat {
  const scanner = new ClaudeCodeScanner()
  records.forEach((record, line) => scanner.add(record, line))
  const { title, cwd } = scanner.result()
  return { sourceSessionId: sessionIdFromPath(filePath), title, cwd }
}

function codexListing(head: Record<string, unknown>[], titles: ReadonlyMap<string, string>): ListedChat | null {
  const meta = head.length > 0 ? codexSessionMeta(head[0]) : null
  return meta ? { sourceSessionId: meta.id, title: titles.get(meta.id) ?? null, cwd: meta.cwd } : null
}

export async function listImportableChats(
  source: ChatImportSource,
  root: string,
  isImported: (sourceSessionId: string) => Promise<boolean>,
  codexIndexPath: string,
): Promise<ChatImportListItem[]> {
  const files = await listSourceFiles(source, root)
  const titles = source === 'codex' ? await readCodexTitles(codexIndexPath) : new Map<string, string>()
  const items = await mapWithConcurrency(files, LISTING_CONCURRENCY, async (sourcePath): Promise<ChatImportListItem | null> => {
    try {
      const file = await stat(sourcePath)
      const { head, tail } = await headAndTailRecords(sourcePath, file.size)
      const chat = source === 'claude-code' ? claudeCodeListing(sourcePath, [...head, ...tail]) : codexListing(head, titles)
      if (!chat) return null
      return {
        sourcePath,
        ...chat,
        cwdExists: await isDirectory(chat.cwd),
        modifiedAt: file.mtimeMs,
        sizeBytes: file.size,
        alreadyImported: await isImported(chat.sourceSessionId),
      }
    } catch {
      // Removed or unreadable since the directory read: left out.
      return null
    }
  })
  return items.filter((item) => item !== null).sort((a, b) => b.modifiedAt - a.modifiedAt)
}
