// Pure decisions for the file-preview <webview> guests (see file-tree.tsx).
// Kept free of any `electron` import so they can be unit-tested under a plain
// Node runtime; index.ts applies them in will-attach-webview and on the two
// partitions' webRequest.

import { PDF_PREVIEW_PARTITION, type PreviewPartition } from '../shared/preview-partitions'

const FILE_PROTOCOL = 'file:'
const PDF_EXTENSION = '.pdf'

// The PDF viewer runs inside the guest: a component extension with this fixed
// id, which loads its pages from its own origin and shared files from
// chrome://resources. Both are served from Electron's bundled resources, never
// from the network. They are the only non-file requests seen while a PDF loads
// and renders (checked on Electron 43); blocking them leaves a blank pane.
const PDF_VIEWER_ORIGINS: ReadonlySet<string> = new Set([
  'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai',
  'chrome://resources',
])

export interface PreviewGuest {
  /** The <webview> `partition` attribute. */
  partition?: string
  /** The <webview> `src` attribute. */
  src: string
  workspaceTrusted: boolean
}

export interface PreviewGuestPreferences {
  plugins: boolean
  javascript: boolean
}

export interface PreviewRequest {
  partition: PreviewPartition
  url: string
  workspaceTrusted: boolean
}

/** `url` parsed, when it is a local file URL. */
function parseFileUrl(url: string): URL | null {
  const parsed = URL.parse(url)
  return parsed?.protocol === FILE_PROTOCOL ? parsed : null
}

/**
 * True when `url` loads a local file whose name ends in .pdf. Only the path
 * counts: a `.pdf` in the query or fragment does not change the file that
 * loads, and Chromium picks a file's type from its name.
 */
function isPdfFileUrl(url: string): boolean {
  const parsed = parseFileUrl(url)
  if (!parsed) return false
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch (error) {
    // An escape that does not decode never comes from toFileUrl; refuse it.
    if (error instanceof URIError) return false
    throw error
  }
  return path.toLowerCase().endsWith(PDF_EXTENSION)
}

function isPdfViewerRequest(url: string): boolean {
  const parsed = URL.parse(url)
  return parsed !== null && PDF_VIEWER_ORIGINS.has(`${parsed.protocol}//${parsed.host}`)
}

/**
 * The guest is the PDF preview only when it is in the PDF partition AND its src
 * loads a .pdf file: the partition alone does not say which file the src loads.
 */
function isPdfPreviewGuest(guest: PreviewGuest): boolean {
  return guest.partition === PDF_PREVIEW_PARTITION && isPdfFileUrl(guest.src)
}

/**
 * Plugins and scripts for a preview guest. The PDF preview gets plugins
 * (pdfium) and keeps scripts, because the viewer runs inside the guest and does
 * not start without them. Every other guest has plugins off and runs scripts
 * only for a trusted workspace.
 */
export function previewGuestPreferences(guest: PreviewGuest): PreviewGuestPreferences {
  const pdfPreview = isPdfPreviewGuest(guest)
  return { plugins: pdfPreview, javascript: pdfPreview || guest.workspaceTrusted }
}

/**
 * Whether a preview partition cancels a request. A trusted workspace's previews
 * load anything. For an untrusted workspace, the HTML preview loads local files
 * only. The PDF preview loads .pdf files and the viewer's own files only: its
 * guest runs scripts, so nothing (a link in a PDF, for example) may open any
 * other file there.
 */
export function isBlockedPreviewRequest(request: PreviewRequest): boolean {
  if (request.workspaceTrusted) return false
  if (request.partition === PDF_PREVIEW_PARTITION) {
    return !isPdfFileUrl(request.url) && !isPdfViewerRequest(request.url)
  }
  return parseFileUrl(request.url) === null
}
