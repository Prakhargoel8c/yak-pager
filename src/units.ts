/**
 * UNITS — what pagination places. One walk over the document decides what a
 * unit is, where it starts and ends, and how the solver may treat it:
 *
 *   splittable  may break at a line boundary (a paragraph)
 *   atomic      moves whole (a heading, a rule)
 *   forced      ends its page after itself (an explicit page break)
 *
 * The pass, the Pretext/DOM comparison and the print cutter all walk the
 * document through here. Nested content (lists, table rows) would change
 * this walk and nothing else.
 */
import type { Node as PMNode } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"

export type UnitKind = "splittable" | "atomic" | "forced"

export interface Unit {
  node: PMNode
  /** Doc position of the unit's start. */
  pos: number
  /** Doc position just after the unit. */
  end: number
  /** Doc position of the unit's first content; split candidates are relative to it. */
  contentStart: number
  kind: UnitKind
}

export function unitKind(node: PMNode): UnitKind {
  if (node.type.name === "pageBreak") return "forced"
  if (node.type.name === "paragraph") return "splittable"
  return "atomic"
}

export function units(doc: PMNode): Unit[] {
  const out: Unit[] = []
  doc.forEach((node, pos) => {
    out.push({ node, pos, end: pos + node.nodeSize, contentStart: pos + 1, kind: unitKind(node) })
  })
  return out
}

/** The unit's rendered element. */
export const unitDOM = (view: EditorView, unit: Unit) => view.nodeDOM(unit.pos) as HTMLElement | null
