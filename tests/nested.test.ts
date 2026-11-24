import { describe, it, expect } from "vitest"
import type { Node as PMNode } from "prosemirror-model"
import { schema } from "../src/schema"
import { breakSite, units } from "../src/units"
import { cutPages } from "../src/cutter"
import { runPass } from "../src/pass"
import { pageGeometry, DEFAULT_MARGINS } from "../src/layout"
import type { MeasuredBlock } from "../src/measure"
import type { Measurer } from "../src/measurers"
import { buildSeedDoc } from "../src/seed"
import { LIST, TABLE } from "../src/typography"

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
  const rows = units(d).filter((u) => u.row)

  it("is placed row by row, indented one level, the first row starting where the table is", () => {
    expect(units(d).map((x) => x.node.textContent)).toEqual(["intro", "one", "two", "h1h2", "ab", "cd", "after", "outro"])
    expect(rows.every((u) => u.kind === "atomic" && u.inset === LIST.indent && u.row!.table === t)).toBe(true)
    expect(rows[0].pos).toBe(tablePos)
    expect(rows[0].at).toBe(tablePos + 1)
    expect(rows.map((u) => u.extra)).toEqual([TABLE.border, 0, TABLE.tail])
  })

  it("is indented once per enclosing list", () => {
    const deep = doc.create(null, [ul(li(p("a"), ol(li(p("b"), ul(li(p("c"), t))))))])
    expect(units(deep).filter((u) => u.row).map((u) => u.inset)).toEqual([72, 72, 72])
  })

  it("breaks between its rows when one does not fit, the gap a row inside the item", () => {
    const { layout } = run(d, { intro: block(700), one: block(24), two: block(24), h1h2: block(40), ab: block(100), cd: block(40), after: block(24) })
    // 700 + 24 + 24 + (40 + 1) = 789; the next row (100) does not fit in 864.
    expect(layout.breaks).toEqual([{ pos: rows[1].pos, remaining: 864 - 789 }])
    expect(breakSite(d, rows[1].pos)).toEqual({ inset: LIST.indent, columns: 2 })
    expect(layout.pages[1]).toMatchObject({ fill: 100 + 40 + TABLE.tail + 24, opening: "between" })
  })

  it("moves with its first row: the break falls before the table, inside the item", () => {
    const { layout } = run(d, { intro: block(800), one: block(24), two: block(24), h1h2: block(40), ab: block(40) })
    expect(layout.breaks).toEqual([{ pos: tablePos, remaining: 864 - 848 }])
    expect(d.resolve(tablePos).parent.type).toBe(listItem)
    expect(breakSite(d, tablePos)).toEqual({ inset: LIST.indent, columns: 0 })
  })

  it("stays on the page when it fits", () => {
    const { layout } = run(d, { intro: block(500), one: block(24), two: block(24), h1h2: block(40), ab: block(40), cd: block(40), after: block(24) })
    expect(layout.breaks).toEqual([])
  })

  it("prints cut between rows, the list, item and table reopened, the numbering kept", () => {
    const pages = cutPages(d, [{ pos: rows[1].pos, remaining: 0 }])
    expect(text(pages)).toEqual([["intro", "onetwoh1h2"], ["abcdafter", "outro"]])
    expect(pages[0][1].continued).toBe(true)
    const first = pages[1][0]
    expect(first.node.type).toBe(orderedList)
    expect(first.node.attrs.start).toBe(2)
    expect(first.continuation).toBe(3)
    expect(first.node.firstChild!.firstChild!.type).toBe(table)
    expect(first.node.firstChild!.firstChild!.childCount).toBe(2)
  })
})

describe("the nested seed", () => {
  const d = buildSeedDoc("nested")

  it("holds tables in list items up to three lists deep", () => {
    const insets = units(d).filter((u) => u.row).map((u) => u.inset)
    expect(Math.max(...insets)).toBe(3 * LIST.indent)
  })

  it("is valid for the schema", () => {
    expect(() => d.check()).not.toThrow()
  })
})
