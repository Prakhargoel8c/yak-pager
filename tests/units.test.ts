import { describe, it, expect } from "vitest"
import { schema } from "../src/schema"
import { units } from "../src/units"

const t = (s: string) => schema.text(s)
const doc = schema.nodes.doc.create(null, [
  schema.nodes.heading.create({ level: 1 }, t("Title")),
  schema.nodes.paragraph.create(null, t("Body text")),
  schema.nodes.horizontal_rule.create(),
  schema.nodes.pageBreak.create(),
  schema.nodes.paragraph.create(null, t("After")),
])

describe("units", () => {
  it("yields one unit per top-level block, in order, with positions", () => {
    const u = units(doc)
    expect(u.map((x) => x.node.type.name)).toEqual(["heading", "paragraph", "horizontal_rule", "pageBreak", "paragraph"])
    expect(u.map((x) => x.pos)).toEqual([0, 7, 18, 19, 20])
    expect(u.map((x) => x.end)).toEqual([7, 18, 19, 20, 27])
    expect(u.map((x) => x.contentStart)).toEqual([1, 8, 19, 20, 21])
    expect(u[4].end).toBe(doc.content.size)
  })

  it("decides the kind: paragraphs split, page breaks force, the rest is atomic", () => {
    expect(units(doc).map((x) => x.kind)).toEqual(["atomic", "splittable", "atomic", "forced", "splittable"])
  })
})
