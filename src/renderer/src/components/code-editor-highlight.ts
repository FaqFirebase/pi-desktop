import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/**
 * Comprehensive HighlightStyle whose token colors are CSS variables.
 * Each app theme (Dark, Light, Nord, Gruvbox) defines these variables in
 * index.css so the editor automatically restyles when the theme changes.
 */
export const themedHighlightStyle = HighlightStyle.define([
  // Keywords, modifiers, atoms
  { tag: t.keyword, color: 'var(--cm-keyword)' },
  { tag: [t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword], color: 'var(--cm-keyword)' },
  { tag: [t.atom, t.bool, t.null], color: 'var(--cm-constant)' },

  // Strings and string-like
  { tag: [t.string, t.special(t.string), t.docString], color: 'var(--cm-string)' },
  { tag: [t.regexp, t.escape], color: 'var(--cm-string)' },
  { tag: t.character, color: 'var(--cm-string)' },

  // Comments
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--cm-comment)', fontStyle: 'italic' },

  // Names: functions, types, classes, properties, variables
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--cm-function)' },
  { tag: [t.typeName, t.className], color: 'var(--cm-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--cm-property)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--cm-variable)' },
  { tag: [t.macroName, t.special(t.variableName)], color: 'var(--cm-keyword)' },
  { tag: [t.namespace, t.self], color: 'var(--cm-type)' },

  // Numbers, units, colors
  { tag: [t.number, t.integer, t.float], color: 'var(--cm-number)' },
  { tag: [t.color, t.unit], color: 'var(--cm-number)' },

  // Operators and punctuation
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator], color: 'var(--cm-operator)' },
  { tag: [t.punctuation, t.separator, t.bracket, t.brace, t.paren, t.squareBracket, t.angleBracket], color: 'var(--cm-operator)' },

  // Tags and markup
  { tag: t.tagName, color: 'var(--cm-tag)' },
  { tag: t.attributeValue, color: 'var(--cm-string)' },

  // Constants and definitions
  { tag: [t.constant(t.name), t.standard(t.name)], color: 'var(--cm-constant)' },
  { tag: t.definition(t.name), color: 'var(--cm-function)' },

  // Markdown
  { tag: t.heading, color: 'var(--cm-heading)', fontWeight: 'bold' },
  { tag: t.heading1, color: 'var(--cm-heading)', fontWeight: 'bold' },
  { tag: t.heading2, color: 'var(--cm-heading)', fontWeight: 'bold' },
  { tag: t.heading3, color: 'var(--cm-heading)', fontWeight: 'bold' },
  { tag: t.heading4, color: 'var(--cm-heading)', fontWeight: 'bold' },
  { tag: t.heading5, color: 'var(--cm-heading)', fontWeight: 'bold' },
  { tag: t.heading6, color: 'var(--cm-heading)', fontWeight: 'bold' },
  { tag: t.list, color: 'var(--cm-list)' },
  { tag: t.quote, color: 'var(--cm-quote)', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--cm-link)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--cm-link)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--cm-property)' },

  // Diff / change tracking
  { tag: t.inserted, color: 'var(--cm-string)' },
  { tag: t.deleted, color: 'var(--cm-invalid)' },
  { tag: t.changed, color: 'var(--cm-number)' },

  // Meta and invalid
  { tag: [t.meta, t.annotation], color: 'var(--cm-meta)' },
  { tag: t.invalid, color: 'var(--cm-invalid)' },

  // Markdown structural marks (`#`, `-`, `*`, link/emphasis delimiters).
  // Lang-markdown emits these as t.processingInstruction. Use the heading
  // color so `##` matches the heading text it precedes (visually unified,
  // like VS Code's Markdown rendering) and list/emphasis marks pop instead
  // of blending into the background.
  { tag: t.processingInstruction, color: 'var(--cm-mark)' },

  // Markdown thematic break (`---`, `***`, `___`) — tagged as
  // t.contentSeparator. Use the same mark color so horizontal rules are
  // clearly visible (default would render them in a dark fallback color
  // that barely shows up against any of our themed backgrounds).
  { tag: t.contentSeparator, color: 'var(--cm-mark)' },
])
