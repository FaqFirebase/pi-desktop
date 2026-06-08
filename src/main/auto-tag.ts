import { open } from 'fs/promises'

/**
 * Derive a single-word topic tag from the context of a PI session by reading
 * the first user message out of the session .jsonl and extracting the most
 * salient keyword. Runs locally — no network, no LLM, deterministic.
 */

// Only the head of the file is scanned; the first user message appears early.
const MAX_READ_BYTES = 32 * 1024
const MIN_TOKEN_LENGTH = 3
const MAX_TAG_LENGTH = 32
// Action-oriented words win frequency ties so tags read as intent ("refactor").
const INTENT_WEIGHT = 2

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'this', 'that',
  'have', 'has', 'had', 'from', 'they', 'them', 'then', 'than', 'will', 'would',
  'should', 'could', 'can', 'all', 'any', 'our', 'out', 'use', 'using', 'used',
  'into', 'over', 'some', 'such', 'only', 'also', 'how', 'what', 'when', 'where',
  'which', 'who', 'why', 'its', 'his', 'her', 'their', 'about', 'there', 'here',
  'just', 'like', 'make', 'made', 'need', 'needs', 'want', 'please', 'help',
  'let', 'lets', 'get', 'got', 'see', 'now', 'one', 'two', 'new', 'set', 'way',
  'via', 'per', 'each', 'more', 'most', 'very', 'much', 'many', 'few', 'these',
  'those', 'been', 'being', 'was', 'were', 'does', 'did', 'doing', 'done',
  'task', 'code', 'file', 'files', 'project', 'app', 'application', 'user',
  'expert', 'senior', 'follow', 'following', 'current', 'currently', 'must',
])

const INTENT_WORDS = new Set([
  'fix', 'bug', 'refactor', 'implement', 'feature', 'test', 'tests', 'debug',
  'docs', 'documentation', 'design', 'review', 'deploy', 'build', 'setup',
  'config', 'migrate', 'migration', 'optimize', 'performance', 'security',
  'add', 'create', 'remove', 'delete', 'update', 'upgrade', 'rename',
  'integrate', 'integration', 'rewrite', 'cleanup',
])

export async function deriveAutoTag(sessionFilePath: string): Promise<string | null> {
  const text = await readFirstUserMessage(sessionFilePath)
  if (!text) return null
  return extractKeyword(text)
}

async function readFirstUserMessage(sessionFilePath: string): Promise<string | null> {
  let handle
  try {
    handle = await open(sessionFilePath, 'r')
    const buffer = Buffer.alloc(MAX_READ_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, 0)
    const chunk = buffer.toString('utf-8', 0, bytesRead)

    // Drop a trailing partial line so JSON.parse only sees complete records.
    const lines = chunk.split('\n')
    const complete = bytesRead === MAX_READ_BYTES ? lines.slice(0, -1) : lines

    for (const line of complete) {
      if (!line.trim()) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const text = userMessageText(record)
      if (text) return text
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

function userMessageText(record: unknown): string | null {
  if (typeof record !== 'object' || record === null) return null
  const rec = record as { type?: unknown; message?: unknown }
  if (rec.type !== 'message' || typeof rec.message !== 'object' || rec.message === null) {
    return null
  }
  const message = rec.message as { role?: unknown; content?: unknown }
  if (message.role !== 'user' || !Array.isArray(message.content)) return null

  const parts: string[] = []
  for (const block of message.content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text)
    }
  }
  const joined = parts.join(' ').trim()
  return joined.length > 0 ? joined : null
}

function extractKeyword(text: string): string | null {
  const cleaned = text
    .toLowerCase()
    // Strip fenced code blocks and inline code so prose drives the tag.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    // Strip URLs and file paths.
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S*\/\S*/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')

  const scores = new Map<string, number>()
  for (const token of cleaned.split(/\s+/)) {
    if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TAG_LENGTH) continue
    if (/^\d+$/.test(token)) continue
    if (STOPWORDS.has(token)) continue
    const weight = INTENT_WORDS.has(token) ? INTENT_WEIGHT : 1
    scores.set(token, (scores.get(token) ?? 0) + weight)
  }

  let best: string | null = null
  let bestScore = 0
  for (const [token, score] of scores) {
    // Tie-break toward the longer (more specific) token.
    if (score > bestScore || (score === bestScore && best !== null && token.length > best.length)) {
      best = token
      bestScore = score
    }
  }
  return best
}
