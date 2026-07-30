import type { SessionListItem } from '../../../shared/ipc-contracts'
import { getSessionTitle } from '../utils/session-title'

type SessionRowLabelInput = Pick<
  SessionListItem,
  'name' | 'preview' | 'sessionId' | 'projectName' | 'projectPath'
>

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
