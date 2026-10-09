import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  REPO_MAP_ENV,
  REPO_SET_CHANGE_MESSAGE_TYPE,
  appendToSystemPrompt,
  describeRepoSetChange,
  formatRepoMapPrompt,
  loadRepoMap,
  type RepoSetContext,
} from './repo-set-map'

// Set by the GUI only when it starts an agent for a linked task (a repo set
// tab). The file is re-read per turn, so a repository added during the task
// reaches the agent on its next turn.
const repoMapPath = process.env[REPO_MAP_ENV] ?? null

/**
 * Tells the agent which repositories a linked task spans. Pi and OMP both run
 * `before_agent_start` before every turn and accept a replacement system
 * prompt (Pi passes it as one string, OMP as a list of strings) and a message
 * for that turn. When the repositories changed since the last turn, a hidden
 * message says so in the conversation too.
 *
 * Writes outside the set are routed to the approval prompt by the permission
 * extension, so a single tool call never raises two prompts.
 */
export default function piDesktopRepoSet(pi: ExtensionAPI): void {
  // The repositories the agent was told about on its last turn in this process.
  let previous: RepoSetContext | null = null
  pi.on('before_agent_start', async (event) => {
    if (!repoMapPath) return
    const context = loadRepoMap(repoMapPath)
    if (!context) return
    const change = previous ? describeRepoSetChange(previous, context) : null
    previous = context
    return {
      systemPrompt: appendToSystemPrompt(event.systemPrompt, formatRepoMapPrompt(context)),
      ...(change ? { message: { customType: REPO_SET_CHANGE_MESSAGE_TYPE, content: change, display: false } } : {}),
    }
  })
}
