import { describe, it, expect } from "vitest"
import type { Node as PMNode } from "prosemirror-model"
import { schema } from "../src/schema"
import { breakSite, units } from "../src/units"
import { cutPages } from "../src/cutter"
import { runPass } from "../src/pass"
import { pageGeometry, DEFAULT_MARGINS } from "../src/layout"
import type { MeasuredBlock } from "../src/measure"
import type { Measurer } from "../src/measurers"
import { TABLE } from "../src/typography"

const { doc, paragraph, orderedList, listItem, table, tableRow, tableCell } = schema.nodes
const p = (s: string) => paragraph.create(null, schema.text(s))
const li = (...blocks: PMNode[]) => listItem.create(null, blocks)
const ol = (...items: PMNode[]) => orderedList.create(null, items)
const grid = (...rows: string[]) => table.create(null, rows.map((s) => tableRow.create(null, tableCell.create(null, p(s)))))

const geometry = pageGeometry(DEFAULT_MARGINS)
const { contentH } = geometry
const block = (height: number): MeasuredBlock => ({ height, splitCandidates: null })
const run = (d: PMNode, heights: Record<string, number>) => {
  const fake: Measurer = { measure: (u) => block(heights[u.node.textContent] ?? 0), invalidate() {} }
  return runPass({ doc: d, geometry, measurers: [fake], dirty: null, full: false, cache: new WeakMap() }).layout
}
const unitAt = (d: PMNode, text: string) => units(d).find((u) => u.node.textContent === text)!
const text = (pages: ReturnType<typeof cutPages>) => pages.map((page) => page.map((x) => x.node.textContent))

describe("a table inside a list item, taller than a page", () => {
  const d = doc.create(null, [p("intro"), ol(li(p("one"), grid("t1", "t2", "t3"), p("after"))), p("outro")])
  const layout = run(d, { intro: 100, one: 24, t1: 500, t2: 500, t3: 500, after: 24, outro: 24 })
  const [t2, t3] = [unitAt(d, "t2"), unitAt(d, "t3")]

  it("breaks between its rows, across as many pages as it needs", () => {
    // 100 + 24 + (500 + 1) = 625, then t2 (500) does not fit; t2 alone, then t3 + tail does not fit.
    expect(layout.breaks).toEqual([
      { pos: t2.pos, remaining: contentH - 625 },
      { pos: t3.pos, remaining: contentH - 500 },
    ])
    expect(layout.breaks.every((b) => breakSite(d, b.pos).columns === 1 && breakSite(d, b.pos).inset === 24)).toBe(true)
  })

  it("never overflows a page", () => {
    expect(layout.pages.map((pg) => pg.fill)).toEqual([625, 500, 500 + TABLE.tail + 24 + 24])
    expect(layout.pages.every((pg) => pg.fill <= contentH)).toBe(true)
  })

  it("prints a slice of the table on each page, inside its reopened list and item", () => {
    const pages = cutPages(d, layout.breaks)
    expect(text(pages)).toEqual([["intro", "onet1"], ["t2"], ["t3after", "outro"]])
    for (const page of pages.slice(1)) {
      const item = page[0].node.firstChild!
      expect(page[0].node.type).toBe(orderedList)
      expect(item.type).toBe(listItem)
      expect(item.firstChild!.type).toBe(table)
      expect(item.firstChild!.childCount).toBe(1)
    }
  })
})
