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
  /** Rendered width of the whole side panel. */
  contentWidth: number
  /** Rendered width of the file-tree pane. */
  filePaneWidth: number
  /** The one ceiling both the drag handlers and the render must respect. */
  maxFilePaneWidth: number
}

/**
 * Resolve the rendered widths and the bounds a drag must clamp to.
 *
 * `resolveSidePanelMetrics(panes, sidePanel, metrics.filePaneWidth)` returns the
 * same `filePaneWidth` it was given — that fixed-point property is what keeps a
 * drag from moving state the render will not follow.
 */
export function resolveSidePanelMetrics(
  panes: SidePanelPanes,
  sidePanelWidth: number,
  filePaneWidth: number
): SidePanelMetrics {
  const besideAnotherPane = panes.showEditor || panes.showImage
  const fileTreeOnly = panes.showFileTree && !besideAnotherPane

  const minSidePanelWidth =
    panes.showFileTree && besideAnotherPane
      ? MIN_SIDE_PANEL_WIDTH_WITH_EDITOR
      : MIN_SIDE_PANEL_WIDTH
  const sidePanel = clamp(sidePanelWidth, minSidePanelWidth, MAX_SIDE_PANEL_WIDTH)

  // Alone, the file tree *is* the side panel, so there is nothing to reserve —
  // reserving anyway is what pinned it to a fraction of the panel.
  const maxFilePaneWidth = fileTreeOnly
    ? MAX_SIDE_PANEL_WIDTH
    : Math.max(MIN_FILE_PANE_WIDTH, sidePanel - MIN_EDITOR_PANE_WIDTH)

  const filePane = clamp(filePaneWidth, MIN_FILE_PANE_WIDTH, maxFilePaneWidth)

  return {
    fileTreeOnly,
    minSidePanelWidth,
    contentWidth: fileTreeOnly ? filePane : sidePanel,
    filePaneWidth: filePane,
    maxFilePaneWidth,
  }
}
