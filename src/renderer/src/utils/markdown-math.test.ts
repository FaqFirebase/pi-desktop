import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { MathSpan, markdownRehypePlugins, markdownRemarkPlugins, normalizeMathDelimiters } from './markdown-math'

function render(markdown: string, singleDollarMath = false): string {
  return renderToStaticMarkup(createElement(
    ReactMarkdown,
    {
      remarkPlugins: markdownRemarkPlugins(singleDollarMath),
      rehypePlugins: markdownRehypePlugins,
      components: { span: MathSpan },
    },
    normalizeMathDelimiters(markdown, singleDollarMath),
  ))
}

const MATH = '<span class="katex">'
const DISPLAY_MATH = '<span class="katex-display">'

function mathCount(html: string): number {
  return html.split(MATH).length - 1
}

function displayCount(html: string): number {
  return html.split(DISPLAY_MATH).length - 1
}

/** The visible text of rendered HTML, without tags and KaTeX output. */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
}

test('money amounts stay plain text by default', () => {
  const html = render('Lunch was $5 and dinner was $10, so $15 in total.')
  assert.equal(mathCount(html), 0)
  assert.match(html, /\$5 and dinner was \$10, so \$15/)
})

test('double-dollar price tiers inside a sentence stay plain text', () => {
  const markdown = 'Restaurant A ($$) and Restaurant B ($$) are both fine.'
  const html = render(markdown)
  assert.equal(mathCount(html), 0)
  assert.equal(visibleText(html), markdown)
  assert.equal(mathCount(render('Area is $$x^2$$ here.')), 0)
})

test('price tiers at the start of a line never swallow the rest of the reply', () => {
  const cases = [
    ['- $$: moderate\n- $$$: expensive\n- $: cheap', ['$$: moderate', '$$$: expensive', '$: cheap']],
    ['$$$ places cost more.\n\nNext paragraph stays.', ['$$$ places cost more.', 'Next paragraph stays.']],
    ['Price level:\n$$\n\nThis text must stay visible.', ['Price level:', '$$', 'This text must stay visible.']],
    ['| Tier | Price |\n|---|---|\n| A | $$ |\n| B | $$$ |', ['$$', '$$$']],
  ] as const
  for (const [markdown, expected] of cases) {
    const html = render(markdown)
    assert.equal(mathCount(html), 0, markdown)
    for (const text of expected) assert.ok(visibleText(html).includes(text), `${markdown} -> ${text}`)
  }
})

test('shell variables and money in code are never math, even with single-dollar math on', () => {
  const markdown = 'Run `echo $HOME and $PATH` then:\n\n```sh\nprice=$5; echo "$price $total"\n```'
  assert.equal(mathCount(render(markdown, true)), 0)
})

test('single dollar signs are math only when the setting is on, and stay inline', () => {
  assert.equal(mathCount(render('Area is $x^2$ here.')), 0)
  assert.equal(mathCount(render('Area is $x^2$ here.', true)), 1)
  const alone = render('$x^2$', true)
  assert.equal(mathCount(alone), 1)
  assert.equal(displayCount(alone), 0)
})

test('double-dollar math alone on its line renders as display math', () => {
  assert.equal(displayCount(render('$$x^2$$')), 1)
  assert.equal(displayCount(render('$$x^2$$.')), 1)
  assert.equal(displayCount(render('- $$x^2$$')), 1)
  assert.equal(displayCount(render('> $$x^2$$')), 1)
  assert.equal(displayCount(render('Text before:\n$$x^2$$\nText after.')), 1)
  assert.equal(displayCount(render('$$\nx^2\n$$')), 1)
})

test('a math code block renders as display math', () => {
  assert.equal(displayCount(render('```math\nx^2\n```')), 1)
})

test('LaTeX parenthesis delimiters render inline math, also alone on a line', () => {
  const html = render('Euler: \\(e^{i\\pi} + 1 = 0\\) is neat.')
  assert.equal(mathCount(html), 1)
  assert.equal(displayCount(html), 0)
  assert.equal(displayCount(render('\\(x\\)')), 0)
  assert.equal(mathCount(render('\\(x\\)')), 1)
})

test('LaTeX bracket delimiters render display math, on one line, several, or in a sentence', () => {
  assert.equal(displayCount(render('\\[x^2 + y^2 = z^2\\]')), 1)
  assert.equal(displayCount(render('Then:\n\n\\[\n\\frac{a}{b}\n= c\n\\]\n\nDone.')), 1)
  assert.equal(displayCount(render('The formula \\[x = 1\\] holds.')), 1)
})

test('markdown syntax inside LaTeX delimiters is not read as emphasis', () => {
  const html = render('\\(a_1 * b_2 * c_3\\)')
  assert.equal(mathCount(html), 1)
  assert.ok(!html.includes('<em>'))
})

test('multi-line bracket math never opens a math block that swallows the rest of the reply', () => {
  const html = render('\\[\na = b\n+ c \\]\n\nThe text after the formula.')
  assert.equal(displayCount(html), 1)
  assert.match(html, /<p>The text after the formula\.<\/p>/)
})

test('a double-dollar block that closes at the end of a text line does not swallow the reply', () => {
  const markdown = 'Evaluate:\n\n$$S_2 = \\frac{\\pi^2}{2},\\qquad\nS_3 = 2\\ln^2(1+\\sqrt2).$$\n\n> A note with $x$.\n\n$$y = 1$$\n\nThe end.'
  const html = render(markdown)
  assert.ok(!html.includes('katex-error'))
  assert.equal(displayCount(html), 2)
  assert.match(html, /<blockquote>/)
  assert.match(html, /<p>The end\.<\/p>/)
})

test('a double-dollar block opened on its own line and closed after text is repaired', () => {
  const html = render('$$\na = b\n+ c$$\n\nAfter.')
  assert.equal(displayCount(html), 1)
  assert.match(html, /<p>After\.<\/p>/)
  const trailing = render('$$a\nb$$ then text')
  assert.equal(displayCount(trailing), 1)
  assert.match(visibleText(trailing), / then text$/)
})

test('a broken double-dollar block hidden inside an earlier broken block is repaired too', () => {
  const html = render('$$a\nb$$\n\nText.\n\n$$c\nd$$\n\nEnd.')
  assert.equal(displayCount(html), 2)
  assert.match(html, /<p>Text\.<\/p>/)
  assert.match(html, /<p>End\.<\/p>/)
})

test('a double-dollar block that cannot be repaired shows as text instead of swallowing the reply', () => {
  assert.equal(normalizeMathDelimiters('$$a\n\nb$$\n\nAfter stays.', false), '\\$\\$a\n\nb$$\n\nAfter stays.')
  assert.equal(normalizeMathDelimiters('$$\nx is still streaming', false), '\\$\\$\nx is still streaming')
  const html = render('$$x is cheap\n\nSome text.\n\n$$\ny\n$$')
  assert.match(html, /<p>Some text\.<\/p>/)
  assert.equal(displayCount(html), 1)
})

test('well-formed double-dollar blocks and code stay as typed', () => {
  const kept = ['$$\nx^2\n$$\n\nAfter.', '$$$\nx^2\n$$$', '> $$\n> x\n> $$', '$$x$$', '```\n$$a\nb$$\n```']
  for (const markdown of kept) {
    assert.equal(normalizeMathDelimiters(markdown, false), markdown, markdown)
  }
})

test('LaTeX delimiters inside code stay as typed', () => {
  assert.equal(normalizeMathDelimiters('`\\(x\\)`', false), '`\\(x\\)`')
  assert.equal(normalizeMathDelimiters('```\n\\[x\\]\n```', false), '```\n\\[x\\]\n```')
})

test('LaTeX delimiters in link targets stay as typed', () => {
  const markdown = '[docs](https://example.com/a\\(b\\))'
  assert.equal(normalizeMathDelimiters(markdown, false), markdown)
})

test('an escaped backslash before a parenthesis is not a delimiter', () => {
  const markdown = 'Path C:\\\\(x\\\\) here'
  assert.equal(normalizeMathDelimiters(markdown, false), markdown)
})

test('delimiters that cannot form safe math stay as typed', () => {
  const unsafe = [
    '\\(\\)',
    '\\(a\nb\\)',
    '\\[a\n\nb\\]',
    '\\[a % comment\nb\\]',
    '> \\[a\n> b\\]',
    '\\(x$$y\\)',
    '\\($x\\)',
    '$\\(x\\)',
  ]
  for (const markdown of unsafe) {
    assert.equal(normalizeMathDelimiters(markdown, false), markdown, markdown)
  }
})

test('an unclosed delimiter does not stop later math from converting', () => {
  const html = render('a \\( b and \\[c\\]')
  assert.equal(displayCount(html), 1)
  assert.match(visibleText(html), /^a \( b and /)
})

test('text without math markup is returned unchanged', () => {
  const markdown = 'Plain $5 text with (parens) and [brackets].'
  assert.equal(normalizeMathDelimiters(markdown, false), markdown)
})

test('a repeated formula renders the same each time, without leaking its HTML into an attribute', () => {
  const first = render('$$x^2 + 1$$')
  assert.equal(render('$$x^2 + 1$$'), first)
  assert.ok(!first.includes('data-math-html'))
})

test('invalid LaTeX shows an error mark instead of breaking the message', () => {
  const html = render('Before:\n\n$$\\frac{a$$\n\nAfter.')
  assert.match(html, /katex-error/)
  assert.match(html, /<p>After\.<\/p>/)
})
