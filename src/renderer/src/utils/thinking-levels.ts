import type { ModelInfo } from '../../../shared/ipc-contracts'

/** Every thinking level, lowest first. */
const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** Levels a Pi model supports only when its thinkingLevelMap names them. */
const OPT_IN_THINKING_LEVELS = new Set(['xhigh', 'max'])

/**
 * The levels a model accepts. OMP lists them as efforts; Pi describes them with
 * `reasoning` and `thinkingLevelMap`, following Pi's getSupportedThinkingLevels
 * so the picker never offers a level the engine would silently change.
 */
export function thinkingLevels(model: ModelInfo | null | undefined): string[] {
  if (!model) return [...ALL_THINKING_LEVELS]
  const efforts = model.thinking?.efforts?.filter(
    (level) => typeof level === 'string' && level.length > 0,
  )
  if (efforts && efforts.length > 0) return ['off', ...efforts.filter((level) => level !== 'off')]
  if (!model.reasoning) return ['off']
  const map = model.thinkingLevelMap
  return ALL_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level]
    return mapped !== null && (!OPT_IN_THINKING_LEVELS.has(level) || mapped !== undefined)
  })
}

export function stepThinkingLevel(levels: string[], current: string, step: -1 | 1): string {
  const index = levels.indexOf(current)
  return levels[Math.max(0, Math.min(levels.length - 1, index + step))]
}
