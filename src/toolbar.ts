/**
 * Toolbar — marks, block type, alignment, margins, tables, lists and the
 * explicit page break (the one kind of break that is a document node).
 * Everything here is an ordinary transaction with steps, undoable and
 * serialized; computed pagination never is.
 */
import type { EditorView } from "prosemirror-view"
import { toggleMark, setBlockType } from "prosemirror-commands"
import type { Command } from "prosemirror-state"
import type { Mark, MarkType, Node } from "prosemirror-model"
import type { EditorState } from "prosemirror-state"
import { schema } from "./schema"
import { FONTS, docFont, fontKeyOf, isFontKey } from "./fonts"
import type { FontKey } from "./fonts"
import { buildMarginsControl } from "./marginsControl"
import { insertTable } from "./tables"
import { toggleList } from "./lists"

const { strong, em, fontSize, fontFamily } = schema.marks

/**
 * The font at the cursor: the text's fontFamily mark, else the document's
 * base font. Over a selection, the one font all its text shares, or
 * "mixed". "other" is a family not in FONTS (pasted).
 */
function fontAt(state: EditorState): FontKey | "mixed" | "other" {
  const base = docFont(state)
  const of = (marks: readonly Mark[]) => {
    const m = fontFamily.isInSet(marks)
    return m ? (fontKeyOf(m.attrs.family as string) ?? "other") : base
  }
  const { selection, storedMarks } = state
  if (selection.empty) return of(storedMarks ?? selection.$from.marks())
  const seen = new Set<string>()
  state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.isText) seen.add(of(node.marks))
  })
  if (seen.size === 0) return base
  return seen.size === 1 ? ([...seen][0] as FontKey | "other") : "mixed"
}

/** Replaces `type` on the selection with `mark` (null removes it), or on what is typed next. */
function setMark(type: MarkType, mark: Mark | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    const tr = state.tr
    if (empty) {
      tr.removeStoredMark(type)
      if (mark) tr.addStoredMark(mark)
    } else {
      tr.removeMark(from, to, type)
      if (mark) tr.addMark(from, to, mark)
    }
    dispatch?.(tr)
    return true
  }
}

/** The document's base font is no mark at all, so choosing it removes the fontFamily mark. */
const setFont = (font: FontKey, state: EditorState): Command =>
  setMark(fontFamily, font === docFont(state) ? null : fontFamily.create({ family: FONTS[font].family }))

/**
 * Set `align` on every block in the selection that carries the attr. Not one
 * blanket `setBlockType`: over a selection it would convert a heading into
 * a paragraph.
 */
export function setAlign(align: string): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection
    const tr = state.tr
    let touched = false
    state.doc.nodesBetween(from, to, (node: Node, pos: number) => {
      if (!("align" in node.attrs) || node.attrs.align === align) return
      tr.setBlockType(pos, pos + node.nodeSize, node.type, { ...node.attrs, align })
      touched = true
    })
    if (!touched) return false
    dispatch?.(tr)
    return true
  }
}

export const insertPageBreak: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(schema.nodes.pageBreak.create()).scrollIntoView())
  return true
}

/** Shift-Enter: a line end inside a block. Refused where inline content can't go (a selected block node). */
export const insertHardBreak: Command = (state, dispatch) => {
  if (!state.selection.$from.parent.inlineContent) return false
  dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView())
  return true
}

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 32]

const ALIGNMENTS: Array<[string, string]> = [
  ["left", "Left"],
  ["center", "Center"],
  ["right", "Right"],
  ["justify", "Justify"],
]

const BLOCKS: Array<[string, Command]> = [
  ["Paragraph", setBlockType(schema.nodes.paragraph)],
  ["Heading 1", setBlockType(schema.nodes.heading, { level: 1 })],
  ["Heading 2", setBlockType(schema.nodes.heading, { level: 2 })],
  ["Heading 3", setBlockType(schema.nodes.heading, { level: 3 })],
]

function button(html: string, title: string, onclick: () => void, className = ""): HTMLButtonElement {
  const b = document.createElement("button")
  b.innerHTML = html
  b.title = title
  b.className = className
  b.onclick = onclick
  return b
}

function select(title: string, options: Array<[value: string, label: string]>, onchange: (value: string) => void): HTMLSelectElement {
  const sel = document.createElement("select")
  sel.title = title
  for (const [value, label] of options) sel.append(new Option(label, value))
  sel.onchange = () => onchange(sel.value)
  return sel
}

export function buildToolbar(view: EditorView, mount: HTMLElement): { sync: () => void } {
  const run = (cmd: Command) => () => {
    cmd(view.state, view.dispatch, view)
    view.focus()
  }

  const strongBtn = button("<strong>B</strong>", "Bold (Mod-B)", run(toggleMark(strong)))
  const emBtn = button("<em>I</em>", "Italic (Mod-I)", run(toggleMark(em)))
  const sizeSel = select(
    "Font size",
    [["", "size –"], ...FONT_SIZES.map((s): [string, string] => [String(s), `${s}px`])],
    (v) => run(setMark(fontSize, v === "" ? null : fontSize.create({ size: Number(v) })))()
  )
  const fontSel = select(
    "Font",
    Object.entries(FONTS).map(([key, font]): [string, string] => [key, font.label]),
    (v) => isFontKey(v) && run(setFont(v, view.state))()
  )
  fontSel.className = "font-select"
  // Shown, not chosen: the selection holds several fonts, or one not listed.
  for (const [value, label] of [["mixed", "Mixed fonts"], ["other", "Other font"]]) {
    const o = new Option(label, value)
    o.disabled = true
    o.hidden = true
    fontSel.append(o)
  }
  const blockSel = select(
    "Block type",
    BLOCKS.map(([label]): [string, string] => [label, label]),
    (v) => run(BLOCKS.find(([label]) => label === v)![1])()
  )
  const alignSel = select("Alignment", ALIGNMENTS, (v) => run(setAlign(v))())
  const margins = buildMarginsControl(view, run)
  const pbBtn = button("⤓ Page break", "Insert explicit page break (Mod-Enter)", run(insertPageBreak))
  const tableBtn = button("Insert table", "Insert a 3 × 3 table with a header row", run(insertTable()), "insert-table")
  const bulletBtn = button("• List", 'Bullet list (type "- ")', run(toggleList(schema.nodes.bulletList)), "bullet-list")
  const orderedBtn = button("1. List", 'Numbered list (type "1. ")', run(toggleList(schema.nodes.orderedList)), "ordered-list")
  const hint = document.createElement("span")
  hint.className = "tb-hint"
  hint.textContent = "Ctrl/⌘-Z undoes typing — pagination is never in the undo stack"

  mount.append(strongBtn, emBtn, fontSel, sizeSel, blockSel, alignSel, margins.el, pbBtn, tableBtn, bulletBtn, orderedBtn, hint)

  const sync = () => {
    const { state } = view
    const { selection, storedMarks } = state
    const marksAt = storedMarks ?? selection.$from.marks()
    const range = !selection.empty
    strongBtn.classList.toggle("active", range ? state.doc.rangeHasMark(selection.from, selection.to, strong) : strong.isInSet(marksAt) != null)
    emBtn.classList.toggle("active", range ? state.doc.rangeHasMark(selection.from, selection.to, em) : em.isInSet(marksAt) != null)
    const fs = fontSize.isInSet(marksAt)
    sizeSel.value = fs ? String(fs.attrs.size) : ""
    fontSel.value = fontAt(state)
    const parent = selection.$from.parent
    blockSel.value = parent.type.name === "heading" ? `Heading ${parent.attrs.level}` : "Paragraph"
    // Blocks without the attr (rules, page breaks) match no option, so the select shows blank.
    alignSel.value = "align" in parent.attrs ? parent.attrs.align : ""
    margins.sync()
  }
  sync()
  return { sync }
}
