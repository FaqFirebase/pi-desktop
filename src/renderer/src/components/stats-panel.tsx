import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import type {
  ActivityStatsResult,
  ActivityRangeKey,
  ActivityStatsDay,
  ActivityModelUsage,
} from '../../../shared/ipc-contracts'
import { buildWeeks, intensityLevel, type IntensityLevel } from '../utils/heatmap-grid'

type Tab = 'overview' | 'models'

const RANGE_LABELS: { key: ActivityRangeKey; label: string }[] = [
  { key: '365', label: '1y' },
  { key: '180', label: '6mo' },
  { key: '90', label: '3mo' },
  { key: '30', label: '30d' },
  { key: '7', label: '7d' },
]

const RANGE_DAYS: Record<ActivityRangeKey, number> = {
  '365': 365,
  '180': 180,
  '90': 90,
  '30': 30,
  '7': 7,
}
const MAX_BARS = 26 // token chart resolution cap
const CHART_TICKS = 4 // y-axis intervals (→ 5 labels)

// Intensity buckets for the heatmap (0 = empty).
const LEVEL_CLASSES: Record<IntensityLevel, string> = {
  0: 'bg-card/60',
  1: 'bg-accent/30',
  2: 'bg-accent/50',
  3: 'bg-accent/70',
  4: 'bg-accent',
}

// Legend dot colors, cycled by model rank.
const MODEL_DOT_COLORS = [
  'bg-emerald-500', /* theme-exempt: categorical palette */
  'bg-blue-500', /* theme-exempt: categorical palette */
  'bg-sky-400', /* theme-exempt: categorical palette */
  'bg-violet-500', /* theme-exempt: categorical palette */
  'bg-amber-500', /* theme-exempt: categorical palette */
  'bg-rose-500', /* theme-exempt: categorical palette */
  'bg-teal-400', /* theme-exempt: categorical palette */
  'bg-neutral-500', /* theme-exempt: categorical palette */
]

/** Display label for a model: its models.json name, or the raw id as fallback. */
function modelLabel(usage: ActivityModelUsage): string {
  return usage.name ?? usage.model
}

/** Compact token/count formatting: 6600000 → "6.6M", 847200 → "847.2k". */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** 23 → "11 PM", 0 → "12 AM". */
function formatHour(h: number): string {
  const period = h < 12 ? 'AM' : 'PM'
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr} ${period}`
}

function formatShortDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

interface TokenBucket {
  label: string
  total: number
  byModel: Record<string, number> // model id -> tokens in this bucket
}

/** Bucket a day slice into ≤ MAX_BARS bars, trimming leading token-free days. */
function bucketTokens(days: ActivityStatsDay[]): TokenBucket[] {
  let start = 0
  while (start < days.length && days[start].tokens === 0) start += 1
  const span = days.slice(start)
  if (span.length === 0) return []
  const size = Math.max(1, Math.ceil(span.length / MAX_BARS))
  const buckets: TokenBucket[] = []
  for (let i = 0; i < span.length; i += size) {
    const chunk = span.slice(i, i + size)
    const byModel: Record<string, number> = {}
    let total = 0
    for (const d of chunk) {
      total += d.tokens
      for (const [model, t] of Object.entries(d.tokensByModel)) byModel[model] = (byModel[model] ?? 0) + t
    }
    buckets.push({ label: formatShortDate(chunk[0].date), total, byModel })
  }
  return buckets
}

function StatCard({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg bg-card/40 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-dim">{label}</div>
      <div className="mt-0.5 truncate text-lg font-semibold text-primary" title={value}>
        {value}
      </div>
    </div>
  )
}

function Heatmap({ days }: { days: ActivityStatsDay[] }): React.JSX.Element {
  const { weeks, maxCount } = useMemo(() => {
    const asActivity = days.map((d) => ({ date: d.date, count: d.messages }))
    return {
      weeks: buildWeeks(asActivity),
      maxCount: days.reduce((m, d) => Math.max(m, d.messages), 0),
    }
  }, [days])

  return (
    <div className="flex gap-1 overflow-x-auto">
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-1">
          {week.map((day, di) => (
            <div
              key={di}
              title={day ? `${day.date} — ${day.count} messages` : undefined}
              className={clsx(
                'h-3 w-3 rounded-sm',
                day ? LEVEL_CLASSES[intensityLevel(day.count, maxCount)] : 'bg-transparent'
              )}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function TokenChart({
  days,
  orderedModels,
  modelColor,
}: {
  days: ActivityStatsDay[]
  orderedModels: string[] // largest-first; stacking order (top → bottom)
  modelColor: Map<string, string>
}): React.JSX.Element {
  const buckets = useMemo(() => bucketTokens(days), [days])

  if (buckets.length === 0) {
    return <div className="py-10 text-center text-xs text-faint">No token usage in this range.</div>
  }

  const max = buckets.reduce((m, b) => Math.max(m, b.total), 0)
  const ticks = Array.from({ length: CHART_TICKS + 1 }, (_, i) => (max * (CHART_TICKS - i)) / CHART_TICKS)
  const labelStep = Math.ceil(buckets.length / 6)

  return (
    <div className="flex gap-2">
      {/* Y-axis tick labels */}
      <div className="flex h-40 w-12 shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-faint">
        {ticks.map((t, i) => (
          <div key={i}>{formatCompact(Math.round(t))}</div>
        ))}
      </div>

      {/* Plot area */}
      <div className="min-w-0 flex-1">
        <div className="relative h-40">
          {/* Gridlines */}
          {ticks.map((_, i) => (
            <div
              key={i}
              className="absolute inset-x-0 border-t border-border/70"
              style={{ top: `${(i / CHART_TICKS) * 100}%` }}
            />
          ))}
          {/* Stacked bars: one column per bucket, segments colored by model. */}
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {buckets.map((b, i) => (
              <div
                key={i}
                title={`${b.label} — ${formatCompact(b.total)} tokens`}
                className="flex min-w-[2px] flex-1 flex-col overflow-hidden rounded-sm"
                style={{ height: max > 0 ? `${Math.max((b.total / max) * 100, b.total > 0 ? 2 : 0)}%` : '0%' }}
              >
                {orderedModels.map((model) => {
                  const t = b.byModel[model] ?? 0
                  if (t <= 0 || b.total <= 0) return null
                  return (
                    <div
                      key={model}
                      className={clsx('w-full', modelColor.get(model) ?? 'bg-accent')}
                      style={{ height: `${(t / b.total) * 100}%` }}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        {/* X-axis labels */}
        <div className="mt-1 flex gap-[3px] text-[10px] text-faint">
          {buckets.map((b, i) => (
            <div key={i} className="min-w-[2px] flex-1 text-center">
              {i % labelStep === 0 ? b.label : ''}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ModelLegend({
  models,
  modelColor,
}: {
  models: ActivityModelUsage[]
  modelColor: Map<string, string>
}): React.JSX.Element {
  const grandTotal = models.reduce((s, m) => s + m.input + m.output, 0)
  if (models.length === 0) {
    return <div className="py-4 text-center text-xs text-faint">No model usage in this range.</div>
  }
  return (
    <div className="space-y-1.5">
      {models.map((m) => {
        const total = m.input + m.output
        const pct = grandTotal > 0 ? (total / grandTotal) * 100 : 0
        return (
          <div key={m.model} className="flex items-center gap-2 text-xs">
            <span
              className={clsx(
              'h-2 w-2 shrink-0 rounded-full',
              modelColor.get(m.model) ?? 'bg-neutral-500' /* theme-exempt: categorical palette */
            )}
            />
            <span className="min-w-0 flex-1 truncate text-secondary">{modelLabel(m)}</span>
            <span className="shrink-0 tabular-nums text-dim">
              {formatCompact(m.input)} in · {formatCompact(m.output)} out
            </span>
            <span className="w-12 shrink-0 text-right tabular-nums text-muted">{pct.toFixed(1)}%</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Home-screen activity dashboard, backed by the persisted stats store (survives
 * session deletion). Renders nothing until there is activity, so a fresh install
 * stays uncluttered.
 */
export function StatsPanel(): React.JSX.Element | null {
  const [data, setData] = useState<ActivityStatsResult | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [range, setRange] = useState<ActivityRangeKey>('365')

  useEffect(() => {
    let cancelled = false
    window.piDesktop.activity
      .getStats()
      .then((r) => { if (!cancelled) setData(r) })
      .catch(() => { if (!cancelled) setData(null) })
    return () => { cancelled = true }
  }, [])

  const rangedDays = useMemo(() => {
    if (!data) return []
    return data.days.slice(-RANGE_DAYS[range])
  }, [data, range])

  // Nothing to show on a fresh install.
  if (!data || data.ranges['365'].messages === 0) return null

  const stats = data.ranges[range]
  const favoriteModel = stats.models[0] ? modelLabel(stats.models[0]) : '—'

  // Shared model→color mapping (largest-first) so the stacked bars and the
  // legend agree on colors.
  const orderedModels = stats.models.map((m) => m.model)
  const modelColor = new Map<string, string>(
    orderedModels.map((model, i) => [model, MODEL_DOT_COLORS[i % MODEL_DOT_COLORS.length]])
  )

  return (
    <div className="mb-8 rounded-lg border border-border bg-surface/50 p-4">
      {/* Tabs + range toggle */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-1">
          {(['overview', 'models'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                tab === t ? 'bg-elevated text-primary' : 'text-dim hover:text-secondary'
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex gap-0.5 rounded-md bg-card/60 p-0.5">
          {RANGE_LABELS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={clsx(
                'rounded px-2 py-0.5 text-xs font-medium tabular-nums transition-colors',
                range === key ? 'bg-elevated text-primary' : 'text-dim hover:text-secondary'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard label="Sessions" value={stats.sessions.toLocaleString()} />
            <StatCard label="Messages" value={stats.messages.toLocaleString()} />
            <StatCard label="Total tokens" value={formatCompact(stats.totalTokens)} />
            <StatCard label="Active days" value={stats.activeDays.toLocaleString()} />
            <StatCard label="Current streak" value={`${stats.currentStreak}d`} />
            <StatCard label="Longest streak" value={`${stats.longestStreak}d`} />
            <StatCard label="Peak hour" value={stats.peakHour === null ? '—' : formatHour(stats.peakHour)} />
            <StatCard label="Favorite model" value={favoriteModel} />
          </div>
          <Heatmap days={rangedDays} />
        </>
      ) : (
        <>
          <TokenChart days={rangedDays} orderedModels={orderedModels} modelColor={modelColor} />
          <div className="mt-4 border-t border-border pt-3">
            <ModelLegend models={stats.models} modelColor={modelColor} />
          </div>
        </>
      )}
    </div>
  )
}
