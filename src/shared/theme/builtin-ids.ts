// The 7 built-in theme ids, frozen since the token system's first task.
// These are also persisted in users' settings.json, so this list must never
// change without a migration. Both the renderer's theme registry
// (src/renderer/src/themes/index.ts) and the main process's user-theme store
// (src/main/theme-store.ts) must agree on this exact set — the renderer is
// the source of the actual theme files, but the main process cannot import
// those (separate process/bundle), so this module is the single shared
// source of truth for just the id strings.
export const BUILTIN_THEME_IDS = [
  'dark', 'light', 'nord', 'gruvbox', 'breeze-dark', 'breeze-light', 'breeze-claudius',
] as const
