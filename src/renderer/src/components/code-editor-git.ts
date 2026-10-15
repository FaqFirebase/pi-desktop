import { MapMode, RangeSet, StateEffect, StateField, type Range, type Text } from '@codemirror/state'
import { EditorView, GutterMarker, gutter } from '@codemirror/view'

export interface GitLineMarker {
  line: number
  kind: 'added' | 'modified' | 'deleted'
}

/** Parse a single file's unified diff, using worktree line numbers. */
export function parseGitLineMarkers(diff: string): GitLineMarker[] {
  const markers: GitLineMarker[] = []
  let line = 1
  let inHunk = false
  let added = 0
  let removed = 0

  const flush = () => {
    for (let i = 0; i < added; i++) {
      markers.push({ line: line + i, kind: i < removed ? 'modified' : 'added' })
    }
    line += added
    if (removed > added) markers.push({ line, kind: 'deleted' })
    added = 0
    removed = 0
  }

  for (const text of diff.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text)
    if (header) {
      flush()
      line = Math.max(1, Number(header[1]) + (header[2] === '0' ? 1 : 0))
      inHunk = true
    } else if (text.startsWith('diff --git ')) {
      flush()
      inHunk = false
    } else if (inHunk) {
      if (text.startsWith('+')) added++
      else if (text.startsWith('-')) removed++
      else if (text.startsWith(' ')) {
        flush()
        line++
      }
      // The "no newline at end of file" annotation consumes no line.
    }
  }
  flush()
  return markers
}

class GitGutterMarker extends GutterMarker {
  startSide = 1
  endSide = 1
  mapMode = MapMode.TrackAfter

  constructor(readonly kind: GitLineMarker['kind'], readonly atEnd = false) {
    super()
  }

  eq(other: GitGutterMarker): boolean {
    return this.kind === other.kind && this.atEnd === other.atEnd
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = `cm-git-marker cm-git-${this.kind}${this.atEnd ? ' cm-git-at-end' : ''}`
    element.setAttribute('aria-hidden', 'true')
    return element
  }
}

export const setGitLineMarkers = StateEffect.define<GitLineMarker[]>()

function markerRanges(doc: Text, markers: GitLineMarker[]): RangeSet<GutterMarker> {
  return RangeSet.of(markers.map(({ line, kind }) => {
    const atEnd = line > doc.lines
    const position = doc.line(Math.min(line, doc.lines)).from
    return new GitGutterMarker(kind, atEnd).range(position)
  }), true)
}

export const gitLineMarkers = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    if (transaction.docChanged) {
      const ranges: Range<GutterMarker>[] = []
      const cursor = markers.map(transaction.changes).iter()
      while (cursor.value) {
        ranges.push(cursor.value.range(transaction.state.doc.lineAt(cursor.from).from))
        cursor.next()
      }
      markers = RangeSet.of(ranges, true)
    }
    for (const effect of transaction.effects) {
      if (effect.is(setGitLineMarkers)) markers = markerRanges(transaction.state.doc, effect.value)
    }
    return markers
  },
})

export const gitGutter = [
  gitLineMarkers,
  gutter({
    class: 'cm-git-gutter',
    markers: (view) => view.state.field(gitLineMarkers),
    initialSpacer: () => new GitGutterMarker('added'),
  }),
  EditorView.baseTheme({
    '.cm-git-gutter': { width: '8px' },
    '.cm-git-gutter .cm-gutterElement': { position: 'relative', padding: '0', width: '8px' },
    '.cm-git-marker': { position: 'absolute', left: '2px', width: '3px', height: '100%' },
    '.cm-git-added': { backgroundColor: 'var(--color-success)' },
    '.cm-git-modified': { backgroundColor: 'var(--color-info)' },
    '.cm-git-deleted': {
      width: '0',
      height: '0',
      top: '-3px',
      borderTop: '3px solid transparent',
      borderBottom: '3px solid transparent',
      borderLeft: '5px solid var(--color-error)',
    },
    '.cm-git-deleted.cm-git-at-end': { top: 'auto', bottom: '-3px' },
  }),
]
