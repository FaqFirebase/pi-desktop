// <webview> partitions of the file preview (file-tree.tsx). Main hardens each
// guest by its partition name (main/preview-guest.ts), so both sides use these.

/** The HTML preview. It runs scripts and loads network only for a trusted workspace. */
export const HTML_PREVIEW_PARTITION = 'preview'
/** The PDF preview, rendered by Chromium's built-in viewer (pdfium needs plugins). */
export const PDF_PREVIEW_PARTITION = 'persist:pdf-preview'
export type PreviewPartition = typeof HTML_PREVIEW_PARTITION | typeof PDF_PREVIEW_PARTITION
export const PREVIEW_PARTITIONS: readonly PreviewPartition[] = [HTML_PREVIEW_PARTITION, PDF_PREVIEW_PARTITION]

/**
 * The Browser pane (components/browser-pane.tsx). In memory only (no `persist:`
 * prefix), so cookies end with the app. Main hardens it with its own rules in
 * main/browser-pane-session.ts. It is not a file preview and not in PREVIEW_PARTITIONS.
 */
export const BROWSER_PANE_PARTITION = 'browser-pane'
