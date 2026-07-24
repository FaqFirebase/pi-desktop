import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listUserThemes, saveUserTheme, deleteUserTheme, installThemeFromUrl, fetchGalleryThemes,
  fetchGalleryImage,
} from './theme-store'
import { THEME_SCHEMA_V1, type ThemeFile } from '../shared/theme/theme-file'

const theme = (name: string): ThemeFile => ({
  $schema: THEME_SCHEMA_V1, name, kind: 'dark',
  seeds: {
    app: '#111111', surface: '#222222', text: '#eeeeee', accent: '#3366ff',
    success: '#33cc66', warning: '#ffcc00', error: '#ff4444',
  },
})

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pi-themes-'))
}

test('save + list round-trip', async () => {
  const dir = await freshDir()
  const { id } = await saveUserTheme(dir, theme('My Theme'))
  assert.equal(id, 'my-theme')
  const { themes, warnings } = await listUserThemes(dir)
  assert.equal(warnings.length, 0)
  assert.deepEqual(themes.map((t) => t.id), ['my-theme'])
})

test('name collision gets numeric suffix', async () => {
  const dir = await freshDir()
  await saveUserTheme(dir, theme('Dup'))
  const second = await saveUserTheme(dir, { ...theme('Dup'), kind: 'light' })
  assert.equal(second.id, 'dup-2')
})

test('saving a theme named after a built-in avoids the built-in id', async () => {
  const dir = await freshDir()
  const { id } = await saveUserTheme(dir, theme('Nord'))
  assert.equal(id, 'nord-2')
})

test('saving a theme named after a Windows reserved device avoids the reserved id', async () => {
  const dir = await freshDir()
  // "CON"/"NUL"/"COM1"/... are Windows device names even with a .json
  // extension, so their slugs must never become the on-disk filename.
  assert.equal((await saveUserTheme(dir, theme('CON'))).id, 'con-2')
  assert.equal((await saveUserTheme(dir, theme('nul'))).id, 'nul-2')
  assert.equal((await saveUserTheme(dir, theme('Com1'))).id, 'com1-2')
  // A non-reserved lookalike is unaffected.
  assert.equal((await saveUserTheme(dir, theme('com0'))).id, 'com0')
})

test('re-importing the same built-in-named theme stays on the same suffixed id', async () => {
  const dir = await freshDir()
  const first = await saveUserTheme(dir, theme('Nord'))
  const second = await saveUserTheme(dir, theme('Nord'))
  assert.equal(first.id, 'nord-2')
  assert.equal(second.id, 'nord-2')
  const { themes } = await listUserThemes(dir)
  assert.deepEqual(themes.map((t) => t.id), ['nord-2'])
})

test('saving identical id and name overwrites (editor update path)', async () => {
  const dir = await freshDir()
  await saveUserTheme(dir, theme('Same'))
  await saveUserTheme(dir, { ...theme('Same'), seeds: { ...theme('Same').seeds, app: '#000000' } })
  const { themes } = await listUserThemes(dir)
  assert.equal(themes.length, 1)
  assert.equal(themes[0].file.seeds.app, '#000000')
})

test('editing a theme onto another theme\'s name suffixes instead of overwriting', async () => {
  const dir = await freshDir()
  const fooContent = theme('Foo')
  const barContent = { ...theme('Bar'), seeds: { ...theme('Bar').seeds, app: '#abcdef' } }
  const foo = await saveUserTheme(dir, fooContent)
  const bar = await saveUserTheme(dir, barContent)
  assert.equal(foo.id, 'foo')
  assert.equal(bar.id, 'bar')

  // Editing Bar in the theme editor: rename it to "Foo" and save with
  // existingId 'bar'. Identity (name+kind) now matches Foo's file, but the
  // edited theme is NOT Foo — it must not overwrite foo.json.
  const renamed = { ...barContent, name: 'Foo' }
  const result = await saveUserTheme(dir, renamed, 'bar')
  assert.equal(result.id, 'foo-2')

  const fooOnDisk = JSON.parse(await readFile(join(dir, 'foo.json'), 'utf8'))
  assert.equal(fooOnDisk.seeds.app, fooContent.seeds.app)

  const { themes } = await listUserThemes(dir)
  assert.deepEqual(themes.map((t) => t.id).sort(), ['bar', 'foo', 'foo-2'])
})

test('editing a theme without renaming overwrites its own file in place', async () => {
  const dir = await freshDir()
  await saveUserTheme(dir, theme('Foo'))
  const bar = await saveUserTheme(dir, theme('Bar'))
  assert.equal(bar.id, 'bar')

  const edited = { ...theme('Bar'), seeds: { ...theme('Bar').seeds, app: '#000000' } }
  const result = await saveUserTheme(dir, edited, 'bar')
  assert.equal(result.id, 'bar')

  const { themes } = await listUserThemes(dir)
  assert.deepEqual(themes.map((t) => t.id).sort(), ['bar', 'foo'])
  const barOnDisk = JSON.parse(await readFile(join(dir, 'bar.json'), 'utf8'))
  assert.equal(barOnDisk.seeds.app, '#000000')
})

test('existingId must be a valid theme id', async () => {
  const dir = await freshDir()
  await assert.rejects(
    saveUserTheme(dir, theme('Foo'), '../escape'), /invalid theme id/)
})

test('existingId cannot target a built-in theme id', async () => {
  const dir = await freshDir()
  await assert.rejects(
    saveUserTheme(dir, theme('Foo'), 'nord'), /built-in/)
})

test('list skips invalid files with a warning', async () => {
  const dir = await freshDir()
  await saveUserTheme(dir, theme('Good'))
  await writeFile(join(dir, 'bad.json'), '{"$schema":"nope"}')
  await writeFile(join(dir, 'not-json.json'), '{{{')
  const { themes, warnings } = await listUserThemes(dir)
  assert.equal(themes.length, 1)
  assert.equal(warnings.length, 2)
})

test('list ignores a file whose id shadows a built-in theme', async () => {
  const dir = await freshDir()
  // Simulate a shadow file arriving by any means other than saveUserTheme
  // (predates the write-side fix, placed by another process, etc). The
  // content itself is a valid theme file; only its filename collides.
  await writeFile(join(dir, 'nord.json'), JSON.stringify(theme('Not Actually Nord')))
  const { themes, warnings } = await listUserThemes(dir)
  assert.ok(!themes.some((t) => t.id === 'nord'))
  const nordWarnings = warnings.filter((w) => w.includes('nord'))
  assert.equal(nordWarnings.length, 1)
  assert.match(nordWarnings[0], /built-in/)
})

test('delete removes the file and rejects traversal', async () => {
  const dir = await freshDir()
  const { id } = await saveUserTheme(dir, theme('Bye'))
  await deleteUserTheme(dir, id)
  assert.equal((await listUserThemes(dir)).themes.length, 0)
  await assert.rejects(deleteUserTheme(dir, '../escape'), /invalid theme id/)
})

test('installThemeFromUrl validates scheme, size, and content', async () => {
  const dir = await freshDir()
  const body = JSON.stringify(theme('Remote'))
  const okFetch = (async () => new Response(body, { status: 200 })) as typeof fetch
  const { id } = await installThemeFromUrl(dir, 'https://example.com/t.json', okFetch)
  assert.equal(id, 'remote')
  assert.ok((await readFile(join(dir, 'remote.json'), 'utf8')).includes('Remote'))

  await assert.rejects(
    installThemeFromUrl(dir, 'http://example.com/t.json', okFetch), /https/)
  const bigFetch = (async () =>
    new Response('x'.repeat(300000), { status: 200 })) as typeof fetch
  await assert.rejects(
    installThemeFromUrl(dir, 'https://example.com/big.json', bigFetch), /too large/)
  const badFetch = (async () =>
    new Response('{"$schema":"nope"}', { status: 200 })) as typeof fetch
  await assert.rejects(
    installThemeFromUrl(dir, 'https://example.com/bad.json', badFetch), /ThemeValidationError|unsupported/)
  const failFetch = (async () => new Response('', { status: 404 })) as typeof fetch
  await assert.rejects(
    installThemeFromUrl(dir, 'https://example.com/404.json', failFetch), /404/)
})

// installThemeFromUrl fetches in the Electron main process, outside the
// renderer's CSP connect-src. Without host classification this is a blind
// SSRF: a URL (or a redirect target) pointing at a private/loopback/
// link-local/metadata host causes the main process to issue a real GET
// against internal infrastructure. These tests prove the guard runs BEFORE
// any network call (fetchFn.mock.calls stays empty) for every dangerous
// host class, and that manual redirect handling validates every hop so a
// public URL cannot be used to bounce a request onto an internal one.

function trackingFetch(
  responses: Record<string, () => Response>,
): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    const make = responses[url]
    if (!make) throw new Error(`unexpected fetch to ${url}`)
    return make()
  }) as typeof fetch
  return { fetchFn, calls }
}

const PRIVATE_IPV4_URLS = [
  'https://127.0.0.1/',
  'https://10.0.0.5/',
  'https://172.16.0.1/',
  'https://192.168.1.1/',
  'https://169.254.169.254/',
  'https://100.64.0.1/',
]

for (const url of PRIVATE_IPV4_URLS) {
  test(`installThemeFromUrl rejects private IPv4 literal ${url}`, async () => {
    const dir = await freshDir()
    const { fetchFn, calls } = trackingFetch({})
    await assert.rejects(installThemeFromUrl(dir, url, fetchFn), /block|private|internal|reserved/i)
    assert.equal(calls.length, 0)
  })
}

const BLOCKED_HOSTNAMES = ['https://localhost/', 'https://foo.local/']

for (const url of BLOCKED_HOSTNAMES) {
  test(`installThemeFromUrl rejects blocked hostname ${url}`, async () => {
    const dir = await freshDir()
    const { fetchFn, calls } = trackingFetch({})
    await assert.rejects(installThemeFromUrl(dir, url, fetchFn), /block|local/i)
    assert.equal(calls.length, 0)
  })
}

const PRIVATE_IPV6_URLS = [
  'https://[::1]/',
  'https://[fc00::1]/',
  'https://[fe80::1]/',
  'https://[::ffff:10.0.0.1]/',
]

for (const url of PRIVATE_IPV6_URLS) {
  test(`installThemeFromUrl rejects private IPv6 literal ${url}`, async () => {
    const dir = await freshDir()
    const { fetchFn, calls } = trackingFetch({})
    await assert.rejects(installThemeFromUrl(dir, url, fetchFn), /block|private|internal|reserved/i)
    assert.equal(calls.length, 0)
  })
}

test('installThemeFromUrl blocks a public URL that redirects to an internal host', async () => {
  const dir = await freshDir()
  const publicUrl = 'https://public.example.com/t.json'
  const internalUrl = 'https://10.0.0.5/x'
  const { fetchFn, calls } = trackingFetch({
    [publicUrl]: () => new Response(null, { status: 302, headers: { location: internalUrl } }),
  })
  await assert.rejects(installThemeFromUrl(dir, publicUrl, fetchFn), /block|private|internal|reserved/i)
  assert.deepEqual(calls, [publicUrl])
})

test('installThemeFromUrl follows a public-to-public redirect chain to a valid theme', async () => {
  const dir = await freshDir()
  const hop1 = 'https://hop1.example.com/t.json'
  const hop2 = 'https://hop2.example.com/t.json'
  const finalUrl = 'https://final.example.com/t.json'
  const body = JSON.stringify(theme('Chained'))
  const { fetchFn, calls } = trackingFetch({
    [hop1]: () => new Response(null, { status: 302, headers: { location: hop2 } }),
    [hop2]: () => new Response(null, { status: 302, headers: { location: finalUrl } }),
    [finalUrl]: () => new Response(body, { status: 200 }),
  })
  const { id } = await installThemeFromUrl(dir, hop1, fetchFn)
  assert.equal(id, 'chained')
  assert.deepEqual(calls, [hop1, hop2, finalUrl])
})

test('installThemeFromUrl throws when redirects exceed the cap', async () => {
  const dir = await freshDir()
  const base = 'https://redirect.example.com/'
  const hopCount = 8
  const responses: Record<string, () => Response> = {}
  for (let i = 0; i < hopCount; i += 1) {
    responses[`${base}${i}`] = () => new Response(null, {
      status: 302, headers: { location: `${base}${i + 1}` },
    })
  }
  const { fetchFn } = trackingFetch(responses)
  await assert.rejects(installThemeFromUrl(dir, `${base}0`, fetchFn), /redirect/i)
})

test('installThemeFromUrl still installs from a normal public https URL', async () => {
  const dir = await freshDir()
  const body = JSON.stringify(theme('Plain'))
  const { fetchFn, calls } = trackingFetch({
    'https://public.example.com/plain.json': () => new Response(body, { status: 200 }),
  })
  const { id } = await installThemeFromUrl(dir, 'https://public.example.com/plain.json', fetchFn)
  assert.equal(id, 'plain')
  assert.deepEqual(calls, ['https://public.example.com/plain.json'])
})

test('installThemeFromUrl rejects a redirect that downgrades to http', async () => {
  const dir = await freshDir()
  const httpsUrl = 'https://example.com/t.json'
  const httpUrl = 'http://evil.example.com/t.json'
  const { fetchFn, calls } = trackingFetch({
    [httpsUrl]: () => new Response(null, { status: 302, headers: { location: httpUrl } }),
  })
  await assert.rejects(installThemeFromUrl(dir, httpsUrl, fetchFn), /https/)
  assert.deepEqual(calls, [httpsUrl])
})

test('installThemeFromUrl allows a public IPv4 literal', async () => {
  const dir = await freshDir()
  const url = 'https://93.184.216.34/'
  const body = JSON.stringify(theme('PublicIp'))
  const { fetchFn, calls } = trackingFetch({
    [url]: () => new Response(body, { status: 200 }),
  })
  const { id } = await installThemeFromUrl(dir, url, fetchFn)
  assert.equal(id, 'publicip')
  assert.deepEqual(calls, [url])
})

// --- fetchGalleryThemes -----------------------------------------------------

const jsonFetch = (payload: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch

test('fetchGalleryThemes returns valid entries with pinned first-party URLs', async () => {
  const themes = await fetchGalleryThemes(jsonFetch([
    // Current per-folder layout and the original flat layout are both valid.
    { name: 'Ocean', kind: 'dark', file: 'themes/ocean/theme.json' },
    { name: 'Ember Light', kind: 'light', file: 'themes/ember-light.json' },
  ]))
  assert.deepEqual(themes.map(({ name, kind, url }) => ({ name, kind, url })), [
    { name: 'Ocean', kind: 'dark', url: 'https://raw.githubusercontent.com/FaqFirebase/pi-desktop-themes/main/themes/ocean/theme.json' },
    { name: 'Ember Light', kind: 'light', url: 'https://raw.githubusercontent.com/FaqFirebase/pi-desktop-themes/main/themes/ember-light.json' },
  ])
})

test('fetchGalleryThemes validates embedded theme content and metadata', async () => {
  const embedded = { ...theme('Ocean'), author: 'Pi Desktop', description: 'Calm blues.' }
  const themes = await fetchGalleryThemes(jsonFetch([
    { name: 'Ocean', kind: 'dark', file: 'themes/ocean.json', theme: embedded },
    // Invalid embedded theme: the entry survives without a preview.
    { name: 'Broken', kind: 'dark', file: 'themes/broken.json', theme: { $schema: 'nope' } },
    // Entry-level metadata fallback, with the oversized value dropped.
    { name: 'Meta', kind: 'light', file: 'themes/meta.json', author: 'Someone', description: 'x'.repeat(300) },
  ]))
  assert.equal(themes.length, 3)
  assert.equal(themes[0].theme?.seeds.app, embedded.seeds.app)
  assert.equal(themes[0].author, 'Pi Desktop')
  assert.equal(themes[0].description, 'Calm blues.')
  assert.equal(themes[1].theme, undefined)
  assert.equal(themes[2].author, 'Someone')
  assert.equal(themes[2].description, undefined)
})

test('fetchGalleryThemes drops malformed and path-traversal entries', async () => {
  const themes = await fetchGalleryThemes(jsonFetch([
    { name: 'Good', kind: 'dark', file: 'themes/good.json' },
    { name: 'No kind', file: 'themes/x.json' },
    { name: 'Bad kind', kind: 'sepia', file: 'themes/x.json' },
    { name: 'Traversal', kind: 'dark', file: 'themes/../../etc/passwd' },
    { name: 'Folder traversal', kind: 'dark', file: 'themes/x/../y/theme.json' },
    { name: 'Nested too deep', kind: 'dark', file: 'themes/a/b/theme.json' },
    { name: 'Wrong file name', kind: 'dark', file: 'themes/x/other.json' },
    { name: 'Absolute', kind: 'dark', file: 'https://evil.example.com/x.json' },
    { name: 'Wrong dir', kind: 'dark', file: 'other/x.json' },
    { name: '', kind: 'dark', file: 'themes/empty.json' },
    'not an object',
  ]))
  // Only the single well-formed entry survives.
  assert.deepEqual(themes.map((t) => t.name), ['Good'])
})

test('fetchGalleryThemes rejects a non-array index and a failed fetch', async () => {
  await assert.rejects(fetchGalleryThemes(jsonFetch({ not: 'an array' })), /not a JSON array/)
  const failFetch = (async () => new Response('', { status: 500 })) as typeof fetch
  await assert.rejects(fetchGalleryThemes(failFetch), /gallery index download failed: 500/)
})

const GALLERY_BASE = 'https://raw.githubusercontent.com/FaqFirebase/pi-desktop-themes/main'

test('fetchGalleryThemes exposes a valid screenshot URL, ignores a bad one', async () => {
  const themes = await fetchGalleryThemes(jsonFetch([
    { name: 'Shot', kind: 'dark', file: 'themes/shot/theme.json', screenshot: 'themes/shot/screenshot.png' },
    { name: 'Bad', kind: 'dark', file: 'themes/bad/theme.json', screenshot: 'themes/bad/../evil.png' },
    { name: 'None', kind: 'dark', file: 'themes/none/theme.json' },
  ]))
  assert.equal(themes[0].screenshotUrl, `${GALLERY_BASE}/themes/shot/screenshot.png`)
  assert.equal(themes[1].screenshotUrl, undefined)
  assert.equal(themes[2].screenshotUrl, undefined)
})

test('fetchGalleryImage pins the URL and requires an image response', async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const imgFetch = (async () =>
    new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch
  const good = `${GALLERY_BASE}/themes/shot/screenshot.png`
  const { dataUri } = await fetchGalleryImage(good, imgFetch)
  assert.match(dataUri, /^data:image\/png;base64,/)

  // Off-gallery host is rejected before any fetch.
  await assert.rejects(
    fetchGalleryImage('https://evil.example.com/x.png', imgFetch), /not an allowed gallery path/)
  // Right host, but not a screenshot path.
  await assert.rejects(
    fetchGalleryImage(`${GALLERY_BASE}/themes/shot/theme.json`, imgFetch), /not an allowed gallery path/)
  // Right path, but the response is not an image.
  const htmlFetch = (async () =>
    new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch
  await assert.rejects(fetchGalleryImage(good, htmlFetch), /not an allowed image type/)
  // SVG is an image type but can carry script, so the allowlist excludes it.
  const svgFetch = (async () =>
    new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } })) as typeof fetch
  await assert.rejects(fetchGalleryImage(good, svgFetch), /not an allowed image type/)
  // A charset parameter on the content-type must not defeat the allowlist.
  const paramFetch = (async () =>
    new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png; charset=binary' } })) as typeof fetch
  const { dataUri: paramUri } = await fetchGalleryImage(good, paramFetch)
  assert.match(paramUri, /^data:image\/png;base64,/)
})

test('fetchGalleryImage caps oversized screenshots', async () => {
  const huge = new Uint8Array(3 * 1024 * 1024)
  const hugeFetch = (async () =>
    new Response(huge, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch
  await assert.rejects(
    fetchGalleryImage(`${GALLERY_BASE}/themes/shot/screenshot.png`, hugeFetch), /too large/)
})
