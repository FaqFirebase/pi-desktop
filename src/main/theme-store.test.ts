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

test('saving identical id and name overwrites (editor update path)', async () => {
  const dir = await freshDir()
  await saveUserTheme(dir, theme('Same'))
  await saveUserTheme(dir, { ...theme('Same'), seeds: { ...theme('Same').seeds, app: '#000000' } })
  const { themes } = await listUserThemes(dir)
  assert.equal(themes.length, 1)
  assert.equal(themes[0].file.seeds.app, '#000000')
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
