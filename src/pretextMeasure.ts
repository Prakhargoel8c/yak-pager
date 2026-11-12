/**
 * MEASURE without the DOM: paragraph and heading heights, and the paragraph
 * line boundaries the solver splits at, computed with Pretext
 * (@chenglou/pretext) from the node's text and marks alone.
 *
 * Pretext measures text with Canvas and breaks lines by the browser engine's
 * own rules, so it predicts the lines the editor paints without a layout
 * read. The DOM path (measure.ts) stays the reference and the fallback:
 * measureWithPretext returns null for anything it cannot model, and runPass
 * then measures that block from the DOM as before.
 *
 * Because no DOM is read, a paragraph that currently holds its gap widget
 * needs no widget subtraction: the numbers come from the document, so
 * re-measuring is idempotent by construction.
 *
 * The styles below must match styles.css (#paper .ProseMirror and its
 * blocks), the same way layout.ts and styles.css share their geometry.
 */
import type { Mark, Node as PMNode } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import {
  materializeRichInlineLineRange,
  prepareRichInline,
  walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline"
import type { RichInlineItem } from "@chenglou/pretext/rich-inline"
import { measureBlock } from "./measure"
import type { MeasuredBlock } from "./measure"
import type { SplitCandidate } from "./solver"

/** #paper .ProseMirror font-family. */
const FAMILY = 'Georgia, "Times New Roman", serif'

interface BlockStyle {
  size: number
  /** Unitless CSS line-height: a run in another font size gets size × this. */
  lineHeight: number
  weight: number
  padTop: number
  padBottom: number
}

const PARAGRAPH: BlockStyle = { size: 16, lineHeight: 1.5, weight: 400, padTop: 0, padBottom: 10 }
const HEADINGS: Record<number, BlockStyle> = {
  1: { size: 28, lineHeight: 1.25, weight: 700, padTop: 18, padBottom: 10 },
  2: { size: 22, lineHeight: 1.3, weight: 700, padTop: 16, padBottom: 8 },
  3: { size: 18, lineHeight: 1.35, weight: 600, padTop: 12, padBottom: 8 },
}

function blockStyle(node: PMNode): BlockStyle | null {
  if (node.type.name === "paragraph") return PARAGRAPH
  if (node.type.name === "heading") return HEADINGS[node.attrs.level as number] ?? null
  return null
}

const lineHeights = new Map<string, number>()

/**
 * The height of one line of `size`px text at a unitless `lineHeight`, as
 * this browser lays it out. Not size × lineHeight: WebKit rounds line
 * heights down to whole pixels (22px × 1.3 is 28 there, 28.6 in Chrome and
 * Firefox), so it is read once per size from a hidden probe and cached.
 */
function lineHeightPx(size: number, lineHeight: number): number {
  const key = `${size}/${lineHeight}`
  let px = lineHeights.get(key)
  if (px === undefined) {
    const probe = document.createElement("div")
    probe.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;white-space:nowrap;font-family:${FAMILY};font-size:${size}px;line-height:${lineHeight}`
    probe.textContent = "x"
    document.body.append(probe)
    px = probe.getBoundingClientRect().height
    probe.remove()
    lineHeights.set(key, px)
  }
  return px
}

/** `strong` is `font-weight: bolder` in the UA stylesheet. */
const bolder = (weight: number) => (weight < 600 ? 700 : 900)

function runFont(marks: readonly Mark[], base: BlockStyle): { font: string; size: number } {
  let size = base.size
  let weight = base.weight
  let italic = false
  for (const mark of marks) {
    if (mark.type.name === "strong") weight = bolder(base.weight)
    else if (mark.type.name === "em") italic = true
    else if (mark.type.name === "fontSize") size = mark.attrs.size as number
  }
  return { font: `${italic ? "italic " : ""}${weight} ${size}px ${FAMILY}`, size }
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
 * Line heights follow CSS for a unitless line-height in one font family: a
 * line is as tall as one line of its largest font size (lineHeightPx),
 * never less than the block's own (the strut). Split candidates use the same convention as
 * measure.ts: positions relative to the content start, heights to the
 * carried line's line-box top.
 */
export function measureWithPretext(node: PMNode, contentWidth: number): MeasuredBlock | null {
  const style = blockStyle(node)
  if (!style) return null

  const items: RichInlineItem[] = []
  const starts: number[] = []
  const sizes: number[] = []
  let supported = true
  node.forEach((child, offset) => {
    if (child.isText) {
      const run = runFont(child.marks, style)
      items.push({ text: child.text!, font: run.font })
      sizes.push(run.size)
    } else if (child.type.name === "hard_break") {
      items.push({ text: "\n", font: runFont([], style).font })
      sizes.push(style.size)
    } else {
      supported = false
    }
    starts.push(offset)
  })
  if (!supported) return null

  const strut = lineHeightPx(style.size, style.lineHeight)
  const lines: Line[] = []
  if (items.length > 0) {
    // The editor is white-space: pre-wrap (#paper .ProseMirror).
    const prepared = prepareRichInline(items, { whiteSpace: "pre-wrap" })
    walkRichInlineLineRanges(prepared, contentWidth, (range) => {
      const line = materializeRichInlineLineRange(prepared, range)
      let tallest = style.size
      let pos: number | null = null
      for (const fragment of line.fragments) {
        if (fragment.text.length > 0) tallest = Math.max(tallest, sizes[fragment.itemIndex])
        if (pos === null) {
          const k = fragment.text.search(/\S/)
          if (k >= 0) pos = starts[fragment.itemIndex] + fragment.sourceStart + k
        }
      }
      lines.push({ height: lineHeightPx(tallest, style.lineHeight), pos })
    })
  }
  // An empty block still renders one line, and a trailing hard break gets a
  // line of its own from ProseMirror's trailing <br>; Pretext counts neither.
  if (lines.length === 0 || node.lastChild?.type.name === "hard_break") {
    lines.push({ height: strut, pos: null })
  }

  let top = 0
  const splits: SplitCandidate[] = []
  lines.forEach((line, i) => {
    if (i > 0 && line.pos !== null) splits.push({ pos: line.pos, height: style.padTop + top })
    top += line.height
  })
  return {
    height: style.padTop + top + style.padBottom,
    splitCandidates: node.type.name === "paragraph" && splits.length > 0 ? splits : null,
  }
}

export interface MeasureDiff {
  index: number
  type: string
  text: string
  dom: MeasuredBlock
  pretext: MeasuredBlock
}

const sameSplits = (a: SplitCandidate[] | null, b: SplitCandidate[] | null) =>
  (a ?? []).length === (b ?? []).length &&
  (a ?? []).every((s, i) => s.pos === b![i].pos && Math.abs(s.height - b![i].height) < 0.5)

/**
 * The editor's text column in px: its content box, inside the side padding
 * that is the page margin. One layout read per pass, in place of reading
 * every word's rect.
 */
export function editorContentWidth(view: EditorView): number {
  const style = getComputedStyle(view.dom)
  return view.dom.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
}

/**
 * Measure every top-level block both ways and return where they disagree:
 * a height off by half a pixel or more, or different split candidates.
 * For checking the Pretext path against the DOM (tests/pretext-compare.mjs).
 */
export function compareWithDom(view: EditorView): { compared: number; diffs: MeasureDiff[] } {
  const diffs: MeasureDiff[] = []
  let compared = 0
  let index = 0
  const width = editorContentWidth(view)
  view.state.doc.forEach((node, offset) => {
    const i = index++
    const pretext = measureWithPretext(node, width)
    if (!pretext) return
    compared++
    const dom = measureBlock(view, view.nodeDOM(offset) as HTMLElement | null, node, offset + 1)
    if (Math.abs(dom.height - pretext.height) >= 0.5 || !sameSplits(dom.splitCandidates, pretext.splitCandidates)) {
      diffs.push({ index: i, type: node.type.name, text: node.textContent.slice(0, 80), dom, pretext })
    }
  })
  return { compared, diffs }
}
