/**
 * UNITS — what pagination places. One walk over the document decides what a
 * unit is, where it starts and ends, and how the solver may treat it:
 *
 *   splittable  may break at a line boundary (a paragraph)
 *   atomic      moves whole (a heading, a rule, a table row)
 *   forced      ends its page after itself (an explicit page break)
 *
 * A table is placed row by row, so a page may end between two rows but
 * never inside one. The first row's unit starts at the table, so a break
 * before it falls before the table; the table's top border and the space
 * below it are the first and last rows' `extra`. A table with a rowspan
 * moves whole.
 *
 * The pass, the Pretext/DOM comparison and the print cutter all walk the
 * document through here.
 */
import type { Node as PMNode } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import { TABLE } from "./typography"

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
  /** For a table row: its table, index and own position. */
  row?: { table: PMNode; index: number; pos: number }
  /** Height the unit has beyond its node's own box (a table's border and tail). */
  extra: number
}

export function unitKind(node: PMNode): UnitKind {
  if (node.type.name === "pageBreak") return "forced"
  if (node.type.name === "paragraph") return "splittable"
  return "atomic"
}

const hasRowspan = (table: PMNode) => {
  let found = false
  table.forEach((row) => row.forEach((cell) => (found ||= cell.attrs.rowspan > 1)))
  return found
}

export function units(doc: PMNode): Unit[] {
  const out: Unit[] = []
  doc.forEach((node, pos) => {
    if (node.type.name !== "table" || hasRowspan(node)) {
      out.push({ node, pos, end: pos + node.nodeSize, contentStart: pos + 1, kind: unitKind(node), extra: 0 })
      return
    }
    const last = node.childCount - 1
    node.forEach((row, offset, index) => {
      const at = pos + 1 + offset
      out.push({
        node: row,
        pos: index === 0 ? pos : at,
        end: index === last ? pos + node.nodeSize : at + row.nodeSize,
        contentStart: at + 1,
        kind: "atomic",
        row: { table: node, index, pos: at },
        extra: (index === 0 ? TABLE.border : 0) + (index === last ? TABLE.tail : 0),
      })
    })
  })
  return out
}

/** The unit's rendered element: a row's <tr>, else the block. */
export const unitDOM = (view: EditorView, unit: Unit) => view.nodeDOM(unit.row?.pos ?? unit.pos) as HTMLElement | null
