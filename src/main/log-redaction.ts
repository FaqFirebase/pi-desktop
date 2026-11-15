import type { AppLogEntry } from '../shared/ipc-contracts'

/** Stands in for every secret removed from log text. */
export const REDACTED_TEXT = '[redacted]'
/** Shorter environment values are too likely to match ordinary words. */
export const MIN_SECRET_VALUE_LENGTH = 8

const SECRET_ENV_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i
/** `scheme://user:password@` in a remote URL, as git quotes it in errors. */
const URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi
/** An HTTP authorization value; the scheme word goes with it. */
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
/**
 * `api_key=...`, `"token": "..."`, `password: ...` and similar pairs. The
 * value stops at a backslash too, so the escapes of a JSON-encoded detail
 * (`\n`, `\"`) stay intact.
 */
const SECRET_ASSIGNMENT_PATTERN = /([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"'&,;\\]+)/gi
/** Token formats that announce themselves by prefix. */
const TOKEN_PREFIX_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g

/** Values of secret-named environment variables, longest first, so a longer secret is never left half-redacted by a shorter one it contains. */
export function secretValuesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= MIN_SECRET_VALUE_LENGTH && SECRET_ENV_NAME_PATTERN.test(name)) values.add(value)
  }
  return [...values].sort((a, b) => b.length - a.length)
}

export function redactSecrets(text: string, secretValues: readonly string[]): string {
  let redacted = text
  for (const value of secretValues) redacted = redacted.split(value).join(REDACTED_TEXT)
  return redacted
    .replace(URL_CREDENTIALS_PATTERN, `$1${REDACTED_TEXT}@`)
    .replace(BEARER_PATTERN, REDACTED_TEXT)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1${REDACTED_TEXT}`)
    .replace(TOKEN_PREFIX_PATTERN, REDACTED_TEXT)
}

export function redactLogEntry(entry: AppLogEntry, secretValues: readonly string[]): AppLogEntry {
  const redacted: AppLogEntry = { ...entry, message: redactSecrets(entry.message, secretValues) }
  if (entry.detail !== undefined) redacted.detail = redactSecrets(entry.detail, secretValues)
  return redacted
}
