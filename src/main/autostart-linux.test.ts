import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LINUX_DESKTOP_FILENAME,
  LINUX_GENERATED_ENTRY_LINE,
  LINUX_ICON_NAME,
  buildLinuxApplicationEntry,
  buildLinuxDesktopEntry,
  linuxApplicationEntryPath,
  linuxIconInstallPath,
  linuxSystemApplicationEntryPaths,
  linuxAutostartPath,
  linuxLaunchExec,
  quoteDesktopExec,
  shouldWriteLinuxApplicationEntry,
} from './autostart-linux'

test('linuxAutostartPath falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
  const path = linuxAutostartPath({}, '/home/alice')
  assert.equal(path, `/home/alice/.config/autostart/${LINUX_DESKTOP_FILENAME}`)
})

test('linuxAutostartPath honors XDG_CONFIG_HOME', () => {
  const path = linuxAutostartPath({ XDG_CONFIG_HOME: '/custom/cfg' }, '/home/alice')
  assert.equal(path, `/custom/cfg/autostart/${LINUX_DESKTOP_FILENAME}`)
})

test('linuxAutostartPath ignores a blank XDG_CONFIG_HOME', () => {
  const path = linuxAutostartPath({ XDG_CONFIG_HOME: '   ' }, '/home/alice')
  assert.equal(path, `/home/alice/.config/autostart/${LINUX_DESKTOP_FILENAME}`)
})

test('linuxLaunchExec prefers APPIMAGE over execPath', () => {
  assert.equal(
    linuxLaunchExec({ APPIMAGE: '/opt/Pi-Desktop.AppImage' }, '/tmp/.mount_x/pi-desktop'),
    '/opt/Pi-Desktop.AppImage',
  )
})

test('linuxLaunchExec falls back to execPath when APPIMAGE is absent', () => {
  assert.equal(linuxLaunchExec({}, '/usr/bin/pi-desktop'), '/usr/bin/pi-desktop')
})

test('quoteDesktopExec wraps in double quotes and escapes special chars', () => {
  assert.equal(quoteDesktopExec('/opt/Pi Desktop/app'), '"/opt/Pi Desktop/app"')
  assert.equal(quoteDesktopExec('/a\\b'), '"/a\\\\b"')
  assert.equal(quoteDesktopExec('/a"b'), '"/a\\"b"')
})

test('buildLinuxDesktopEntry produces a valid, complete desktop entry', () => {
  const entry = buildLinuxDesktopEntry({ exec: '/opt/Pi Desktop.AppImage', icon: '/opt/icon.png' })
  const lines = entry.split('\n')

  assert.equal(lines[0], '[Desktop Entry]')
  assert.ok(lines.includes('Type=Application'))
  assert.ok(lines.includes('Name=Pi Desktop'))
  assert.ok(lines.includes('Exec="/opt/Pi Desktop.AppImage"'))
  assert.ok(lines.includes('Icon=/opt/icon.png'))
  assert.ok(lines.includes('Terminal=false'))
  assert.ok(lines.includes('X-GNOME-Autostart-enabled=true'))
  // Trailing newline so the file ends cleanly.
  assert.ok(entry.endsWith('\n'))
})

test('the entry name matches package.json desktopName, which names the app id the portal checks', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { desktopName: string }
  assert.equal(manifest.desktopName, LINUX_DESKTOP_FILENAME)
})

test('the application entry and icon live under XDG_DATA_HOME, falling back to ~/.local/share', () => {
  assert.equal(linuxApplicationEntryPath({}, '/home/alice'), `/home/alice/.local/share/applications/${LINUX_DESKTOP_FILENAME}`)
  assert.equal(linuxApplicationEntryPath({ XDG_DATA_HOME: '/data' }, '/home/alice'), `/data/applications/${LINUX_DESKTOP_FILENAME}`)
  assert.equal(linuxApplicationEntryPath({ XDG_DATA_HOME: '  ' }, '/home/alice'), `/home/alice/.local/share/applications/${LINUX_DESKTOP_FILENAME}`)
  assert.equal(linuxIconInstallPath({}, '/home/alice'), `/home/alice/.local/share/icons/hicolor/512x512/apps/${LINUX_ICON_NAME}.png`)
})

test('system entries come from XDG_DATA_DIRS, or the spec default when it is unset', () => {
  assert.deepEqual(linuxSystemApplicationEntryPaths({}), [
    `/usr/local/share/applications/${LINUX_DESKTOP_FILENAME}`,
    `/usr/share/applications/${LINUX_DESKTOP_FILENAME}`,
  ])
  assert.deepEqual(linuxSystemApplicationEntryPaths({ XDG_DATA_DIRS: '/a::/b' }), [
    `/a/applications/${LINUX_DESKTOP_FILENAME}`,
    `/b/applications/${LINUX_DESKTOP_FILENAME}`,
  ])
})

test('the application entry is marked as ours and uses the installed icon name', () => {
  const lines = buildLinuxApplicationEntry({ exec: '/opt/Pi Desktop.AppImage', icon: LINUX_ICON_NAME }).split('\n')
  assert.equal(lines[0], '[Desktop Entry]')
  assert.ok(lines.includes('Exec="/opt/Pi Desktop.AppImage"'))
  assert.ok(lines.includes(`Icon=${LINUX_ICON_NAME}`))
  assert.ok(lines.includes(`StartupWMClass=${LINUX_ICON_NAME}`))
  assert.ok(lines.includes(LINUX_GENERATED_ENTRY_LINE))
  assert.ok(!lines.includes('X-GNOME-Autostart-enabled=true'))
})

test('the app writes a missing entry, refreshes its own and leaves every other entry alone', () => {
  const wanted = buildLinuxApplicationEntry({ exec: '/new/Pi.AppImage', icon: LINUX_ICON_NAME })
  const stale = buildLinuxApplicationEntry({ exec: '/old/Pi.AppImage', icon: LINUX_ICON_NAME })
  const foreign = '[Desktop Entry]\nType=Application\nName=Pi Desktop\nExec=/usr/bin/pi-desktop\n'
  assert.equal(shouldWriteLinuxApplicationEntry({ userEntry: null, systemEntryExists: false, wanted }), true)
  assert.equal(shouldWriteLinuxApplicationEntry({ userEntry: null, systemEntryExists: true, wanted }), false)
  assert.equal(shouldWriteLinuxApplicationEntry({ userEntry: stale, systemEntryExists: false, wanted }), true)
  assert.equal(shouldWriteLinuxApplicationEntry({ userEntry: wanted, systemEntryExists: false, wanted }), false)
  assert.equal(shouldWriteLinuxApplicationEntry({ userEntry: foreign, systemEntryExists: false, wanted }), false)
})
