import { describe, it, expect } from "vitest"
import { schema } from "../src/schema"
import { HEADINGS, PARAGRAPH, blockStyle, typographyCSS } from "../src/typography"

describe("typography", () => {
  it("styles every text block type the schema has", () => {
    expect(blockStyle(schema.nodes.paragraph.create())).toBe(PARAGRAPH)
    for (const level of [1, 2, 3]) {
      expect(blockStyle(schema.nodes.heading.create({ level }))).toBe(HEADINGS[level])
    }
    expect(blockStyle(schema.nodes.horizontal_rule.create())).toBeNull()
    expect(blockStyle(schema.nodes.pageBreak.create())).toBeNull()
  })

  it("generates one rule per block type under the scope, in the given font", () => {
    const css = typographyCSS(".sheet", '"Kruti Dev", Georgia, serif')
    expect(css).toContain('.sheet { font-family: "Kruti Dev", Georgia, serif; font-size: 16px; line-height: 1.5;')
    expect(css).toContain("white-space: pre-wrap")
    expect(css).toContain(".sheet p { padding: 0px 0 10px; }")
    expect(css).toContain(".sheet h1 { font-size: 28px; line-height: 1.25; padding: 18px 0 10px; font-weight: 700; }")
    expect(css).toContain(".sheet h2 { font-size: 22px; line-height: 1.3; padding: 16px 0 8px; font-weight: 700; }")
    expect(css).toContain(".sheet h3 { font-size: 18px; line-height: 1.35; padding: 12px 0 8px; font-weight: 600; }")
    expect(css).toContain(".sheet hr {")
    expect(css).toContain(".sheet [data-page-break] {")
    expect(css).not.toMatch(/^[^.\n@][^{]*\{/m)
  })
})
