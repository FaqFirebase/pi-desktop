export const SEED_NAMES = [
  'app', 'surface', 'text', 'accent', 'success', 'warning', 'error',
] as const
export type SeedName = (typeof SEED_NAMES)[number]

export const TOKEN_NAMES = [
  // surfaces
  'app', 'surface', 'surface-hover', 'card', 'elevated', 'highlight', 'highlight-strong',
  // text
  'primary', 'secondary', 'muted', 'dim', 'faint', 'ghost', 'inverse',
  // border
  'border', 'border-strong', 'border-strong-hover', 'focus',
  // accent
  'accent', 'accent-hover', 'accent-fg', 'accent-bg',
  // status
  'success', 'success-bg', 'warning', 'warning-bg', 'error', 'error-hover', 'error-bg',
  'info', 'info-bg', 'special', 'special-bg',
  // misc
  'chat-column', 'chat-column-border', 'scrollbar', 'scrollbar-hover',
  'md-code', 'md-pre-bg',
] as const
export type TokenName = (typeof TOKEN_NAMES)[number]

export const SEED_TO_TOKEN: Record<SeedName, TokenName> = {
  app: 'app',
  surface: 'surface',
  text: 'primary',
  accent: 'accent',
  success: 'success',
  warning: 'warning',
  error: 'error',
}

export function cssVarForToken(name: string): string {
  return `--color-${name}`
}

/* Derivation templates. Each non-seed token resolves to a CSS value built
   from other token variables, so a theme that sets only the 7 seeds is
   complete. Mix percentages were tuned against the base dark palette. */
const MIX = (a: string, b: string, pct: number): string =>
  `color-mix(in oklab, var(--color-${a}), var(--color-${b}) ${pct}%)`
const WASH = (name: string, pct: number): string =>
  `color-mix(in oklab, var(--color-${name}), transparent ${pct}%)`

export const DERIVED_TOKENS: Record<string, string> = {
  'surface-hover': MIX('surface', 'primary', 8),
  card: MIX('surface', 'primary', 6),
  elevated: MIX('surface', 'primary', 14),
  highlight: 'var(--color-surface)',
  'highlight-strong': 'var(--color-card)',
  secondary: MIX('primary', 'app', 15),
  muted: MIX('primary', 'app', 35),
  dim: MIX('primary', 'app', 52),
  faint: MIX('primary', 'app', 65),
  ghost: MIX('primary', 'app', 73),
  inverse: 'var(--color-app)',
  border: MIX('surface', 'primary', 15),
  'border-strong': MIX('surface', 'primary', 25),
  'border-strong-hover': MIX('surface', 'primary', 35),
  focus: 'var(--color-accent)',
  'accent-hover': MIX('accent', 'primary', 15),
  'accent-fg': MIX('accent', 'primary', 30),
  'accent-bg': WASH('accent', 82),
  'success-bg': WASH('success', 85),
  'warning-bg': WASH('warning', 85),
  'error-hover': MIX('error', 'primary', 15),
  'error-bg': WASH('error', 85),
  info: 'var(--color-accent-fg)',
  'info-bg': WASH('info', 85),
  special: 'var(--color-accent-fg)',
  'special-bg': WASH('special', 85),
  'chat-column': 'var(--color-app)',
  'chat-column-border': 'var(--color-border)',
  scrollbar: 'var(--color-border)',
  'scrollbar-hover': 'var(--color-elevated)',
  'md-code': 'var(--color-accent-fg)',
  'md-pre-bg': 'var(--color-surface)',
}
