import { i18n } from '../../../shared/i18n'

const UNITS = ['day', 'hour', 'minute', 'second'] as const

/**
 * A countdown such as "4d 10h", "26m 21s" or "3h": the largest non-zero unit
 * and the next one when it is non-zero, in narrow style and the interface
 * language. Zero and negative durations read as "0s".
 */
export function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const values: Record<(typeof UNITS)[number], number> = {
    day: Math.floor(totalSeconds / 86_400),
    hour: Math.floor(totalSeconds / 3_600) % 24,
    minute: Math.floor(totalSeconds / 60) % 60,
    second: totalSeconds % 60,
  }
  const first = UNITS.findIndex((unit) => values[unit] > 0)
  const units = first === -1 ? (['second'] as const) : UNITS.slice(first, first + 2).filter((unit) => values[unit] > 0)
  const language = i18n.language
  return new Intl.ListFormat(language, { type: 'unit', style: 'narrow' }).format(
    units.map((unit) =>
      new Intl.NumberFormat(language, { style: 'unit', unit, unitDisplay: 'narrow' }).format(values[unit])
    )
  )
}
