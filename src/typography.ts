/**
 * TYPOGRAPHY — the one table of block styles. The editor's CSS, Pretext's
 * block model and the print document's CSS are all generated from it, so
 * a block is the same height in all three.
 */
import type { Node as PMNode } from "prosemirror-model"

export interface BlockStyle {
  size: number
  /** Unitless CSS line-height: a run in another font size gets size × this. */
  lineHeight: number
  weight: number
  padTop: number
  padBottom: number
}

export const PARAGRAPH: BlockStyle = { size: 16, lineHeight: 1.5, weight: 400, padTop: 0, padBottom: 10 }
export const HEADINGS: Record<number, BlockStyle> = {
  1: { size: 28, lineHeight: 1.25, weight: 700, padTop: 18, padBottom: 10 },
  2: { size: 22, lineHeight: 1.3, weight: 700, padTop: 16, padBottom: 8 },
  3: { size: 18, lineHeight: 1.35, weight: 600, padTop: 12, padBottom: 8 },
}

export function blockStyle(node: PMNode): BlockStyle | null {
  if (node.type.name === "paragraph") return PARAGRAPH
  if (node.type.name === "heading") return HEADINGS[node.attrs.level as number] ?? null
  return null
}

/** Lists add no height of their own: an item is its blocks, indented a whole number of px per level. */
export const LIST = { indent: 24 }

/**
 * Table geometry. Borders are separate (no collapsing): every cell draws its
 * right and bottom border, first-column cells also their left, and the
 * table its top. A row's height is then max(cell content) + 2 × padY +
 * border, whatever its place in the table; the table's top border and the
 * space below it belong to its first and last row.
 */
export const TABLE = { padX: 8, padY: 6, border: 1, tail: 10, minCol: 25, line: "#c3c9d2", head: "#f3f5f8" }

/** A block inside a table cell: no block spacing, and bold in a header cell. */
export function cellBlockStyle(node: PMNode, header: boolean): BlockStyle | null {
  const s = blockStyle(node)
  if (!s) return null
  return { ...s, padTop: 0, padBottom: 0, weight: header && node.type.name === "paragraph" ? 700 : s.weight }
}

export const INK = "#1f2328"

/** How the column flows text; the edge-line probe lays text out with the same settings. */
export const TEXT_FLOW =
  "word-wrap: break-word; white-space: pre-wrap; -webkit-font-variant-ligatures: none; font-variant-ligatures: none"

const block = (s: BlockStyle) =>
  `font-size: ${s.size}px; line-height: ${s.lineHeight}; padding: ${s.padTop}px 0 ${s.padBottom}px; font-weight: ${s.weight};`

/** The column's CSS under `scope`, in `family` (the document's font). */
export function typographyCSS(scope: string, family: string): string {
  return `
${scope} { font-family: ${family}; font-size: ${PARAGRAPH.size}px; line-height: ${PARAGRAPH.lineHeight}; color: ${INK}; ${TEXT_FLOW}; }
${scope} > * { margin: 0; }
${scope} p { padding: ${PARAGRAPH.padTop}px 0 ${PARAGRAPH.padBottom}px; }
${scope} h1 { ${block(HEADINGS[1])} }
${scope} h2 { ${block(HEADINGS[2])} }
${scope} h3 { ${block(HEADINGS[3])} }
${scope} hr { border: none; border-top: 2px solid #c3c9d2; padding: 14px 0; }
${scope} [data-page-break] { border-top: 1px dashed #c5221f; padding: 6px 0 10px; position: relative; user-select: none; }
${scope} .tableWrapper { padding-bottom: ${TABLE.tail}px; }
${scope} table { border-collapse: separate; border-spacing: 0; table-layout: fixed; border-top: ${TABLE.border}px solid ${TABLE.line}; }
${scope} td, ${scope} th { box-sizing: border-box; padding: ${TABLE.padY}px ${TABLE.padX}px; border: 0 solid ${TABLE.line}; border-width: 0 ${TABLE.border}px ${TABLE.border}px 0; vertical-align: top; text-align: start; font-weight: 400; position: relative; }
${scope} th { font-weight: 700; background: ${TABLE.head}; }
${scope} tr > :first-child { border-left-width: ${TABLE.border}px; }
${scope} ul, ${scope} ol { margin: 0; padding: 0 0 0 ${LIST.indent}px; }
${scope} li, ${scope} li > * { margin: 0; }
${scope} li { padding: 0; }
${scope} .li-continued { list-style-type: none; }
${scope} td > *, ${scope} th > * { margin: 0; padding-top: 0; padding-bottom: 0; }
${scope} .page-gap + tr > *, ${scope} .table-continued tr:first-child > * { box-shadow: inset 0 ${TABLE.border}px 0 ${TABLE.line}; }
${scope} .table-continued table { border-top-width: 0; }
${scope} .table-continues { padding-bottom: 0; }
`
}
