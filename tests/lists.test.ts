import { describe, it, expect } from "vitest"
import { EditorState, TextSelection } from "prosemirror-state"
import type { Command } from "prosemirror-state"
import type { Node as PMNode } from "prosemirror-model"
import { sinkListItem, liftListItem } from "prosemirror-schema-list"
import { schema } from "../src/schema"
import { insetAt, units } from "../src/units"
import { cutPages } from "../src/cutter"
import { runPass } from "../src/pass"
import { pageGeometry, DEFAULT_MARGINS } from "../src/layout"
import type { MeasuredBlock } from "../src/measure"
import type { Measurer } from "../src/measurers"
import { toggleList } from "../src/lists"
import { LIST } from "../src/typography"
import { buildSeedDoc } from "../src/seed"

const { doc, paragraph, heading, bulletList, orderedList, listItem } = schema.nodes
const p = (s = "") => paragraph.create(null, s ? schema.text(s) : [])
const li = (...blocks: PMNode[]) => listItem.create(null, blocks)
const ul = (...items: PMNode[]) => bulletList.create(null, items)
const ol = (...items: PMNode[]) => orderedList.create(null, items)
const olFrom = (start: number, ...items: PMNode[]) => orderedList.create({ start }, items)


/** Where `text` starts in `d` (its paragraph's position). */
function at(d: PMNode, text: string): number {
  let found = -1
  d.descendants((n, pos) => {
    if (found < 0 && n.type === paragraph && n.textContent === text) found = pos
    return found < 0
  })
  return found
}

const nested = doc.create(null, [
  p("intro"),
  ol(
    li(p("one"), ul(li(p("one.a"), ol(li(p("one.a.i"), ul(li(p("deep"), p("deep 2")))))), li(p("one.b")))),
    li(p("two"), p("two, second paragraph")),
    li(p()),
    li(p("four"))
  ),
  p("outro"),
])

describe("list schema", () => {
  it("uses TipTap's names and shape", () => {
    expect(orderedList.create().attrs).toEqual({ start: 1 })
    expect(listItem.spec.content).toBe("paragraph block*")
    expect(bulletList.spec.content).toBe("listItem+")
    expect(() => listItem.create(null, [heading.create({ level: 2 })]).check()).toThrow()
  })
})

describe("list units", () => {
  it("walks into nested lists: every block is a unit, in document order", () => {
    expect(units(nested).map((u) => u.node.textContent)).toEqual([
      "intro",
      "one",
      "one.a",
      "one.a.i",
      "deep",
      "deep 2",
      "one.b",
      "two",
      "two, second paragraph",
      "",
      "four",
      "outro",
    ])
    expect(units(nested).every((u) => u.node.type === paragraph)).toBe(true)
  })

  it("indents each level by LIST.indent, four levels deep", () => {
    const inset = Object.fromEntries(units(nested).map((u) => [u.node.textContent, u.inset]))
    expect(inset).toMatchObject({ intro: 0, one: 24, "one.a": 48, "one.a.i": 72, deep: 96, "deep 2": 96, "one.b": 48, two: 24, outro: 0 })
    expect(LIST.indent).toBe(24)
    expect(Number.isInteger(LIST.indent)).toBe(true)
  })

  it("a block that opens its item and list starts its unit where they start", () => {
    const u = Object.fromEntries(units(nested).map((x) => [x.node.textContent, x]))
    const list = nested.child(1)
    const listPos = 7
    expect(nested.nodeAt(listPos)).toBe(list)
    // "one" opens item 1 and the list: its unit starts at the list.
    expect(u.one.pos).toBe(listPos)
    expect(u.one.at).toBe(at(nested, "one"))
    // "one.a" opens the nested bullet list (the 2nd block of item 1): its unit starts at that list.
    expect(nested.nodeAt(u["one.a"].pos)!.type).toBe(bulletList)
    expect(nested.nodeAt(u["one.a.i"].pos)!.type).toBe(orderedList)
    expect(nested.nodeAt(u.deep.pos)!.type).toBe(bulletList)
    // A second paragraph in an item, and a later item, start where they are / at their item.
    expect(u["deep 2"].pos).toBe(u["deep 2"].at)
    expect(nested.nodeAt(u["one.b"].pos)!.type).toBe(listItem)
    expect(nested.nodeAt(u.two.pos)!.type).toBe(listItem)
    expect(u["two, second paragraph"].pos).toBe(u["two, second paragraph"].at)
    expect(u.outro.pos).toBe(u.outro.at)
  })

  it("an empty item is a unit of its own; paragraphs stay splittable at every depth", () => {
    const empty = units(nested).find((u) => u.node.textContent === "")!
    expect(nested.nodeAt(empty.pos)!.type).toBe(listItem)
    expect(units(nested).every((u) => u.kind === "splittable")).toBe(true)
  })

  it("a table inside an item moves whole", () => {
    const t = schema.nodes.table.create(null, [
      schema.nodes.tableRow.create(null, [schema.nodes.tableCell.create(null, p("a"))]),
      schema.nodes.tableRow.create(null, [schema.nodes.tableCell.create(null, p("b"))]),
    ])
    const u = units(doc.create(null, [ul(li(p("x"), t))]))
    expect(u.map((x) => x.node.type.name)).toEqual(["paragraph", "table"])
    expect(u[1].row).toBeUndefined()
    expect(u[1].inset).toBe(24)
  })

  it("insetAt counts the lists around a position", () => {
    expect(insetAt(nested, at(nested, "deep") + 1)).toBe(96)
    expect(insetAt(nested, at(nested, "one.b"))).toBe(48)
    expect(insetAt(nested, at(nested, "outro"))).toBe(0)
  })
})

describe("paginating nested lists", () => {
  const geometry = pageGeometry(DEFAULT_MARGINS)
  const run = (d: PMNode, heights: Record<string, MeasuredBlock>) => {
    const fake: Measurer = {
      measure: (u) => heights[u.node.textContent] ?? { height: 0, splitCandidates: null },
      invalidate() {},
    }
    return runPass({ doc: d, geometry, measurers: [fake], dirty: null, full: false, cache: new WeakMap() })
  }
  const block = (height: number): MeasuredBlock => ({ height, splitCandidates: null })

  it("splits a deep item's paragraph at a line boundary", () => {
    const { layout } = run(nested, {
      intro: block(500),
      one: block(100),
      "one.a": block(100),
      "one.a.i": block(100),
      deep: { height: 200, splitCandidates: [{ pos: 2, height: 50 }, { pos: 3, height: 100 }, { pos: 4, height: 150 }] },
    })
    // 800 placed above "deep"; 64px left: one line (50) fits.
    const deepAt = at(nested, "deep")
    expect(layout.breaks).toEqual([{ pos: deepAt + 1 + 2, remaining: 14 }])
    expect(nested.resolve(layout.breaks[0].pos).parent.textContent).toBe("deep")
    expect(layout.pages[1].opening).toBe("inside")
  })

  it("breaks between two items, before the item, not between it and its paragraph", () => {
    const { layout } = run(nested, { intro: block(700), one: block(50), "one.a": block(50), "one.a.i": block(50), deep: block(10), "deep 2": block(20), "one.b": block(40) })
    // 700 + 50 + 50 + 50 + 10 = 860; "deep 2" (20) does not fit, and cannot split, so it moves.
    const deep2 = units(nested).find((u) => u.node.textContent === "deep 2")!
    expect(layout.breaks.map((b) => b.pos)).toEqual([deep2.pos])
    const { layout: l3 } = run(nested, { intro: block(830), "one.b": block(40) })
    const oneB = units(nested).find((u) => u.node.textContent === "one.b")!
    expect(l3.breaks.map((b) => b.pos)).toEqual([oneB.pos])
    expect(nested.nodeAt(l3.breaks[0].pos)!.type).toBe(listItem)
    expect(nested.resolve(l3.breaks[0].pos).parent.type).toBe(bulletList)
    expect(l3.pages[1].opening).toBe("between")
  })

  it("a list whose first line does not fit moves whole, its break before the list", () => {
    const { layout } = run(nested, { intro: block(850), one: block(24) })
    expect(layout.breaks[0].pos).toBe(7)
    expect(nested.resolve(7).parent.type).toBe(doc)
  })

  it("re-measures a block moved into a list even when its node is unchanged", () => {
    const para = p("moved")
    const flat = doc.create(null, [para])
    const inList = doc.create(null, [ul(li(para))])
    const seen: number[] = []
    const fake: Measurer = { measure: (u) => (seen.push(u.inset), block(10)), invalidate() {} }
    const cache = new WeakMap<PMNode, MeasuredBlock>()
    runPass({ doc: flat, geometry, measurers: [fake], dirty: null, full: false, cache })
    runPass({ doc: inList, geometry, measurers: [fake], dirty: null, full: false, cache })
    expect(seen).toEqual([0, 24])
  })
})

describe("cutting nested lists", () => {
  const text = (pages: ReturnType<typeof cutPages>) => pages.map((page) => page.map((x) => x.node.textContent))

  it("a cut inside a deep item's paragraph keeps every level of nesting on both pages", () => {
    const cut = at(nested, "deep") + 1 + 2
    const pages = cutPages(nested, [{ pos: cut, remaining: 0 }])
    expect(pages).toHaveLength(2)
    const second = pages[1][0]
    expect(second.continuation).toBe(9)
    const path: string[] = []
    for (let n: PMNode | null = second.node; n; n = n.firstChild) path.push(n.type.name)
    expect(path).toEqual(["orderedList", "listItem", "bulletList", "listItem", "orderedList", "listItem", "bulletList", "listItem", "paragraph", "text"])
    expect(second.node.firstChild!.firstChild!.firstChild!.firstChild!.firstChild!.firstChild!.firstChild!.firstChild!.textContent).toBe("ep")
    expect(pages[0][1].continued).toBe(true)
    expect(pages[0].map((x) => x.node.textContent).join("|")).toContain("one.a.ide")
    expect(text(pages).flat().join("")).toBe(nested.textContent)
  })

  it("an ordered list cut between items continues its numbering", () => {
    const d = doc.create(null, [olFrom(3, li(p("a")), li(p("b")), li(p("c")), li(p("d")))])
    const third = units(d).find((u) => u.node.textContent === "c")!
    const pages = cutPages(d, [{ pos: third.pos, remaining: 0 }])
    expect(text(pages)).toEqual([["ab"], ["cd"]])
    expect(pages[0][0].node.attrs.start).toBe(3)
    expect(pages[1][0].node.attrs.start).toBe(5)
    expect(pages[1][0].continuation).toBe(1)
  })

  it("nested ordered lists continue their own numbering at every level", () => {
    const d = doc.create(null, [ol(li(p("1")), li(p("2"), ol(li(p("2.1")), li(p("2.2")), li(p("2.3")))), li(p("3")))])
    const cut = units(d).find((u) => u.node.textContent === "2.2")!
    const pages = cutPages(d, [{ pos: cut.pos, remaining: 0 }])
    const outer = pages[1][0].node
    expect(outer.attrs.start).toBe(2)
    const inner = outer.firstChild!.firstChild!
    expect(inner.type).toBe(orderedList)
    expect(inner.attrs.start).toBe(2)
    expect(inner.textContent).toBe("2.22.3")
    expect(outer.textContent).toBe("2.22.33")
    // The outer item "2" is cut open: it continues on page 2 (its marker stays on page 1).
    expect(pages[1][0].continuation).toBeGreaterThan(2)
  })

  it("a bullet list cut inside an item's second paragraph", () => {
    const d = doc.create(null, [ul(li(p("first"), p("second para")), li(p("next")))])
    const cut = at(d, "second para") + 1 + 7
    const pages = cutPages(d, [{ pos: cut, remaining: 0 }])
    expect(text(pages)).toEqual([["firstsecond "], ["paranext"]])
    expect(pages[1][0].node.type).toBe(bulletList)
    expect(pages[1][0].node.childCount).toBe(2)
  })
})

describe("list commands", () => {
  const state = (d: PMNode, text: string) => EditorState.create({ doc: d, selection: TextSelection.create(d, at(d, text) + 1) })
  const apply = (cmd: Command, s: EditorState) => {
    let next: EditorState | null = null
    cmd(s, (tr) => (next = s.apply(tr)))
    return next as EditorState | null
  }

  it("toggleList wraps a paragraph, switches the kind, and lifts it back out", () => {
    const d = doc.create(null, [p("x")])
    const wrapped = apply(toggleList(bulletList), state(d, "x"))!
    expect(wrapped.doc.firstChild!.type).toBe(bulletList)
    const switched = apply(toggleList(orderedList), wrapped)!
    expect(switched.doc.firstChild!.type).toBe(orderedList)
    const lifted = apply(toggleList(orderedList), switched)!
    expect(lifted.doc.firstChild!.type).toBe(paragraph)
  })

  it("sinking and lifting an item moves its paragraph a level in and out", () => {
    const d = doc.create(null, [ul(li(p("a")), li(p("b")))])
    const sunk = apply(sinkListItem(listItem), state(d, "b"))!
    expect(units(sunk.doc).map((u) => u.inset)).toEqual([24, 48])
    const lifted = apply(liftListItem(listItem), state(sunk.doc, "b"))!
    expect(units(lifted.doc).map((u) => u.inset)).toEqual([24, 24])
  })
})

describe("list seeds", () => {
  it("?lang=list nests lists four levels deep, with an empty item and a list starting at 5", () => {
    const d = buildSeedDoc("list")
    expect(Math.max(...units(d).map((u) => u.inset))).toBe(96)
    let empty = 0, five = 0
    d.descendants((n) => {
      if (n.type === listItem && n.textContent === "") empty++
      if (n.type === orderedList && n.attrs.start === 5) five++
    })
    expect(empty).toBe(1)
    expect(five).toBe(1)
  })

  it("the Kruti Dev document holds a nested list", () => {
    expect(Math.max(...units(buildSeedDoc("hi")).map((u) => u.inset))).toBe(72)
  })
})

