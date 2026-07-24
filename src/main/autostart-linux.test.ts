import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LINUX_AUTOSTART_FILENAME,
  buildLinuxDesktopEntry,
  linuxAutostartPath,
  linuxLaunchExec,
  quoteDesktopExec,
} from './autostart-linux'

test('linuxAutostartPath falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
  const path = linuxAutostartPath({}, '/home/alice')
  assert.equal(path, `/home/alice/.config/autostart/${LINUX_AUTOSTART_FILENAME}`)
})

test('linuxAutostartPath honors XDG_CONFIG_HOME', () => {
  const path = linuxAutostartPath({ XDG_CONFIG_HOME: '/custom/cfg' }, '/home/alice')
  assert.equal(path, `/custom/cfg/autostart/${LINUX_AUTOSTART_FILENAME}`)
})

test('linuxAutostartPath ignores a blank XDG_CONFIG_HOME', () => {
  const path = linuxAutostartPath({ XDG_CONFIG_HOME: '   ' }, '/home/alice')
  assert.equal(path, `/home/alice/.config/autostart/${LINUX_AUTOSTART_FILENAME}`)
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
