// scripts/check-semantic-colors.mjs
// Fails when renderer code bypasses the semantic token system, either by using
// raw Tailwind color utilities or by reading a legacy CSS variable that no
// longer exists. See docs/superpowers/specs/2026-07-16-theme-system-design.md.
/* global console, process */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/renderer/src'
const SOURCE_FILE = /\.(ts|tsx)$/

const COLOR_FAMILIES = 'neutral|blue|red|emerald|green|yellow|purple|orange|pink|indigo|violet|cyan|teal|lime|amber|rose|sky|fuchsia|slate|gray|zinc|stone'
const COLOR_PREFIXES = 'bg|text|border|accent|ring|from|to|via|fill|stroke|divide|outline|shadow'

// A line may opt out with a trailing `theme-exempt` comment. This exists for
// colors that are categorical data rather than theming — a legend palette whose
// entries must be mutually distinct has no semantic token, and forcing one on it
// both destroys the distinction and asserts a meaning the data lacks.
const EXEMPT_MARKER = 'theme-exempt'

const CHECKS = [
  {
    label: 'Raw Tailwind color utilities found; use semantic tokens instead',
    pattern: new RegExp(`(?:${COLOR_PREFIXES})-(?:${COLOR_FAMILIES})-[0-9]+`),
  },
  {
    label: 'Legacy theme CSS variables found; these no longer exist and resolve to nothing',
    pattern: /--(?:color-bg-|color-text-|color-app-|color-border-focus|pi-highlight)/,
  },
]

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sourceFiles(path, found)
    else if (SOURCE_FILE.test(path)) found.push(path)
  }
  return found
}

const files = sourceFiles(ROOT)
let failed = false
for (const { label, pattern } of CHECKS) {
  const offending = []
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (pattern.test(line) && !line.includes(EXEMPT_MARKER)) {
        offending.push(`${file}:${index + 1}: ${line.trim()}`)
      }
    })
  }
  if (offending.length === 0) continue
  console.error(`${label}:`)
  console.error(offending.join('\n'))
  failed = true
}
process.exit(failed ? 1 : 0)
