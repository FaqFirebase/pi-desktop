const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A friendly relative-time label capped at days — never a coarser unit than
 * "days". Beyond ~30 days it falls back to an absolute date ("Jul 3 2026").
 * Single unit only (no "1 hour 5 minutes"). `now` is passed in so a single
 * shared ticker can drive every label (see `NowContext`).
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const diff = now - timestamp
  // Clock skew / not-yet timestamps: treat as just now rather than "in -3s".
  if (diff < 45 * SECOND) return 'just now'
  if (diff < 90 * SECOND) return '1 minute ago'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} minutes ago`
  if (diff < 2 * HOUR) return '1 hour ago'
  if (diff < DAY) return `${Math.floor(diff / HOUR)} hours ago`
  if (diff < 2 * DAY) return 'yesterday'
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} days ago`

  const d = new Date(timestamp)
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`
}
