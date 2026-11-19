import { describe, it, expect } from "vitest"
import type { Node as PMNode } from "prosemirror-model"
import { schema } from "../src/schema"
import { breakSite, units } from "../src/units"
import { cutPages } from "../src/cutter"
import { runPass } from "../src/pass"
import { pageGeometry, DEFAULT_MARGINS } from "../src/layout"
import type { MeasuredBlock } from "../src/measure"
import type { Measurer } from "../src/measurers"
import { measureWithPretext } from "../src/pretextMeasure"
import { buildSeedDoc } from "../src/seed"
import { LIST } from "../src/typography"

const { doc, paragraph, bulletList, orderedList, listItem, table, tableRow, tableCell } = schema.nodes
const p = (s = "") => paragraph.create(null, s ? schema.text(s) : [])
const li = (...blocks: PMNode[]) => listItem.create(null, blocks)
const ul = (...items: PMNode[]) => bulletList.create(null, items)
const ol = (...items: PMNode[]) => orderedList.create(null, items)
const td = (...blocks: PMNode[]) => tableCell.create(null, blocks)
const tr = (...cells: PMNode[]) => tableRow.create(null, cells)
const grid = (...rows: string[][]) => table.create(null, rows.map((r) => tr(...r.map((s) => td(p(s))))))

const geometry = pageGeometry(DEFAULT_MARGINS)
const block = (height: number): MeasuredBlock => ({ height, splitCandidates: null })
/** Heights by the unit's text; a unit not listed is 0px. */
const run = (d: PMNode, heights: Record<string, MeasuredBlock>) => {
  const fake: Measurer = { measure: (u) => heights[u.node.textContent] ?? block(0), invalidate() {} }
  return runPass({ doc: d, geometry, measurers: [fake], dirty: null, full: false, cache: new WeakMap() })
}
const posOf = (d: PMNode, type: (typeof schema.nodes)[string]) => {
  let found = -1
  d.descendants((n, pos) => {
    if (found < 0 && n.type === type) found = pos
    return found < 0
  })
  return found
}
const text = (pages: ReturnType<typeof cutPages>) => pages.map((page) => page.map((x) => x.node.textContent))

describe("a table inside a list item", () => {
  const t = grid(["h1", "h2"], ["a", "b"], ["c", "d"])
  const d = doc.create(null, [p("intro"), ol(li(p("one")), li(p("two"), t, p("after"))), p("outro")])
  const tablePos = posOf(d, table)

  it("is one atomic unit, indented one level, starting where the table is", () => {
    const u = units(d)
    expect(u.map((x) => x.node.textContent)).toEqual(["intro", "one", "two", "h1h2abcd", "after", "outro"])
    const unit = u[3]
    expect(unit.node.type).toBe(table)
    expect(unit.kind).toBe("atomic")
    expect(unit.row).toBeUndefined()
    expect(unit.inset).toBe(LIST.indent)
    expect(unit.pos).toBe(tablePos)
    expect(unit.at).toBe(tablePos)
    expect(unit.extra).toBe(0)
  })

  it("is indented once per enclosing list", () => {
    const deep = doc.create(null, [ul(li(p("a"), ol(li(p("b"), ul(li(p("c"), t))))))])
    const unit = units(deep).find((u) => u.node.type === table)!
    expect(unit.inset).toBe(3 * LIST.indent)
  })

  it("Pretext declines it, so the DOM measures it", () => {
    const unit = units(d).find((u) => u.node.type === table)!
    expect(measureWithPretext(unit, { width: 624, family: "Georgia" })).toBeNull()
  })

  it("moves whole when it does not fit, its break inside the item, before the table", () => {
    const { layout } = run(d, { intro: block(700), one: block(24), two: block(24), h1h2abcd: block(200), after: block(24) })
    expect(layout.breaks.map((b) => b.pos)).toEqual([tablePos])
    expect(d.resolve(tablePos).parent.type).toBe(listItem)
    expect(breakSite(d, tablePos)).toEqual({ inset: LIST.indent, columns: 0 })
    expect(layout.pages[1].opening).toBe("between")
    expect(layout.pages[1].fill).toBe(200 + 24 + 0)
  })

  it("stays on the page when it fits", () => {
    const { layout } = run(d, { intro: block(500), one: block(24), two: block(24), h1h2abcd: block(200), after: block(24) })
    expect(layout.breaks).toEqual([])
  })

  it("prints whole on the next page, inside its reopened list and item, the numbering kept", () => {
    const pages = cutPages(d, [{ pos: tablePos, remaining: 0 }])
    expect(text(pages)).toEqual([["intro", "onetwo"], ["h1h2abcdafter", "outro"]])
    const first = pages[1][0]
    expect(first.node.type).toBe(orderedList)
    expect(first.node.attrs.start).toBe(2)
    expect(first.continuation).toBe(2)
    expect(first.node.firstChild!.firstChild!.type).toBe(table)
    expect(first.node.firstChild!.firstChild!.childCount).toBe(3)
    expect(pages[0][1].continued).toBe(true)
  })
})

describe("the nested seed", () => {
  const d = buildSeedDoc("nested")

  it("holds tables in list items up to three lists deep", () => {
    const insets = units(d).filter((u) => u.node.type === table).map((u) => u.inset)
    expect(Math.max(...insets)).toBe(3 * LIST.indent)
  })

  it("is valid for the schema", () => {
    expect(() => d.check()).not.toThrow()
  })
})
