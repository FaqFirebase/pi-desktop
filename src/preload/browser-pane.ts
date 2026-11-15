// Picker preload of the Browser pane guest (main/browser-pane-guest.ts sets it).
// It runs in an isolated world next to an untrusted page: it exposes nothing
// to the page, writes nothing to `window`, and talks only to the host
// <webview> through sendToHost. A sandboxed preload cannot load a shared build
// chunk, so it imports only `electron` and ../shared/browser-pick.

import { ipcRenderer } from 'electron'
import {
  BROWSER_PICK_CHANNELS,
  MAX_PICK_HTML_LENGTH,
  MAX_PICK_TAG_LENGTH,
  MAX_PICK_TEXT_LENGTH,
  buildSelector,
  capText,
  elementLabel,
  type BrowserPick,
  type PickNode,
} from '../shared/browser-pick'

const PICK_OVERLAY_Z_INDEX = '2147483647'
const PICK_HIGHLIGHT_COLOR = 'rgba(59, 130, 246, 0.25)'
const PICK_HIGHLIGHT_BORDER = '2px solid rgb(59, 130, 246)'
const PICK_LABEL_BACKGROUND = 'rgb(30, 41, 59)'
const PICK_LABEL_COLOR = 'rgb(248, 250, 252)'
const PICK_LABEL_FONT = '12px/1.4 ui-monospace, monospace'
const PICK_LABEL_PADDING = '2px 6px'
const PICK_LABEL_RADIUS = '3px'
const PICK_LABEL_HEIGHT_PX = 20
const PICK_CURSOR = 'crosshair'
const ESCAPE_KEY = 'Escape'
const CLICK_EVENT = 'click'
const PX = 'px'

// Pointer events the page must not see while picking. The click also picks.
const SWALLOWED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', CLICK_EVENT, 'dblclick', 'auxclick', 'contextmenu'] as const
const CAPTURE: AddEventListenerOptions = { capture: true }

interface PickOverlay {
  host: HTMLDivElement
  box: HTMLDivElement
  label: HTMLDivElement
}

let overlay: PickOverlay | null = null
let pointer: { x: number; y: number } | null = null

function createOverlay(): PickOverlay {
  // Styles go through CSSOM, which a page's style-src policy does not block.
  const host = document.createElement('div')
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: PICK_OVERLAY_Z_INDEX, cursor: PICK_CURSOR, background: 'transparent' })
  const root = host.attachShadow({ mode: 'closed' })
  const box = document.createElement('div')
  Object.assign(box.style, {
    position: 'fixed', display: 'none', pointerEvents: 'none', boxSizing: 'border-box',
    background: PICK_HIGHLIGHT_COLOR, border: PICK_HIGHLIGHT_BORDER,
  })
  const label = document.createElement('div')
  Object.assign(label.style, {
    position: 'fixed', display: 'none', pointerEvents: 'none', whiteSpace: 'nowrap',
    background: PICK_LABEL_BACKGROUND, color: PICK_LABEL_COLOR, font: PICK_LABEL_FONT,
    padding: PICK_LABEL_PADDING, borderRadius: PICK_LABEL_RADIUS,
  })
  root.append(box, label)
  return { host, box, label }
}

function nthOfType(element: Element): number {
  let index = 1
  for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    if (sibling.tagName === element.tagName) index++
  }
  return index
}

/** The element as the shared rules see it; ancestors are read only when asked for. */
function toPickNode(element: Element): PickNode {
  return {
    tagName: element.tagName,
    id: element.id,
    classNames: Array.from(element.classList),
    nthOfType: nthOfType(element),
    get parent() {
      const parent = element === document.documentElement ? null : element.parentElement
      return parent ? toPickNode(parent) : null
    },
  }
}

function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

/** The page element under a point, below our overlay. */
function elementAt(x: number, y: number): Element | null {
  return document.elementsFromPoint(x, y).find((element) => element !== overlay?.host) ?? null
}

function highlight(): void {
  if (!overlay || !pointer) return
  const target = elementAt(pointer.x, pointer.y)
  const { box, label } = overlay
  if (!target) {
    box.style.display = 'none'
    label.style.display = 'none'
    return
  }
  const rect = target.getBoundingClientRect()
  Object.assign(box.style, { display: 'block', left: rect.left + PX, top: rect.top + PX, width: rect.width + PX, height: rect.height + PX })
  label.textContent = elementLabel(toPickNode(target))
  const labelTop = rect.top >= PICK_LABEL_HEIGHT_PX ? rect.top - PICK_LABEL_HEIGHT_PX : rect.bottom
  Object.assign(label.style, { display: 'block', left: Math.max(0, rect.left) + PX, top: labelTop + PX })
}

function buildPick(element: Element): BrowserPick {
  const node = toPickNode(element)
  const rect = element.getBoundingClientRect()
  const text = (element as HTMLElement).innerText ?? element.textContent ?? ''
  return {
    url: location.href,
    selector: buildSelector(node, isUnique),
    tag: capText(element.tagName.toLowerCase(), MAX_PICK_TAG_LENGTH),
    label: elementLabel(node),
    text: capText(text, MAX_PICK_TEXT_LENGTH),
    html: capText(element.outerHTML, MAX_PICK_HTML_LENGTH),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }
}

function onPointerMove(event: PointerEvent): void {
  pointer = { x: event.clientX, y: event.clientY }
  highlight()
}

function pickAt(event: MouseEvent): void {
  // A page can dispatch its own click events; only a real click picks.
  if (!event.isTrusted) return
  const target = elementAt(event.clientX, event.clientY)
  if (!target) return
  const pick = buildPick(target)
  // Remove the overlay and wait until a frame without it is painted, so the
  // host's screenshot does not show the highlight.
  stopPicking()
  requestAnimationFrame(() => requestAnimationFrame(() => ipcRenderer.sendToHost(BROWSER_PICK_CHANNELS.picked, pick)))
}

function onSwallowed(event: Event): void {
  event.preventDefault()
  event.stopImmediatePropagation()
  if (event.type === CLICK_EVENT) pickAt(event as MouseEvent)
}

function onKeyDown(event: KeyboardEvent): void {
  if (!event.isTrusted || event.key !== ESCAPE_KEY) return
  event.preventDefault()
  event.stopImmediatePropagation()
  stopPicking()
  ipcRenderer.sendToHost(BROWSER_PICK_CHANNELS.cancelled)
}

function attachOverlay(): void {
  if (!overlay) return
  document.documentElement.append(overlay.host)
}

function startPicking(): void {
  if (overlay) return
  overlay = createOverlay()
  if (document.documentElement) attachOverlay()
  else document.addEventListener('DOMContentLoaded', attachOverlay, { once: true })
  window.addEventListener('pointermove', onPointerMove, CAPTURE)
  window.addEventListener('scroll', highlight, CAPTURE)
  for (const type of SWALLOWED_EVENTS) window.addEventListener(type, onSwallowed, CAPTURE)
  window.addEventListener('keydown', onKeyDown, CAPTURE)
}

function stopPicking(): void {
  if (!overlay) return
  document.removeEventListener('DOMContentLoaded', attachOverlay)
  window.removeEventListener('pointermove', onPointerMove, CAPTURE)
  window.removeEventListener('scroll', highlight, CAPTURE)
  for (const type of SWALLOWED_EVENTS) window.removeEventListener(type, onSwallowed, CAPTURE)
  window.removeEventListener('keydown', onKeyDown, CAPTURE)
  overlay.host.remove()
  overlay = null
  pointer = null
}

ipcRenderer.on(BROWSER_PICK_CHANNELS.start, startPicking)
ipcRenderer.on(BROWSER_PICK_CHANNELS.stop, stopPicking)
