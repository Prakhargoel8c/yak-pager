/** classify() over synthetic records: the node-shaped objects carry only what it reads. */
import { describe, it, expect } from "vitest"
import { classify } from "../src/reflowAudit"

interface FakeEl {
  nodeType: number
  nodeName: string
  classList: { contains(c: string): boolean }
  dataset: Record<string, string>
  parentNode: FakeEl | null
  attrs: Record<string, string>
  getAttribute(name: string): string | null
}

function el(name: string, opts: { classes?: string[]; page?: string; parent?: FakeEl | null; attrs?: Record<string, string> } = {}): FakeEl {
  const classes = opts.classes ?? []
  return {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    classList: { contains: (c) => classes.includes(c) },
    dataset: opts.page != null ? { page: opts.page } : {},
    parentNode: opts.parent ?? null,
    attrs: opts.attrs ?? {},
    getAttribute(n) {
      return this.attrs[n] ?? null
    },
  }
}
const textNode = () => ({ nodeType: 3, nodeName: "#text" })

const stack = el("div", { classes: ["paper-stack"] })
const editor = el("div", { classes: ["ProseMirror"], parent: stack })
const gap = (page: string, parent: FakeEl = editor) => el("div", { classes: ["page-gap"], page, parent })

const childList = (target: unknown, added: unknown[] = [], removed: unknown[] = []) =>
  ({ type: "childList", target, addedNodes: added, removedNodes: removed }) as unknown as MutationRecord
const attribute = (target: unknown, attributeName: string, oldValue: string | null) =>
  ({ type: "attributes", target, attributeName, oldValue }) as unknown as MutationRecord

const env = (created: unknown[] = []) => ({
  stack: stack as unknown as Node,
  created: new Set(created as Node[]),
})

describe("classify", () => {
  it("no records: no operations", () => {
    const { ops, counts } = classify([], env())
    expect(ops).toEqual([])
    expect(Object.values(counts).every((n) => n === 0)).toBe(true)
  })

  it("a widget removed and re-added is one insertBefore, however many records it took", () => {
    const g = gap("0")
    const { counts } = classify([childList(editor, [], [g]), childList(editor, [g], [])], env())
    expect(counts).toMatchObject({ insertBefore: 1, create: 0, remove: 0, other: 0 })
    const single = classify([childList(editor, [g], [g])], env())
    expect(single.counts.insertBefore).toBe(1)
  })

  it("a widget created this pass is a create; one that only disappears is a remove", () => {
    const fresh = gap("3")
    const gone = gap("4")
    const { ops, counts } = classify([childList(editor, [fresh]), childList(editor, [], [gone])], env([fresh]))
    expect(counts).toMatchObject({ create: 1, remove: 1, insertBefore: 0 })
    expect(ops.map((o) => o.text)).toEqual(["create .page-gap-3 (page count grew)", "remove .page-gap-4 (page count shrank)"])
  })

  it("text nodes re-split around a moved inline widget count as the move", () => {
    const p = el("p", { parent: editor })
    const { counts } = classify([childList(p, [textNode()], [textNode()])], env())
    expect(counts).toMatchObject({ insertBefore: 1, other: 0 })
  })

  it("a block added or removed is other", () => {
    const { counts, ops } = classify([childList(editor, [el("p")])], env())
    expect(counts.other).toBe(1)
    expect(ops[0].text).toBe("childList +P under DIV")
  })

  it("attribute writes: push on a widget, scaffold on the stack, no-ops skipped", () => {
    const g = gap("1")
    g.attrs.style = "--push: 12px;"
    g.attrs.class = "page-gap"
    stack.attrs.style = "padding-bottom: 100px;"
    const { ops, counts } = classify(
      [attribute(g, "style", "--push: 8px;"), attribute(g, "style", ""), attribute(stack, "style", null), attribute(g, "class", "page-gap")],
      env()
    )
    expect(counts).toMatchObject({ setAttribute: 2, other: 0 })
    expect(ops.map((o) => o.text)).toEqual([
      'setAttribute style="--push: 12px;" on .page-gap-1 (--push)',
      "setAttribute style on .paper-stack (scaffold, not content)",
    ])
  })

  it("an unchanged attribute written back is not an operation", () => {
    const g = gap("1")
    g.attrs.class = "page-gap ProseMirror-widget"
    const { ops } = classify([attribute(g, "class", "page-gap ProseMirror-widget")], env())
    expect(ops).toEqual([])
  })

  it("a style written on a block is other: reflow never touches block DOM", () => {
    const block = el("p", { parent: editor, attrs: { style: "margin-top: 40px" } })
    const { ops, counts } = classify([attribute(block, "style", null)], env())
    expect(counts).toMatchObject({ setAttribute: 0, other: 1 })
    expect(ops[0].text).toBe("attribute style on P")
  })
})
