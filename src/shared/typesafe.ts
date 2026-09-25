/**
 * TypeSafe (Jev) values shared by both processes.
 *
 * Pi Desktop never calls TypeSafe itself. It stores the user's API key, hands
 * it to Pi and OMP through this environment variable, and installs the
 * TypeSafe agent skill that tells the agent how to use it.
 */

/** The variable the TypeSafe SDKs and the agent skill read the key from. */
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY'

export const TYPESAFE_LINKS = {
  apiKeys: 'https://console.typesafe.ai/keys',
  introduction: 'https://docs.typesafe.ai/introduction',
  agentSkill: 'https://docs.typesafe.ai/agent-skill',
} as const

export const MAX_TYPESAFE_API_KEY_LENGTH = 512

// A key is one token: printable ASCII with no spaces. Anything else is a paste
// accident, and a newline would corrupt the environment it is passed through.
const API_KEY_PATTERN = /^[\x21-\x7e]+$/

/** The trimmed key, or null when the value cannot be a TypeSafe API key. */
export function normalizeTypeSafeApiKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  if (key.length === 0 || key.length > MAX_TYPESAFE_API_KEY_LENGTH) return null
  return API_KEY_PATTERN.test(key) ? key : null
}
