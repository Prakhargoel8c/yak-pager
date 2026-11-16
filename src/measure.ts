/**
 * The DOM measurer: a block's rendered height and, for a paragraph, its
 * line-boundary split candidates, read with Ranges. A paragraph that
 * straddles a page holds its gap widget between passes, so the widget's box
 * is subtracted from the height and from every line below it; re-measuring
 * then reproduces the same numbers and reflow stays idempotent.
 */
import type { EditorView } from "prosemirror-view"
import type { SplitCandidate } from "./solver"
import type { Unit } from "./units"

/**
 * Split positions are relative to the paragraph's content start: an
 * insertion elsewhere in the document keeps the node (and its cached
 * measurement) while shifting its doc positions.
 */
export interface MeasuredBlock {
  height: number
  splitCandidates: SplitCandidate[] | null
}

export function measureBlock(view: EditorView, el: HTMLElement | null, unit: Unit): MeasuredBlock {
  if (!el) return { height: 0, splitCandidates: null }
  const rect = el.getBoundingClientRect()
  const allRects = Array.from(
    el.querySelectorAll<HTMLElement>(".page-gap"),
    (w) => w.getBoundingClientRect()
  )
  // A float's box counts toward the paragraph's height only while a line of
  // text sits below it; deleting everything after the widget leaves it
  // overhanging the paragraph's rect, where it was never part of the height.
  const widgetRects = allRects.filter((r) => r.bottom <= rect.bottom + 1)
  let height = rect.height
  for (const r of widgetRects) height -= r.height
  const splits =
    unit.kind === "splittable" ? measureSplitCandidates(view, el, rect, widgetRects, unit.contentStart) : null
  return { height, splitCandidates: splits }
}

interface WordRect {
  node: Text
  start: number
  rect: DOMRect
}

/** Every word's rect, in document order. The gap widget's page number is decoration, not a word. */
function paragraphWords(el: HTMLElement): WordRect[] {
  const out: WordRect[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest(".page-gap")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  for (const t of texts) {
    const s = t.nodeValue ?? ""
    const re = /\S+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      const r = document.createRange()
      r.setStart(t, m.index)
      r.setEnd(t, m.index + m[0].length)
      out.push({ node: t, start: m.index, rect: r.getBoundingClientRect() })
    }
  }
  return out
}

interface LineRect {
  top: number
  firstWord: WordRect
}

/**
 * Words grouped into visual lines. Two words share a line when their rects
 * overlap vertically by more than half the shorter one, which holds when a
 * font-size mark shares a line with normal text.
 */
function lineRects(el: HTMLElement): LineRect[] {
  const words = paragraphWords(el)
  const order = new Map(words.map((w, i) => [w, i]))
  const sorted = [...words].sort(
    (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left
  )
  const lines: WordRect[][] = []
  for (const w of sorted) {
    const cur = lines[lines.length - 1]
    if (cur) {
      const top = Math.min(...cur.map((x) => x.rect.top))
      const bottom = Math.max(...cur.map((x) => x.rect.bottom))
      const overlap = Math.min(bottom, w.rect.bottom) - Math.max(top, w.rect.top)
      if (overlap > 0.5 * Math.min(w.rect.bottom - w.rect.top, bottom - top)) {
        cur.push(w)
        continue
      }
    }
    lines.push([w])
  }
  return lines.map((ws) => ({
    top: Math.min(...ws.map((w) => w.rect.top)),
    // The earliest word in document order, not the leftmost: in right-to-left text that is the last.
    firstWord: ws.reduce((a, b) => (order.get(b)! < order.get(a)! ? b : a)),
  }))
}

/**
 * One candidate per line after the first: the line's first word and the
 * height from the paragraph's top to the line's line-box top, which is where
 * the browser puts a float's top edge. The line-box top is the word's em-box
 * top less the half-leading measured on the first line, so a line in a
 * larger font is off by its extra leading (a few px, only when a font-size
 * mark is carried onto the new page).
 */
function measureSplitCandidates(
  view: EditorView,
  el: HTMLElement,
  pRect: DOMRect,
  widgetRects: DOMRect[],
  contentStart: number
): SplitCandidate[] | null {
  const lines = lineRects(el)
  if (lines.length < 2) return null

  const widgetOffset = (top: number) => {
    let off = 0
    for (const r of widgetRects) if (r.top < top) off += r.height
    return off
  }

  const leading = lines[0].top - pRect.top - widgetOffset(lines[0].top)
  const out: SplitCandidate[] = []
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i]
    out.push({
      pos: view.posAtDOM(L.firstWord.node, L.firstWord.start) - contentStart,
      height: L.top - pRect.top - widgetOffset(L.top) - leading,
    })
  }
  return out
}
