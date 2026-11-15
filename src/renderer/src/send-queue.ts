import type { TFunction } from 'i18next'
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

/**
 * Queued prompts per chat, oldest first. A chat is keyed by its session
 * runtime id: a new chat has it from its first send, and it stays the same
 * across restarts of that chat's process.
 */
export type SendQueues = Readonly<Record<string, readonly QueuedPrompt[]>>

export function withQueued(queues: SendQueues, chatId: string, prompt: QueuedPrompt): SendQueues {
  return { ...queues, [chatId]: [...(queues[chatId] ?? []), prompt] }
}

/** The queues without that prompt. A queue left empty is dropped; the same queues come back when nothing changed. */
export function withoutQueued(queues: SendQueues, chatId: string, promptId: string): SendQueues {
  const queue = queues[chatId]
  if (!queue?.some((prompt) => prompt.id === promptId)) return queues
  const rest = queue.filter((prompt) => prompt.id !== promptId)
  const next = { ...queues }
  if (rest.length > 0) next[chatId] = rest
  else delete next[chatId]
  return next
}

/**
 * Why a chat's queue waits for the user instead of going out when a turn ends.
 * - 'interrupted': the turn was stopped, refused or failed, so the next
 *   message would surprise the user or fail again. The user's next send
 *   releases it.
 * - 'ended-off-screen': the turn ended while the chat was off screen, where
 *   its end cannot be seen. Only "Send now" sends these messages, so none
 *   goes out by itself after a prompt the user sent later.
 */
export type SendQueueHold = 'interrupted' | 'ended-off-screen'

/** What starts the queue again: each hold reason has its own way out. */
export function sendQueueStatusText(t: TFunction, hold: SendQueueHold | undefined): string {
  switch (hold) {
    case 'interrupted': return t('chat.sendQueue.held')
    case 'ended-off-screen': return t('chat.sendQueue.heldOffScreen')
    case undefined: return t('chat.sendQueue.next')
  }
}

/** Held queues per chat; a chat that is not here sends its queue at the end of each turn. */
export type SendQueueHolds = Readonly<Record<string, SendQueueHold>>

/** The per-chat entries without those chats (the chats were closed); the same entries come back when nothing changed. */
export function withoutChats<T>(entries: Readonly<Record<string, T>>, chatIds: readonly string[]): Readonly<Record<string, T>> {
  if (!chatIds.some((chatId) => chatId in entries)) return entries
  const next = { ...entries }
  for (const chatId of chatIds) delete next[chatId]
  return next
}

export function firstQueued(queues: SendQueues, chatId: string): QueuedPrompt | undefined {
  return queues[chatId]?.[0]
}
