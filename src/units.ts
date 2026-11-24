/**
 * What pagination places: one walk over the document into the units the
 * solver stacks. Lists are walked into and a table is placed row by row; a
 * block that opens its item, list or table starts its unit there, so a break
 * before it falls before the container (an item is never parted from its
 * marker). The pass, the Pretext/DOM comparison and the print cutter all
 * walk the document through here.
 */
import type { Node as PMNode } from "prosemirror-model"
import { TableMap } from "prosemirror-tables"
import { LIST, TABLE } from "./typography"

/** splittable: may break at a line boundary. atomic: moves whole. forced: ends its page after itself. */
export type UnitKind = "splittable" | "atomic" | "forced"

export interface Unit {
  node: PMNode
  /** Where the unit starts: the node, or the item, list or table it opens. */
  pos: number
  /** Where the node itself is. */
  at: number
  end: number
  /** Split candidates are relative to this. */
  contentStart: number
  kind: UnitKind
  /** Indent from the column in px: LIST.indent per enclosing list. */
  inset: number
  row?: { table: PMNode; index: number }
  /** Height beyond the node's own box: a table's top border and tail, on its first and last row. */
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
    if (node.type.name === "table" && !hasRowspan(node)) {
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
