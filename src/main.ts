import { EditorState } from "prosemirror-state"
import type { Transaction } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { keymap } from "prosemirror-keymap"
import { baseKeymap } from "prosemirror-commands"
import { history, undo, redo } from "prosemirror-history"
import { buildSeedDoc } from "./seed"
import { paginationPlugin, paginationKey, requestFullRecompute, setMeasurer } from "./paginationPlugin"
import type { Measurer } from "./paginationPlugin"
import { compareWithDom } from "./pretextMeasure"
import { buildToolbar, insertPageBreak, insertHardBreak } from "./toolbar"
import { buildPrintPreviewButtons } from "./printPreview"
import { createDevPanel } from "./devPanel"
import "./styles.css"

// Paragraphs and headings are measured with Pretext; ?measure=dom reads them from the DOM instead.
const measurer: Measurer = new URLSearchParams(location.search).get("measure") === "dom" ? "dom" : "pretext"

const paperHost = document.getElementById("paper")!
const panel = createDevPanel(document.getElementById("panel")!)

let toolbar: { sync: () => void } | null = null

const view = new EditorView(paperHost, {
  state: EditorState.create({
    doc: buildSeedDoc(),
    plugins: [
      history(),
      keymap({
        "Mod-z": undo,
        "Mod-y": redo,
        "Shift-Mod-z": redo,
        "Mod-Enter": insertPageBreak,
        "Shift-Enter": insertHardBreak,
      }),
      keymap(baseKeymap),
      paginationPlugin({ onReflow: (r) => panel.report(r), measurer }),
    ],
  }),
  dispatchTransaction(tr: Transaction) {
    view.updateState(view.state.apply(tr))
    toolbar?.sync()
    panel.sync()
  },
})

toolbar = buildToolbar(view, document.getElementById("toolbar")!)
buildPrintPreviewButtons(view, document.getElementById("toolbar")!)
document.getElementById("toolbar")!.append(measurerSelect())
panel.attach(view)

  // Poke at the editor from the console: window.__pager.view.state.doc, ...
  // (also used by tests/e2e.mjs to verify widget placement against the doc —
  // the key is how it reads the pagination state out of the built bundle).
  ; (window as unknown as {
    __pager: { view: EditorView; key: typeof paginationKey; measurer: Measurer; compareWithDom: () => ReturnType<typeof compareWithDom> }
  }).__pager = {
    view,
    key: paginationKey,
    get measurer() {
      return paginationKey.getState(view.state)!.measurer
    },
    compareWithDom: () => compareWithDom(view),
  }

/** Switches the measurer live and keeps ?measure= in the URL, so a reload keeps the choice. */
function measurerSelect(): HTMLSelectElement {
  const sel = document.createElement("select")
  sel.title = "How paragraphs and headings are measured"
  for (const [value, label] of [["pretext", "Measure: Pretext"], ["dom", "Measure: DOM"]]) {
    sel.append(new Option(label, value, false, value === measurer))
  }
  sel.onchange = () => {
    const next = sel.value as Measurer
    const url = new URL(location.href)
    if (next === "dom") url.searchParams.set("measure", "dom")
    else url.searchParams.delete("measure")
    window.history.replaceState(null, "", url)
    setMeasurer(view, next)
    view.focus()
  }
  return sel
}

// Heights can change without the document changing: fonts settling, images
// loading, the window resizing. Each triggers a full re-measure through a
// meta-transaction; the pass itself stays debounced and idempotent.
if (typeof document !== "undefined" && "fonts" in document) {
  document.fonts.ready.then(() => requestFullRecompute(view))
}
window.addEventListener("resize", () => requestFullRecompute(view))
// Capture phase: <load> does not bubble, and it fires on descendants.
paperHost.addEventListener(
  "load",
  (e) => {
    if ((e.target as HTMLElement)?.tagName === "IMG") requestFullRecompute(view)
  },
  true
)
