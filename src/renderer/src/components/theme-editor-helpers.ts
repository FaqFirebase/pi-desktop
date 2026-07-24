// Pure helpers for the theme editor. No DOM imports, no side effects — kept
// in a .ts file (not .tsx) so `find src -name '*.test.ts'` can discover the
// paired test; a .tsx test file would never run in CI.
import type { SeedName, TokenName } from '../../../shared/theme/tokens'
import type { SyntaxKey, ThemeFile } from '../../../shared/theme/theme-file'

export function forkTheme(base: ThemeFile, newName: string): ThemeFile {
  return { ...structuredClone(base), name: newName }
}

export function withSeed(theme: ThemeFile, seed: SeedName, value: string): ThemeFile {
  return { ...theme, seeds: { ...theme.seeds, [seed]: value } }
}

export function withOverride(
  theme: ThemeFile, token: TokenName, value: string | null,
): ThemeFile {
  const overrides = { ...theme.overrides }
  if (value === null) delete overrides[token]
  else overrides[token] = value
  return Object.keys(overrides).length > 0
    ? { ...theme, overrides }
    : (({ overrides: _dropped, ...rest }) => rest)(theme)
}

export function withSyntax(
  theme: ThemeFile, key: SyntaxKey, value: string | null,
): ThemeFile {
  const syntax = { ...theme.syntax }
  if (value === null) delete syntax[key]
  else syntax[key] = value
  return Object.keys(syntax).length > 0
    ? { ...theme, syntax }
    : (({ syntax: _dropped, ...rest }) => rest)(theme)
}
