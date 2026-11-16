/**
 * The pagination pass: measure, then solve. Touches no DOM itself (the
 * measurers do) and dispatches nothing, so it runs in Node with a fake
 * measurer. Measurements are cached by Node identity: PM nodes are immutable
 * values, so an untouched block keeps its Node across a transaction.
 */
import type { Node as PMNode } from "prosemirror-model"
import type { Layout, PageGeometry } from "./layout"
import type { MeasuredBlock } from "./measure"
import type { Measurer } from "./measurers"
import { solve } from "./solver"
import type { Block } from "./solver"
import { units } from "./units"
import type { Unit } from "./units"

/** Measurements by Node identity, with the inset each was taken at: a block moved into or out of a list is re-measured. */
export type MeasureCache = WeakMap<PMNode, MeasuredBlock & { inset: number }>

export interface PassInput {
  doc: PMNode
  geometry: PageGeometry
  /** Asked in order; the first that does not decline answers. */
  measurers: Measurer[]
  dirty: { from: number; to: number } | null
  /** Re-measure everything and drop what the measurers cached. */
  full: boolean
  cache: MeasureCache
}

export interface PassResult {
  layout: Layout
  measured: number
  total: number
  ms: { measure: number; solve: number }
}

function measure(measurers: Measurer[], unit: Unit): MeasuredBlock {
  for (const m of measurers) {
    const r = m.measure(unit)
    if (r) return r
  }
  return { height: 0, splitCandidates: null }
}

export function runPass({ doc, geometry, measurers, dirty, full, cache }: PassInput): PassResult {
  const t0 = performance.now()
  if (full) for (const m of measurers) m.invalidate()

  const all = units(doc)
  const blocks: Block[] = []
  const forced: number[] = []
  let measured = 0
  for (const u of all) {
    const inDirty = dirty != null && u.pos < dirty.to && u.end > dirty.from
    let m = cache.get(u.node)
    if (full || m === undefined || inDirty || m.inset !== u.inset) {
      m = { ...measure(measurers, u), inset: u.inset }
      cache.set(u.node, m)
      measured++
    }
    const splits = m.splitCandidates?.map((s) => ({ pos: u.contentStart + s.pos, height: s.height }))
    blocks.push({ pos: u.pos, height: m.height + u.extra, splits })
    if (u.kind === "forced") forced.push(u.pos)
  }
  const t1 = performance.now()

  const { breaks, pageStarts, fills } = solve(blocks, geometry.contentH, forced, geometry.band)
  const starts = new Set(all.map((u) => u.pos))
  const pages = pageStarts.map((start, i) => ({
    start,
    fill: fills[i],
    opening: i === 0 ? null : starts.has(breaks[i - 1].pos) ? ("between" as const) : ("inside" as const),
  }))
  const t2 = performance.now()

  return {
    layout: { geometry, breaks, pages },
    measured,
    total: all.length,
    ms: { measure: t1 - t0, solve: t2 - t1 },
  }
}
