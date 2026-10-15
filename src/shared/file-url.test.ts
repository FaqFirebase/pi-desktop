import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { toFileUrl } from './file-url'

// Node's own file-URL reader, per platform: the URL must name exactly the input
// path, whatever characters the names hold.
const readsBackAs = (path: string, windows: boolean): string => fileURLToPath(toFileUrl(path), { windows })

test('a POSIX path keeps its separators', () => {
  assert.equal(toFileUrl('/home/me/project/report.pdf'), 'file:///home/me/project/report.pdf')
})

test('# and ? in a name stay in the path, so the URL names that same file', () => {
  // A folder named "doc.html#" and a file named "page.html?.pdf" stay part of
  // the path: no fragment or query that would name another file.
  assert.equal(toFileUrl('/ws/doc.html#/report.pdf'), 'file:///ws/doc.html%23/report.pdf')
  assert.equal(toFileUrl('/ws/page.html?.pdf'), 'file:///ws/page.html%3F.pdf')
  for (const path of ['/ws/doc.html#/report.pdf', '/ws/page.html?.pdf']) {
    const url = new URL(toFileUrl(path))
    assert.equal(url.search, '')
    assert.equal(url.hash, '')
    assert.equal(readsBackAs(path, false), path)
  }
})

test('%, spaces, and non-ASCII letters are percent-encoded', () => {
  assert.equal(
    toFileUrl('/ws/a b%20c/résumé 100%.pdf'),
    'file:///ws/a%20b%2520c/r%C3%A9sum%C3%A9%20100%25.pdf',
  )
  assert.equal(toFileUrl('/ws/文档/報告.pdf'), 'file:///ws/%E6%96%87%E6%A1%A3/%E5%A0%B1%E5%91%8A.pdf')
  for (const path of ['/ws/a b%20c/résumé 100%.pdf', '/ws/文档/報告.pdf', '/ws/50%25 off;a=b&c+d@e$f,g.pdf']) {
    assert.equal(readsBackAs(path, false), path)
  }
})

test('a backslash in a POSIX name is a character, not a separator', () => {
  assert.equal(toFileUrl('/ws/back\\slash.pdf'), 'file:///ws/back%5Cslash.pdf')
  assert.equal(readsBackAs('/ws/back\\slash.pdf', false), '/ws/back\\slash.pdf')
})

test('a Windows drive path keeps its drive letter', () => {
  assert.equal(toFileUrl('C:\\a b\\x.pdf'), 'file:///C:/a%20b/x.pdf')
  assert.equal(toFileUrl('C:/a b/x.pdf'), 'file:///C:/a%20b/x.pdf')
  assert.equal(toFileUrl('d:\\Docs\\doc.html#\\report.pdf'), 'file:///d:/Docs/doc.html%23/report.pdf')
  for (const path of ['C:\\a b\\x.pdf', 'd:\\Docs\\doc.html#\\report.pdf', 'C:\\Users\\Zoë\\100% ?.pdf']) {
    assert.equal(readsBackAs(path, true), path)
  }
})

test('a UNC path names its server as the URL host', () => {
  assert.equal(toFileUrl('\\\\server\\share\\x.pdf'), 'file://server/share/x.pdf')
  assert.equal(toFileUrl('\\\\server\\share\\a b\\#1.pdf'), 'file://server/share/a%20b/%231.pdf')
  for (const path of ['\\\\server\\share\\x.pdf', '\\\\server\\share\\a b\\#1.pdf']) {
    assert.equal(readsBackAs(path, true), path)
  }
})

test('a path that is neither a drive, a UNC, nor POSIX-rooted never names a host', () => {
  // Callers pass absolute paths; anything else must not become a network share.
  assert.equal(new URL(toFileUrl('relative/x.pdf')).host, '')
  assert.equal(new URL(toFileUrl('C:relative.pdf')).host, '')
})
