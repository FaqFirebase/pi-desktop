import { createReadStream } from 'fs'
import { open, type FileHandle } from 'fs/promises'
import { createInterface } from 'readline'
import { sessionPreview, stripInjectedPreamble } from '../shared/session-preview'
import { sessionInfoNameFromLine } from './session-name'

/**
 * Bounded reader for everything the GUI shows about a session it has not opened:
 * the display name, the header's fork link, and a preview of the first user
 * message.
 *
 * Sessions reach multiple MB, and both Recent Sessions and the Timeline read
 * *every* session in the store, so neither may load a whole file. The three
 * fields come from one open and the same range reads, because reading the name
 * and the preview separately doubles the syscalls per file — measurably slower on
 * a cold walk than the single full `readFile` this replaced, even though it moves
 * far fewer bytes.
 *
 * Layout of the reads:
 *  - Head (32 KB): the header is line 1 and the first user turn is line 4-6, so
 *    both land here in practice. An early auto-title also lands here.
 *  - Tail (256 KB): renames append, so the latest name is usually here. Preferred
 *    over the head for the name only.
 *  - Streaming fallback: a user turn with an inlined base64 image can make a
 *    single line hundreds of KB, past the head. Capped, so a file that buries its
 *    first turn behind megabytes of tool output yields no preview rather than a
 *    long read on the main thread.
 *  - Full scan: only when neither head nor tail saw any session_info, which means
 *    a rename sits mid-file behind large tool output.
 */

/** Bytes read from the start (header, first user turn, early auto-title). */
export const HEAD_SCAN_BYTES = 32 * 1024
/** Bytes read from the end (latest renames append). */
export const TAIL_SCAN_BYTES = 256 * 1024
/** Hard ceiling on the streaming preview fallback. */
export const MAX_PREVIEW_SCAN_BYTES = 1024 * 1024
/**
 * Entries kept in the mtime-keyed cache. Sized for a whole-store lineage walk
 * rather than the 100-row session list, so a large store does not thrash.
 */
const METADATA_CACHE_MAX = 2000

export interface SessionHeader {
  id: string
  /** Absolute path to the session this one was forked from, or null. */
  parentSession: string | null
  /**
   * Working directory the session actually ran in, or null when the header
   * omits it (legacy sessions). Authoritative where it exists: session dir
   * names are lossy decodes of paths, so this is the only reliable anchor
   * back to the real project.
   */
  cwd: string | null
}
export type SessionContentState = 'empty' | 'non-empty' | 'unknown'

export interface SessionMetadata {
  header: SessionHeader | null
  /** Latest `session_info` name, or null if the session was never named. */
  name: string | null
  /** First user message, normalized for display, or null if there is none. */
  preview: string | null
  /** Conservative content classification used before destructive cleanup. */
  contentState: SessionContentState
}

/** Parse the `type:"session"` record that opens every session file. */
export function sessionHeaderFromLine(line: string): SessionHeader | null {
  const trimmed = line.trim()
  // Cheap prefilter; the type check below is what actually decides.
  if (!trimmed || !trimmed.includes('"session"')) return null

  let record: unknown
  try {
    record = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof record !== 'object' || record === null) return null

  const rec = record as { type?: unknown; id?: unknown; parentSession?: unknown; cwd?: unknown }
  if (rec.type !== 'session' || typeof rec.id !== 'string') return null

  return {
    id: rec.id,
    parentSession: typeof rec.parentSession === 'string' ? rec.parentSession : null,
    cwd: typeof rec.cwd === 'string' && rec.cwd.length > 0 ? rec.cwd : null,
  }
}

/**
 * Text of a user turn, or null for any other record.
 *
 * `role` is the only thing separating a user turn from a tool result: both are
 * `type:"message"` carrying a text-block content array, and tool results
 * outnumber user turns roughly ten to one in a real session.
 */
export function isUserMessageRecord(
  record: unknown,
): record is { type: 'message'; message: { role: 'user'; content?: unknown } } {
  if (typeof record !== 'object' || record === null || !('message' in record)) return false
  const message = record.message
  if (typeof message !== 'object' || message === null || !('role' in message)) return false
  if (!('type' in record) || record.type !== 'message') return false
  return message.role === 'user'
}

export function userMessageText(record: unknown): string | null {
  if (!isUserMessageRecord(record)) return null
  return contentText(record.message.content) || null
}

/** The session format allows `content` as a bare string or as a block array. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: unknown; text?: unknown }
    // Skips image blocks, whose base64 payload would swamp the preview.
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join(' ').trim()
}

interface RangeScan {
  header: SessionHeader | null
  text: string | null
  hasUserMessage: boolean
  parseFailure: boolean
  /** `undefined` when the range held no session_info record at all. */
  name: string | null | undefined
}

interface ScanOptions {
  /** Drop the leading fragment of a mid-file range read. */
  skipPartialFirstLine?: boolean
  /**
   * Whether this range can contain a `session_info`. When false the scan stops as
   * soon as it has the header and the first user turn, instead of walking every
   * remaining line of the range.
   */
  wantName?: boolean
}

/**
 * Pull the header, first user turn and latest name out of a set of JSONL lines.
 */
function scanLines(lines: readonly string[], options: ScanOptions = {}): RangeScan {
  const { skipPartialFirstLine = false, wantName = true } = options
  let header: SessionHeader | null = null
  let text: string | null = null
  let hasUserMessage = false
  let parseFailure = false
  let name: string | null | undefined = undefined

  for (const [index, line] of lines.entries()) {
    if (index === 0 && skipPartialFirstLine) continue
    // Bare emptiness only — every parser below trims for itself, and trimming
    // each line here doubles the string allocations across a whole-store walk.
    if (!line) continue

    if (wantName) {
      const nameOnLine = sessionInfoNameFromLine(line)
      if (nameOnLine !== undefined) {
        name = nameOnLine
        continue
      }
    }

    if (header === null) {
      const parsed = sessionHeaderFromLine(line)
      if (parsed) {
        header = parsed
        continue
      }
    }

    // A user message with image-only content is still a real conversation.
    // Keep that fact separate from the text preview, which intentionally omits
    // image payloads.
    if (!hasUserMessage) {
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        parseFailure = true
        continue
      }
      if (isUserMessageRecord(record)) {
        hasUserMessage = true
        text = userMessageText(record)
      }
    }

    if (!wantName && header !== null && hasUserMessage) break
  }

  return { header, text, hasUserMessage, parseFailure, name }
}

/**
 * Decode a byte range of an open session file into complete JSONL lines.
 *
 * `reachesEof` says whether the range ends at the end of the file. When it does
 * not, the final line is a fragment and is dropped so `JSON.parse` only ever sees
 * whole records — but when it does, that line is the file's last record and must
 * be kept, because a session with no trailing newline would otherwise lose its
 * most recent rename.
 */
async function readRange(
  handle: FileHandle,
  start: number,
  length: number,
  reachesEof: boolean
): Promise<{ lines: string[]; truncated: boolean; hasSessionInfo: boolean }> {
  if (length <= 0) return { lines: [], truncated: false, hasSessionInfo: false }

  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, start)
  const bytes = buffer.subarray(0, bytesRead)
  const lines = bytes.toString('utf-8').split('\n')
  const truncated = !reachesEof && bytesRead === length

  return {
    lines: truncated ? lines.slice(0, -1) : lines,
    truncated,
    // Lets the caller skip name scanning entirely for the common unnamed session.
    hasSessionInfo: bytes.includes(SESSION_INFO_MARKER),
  }
}

/**
 * Line-by-line fallback for a user turn whose record is too large to fit the head
 * buffer. Stops at `MAX_PREVIEW_SCAN_BYTES`.
 */
async function streamFirstUserMessage(filePath: string): Promise<string | null> {
  let stream
  try {
    stream = createReadStream(filePath, { encoding: 'utf-8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    let scanned = 0

    for await (const line of rl) {
      scanned += Buffer.byteLength(line, 'utf-8') + 1

      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        record = null
      }
      // Checked before the budget so a match already in hand is never discarded.
      const text = record === null ? null : userMessageText(record)
      if (text) {
        rl.close()
        return text
      }
      if (scanned >= MAX_PREVIEW_SCAN_BYTES) {
        rl.close()
        return null
      }
    }
    return null
  } catch {
    return null
  } finally {
    stream?.destroy()
  }
}

/**
 * Classify whether a session is provably header-only.
 *
 * This deliberately returns `unknown` for unreadable, malformed, or
 * over-budget files. Callers may hide an unknown row, but must never delete it.
 */
export async function inspectSessionContent(filePath: string): Promise<SessionContentState> {
  let stream
  let sawHeader = false
  let scanned = 0
  try {
    stream = createReadStream(filePath, { encoding: 'utf-8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      scanned += Buffer.byteLength(line, 'utf-8') + 1
      if (!line) continue
      const header = sessionHeaderFromLine(line)
      if (header) {
        sawHeader = true
        continue
      }
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        rl.close()
        return 'unknown'
      }
      if (isUserMessageRecord(record)) {
        rl.close()
        return 'non-empty'
      }
      if (scanned >= MAX_PREVIEW_SCAN_BYTES) {
        rl.close()
        return 'unknown'
      }
    }
    return sawHeader ? 'empty' : 'unknown'
  } catch {
    return 'unknown'
  } finally {
    stream?.destroy()
  }
}

/** Full line-by-line stream for a name that head and tail both missed. */
async function streamLatestName(filePath: string): Promise<string | null> {
  let stream
  try {
    stream = createReadStream(filePath, { encoding: 'utf-8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    let name: string | null = null
    for await (const line of rl) {
      const result = sessionInfoNameFromLine(line)
      if (result !== undefined) name = result
    }
    return name
  } catch {
    return null
  } finally {
    stream?.destroy()
  }
}

/**
 * First user message as stored — untruncated, unlike `SessionMetadata.preview`.
 *
 * Separate from `readSessionMetadata` because auto-tagging needs the full text to
 * pick a keyword, and caching a multi-KB message per session just to serve a
 * 120-character row label would be the wrong trade. Callers are per-session and
 * on demand, not whole-store walks. Never throws.
 */
export async function readFirstUserMessage(filePath: string): Promise<string | null> {
  const head = await readHead(filePath)
  if (!head) return null
  return head.scan.text ?? (head.truncated ? await streamFirstUserMessage(filePath) : null)
}

/** Head range only, decoded and scanned. Null when the file is empty/unreadable. */
async function readHead(
  filePath: string
): Promise<{ scan: RangeScan; truncated: boolean } | null> {
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    if (size <= 0) return null

    const head = await readRange(
      handle,
      0,
      Math.min(size, HEAD_SCAN_BYTES),
      size <= HEAD_SCAN_BYTES
    )
    // Names are irrelevant here — only the message text is wanted.
    return { scan: scanLines(head.lines, { wantName: false }), truncated: head.truncated }
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/** Byte pattern every `session_info` record carries. */
const SESSION_INFO_MARKER = Buffer.from('"session_info"')

/**
 * Latest name in the tail range, or undefined when the range holds no
 * session_info record at all.
 *
 * Prefilters on raw bytes because most sessions are never renamed — decoding
 * 256 KB to a string and parsing every line in it, per session, across the whole
 * store, costs more than the read itself. `Buffer.includes` cannot produce a
 * false negative here, and a false positive just falls through to the real parse.
 */
async function readTailName(
  handle: FileHandle,
  size: number
): Promise<string | null | undefined> {
  const length = Math.min(TAIL_SCAN_BYTES, size)
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, size - length)
  const bytes = buffer.subarray(0, bytesRead)
  if (!bytes.includes(SESSION_INFO_MARKER)) return undefined

  // The tail ends at EOF, so its final line is a whole record and is kept; the
  // first is a fragment of whatever record the range started inside.
  return scanLines(bytes.toString('utf-8').split('\n'), { skipPartialFirstLine: true }).name
}

interface RangeReads {
  scan: RangeScan
  headTruncated: boolean
  /** Name found in the tail range, or undefined when the tail held none. */
  tailName: string | null | undefined
  /** The ranges covered the entire file, so no fallback scan can find more. */
  sawWholeFile: boolean
}

/** Head and tail ranges, decoded and scanned. Null when empty/unreadable. */
async function readRanges(filePath: string): Promise<RangeReads | null> {
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    if (size <= 0) return null

    if (size <= HEAD_SCAN_BYTES + TAIL_SCAN_BYTES) {
      // Small enough that one pass is both the head and the tail.
      const whole = await readRange(handle, 0, size, true)
      return {
        scan: scanLines(whole.lines, { wantName: whole.hasSessionInfo }),
        headTruncated: false,
        tailName: undefined,
        sawWholeFile: true,
      }
    }

    const head = await readRange(handle, 0, HEAD_SCAN_BYTES, false)
    return {
      scan: scanLines(head.lines, { wantName: head.hasSessionInfo }),
      headTruncated: head.truncated,
      tailName: await readTailName(handle, size),
      sawWholeFile: false,
    }
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/** Header, name and display preview from one open. Never throws. */
export async function readSessionMetadata(filePath: string): Promise<SessionMetadata> {
  const reads = await readRanges(filePath)
  if (!reads) return { header: null, name: null, preview: null, contentState: 'unknown' }

  const { scan, headTruncated, tailName, sawWholeFile } = reads

  // A rename appends, so the tail outranks the head — but only when the tail
  // actually held a session_info record.
  let name = tailName ?? scan.name
  if (name === undefined) {
    // Neither range saw one: either the session is unnamed, or a rename sits
    // mid-file behind large tool output.
    name = sawWholeFile ? null : await streamLatestName(filePath)
  }

  const text = scan.text ?? (headTruncated ? await streamFirstUserMessage(filePath) : null)
  const contentState = scan.hasUserMessage
    ? 'non-empty'
    : sawWholeFile
      ? scan.header && !scan.parseFailure ? 'empty' : 'unknown'
      : await inspectSessionContent(filePath)

  return {
    header: scan.header,
    name,
    preview: text === null ? null : sessionPreview(stripInjectedPreamble(text)),
    contentState,
  }
}

/** mtime-keyed cache so repeated list and Timeline refreshes re-read nothing. */
const metadataCache = new Map<string, { mtimeMs: number; metadata: SessionMetadata }>()

export async function readSessionMetadataCached(
  filePath: string,
  mtimeMs: number
): Promise<SessionMetadata> {
  const hit = metadataCache.get(filePath)
  if (hit && hit.mtimeMs === mtimeMs) return hit.metadata

  const metadata = await readSessionMetadata(filePath)
  // Re-insert so eviction order tracks the most recent write, not the first.
  metadataCache.delete(filePath)
  metadataCache.set(filePath, { mtimeMs, metadata })
  if (metadataCache.size > METADATA_CACHE_MAX) {
    const oldest = metadataCache.keys().next().value
    if (oldest !== undefined) metadataCache.delete(oldest)
  }
  return metadata
}

/** Test helper: clear the metadata cache between cases. */
export function clearSessionMetadataCache(): void {
  metadataCache.clear()
}
