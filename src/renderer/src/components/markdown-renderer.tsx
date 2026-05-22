import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useContextMenu, buildCodeBlockContextMenu, buildLinkContextMenu } from './context-menu'

interface MarkdownRendererProps {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps): React.JSX.Element {
  const { show, ContextMenuComponent } = useContextMenu()

  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
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
              className="text-blue-400 hover:text-blue-300 hover:underline cursor-pointer"
            >
              {children}
            </a>
          ),

          // Code blocks — right-click to copy
          pre: (props) => {
            const p = props as Record<string, unknown>
            const children = p.children as React.ReactNode
            const codeText = extractCodeText(children)

            return (
              <pre
                className="relative group"
                onContextMenu={(e) => {
                  if (codeText) {
                    show(e, buildCodeBlockContextMenu(codeText))
                  }
                }}
              >
                {children}
                <button
                  onClick={() => {
                    if (codeText) {
                      navigator.clipboard.writeText(codeText)
                    }
                  }}
                  className="absolute top-2 right-2 rounded px-2 py-1 text-xs text-neutral-500 opacity-0 group-hover:opacity-100 bg-neutral-800 hover:text-neutral-300 transition-all"
                >
                  Copy
                </button>
              </pre>
            )
          },

          // Inline code — right-click to copy
          code: (props) => {
            const p = props as Record<string, unknown>
            const children = p.children as React.ReactNode
            const isBlock = p.className as string | undefined

            // Don't add context menu to code blocks (handled by pre)
            if (isBlock?.includes('language-')) {
              return <code {...(p as React.HTMLAttributes<HTMLElement>)}>{children}</code>
            }

            return (
              <code
                className="cursor-pointer hover:bg-white/10 rounded px-0.5 transition-colors"
                onClick={() => {
                  const text = typeof children === 'string' ? children : ''
                  if (text) navigator.clipboard.writeText(text)
                }}
                onContextMenu={(e) => {
                  const text = typeof children === 'string' ? children : ''
                  if (text) {
                    show(e, buildCodeBlockContextMenu(text))
                  }
                }}
                title="Click to copy"
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
    </>
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
