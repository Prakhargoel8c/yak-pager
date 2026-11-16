/**
 * Measurer adapters: a unit's height and split candidates, or null to
 * decline. pretextMeasurer computes from the document (pretextMeasure.ts)
 * and declines what it can't model; domMeasurer reads the rendered block
 * (measure.ts) and never declines.
 */
import type { EditorView } from "prosemirror-view"
import { clearCache } from "@chenglou/pretext"
import { measureBlock } from "./measure"
import type { MeasuredBlock } from "./measure"
import { clearInlineBoxes, editorColumn, measureWithPretext } from "./pretextMeasure"
import { units } from "./units"
import type { Unit } from "./units"
import type { SplitCandidate } from "./solver"

export interface Measurer {
  measure(unit: Unit): MeasuredBlock | null
  /** Forget anything measured in a font that has since loaded. */
  invalidate(): void
}

export function domMeasurer(view: EditorView): Measurer {
  return {
    measure: (unit) => measureBlock(view, view.nodeDOM(unit.at) as HTMLElement | null, unit),
    invalidate() {},
  }
}

/** Reads the editor's column once, so create it per pass, after the geometry is applied. */
export function pretextMeasurer(view: EditorView): Measurer {
  const column = editorColumn(view)
  return {
    measure: (unit) => measureWithPretext(unit, column),
    invalidate() {
      clearCache()
      clearInlineBoxes()
    },
  }
}

export interface MeasureDiff {
  index: number
  /** The block's document position. */
  offset: number
  type: string
  text: string
  dom: MeasuredBlock
  pretext: MeasuredBlock
}

const sameSplits = (a: SplitCandidate[] | null, b: SplitCandidate[] | null) =>
  (a ?? []).length === (b ?? []).length &&
  (a ?? []).every((s, i) => s.pos === b![i].pos && Math.abs(s.height - b![i].height) < 0.5)

/** Where the two adapters disagree (a height off by 0.5px or more, or different split candidates), for tests/pretext-compare.mjs. */
export function compareWithDom(view: EditorView): { compared: number; diffs: MeasureDiff[]; rows: { pos: number; dom: number; pretext: number }[] } {
  const pretext = pretextMeasurer(view)
  const dom = domMeasurer(view)
  const diffs: MeasureDiff[] = []
  const rows: { pos: number; dom: number; pretext: number }[] = []
  let compared = 0
  units(view.state.doc).forEach((unit, index) => {
    const p = pretext.measure(unit)
    if (!p) return
    compared++
    const d = dom.measure(unit)!
    if (unit.row) rows.push({ pos: unit.at, dom: d.height, pretext: p.height })
    if (Math.abs(d.height - p.height) >= 0.5 || !sameSplits(d.splitCandidates, p.splitCandidates)) {
      diffs.push({ index, offset: unit.at, type: unit.node.type.name, text: unit.node.textContent.slice(0, 80), dom: d, pretext: p })
    }
  })
  return { compared, diffs, rows }
}
