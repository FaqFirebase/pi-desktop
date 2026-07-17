import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  validateThemeFile, themeIdFromName, MAX_THEME_FILE_BYTES, type ThemeFile,
} from '../shared/theme/theme-file'
import { BUILTIN_THEME_IDS } from '../shared/theme/builtin-ids'

const THEME_FILE_EXT = '.json'
const VALID_THEME_ID = /^[a-z0-9-]+$/

export interface UserThemeList {
  themes: Array<{ id: string; file: ThemeFile }>
  warnings: string[]
}

export async function listUserThemes(dir: string): Promise<UserThemeList> {
  await mkdir(dir, { recursive: true })
  const themes: UserThemeList['themes'] = []
  const warnings: string[] = []
  for (const entry of (await readdir(dir)).filter((f) => f.endsWith(THEME_FILE_EXT)).sort()) {
    const id = entry.slice(0, -THEME_FILE_EXT.length)
    try {
      const file = validateThemeFile(JSON.parse(await readFile(join(dir, entry), 'utf8')))
      themes.push({ id, file })
    } catch (error) {
      warnings.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { themes, warnings }
}

const IDENTITY_SEPARATOR = ' '

function themeIdentity(file: ThemeFile): string {
  return `${file.name}${IDENTITY_SEPARATOR}${file.kind}`
}

// A real theme's identity is always `${name}${IDENTITY_SEPARATOR}${kind}`
// with kind restricted to 'dark' | 'light', so it can never equal this
// sentinel. Seeding the taken-id map with it for every built-in id forces
// the numeric-suffix loop below to run whenever a fresh save's base id
// collides with a built-in, without disturbing the legitimate "resave of an
// existing user theme file" identity-match path (a built-in is never itself
// a file in the user themes directory, so it can never be the thing a
// resave is legitimately updating).
const BUILTIN_IDENTITY_SENTINEL = '\0builtin'

export async function saveUserTheme(dir: string, file: ThemeFile): Promise<{ id: string }> {
  const theme = validateThemeFile(file)
  await mkdir(dir, { recursive: true })
  const base = themeIdFromName(theme.name) || 'theme'
  const { themes } = await listUserThemes(dir)
  const taken = new Map<string, string>(
    BUILTIN_THEME_IDS.map((builtinId) => [builtinId, BUILTIN_IDENTITY_SENTINEL]),
  )
  for (const t of themes) taken.set(t.id, themeIdentity(t.file))
  let id = base
  const identity = themeIdentity(theme)
  for (let n = 2; taken.has(id) && taken.get(id) !== identity; n += 1) id = `${base}-${n}`
  await writeFile(join(dir, `${id}${THEME_FILE_EXT}`), JSON.stringify(theme, null, 2))
  return { id }
}

export async function deleteUserTheme(dir: string, id: string): Promise<void> {
  if (!VALID_THEME_ID.test(id)) throw new Error(`invalid theme id: ${id}`)
  await unlink(join(dir, `${id}${THEME_FILE_EXT}`))
}

// Reads the response body incrementally, aborting as soon as the byte
// count exceeds limitBytes, so an oversized or unbounded response is never
// fully buffered into memory before the size check applies.
async function readCappedText(response: Response, limitBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const decoder = new TextDecoder()
  let text = ''
  let totalBytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > limitBytes) {
      await reader.cancel()
      throw new Error(`theme file too large (limit ${limitBytes} bytes)`)
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return text
}

export async function installThemeFromUrl(
  dir: string, url: string, fetchFn: typeof fetch = fetch,
): Promise<{ id: string; file: ThemeFile }> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('theme URLs must use https')
  const response = await fetchFn(url)
  // fetch follows redirects by default and does not preserve the original
  // scheme: an https URL can 302 to plain http and the request completes
  // over an unencrypted connection. response.url reflects the final,
  // post-redirect location, so it is the only reliable place to re-check
  // the https guarantee before any response data is trusted.
  if (response.url && new URL(response.url).protocol !== 'https:') {
    throw new Error('theme URL redirected away from https')
  }
  if (!response.ok) throw new Error(`theme download failed: ${response.status}`)
  const body = await readCappedText(response, MAX_THEME_FILE_BYTES)
  const file = validateThemeFile(JSON.parse(body))
  const { id } = await saveUserTheme(dir, file)
  return { id, file }
}
