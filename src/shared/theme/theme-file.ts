import { SEED_NAMES, TOKEN_NAMES, type SeedName, type TokenName } from './tokens'

export const THEME_SCHEMA_V1 = 'pi-theme/v1'
export const MAX_THEME_NAME_LENGTH = 64
export const MAX_THEME_AUTHOR_LENGTH = 64
export const MAX_THEME_DESCRIPTION_LENGTH = 280
export const MAX_THEME_FILE_BYTES = 262144

export const SYNTAX_KEYS = [
  'keyword', 'string', 'comment', 'function', 'type', 'number', 'operator',
  'property', 'tag', 'variable', 'constant', 'heading', 'link', 'list',
  'quote', 'meta', 'mark', 'invalid',
  'active-line-bg', 'selection-bg', 'selection-match-bg',
] as const
export type SyntaxKey = (typeof SYNTAX_KEYS)[number]

export interface ThemeFile {
  $schema: typeof THEME_SCHEMA_V1
  name: string
  kind: 'dark' | 'light'
  // Optional authorship metadata, shown by the community gallery and kept
  // through export/import. Plain display strings — never interpreted.
  author?: string
  description?: string
  seeds: Record<SeedName, string>
  overrides?: Partial<Record<TokenName, string>>
  syntax?: Partial<Record<SyntaxKey, string>>
}

export class ThemeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThemeValidationError'
  }
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_COLOR = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+|1\.0+)\s*)?\)$/

function isColorValue(value: unknown): value is string {
  return typeof value === 'string' &&
    (value === 'transparent' || HEX_COLOR.test(value) || RGB_COLOR.test(value))
}

function requireColorMap(
  data: unknown, allowedKeys: readonly string[], label: string, requireAll: boolean,
): Record<string, string> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ThemeValidationError(`${label} must be an object`)
  }
  const record = data as Record<string, unknown>
  const validated: Record<string, string> = {}
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new ThemeValidationError(`${label} has unknown key "${key}"`)
    }
    const value = record[key]
    if (!isColorValue(value)) {
      throw new ThemeValidationError(`${label}.${key} is not a valid color`)
    }
    validated[key] = value
  }
  if (requireAll) {
    for (const key of allowedKeys) {
      if (!(key in record)) throw new ThemeValidationError(`${label} is missing "${key}"`)
    }
  }
  return validated
}

export function validateThemeFile(data: unknown): ThemeFile {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ThemeValidationError('theme must be a JSON object')
  }
  const raw = data as Record<string, unknown>
  if (raw.$schema !== THEME_SCHEMA_V1) {
    throw new ThemeValidationError(`unsupported $schema (expected ${THEME_SCHEMA_V1})`)
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 ||
      raw.name.length > MAX_THEME_NAME_LENGTH) {
    throw new ThemeValidationError(
      `name must be a non-empty string of at most ${MAX_THEME_NAME_LENGTH} characters`,
    )
  }
  if (raw.kind !== 'dark' && raw.kind !== 'light') {
    throw new ThemeValidationError('kind must be "dark" or "light"')
  }
  const author = validateOptionalText(raw.author, 'author', MAX_THEME_AUTHOR_LENGTH)
  const description = validateOptionalText(raw.description, 'description', MAX_THEME_DESCRIPTION_LENGTH)
  const seeds = requireColorMap(raw.seeds, SEED_NAMES, 'seeds', true)
  const overrides = raw.overrides === undefined
    ? undefined
    : requireColorMap(raw.overrides, TOKEN_NAMES, 'overrides', false)
  const syntax = raw.syntax === undefined
    ? undefined
    : requireColorMap(raw.syntax, SYNTAX_KEYS, 'syntax', false)
  return {
    $schema: THEME_SCHEMA_V1,
    name: raw.name.trim(),
    kind: raw.kind,
    ...(author !== undefined ? { author } : {}),
    ...(description !== undefined ? { description } : {}),
    seeds: seeds as ThemeFile['seeds'],
    ...(overrides ? { overrides: overrides as ThemeFile['overrides'] } : {}),
    ...(syntax ? { syntax: syntax as ThemeFile['syntax'] } : {}),
  }
}

// Optional display-text fields: absent is fine; if present they must be
// non-empty strings within the given cap (empty means "omit it instead").
function validateOptionalText(
  value: unknown, label: string, maxLength: number,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new ThemeValidationError(
      `${label} must be a non-empty string of at most ${maxLength} characters`,
    )
  }
  return value.trim()
}

export function themeIdFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
