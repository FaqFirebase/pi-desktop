import { useState } from 'react'
import { clsx } from 'clsx'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useContextMenu, buildCodeBlockContextMenu, buildLinkContextMenu } from './context-menu'
import { CopyButton } from './copy-button'
import { LineNumberedCode } from './line-numbered-code'
import { splitReadTruncationNote } from '../message-grouping'
import { looksLikeFilePath, openFileFromChat } from './chat-file-link'
import { ErrorBoundary } from './error-boundary'
import { Code2, Eye } from 'lucide-react'

interface MarkdownRendererProps {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps): React.JSX.Element {
  const { show, ContextMenuComponent } = useContextMenu()

  return (
    <ErrorBoundary
      fallback={<pre className="whitespace-pre-wrap break-words text-secondary">{content}</pre>}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links — right-click for context menu
          a: ({ href, children, ...props }) => (
            <a
              {...props}
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (href) {
                  window.piDesktop.system.openExternal(href)
                }
              }}
              onContextMenu={(e) => {
                if (href) {
                  show(e, buildLinkContextMenu(href))
                }
              }}
              className="text-accent-fg hover:underline cursor-pointer"
            >
              {children}
            </a>
          ),

          // Code blocks — right-click to copy
          pre: (props) => {
            const p = props as Record<string, unknown>
            const children = p.children as React.ReactNode
            const codeText = extractCodeText(children)

            // A fenced block whose content is a complete SVG document renders as
            // an image (with a source toggle), regardless of the fence's language
            // tag — models emit SVG under ```svg / ```xml / ```html or untagged.
            if (isRenderableSvg(codeText)) {
              return <SvgBlock raw={codeText.replace(/\n$/, '')} />
            }

            return (
              <pre
                className="relative"
                onContextMenu={(e) => {
                  if (codeText) {
                    show(e, buildCodeBlockContextMenu(codeText))
                  }
                }}
              >
                {children}
                <CopyButton text={codeText} className="absolute right-1.5 top-1.5" />
              </pre>
            )
          },

          // Inline code — right-click to copy
          code: (props) => {
            const p = props as Record<string, unknown>
            const children = p.children as React.ReactNode
            const className = p.className as string | undefined

            // Fenced code block: highlight with the same CodeMirror pipeline the
            // code editor uses. `language-xxx` class is added by mdast-util-to-hast
            // from the fence info string. Context menu is handled by the pre wrapper.
            if (className?.includes('language-')) {
              const lang = className.replace(/^.*language-/, '').split(/\s+/)[0]
              const raw = extractCodeText(children).replace(/\n$/, '')
              // Models often paste a truncated read verbatim; peel Pi's
              // "[N more lines in file…]" footer out of the fence so it renders as
              // a note rather than syntax-highlighted code. Line-numbered via the
              // same component as file-read tool results so both look identical.
              const { code: codeBody, note } = splitReadTruncationNote(raw)
              return (
                <code className={className}>
                  <LineNumberedCode content={codeBody} lang={lang} />
                  {note && <div className="mt-2 text-xs italic text-dim">{note}</div>}
                </code>
              )
            }

            const inlineText = typeof children === 'string' ? children : ''

            // Inline code that reads like a real filename opens in the editor;
            // everything else (keywords, function names, literals) copies on click.
            if (looksLikeFilePath(inlineText)) {
              return (
                <code
                  className="chat-file-link"
                  onClick={() => {
                    void openFileFromChat(inlineText)
                  }}
                  onContextMenu={(e) => {
                    show(e, buildCodeBlockContextMenu(inlineText))
                  }}
                >
                  {children}
                </code>
              )
            }

            return (
              <code
                onClick={() => {
                  if (inlineText) navigator.clipboard.writeText(inlineText)
                }}
                onContextMenu={(e) => {
                  if (inlineText) {
                    show(e, buildCodeBlockContextMenu(inlineText))
                  }
                }}
              >
                {children}
              </code>
            )
          },

          // Tables
          table: ({ children, ...props }) => (
            <div className="overflow-x-auto">
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
      {ContextMenuComponent}
    </ErrorBoundary>
  )
}

/**
 * True when `text` is a self-contained SVG document — an optional XML prolog or
 * comment, then a root <svg> element through a closing </svg>. Used to decide
 * whether a fenced code block should render as an image.
 */
function isRenderableSvg(text: string): boolean {
  const t = text.trim()
  return /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(t) && /<\/svg>\s*$/i.test(t)
}

/**
 * Renders SVG markup as an image with a toggle to view its source. The image is
 * a `data:` URI in an <img>, which the browser treats as "secure static mode":
 * no scripts, no external resource loads, no interactivity — so untrusted SVG
 * from model/tool output can't run code or phone home.
 */
function SvgBlock({ raw }: { raw: string }): React.JSX.Element {
  const [showSource, setShowSource] = useState(false)
  const src = `data:image/svg+xml;utf8,${encodeURIComponent(raw)}`

  return (
    <div className="relative my-2 overflow-hidden rounded-lg border border-border bg-surface/50">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowSource(true)}
            className={clsx(
              'rounded p-1 transition-colors',
              showSource ? 'bg-card text-primary' : 'text-dim hover:bg-surface-hover/50 hover:text-secondary'
            )}
            title="View source"
            aria-label="View source"
          >
            <Code2 size={14} />
          </button>
          <button
            onClick={() => setShowSource(false)}
            className={clsx(
              'rounded p-1 transition-colors',
              !showSource ? 'bg-card text-primary' : 'text-dim hover:bg-surface-hover/50 hover:text-secondary'
            )}
            title="Render SVG"
            aria-label="Render SVG"
          >
            <Eye size={14} />
          </button>
        </div>
        <CopyButton text={raw} />
      </div>
      {showSource ? (
        // No padding on the <pre>; the inner <code> gets `.markdown-body pre code`
        // padding, matching a normal code block (avoids doubling it). Square off
        // the `.markdown-body pre` radius/border so it sits flush under the toolbar.
        <pre className="m-0 overflow-x-auto rounded-none border-0">
          <code className="language-svg">
            <LineNumberedCode content={raw} lang="svg" />
          </code>
        </pre>
      ) : (
        <div className="flex justify-center p-3">
          <img src={src} alt="Rendered SVG" className="max-h-[480px] max-w-full" />
        </div>
      )}
    </div>
  )
}

/**
 * Extract plain text from code block children.
 */
function extractCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) {
    return children.map(extractCodeText).join('')
  }
  if (children && typeof children === 'object') {
    const el = children as { props?: { children?: unknown } }
    if (el.props?.children) {
      return extractCodeText(el.props.children as React.ReactNode)
    }
  }
  return ''
}
