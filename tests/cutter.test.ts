import { describe, it, expect } from "vitest"
import { schema } from "../src/schema"
import { cutPages } from "../src/cutter"

const t = (s: string) => schema.text(s)
const p = (s: string, align = "left") => schema.nodes.paragraph.create({ align }, t(s))
const text = (pages: ReturnType<typeof cutPages>) => pages.map((page) => page.map((x) => x.node.textContent))

describe("cutPages", () => {
  it("no breaks: one page holding every block", () => {
    const doc = schema.nodes.doc.create(null, [p("one"), p("two")])
    expect(text(cutPages(doc, []))).toEqual([["one", "two"]])
  })

  it("a break at a block's start opens the next page with that block", () => {
    const doc = schema.nodes.doc.create(null, [p("one"), schema.nodes.heading.create({ level: 2 }, t("two")), p("three")])
    const pages = cutPages(doc, [{ pos: 5, remaining: 0 }])
    expect(text(pages)).toEqual([["one"], ["two", "three"]])
    expect(pages[1][0].node.type.name).toBe("heading")
    expect(pages.flat().every((x) => !x.continued)).toBe(true)
  })

  it("a break inside a paragraph cuts it into real halves, marks and attrs kept", () => {
    const para = schema.nodes.paragraph.create({ align: "justify" }, [t("first line "), schema.text("second line", [schema.marks.strong.create()])])
    const doc = schema.nodes.doc.create(null, [p("intro"), para])
    // The paragraph starts at 7, its content at 8; cut 11 chars in.
    const pages = cutPages(doc, [{ pos: 8 + 11, remaining: 0 }])
    expect(text(pages)).toEqual([["intro", "first line "], ["second line"]])
    expect(pages[0][1].continued).toBe(true)
    expect(pages[1][0].continued).toBe(false)
    expect(pages[1][0].node.attrs.align).toBe("justify")
    expect(pages[1][0].node.firstChild?.marks.map((m) => m.type.name)).toEqual(["strong"])
  })

  it("a paragraph taller than a page is cut more than once, in order", () => {
    const doc = schema.nodes.doc.create(null, [p("abcdefghij")])
    const pages = cutPages(doc, [{ pos: 1 + 7, remaining: 0 }, { pos: 1 + 3, remaining: 0 }])
    expect(text(pages)).toEqual([["abc"], ["defg"], ["hij"]])
    expect(pages.map((pg) => pg[0].continued)).toEqual([true, true, false])
  })

  it("only splittable units are cut: a break inside a heading is ignored", () => {
    const doc = schema.nodes.doc.create(null, [schema.nodes.heading.create({ level: 1 }, t("a heading"))])
    expect(text(cutPages(doc, [{ pos: 4, remaining: 0 }]))).toEqual([["a heading"]])
  })
})
