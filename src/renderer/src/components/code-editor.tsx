import { useEffect, useRef, useState } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { syntaxHighlighting } from '@codemirror/language'
import { getCodeEditorLanguageExtensions } from './code-editor-language'
import { themedHighlightStyle } from './code-editor-highlight'
import { useAppStore } from '../store'
import { useAppliedThemeId } from '../hooks'
import { isLightTheme } from '../utils/theme'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { gitGutter, parseGitLineMarkers, setGitLineMarkers } from './code-editor-git'
import { createStaleGuard } from '../utils/stale-guard'
import { formatIpcError } from '../utils/ipc-error'

interface GitDiffSnapshot {
  filePath: string
  workspaceKey: string | null
  savedValue: string
  diff: string
  error: string | null
}

interface CodeEditorProps {
  filePath: string
  value: string
  savedValue: string
  readOnly?: boolean
  onChange?: (value: string) => void
}

export function CodeEditor({
  filePath,
  value,
  savedValue,
  readOnly = true,
  onChange,
}: CodeEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const lightTheme = isLightTheme(useAppliedThemeId())
  const fontSize = useAppStore((state) => state.settingsDraft.codeEditorFontSize ?? state.settings?.codeEditorFontSize)
  const workspace = useAppStore((state) => state.activeWorkspace)
  const workspaceKey = workspace ? `${workspace.id}:${workspace.path}` : null
  const [gitSnapshot, setGitSnapshot] = useState<GitDiffSnapshot | null>(null)
  const snapshot = gitSnapshot?.filePath === filePath
    && gitSnapshot.workspaceKey === workspaceKey && gitSnapshot.savedValue === savedValue
    ? gitSnapshot : null
  const diff = snapshot?.diff ?? ''

  useEffect(() => {
    if (!workspaceKey) return
    const guard = createStaleGuard()
    let disposed = false
    const load = async () => {
      const isCurrent = guard.begin()
      try {
        const diff = await window.piDesktop.files.getDiff(filePath)
        if (disposed || !isCurrent()) return
        const diskValue = await window.piDesktop.files.read(filePath)
        if (disposed || !isCurrent()) return
        // External writes must not put disk line numbers on an older editor buffer.
        setGitSnapshot({ filePath, workspaceKey, savedValue, diff: diskValue === savedValue ? diff : '', error: null })
      } catch (err) {
        if (disposed || !isCurrent()) return
        setGitSnapshot({ filePath, workspaceKey, savedValue, diff: '', error: formatIpcError(err) })
      }
    }
    void load()
    const unsubscribe = window.piDesktop.onFileChange(() => { void load() })
    const onFocus = () => { void load() }
    window.addEventListener('focus', onFocus)
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [filePath, savedValue, workspaceKey])

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
        gitGutter,
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
            backgroundColor: 'var(--color-app)',
            color: 'var(--color-primary)',
            fontSize: `${fontSize ?? DEFAULT_SETTINGS.codeEditorFontSize}px`,
          },
          '.cm-editor': {
            height: '100%',
          },
          '.cm-scroller': {
            fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'OpenMoji Color', 'Fira Code', 'Cascadia Code', monospace",
          },
          '.cm-content': {
            caretColor: 'var(--color-primary)',
          },
          '.cm-gutters': {
            backgroundColor: 'var(--color-app)',
            color: 'var(--color-muted)',
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
  }, [filePath, workspaceKey, readOnly, lightTheme, fontSize])

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

  useEffect(() => {
    const view = viewRef.current
    // While editing, CodeMirror maps the last saved markers through local changes.
    // A fresh Git result uses saved-file coordinates and is applied only to that text.
    if (!view || view.state.doc.toString() !== savedValue) return
    view.dispatch({ effects: setGitLineMarkers.of(parseGitLineMarkers(diff)) })
  }, [diff, savedValue, value, filePath, workspaceKey, readOnly, lightTheme, fontSize])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {snapshot?.error && <div className="px-3 py-1 text-xs text-error" role="status">{snapshot.error}</div>}
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  )
}
