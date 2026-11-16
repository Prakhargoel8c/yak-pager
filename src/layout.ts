/**
 * Page geometry and the rendering of "a page". The editor is one continuous
 * flow; a page is a region of it. Sheets are painted by CSS on .paper-stack,
 * and each break inserts a gap widget whose box is the whole inter-page
 * space (band + the ragged bottom, --push), so the block after it lands on
 * the next page's content start with no margin of its own. Reflow never
 * touches block DOM: PM rebuilds a block whose attributes are written, but
 * ignores everything inside widgets.
 *
 * Flow coordinates (y=0 is the first content pixel of page 1):
 *   page k content:   [start_k, start_k + contentH)
 *   sheet k:          [start_k - top, start_k - top + SHEET_H)
 *
 * applyGeometry is the only writer of the geometry CSS variables.
 */
import type { PageBreak } from "./solver"

export const PX_PER_IN = 96
export const SHEET_W = 8.5 * PX_PER_IN // 816
export const SHEET_H = 11 * PX_PER_IN // 1056
export const DESK_GAP = 24
const BLEED = 8 // shadow room inside the SVG tile, each side
const TILE_W = SHEET_W + 2 * BLEED
const TILE_H = SHEET_H + 2 * BLEED

/** In inches: the document's `margins` attr. */
export interface Margins {
  top: number
  right: number
  bottom: number
  left: number
}

export const DEFAULT_MARGINS: Margins = { top: 1, right: 1, bottom: 1, left: 1 }

/** Smallest writable area a margin choice may leave, in inches. */
export const MIN_CONTENT_IN = 1

/** The margins a document's attr asks for, or the defaults for a malformed value. */
export function marginsOf(attr: unknown): Margins {
  const m = attr as Partial<Margins> | null
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0
  if (!m || ![m.top, m.right, m.bottom, m.left].every(ok)) return DEFAULT_MARGINS
  const g = m as Margins
  if (SHEET_H / PX_PER_IN - g.top - g.bottom < MIN_CONTENT_IN) return DEFAULT_MARGINS
  if (SHEET_W / PX_PER_IN - g.left - g.right < MIN_CONTENT_IN) return DEFAULT_MARGINS
  return g
}

/** In px. */
export interface PageGeometry {
  top: number
  right: number
  bottom: number
  left: number
  contentW: number
  contentH: number
  /** Inter-page space at a break: bottom margin + desk gap + top margin. */
  band: number
}

export function pageGeometry(m: Margins): PageGeometry {
  const [top, right, bottom, left] = [m.top, m.right, m.bottom, m.left].map((v) => v * PX_PER_IN)
  return {
    top,
    right,
    bottom,
    left,
    contentW: SHEET_W - left - right,
    contentH: SHEET_H - top - bottom,
    band: bottom + DESK_GAP + top,
  }
}

export const geometryOf = (docAttrs: Record<string, unknown>) => pageGeometry(marginsOf(docAttrs.margins))

export interface Page {
  /** Flow y of the page's first content pixel. */
  start: number
  fill: number
  /** At a block boundary, inside a split block, or not at all (page 1). */
  opening: "between" | "inside" | null
}

export interface Layout {
  geometry: PageGeometry
  breaks: PageBreak[]
  pages: Page[]
}

export const emptyLayout = (geometry: PageGeometry): Layout => ({
  geometry,
  breaks: [],
  pages: [{ start: 0, fill: 0, opening: null }],
})

/** Change-checked: an unchanged geometry writes nothing. */
export function applyGeometry(stack: HTMLElement, g: PageGeometry) {
  const vars: Array<[string, number]> = [
    ["--sheet-w", SHEET_W],
    ["--bleed", BLEED],
    ["--tile-w", TILE_W],
    ["--tile-h", TILE_H],
    ["--margin-top", g.top],
    ["--margin-right", g.right],
    ["--margin-bottom", g.bottom],
    ["--margin-left", g.left],
    ["--content-h", g.contentH],
    ["--content-w", g.contentW],
    ["--band", g.band],
  ]
  for (const [name, px] of vars) {
    const v = `${px}px`
    if (stack.style.getPropertyValue(name) !== v) stack.style.setProperty(name, v)
  }
}

const SHEET_URI = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${TILE_W}' height='${TILE_H}'>` +
    `<defs><filter id='s' x='-4%' y='-4%' width='108%' height='108%'>` +
    `<feDropShadow dx='0' dy='1.5' stdDeviation='2.5' flood-color='#1f2937' flood-opacity='0.25'/>` +
    `</filter></defs>` +
    `<rect x='${BLEED}' y='${BLEED}' width='${SHEET_W}' height='${SHEET_H}' fill='#ffffff' filter='url(%23s)'/>` +
    `</svg>`
)}`

function setStyleIfChanged(el: HTMLElement, prop: "backgroundImage" | "backgroundPosition" | "paddingBottom", value: string) {
  if (el.style[prop] !== value) el.style[prop] = value
}

/** One background layer per page at its start, plus stack padding to complete the last sheet. Change-checked. */
export function paintSheets(stack: HTMLElement, layout: Layout) {
  const { pages, geometry: g } = layout
  const image = Array(pages.length).fill(`url("${SHEET_URI}")`).join(", ")
  const position = pages.map((p) => `0px ${p.start}px`).join(", ")
  const fillLast = pages[pages.length - 1]?.fill ?? 0
  const paddingBottom = Math.max(0, g.bottom + g.contentH + BLEED - fillLast)
  setStyleIfChanged(stack, "backgroundImage", image)
  setStyleIfChanged(stack, "backgroundPosition", position)
  setStyleIfChanged(stack, "paddingBottom", `${paddingBottom}px`)
}

/**
 * The gap widget. Its children sit at fixed offsets below the ragged bottom,
 * so a pooled element's internals never change when its break moves; between
 * two table rows it is a <tr> with one cell spanning the table. The page
 * number is drawn by CSS from data-num, so a selection across a page boundary
 * never picks it up.
 */
export function makeGapDOM(pageIdx: number, row: boolean): HTMLElement {
  const el = document.createElement(row ? "tr" : "div")
  el.className = "page-gap"
  el.dataset.page = String(pageIdx)
  el.setAttribute("contenteditable", "false")
  const rule = document.createElement("div")
  rule.className = "gap-rule"
  const num = document.createElement("div")
  num.className = "gap-num"
  num.dataset.num = String(pageIdx + 1)
  ;(row ? el.appendChild(document.createElement("td")) : el).append(rule, num)
  return el
}

export function setGapColspan(row: HTMLElement, span: number) {
  const cell = row.firstChild as HTMLTableCellElement
  if (cell.colSpan !== span) cell.colSpan = span
}

/** --push: the ragged space above the gap. --inset: how far inside a list it sits (its visuals reach back out). Change-checked. */
export function setGapVar(widgetEl: HTMLElement, name: "--push" | "--inset", px: number) {
  const v = `${px}px`
  if (widgetEl.style.getPropertyValue(name) !== v) widgetEl.style.setProperty(name, v)
}
