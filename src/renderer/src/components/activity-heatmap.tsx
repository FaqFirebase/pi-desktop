import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import type { ActivityHeatmapResult } from '../../../shared/ipc-contracts'
import { buildWeeks, intensityLevel, type IntensityLevel } from '../utils/heatmap-grid'

const STRIP_WEEKS = 16 // trailing weeks shown on the Home screen
const DAYS_PER_WEEK = 7

// Tailwind classes per intensity bucket (0 = empty).
const LEVEL_CLASSES: Record<IntensityLevel, string> = {
  0: 'bg-neutral-800/60',
  1: 'bg-blue-900',
  2: 'bg-blue-700',
  3: 'bg-blue-500',
  4: 'bg-blue-400',
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
      {children}
    </div>
  )
}

/**
 * GitHub-style contribution strip for the Home screen. Fetches pooled per-day
 * message activity and renders the trailing STRIP_WEEKS weeks. Renders nothing
 * when there is no activity, so it stays unobtrusive on a fresh install.
 */
export function ActivityHeatmap(): React.JSX.Element | null {
  const [data, setData] = useState<ActivityHeatmapResult | null>(null)

  useEffect(() => {
    let cancelled = false
    window.piDesktop.activity
      .getHeatmap()
      .then((r) => { if (!cancelled) setData(r) })
      .catch(() => { if (!cancelled) setData(null) })
    return () => { cancelled = true }
  }, [])

  const { weeks, visibleTotal } = useMemo(() => {
    if (!data) return { weeks: [], visibleTotal: 0 }
    const tail = data.days.slice(-STRIP_WEEKS * DAYS_PER_WEEK)
    return {
      weeks: buildWeeks(tail),
      visibleTotal: tail.reduce((sum, d) => sum + d.count, 0),
    }
  }, [data])

  if (!data || visibleTotal === 0 || weeks.length === 0) return null

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between">
        <SectionLabel>Activity</SectionLabel>
        <span className="text-[11px] text-neutral-600">
          {visibleTotal} messages in the last {STRIP_WEEKS} weeks
        </span>
      </div>
      <div className="flex gap-1 overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-1">
            {week.map((day, di) => (
              <div
                key={di}
                title={day ? `${day.date} - ${day.count} messages` : undefined}
                className={clsx(
                  'h-3 w-3 rounded-sm',
                  day ? LEVEL_CLASSES[intensityLevel(day.count, data.maxCount)] : 'bg-transparent'
                )}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
