import type { ComposerAttachment } from './store'

/**
 * A message the user sent while the agent was busy. The app holds it, not the
 * engine, so Pi and OMP queue the same way: the store sends the oldest one as
 * a normal prompt when the turn ends, and "Send now" pushes one into the
 * running turn. The raw text and files are kept, so Edit can put them back in
 * the composer exactly as typed.
 */
export interface QueuedPrompt {
  id: string
  text: string
  attachments: ComposerAttachment[]
}

/** Queued prompts per workspace (one chat tab each), oldest first. */
export type SendQueues = Readonly<Record<string, readonly QueuedPrompt[]>>

export function withQueued(queues: SendQueues, workspaceId: string, prompt: QueuedPrompt): SendQueues {
  return { ...queues, [workspaceId]: [...(queues[workspaceId] ?? []), prompt] }
}

/** The queues without that prompt. A queue left empty is dropped; the same queues come back when nothing changed. */
export function withoutQueued(queues: SendQueues, workspaceId: string, promptId: string): SendQueues {
  const queue = queues[workspaceId]
  if (!queue?.some((prompt) => prompt.id === promptId)) return queues
  const rest = queue.filter((prompt) => prompt.id !== promptId)
  const next = { ...queues }
  if (rest.length > 0) next[workspaceId] = rest
  else delete next[workspaceId]
  return next
}

/** The queues without that workspace's queue (the workspace was removed). */
export function withoutWorkspaceQueue(queues: SendQueues, workspaceId: string): SendQueues {
  if (!(workspaceId in queues)) return queues
  const next = { ...queues }
  delete next[workspaceId]
  return next
}

export function firstQueued(queues: SendQueues, workspaceId: string): QueuedPrompt | undefined {
  return queues[workspaceId]?.[0]
}
