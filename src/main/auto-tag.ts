import { stripInjectedPreamble } from '../shared/session-preview'
import { readFirstUserMessage } from './session-metadata'

/**
 * Derive a single-word topic tag from the context of a Pi session by reading
 * the first user message out of the session .jsonl and extracting the most
 * salient keyword. Runs locally — no network, no LLM, deterministic.
 */

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
  // Strip GUI-injected boilerplate so the tag reflects the user's intent rather
  // than the words of a planning-mode preamble.
  return extractKeyword(stripInjectedPreamble(text))
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
