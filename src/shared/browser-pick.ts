// Rules of the Browser pane element picker: the picker preload
// (preload/browser-pane.ts) builds a pick with them, and the app window
// (components/browser-pane.tsx) checks it again before it uses it.
// The sandboxed preload cannot load a shared build chunk, so this module
// imports nothing but ./browser-pane.

import { isBrowserPaneUrl } from './browser-pane'

/** Messages between the Browser pane host and its picker preload. */
export const BROWSER_PICK_CHANNELS = {
  start: 'browser-pane:pick-start',
  stop: 'browser-pane:pick-stop',
  picked: 'browser-pane:picked',
  cancelled: 'browser-pane:pick-cancelled',
} as const

export const MAX_PICK_URL_LENGTH = 2048
export const MAX_PICK_SELECTOR_LENGTH = 512
export const MAX_PICK_TEXT_LENGTH = 2000
export const MAX_PICK_HTML_LENGTH = 4000
export const MAX_PICK_LABEL_LENGTH = 60
export const MAX_PICK_TAG_LENGTH = 32
export const MAX_SELECTOR_DEPTH = 8
export const MAX_SELECTOR_CLASSES = 2
export const TRUNCATION_MARKER = '…'

const SELECTOR_SEPARATOR = ' > '
const REPLACEMENT_CHARACTER = '�'
const HEX_RADIX = 16
const NULL_CODE = 0x0
const LAST_CONTROL_CODE = 0x1f
const DELETE_CODE = 0x7f
const FIRST_NON_ASCII_CODE = 0x80
const IDENTIFIER_CHARACTER = /^[-_0-9A-Za-z]$/
const DIGIT = /^[0-9]$/
// The label names the attachment, and the name sits on the untrusted-data
// marker lines; a line break or other control character would split them.
const LABEL_UNSAFE_CHARACTERS = /[\s\p{Cc}\p{Cf}]/gu

/** An element as the selector and label rules see it. */
export interface PickNode {
  tagName: string
  id: string
  classNames: readonly string[]
  /** 1-based index among the siblings with the same tag name. */
  nthOfType: number
  parent: PickNode | null
}

/** A box in CSS pixels of the page viewport. */
export interface PickRect {
  x: number
  y: number
  width: number
  height: number
}

/** One picked element, as the picker preload sends it to the host. */
export interface BrowserPick {
  url: string
  selector: string
  tag: string
  label: string
  text: string
  html: string
  rect: PickRect
  viewport: { width: number; height: number }
}

/** `value` escaped as a CSS identifier, by the rules of CSSOM `CSS.escape`. */
export function escapeCssIdentifier(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    const code = value.charCodeAt(index)
    if (code === NULL_CODE) {
      result += REPLACEMENT_CHARACTER
    } else if (
      (code > NULL_CODE && code <= LAST_CONTROL_CODE) || code === DELETE_CODE
      || (index === 0 && DIGIT.test(character))
      || (index === 1 && DIGIT.test(character) && value[0] === '-')
    ) {
      result += `\\${code.toString(HEX_RADIX)} `
    } else if (index === 0 && character === '-' && value.length === 1) {
      result += `\\${character}`
    } else if (code >= FIRST_NON_ASCII_CODE || IDENTIFIER_CHARACTER.test(character)) {
      result += character
    } else {
      result += `\\${character}`
    }
  }
  return result
}

/** `value` at most `max` characters long; a cut value ends in TRUNCATION_MARKER. */
export function capText(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
}

/** `value` on one line with no spaces or control characters, capped to MAX_PICK_LABEL_LENGTH. */
function safeLabel(value: string): string {
  return capText(value.replace(LABEL_UNSAFE_CHARACTERS, ''), MAX_PICK_LABEL_LENGTH)
}

/** A short display name: `tag#id`, else `tag.class1.class2`, else `tag`, with id and classes escaped. */
export function elementLabel(node: PickNode): string {
  const tag = node.tagName.toLowerCase()
  const label = node.id
    ? `${tag}#${escapeCssIdentifier(node.id)}`
    : [tag, ...node.classNames.slice(0, MAX_SELECTOR_CLASSES).map(escapeCssIdentifier)].join('.')
  return safeLabel(label)
}

function joinSegments(segments: readonly string[]): string {
  return segments.join(SELECTOR_SEPARATOR)
}

/**
 * A CSS selector for `node`: its id when that is unique, else the shortest
 * chain of `tag.class` (and `:nth-of-type`) steps up to MAX_SELECTOR_DEPTH
 * ancestors that `isUnique` accepts. With none unique, the deepest chain.
 */
export function buildSelector(node: PickNode, isUnique: (selector: string) => boolean): string {
  const segments: string[] = []
  let current: PickNode | null = node
  for (let depth = 0; current && depth < MAX_SELECTOR_DEPTH; depth++, current = current.parent) {
    if (current.id) {
      const byId = joinSegments([`#${escapeCssIdentifier(current.id)}`, ...segments])
      if (isUnique(byId)) return capText(byId, MAX_PICK_SELECTOR_LENGTH)
    }
    const base = escapeCssIdentifier(current.tagName.toLowerCase())
      + current.classNames.slice(0, MAX_SELECTOR_CLASSES).map((name) => `.${escapeCssIdentifier(name)}`).join('')
    const byClass = joinSegments([base, ...segments])
    if (isUnique(byClass)) return capText(byClass, MAX_PICK_SELECTOR_LENGTH)
    segments.unshift(`${base}:nth-of-type(${current.nthOfType})`)
    const byPosition = joinSegments(segments)
    if (isUnique(byPosition)) return capText(byPosition, MAX_PICK_SELECTOR_LENGTH)
  }
  return capText(joinSegments(segments), MAX_PICK_SELECTOR_LENGTH)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumbers<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isRecord(value)) return null
  const result = {} as Record<K, number>
  for (const key of keys) {
    const number = value[key]
    if (typeof number !== 'number' || !Number.isFinite(number)) return null
    result[key] = number
  }
  return result
}

const RECT_KEYS = ['x', 'y', 'width', 'height'] as const
const VIEWPORT_KEYS = ['width', 'height'] as const
const PICK_STRING_CAPS = {
  url: MAX_PICK_URL_LENGTH,
  selector: MAX_PICK_SELECTOR_LENGTH,
  tag: MAX_PICK_TAG_LENGTH,
  label: MAX_PICK_LABEL_LENGTH,
  text: MAX_PICK_TEXT_LENGTH,
  html: MAX_PICK_HTML_LENGTH,
} as const

/**
 * A pick payload from the page's process, checked and capped again, or null
 * when any field is missing, of the wrong type, or out of range. The page can
 * run code next to the picker, so nothing it sends is trusted as is.
 */
export function parseBrowserPick(value: unknown): BrowserPick | null {
  if (!isRecord(value)) return null
  const strings = {} as Record<keyof typeof PICK_STRING_CAPS, string>
  for (const [key, max] of Object.entries(PICK_STRING_CAPS) as [keyof typeof PICK_STRING_CAPS, number][]) {
    const field = value[key]
    if (typeof field !== 'string') return null
    strings[key] = capText(field, max)
  }
  strings.label = safeLabel(strings.label)
  const rect = finiteNumbers(value.rect, RECT_KEYS)
  const viewport = finiteNumbers(value.viewport, VIEWPORT_KEYS)
  if (!rect || rect.width < 0 || rect.height < 0) return null
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return null
  if (!isBrowserPaneUrl(strings.url)) return null
  return { ...strings, rect, viewport }
}

/**
 * The webview area to capture for a pick: its rect cut to the viewport, in
 * view pixels (CSS pixels times the page zoom factor), widened to whole
 * pixels. Null when no part of the element is on screen.
 */
export function captureRectForPick(pick: Pick<BrowserPick, 'rect' | 'viewport'>, zoomFactor: number): PickRect | null {
  const { rect, viewport } = pick
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  const right = Math.min(viewport.width, rect.x + rect.width)
  const bottom = Math.min(viewport.height, rect.y + rect.height)
  if (right <= left || bottom <= top) return null
  const x = Math.floor(left * zoomFactor)
  const y = Math.floor(top * zoomFactor)
  return { x, y, width: Math.ceil(right * zoomFactor) - x, height: Math.ceil(bottom * zoomFactor) - y }
}
