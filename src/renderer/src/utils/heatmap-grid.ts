import type { ActivityDay } from '../../../shared/ipc-contracts'

const DAYS_PER_WEEK = 7
const INTENSITY_LEVELS = 4 // levels 1..4 above the empty level 0

export type IntensityLevel = 0 | 1 | 2 | 3 | 4

/**
 * Group ascending daily activity into column-major weeks. Each inner array
 * has 7 slots (Sunday..Saturday). The first column is left-padded with `null`
 * so the first real day lands on its correct weekday row; the last column is
 * right-padded the same way.
 */
export function buildWeeks(days: ActivityDay[]): (ActivityDay | null)[][] {
  if (days.length === 0) return []
  const weeks: (ActivityDay | null)[][] = []
  let current: (ActivityDay | null)[] = []

  const firstWeekday = new Date(`${days[0].date}T00:00:00`).getDay()
  for (let i = 0; i < firstWeekday; i++) current.push(null)

  for (const day of days) {
    current.push(day)
    if (current.length === DAYS_PER_WEEK) {
      weeks.push(current)
      current = []
    }
  }
  if (current.length > 0) {
    while (current.length < DAYS_PER_WEEK) current.push(null)
    weeks.push(current)
  }
  return weeks
}

/** Map a day's count to a 0..4 intensity bucket relative to the busiest day. */
export function intensityLevel(count: number, maxCount: number): IntensityLevel {
  if (count <= 0 || maxCount <= 0) return 0
  const level = Math.ceil((count / maxCount) * INTENSITY_LEVELS)
  return Math.min(level, INTENSITY_LEVELS) as IntensityLevel
}
