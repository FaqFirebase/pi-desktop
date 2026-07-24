import { clsx } from 'clsx'
import { highlightCodeToHtml } from './chat-code-highlight'

/**
 * Renders code as line-numbered, syntax-highlighted rows. Shared by file-read
 * tool results and markdown fenced blocks so both look identical.
 *
 * highlightCodeToHtml emits newlines separately from its <span> runs, so its
 * output splits cleanly on '\n' into self-contained per-line HTML; when no parser
 * matches it falls back to plain text. Base text color is inherited from the
 * caller; only the gutter is styled here.
 *
 * `onFirstLineClick`, when given, makes the first row a click target (used to
 * collapse the tool-result view).
 */
export function LineNumberedCode({
  content,
  lang,
  onFirstLineClick,
}: {
  content: string
  lang: string
  onFirstLineClick?: () => void
}): React.JSX.Element {
  const html = highlightCodeToHtml(content, lang)
  const lines = (html ?? content).split('\n')
  const gutter = `${String(lines.length).length}ch`

  return (
    <>
      {lines.map((line, i) => {
        const clickable = i === 0 && onFirstLineClick
        return (
          <div
            key={i}
            className={clsx('flex', clickable && 'cursor-pointer hover:bg-surface-hover/40')}
            onClick={clickable ? onFirstLineClick : undefined}
            title={clickable ? 'Collapse' : undefined}
          >
            <span
              className="mr-3 shrink-0 select-none text-right text-faint"
              style={{ minWidth: gutter }}
            >
              {i + 1}
            </span>
            {html !== null ? (
              <span className="whitespace-pre" dangerouslySetInnerHTML={{ __html: line || ' ' }} />
            ) : (
              <span className="whitespace-pre">{line || ' '}</span>
            )}
          </div>
        )
      })}
    </>
  )
}
