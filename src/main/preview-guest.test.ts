import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toFileUrl } from '../shared/file-url'
import { HTML_PREVIEW_PARTITION, PDF_PREVIEW_PARTITION } from '../shared/preview-partitions'
import { isBlockedPreviewRequest, previewGuestPreferences } from './preview-guest'

// The PDF pane's <webview> src: the file URL plus the viewer's display options.
const PDF_VIEWER_FRAGMENT = '#toolbar=0&navpanes=0'
const pdfPaneSrc = (path: string): string => `${toFileUrl(path)}${PDF_VIEWER_FRAGMENT}`
// The src an encodeURI-based builder makes: # and ? stay raw, so these load
// /ws/doc.html and /ws/page.html.
const encodeUriPaneSrc = (path: string): string => `${encodeURI(`file://${path}`)}${PDF_VIEWER_FRAGMENT}`
// PDF names in folders or with suffixes whose raw URL loads an HTML file.
const PDF_NAMES_OVER_HTML = ['/ws/doc.html#/report.pdf', '/ws/page.html?.pdf']

const NOT_PDF_UNTRUSTED = { plugins: false, javascript: false }
const NOT_PDF_TRUSTED = { plugins: false, javascript: true }
const PDF_PREVIEW = { plugins: true, javascript: true }

test('a guest whose src loads HTML is not the PDF preview: no plugins, no scripts when untrusted', () => {
  for (const path of PDF_NAMES_OVER_HTML) {
    const src = encodeUriPaneSrc(path)
    assert.deepEqual(previewGuestPreferences({ partition: PDF_PREVIEW_PARTITION, src, workspaceTrusted: false }), NOT_PDF_UNTRUSTED)
    assert.deepEqual(previewGuestPreferences({ partition: PDF_PREVIEW_PARTITION, src, workspaceTrusted: true }), NOT_PDF_TRUSTED)
  }
})

test('a .pdf file in the PDF partition is the PDF preview: plugins on, and scripts on for the viewer', () => {
  const paths = [...PDF_NAMES_OVER_HTML, '/ws/report.pdf', '/ws/résumé 100%.pdf', 'C:\\Docs\\Report.PDF', '\\\\server\\share\\x.pdf']
  for (const path of paths) {
    for (const workspaceTrusted of [false, true]) {
      assert.deepEqual(
        previewGuestPreferences({ partition: PDF_PREVIEW_PARTITION, src: pdfPaneSrc(path), workspaceTrusted }),
        PDF_PREVIEW,
        path,
      )
    }
  }
})

test('the PDF preview needs both the PDF partition and a src whose file is a .pdf', () => {
  const report = pdfPaneSrc('/ws/report.pdf')
  assert.deepEqual(previewGuestPreferences({ partition: HTML_PREVIEW_PARTITION, src: report, workspaceTrusted: false }), NOT_PDF_UNTRUSTED)
  assert.deepEqual(previewGuestPreferences({ src: report, workspaceTrusted: false }), NOT_PDF_UNTRUSTED)
  const notPdfSources = [
    toFileUrl('/ws/page.html'),
    'file:///ws/page.html?x.pdf',
    'file:///ws/page.html#.pdf',
    'https://example.com/report.pdf',
    // An escape that does not decode: refused rather than guessed.
    'file:///ws/bad%E0%A4%A.pdf',
    'not a url',
  ]
  for (const src of notPdfSources) {
    assert.deepEqual(previewGuestPreferences({ partition: PDF_PREVIEW_PARTITION, src, workspaceTrusted: false }), NOT_PDF_UNTRUSTED, src)
  }
})

test('the HTML preview runs scripts only for a trusted workspace and never gets plugins', () => {
  const src = toFileUrl('/ws/index.html')
  assert.deepEqual(previewGuestPreferences({ partition: HTML_PREVIEW_PARTITION, src, workspaceTrusted: false }), NOT_PDF_UNTRUSTED)
  assert.deepEqual(previewGuestPreferences({ partition: HTML_PREVIEW_PARTITION, src, workspaceTrusted: true }), NOT_PDF_TRUSTED)
})

// Requests the PDF viewer makes in the guest (seen on Electron 43): its own
// component-extension pages and Chromium's shared WebUI resources.
const PDF_VIEWER_REQUESTS = [
  'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf_embedder.css',
  'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
  'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/main.js',
  'chrome://resources/css/text_defaults_md.css',
  'chrome://resources/roboto/roboto-regular.woff2',
  'chrome://resources/mojo/mojo/public/js/bindings.js',
]
const REMOTE_REQUESTS = ['https://example.com/beacon', 'http://127.0.0.1:8080/x', 'wss://example.com/socket']

test('a trusted workspace preview may load anything in either partition', () => {
  for (const partition of [HTML_PREVIEW_PARTITION, PDF_PREVIEW_PARTITION] as const) {
    for (const url of [...REMOTE_REQUESTS, 'file:///ws/page.html', ...PDF_VIEWER_REQUESTS]) {
      assert.equal(isBlockedPreviewRequest({ partition, url, workspaceTrusted: true }), false, `${partition} ${url}`)
    }
  }
})

test('an untrusted HTML preview loads local files only', () => {
  const blocked = (url: string): boolean =>
    isBlockedPreviewRequest({ partition: HTML_PREVIEW_PARTITION, url, workspaceTrusted: false })
  for (const url of [toFileUrl('/ws/index.html'), 'file:///ws/style.css', 'file:///ws/img/logo.png']) {
    assert.equal(blocked(url), false, url)
  }
  for (const url of [...REMOTE_REQUESTS, ...PDF_VIEWER_REQUESTS]) {
    assert.equal(blocked(url), true, url)
  }
})

test('an untrusted PDF preview loads PDF files and the PDF viewer, nothing else', () => {
  const blocked = (url: string): boolean =>
    isBlockedPreviewRequest({ partition: PDF_PREVIEW_PARTITION, url, workspaceTrusted: false })
  for (const url of [...PDF_NAMES_OVER_HTML.map(toFileUrl), 'file:///ws/report.PDF', 'file://server/share/x.pdf', ...PDF_VIEWER_REQUESTS]) {
    assert.equal(blocked(url), false, url)
  }
  const refused = [
    ...REMOTE_REQUESTS,
    // Other local files, such as HTML a link in a PDF opens: the guest keeps
    // the scripts the viewer needs, so it loads PDF files only.
    'file:///ws/doc.html',
    'file:///ws/page.html?.pdf',
    'file:///etc/hostname',
    'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/script.js',
    'chrome://settings/',
    'chrome://resources@example.com/x.js',
  ]
  for (const url of refused) {
    assert.equal(blocked(url), true, url)
  }
})
