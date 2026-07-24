import type { ThemeFile } from '../../../shared/theme/theme-file'
import dark from './dark.json'
import light from './light.json'
import nord from './nord.json'
import gruvbox from './gruvbox.json'
import breezeDark from './breeze-dark.json'
import breezeLight from './breeze-light.json'
import breezeClaudius from './breeze-claudius.json'

export const BUILTIN_THEMES: ReadonlyArray<{ id: string; file: ThemeFile }> = [
  { id: 'dark', file: dark as ThemeFile },
  { id: 'light', file: light as ThemeFile },
  { id: 'nord', file: nord as ThemeFile },
  { id: 'gruvbox', file: gruvbox as ThemeFile },
  { id: 'breeze-dark', file: breezeDark as ThemeFile },
  { id: 'breeze-light', file: breezeLight as ThemeFile },
  { id: 'breeze-claudius', file: breezeClaudius as ThemeFile },
]

export const BUILTIN_THEME_IDS: readonly string[] = BUILTIN_THEMES.map((t) => t.id)
