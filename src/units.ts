/**
 * UNITS — what pagination places. One walk over the document decides what a
 * unit is, where it starts and ends, and how the solver may treat it:
 *
 *   splittable  may break at a line boundary (a paragraph)
 *   atomic      moves whole (a heading, a rule, a table row)
 *   forced      ends its page after itself (an explicit page break)
 *
 * Lists are walked into: every block of every item is a unit of its own,
 * indented LIST.indent per level, so a paragraph deep in a list still splits
 * at a line boundary. A block that is the first content of its item (and of
 * its list) starts its unit where that item or list starts, so a break
 * before it falls before the item, never between an item and its marker.
 *
 * A top-level table is placed row by row, so a page may end between two rows
 * but never inside one; its first row's unit starts at the table, and the
 * table's top border and the space below it are the first and last rows'
 * `extra`. A table with a rowspan, or one inside a list, moves whole.
 *
 * The pass, the Pretext/DOM comparison and the print cutter all walk the
 * document through here.
 */
import type { Node as PMNode } from "prosemirror-model"
import { TableMap } from "prosemirror-tables"
import { LIST, TABLE } from "./typography"

export type UnitKind = "splittable" | "atomic" | "forced"

export interface Unit {
  node: PMNode
  /** Doc position of the unit's start: the node's, or an enclosing item's, list's or table's it opens. */
  pos: number
  /** Doc position of the node itself. */
  at: number
  /** Doc position just after the unit. */
  end: number
  /** Doc position of the unit's first content; split candidates are relative to it. */
  contentStart: number
  kind: UnitKind
  /** How far the unit is indented from the column, in px (list levels). */
  inset: number
  /** For a table row: its table and index. */
  row?: { table: PMNode; index: number }
  /** Height the unit has beyond its node's own box (a table's border and tail). */
  extra: number
}

function unitKind(node: PMNode): UnitKind {
  if (node.type.name === "pageBreak") return "forced"
  if (node.type.name === "paragraph") return "splittable"
  return "atomic"
}

export const isList = (node: PMNode) => node.type.name === "bulletList" || node.type.name === "orderedList"

const hasRowspan = (table: PMNode) => {
  let found = false
  table.forEach((row) => row.forEach((cell) => (found ||= cell.attrs.rowspan > 1)))
  return found
}

/** The blocks of `parent` (content at `start`), the first opening at `lead` when given. */
function walk(parent: PMNode, start: number, inset: number, lead: number | null, out: Unit[]) {
  parent.forEach((node, offset, index) => {
    const at = start + offset
    const pos = index === 0 && lead != null ? lead : at
    if (isList(node)) {
      node.forEach((item, itemOffset, itemIndex) => {
        const itemAt = at + 1 + itemOffset
        walk(item, itemAt + 1, inset + LIST.indent, itemIndex === 0 ? pos : itemAt, out)
      })
      return
    }
    if (node.type.name === "table" && inset === 0 && !hasRowspan(node)) {
      const last = node.childCount - 1
      node.forEach((row, rowOffset, i) => {
        const rowAt = at + 1 + rowOffset
        out.push({
          node: row,
          pos: i === 0 ? pos : rowAt,
          at: rowAt,
          end: i === last ? at + node.nodeSize : rowAt + row.nodeSize,
          contentStart: rowAt + 1,
          kind: "atomic",
          inset,
          row: { table: node, index: i },
          extra: (i === 0 ? TABLE.border : 0) + (i === last ? TABLE.tail : 0),
        })
      })
      return
    }
    out.push({ node, pos, at, end: at + node.nodeSize, contentStart: at + 1, kind: unitKind(node), inset, extra: 0 })
  })
}

export function units(doc: PMNode): Unit[] {
  const out: Unit[] = []
  walk(doc, 0, 0, null, out)
  return out
}

/** What a break at `pos` sits in: the lists around it (one LIST.indent each), and the table's column count when it falls between two rows. */
export function breakSite(doc: PMNode, pos: number): { inset: number; columns: number } {
  const $pos = doc.resolve(pos)
  let lists = 0
  for (let d = 1; d <= $pos.depth; d++) if (isList($pos.node(d))) lists++
  const columns = $pos.parent.type.name === "table" ? TableMap.get($pos.parent).width : 0
  return { inset: lists * LIST.indent, columns }
}
