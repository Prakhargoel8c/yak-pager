import { describe, it, expect } from "vitest"
import { EditorState, TextSelection } from "prosemirror-state"
import type { Node as PMNode } from "prosemirror-model"
import { schema } from "../src/schema"
import { units } from "../src/units"
import { cutPages } from "../src/cutter"
import { runPass } from "../src/pass"
import { pageGeometry, DEFAULT_MARGINS } from "../src/layout"
import type { Measurer } from "../src/measurers"
import { columnWidths, insertTable, tableColumns } from "../src/tables"
import { TABLE } from "../src/typography"

const { table, tableRow, tableCell, tableHeader, paragraph, doc } = schema.nodes
const p = (s: string) => paragraph.create(null, schema.text(s))
const cell = (s: string, attrs: Record<string, unknown> | null = null) => tableCell.create(attrs, p(s))
const row = (...cells: PMNode[]) => tableRow.create(null, cells)
const grid = (rows: string[][]) => table.create(null, rows.map((r) => row(...r.map((s) => cell(s)))))

describe("table schema", () => {
  it("uses TipTap's node names and cell attrs", () => {
    const c = tableCell.create(null, p("x"))
    expect(c.attrs).toEqual({ colspan: 1, rowspan: 1, colwidth: null })
    expect(tableHeader.spec.tableRole).toBe("header_cell")
    expect(table.spec.content).toBe("tableRow+")
    expect(tableRow.spec.content).toBe("(tableCell | tableHeader)*")
  })

  it("insertTable puts a 3 × 3 table with a header row at the cursor, the cursor in its first cell", () => {
    const start = doc.create(null, [p("before")])
    const state = EditorState.create({ doc: start, selection: TextSelection.atEnd(start) })
    let next = state
    insertTable()(state, (tr) => (next = state.apply(tr)))
    const t = next.doc.child(1)
    expect(t.type).toBe(table)
    expect(t.childCount).toBe(3)
    expect(t.child(0).firstChild!.type).toBe(tableHeader)
    expect(t.child(1).firstChild!.type).toBe(tableCell)
    expect(t.child(0).childCount).toBe(3)
    expect(next.selection.$from.node(-1).type).toBe(tableHeader)
  })
})

describe("column widths", () => {
  it("shares the column in whole pixels, the last column taking the remainder", () => {
    expect(columnWidths([null, null, null], 640)).toEqual([213, 213, 214])
    expect(columnWidths([null, null, null], 624)).toEqual([208, 208, 208])
  })

  it("keeps resized columns and shares the rest", () => {
    expect(columnWidths([120, null, 200], 624)).toEqual([120, 304, 200])
    expect(columnWidths([120.4, 200], 624)).toEqual([120.4, 200])
  })

  it("never goes below the minimum column width", () => {
    expect(columnWidths([600, null], 624)).toEqual([600, TABLE.minCol])
  })

  it("reads columns from the first row, expanding colspans and rounding colwidths", () => {
    const t = table.create(null, [row(cell("a", { colspan: 2, colwidth: [100.6, 0] }), cell("b"))])
    expect(tableColumns(t)).toEqual([101, null, null])
  })
})

describe("table units", () => {
  const t = grid([["h1", "h2"], ["a", "b"], ["c", "d"]])
  const d = doc.create(null, [p("x"), t, p("y")])

  it("places a table row by row; the first row starts at the table, the last ends with it", () => {
    const u = units(d)
    expect(u.map((x) => x.node.type.name)).toEqual(["paragraph", "tableRow", "tableRow", "tableRow", "paragraph"])
    const tablePos = 3
    const rows: number[] = []
    t.forEach((_, offset) => rows.push(tablePos + 1 + offset))
    expect(u[1].pos).toBe(tablePos)
    expect(u.slice(2, 4).map((x) => x.pos)).toEqual(rows.slice(1))
    expect(u.slice(1, 4).map((x) => x.at)).toEqual(rows)
    expect(u[3].end).toBe(tablePos + t.nodeSize)
    expect(u.slice(1, 4).map((x) => x.kind)).toEqual(["atomic", "atomic", "atomic"])
  })

  it("gives the table's top border to its first row and the space below it to its last", () => {
    expect(units(d).map((x) => x.extra)).toEqual([0, TABLE.border, 0, TABLE.tail, 0])
    const single = units(doc.create(null, [grid([["only"]])]))
    expect(single.map((x) => x.extra)).toEqual([TABLE.border + TABLE.tail])
  })

  it("moves a table with a rowspan whole", () => {
    const spanned = table.create(null, [row(cell("a", { rowspan: 2 }), cell("b")), row(cell("c"))])
    const u = units(doc.create(null, [spanned]))
    expect(u).toHaveLength(1)
    expect(u[0].node.type).toBe(table)
    expect(u[0].row).toBeUndefined()
  })
})

describe("paginating table rows", () => {
  const geometry = pageGeometry(DEFAULT_MARGINS)
  const heights: Record<string, number> = { intro: 700, h1h2: 40, ab: 100, cd: 100, ef: 30 }
  const fake: Measurer = {
    measure: (u) => ({ height: heights[u.node.textContent] ?? 0, splitCandidates: null }),
    invalidate() {},
  }
  const run = (d: PMNode) =>
    runPass({ doc: d, geometry, measurers: [fake], dirty: null, full: false, cache: new WeakMap() })

  it("breaks between two rows, never inside one", () => {
    const t = grid([["h1", "h2"], ["a", "b"], ["c", "d"], ["e", "f"]])
    const d = doc.create(null, [p("intro"), t])
    const { layout } = run(d)
    // 700 + (40 + 1) + 100 = 841 fits in 864; the next row (100) does not.
    const thirdRow = units(d)[3]
    expect(layout.breaks).toEqual([{ pos: thirdRow.at, remaining: 864 - 841 }])
    expect(d.resolve(layout.breaks[0].pos).parent.type).toBe(table)
    expect(layout.pages.map((pg) => pg.fill)).toEqual([841, 100 + 30 + TABLE.tail])
    expect(layout.pages[1].opening).toBe("between")
  })

  it("a first row that does not fit moves the whole table", () => {
    heights.intro = 850
    const d = doc.create(null, [p("intro"), grid([["h1", "h2"], ["a", "b"]])])
    const { layout } = run(d)
    expect(layout.breaks.map((b) => b.pos)).toEqual([units(d)[1].pos])
    expect(d.resolve(layout.breaks[0].pos).parent.type).toBe(doc)
    heights.intro = 700
  })
})

describe("cutting a table between rows", () => {
  it("prints one table per page, with the rows that page holds", () => {
    const t = grid([["h1", "h2"], ["a", "b"], ["c", "d"]])
    const d = doc.create(null, [p("x"), t, p("y")])
    const third = units(d)[3]
    const pages = cutPages(d, [{ pos: third.pos, remaining: 0 }])
    expect(pages.map((pg) => pg.map((x) => x.node.textContent))).toEqual([["x", "h1h2ab"], ["cd", "y"]])
    expect(pages[0][1].node.type).toBe(table)
    expect(pages[0][1].continued).toBe(true)
    expect(pages[1][0].node.type).toBe(table)
    expect(pages[1][0].continuation).toBe(1)
    expect(pages[1][0].continued).toBe(false)
  })

  it("a break before the table opens the page with the whole table", () => {
    const t = grid([["h1", "h2"], ["a", "b"]])
    const d = doc.create(null, [p("x"), t])
    const pages = cutPages(d, [{ pos: 3, remaining: 0 }])
    expect(pages.map((pg) => pg.map((x) => x.node.textContent))).toEqual([["x"], ["h1h2ab"]])
    expect(pages[1][0].continuation).toBe(0)
  })
})
