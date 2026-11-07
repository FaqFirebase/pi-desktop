import type { Element, ElementContent, Root as HastRoot } from 'hast'
import type { Literal, Node, Parent } from 'unist'
import type { PluggableList } from 'unified'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import katex from 'katex'
import { createElement, type ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'

// Math in chat markdown. Money must never turn into math: not "$5 and $10",
// and not price tiers such as "$$" or "$$$". So:
// - Single-dollar `$x$` math is opt-in (the singleDollarMath setting).
// - `$$x$$` is math only when it stands alone on its line (display math).
//   Inside a sentence it stays text.
// - `$$` blocks on their own lines and ```math blocks are display math.
// - LaTeX `\(x\)` (inline) and `\[x\]` (display) are rewritten to `$$x$$`
//   before rendering, with a mark that keeps them math anywhere in a line.
// - A `$$` block only closes on a line of its own. A block that closes at the
//   end of a text line instead is rewritten to one-line math; a block that
//   cannot be repaired has its opening `$$` escaped, so it shows as text and
//   never swallows the rest of the reply.
// - A streaming reply re-renders on every token. Each formula is drawn once
//   into cached KaTeX HTML and shown through one span (MathSpan), so React
//   compares one string per formula instead of rebuilding its many nodes.

const MATH_FENCE = '$$'
const INLINE_OPEN = '\\('
const INLINE_CLOSE = '\\)'
const DISPLAY_OPEN = '\\['
const DISPLAY_CLOSE = '\\]'
const DELIMITER_LENGTH = 2
const BACKSLASH = '\\'
const DOLLAR = '$'
const ESCAPED_DOLLAR = '\\$'

// Private-use characters put at the start of rewritten math. No model or user
// text carries them, so they tell rewritten math apart from typed `$$x$$`.
const INLINE_MATH_MARK = '\uE000'
const DISPLAY_MATH_MARK = '\uE001'

// Node types whose source text is never prose: code, existing math, raw HTML,
// and link or image targets. Delimiters inside them stay as typed.
const VERBATIM_NODE_TYPES = new Set([
  'code',
  'inlineCode',
  'math',
  'inlineMath',
  'html',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'definition',
])
const MATH_BLOCK_TYPES = new Set(['math'])

const BLANK_LINE = /\n[ \t]*\n/
const BLOCKQUOTE_CONTINUATION = /\n[ \t]*>/
const UNESCAPED_PERCENT = /(^|[^\\])%/
const LINE_BREAK_WITH_SPACE = /\s*\n\s*/g
const MATH_BLOCK_OPENER = /^([ \t]*)(\$\$+)(.*)$/
const MATH_BLOCK_CLOSER = /^[ \t>]*(\$\$+)[ \t]*$/
// What may stand before and after math that is alone on its line: blockquote
// and list markers before it, one punctuation mark after it.
const ALONE_LINE_LEAD = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?$/
const ALONE_LINE_TRAIL = /^[ \t]*[.,;:!?]?[ \t]*$/

const MATH_CLASS = 'language-math'
const INLINE_MATH_CLASS = 'math-inline'
const DISPLAY_MATH_CLASSES = [MATH_CLASS, 'math-display']
const KATEX_ERROR_CLASS = 'katex-error'
const RENDERED_MATH_CACHE_LIMIT = 1_000
// hast property for rendered math HTML; React receives it as data-math-html.
const MATH_HTML_PROPERTY = 'dataMathHtml'
const MATH_HTML_ATTRIBUTE = 'data-math-html'

interface InlineMathNode extends Literal {
  type: 'inlineMath'
  value: string
  data: {
    hProperties: { className: string[] }
    hChildren: Array<{ type: 'text'; value: string }>
  }
}

const remarkPluginsBySingleDollar = new Map<boolean, PluggableList>(
  [false, true].map((singleDollarMath) => [
    singleDollarMath,
    [remarkGfm, [remarkMath, { singleDollarTextMath: singleDollarMath }], remarkPlaceMath],
  ]),
)

/** Remark plugins for chat markdown; one stable list per setting value. */
export function markdownRemarkPlugins(singleDollarMath: boolean): PluggableList {
  return remarkPluginsBySingleDollar.get(singleDollarMath)!
}

export const markdownRehypePlugins: PluggableList = [rehypeRenderMath]

// Key: display flag + TeX source. Oldest entries go first when it is full.
const renderedMathCache = new Map<string, string>()

/**
 * react-markdown `span` component: shows rendered math HTML from KaTeX, which
 * escapes its input and allows no links, classes or styles from the TeX while
 * its `trust` option is off (the default). Other spans render as they are.
 */
export function MathSpan({ node: _node, ...props }: ComponentProps<'span'> & ExtraProps): React.JSX.Element {
  const html = (props as Record<string, unknown>)[MATH_HTML_ATTRIBUTE]
  if (typeof html !== 'string') return createElement('span', props)
  return createElement('span', { dangerouslySetInnerHTML: { __html: html } })
}

/**
 * Replace each math element with a span that carries its KaTeX HTML: a
 * `code.language-math` element, or the `pre` around one (display math).
 */
function rehypeRenderMath() {
  return (tree: HastRoot): void => {
    replaceMathElements(tree)
  }
}

function replaceMathElements(parent: HastRoot | Element): void {
  const children: ElementContent[] = []
  for (const child of parent.children as ElementContent[]) {
    if (child.type !== 'element') {
      children.push(child)
      continue
    }
    const math = mathCode(child)
    if (math) {
      children.push(renderMath(textContent(math), child !== math || !hasClass(math, INLINE_MATH_CLASS)))
      continue
    }
    replaceMathElements(child)
    children.push(child)
  }
  parent.children = children
}

/** The math `code` element this element is or wraps, if any. */
function mathCode(element: Element): Element | null {
  if (element.tagName === 'code' && hasClass(element, MATH_CLASS)) return element
  if (element.tagName !== 'pre') return null
  const only = element.children.length === 1 ? element.children[0] : null
  return only?.type === 'element' && only.tagName === 'code' && hasClass(only, MATH_CLASS) ? only : null
}

function hasClass(element: Element, name: string): boolean {
  const classes = element.properties.className
  return Array.isArray(classes) && classes.includes(name)
}

function textContent(node: ElementContent): string {
  if (node.type === 'text') return node.value
  return node.type === 'element' ? node.children.map(textContent).join('') : ''
}

function renderMath(tex: string, displayMode: boolean): ElementContent {
  const key = `${displayMode}:${tex}`
  let html = renderedMathCache.get(key)
  if (html === undefined) {
    try {
      // Invalid TeX comes back as KaTeX's red error text, not an exception.
      html = katex.renderToString(tex, { displayMode, throwOnError: false })
    } catch (error) {
      return {
        type: 'element',
        tagName: 'span',
        properties: { className: [KATEX_ERROR_CLASS], title: String(error) },
        children: [{ type: 'text', value: tex }],
      }
    }
    if (renderedMathCache.size >= RENDERED_MATH_CACHE_LIMIT) {
      renderedMathCache.delete(renderedMathCache.keys().next().value!)
    }
    renderedMathCache.set(key, html)
  }
  return { type: 'element', tagName: 'span', properties: { [MATH_HTML_PROPERTY]: html }, children: [] }
}

/**
 * Decide how each piece of inline math shows: rewritten math by its mark,
 * typed `$$x$$` as display math when alone on its line and as text otherwise,
 * single-dollar math (when on) inline.
 */
function remarkPlaceMath() {
  return (tree: Node, file: { value: unknown }): void => {
    placeMath(tree, String(file.value))
  }
}

function placeMath(node: Node, source: string): void {
  const children = (node as Partial<Parent>).children
  if (!children) return
  children.forEach((child, index) => {
    if (child.type === 'inlineMath') children[index] = placeInlineMath(child as InlineMathNode, source)
    else placeMath(child, source)
  })
}

function placeInlineMath(node: InlineMathNode, source: string): Node {
  if (takeMark(node, DISPLAY_MATH_MARK)) return asDisplayMath(node)
  if (takeMark(node, INLINE_MATH_MARK)) return node
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined || !source.startsWith(MATH_FENCE, start)) return node
  if (isAloneOnLine(source, start, end)) return asDisplayMath(node)
  return { type: 'text', value: source.slice(start, end), position: node.position } as Literal
}

function takeMark(node: InlineMathNode, mark: string): boolean {
  if (!node.value.startsWith(mark)) return false
  node.value = node.value.slice(mark.length)
  node.data.hChildren = [{ type: 'text', value: node.value }]
  return true
}

function asDisplayMath(node: InlineMathNode): InlineMathNode {
  node.data.hProperties = { className: DISPLAY_MATH_CLASSES }
  return node
}

function isAloneOnLine(source: string, start: number, end: number): boolean {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const newline = source.indexOf('\n', end)
  const lineEnd = newline < 0 ? source.length : newline
  return ALONE_LINE_LEAD.test(source.slice(lineStart, start)) && ALONE_LINE_TRAIL.test(source.slice(end, lineEnd))
}

/**
 * Rewrite math markup that remark-math would misread: `$$` blocks that do
 * not close on a line of their own, and the LaTeX delimiters `\(x\)` and
 * `\[x\]` in prose. Everything else stays as typed.
 */
export function normalizeMathDelimiters(markdown: string, singleDollarMath: boolean): string {
  const hasLatexDelimiter = markdown.includes(INLINE_OPEN) || markdown.includes(DISPLAY_OPEN)
  if (!markdown.includes(MATH_FENCE) && !hasLatexDelimiter) return markdown
  // Only the first broken `$$` block is repaired per parse: everything after
  // it was parsed wrongly (it swallowed text and shifted later fences).
  for (let current = markdown; ;) {
    const tree = parseMarkdown(current, singleDollarMath)
    const repaired = repairFirstBrokenMathBlock(current, tree)
    if (repaired === null) return hasLatexDelimiter ? convertLatexDelimiters(current, tree) : current
    current = repaired
  }
}

function parseMarkdown(markdown: string, singleDollarMath: boolean): Node {
  return unified().use(remarkParse).use(markdownRemarkPlugins(singleDollarMath)).parse(markdown)
}

/** The markdown with its first `$$` block that does not close on a line of its own repaired, or null. */
function repairFirstBrokenMathBlock(markdown: string, tree: Node): string | null {
  for (const [blockStart, blockEnd] of nodeRanges(tree, MATH_BLOCK_TYPES)) {
    const repair = repairMathBlock(markdown.slice(blockStart, blockEnd))
    if (repair) return markdown.slice(0, blockStart) + repair.replacement + markdown.slice(blockStart + repair.sourceLength)
  }
  return null
}

/**
 * How to rewrite the start of one `$$` block, or null for a block that opens
 * and closes on lines of their own. A block that closes at the end of a text
 * line becomes one-line display math. Any other block (never closed, or text
 * after its opening `$$`, as in "$$$ places cost more") gets its opening
 * dollars escaped, so they show as text.
 */
function repairMathBlock(source: string): { replacement: string; sourceLength: number } | null {
  const lines = source.split('\n')
  const opener = MATH_BLOCK_OPENER.exec(lines[0])
  if (!opener) return null
  const [, indent, fence, meta] = opener
  const hasMeta = meta.trim() !== ''
  if (fence === MATH_FENCE) {
    const oneLine = oneLineMathBlock(lines, meta, hasMeta)
    if (oneLine) return { replacement: indent + oneLine.math, sourceLength: oneLine.sourceLength }
  }
  if (!hasMeta && closesOnOwnLine(lines, fence.length)) return null
  return { replacement: indent + ESCAPED_DOLLAR.repeat(fence.length), sourceLength: indent.length + fence.length }
}

/**
 * The one-line form of a `$$` block whose closing `$$` shares a line with
 * text, and how much of the block source it replaces; null otherwise.
 */
function oneLineMathBlock(lines: readonly string[], meta: string, hasMeta: boolean): { math: string; sourceLength: number } | null {
  let consumed = lines[0].length
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    consumed += 1
    const close = line.indexOf(MATH_FENCE)
    if (close < 0) {
      consumed += line.length
      continue
    }
    if (MATH_BLOCK_CLOSER.test(line) && !hasMeta) return null
    const math = oneLineMath([meta, ...lines.slice(1, index), line.slice(0, close)].join('\n'), true, DISPLAY_MATH_MARK)
    return math === null ? null : { math, sourceLength: consumed + close + DELIMITER_LENGTH }
  }
  return null
}

function closesOnOwnLine(lines: readonly string[], fenceLength: number): boolean {
  const closer = lines.length > 1 ? MATH_BLOCK_CLOSER.exec(lines[lines.length - 1]) : null
  return closer !== null && closer[1].length >= fenceLength
}

/**
 * Rewrite LaTeX `\(x\)` and `\[x\]` delimiters in prose to `$$x$$`, which
 * remark-math reads as math. Markdown would otherwise read `\(` as an escaped
 * "(" and drop the backslash. Delimiters in code, math, HTML, and link targets
 * stay as typed, and so does any pair that cannot become safe one-line math.
 */
function convertLatexDelimiters(markdown: string, tree: Node): string {
  let result = ''
  let copiedUpTo = 0
  for (const [segmentStart, segmentEnd] of proseSegments(tree, markdown.length)) {
    let searchFrom = segmentStart
    for (;;) {
      const open = findDelimiter(markdown, [INLINE_OPEN, DISPLAY_OPEN], searchFrom, segmentEnd)
      if (open < 0) break
      const isDisplay = markdown.startsWith(DISPLAY_OPEN, open)
      const bodyStart = open + DELIMITER_LENGTH
      const close = findDelimiter(markdown, [isDisplay ? DISPLAY_CLOSE : INLINE_CLOSE], bodyStart, segmentEnd)
      const math = close < 0 ? null : toMathFence(markdown, open, bodyStart, close, isDisplay)
      if (math === null) {
        searchFrom = bodyStart
        continue
      }
      result += markdown.slice(copiedUpTo, open) + math
      copiedUpTo = close + DELIMITER_LENGTH
      searchFrom = copiedUpTo
    }
  }
  return result + markdown.slice(copiedUpTo)
}

/** The `$$x$$` form of one LaTeX delimiter pair, or null when it could misrender. */
function toMathFence(markdown: string, open: number, bodyStart: number, close: number, isDisplay: boolean): string | null {
  if (markdown[open - 1] === DOLLAR || markdown[close + DELIMITER_LENGTH] === DOLLAR) return null
  return oneLineMath(markdown.slice(bodyStart, close), isDisplay, isDisplay ? DISPLAY_MATH_MARK : INLINE_MATH_MARK)
}

/**
 * Marked `$$body$$` on one line, so it is never read as the opening fence of a
 * `$$` block, which would swallow the rest of the reply. Null when the body
 * would clash with the fence, or when joining its lines could change it.
 */
function oneLineMath(rawBody: string, allowLineBreaks: boolean, mark: string): string | null {
  const body = rawBody.trim()
  if (!body) return null
  if (body.includes(MATH_FENCE) || body.startsWith(DOLLAR) || body.endsWith(DOLLAR)) return null
  if (body.includes('\n')) {
    if (!allowLineBreaks) return null
    if (BLANK_LINE.test(body) || BLOCKQUOTE_CONTINUATION.test(body) || UNESCAPED_PERCENT.test(body)) return null
  }
  return `${MATH_FENCE}${mark}${body.replace(LINE_BREAK_WITH_SPACE, ' ')}${MATH_FENCE}`
}

/** Index of the first unescaped delimiter in [from, to), or -1. */
function findDelimiter(text: string, delimiters: readonly string[], from: number, to: number): number {
  for (let index = text.indexOf(BACKSLASH, from); index >= 0 && index + DELIMITER_LENGTH <= to; index = text.indexOf(BACKSLASH, index + 1)) {
    if (!delimiters.some((delimiter) => text.startsWith(delimiter, index))) continue
    if (precedingBackslashCount(text, index) % 2 === 0) return index
  }
  return -1
}

function precedingBackslashCount(text: string, index: number): number {
  let count = 0
  while (index - count - 1 >= 0 && text[index - count - 1] === BACKSLASH) count++
  return count
}

/** Source ranges [start, end) outside every verbatim node, in order. */
function proseSegments(tree: Node, length: number): Array<[number, number]> {
  const segments: Array<[number, number]> = []
  let start = 0
  for (const [verbatimStart, verbatimEnd] of nodeRanges(tree, VERBATIM_NODE_TYPES)) {
    if (verbatimStart > start) segments.push([start, verbatimStart])
    start = Math.max(start, verbatimEnd)
  }
  if (start < length) segments.push([start, length])
  return segments
}

/** Source ranges [start, end) of the outermost nodes of the given types, in order. */
function nodeRanges(node: Node, types: ReadonlySet<string>, ranges: Array<[number, number]> = []): Array<[number, number]> {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (types.has(node.type) && start !== undefined && end !== undefined) {
    ranges.push([start, end])
    return ranges
  }
  for (const child of (node as Partial<Parent>).children ?? []) nodeRanges(child, types, ranges)
  return ranges
}
