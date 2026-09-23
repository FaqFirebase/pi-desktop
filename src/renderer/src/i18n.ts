import { availableLanguages, i18n, languageNativeName } from '../../shared/i18n'
import { SOURCE_LANGUAGE, SYSTEM_LANGUAGE } from '../../shared/i18n/languages'
import { resolveLanguage } from '../../shared/i18n/resolve'
import type { I18nEnvironment } from '../../shared/ipc-contracts'

/** Last resolved language, so the first frame is not English (see theme BOOT_THEME_STORAGE_KEY). */
export const BOOT_LANGUAGE_STORAGE_KEY = 'pi-desktop.boot-language'

export interface LanguageOption {
  value: string
  label: string
}

let environment: I18nEnvironment | null = null
let environmentRequest: Promise<I18nEnvironment> | null = null

/** The stored boot language when it is still a known code; English otherwise. */
export function bootLanguageFrom(stored: string | null): string {
  return stored !== null && availableLanguages(true).includes(stored) ? stored : SOURCE_LANGUAGE
}

function readBootLanguage(): string {
  try {
    return bootLanguageFrom(localStorage.getItem(BOOT_LANGUAGE_STORAGE_KEY))
  } catch {
    // Storage blocked: start in English and switch once settings load.
    return SOURCE_LANGUAGE
  }
}

function rememberBootLanguage(language: string): void {
  try {
    localStorage.setItem(BOOT_LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Private-mode or quota failure: the next launch starts in English.
  }
}

function showLanguage(language: string): void {
  if (language !== i18n.language) void i18n.changeLanguage(language)
  document.documentElement.lang = language
}

/** Call once before the first render. */
export function applyBootLanguage(): void {
  showLanguage(readBootLanguage())
}

/** The OS language list and pseudo switch from main, fetched once per window. */
export function loadI18nEnvironment(): Promise<I18nEnvironment> {
  environmentRequest ??= window.piDesktop.i18n.getEnvironment().then(
    (loaded) => {
      environment = loaded
      return loaded
    },
    (error: unknown) => {
      // A failed request must not stick: the next settings load retries it.
      environmentRequest = null
      throw error
    },
  )
  return environmentRequest
}

/** The environment when it has loaded, for synchronous first renders. */
export function loadedI18nEnvironment(): I18nEnvironment | null {
  return environment
}

/** Show the language a setting resolves to, the same way main resolves it. */
export async function applyLanguageSetting(setting: string): Promise<void> {
  const loaded = await loadI18nEnvironment()
  const language = resolveLanguage(setting, loaded.systemLanguages, availableLanguages(loaded.pseudoLanguageEnabled))
  showLanguage(language)
  rememberBootLanguage(language)
}

/** A language's name in the interface language ("Simplified Chinese"), or null when Intl has none. */
function languageNameInInterface(code: string): string | null {
  try {
    return new Intl.DisplayNames([i18n.language], { type: 'language', fallback: 'none' }).of(code) ?? null
  } catch {
    return null
  }
}

/** A language's own name, followed by its name in the interface language when the two differ. */
function languageOptionLabel(code: string): string {
  const nativeName = languageNativeName(code)
  const name = languageNameInInterface(code)
  return name === null || name === nativeName
    ? nativeName
    : i18n.t('settings.language.optionLabel', { nativeName, name })
}

/** "System default (<resolved language>)", then each language in its own name and the interface language. */
export function languagePickerOptions(loaded: I18nEnvironment): LanguageOption[] {
  const available = availableLanguages(loaded.pseudoLanguageEnabled)
  const systemLanguage = resolveLanguage(SYSTEM_LANGUAGE, loaded.systemLanguages, available)
  const languages = available
    .map((code) => ({ value: code, label: languageOptionLabel(code) }))
    .sort((a, b) => a.label.localeCompare(b.label, i18n.language))
  return [
    { value: SYSTEM_LANGUAGE, label: i18n.t('settings.language.system', { language: languageNativeName(systemLanguage) }) },
    ...languages,
  ]
}
