/**
 * PAGE CUTTER — the document sliced into pages at the layout's breaks, as
 * document nodes: a break at a unit's start opens a page with that unit; a
 * break inside a splittable unit cuts it into real halves, one per page.
 * Pure, so the print document is built from the same pages the editor
 * shows, and the cut is testable without a browser.
 */
import type { Node as PMNode } from "prosemirror-model"
import type { BreakInfo } from "./layout"
import { units } from "./units"

export interface Piece {
  node: PMNode
  /** The piece ends at a cut: the rest of its unit is on the next page. */
  continued: boolean
}

export function cutPages(doc: PMNode, breaks: BreakInfo[]): Piece[][] {
  const positions = breaks.map((b) => b.pos).sort((a, b) => a - b)
  const starts = new Set(positions)
  const pages: Piece[][] = [[]]
  const page = () => pages[pages.length - 1]
  for (const u of units(doc)) {
    if (starts.has(u.pos)) pages.push([])
    const size = u.node.content.size
    const cuts =
      u.kind === "splittable" ? positions.map((p) => p - u.contentStart).filter((c) => c > 0 && c < size) : []
    if (cuts.length === 0) {
      page().push({ node: u.node, continued: false })
      continue
    }
    let from = 0
    for (const stop of [...cuts, size]) {
      if (from > 0) pages.push([])
      page().push({ node: u.node.copy(u.node.content.cut(from, stop)), continued: stop < size })
      from = stop
    }
  }
  return pages
}
