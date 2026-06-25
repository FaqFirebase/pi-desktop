import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWeeks, intensityLevel } from './heatmap-grid'
import type { ActivityDay } from '../../../shared/ipc-contracts'

function rangeDays(start: string, n: number): ActivityDay[] {
  const out: ActivityDay[] = []
  const base = new Date(`${start}T00:00:00`)
  for (let i = 0; i < n; i++) {
    const d = new Date(base.getTime() + i * 86_400_000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ date: key, count: 0 })
  }
  return out
}

test('buildWeeks groups days into 7-row week columns', () => {
  // 2026-06-21 is a Sunday: a clean 14-day span makes exactly 2 full weeks.
  const weeks = buildWeeks(rangeDays('2026-06-21', 14))
  assert.equal(weeks.length, 2)
  assert.equal(weeks[0].length, 7)
  assert.equal(weeks[0][0]?.date, '2026-06-21')
  assert.equal(weeks[1][0]?.date, '2026-06-28')
})

test('buildWeeks pads the first column when the range starts mid-week', () => {
  // 2026-06-24 is a Wednesday (weekday index 3): first 3 cells are null pads.
  const weeks = buildWeeks(rangeDays('2026-06-24', 4))
  assert.equal(weeks[0][0], null)
  assert.equal(weeks[0][1], null)
  assert.equal(weeks[0][2], null)
  assert.equal(weeks[0][3]?.date, '2026-06-24')
})

test('buildWeeks pads the trailing column when the range ends mid-week', () => {
  // 2026-06-21 is a Sunday: 10 days covers one full week plus 3 days,
  // so the last column has days at indices 0-2 and null pads at 3-6.
  const weeks = buildWeeks(rangeDays('2026-06-21', 10))
  assert.equal(weeks.length, 2)
  const lastWeek = weeks[1]
  assert.equal(lastWeek[2]?.date, '2026-06-30')
  assert.equal(lastWeek[3], null)
  assert.equal(lastWeek[4], null)
  assert.equal(lastWeek[5], null)
  assert.equal(lastWeek[6], null)
})

test('intensityLevel buckets counts from 0 to 4', () => {
  assert.equal(intensityLevel(0, 10), 0)
  assert.equal(intensityLevel(10, 10), 4)
  assert.equal(intensityLevel(1, 10), 1)
  assert.equal(intensityLevel(5, 10), 2)
})

test('intensityLevel returns 0 when maxCount is 0', () => {
  assert.equal(intensityLevel(0, 0), 0)
})
