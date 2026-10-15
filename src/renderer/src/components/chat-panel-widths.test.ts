import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_FILE_PANE_WIDTH,
  DEFAULT_SIDE_PANEL_WIDTH,
  MAX_SIDE_PANEL_WIDTH,
  MIN_CHAT_COLUMN_WIDTH,
  MIN_EDITOR_PANE_WIDTH,
  MIN_FILE_PANE_WIDTH,
  MIN_SIDE_PANEL_WIDTH,
  MIN_SIDE_PANEL_WIDTH_WITH_EDITOR,
  PANE_GRID_AREA,
  REVIEW_PANEL_WIDTH,
  clamp,
  resolvePaneGrid,
  resolvePaneLayout,
  resolveSidePanelMetrics,
  type PaneGridTemplate,
  type PanePlacement,
} from './chat-panel-widths'

const FILE_TREE_ONLY = { showFileTree: true, showEditor: false, showImage: false }
const TREE_AND_EDITOR = { showFileTree: true, showEditor: true, showImage: false }
const TREE_AND_IMAGE = { showFileTree: true, showEditor: false, showImage: true }
const EDITOR_ONLY = { showFileTree: false, showEditor: true, showImage: false }

// ─── clamp ───────────────────────────────────────────────────────────────────

test('clamp bounds a value on both sides', () => {
  assert.equal(clamp(5, 1, 10), 5)
  assert.equal(clamp(-1, 1, 10), 1)
  assert.equal(clamp(99, 1, 10), 10)
})

// ─── The regression: a lone file tree could not be widened ───────────────────

test('a lone file tree can be widened past the editor reservation', () => {
  // Regression: maxFilePaneWidth was sidePanelWidth - MIN_EDITOR_PANE_WIDTH even
  // with no editor mounted, pinning a file-tree-only pane at 280px forever.
  const metrics = resolveSidePanelMetrics(FILE_TREE_ONLY, DEFAULT_SIDE_PANEL_WIDTH, 700)
  assert.equal(metrics.filePaneWidth, 700)
  assert.ok(
    metrics.maxFilePaneWidth > DEFAULT_SIDE_PANEL_WIDTH - MIN_EDITOR_PANE_WIDTH,
    `ceiling ${metrics.maxFilePaneWidth} still reserves room for an absent editor`
  )
})

test('a lone file tree may fill the whole side panel', () => {
  const metrics = resolveSidePanelMetrics(FILE_TREE_ONLY, DEFAULT_SIDE_PANEL_WIDTH, 9999)
  assert.equal(metrics.maxFilePaneWidth, MAX_SIDE_PANEL_WIDTH)
  assert.equal(metrics.filePaneWidth, MAX_SIDE_PANEL_WIDTH)
})

test('a lone file tree sets the side panel width', () => {
  // The pane IS the panel here, so the panel must not keep its own wider size.
  const metrics = resolveSidePanelMetrics(FILE_TREE_ONLY, DEFAULT_SIDE_PANEL_WIDTH, 420)
  assert.equal(metrics.contentWidth, 420)
  assert.equal(metrics.fileTreeOnly, true)
})

// ─── The invariant that prevents silent state drift ──────────────────────────

test('the resolved file pane width is a fixed point', () => {
  // The dead-zone bug: the drag handler clamped to a different ceiling than the
  // renderer, so the state drifted invisibly and a drag back did nothing until it
  // re-entered range. Feeding a resolved width back in must change nothing, which
  // is what lets both sides share one ceiling.
  for (const panes of [FILE_TREE_ONLY, TREE_AND_EDITOR, TREE_AND_IMAGE]) {
    for (const requested of [0, 100, 220, 280, 520, 700, 5000]) {
      const once = resolveSidePanelMetrics(panes, DEFAULT_SIDE_PANEL_WIDTH, requested)
      const twice = resolveSidePanelMetrics(panes, DEFAULT_SIDE_PANEL_WIDTH, once.filePaneWidth)
      assert.equal(
        twice.filePaneWidth,
        once.filePaneWidth,
        `not a fixed point for ${JSON.stringify(panes)} at ${requested}`
      )
    }
  }
})

// ─── File tree beside an editor or image ─────────────────────────────────────

test('the file pane leaves room for an editor beside it', () => {
  const metrics = resolveSidePanelMetrics(TREE_AND_EDITOR, 1000, 9999)
  assert.equal(metrics.maxFilePaneWidth, 1000 - MIN_EDITOR_PANE_WIDTH)
  assert.equal(metrics.filePaneWidth, 1000 - MIN_EDITOR_PANE_WIDTH)
})

test('the file pane leaves room for an image beside it', () => {
  const metrics = resolveSidePanelMetrics(TREE_AND_IMAGE, 1000, 9999)
  assert.equal(metrics.maxFilePaneWidth, 1000 - MIN_EDITOR_PANE_WIDTH)
})

test('a file tree beside an editor keeps the side panel width', () => {
  const metrics = resolveSidePanelMetrics(TREE_AND_EDITOR, 900, 300)
  assert.equal(metrics.contentWidth, 900)
  assert.equal(metrics.filePaneWidth, 300)
  assert.equal(metrics.fileTreeOnly, false)
})

test('showing an editor raises the side panel minimum', () => {
  assert.equal(
    resolveSidePanelMetrics(TREE_AND_EDITOR, 100, DEFAULT_FILE_PANE_WIDTH).minSidePanelWidth,
    MIN_SIDE_PANEL_WIDTH_WITH_EDITOR
  )
  assert.equal(
    resolveSidePanelMetrics(FILE_TREE_ONLY, 100, DEFAULT_FILE_PANE_WIDTH).minSidePanelWidth,
    MIN_SIDE_PANEL_WIDTH
  )
})

// ─── Bounds ──────────────────────────────────────────────────────────────────

test('the file pane never goes below its minimum', () => {
  assert.equal(resolveSidePanelMetrics(FILE_TREE_ONLY, 640, 10).filePaneWidth, MIN_FILE_PANE_WIDTH)
  assert.equal(resolveSidePanelMetrics(TREE_AND_EDITOR, 640, 10).filePaneWidth, MIN_FILE_PANE_WIDTH)
})

test('the file pane ceiling never drops below its minimum', () => {
  // A side panel narrower than the editor reservation would otherwise produce a
  // ceiling below the floor, and clamp(min > max) returns the max.
  const metrics = resolveSidePanelMetrics(TREE_AND_EDITOR, MIN_EDITOR_PANE_WIDTH, 300)
  assert.ok(metrics.maxFilePaneWidth >= MIN_FILE_PANE_WIDTH)
  assert.ok(metrics.filePaneWidth >= MIN_FILE_PANE_WIDTH)
})

test('the side panel is clamped to its own bounds', () => {
  assert.equal(
    resolveSidePanelMetrics(EDITOR_ONLY, 99_999, DEFAULT_FILE_PANE_WIDTH).contentWidth,
    MAX_SIDE_PANEL_WIDTH
  )
  assert.equal(
    resolveSidePanelMetrics(EDITOR_ONLY, 1, DEFAULT_FILE_PANE_WIDTH).contentWidth,
    MIN_SIDE_PANEL_WIDTH
  )
})

// ─── Sharing the row with the chat column ────────────────────────────────────

test('the side panel gives up width so the chat column keeps its minimum', () => {
  // Regression: a 1040px row held the 640px default panel beside the 480px chat
  // minimum, so the row scrolled and cut off the diff pane's right edge.
  const rowWidth = 1040
  const metrics = resolveSidePanelMetrics(EDITOR_ONLY, DEFAULT_SIDE_PANEL_WIDTH, DEFAULT_FILE_PANE_WIDTH, rowWidth)
  assert.equal(metrics.maxSidePanelWidth, rowWidth - MIN_CHAT_COLUMN_WIDTH)
  assert.equal(metrics.contentWidth, rowWidth - MIN_CHAT_COLUMN_WIDTH)
})

test('a row with room keeps the requested side panel width', () => {
  const metrics = resolveSidePanelMetrics(EDITOR_ONLY, DEFAULT_SIDE_PANEL_WIDTH, DEFAULT_FILE_PANE_WIDTH, 1600)
  assert.equal(metrics.contentWidth, DEFAULT_SIDE_PANEL_WIDTH)
  const wideRow = resolveSidePanelMetrics(EDITOR_ONLY, 99_999, DEFAULT_FILE_PANE_WIDTH, 99_999)
  assert.equal(wideRow.maxSidePanelWidth, MAX_SIDE_PANEL_WIDTH)
})

test('a row too narrow for both keeps the side panel minimum', () => {
  for (const panes of [EDITOR_ONLY, TREE_AND_EDITOR]) {
    const metrics = resolveSidePanelMetrics(panes, DEFAULT_SIDE_PANEL_WIDTH, DEFAULT_FILE_PANE_WIDTH, 700)
    assert.equal(metrics.maxSidePanelWidth, metrics.minSidePanelWidth)
    assert.equal(metrics.contentWidth, metrics.minSidePanelWidth)
  }
})

test('a lone file tree also leaves the chat column its minimum', () => {
  const rowWidth = 1040
  const metrics = resolveSidePanelMetrics(FILE_TREE_ONLY, DEFAULT_SIDE_PANEL_WIDTH, 900, rowWidth)
  assert.equal(metrics.maxFilePaneWidth, rowWidth - MIN_CHAT_COLUMN_WIDTH)
  assert.equal(metrics.contentWidth, rowWidth - MIN_CHAT_COLUMN_WIDTH)
  const again = resolveSidePanelMetrics(FILE_TREE_ONLY, DEFAULT_SIDE_PANEL_WIDTH, metrics.filePaneWidth, rowWidth)
  assert.equal(again.filePaneWidth, metrics.filePaneWidth)
})

test('the defaults sit inside their own bounds', () => {
  assert.ok(DEFAULT_FILE_PANE_WIDTH >= MIN_FILE_PANE_WIDTH)
  assert.ok(DEFAULT_SIDE_PANEL_WIDTH >= MIN_SIDE_PANEL_WIDTH_WITH_EDITOR)
  assert.ok(DEFAULT_SIDE_PANEL_WIDTH <= MAX_SIDE_PANEL_WIDTH)
  // The default panel must actually fit the default tree plus an editor.
  assert.ok(DEFAULT_SIDE_PANEL_WIDTH - MIN_EDITOR_PANE_WIDTH >= MIN_FILE_PANE_WIDTH)
})

// ─── Sharing the row between the chat column, side panel and review panel ───

// Chat rows measured in the live test: 1400px and 1000px windows with the
// sidebar and the tool rail open.
const ROW_AT_1400 = 1040
const ROW_AT_1000 = 640

test('side panel and review panel both sit beside a wide chat column', () => {
  const layout = resolvePaneLayout(1560, MIN_SIDE_PANEL_WIDTH, true)
  assert.deepEqual(layout, { sidePanel: 'beside', review: 'beside', sidePanelRowWidth: 1560 - REVIEW_PANEL_WIDTH })
})

test('at 1400px the diff stays beside the chat and the review panel moves under it', () => {
  const layout = resolvePaneLayout(ROW_AT_1400, MIN_SIDE_PANEL_WIDTH, true)
  assert.deepEqual(layout, { sidePanel: 'beside', review: 'stacked', sidePanelRowWidth: ROW_AT_1400 })
  const metrics = resolveSidePanelMetrics(EDITOR_ONLY, DEFAULT_SIDE_PANEL_WIDTH, DEFAULT_FILE_PANE_WIDTH, layout.sidePanelRowWidth)
  assert.ok(metrics.contentWidth + MIN_CHAT_COLUMN_WIDTH <= ROW_AT_1400)
})

test('at 1000px the diff and the review panel both move under the chat', () => {
  assert.deepEqual(resolvePaneLayout(ROW_AT_1000, MIN_SIDE_PANEL_WIDTH, false), {
    sidePanel: 'stacked', review: null, sidePanelRowWidth: ROW_AT_1000,
  })
  assert.deepEqual(resolvePaneLayout(ROW_AT_1000, MIN_SIDE_PANEL_WIDTH, true), {
    sidePanel: 'stacked', review: 'stacked', sidePanelRowWidth: ROW_AT_1000,
  })
})

test('a review panel alone moves under a chat column that has no room beside it', () => {
  assert.equal(resolvePaneLayout(ROW_AT_1000, null, true).review, 'stacked')
  assert.equal(resolvePaneLayout(MIN_CHAT_COLUMN_WIDTH + REVIEW_PANEL_WIDTH, null, true).review, 'beside')
})

test('nothing beside the chat column ever needs more than the row', () => {
  for (const rowWidth of [MIN_CHAT_COLUMN_WIDTH, ROW_AT_1000, 900, ROW_AT_1400, 1560, 2400]) {
    for (const sideMin of [null, MIN_FILE_PANE_WIDTH, MIN_SIDE_PANEL_WIDTH, MIN_SIDE_PANEL_WIDTH_WITH_EDITOR]) {
      for (const reviewOpen of [false, true]) {
        const layout = resolvePaneLayout(rowWidth, sideMin, reviewOpen)
        const besideWidth = (layout.sidePanel === 'beside' ? sideMin! : 0) + (layout.review === 'beside' ? REVIEW_PANEL_WIDTH : 0)
        assert.ok(MIN_CHAT_COLUMN_WIDTH + besideWidth <= rowWidth, `${rowWidth} ${sideMin} ${reviewOpen}`)
      }
    }
  }
})

// ─── One grid holds the chat column and both panes ───────────────────────────

const PLACEMENTS: (PanePlacement | null)[] = [null, 'beside', 'stacked']
const LAYOUTS = PLACEMENTS.flatMap((sidePanel) => PLACEMENTS.map((review) => ({ sidePanel, review })))

/** The template's area names, row by row. */
function areaRows(grid: PaneGridTemplate): string[][] {
  return [...grid.gridTemplateAreas.matchAll(/"([^"]+)"/g)].map(([, row]) => row.split(' '))
}

/** "minmax(0, 1fr) auto" -> ["minmax(0, 1fr)", "auto"] */
function tracks(trackList: string): string[] {
  return trackList.match(/minmax\([^)]*\)|\S+/g) ?? []
}

/** Each track's share of the free space ("minmax(0, 2fr)" -> 2). */
function shares(trackList: string): number[] {
  return tracks(trackList).map((track) => Number(/(\d+)fr\)$/.exec(track)?.[1]))
}

function openPanes(layout: (typeof LAYOUTS)[number]): [string, PanePlacement][] {
  const panes: [string, PanePlacement | null][] = [
    [PANE_GRID_AREA.sidePanel, layout.sidePanel],
    [PANE_GRID_AREA.review, layout.review],
  ]
  return panes.filter((pane): pane is [string, PanePlacement] => pane[1] !== null)
}

test('every open pane is a cell of the one row grid in every placement', () => {
  // Regression: a stacked side panel rendered in a container under the chat
  // column, a beside one directly in the row. Each change of place gave it
  // another parent, so React mounted it again: the editor in it read the file
  // from disk again and its unsaved edits were lost. One grid now holds the
  // chat column and both panes, and only its template moves them.
  for (const layout of LAYOUTS) {
    const cells = [...new Set(areaRows(resolvePaneGrid(layout)).flat())].sort()
    const expected = [PANE_GRID_AREA.chat, ...openPanes(layout).map(([area]) => area)].sort()
    assert.deepEqual(cells, expected, JSON.stringify(layout))
  }
})

test('a beside pane fills a column right of the chat column from top to bottom, in its own width', () => {
  for (const layout of LAYOUTS) {
    const grid = resolvePaneGrid(layout)
    const rows = areaRows(grid)
    for (const [area] of openPanes(layout).filter(([, placement]) => placement === 'beside')) {
      const column = rows[0].indexOf(area)
      assert.ok(column > 0, `${area} in ${JSON.stringify(layout)}`)
      assert.ok(rows.every((row) => row[column] === area), `${area} in ${JSON.stringify(layout)}`)
      // An auto track follows the width the pane sets on itself.
      assert.equal(tracks(grid.gridTemplateColumns)[column], 'auto')
    }
  }
})

test('a stacked pane fills a row under the chat column, across the chat column only', () => {
  for (const layout of LAYOUTS) {
    const rows = areaRows(resolvePaneGrid(layout))
    for (const [area] of openPanes(layout).filter(([, placement]) => placement === 'stacked')) {
      const row = rows.findIndex((cells) => cells[0] === area)
      assert.ok(row > 0, `${area} in ${JSON.stringify(layout)}`)
      // The beside columns go on through this row unchanged.
      assert.deepEqual(rows[row].slice(1), rows[0].slice(1), `${area} in ${JSON.stringify(layout)}`)
    }
  }
})

test('the chat column keeps the top half over stacked panes, which share the rest evenly', () => {
  assert.deepEqual(shares(resolvePaneGrid({ sidePanel: null, review: null }).gridTemplateRows), [1])
  assert.deepEqual(shares(resolvePaneGrid({ sidePanel: 'beside', review: 'beside' }).gridTemplateRows), [1])
  assert.deepEqual(shares(resolvePaneGrid({ sidePanel: 'stacked', review: 'beside' }).gridTemplateRows), [1, 1])
  assert.deepEqual(shares(resolvePaneGrid({ sidePanel: 'beside', review: 'stacked' }).gridTemplateRows), [1, 1])
  assert.deepEqual(shares(resolvePaneGrid({ sidePanel: 'stacked', review: 'stacked' }).gridTemplateRows), [2, 1, 1])
  for (const layout of LAYOUTS) {
    // A zero minimum: a pane's content never makes its row taller than its share.
    assert.ok(tracks(resolvePaneGrid(layout).gridTemplateRows).every((track) => track.startsWith('minmax(0,')))
  }
})

test('the chat column keeps its minimum width only while a pane is beside it', () => {
  for (const layout of LAYOUTS) {
    const paneBeside = openPanes(layout).some(([, placement]) => placement === 'beside')
    assert.equal(
      tracks(resolvePaneGrid(layout).gridTemplateColumns)[0],
      `minmax(${paneBeside ? MIN_CHAT_COLUMN_WIDTH : 0}px, 1fr)`,
      JSON.stringify(layout)
    )
  }
})

test('the side panel comes before the review panel, beside or stacked', () => {
  assert.deepEqual(areaRows(resolvePaneGrid({ sidePanel: 'beside', review: 'beside' })), [
    [PANE_GRID_AREA.chat, PANE_GRID_AREA.sidePanel, PANE_GRID_AREA.review],
  ])
  assert.deepEqual(areaRows(resolvePaneGrid({ sidePanel: 'stacked', review: 'stacked' })), [
    [PANE_GRID_AREA.chat], [PANE_GRID_AREA.sidePanel], [PANE_GRID_AREA.review],
  ])
})

test('at 1400px the side panel keeps the full height beside the chat and the review panel goes under it', () => {
  assert.deepEqual(areaRows(resolvePaneGrid(resolvePaneLayout(ROW_AT_1400, MIN_SIDE_PANEL_WIDTH, true))), [
    [PANE_GRID_AREA.chat, PANE_GRID_AREA.sidePanel],
    [PANE_GRID_AREA.review, PANE_GRID_AREA.sidePanel],
  ])
})
