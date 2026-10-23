/**
 * Shared by every `before_agent_start` handler the app ships. It has no
 * imports, so the renderer can load the files that use it.
 */

/**
 * Append a block to the system prompt a `before_agent_start` handler received.
 * Pi passes one string; OMP passes a list of strings. The result keeps the
 * engine's own shape.
 */
export function appendToSystemPrompt(systemPrompt: string | readonly string[], block: string): string | string[] {
  if (typeof systemPrompt === 'string') return `${systemPrompt}\n\n${block}`
  return [...systemPrompt, block]
}
