/**
 * Width math for the chat view's side panel.
 *
 * Extracted so the drag handlers and the render both read one set of bounds. They
 * previously disagreed: the file-tree drag clamped to a standalone literal while
 * the render clamped to a ceiling derived from the layout, so dragging pushed the
 * state past what was drawn. The pane looked stuck, and a drag back did nothing
 * until the invisible state re-entered range.
 */

/**
 * The editor and image panes carry this as a CSS min-width, so the file pane
 * beside them may not grow past `sidePanel - MIN_EDITOR_PANE_WIDTH` without
 * squeezing them out. One constant, so the reservation and the subtraction cannot
 * drift apart.
 */
export const MIN_EDITOR_PANE_WIDTH = 360

export const MIN_FILE_PANE_WIDTH = 220
export const MIN_SIDE_PANEL_WIDTH = 360
/** A file tree beside an editor needs room for both at once. */
export const MIN_SIDE_PANEL_WIDTH_WITH_EDITOR = 600
export const MAX_SIDE_PANEL_WIDTH = 1280

export const DEFAULT_SIDE_PANEL_WIDTH = 640
export const DEFAULT_FILE_PANE_WIDTH = 280

/**
 * The chat column keeps this width beside the side panel, so the panel gives up
 * room before the row scrolls. Only a row too narrow for both minimums scrolls.
 */
export const MIN_CHAT_COLUMN_WIDTH = 480

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Which panes the side panel is currently showing. */
export interface SidePanelPanes {
  showFileTree: boolean
  showEditor: boolean
  showImage: boolean
}

export interface SidePanelMetrics {
  /** The file tree fills the side panel on its own. */
  fileTreeOnly: boolean
  /** Lower bound for the side panel in the current layout. */
  minSidePanelWidth: number
  /** Upper bound for the side panel: what the row leaves beside the chat column. */
  maxSidePanelWidth: number
  /** Rendered width of the whole side panel. */
  contentWidth: number
  /** Rendered width of the file-tree pane. */
  filePaneWidth: number
  /** The one ceiling both the drag handlers and the render must respect. */
  maxFilePaneWidth: number
}

function isFileTreeOnly(panes: SidePanelPanes): boolean {
  return panes.showFileTree && !panes.showEditor && !panes.showImage
}

function minSidePanelWidthFor(panes: SidePanelPanes): number {
  return panes.showFileTree && !isFileTreeOnly(panes) ? MIN_SIDE_PANEL_WIDTH_WITH_EDITOR : MIN_SIDE_PANEL_WIDTH
}

/** The narrowest the side panel's content can be drawn: a lone file tree needs only its own pane. */
export function sidePanelContentMinWidth(panes: SidePanelPanes): number {
  return isFileTreeOnly(panes) ? MIN_FILE_PANE_WIDTH : minSidePanelWidthFor(panes)
}

/**
 * Resolve the rendered widths and the bounds a drag must clamp to.
 *
 * `resolveSidePanelMetrics(panes, sidePanel, metrics.filePaneWidth, rowWidth)` returns
 * the same `filePaneWidth` it was given — that fixed-point property is what keeps a
 * drag from moving state the render will not follow.
 *
 * `rowWidth` is the width the chat column and the side panel share; unmeasured,
 * it leaves the side panel its own bounds.
 */
export function resolveSidePanelMetrics(
  panes: SidePanelPanes,
  sidePanelWidth: number,
  filePaneWidth: number,
  rowWidth = Number.POSITIVE_INFINITY
): SidePanelMetrics {
  const fileTreeOnly = isFileTreeOnly(panes)
  const minSidePanelWidth = minSidePanelWidthFor(panes)
  const maxSidePanelWidth = clamp(rowWidth - MIN_CHAT_COLUMN_WIDTH, minSidePanelWidth, MAX_SIDE_PANEL_WIDTH)
  const sidePanel = clamp(sidePanelWidth, minSidePanelWidth, maxSidePanelWidth)

  // Alone, the file tree *is* the side panel, so there is nothing to reserve —
  // reserving anyway is what pinned it to a fraction of the panel.
  const maxFilePaneWidth = fileTreeOnly
    ? maxSidePanelWidth
    : Math.max(MIN_FILE_PANE_WIDTH, sidePanel - MIN_EDITOR_PANE_WIDTH)

  const filePane = clamp(filePaneWidth, MIN_FILE_PANE_WIDTH, maxFilePaneWidth)

  return {
    fileTreeOnly,
    minSidePanelWidth,
    maxSidePanelWidth,
    contentWidth: fileTreeOnly ? filePane : sidePanel,
    filePaneWidth: filePane,
    maxFilePaneWidth,
  }
}

/** Fixed width of the review panel when it sits beside the chat column. */
export const REVIEW_PANEL_WIDTH = 320

/** Where a pane shows: beside the chat column, or stacked under it. */
export type PanePlacement = 'beside' | 'stacked'

export interface PaneLayout {
  /** Null when the side panel is closed. */
  sidePanel: PanePlacement | null
  /** Null when the review panel is closed. */
  review: PanePlacement | null
  /** Width the chat column and a side panel beside it share. */
  sidePanelRowWidth: number
}

/**
 * Share the chat row between the chat column, the side panel and the review
 * panel so the row never scrolls sideways. The chat column keeps
 * MIN_CHAT_COLUMN_WIDTH; the side panel (the pane the user works in) claims
 * room before the review panel. A pane with no room beside the column moves
 * under it; the side panel comes first there too.
 *
 * `sidePanelMinWidth` is null while the side panel is closed.
 */
export function resolvePaneLayout(
  rowWidth: number,
  sidePanelMinWidth: number | null,
  reviewOpen: boolean
): PaneLayout {
  const room = rowWidth - MIN_CHAT_COLUMN_WIDTH
  const sidePanel = sidePanelMinWidth === null ? null : room >= sidePanelMinWidth ? 'beside' : 'stacked'
  const roomForReview = room - (sidePanel === 'beside' ? sidePanelMinWidth! : 0)
  const review = !reviewOpen ? null : roomForReview >= REVIEW_PANEL_WIDTH ? 'beside' : 'stacked'
  return {
    sidePanel,
    review,
    sidePanelRowWidth: rowWidth - (review === 'beside' ? REVIEW_PANEL_WIDTH : 0),
  }
}
