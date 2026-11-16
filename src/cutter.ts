/**
 * PAGE CUTTER — the document sliced into pages at the layout's breaks, as
 * document nodes. Each page is the slice between two breaks: a break at a
 * unit's start opens a page with that unit, a break inside a paragraph cuts
 * it into real halves, a break between table rows or list items cuts the
 * table or list, and every node the cut runs through is closed on one page
 * and reopened on the next, so nesting survives. A reopened ordered list
 * starts at the number of its first item there. Pure, so the print document
 * is built from the same pages the editor shows, and the cut is testable
 * without a browser.
 */
import type { Node as PMNode, ResolvedPos } from "prosemirror-model"
import type { PageBreak } from "./solver"
import { units } from "./units"

export interface Piece {
  node: PMNode
  /** The piece ends at a cut: the rest of it is on the next page. */
  continued: boolean
  /** How many levels deep the piece starts inside a cut (0: it starts whole). */
  continuation: number
}

/** Positions a page may start at: unit starts, and line starts inside a paragraph. */
function validBreaks(doc: PMNode, breaks: PageBreak[]): number[] {
  const all = units(doc)
  const starts = new Set(all.map((u) => u.pos))
  const ok = (p: number) =>
    p > 0 && p < doc.content.size && (starts.has(p) || all.some((u) => u.kind === "splittable" && p > u.contentStart && p < u.end - 1))
  return [...new Set(breaks.map((b) => b.pos))].filter(ok).sort((a, b) => a - b)
}

/** The first node of a slice, its open ordered lists renumbered from where `$from` cuts them. */
function reopen(node: PMNode, $from: ResolvedPos, depth: number, open: number): PMNode {
  if (depth > open) return node
  const first = node.firstChild
  const content = first && depth < open ? node.content.replaceChild(0, reopen(first, $from, depth + 1, open)) : node.content
  const attrs = node.type.name === "orderedList" ? { ...node.attrs, start: node.attrs.start + $from.index(depth) } : node.attrs
  return node.type.create(attrs, content, node.marks)
}

export function cutPages(doc: PMNode, breaks: PageBreak[]): Piece[][] {
  const bounds = [0, ...validBreaks(doc, breaks), doc.content.size]
  const pages: Piece[][] = []
  for (let k = 0; k + 1 < bounds.length; k++) {
    const slice = doc.slice(bounds[k], bounds[k + 1], true)
    const nodes: PMNode[] = []
    slice.content.forEach((n) => nodes.push(n))
    pages.push(
      nodes.map((n, i) => ({
        node: i === 0 && slice.openStart > 0 ? reopen(n, doc.resolve(bounds[k]), 1, slice.openStart) : n,
        continued: i === nodes.length - 1 && slice.openEnd > 0,
        continuation: i === 0 ? slice.openStart : 0,
      }))
    )
  }
  return pages
}
