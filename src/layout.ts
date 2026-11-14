/**
 * LAYOUT — geometry and the rendering vocabulary of "a page", as plain
 * constants. CSS (styles.css) and this module must agree; the numbers meet
 * in exactly one place each, documented on both sides.
 *
 * The trick that makes rule 3 possible: the editor is ONE continuous flow.
 * A page is not a container; it is a region of the flow. Sheet backgrounds
 * are painted by CSS on .paper-stack, and each break inserts a gap widget
 * whose box is the entire inter-page space — band (216px) plus the ragged
 * bottom (--push) — so the block after it lands exactly on the next page's
 * content start with no margin of its own. Content therefore never moves
 * between pages, and no block's DOM is ever touched by reflow: PM's DOM
 * observer reconciles attribute writes on blocks by rebuilding them, but
 * it ignores everything inside/on widgets (ignoreMutation).
 *
 * Flow coordinates (y=0 is the first content pixel of page 1):
 *   page k content:   [start_k, start_k + 864)
 *   sheet k:          [start_k - 96, start_k + 960)   (1in margins)
 *   desk gap:         24px between sheets
 *   band at a break:  216px = 96 (bottom margin) + 24 (desk) + 96 (top margin)
 *   period:           864 + 216 = 1080px when no page overflows
 *
 * A break inserts exactly band + remaining px of space, so the block after
 * the break lands precisely on the next page's content start. Every visual
 * anchored to a page boundary is therefore at a *fixed* offset from the
 * break — widget internals never need to change when a break moves.
 */

export const PX_PER_IN = 96
export const MARGIN = 96 // 1in
export const SHEET_W = 8.5 * PX_PER_IN // 816
export const SHEET_H = 11 * PX_PER_IN // 1056
export const CONTENT_H = SHEET_H - 2 * MARGIN // 864 — the solver's pageHeight
export const DESK_GAP = 24
export const BLEED = 8 // shadow room inside the SVG tile, each side
export const TILE_W = SHEET_W + 2 * BLEED // 832
export const TILE_H = SHEET_H + 2 * BLEED // 1072
export const FLOW_PERIOD = CONTENT_H + 216 // 1080 (BAND imported type-only; value must match solver)

/**
 * Page margins in inches, the document's `margins` attr (schema.ts).
 * Everything above is the default 1in geometry; a document with other
 * margins gets its geometry from pageGeometry.
 */
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

/** A page's geometry in px for a set of margins. */
export interface PageGeometry {
  top: number
  right: number
  bottom: number
  left: number
  /** Writable height of a page: the solver's pageHeight. */
  contentH: number
  /** Inter-page space at a break: bottom margin + desk gap + top margin. */
  band: number
}

export function pageGeometry(m: Margins): PageGeometry {
  const [top, right, bottom, left] = [m.top, m.right, m.bottom, m.left].map((v) => v * PX_PER_IN)
  return { top, right, bottom, left, contentH: SHEET_H - top - bottom, band: bottom + DESK_GAP + top }
}

/**
 * Point the CSS at a geometry: the editor's side padding, the stack's top
 * padding and the gap widget's band all read these variables (styles.css).
 * Change-checked, so an unchanged geometry writes nothing.
 */
export function applyGeometry(stack: HTMLElement, g: PageGeometry) {
  const vars: Array<[string, number]> = [
    ["--margin-top", g.top],
    ["--margin-right", g.right],
    ["--margin-bottom", g.bottom],
    ["--margin-left", g.left],
    ["--content-h", g.contentH],
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

/**
 * Paint `n` sheets behind the flow, one CSS background layer per sheet, plus
 * enough stack padding to complete the last sheet. Positions come from the
 * solver's pageStarts, so overflowing pages (whose start drifts past the
 * 1080px period) are handled by the same mechanism — no special cases.
 * Assignments are change-checked, so a stable layout writes nothing.
 */
export function paintSheets(stack: HTMLElement, pageStarts: number[], fills: number[], g: PageGeometry) {
  const n = pageStarts.length
  const image = Array(n).fill(`url("${SHEET_URI}")`).join(", ")
  const position = pageStarts.map((s) => `0px ${s}px`).join(", ")
  const fillLast = fills[fills.length - 1] ?? 0
  const paddingBottom = Math.max(0, g.bottom + g.contentH + BLEED - fillLast)
  setStyleIfChanged(stack, "backgroundImage", image)
  setStyleIfChanged(stack, "backgroundPosition", position)
  setStyleIfChanged(stack, "paddingBottom", `${paddingBottom}px`)
}

/**
 * The gap widget. Created once per page index, pooled, and reused for the
 * life of the editor: ProseMirror re-inserts the same element (insertBefore)
 * when a break moves, which is exactly the DOM operation rule 3 allows.
 *
 * All children are absolutely positioned relative to the widget, offset by
 * the CSS variable --push = `remaining` (the ragged space above). From the
 * widget's top: [0, push) is the rest of the writable area, [push, push+96)
 * is the bottom margin (page number lives here), [push+96, push+120) is the
 * desk gap, [push+120, push+216) is the next sheet's top margin.
 */
export function makeGapWidgetDOM(pageIdx: number): HTMLElement {
  const el = document.createElement("div")
  el.className = "page-gap"
  el.dataset.page = String(pageIdx)
  el.setAttribute("contenteditable", "false")
  const rule = document.createElement("div")
  rule.className = "gap-rule"
  const num = document.createElement("div")
  num.className = "gap-num"
  // Drawn by CSS (::after) from this attribute, not as text, so selecting
  // or copying across a page boundary never picks up the number.
  num.dataset.num = String(pageIdx + 1)
  el.append(rule, num)
  return el
}

/** Point the gap's visuals at a new `remaining`. Change-checked: idempotent. */
export function setPush(widgetEl: HTMLElement, remaining: number) {
  const v = `${remaining}px`
  if (widgetEl.style.getPropertyValue("--push") !== v) {
    widgetEl.style.setProperty("--push", v)
  }
}
