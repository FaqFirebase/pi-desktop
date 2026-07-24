import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isIPv6 } from 'node:net'
import {
  validateThemeFile, themeIdFromName, MAX_THEME_FILE_BYTES,
  MAX_THEME_AUTHOR_LENGTH, MAX_THEME_DESCRIPTION_LENGTH, type ThemeFile,
} from '../shared/theme/theme-file'
import { BUILTIN_THEME_IDS } from '../shared/theme/builtin-ids'
import type { GalleryTheme } from '../shared/ipc-contracts'

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
      // Theme files are untrusted input (imported from disk or installed
      // from arbitrary URLs). saveUserTheme refuses to *create* a file whose
      // id collides with a built-in, but a colliding file can still land in
      // this directory by other means (predates that fix, external write,
      // future bug). If loaded, it would silently replace the real built-in
      // in the renderer's theme registry (Map.set) on every launch, so any
      // such file must be excluded here regardless of how it got there.
      if ((BUILTIN_THEME_IDS as readonly string[]).includes(id)) {
        warnings.push(`${entry}: id '${id}' collides with a built-in theme and was ignored`)
        continue
      }
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

const SUFFIX_START = 2

// Windows treats these as device names even with a file extension, so a slug
// matching one cannot be written as "<id>.json" on Windows (fs writes fail or
// hit the device). Blocking them in the id search makes the suffix loop yield
// a safe id (e.g. "con" -> "con-2", which is not reserved), keeping user-theme
// files portable across macOS, Windows, and Linux. Appending "-N" always
// de-reserves, so this can never loop forever.
const WINDOWS_RESERVED_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

// Finds the first id starting at `base` that is neither reserved nor rejected
// by `isBlocked`, appending `-2`, `-3`, ... until one is free. Shared by both
// save paths below; only the caller's definition of "blocked" differs.
function nextAvailableId(base: string, isBlocked: (id: string) => boolean): string {
  let id = base
  for (let n = SUFFIX_START; WINDOWS_RESERVED_ID.test(id) || isBlocked(id); n += 1) id = `${base}-${n}`
  return id
}

// `existingId` is set only when the theme editor is re-saving a theme it is
// already editing (isUserTheme === true). It must NOT be derived from
// name+kind identity like the fresh-save path below: two different user
// themes can share a name+kind (e.g. after one of them gets renamed to
// match the other), and identity-matching on the *new* name would let the
// save silently overwrite the OTHER theme's file while the editor's
// rename-cleanup then deletes the theme actually being edited — destroying
// both. Restricting overwrite to the exact id under edit closes that path:
// any collision with any other id, built-in or user, is suffixed instead.
export async function saveUserTheme(
  dir: string, file: ThemeFile, existingId?: string,
): Promise<{ id: string }> {
  const theme = validateThemeFile(file)
  if (existingId !== undefined) {
    if (!VALID_THEME_ID.test(existingId)) throw new Error(`invalid theme id: ${existingId}`)
    if ((BUILTIN_THEME_IDS as readonly string[]).includes(existingId)) {
      throw new Error(`cannot overwrite built-in theme id: ${existingId}`)
    }
  }
  await mkdir(dir, { recursive: true })
  const base = themeIdFromName(theme.name) || 'theme'
  const { themes } = await listUserThemes(dir)

  let id: string
  if (existingId !== undefined) {
    const takenIds = new Set<string>(BUILTIN_THEME_IDS)
    for (const t of themes) takenIds.add(t.id)
    id = nextAvailableId(base, (candidate) => takenIds.has(candidate) && candidate !== existingId)
  } else {
    // Fresh create, file import, or URL install: dedupe by identity
    // (name+kind), so re-importing/re-installing the same theme keeps
    // updating the same file instead of piling up numbered duplicates. This
    // is intentionally different from the existingId path above — here
    // there is no "theme under edit" to protect, so identity is a safe and
    // desirable match key.
    const taken = new Map<string, string>(
      BUILTIN_THEME_IDS.map((builtinId) => [builtinId, BUILTIN_IDENTITY_SENTINEL]),
    )
    for (const t of themes) taken.set(t.id, themeIdentity(t.file))
    const identity = themeIdentity(theme)
    id = nextAvailableId(base, (candidate) => taken.has(candidate) && taken.get(candidate) !== identity)
  }

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

// --- SSRF guard for installThemeFromUrl -----------------------------------
//
// installThemeFromUrl fetches an arbitrary attacker-influenced URL from the
// Electron MAIN process, outside the renderer's CSP connect-src. Without
// host classification this is a blind SSRF primitive: pointing it (or a
// redirect target) at a private/loopback/link-local/cloud-metadata host
// makes the main process issue a real GET against internal infrastructure
// with no per-URL consent. Today the URL is user-typed; a planned in-app
// theme gallery would install from URLs listed in a fetched index.json, at
// which point a single poisoned gallery entry could target an internal
// host with no user interaction at all. This guard, plus manual redirect
// validation below, is the mitigation for both.

const THEME_FETCH_TIMEOUT_MS = 10_000
const MAX_THEME_REDIRECTS = 5
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])

// CGNAT range 100.64.0.0/10: octet 2 spans 64-127.
const CGNAT_SECOND_OCTET_MIN = 64
const CGNAT_SECOND_OCTET_MAX = 127
// 172.16.0.0/12: octet 2 spans 16-31.
const RANGE_172_SECOND_OCTET_MIN = 16
const RANGE_172_SECOND_OCTET_MAX = 31
const IPV4_OCTET_MAX = 255

type IPv4Octets = [number, number, number, number]

function parseIPv4(hostname: string): IPv4Octets | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > IPV4_OCTET_MAX) return null
    octets.push(value)
  }
  return octets as IPv4Octets
}

// Ranges per RFC 1918 (private), RFC 6598 (CGNAT), RFC 5735/3927 (loopback,
// link-local incl. 169.254.169.254 cloud metadata), and RFC 1122 (0.0.0.0/8).
function isBlockedIPv4([a, b]: IPv4Octets): boolean {
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // 10.0.0.0/8
  if (a === 100 && b >= CGNAT_SECOND_OCTET_MIN && b <= CGNAT_SECOND_OCTET_MAX) return true // 100.64.0.0/10
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local, incl. cloud metadata
  if (a === 172 && b >= RANGE_172_SECOND_OCTET_MIN && b <= RANGE_172_SECOND_OCTET_MAX) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  return false
}

const IPV4_MAPPED_PREFIX = '::ffff:'
// fc00::/7 (ULA): the first hextet's top 7 bits are 1111110, i.e. the
// hextet's leading byte is 0xfc or 0xfd.
const ULA_HEXTET_PREFIXES = ['fc', 'fd']
// fe80::/10 (link-local): the first hextet ranges 0xfe80-0xfebf.
const LINK_LOCAL_HEXTET_MIN = 0xfe80
const LINK_LOCAL_HEXTET_MAX = 0xfebf

// Extracts an embedded IPv4 address from an IPv4-mapped IPv6 literal, e.g.
// "::ffff:10.0.0.1" (dotted) or "::ffff:0a00:0001" (hex groups). Returns
// null if `lowerHostname` has no such form.
function extractIPv4MappedAddress(lowerHostname: string): string | null {
  const idx = lowerHostname.lastIndexOf(IPV4_MAPPED_PREFIX)
  if (idx === -1) return null
  const tail = lowerHostname.slice(idx + IPV4_MAPPED_PREFIX.length)
  if (parseIPv4(tail)) return tail
  const hexGroups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
  if (!hexGroups) return null
  const high = Number.parseInt(hexGroups[1], 16)
  const low = Number.parseInt(hexGroups[2], 16)
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}

// hostname is a raw IPv6 literal (brackets already stripped by URL parsing,
// e.g. "::1", "fc00::1"). Full IPv6 canonicalization is out of scope; this
// pragmatically covers the loopback/unspecified exact forms, the ULA and
// link-local prefixes via the first hextet, and IPv4-mapped addresses by
// delegating to the IPv4 rules above. Any other IPv6 form (e.g. a
// non-mapped global unicast address, or unusual zero-compression shapes
// this parsing does not normalize) is NOT further inspected and is allowed
// through if it isn't caught by one of these specific checks.
function isBlockedIPv6(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === '::1' || lower === '::') return true // loopback / unspecified

  const mapped = extractIPv4MappedAddress(lower)
  if (mapped) {
    const octets = parseIPv4(mapped)
    return octets !== null && isBlockedIPv4(octets)
  }

  const colonIndex = lower.indexOf(':')
  const firstHextet = (colonIndex <= 0 ? '' : lower.slice(0, colonIndex)).padStart(4, '0')
  if (ULA_HEXTET_PREFIXES.some((prefix) => firstHextet.startsWith(prefix))) return true
  const hextetValue = Number.parseInt(firstHextet, 16)
  return !Number.isNaN(hextetValue)
    && hextetValue >= LINK_LOCAL_HEXTET_MIN && hextetValue <= LINK_LOCAL_HEXTET_MAX
}

// Rejects any URL that would send the main process's fetch at an internal
// or well-known-local host. Must be called on the initial URL AND on every
// redirect hop's target before that hop is fetched (see installThemeFromUrl)
// — validating only the first URL is not sufficient because fetch resolves
// and connects to whatever the Location header says next.
function assertSafeThemeUrl(parsed: URL): void {
  if (parsed.protocol !== 'https:') {
    throw new Error(`theme URLs must use https, got ${parsed.protocol}`)
  }
  // WHATWG URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]"), unlike
  // the "brackets already stripped" shape node:net's isIP()/isIPv6() and our
  // own IPv6 parsing below expect, so unwrap them once up front.
  const rawHostname = parsed.hostname.toLowerCase()
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(`theme URL host "${hostname}" is blocked (local/loopback hostname)`)
  }
  const ipv4 = parseIPv4(hostname)
  if (ipv4 && isBlockedIPv4(ipv4)) {
    throw new Error(`theme URL host "${hostname}" is blocked (private/reserved IPv4 address)`)
  }
  if (isIPv6(hostname) && isBlockedIPv6(hostname)) {
    throw new Error(`theme URL host "${hostname}" is blocked (private/reserved IPv6 address)`)
  }
  // Residual limitation, deliberately not solved here: a *hostname* that is
  // not an IP literal (e.g. an attacker-registered "public" domain) can
  // still resolve via DNS to a private/loopback address at request time
  // (DNS rebinding). String classification of the URL cannot see what
  // address DNS will hand back, and Node's fetch resolves + connects
  // atomically with no hook to re-validate the resolved address first.
  // Closing that gap needs a custom dispatcher that pins and validates the
  // resolved IP per connection (and re-validates on every redirect), which
  // is out of scope for this fix. This guard covers IP-literal SSRF and
  // well-known local hostnames only, not DNS-rebinding SSRF.
}

// Fetches `url` following redirects manually, re-running the SSRF guard on
// every hop's target before it is fetched, with a per-request timeout and a
// redirect cap. Returns the first non-redirect Response (the caller checks
// `.ok` and reads the body under a size cap). Shared by installThemeFromUrl
// and fetchGalleryThemes so both get identical redirect/SSRF protection.
async function guardedFetch(url: string, fetchFn: typeof fetch): Promise<Response> {
  let current = new URL(url)
  assertSafeThemeUrl(current)

  let response: Response
  let redirects = 0
  for (;;) {
    // Each hop's target depends on the previous hop's response, so this
    // await must stay sequential rather than being parallelized.
    response = await fetchFn(current.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(THEME_FETCH_TIMEOUT_MS),
    })
    if (!REDIRECT_STATUS_CODES.has(response.status)) break
    redirects += 1
    if (redirects > MAX_THEME_REDIRECTS) {
      throw new Error(`theme URL exceeded ${MAX_THEME_REDIRECTS} redirects`)
    }
    const location = response.headers.get('location')
    if (!location) throw new Error(`theme URL redirect (${response.status}) had no location header`)
    // Resolve relative to the current hop, then re-validate before the next
    // hop is fetched: this is what stops a public URL from bouncing the
    // GET onto an internal host via a redirect the guard never saw.
    current = new URL(location, current)
    assertSafeThemeUrl(current)
  }
  return response
}

export async function installThemeFromUrl(
  dir: string, url: string, fetchFn: typeof fetch = fetch,
): Promise<{ id: string; file: ThemeFile }> {
  const response = await guardedFetch(url, fetchFn)
  if (!response.ok) throw new Error(`theme download failed: ${response.status}`)
  const body = await readCappedText(response, MAX_THEME_FILE_BYTES)
  const file = validateThemeFile(JSON.parse(body))
  const { id } = await saveUserTheme(dir, file)
  return { id, file }
}

// --- Community gallery ------------------------------------------------------
//
// The gallery is a first-party GitHub repo whose index.json lists themes as
// { name, kind, file } where `file` is a repo-relative path. The install URL
// is built here as GALLERY_RAW_BASE + '/' + file, NOT taken from the entry as
// a full URL: this pins every gallery install to the gallery's own raw host
// and path, so even a compromised index can only reference files inside the
// (PR-reviewed, CI-validated) gallery repo — it can never point an install at
// an arbitrary or internal host. Each `file` is still validated against a
// strict pattern to block path traversal, and installs go through
// installThemeFromUrl, which re-validates content and re-runs the SSRF guard.

const GALLERY_RAW_BASE =
  'https://raw.githubusercontent.com/FaqFirebase/pi-desktop-themes/main'
const GALLERY_INDEX_URL = `${GALLERY_RAW_BASE}/index.json`
// The index embeds each theme's full content for gallery preview cards, so
// its cap is a multiple of the single-file cap rather than equal to it.
const MAX_GALLERY_INDEX_BYTES = 1048576
// Accepts both gallery layouts: the current per-theme folder form
// (themes/<slug>/theme.json) and the original flat form (themes/<slug>.json),
// so the app keeps working across the repo's layout migration. The character
// class has no '.', '/' or '\', so neither form can smuggle traversal or an
// absolute/other-host URL into the pinned base join.
const GALLERY_FILE_PATH = /^themes\/[a-z0-9-]+(?:\/theme)?\.json$/
// An optional author screenshot lives beside the theme file. Only these exact
// shapes are ever fetched, so a poisoned index can at most reference an image
// already committed under themes/<slug>/ in the pinned repo.
const GALLERY_SCREENSHOT_PATH = /^themes\/[a-z0-9-]+\/screenshot\.(?:png|jpe?g|webp)$/
const MAX_GALLERY_IMAGE_BYTES = 2097152
// Content types allowed for a fetched screenshot. An allowlist, not an
// `image/` prefix: it keeps out image/svg+xml (SVG can carry script) and any
// other exotic image type even if the pinned path check were ever loosened.
const GALLERY_IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp']

// Untrusted display string from the gallery index: usable only when it is a
// non-empty string within the cap; anything else is treated as absent.
function displayText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined
  return trimmed
}

export async function fetchGalleryThemes(fetchFn: typeof fetch = fetch): Promise<GalleryTheme[]> {
  const response = await guardedFetch(GALLERY_INDEX_URL, fetchFn)
  if (!response.ok) throw new Error(`gallery index download failed: ${response.status}`)
  const body = await readCappedText(response, MAX_GALLERY_INDEX_BYTES)
  const parsed: unknown = JSON.parse(body)
  if (!Array.isArray(parsed)) throw new Error('gallery index is not a JSON array')

  const themes: GalleryTheme[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const { name, kind, file, author, description, theme } = entry as Record<string, unknown>
    if (typeof name !== 'string' || name.trim().length === 0) continue
    if (kind !== 'dark' && kind !== 'light') continue
    if (typeof file !== 'string' || !GALLERY_FILE_PATH.test(file)) continue

    // The embedded theme content and metadata come from the same untrusted
    // index bytes as everything else, so they get the full theme validator
    // (which also caps author/description). An entry whose embedded theme
    // fails validation is kept, but without a preview — installing it still
    // fetches and validates the canonical file, which is the real gate.
    let embedded: ThemeFile | undefined
    try {
      embedded = theme === undefined ? undefined : validateThemeFile(theme)
    } catch {
      embedded = undefined
    }
    const galleryTheme: GalleryTheme = { name, kind, url: `${GALLERY_RAW_BASE}/${file}` }
    if (embedded) galleryTheme.theme = embedded
    // Metadata: the embedded theme's own fields win (the file is the source
    // of truth); entry-level fields fill the gaps. Entry-level strings do not
    // pass through the theme validator, so cap them here the same way.
    galleryTheme.author = embedded?.author
      ?? displayText(author, MAX_THEME_AUTHOR_LENGTH)
    galleryTheme.description = embedded?.description
      ?? displayText(description, MAX_THEME_DESCRIPTION_LENGTH)
    const { screenshot } = entry as Record<string, unknown>
    if (typeof screenshot === 'string' && GALLERY_SCREENSHOT_PATH.test(screenshot)) {
      galleryTheme.screenshotUrl = `${GALLERY_RAW_BASE}/${screenshot}`
    }
    themes.push(galleryTheme)
  }
  return themes
}

// Reads a response body as bytes, aborting once the cap is exceeded — the
// binary counterpart of readCappedText, for screenshots.
async function readCappedBytes(response: Response, limitBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > limitBytes) {
      throw new Error(`screenshot too large (limit ${limitBytes} bytes)`)
    }
    return buffer
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limitBytes) {
      await reader.cancel()
      throw new Error(`screenshot too large (limit ${limitBytes} bytes)`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

// Fetches an author screenshot and returns it as a data: URI (the renderer's
// CSP allows data: images but not remote hosts, so the fetch must happen here).
// The URL is re-pinned to the gallery base + screenshot path even though it
// was built here, and the response must actually be an image — the renderer
// hands the URL back over IPC, so it is treated as untrusted on the way in.
export async function fetchGalleryImage(
  url: string, fetchFn: typeof fetch = fetch,
): Promise<{ dataUri: string }> {
  const prefix = `${GALLERY_RAW_BASE}/`
  if (!url.startsWith(prefix) || !GALLERY_SCREENSHOT_PATH.test(url.slice(prefix.length))) {
    throw new Error('screenshot URL is not an allowed gallery path')
  }
  const response = await guardedFetch(url, fetchFn)
  if (!response.ok) throw new Error(`screenshot download failed: ${response.status}`)
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!GALLERY_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error(`screenshot is not an allowed image type (content-type: ${contentType || 'none'})`)
  }
  const bytes = await readCappedBytes(response, MAX_GALLERY_IMAGE_BYTES)
  return { dataUri: `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}` }
}
