import type { AgentEngineKind, SessionListItem } from '../../../shared/ipc-contracts'
import { getSessionTitle } from '../utils/session-title'
import { agentEngineLabel } from '../../../shared/agent-engine-label'

type SessionRowLabelInput = Pick<
  SessionListItem,
  'name' | 'preview' | 'sessionId' | 'projectName' | 'projectPath'
>

type SessionEngineInput = Pick<SessionListItem, 'engine'>

interface SessionRowLabels {
  title: string
  subtitle: string | null
}

export function getSessionRowLabels(session: SessionRowLabelInput): SessionRowLabels {
  const subtitle = session.projectName.trim()

  return {
    title: getSessionTitle(session.name, session.sessionId, session.preview),
    subtitle: subtitle || null,
  }
}

/**
 * Tag naming the engine a session belongs to, or null when the main process
 * could not classify it. An unlabelled row is left untagged rather than being
 * guessed into one engine — the two are not interchangeable.
 */
export function getSessionEngineLabel(session: SessionEngineInput): string | null {
  return agentEngineLabel(session.engine)
}

/**
 * True when the sessions come from more than one engine. With a single engine
 * on screen the tag names what everything already is, so it is only noise.
 */
export function hasMixedSessionEngines(sessions: readonly SessionEngineInput[]): boolean {
  let seen: AgentEngineKind | null = null
  for (const session of sessions) {
    if (!session.engine) continue
    if (seen === null) seen = session.engine
    else if (seen !== session.engine) return true
  }
  return false
}
