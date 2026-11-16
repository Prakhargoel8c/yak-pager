/**
 * No page nodes: computed breaks live in plugin state only. `pageBreak` is
 * authorial intent, so it is a document node like any other. Alignment is a
 * node attr for the same reason; "left" renders with no style attribute.
 */
import { Schema } from "prosemirror-model"
import type { Node, Mark, DOMOutputSpec } from "prosemirror-model"
import { nodes as basicNodes, marks as basicMarks } from "prosemirror-schema-basic"
import { tableNodes } from "prosemirror-tables"
import { DEFAULT_MARGINS } from "./layout"
import { tableToDOM } from "./tables"

const { text, hard_break, horizontal_rule } = basicNodes

/** The base font (a FONTS key) and page margins in inches: both undoable doc attrs. */
const doc = { ...basicNodes.doc, attrs: { font: { default: "georgia" }, margins: { default: DEFAULT_MARGINS } } }
const { strong, em } = basicMarks

const ALIGN_VALUES = ["left", "center", "right", "justify"]

function alignFromDOM(dom: string | HTMLElement): string {
  const v = (dom as HTMLElement).style?.textAlign
  return ALIGN_VALUES.includes(v) ? v : "left"
}

function alignAttrs(node: Node): { style?: string } {
  const a = node.attrs.align
  return a && a !== "left" ? { style: `text-align: ${a}` } : {}
}

const alignAttr = { align: { default: "left" } }

const paragraph = {
  attrs: alignAttr,
  content: "inline*",
  group: "block",
  parseDOM: [
    {
      tag: "p",
      getAttrs(dom: string | HTMLElement) {
        return { align: alignFromDOM(dom) }
      },
    },
  ],
  toDOM(node: Node): DOMOutputSpec {
    return ["p", alignAttrs(node), 0]
  },
}

const heading = {
  attrs: { level: { default: 1 }, ...alignAttr },
  content: "inline*",
  group: "block",
  defining: true,
  parseDOM: ([1, 2, 3] as const).map((level) => ({
    tag: "h" + level,
    getAttrs(dom: string | HTMLElement) {
      return { level, align: alignFromDOM(dom) }
    },
  })),
  toDOM(node: Node): DOMOutputSpec {
    return ["h" + node.attrs.level, alignAttrs(node), 0]
  },
}

/** Rendered as a visible marker strip so the author can see and delete it. */
const pageBreak = {
  group: "block",
  atom: true,
  selectable: true,
  parseDOM: [{ tag: "div[data-page-break]" }],
  toDOM(): DOMOutputSpec {
    return ["div", { "data-page-break": "true" }]
  },
}

const fontSize = {
  attrs: { size: { default: 16 } },
  parseDOM: [
    {
      tag: "span[style]",
      consuming: false,
      getAttrs(dom: string | HTMLElement) {
        const el = dom as HTMLElement
        const m = el.style.fontSize.match(/^(\d+(?:\.\d+)?)px$/)
        return m ? { size: Math.round(parseFloat(m[1])) } : false
      },
    },
  ],
  toDOM(mark: Mark): DOMOutputSpec {
    return ["span", { style: `font-size: ${mark.attrs.size}px` }]
  },
}

/** A run in a font other than the document's. Inclusive: typing on from a run keeps its font. */
const fontFamily = {
  attrs: { family: {} },
  parseDOM: [
    {
      tag: "span[style]",
      consuming: false,
      getAttrs(dom: string | HTMLElement) {
        const family = (dom as HTMLElement).style.fontFamily
        return family ? { family } : false
      },
    },
  ],
  toDOM(mark: Mark): DOMOutputSpec {
    const family = mark.attrs.family as string
    const attrs: Record<string, string> = { style: `font-family: ${family}` }
    // Kruti Dev text is ASCII underneath: spellcheck would flag every word.
    if (/^["']?Kruti Dev/i.test(family)) attrs.spellcheck = "false"
    return ["span", attrs]
  },
}

/** TipTap's table shape: table > tableRow > tableCell | tableHeader, cells hold blocks. */
const pmTables = tableNodes({ tableGroup: "block", cellContent: "block+", cellAttributes: {} })
const table = { ...pmTables.table, content: "tableRow+", toDOM: tableToDOM }
const tableRow = { ...pmTables.table_row, content: "(tableCell | tableHeader)*" }

/** TipTap's list shape: bulletList | orderedList (start) > listItem > paragraph block*. */
const bulletList = {
  content: "listItem+",
  group: "block list",
  parseDOM: [{ tag: "ul" }],
  toDOM: (): DOMOutputSpec => ["ul", 0],
}
const orderedList = {
  attrs: { start: { default: 1 } },
  content: "listItem+",
  group: "block list",
  parseDOM: [
    {
      tag: "ol",
      getAttrs: (dom: string | HTMLElement) => {
        const start = (dom as HTMLElement).getAttribute("start")
        return { start: start ? parseInt(start, 10) : 1 }
      },
    },
  ],
  toDOM: (node: Node): DOMOutputSpec => ["ol", node.attrs.start === 1 ? {} : { start: node.attrs.start }, 0],
}
const listItem = {
  content: "paragraph block*",
  defining: true,
  parseDOM: [{ tag: "li" }],
  toDOM: (): DOMOutputSpec => ["li", 0],
}

export const schema = new Schema({
  nodes: {
    doc,
    paragraph,
    heading,
    text,
    hard_break,
    horizontal_rule,
    pageBreak,
    table,
    tableRow,
    tableCell: pmTables.table_cell,
    tableHeader: pmTables.table_header,
    bulletList,
    orderedList,
    listItem,
  },
  marks: { strong, em, fontSize, fontFamily },
})
