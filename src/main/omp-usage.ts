import type {
  OmpUsageAccount,
  OmpUsageCapacity,
  OmpUsageDisabledAccount,
  OmpUsageLimit,
  OmpUsageProvider,
  OmpUsageReport,
  OmpUsageResets,
  OmpUsageResult,
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
 * One report is one account; it may carry `notes` about its provider (for
 * example that the provider has no quota API). `accountsWithoutUsage` lists
 * signed-in accounts the provider gives no usage data for, and
 * `disabledCredentials` the logins OMP disabled, which need a new sign-in.
 * `omp usage` groups all of it by provider; so does the parsed report.
 *
 * A report's `limits[].amount` may carry any of `usedFraction`, `used`/`limit`,
 * a percent-unit `used`, or `remainingFraction`; the used fraction is resolved
 * in that order, as OMP's own views do.
 */
export const OMP_USAGE_ARGS = ['usage', '--json']

/** Drops OMP's cached usage reports, so the next read asks every provider again. */
export const OMP_USAGE_INVALIDATE_ARGS = ['usage', 'invalidate']

const STATUSES: readonly OmpUsageStatus[] = ['ok', 'warning', 'exhausted', 'unknown']

/** The usage report, or null when the output is not a usage report. */
export function parseOmpUsage(output: string): OmpUsageReport | null {
  const parsed = parseCliJsonObject(output)
  if (!parsed || !Array.isArray(parsed.reports)) return null

  const groups = new Map<string, OmpUsageProvider>()
  const providerGroup = (provider: string): OmpUsageProvider => {
    let group = groups.get(provider)
    if (!group) {
      group = { provider, notes: [], accounts: [], accountsWithoutUsage: 0, disabled: [], capacity: [] }
      groups.set(provider, group)
    }
    return group
  }

  let fetchedAt: number | null = null
  for (const entry of parsed.reports) {
    const report = asRecord(entry)
    const provider = nonEmptyString(report?.provider)
    if (!report || !provider) continue
    const group = providerGroup(provider)
    group.accounts.push(usageAccount(report))
    for (const note of nonEmptyStrings(report.notes)) {
      if (!group.notes.includes(note)) group.notes.push(note)
    }
    const accountFetchedAt = finiteNumber(report.fetchedAt)
    if (accountFetchedAt !== null && (fetchedAt === null || accountFetchedAt < fetchedAt)) fetchedAt = accountFetchedAt
  }
  for (const entry of records(parsed.accountsWithoutUsage)) {
    const provider = nonEmptyString(entry.provider)
    if (provider) providerGroup(provider).accountsWithoutUsage += 1
  }
  for (const entry of records(parsed.disabledCredentials)) {
    const provider = nonEmptyString(entry.provider)
    if (provider) providerGroup(provider).disabled.push(disabledAccount(entry))
  }
  for (const [provider, rows] of Object.entries(asRecord(parsed.capacity) ?? {})) {
    const capacity = usageCapacity(rows)
    if (capacity.length > 0) providerGroup(provider).capacity.push(...capacity)
  }

  const providers = [...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider))
  return { providers, fetchedAt }
}

export interface OmpUsageLoaderSteps {
  /** One `omp usage --json` run. */
  read(): Promise<OmpUsageResult>
  /** Drops OMP's cached reports; a failure only leaves the next read cached. */
  invalidate(): Promise<void>
}

/**
 * Runs one usage read at a time. Opening the popover and Refresh share a run.
 * OMP answers from its cache, so a refresh first drops that cache; a refresh
 * asked during a cached read waits for it, then reads again, so Refresh always
 * shows new data.
 */
export function createOmpUsageLoader(steps: OmpUsageLoaderSteps): (refresh: boolean) => Promise<OmpUsageResult> {
  let inFlight: { refresh: boolean; result: Promise<OmpUsageResult> } | null = null
  return (refresh) => {
    if (inFlight && (inFlight.refresh || !refresh)) return inFlight.result
    const previous = inFlight?.result
    const result = (async () => {
      await previous?.then(ignore, ignore)
      if (refresh) await steps.invalidate()
      return steps.read()
    })()
    const run = { refresh, result }
    inFlight = run
    const clear = (): void => {
      if (inFlight === run) inFlight = null
    }
    result.then(clear, clear)
    return result
  }
}

function ignore(): void {}

function usageAccount(report: Record<string, unknown>): OmpUsageAccount {
  return {
    ...accountIdentity(asRecord(report.metadata)),
    limits: Array.isArray(report.limits)
      ? report.limits.map(usageLimit).filter((limit) => limit !== null)
      : [],
    resets: usageResets(report.resetCredits),
  }
}

function disabledAccount(credential: Record<string, unknown>): OmpUsageDisabledAccount {
  return {
    ...accountIdentity(credential),
    disabledAt: finiteNumber(credential.disabledAtMs),
    cause: nonEmptyString(credential.cause),
  }
}

/** Email, else account id, and org name, as OMP names an account. */
function accountIdentity(source: Record<string, unknown> | null): { account: string | null; org: string | null } {
  return {
    account: nonEmptyString(source?.email) ?? nonEmptyString(source?.accountId),
    org: nonEmptyString(source?.orgName),
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
  for (const credit of records(credits.credits)) {
    if (credit.remainingCount === 0) continue
    const expiresAt = typeof credit.expiresAt === 'string' ? Date.parse(credit.expiresAt) : NaN
    if (Number.isFinite(expiresAt) && (soonestExpiresAt === null || expiresAt < soonestExpiresAt)) {
      soonestExpiresAt = expiresAt
    }
  }
  return { available, usable: finiteNumber(credits.redeemableCount) ?? 0, soonestExpiresAt }
}

function usageCapacity(rows: unknown): OmpUsageCapacity[] {
  const capacity: OmpUsageCapacity[] = []
  for (const row of records(rows)) {
    const window = nonEmptyString(row.window)
    const accounts = finiteNumber(row.accounts)
    const usedAccounts = finiteNumber(row.usedAccounts)
    if (!window || accounts === null || usedAccounts === null) continue
    capacity.push({ window, meter: nonEmptyString(row.meter), accounts, usedAccounts })
  }
  return capacity
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The object entries of `value` when it is an array; anything else is skipped. */
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((entry) => entry !== null) : []
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nonEmptyStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(nonEmptyString).filter((entry) => entry !== null) : []
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
