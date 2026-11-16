/**
 * MEASURE without the DOM: paragraph and heading heights, and the paragraph
 * line boundaries the solver splits at, computed with Pretext
 * (@chenglou/pretext) from the node's text and marks alone.
 *
 * Pretext measures text with Canvas and breaks lines by the browser engine's
 * own rules, so it predicts the lines the editor paints without a layout
 * read. The DOM path (measure.ts) stays the reference and the fallback:
 * measureWithPretext returns null for anything it cannot model, and the
 * pass then measures that block from the DOM as before.
 *
 * Because no DOM is read, a paragraph that currently holds its gap widget
 * needs no widget subtraction: the numbers come from the document, so
 * re-measuring is idempotent by construction.
 *
 * Block styles come from typography.ts, the same table the editor's CSS is
 * generated from.
 */
import type { Mark } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import {
  layoutNextRichInlineLineRange,
  materializeRichInlineLineRange,
  prepareRichInline,
  walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline"
import type { PreparedRichInline, RichInlineItem, RichInlineLineRange } from "@chenglou/pretext/rich-inline"
import type { MeasuredBlock } from "./measure"
import type { SplitCandidate } from "./solver"
import { TEXT_FLOW, blockStyle } from "./typography"
import type { BlockStyle } from "./typography"
import type { Unit } from "./units"

/**
 * Chrome lays text out in 1/64px units, and its widths drift from canvas by
 * less than that on lines mixing fonts. A line this close to the column
 * edge may or may not fit, so the browser decides it (fitsInBrowser).
 */
const EDGE = 1 / 64

interface InlineBox {
  /** Line-box top to baseline. */
  above: number
  /** Baseline to line-box bottom. */
  below: number
}

const inlineBoxes = new Map<string, InlineBox>()

const edgeFits = new Map<string, boolean>()

/** Forget probed line boxes and edge lines: a web font that finished loading has new metrics. */
export function clearInlineBoxes(): void {
  inlineBoxes.clear()
  edgeFits.clear()
}

/**
 * Whether the browser keeps this text on one line at `width`: laid out once
 * in a hidden probe with the editor's text settings, and cached.
 */
function fitsInBrowser(runs: { text: string; font: string }[], width: number): boolean {
  const key = `${width}|${runs.map((r) => `${r.font}\u0000${r.text}`).join("\u0001")}`
  let fits = edgeFits.get(key)
  if (fits === undefined) {
    const probe = document.createElement("div")
    probe.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;width:${width}px;${TEXT_FLOW}`
    for (const run of runs) {
      const span = document.createElement("span")
      span.style.font = run.font
      span.textContent = run.text
      probe.append(span)
    }
    document.body.append(probe)
    const first = probe.firstChild!.firstChild as Text
    const last = probe.lastChild!.firstChild as Text
    const range = document.createRange()
    range.setStart(first, 0)
    range.setEnd(first, 1)
    const top = range.getBoundingClientRect().top
    range.setStart(last, last.length - 1)
    range.setEnd(last, last.length)
    fits = Math.abs(range.getBoundingClientRect().top - top) < 1
    probe.remove()
    edgeFits.set(key, fits)
  }
  return fits
}

/**
 * The block's line ranges at `width`. Pretext breaks every line; a line
 * whose fit is within EDGE of the column is settled by the browser.
 */
function lineRanges(prepared: PreparedRichInline, items: RichInlineItem[], width: number): RichInlineLineRange[] {
  const ranges: RichInlineLineRange[] = []
  let close = false
  walkRichInlineLineRanges(prepared, width + EDGE, (range) => {
    ranges.push(range)
    if (range.width > width - EDGE) close = true
  })
  if (!close) return ranges

  ranges.length = 0
  let cursor: RichInlineLineRange["end"] | undefined
  for (;;) {
    const loose = layoutNextRichInlineLineRange(prepared, width + EDGE, cursor)
    if (!loose) break
    let range = loose
    if (loose.width > width - EDGE) {
      const runs = materializeRichInlineLineRange(prepared, loose).fragments
        .map((f) => ({ text: f.text, font: items[f.itemIndex].font }))
        .filter((r) => r.text.length > 0)
      while (runs.length > 0) {
        const last = runs[runs.length - 1]
        const text = last.text.replace(/\s+$/, "")
        if (text) {
          runs[runs.length - 1] = { ...last, text }
          break
        }
        runs.pop()
      }
      if (runs.length > 0 && !fitsInBrowser(runs, width)) {
        range = layoutNextRichInlineLineRange(prepared, width - EDGE, cursor) ?? loose
      }
    }
    ranges.push(range)
    cursor = range.end
  }
  return ranges
}

/**
 * Where an inline box of `size`px `family` text at a unitless `lineHeight`
 * sits around the baseline, as this browser lays it out. Its height is the
 * line-height, but the split above and below the baseline follows the
 * font's ascent and descent, so a line mixing two fonts (Kruti Dev and
 * Georgia) is taller than either alone. Also not size × lineHeight exactly:
 * WebKit rounds line heights down to whole pixels (22px × 1.3 is 28 there,
 * 28.6 in Chrome and Firefox). Read once per font and size from a hidden
 * probe, and cached.
 */
function inlineBox(family: string, size: number, lineHeight: number): InlineBox {
  const key = `${family}/${size}/${lineHeight}`
  let box = inlineBoxes.get(key)
  if (box === undefined) {
    const probe = document.createElement("div")
    probe.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;white-space:nowrap;font-family:${family};font-size:${size}px;line-height:${lineHeight}`
    const baseline = document.createElement("span")
    baseline.style.cssText = "display:inline-block;width:0;height:0"
    probe.append("x", baseline)
    document.body.append(probe)
    const rect = probe.getBoundingClientRect()
    const above = baseline.getBoundingClientRect().top - rect.top
    box = { above, below: rect.height - above }
    probe.remove()
    inlineBoxes.set(key, box)
  }
  return box
}

/** A line box's height: from the highest top to the lowest bottom of its inline boxes. */
function lineHeightOf(boxes: InlineBox[]): number {
  let above = 0
  let below = 0
  for (const b of boxes) {
    above = Math.max(above, b.above)
    below = Math.max(below, b.below)
  }
  return above + below
}

/** `strong` is `font-weight: bolder` in the UA stylesheet. */
const bolder = (weight: number) => (weight < 600 ? 700 : 900)

function runFont(marks: readonly Mark[], base: BlockStyle, column: Column): { font: string; family: string; size: number } {
  let size = base.size
  let weight = base.weight
  let italic = false
  let family = column.family
  for (const mark of marks) {
    if (mark.type.name === "strong") weight = bolder(base.weight)
    else if (mark.type.name === "em") italic = true
    else if (mark.type.name === "fontSize") size = mark.attrs.size as number
    else if (mark.type.name === "fontFamily") family = mark.attrs.family as string
  }
  return { font: `${italic ? "italic " : ""}${weight} ${size}px ${family}`, family, size }
}

/** The editor's text column: its content width and font-family, read from the editor. */
export interface Column {
  width: number
  family: string
}

interface Line {
  height: number
  /** Node-local offset of the line's first non-space character, or null for a line without one. */
  pos: number | null
}

/**
 * One block's height and split candidates, or null when the block isn't a
 * paragraph or heading, or holds inline content other than text and hard
 * breaks.
 *
 * Line heights follow CSS for a unitless line-height: each run's inline box
 * is aligned on the baseline (inlineBox), and a line spans from the highest
 * top to the lowest bottom, the block's own strut included. Split candidates use the same convention as
 * measure.ts: positions relative to the content start, heights to the
 * carried line's line-box top.
 */
export function measureWithPretext(unit: Unit, column: Column): MeasuredBlock | null {
  const { node } = unit
  const style = blockStyle(node)
  if (!style) return null

  // Every line holds the block's own strut, in its font and size.
  const strut = inlineBox(column.family, style.size, style.lineHeight)
  const items: RichInlineItem[] = []
  const starts: number[] = []
  const boxes: InlineBox[] = []
  let supported = true
  node.forEach((child, offset) => {
    if (child.isText) {
      const run = runFont(child.marks, style, column)
      items.push({ text: child.text!, font: run.font })
      boxes.push(inlineBox(run.family, run.size, style.lineHeight))
    } else if (child.type.name === "hard_break") {
      items.push({ text: "\n", font: runFont([], style, column).font })
      boxes.push(strut)
    } else {
      supported = false
    }
    starts.push(offset)
  })
  if (!supported) return null

  const lines: Line[] = []
  if (items.length > 0) {
    // The editor is white-space: pre-wrap (#paper .ProseMirror).
    const prepared = prepareRichInline(items, { whiteSpace: "pre-wrap" })
    for (const range of lineRanges(prepared, items, column.width)) {
      const line = materializeRichInlineLineRange(prepared, range)
      const onLine = [strut]
      let pos: number | null = null
      for (const fragment of line.fragments) {
        if (fragment.text.length > 0) onLine.push(boxes[fragment.itemIndex])
        if (pos === null) {
          const k = fragment.text.search(/\S/)
          if (k >= 0) pos = starts[fragment.itemIndex] + fragment.sourceStart + k
        }
      }
      lines.push({ height: lineHeightOf(onLine), pos })
    }
  }
  // An empty block still renders one line, and a trailing hard break gets a
  // line of its own from ProseMirror's trailing <br>; Pretext counts neither.
  if (lines.length === 0 || node.lastChild?.type.name === "hard_break") {
    lines.push({ height: lineHeightOf([strut]), pos: null })
  }

  let top = 0
  const splits: SplitCandidate[] = []
  lines.forEach((line, i) => {
    if (i > 0 && line.pos !== null) splits.push({ pos: line.pos, height: style.padTop + top })
    top += line.height
  })
  return {
    height: style.padTop + top + style.padBottom,
    splitCandidates: unit.kind === "splittable" && splits.length > 0 ? splits : null,
  }
}

/**
 * The editor's text column: its content box, inside the side padding that is
 * the page margin, and its font-family (Kruti Dev for a Hindi document). One
 * layout read per pass, in place of reading every word's rect.
 */
export function editorColumn(view: EditorView): Column {
  const style = getComputedStyle(view.dom)
  return {
    width: view.dom.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    family: style.fontFamily,
  }
}
