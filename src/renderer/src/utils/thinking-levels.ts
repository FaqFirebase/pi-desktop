import type { ModelInfo } from '../../../shared/ipc-contracts'

export function thinkingLevels(model: ModelInfo | null | undefined): string[] {
  const efforts = model?.thinking?.efforts?.filter(
    (level) => typeof level === 'string' && level.length > 0,
  )
  return efforts && efforts.length > 0
    ? ['off', ...efforts.filter((level) => level !== 'off')]
    : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
}

export function stepThinkingLevel(levels: string[], current: string, step: -1 | 1): string {
  const index = levels.indexOf(current)
  return levels[Math.max(0, Math.min(levels.length - 1, index + step))]
}
