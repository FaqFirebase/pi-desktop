import en from '../../../resources/locales/en/translation.json'
import ru from '../../../resources/locales/ru/translation.json'
import uk from '../../../resources/locales/uk/translation.json'
import zhHans from '../../../resources/locales/zh-Hans/translation.json'

/**
 * Every bundled language. To add a language, import its
 * resources/locales/<code>/translation.json here and add one entry.
 */
export const LANGUAGE_RESOURCES = {
  en: { translation: en },
  ru: { translation: ru },
  uk: { translation: uk },
  'zh-Hans': { translation: zhHans },
} as const

export const BUNDLED_LANGUAGES: string[] = Object.keys(LANGUAGE_RESOURCES)
