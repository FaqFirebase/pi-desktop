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
