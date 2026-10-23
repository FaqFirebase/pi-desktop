import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import type {
  ActivityStatsResult,
  ActivityRangeKey,
  ActivityStatsDay,
  ActivityModelUsage,
} from '../../../shared/ipc-contracts'
import { cacheTokenUsage, totalTokenUsage } from '../../../shared/token-usage'
import { buildWeeks, intensityLevel, type IntensityLevel } from '../utils/heatmap-grid'
import { formatCompact } from '../utils/format-compact'

type Tab = 'overview' | 'models'

const STATS_TAB_KEYS = {
  overview: 'stats.tabs.overview',
  models: 'stats.tabs.models',
} as const satisfies Record<Tab, string>

const RANGE_ORDER: ActivityRangeKey[] = ['365', '180', '90', '30', '7']

const RANGE_LABEL_KEYS = {
  '365': 'stats.ranges.oneYear',
  '180': 'stats.ranges.sixMonths',
  '90': 'stats.ranges.threeMonths',
  '30': 'stats.ranges.thirtyDays',
  '7': 'stats.ranges.sevenDays',
} as const satisfies Record<ActivityRangeKey, string>

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

/** 23 → "11 PM", 0 → "12 AM" (in `language`'s hour convention). */
function formatHour(h: number, language: string): string {
  return new Intl.DateTimeFormat(language, { hour: 'numeric' }).format(new Date(2000, 0, 1, h))
}

function formatShortDate(dateKey: string, language: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString(language, {
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
function bucketTokens(days: ActivityStatsDay[], language: string): TokenBucket[] {
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
    buckets.push({ label: formatShortDate(chunk[0].date, language), total, byModel })
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
  const { t } = useTranslation()
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
              title={day ? t('stats.heatmap.dayTooltip', { date: day.date, count: day.count }) : undefined}
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
  const { t, i18n } = useTranslation()
  const buckets = useMemo(() => bucketTokens(days, i18n.language), [days, i18n.language])

  if (buckets.length === 0) {
    return <div className="py-10 text-center text-xs text-faint">{t('stats.tokenChart.empty')}</div>
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
                title={t('stats.tokenChart.barTooltip', { label: b.label, tokens: formatCompact(b.total) })}
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
  const { t } = useTranslation()
  const grandTotal = models.reduce((s, m) => s + totalTokenUsage(m), 0)
  if (models.length === 0) {
    return <div className="py-4 text-center text-xs text-faint">{t('stats.modelLegend.empty')}</div>
  }
  return (
    <div className="space-y-1.5">
      {models.map((m) => {
        const total = totalTokenUsage(m)
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
              {t('stats.modelLegend.tokenBreakdown', {
                input: formatCompact(m.input),
                output: formatCompact(m.output),
                cache: formatCompact(cacheTokenUsage(m)),
              })}
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
  const { t, i18n } = useTranslation()
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
          {(['overview', 'models'] as Tab[]).map((tabId) => (
            <button
              key={tabId}
              onClick={() => setTab(tabId)}
              className={clsx(
                'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                tab === tabId ? 'bg-elevated text-primary' : 'text-dim hover:text-secondary'
              )}
            >
              {t(STATS_TAB_KEYS[tabId])}
            </button>
          ))}
        </div>
        <div className="flex gap-0.5 rounded-md bg-card/60 p-0.5">
          {RANGE_ORDER.map((key) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={clsx(
                'rounded px-2 py-0.5 text-xs font-medium tabular-nums transition-colors',
                range === key ? 'bg-elevated text-primary' : 'text-dim hover:text-secondary'
              )}
            >
              {t(RANGE_LABEL_KEYS[key])}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard label={t('stats.overview.sessionsLabel')} value={stats.sessions.toLocaleString(i18n.language)} />
            <StatCard label={t('stats.overview.messagesLabel')} value={stats.messages.toLocaleString(i18n.language)} />
            <StatCard label={t('stats.overview.totalTokensLabel')} value={formatCompact(stats.totalTokens)} />
            <StatCard label={t('stats.overview.activeDaysLabel')} value={stats.activeDays.toLocaleString(i18n.language)} />
            <StatCard
              label={t('stats.overview.currentStreakLabel')}
              value={t('stats.overview.streakDays', { count: stats.currentStreak })}
            />
            <StatCard
              label={t('stats.overview.longestStreakLabel')}
              value={t('stats.overview.streakDays', { count: stats.longestStreak })}
            />
            <StatCard label={t('stats.overview.peakHourLabel')} value={stats.peakHour === null ? '—' : formatHour(stats.peakHour, i18n.language)} />
            <StatCard label={t('stats.overview.favoriteModelLabel')} value={favoriteModel} />
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
