import {
  DERIVED_TOKENS, SEED_TO_TOKEN, TOKEN_NAMES, cssVarForToken,
  type SeedName,
} from './tokens'
import { SYNTAX_KEYS, type ThemeFile } from './theme-file'
import { DEFAULT_SYNTAX } from './syntax-defaults'

const TOKEN_FOR_SEED = Object.fromEntries(
  Object.entries(SEED_TO_TOKEN).map(([seed, token]) => [token, seed]),
) as Record<string, SeedName>

export function resolveThemeVars(file: ThemeFile): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const token of TOKEN_NAMES) {
    const override = file.overrides?.[token]
    if (override !== undefined) {
      vars[cssVarForToken(token)] = override
    } else if (token in TOKEN_FOR_SEED) {
      vars[cssVarForToken(token)] = file.seeds[TOKEN_FOR_SEED[token]]
    } else {
      vars[cssVarForToken(token)] = DERIVED_TOKENS[token]
    }
  }
  const syntaxDefaults = DEFAULT_SYNTAX[file.kind]
  for (const key of SYNTAX_KEYS) {
    vars[`--cm-${key}`] = file.syntax?.[key] ?? syntaxDefaults[key]
  }
  return vars
}
