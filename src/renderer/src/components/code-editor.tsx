import { useEffect, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { syntaxHighlighting } from '@codemirror/language'
import { getCodeEditorLanguageExtensions } from './code-editor-language'
import { themedHighlightStyle } from './code-editor-highlight'
import { useAppStore } from '../store'
import { isLightTheme } from '../utils/theme'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'

interface CodeEditorProps {
  filePath: string
  value: string
  readOnly?: boolean
  onChange?: (value: string) => void
}

export function CodeEditor({
  filePath,
  value,
  readOnly = true,
  onChange,
}: CodeEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const theme = useAppStore((state) => state.settings?.theme)
  const lightTheme = isLightTheme(theme)
  const fontSize = useAppStore((state) => state.settingsDraft.codeEditorFontSize ?? state.settings?.codeEditorFontSize)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!containerRef.current) return

    // Clear any leftover DOM from a previous view before mounting the new one
    containerRef.current.innerHTML = ''

    // Tell CodeMirror whether the active app theme is dark so its base theme
    // picks the right fallback styles (drop cursor, selection layer, etc.).

    const view = new EditorView({
      doc: value,
      parent: containerRef.current,
      extensions: [
        basicSetup,
        ...getCodeEditorLanguageExtensions(filePath),
        // Must NOT be { fallback: true } — basicSetup registers
        // defaultHighlightStyle as non-fallback, so a fallback registration
        // here would lose to its near-grayscale palette.
        syntaxHighlighting(themedHighlightStyle),
        EditorView.editable.of(!readOnly),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString())
          }
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            backgroundColor: 'var(--color-bg-primary)',
            color: 'var(--color-text-primary)',
            fontSize: `${fontSize ?? DEFAULT_SETTINGS.codeEditorFontSize}px`,
          },
          '.cm-editor': {
            height: '100%',
          },
          '.cm-scroller': {
            fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'OpenMoji Color', 'Fira Code', 'Cascadia Code', monospace",
          },
          '.cm-content': {
            caretColor: 'var(--color-text-primary)',
          },
          '.cm-gutters': {
            backgroundColor: 'var(--color-bg-primary)',
            color: 'var(--color-text-muted)',
            borderRight: '1px solid var(--color-border)',
          },
          '.cm-activeLine': {
            backgroundColor: 'var(--cm-active-line-bg)',
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'var(--cm-active-line-bg)',
          },
          '.cm-selectionMatch': {
            backgroundColor: 'var(--cm-selection-match-bg)',
          },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
            backgroundColor: 'var(--cm-selection-bg)',
          },
          '&.cm-focused': {
            outline: 'none',
          },
        }, { dark: !lightTheme }),
      ],
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // `value` is intentionally omitted: it only seeds the initial doc here.
    // Subsequent changes are applied via dispatch in the effect below so the
    // view (cursor position, undo history) isn't torn down on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, readOnly, lightTheme, fontSize])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const current = view.state.doc.toString()
    if (current === value) return

    view.dispatch({
      changes: {
        from: 0,
        to: current.length,
        insert: value,
      },
    })
  }, [value])

  return <div ref={containerRef} className="h-full min-h-0" />
}
