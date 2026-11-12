import type {
  OmpUsageAccount,
  OmpUsageCapacity,
  OmpUsageLimit,
  OmpUsageReport,
  OmpUsageResets,
  OmpUsageStatus,
} from '../shared/ipc-contracts'
import { parseCliJsonObject } from './cli-json'

/**
 * Parsing for `omp usage --json`: the provider usage limits of every account
 * OMP is signed in to, the same report `omp usage` prints.
 *
 * Shape as OMP 18 emits it:
 *   `{ generatedAt, reports: UsageReport[], accountsWithoutUsage, disabledCredentials,
 *      capacity: { [provider]: [{ window, meter?, accounts, usedAccounts, ... }] } }`
 * One report is one account. A report's `limits[].amount` may carry any of
 * `usedFraction`, `used`/`limit`, a percent-unit `used`, or `remainingFraction`;
 * the used fraction is resolved in that order, as OMP's own views do.
 */
export const OMP_USAGE_ARGS = ['usage', '--json']

const STATUSES: readonly OmpUsageStatus[] = ['ok', 'warning', 'exhausted', 'unknown']

/** The usage report, or null when the output is not a usage report. */
export function parseOmpUsage(output: string): OmpUsageReport | null {
  const parsed = parseCliJsonObject(output)
  if (!parsed || !Array.isArray(parsed.reports)) return null
  const accounts: OmpUsageAccount[] = []
  let fetchedAt: number | null = null
  for (const entry of parsed.reports) {
    const account = usageAccount(entry)
    if (!account) continue
    accounts.push(account)
    const accountFetchedAt = finiteNumber(asRecord(entry)?.fetchedAt)
    if (accountFetchedAt !== null && (fetchedAt === null || accountFetchedAt < fetchedAt)) fetchedAt = accountFetchedAt
  }
  return { accounts, capacity: usageCapacity(parsed.capacity), fetchedAt }
}

function usageAccount(value: unknown): OmpUsageAccount | null {
  const report = asRecord(value)
  const provider = nonEmptyString(report?.provider)
  if (!report || !provider) return null
  const metadata = asRecord(report.metadata)
  return {
    provider,
    account: nonEmptyString(metadata?.email) ?? nonEmptyString(metadata?.accountId),
    org: nonEmptyString(metadata?.orgName),
    limits: Array.isArray(report.limits)
      ? report.limits.map(usageLimit).filter((limit) => limit !== null)
      : [],
    resets: usageResets(report.resetCredits),
  }
}

function usageLimit(value: unknown): OmpUsageLimit | null {
  const limit = asRecord(value)
  const id = nonEmptyString(limit?.id)
  if (!limit || !id) return null
  const status = STATUSES.find((s) => s === limit.status) ?? 'unknown'
  return {
    id,
    label: nonEmptyString(limit.label) ?? id,
    usedFraction: usedFraction(asRecord(limit.amount)),
    resetsAt: finiteNumber(asRecord(limit.window)?.resetsAt),
    status,
  }
}

function usedFraction(amount: Record<string, unknown> | null): number | null {
  if (!amount) return null
  const fraction = finiteNumber(amount.usedFraction)
  if (fraction !== null) return fraction
  const used = finiteNumber(amount.used)
  const max = finiteNumber(amount.limit)
  if (used !== null && max !== null && max > 0) return used / max
  if (amount.unit === 'percent' && used !== null) return used / 100
  const remaining = finiteNumber(amount.remainingFraction)
  return remaining !== null ? Math.max(0, 1 - remaining) : null
}

function usageResets(value: unknown): OmpUsageResets | null {
  const credits = asRecord(value)
  const available = finiteNumber(credits?.availableCount)
  if (!credits || available === null) return null
  let soonestExpiresAt: number | null = null
  for (const entry of Array.isArray(credits.credits) ? credits.credits : []) {
    const credit = asRecord(entry)
    if (!credit || credit.remainingCount === 0) continue
    const expiresAt = typeof credit.expiresAt === 'string' ? Date.parse(credit.expiresAt) : NaN
    if (Number.isFinite(expiresAt) && (soonestExpiresAt === null || expiresAt < soonestExpiresAt)) {
      soonestExpiresAt = expiresAt
    }
  }
  return { available, usable: finiteNumber(credits.redeemableCount) ?? 0, soonestExpiresAt }
}

function usageCapacity(value: unknown): OmpUsageCapacity[] {
  const byProvider = asRecord(value)
  if (!byProvider) return []
  const capacity: OmpUsageCapacity[] = []
  for (const [provider, rows] of Object.entries(byProvider)) {
    if (!Array.isArray(rows)) continue
    for (const entry of rows) {
      const row = asRecord(entry)
      const window = nonEmptyString(row?.window)
      const accounts = finiteNumber(row?.accounts)
      const usedAccounts = finiteNumber(row?.usedAccounts)
      if (!window || accounts === null || usedAccounts === null) continue
      capacity.push({ provider, window, meter: nonEmptyString(row?.meter), accounts, usedAccounts })
    }
  }
  return capacity
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
