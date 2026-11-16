import { describe, it, expect } from "vitest"
import type { Node as PMNode } from "prosemirror-model"
import { schema } from "../src/schema"
import { pageGeometry, DEFAULT_MARGINS } from "../src/layout"
import type { MeasuredBlock } from "../src/measure"
import type { Measurer } from "../src/measurers"
import { runPass } from "../src/pass"
import type { Unit } from "../src/units"

const geometry = pageGeometry(DEFAULT_MARGINS)
const t = (s: string) => schema.text(s)
const p = (s: string) => schema.nodes.paragraph.create(null, t(s))

/** A measurer that answers from a table of heights by text, declining anything else. */
function fake(heights: Record<string, MeasuredBlock>) {
  const calls: string[] = []
  let invalidated = 0
  const m: Measurer = {
    measure(unit: Unit) {
      calls.push(unit.node.textContent)
      return heights[unit.node.textContent] ?? null
    },
    invalidate() {
      invalidated++
    },
  }
  return { m, calls, invalidated: () => invalidated }
}

const block = (height: number): MeasuredBlock => ({ height, splitCandidates: null })

describe("runPass", () => {
  it("measures every unit on the first pass and only the dirty range after", () => {
    const doc = schema.nodes.doc.create(null, [p("a"), p("b"), p("c")])
    const cache = new WeakMap<PMNode, MeasuredBlock>()
    const { m, calls } = fake({ a: block(100), b: block(200), c: block(300) })
    const first = runPass({ doc, geometry, measurers: [m], dirty: null, full: false, cache })
    expect(first.measured).toBe(3)
    expect(first.total).toBe(3)
    expect(first.layout.pages).toEqual([{ start: 0, fill: 600, opening: null }])

    calls.length = 0
    const second = runPass({ doc, geometry, measurers: [m], dirty: { from: 4, to: 5 }, full: false, cache })
    expect(second.measured).toBe(1)
    expect(calls).toEqual(["b"])
  })

  it("a full pass invalidates the measurers and re-measures everything", () => {
    const doc = schema.nodes.doc.create(null, [p("a"), p("b")])
    const cache = new WeakMap<PMNode, MeasuredBlock>()
    const { m, invalidated } = fake({ a: block(10), b: block(20) })
    runPass({ doc, geometry, measurers: [m], dirty: null, full: false, cache })
    const r = runPass({ doc, geometry, measurers: [m], dirty: null, full: true, cache })
    expect(r.measured).toBe(2)
    expect(invalidated()).toBe(1)
  })

  it("falls through to the next measurer when the first declines", () => {
    const doc = schema.nodes.doc.create(null, [p("a"), schema.nodes.horizontal_rule.create()])
    const cache = new WeakMap<PMNode, MeasuredBlock>()
    const first = fake({ a: block(100) })
    const second = fake({ "": block(30) })
    const r = runPass({ doc, geometry, measurers: [first.m, second.m], dirty: null, full: false, cache })
    expect(second.calls).toEqual([""])
    expect(r.layout.pages[0].fill).toBe(130)
  })

  it("reports pages with their start, fill and opening break", () => {
    // 800 + 200 overflows: the second paragraph opens page 2 at a block
    // boundary. The third splits at its one line boundary: page 3 opens
    // inside it, and the carried part is measured by the solver's rule.
    const doc = schema.nodes.doc.create(null, [p("a"), p("b"), p("long paragraph")])
    const cache = new WeakMap<PMNode, MeasuredBlock>()
    const { m } = fake({
      a: block(800),
      b: block(200),
      "long paragraph": { height: 1000, splitCandidates: [{ pos: 5, height: 600 }] },
    })
    const { layout } = runPass({ doc, geometry, measurers: [m], dirty: null, full: false, cache })
    const units = [0, 3, 6]
    expect(layout.breaks.map((b) => b.pos)).toEqual([units[1], units[2] + 1 + 5])
    expect(layout.pages.map((pg) => pg.opening)).toEqual([null, "between", "inside"])
    expect(layout.pages.map((pg) => pg.start)).toEqual([0, 864 + 216, 2 * (864 + 216)])
    expect(layout.pages.map((pg) => pg.fill)).toEqual([800, 800, 400])
    expect(layout.geometry).toBe(geometry)
  })

  it("an explicit page break forces a break before the next unit", () => {
    const doc = schema.nodes.doc.create(null, [p("a"), schema.nodes.pageBreak.create(), p("b")])
    const cache = new WeakMap<PMNode, MeasuredBlock>()
    const { m } = fake({ a: block(100), b: block(100), "": block(17) })
    const { layout } = runPass({ doc, geometry, measurers: [m], dirty: null, full: false, cache })
    expect(layout.breaks).toEqual([{ pos: 4, remaining: 864 - 117 }])
    expect(layout.pages[1].opening).toBe("between")
  })
})
