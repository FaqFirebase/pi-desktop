/**
 * Status entries an agent extension sets with `ctx.ui.setStatus(key, text)`,
 * keyed by status key. Pi's terminal UI lists them in its footer; in RPC mode
 * each call arrives as a fire-and-forget `setStatus` extension-UI request.
 *
 * Main keeps one map per session runtime and ships it on the runtime snapshot,
 * so the renderer always shows the entries of the session on screen.
 */
export type ExtensionStatuses = Readonly<Record<string, string>>

/** The key an engine's setStatus request falls under when it names none. */
export const DEFAULT_EXTENSION_STATUS_KEY = 'default'

/**
 * Apply one setStatus request: a string sets the key, anything else clears it
 * (the engine sends no text to clear). Returns `statuses` itself when nothing
 * changed, and undefined once the last entry is gone.
 */
export function applyExtensionStatus(
  statuses: ExtensionStatuses | undefined,
  key: string | undefined,
  text: unknown,
): ExtensionStatuses | undefined {
  const statusKey = key ?? DEFAULT_EXTENSION_STATUS_KEY
  if (typeof text === 'string') {
    if (statuses?.[statusKey] === text) return statuses
    return { ...statuses, [statusKey]: text }
  }
  if (!statuses || !Object.hasOwn(statuses, statusKey)) return statuses
  const { [statusKey]: _cleared, ...rest } = statuses
  return Object.keys(rest).length > 0 ? rest : undefined
}
