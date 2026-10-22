/**
 * Finds the relay URL this machine already uses, so the Relay panel can offer it
 * instead of asking the user to retype something the Pi CLI already knows.
 *
 * The precedence mirrors remote-pi's own `resolveRelayUrl()` so the desktop and
 * the Pi on this machine can never disagree: an `REMOTE_PI_RELAY` override wins
 * over `~/.pi/remote/config.json`, and both win over the community default.
 *
 * Only the Pi's user-level config is read. A per-directory
 * `<cwd>/.pi/remote-pi/config.json` is deliberately ignored: it describes one
 * folder's agent, not which relay this machine talks to.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeRelayUrl } from '../../shared/relay-protocol'

/**
 * The community default, matching remote-pi's `kDefaultRelayUrl`.
 *
 * Documented for parity rather than offered: see `detectRelayUrl` for why it is
 * never auto-filled.
 */
export const COMMUNITY_RELAY_URL = 'https://relay-rp1.jacobmoura.work'

/** Only sources the user configured on this machine; never the public default. */
export type RelayUrlSource = 'env' | 'config'

export interface DetectedRelayUrl {
  url: string
  source: RelayUrlSource
}

/**
 * Where the Pi keeps user-level relay config.
 *
 * remote-pi resolves this as `~/.pi/remote`, NOT relative to the agent dir: with
 * the default `PI_CODING_AGENT_DIR` of `~/.pi/agent`, joining `..` would land on
 * `~/remote` and silently find nothing.
 */
export function relayConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir()
  return join(home, '.pi', 'remote', 'config.json')
}

/**
 * Reads the `relay` field from remote-pi's config file.
 *
 * Returns null rather than throwing for every failure: a missing file, invalid
 * JSON, or a non-http value all mean "nothing to offer", and the panel falls
 * back to manual entry.
 */
export async function readConfiguredRelayUrl(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const relay = (parsed as { relay?: unknown }).relay
    return typeof relay === 'string' ? normalizeRelayUrl(relay) : null
  } catch {
    return null
  }
}

/**
 * The relay URL to offer in the panel, or null when this machine has never
 * configured one.
 *
 * The community default is NOT offered: it is a public relay the user has not
 * opted into, and prefilling it would silently route their prompts through a
 * third party. It is only reported when it is what the Pi CLI itself resolves,
 * which means the user already accepted it there.
 */
export async function detectRelayUrl(
  options: { env?: NodeJS.ProcessEnv; configPath?: string } = {},
): Promise<DetectedRelayUrl | null> {
  const env = options.env ?? process.env

  const fromEnv = env.REMOTE_PI_RELAY ? normalizeRelayUrl(env.REMOTE_PI_RELAY) : null
  if (fromEnv) return { url: fromEnv, source: 'env' }

  const fromConfig = await readConfiguredRelayUrl(options.configPath ?? relayConfigPath(env))
  if (fromConfig) return { url: fromConfig, source: 'config' }

  return null
}
