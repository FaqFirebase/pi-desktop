import type { SessionListItem } from '../../../shared/ipc-contracts'

type SessionRowLabelInput = Pick<SessionListItem, 'name' | 'sessionId' | 'projectName' | 'projectPath'>

interface SessionRowLabels {
  title: string
  subtitle: string | null
}

export function getSessionRowLabels(session: SessionRowLabelInput): SessionRowLabels {
  const subtitle = session.projectName.trim()

  return {
    title: session.name || session.sessionId.slice(0, 12),
    subtitle: subtitle || null,
  }
}
