const THOUSAND = 1_000
const MILLION = 1_000_000
const BILLION = 1_000_000_000

/** Compact token/count formatting: 4800000000 → "4.8B", 6600000 → "6.6M", 847200 → "847.2k". */
export function formatCompact(n: number): string {
  if (n >= BILLION) return `${(n / BILLION).toFixed(1)}B`
  if (n >= MILLION) return `${(n / MILLION).toFixed(1)}M`
  if (n >= THOUSAND) return `${(n / THOUSAND).toFixed(1)}k`
  return String(n)
}
