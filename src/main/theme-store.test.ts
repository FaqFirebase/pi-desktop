import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listUserThemes, saveUserTheme, deleteUserTheme, installThemeFromUrl,
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

test('installThemeFromUrl rejects a redirect that downgrades to http', async () => {
  const dir = await freshDir()
  const downgradedUrl = 'http://evil.example.com/t.json'
  const redirectFetch = (async () => {
    const response = new Response(JSON.stringify(theme('Remote')), { status: 200 })
    // Response.url has no writable init option; the only way to simulate
    // undici's post-redirect response.url is to override the getter result
    // directly, mirroring what a real https->http redirect would produce.
    Object.defineProperty(response, 'url', { value: downgradedUrl })
    return response
  }) as typeof fetch
  await assert.rejects(
    installThemeFromUrl(dir, 'https://example.com/t.json', redirectFetch), /https/)
})
