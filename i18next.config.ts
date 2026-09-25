import { readdirSync } from 'node:fs'
import { defineConfig } from 'i18next-cli'

const LOCALES_DIR = 'resources/locales'
const SOURCE_LANGUAGE = 'en'

const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

export default defineConfig({
  locales,
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    ignore: ['**/*.test.ts', '**/*.d.ts'],
    output: `${LOCALES_DIR}/{{language}}/{{namespace}}.json`,
    defaultNS: 'translation',
    primaryLanguage: SOURCE_LANGUAGE,
    removeUnusedKeys: true,
    // Read by resources/permission-prompt-text.ts (inside the Pi process), not by t().
    // Voice keys are looked up dynamically by model id and precision, so the
    // extractor cannot see them statically.
    preservePatterns: [
      'permissions.prompt.*',
      'voice.models.*',
      'settings.voice.precision.*',
    ],
    sort: true,
    indentation: 2,
    // New keys land empty; locales.test.ts fails until the English text is written.
    defaultValue: '',
  },
  lint: {
    // Code samples and commands are not interface text.
    ignoredTags: ['code', 'pre'],
    checkConcatenation: 'error',
    checkInterpolationParams: true,
  },
})
