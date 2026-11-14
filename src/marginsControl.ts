/**
 * Page margins: a toolbar menu of presets plus custom values in inches.
 * Margins are the doc node's `margins` attr, so a change is one undoable
 * step; the pagination plugin re-measures the whole document when it sees
 * the attr change.
 */
import type { Command, EditorState } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { MIN_CONTENT_IN, PX_PER_IN, SHEET_H, SHEET_W, marginsOf } from "./layout"
import type { Margins } from "./layout"

export const MARGIN_PRESETS: Record<string, { label: string; margins: Margins }> = {
  normal: { label: "Normal", margins: { top: 1, right: 1, bottom: 1, left: 1 } },
  narrow: { label: "Narrow", margins: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } },
  moderate: { label: "Moderate", margins: { top: 1, right: 0.75, bottom: 1, left: 0.75 } },
  wide: { label: "Wide", margins: { top: 1, right: 2, bottom: 1, left: 2 } },
}

const SIDES = ["top", "bottom", "left", "right"] as const

const sameMargins = (a: Margins, b: Margins) => SIDES.every((s) => a[s] === b[s])

export const docMargins = (state: EditorState): Margins => marginsOf(state.doc.attrs.margins)

/** Why a set of margins can't be used, or null when it can. */
export function marginsError(m: Margins): string | null {
  if (!SIDES.every((s) => Number.isFinite(m[s]) && m[s] >= 0)) return "Margins must be 0 or more inches."
  if (SHEET_H / PX_PER_IN - m.top - m.bottom < MIN_CONTENT_IN) return `Top + bottom must leave at least ${MIN_CONTENT_IN}in of page.`
  if (SHEET_W / PX_PER_IN - m.left - m.right < MIN_CONTENT_IN) return `Left + right must leave at least ${MIN_CONTENT_IN}in of page.`
  return null
}

export function setMargins(m: Margins): Command {
  return (state, dispatch) => {
    if (marginsError(m) || sameMargins(m, docMargins(state))) return false
    dispatch?.(state.tr.setDocAttribute("margins", { ...m }))
    return true
  }
}

const fmt = (m: Margins) => `${m.top}″ ${m.right}″ ${m.bottom}″ ${m.left}″`

export function buildMarginsControl(view: EditorView, run: (cmd: Command) => () => void) {
  const wrap = document.createElement("span")
  wrap.className = "margins-control"

  const sel = document.createElement("select")
  sel.title = "Page margins (top right bottom left)"
  sel.className = "margins-select"
  for (const [key, p] of Object.entries(MARGIN_PRESETS)) sel.append(new Option(`Margins: ${p.label}`, key))
  // Shown, not chosen: the document's margins match no preset.
  const current = new Option("Margins: Custom", "current")
  current.disabled = true
  current.hidden = true
  sel.append(current, new Option("Custom…", "edit"))

  const pop = document.createElement("form")
  pop.className = "margins-pop"
  pop.hidden = true
  const inputs = {} as Record<(typeof SIDES)[number], HTMLInputElement>
  for (const side of SIDES) {
    const label = document.createElement("label")
    const input = document.createElement("input")
    input.type = "number"
    input.step = "0.05"
    input.min = "0"
    input.name = side
    inputs[side] = input
    label.append(side[0].toUpperCase() + side.slice(1), input, "in")
    pop.append(label)
  }
  const error = document.createElement("div")
  error.className = "margins-error"
  const apply = document.createElement("button")
  apply.type = "submit"
  apply.textContent = "Apply"
  const cancel = document.createElement("button")
  cancel.type = "button"
  cancel.textContent = "Cancel"
  pop.append(error, apply, cancel)

  const read = (): Margins => ({
    top: inputs.top.valueAsNumber,
    right: inputs.right.valueAsNumber,
    bottom: inputs.bottom.valueAsNumber,
    left: inputs.left.valueAsNumber,
  })
  const close = () => {
    pop.hidden = true
    sync()
    view.focus()
  }
  const open = () => {
    const m = docMargins(view.state)
    for (const side of SIDES) inputs[side].value = String(m[side])
    error.textContent = ""
    pop.hidden = false
    inputs.top.focus()
    inputs.top.select()
  }
  for (const side of SIDES) inputs[side].oninput = () => (error.textContent = marginsError(read()) ?? "")
  pop.onsubmit = (e) => {
    e.preventDefault()
    const m = read()
    const err = marginsError(m)
    if (err) {
      error.textContent = err
      return
    }
    pop.hidden = true
    run(setMargins(m))()
    sync()
  }
  cancel.onclick = close
  pop.onkeydown = (e) => {
    if (e.key === "Escape") close()
  }

  sel.onchange = () => {
    if (sel.value === "edit") {
      sync()
      open()
      return
    }
    const preset = MARGIN_PRESETS[sel.value]
    if (preset) run(setMargins(preset.margins))()
  }

  wrap.append(sel, pop)

  const sync = () => {
    const m = docMargins(view.state)
    const preset = Object.entries(MARGIN_PRESETS).find(([, p]) => sameMargins(p.margins, m))
    sel.value = preset ? preset[0] : "current"
    sel.title = `Page margins: ${fmt(m)} (top right bottom left)`
  }
  sync()
  return { el: wrap, sync }
}
