import { join } from 'path'

/**
 * Absolute path to Pi's on-disk session store (`~/.pi/agent/sessions`).
 * Centralized so session listing, lineage, and activity aggregation agree.
 */
export function getSessionsRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ||
    join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.pi', 'agent')
  return join(agentDir, 'sessions')
}
