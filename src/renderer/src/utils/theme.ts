import type { AppSettings } from '../../../shared/ipc-contracts'

export const THEME_CLASSES = [
  'dark',
  'light',
  'nord',
  'gruvbox',
  'breeze-dark',
  'breeze-light',
  'breeze-claudius',
] as const

export type ThemeClass = (typeof THEME_CLASSES)[number]

export const LIGHT_THEMES = new Set<string>(['light', 'breeze-light'])

export function applyTheme(theme: AppSettings['theme']): void {
  const html = document.documentElement
  html.classList.remove(...THEME_CLASSES)

  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    html.classList.add(prefersDark ? 'dark' : 'light')
    html.style.colorScheme = prefersDark ? 'dark' : 'light'
  } else if (LIGHT_THEMES.has(theme)) {
    html.classList.add(theme)
    html.style.colorScheme = 'light'
  } else {
    // 'dark' | 'nord' | 'gruvbox' | 'breeze-dark' — all dark-based
    html.classList.add(theme)
    html.style.colorScheme = 'dark'
  }
}

export function isLightTheme(theme: AppSettings['theme'] | null | undefined): boolean {
  if (!theme) return false
  if (theme === 'system') return !window.matchMedia('(prefers-color-scheme: dark)').matches
  return LIGHT_THEMES.has(theme)
}
