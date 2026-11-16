/**
 * TABLES — column widths and the table's DOM. Widths are whole pixels so
 * Pretext breaks a cell's lines at the same width the browser does: a
 * resized column keeps its colwidth, the others share what is left of the
 * column, rounded down, the last one taking the remainder. The CSS computes
 * the same numbers from --content-w, so a margin change needs no JS.
 */
import type { Node as PMNode } from "prosemirror-model"
import type { DOMOutputSpec } from "prosemirror-model"
import type { Command } from "prosemirror-state"
import { TextSelection } from "prosemirror-state"
import type { NodeView, ViewMutationRecord } from "prosemirror-view"
import { TABLE } from "./typography"

/** Per column, from the first row: its colwidth in px, or null for a column that shares the rest. */
export function tableColumns(table: PMNode): (number | null)[] {
  const cols: (number | null)[] = []
  table.firstChild?.forEach((cell) => {
    const { colspan, colwidth } = cell.attrs as { colspan: number; colwidth: number[] | null }
    for (let j = 0; j < colspan; j++) cols.push(colwidth?.[j] ? Math.round(colwidth[j]) : null)
  })
  return cols
}

export function columnWidths(cols: (number | null)[], contentW: number): number[] {
  const set = cols.reduce<number>((s, c) => s + (c ?? 0), 0)
  const free = cols.filter((c) => c == null).length
  const share = Math.max(TABLE.minCol, Math.floor((contentW - set) / free))
  const last = Math.max(TABLE.minCol, contentW - set - (free - 1) * share)
  let seen = 0
  return cols.map((c) => c ?? (++seen === free ? last : share))
}

/** The same widths as CSS over --content-w, plus the table's width. */
function columnCSS(cols: (number | null)[]): { table: string; cols: string[] } {
  const set = cols.reduce<number>((s, c) => s + (c ?? 0), 0)
  const free = cols.filter((c) => c == null).length
  if (free === 0) return { table: `width: ${set}px`, cols: cols.map((c) => `${c}px`) }
  const share = `max(${TABLE.minCol}px, round(down, calc((var(--content-w) - ${set}px) / ${free}), 1px))`
  const last = `max(${TABLE.minCol}px, calc(var(--content-w) - ${set}px - ${free - 1} * var(--share)))`
  let seen = 0
  return {
    table: `--share: ${share}; --last: ${last}; width: calc(${set}px + ${free - 1} * var(--share) + var(--last))`,
    cols: cols.map((c) => (c != null ? `${c}px` : ++seen === free ? "var(--last)" : "var(--share)")),
  }
}

/** The table's DOM for serializing (print): wrapper, table with widths, colgroup, tbody. */
export function tableToDOM(node: PMNode): DOMOutputSpec {
  const css = columnCSS(tableColumns(node))
  return [
    "div",
    { class: "tableWrapper" },
    ["table", { style: css.table }, ["colgroup", ...css.cols.map((w) => ["col", { style: `width: ${w}` }])], ["tbody", 0]],
  ]
}

/** The editor's table: the same DOM, with the colgroup kept in step with the cells' colwidths. */
export class TableView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private table: HTMLTableElement
  private colgroup: HTMLElement

  constructor(private node: PMNode) {
    this.dom = document.createElement("div")
    this.dom.className = "tableWrapper"
    this.table = this.dom.appendChild(document.createElement("table"))
    this.colgroup = this.table.appendChild(document.createElement("colgroup"))
    this.contentDOM = this.table.appendChild(document.createElement("tbody"))
    this.render()
  }

  private render() {
    const css = columnCSS(tableColumns(this.node))
    if (this.table.getAttribute("style") !== css.table) this.table.setAttribute("style", css.table)
    while (this.colgroup.children.length > css.cols.length) this.colgroup.lastChild!.remove()
    while (this.colgroup.children.length < css.cols.length) this.colgroup.append(document.createElement("col"))
    css.cols.forEach((w, i) => {
      const col = this.colgroup.children[i] as HTMLElement
      if (col.getAttribute("style") !== `width: ${w}`) col.setAttribute("style", `width: ${w}`)
    })
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  ignoreMutation(record: ViewMutationRecord) {
    return record.type === "attributes" && (record.target === this.table || this.colgroup.contains(record.target))
  }
}

/** Inserts a rows × cols table with a header row, and puts the cursor in its first cell. */
export function insertTable(rows = 3, cols = 3): Command {
  return (state, dispatch) => {
    const { table, tableRow, tableCell, tableHeader, paragraph } = state.schema.nodes
    const cell = (type: typeof tableCell) => type.create(null, paragraph.create())
    const row = (type: typeof tableCell) => tableRow.create(null, Array.from({ length: cols }, () => cell(type)))
    const node = table.create(null, [row(tableHeader), ...Array.from({ length: rows - 1 }, () => row(tableCell))])
    if (dispatch) {
      const tr = state.tr.replaceSelectionWith(node)
      let pos = -1
      tr.doc.nodesBetween(tr.mapping.map(state.selection.from, -1), tr.doc.content.size, (n, p) => {
        if (pos < 0 && n.type === table) pos = p
        return pos < 0
      })
      if (pos >= 0) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 4)))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}
