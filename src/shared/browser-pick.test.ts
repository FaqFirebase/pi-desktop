import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_PICK_HTML_LENGTH,
  MAX_PICK_LABEL_LENGTH,
  MAX_PICK_SELECTOR_LENGTH,
  MAX_PICK_TEXT_LENGTH,
  MAX_SELECTOR_DEPTH,
  buildSelector,
  capText,
  captureRectForPick,
  elementLabel,
  escapeCssIdentifier,
  parseBrowserPick,
  type BrowserPick,
  type PickNode,
} from './browser-pick'

function node(
  tagName: string,
  { id = '', classNames = [], nthOfType = 1 }: { id?: string; classNames?: string[]; nthOfType?: number },
  parent: PickNode | null,
): PickNode {
  return { tagName, id, classNames, nthOfType, parent }
}

const VALID_PICK: BrowserPick = {
  url: 'https://example.com/',
  selector: 'main > button',
  tag: 'button',
  label: 'button',
  text: 'Save',
  html: '<button>Save</button>',
  rect: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 800, height: 600 },
}

test('escapeCssIdentifier follows CSS.escape', () => {
  assert.equal(escapeCssIdentifier('main'), 'main')
  assert.equal(escapeCssIdentifier('1a'), '\\31 a')
  assert.equal(escapeCssIdentifier('-1a'), '-\\31 a')
  assert.equal(escapeCssIdentifier('a b.c'), 'a\\ b\\.c')
  assert.equal(escapeCssIdentifier('-'), '\\-')
  assert.equal(escapeCssIdentifier('a\0b'), 'a�b')
})

test('buildSelector prefers a unique id', () => {
  const el = node('button', { id: 'save' }, node('div', {}, null))
  assert.equal(buildSelector(el, (s) => s === '#save'), '#save')
})

test('buildSelector walks up with classes, then nth-of-type, until unique', () => {
  const body = node('body', {}, null)
  const list = node('ul', { classNames: ['menu', 'top', 'extra'] }, body)
  const item = node('li', { nthOfType: 3 }, list)
  const unique = new Set(['ul.menu.top > li:nth-of-type(3)'])
  assert.equal(buildSelector(item, (s) => unique.has(s)), 'ul.menu.top > li:nth-of-type(3)')
})

test('buildSelector stops at MAX_SELECTOR_DEPTH and caps the length', () => {
  let leaf: PickNode = node('div', {}, null)
  for (let i = 0; i < 20; i++) leaf = node('div', { nthOfType: 1 }, leaf)
  const selector = buildSelector(leaf, () => false)
  assert.equal(selector.split(' > ').length <= MAX_SELECTOR_DEPTH, true)
  assert.equal(selector.length <= MAX_PICK_SELECTOR_LENGTH, true)
})

test('elementLabel is tag.class or tag#id', () => {
  assert.equal(elementLabel(node('DIV', { classNames: ['card', 'big', 'x'] }, null)), 'div.card.big')
  assert.equal(elementLabel(node('A', { id: 'home', classNames: ['nav'] }, null)), 'a#home')
  assert.equal(elementLabel(node('P', {}, null)), 'p')
})

test('capText leaves short text and cuts long text with the marker', () => {
  assert.equal(capText('abc', 5), 'abc')
  assert.equal(capText('abcdefgh', 5), 'abcd…')
})

test('parseBrowserPick accepts a valid payload and re-caps every string', () => {
  assert.deepEqual(parseBrowserPick(VALID_PICK), VALID_PICK)
  const pick = parseBrowserPick({ ...VALID_PICK, text: 'x'.repeat(MAX_PICK_TEXT_LENGTH + 50), html: 'y'.repeat(MAX_PICK_HTML_LENGTH + 50) })
  assert.equal(pick?.text.length, MAX_PICK_TEXT_LENGTH)
  assert.equal(pick?.html.length, MAX_PICK_HTML_LENGTH)
})

test('parseBrowserPick drops malformed or foreign payloads', () => {
  for (const bad of [null, 'x', [], { ...VALID_PICK, url: 'file:///x' }, { ...VALID_PICK, rect: { x: NaN, y: 0, width: 1, height: 1 } },
    { ...VALID_PICK, selector: 7 }, { ...VALID_PICK, viewport: { width: 0, height: 10 } }, { ...VALID_PICK, rect: undefined },
    { ...VALID_PICK, rect: { x: 0, y: 0, width: -1, height: 1 } }]) {
    assert.equal(parseBrowserPick(bad), null)
  }
})

test('captureRectForPick clips to the viewport and scales by zoom', () => {
  const viewport = { width: 800, height: 600 }
  assert.deepEqual(captureRectForPick({ rect: { x: -10, y: 20, width: 50, height: 30 }, viewport }, 1), { x: 0, y: 20, width: 40, height: 30 })
  assert.deepEqual(captureRectForPick({ rect: { x: -10, y: 20, width: 50, height: 30 }, viewport }, 1.5), { x: 0, y: 30, width: 60, height: 45 })
  assert.deepEqual(captureRectForPick({ rect: { x: 10.4, y: 10.6, width: 10.2, height: 10.2 }, viewport }, 1), { x: 10, y: 10, width: 11, height: 11 })
  assert.equal(captureRectForPick({ rect: { x: 900, y: 0, width: 50, height: 50 }, viewport }, 1), null)
  assert.equal(captureRectForPick({ rect: { x: 10, y: 10, width: 0, height: 50 }, viewport }, 1), null)
})

const CONTROL_ID = 'a\nb\rc\td\u0001e\u2028f g'

test('elementLabel keeps a page id with control and space characters on one line', () => {
  const label = elementLabel(node('DIV', { id: CONTROL_ID }, null))
  assert.match(label, /^div#\S+$/)
  assert.equal(/[\s\p{Cc}]/u.test(label), false)
  const classLabel = elementLabel(node('DIV', { classNames: ['x\ny', 'a b'] }, null))
  assert.equal(/[\s\p{Cc}]/u.test(classLabel), false)
})

test('parseBrowserPick strips control and space characters from a forged label', () => {
  const pick = parseBrowserPick({ ...VALID_PICK, label: `x${CONTROL_ID}`.repeat(10) })
  assert.ok(pick)
  assert.equal(/[\s\p{Cc}]/u.test(pick.label), false)
  assert.equal(pick.label.length <= MAX_PICK_LABEL_LENGTH, true)
})
