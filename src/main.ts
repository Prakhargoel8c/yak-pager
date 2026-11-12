import { EditorState } from "prosemirror-state"
import type { Transaction } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { keymap } from "prosemirror-keymap"
import { baseKeymap } from "prosemirror-commands"
import { history, undo, redo } from "prosemirror-history"
import { buildSeedDoc, LANGUAGES } from "./seed"
import type { Language } from "./seed"
import { paginationPlugin, paginationKey, requestFullRecompute, setMeasurer } from "./paginationPlugin"
import type { Measurer } from "./paginationPlugin"
import { compareWithDom } from "./pretextMeasure"
import { buildToolbar, insertPageBreak, insertHardBreak } from "./toolbar"
import { buildPrintPreviewButtons } from "./printPreview"
import { createDevPanel } from "./devPanel"
import "./styles.css"

// Paragraphs and headings are measured with Pretext; ?measure=dom reads them from the DOM instead.
const params = new URLSearchParams(location.search)
const measurer: Measurer = params.get("measure") === "dom" ? "dom" : "pretext"
// ?lang=hi|ml|kn loads the seed document in Hindi, Malayalam or Kannada; English otherwise.
const langParam = params.get("lang") ?? ""
const lang: Language = langParam in LANGUAGES ? (langParam as Language) : "en"

const paperHost = document.getElementById("paper")!
const panel = createDevPanel(document.getElementById("panel")!)

let toolbar: { sync: () => void } | null = null

const view = new EditorView(paperHost, {
  state: EditorState.create({
    doc: buildSeedDoc(lang),
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
document.getElementById("toolbar")!.append(measurerSelect(), languageSelect())
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

/**
 * Loads the seed document in another language as a fresh editor state (its
 * own undo history; switching language is not an edit), keeps ?lang= in the
 * URL, and re-paginates with whichever measurer is selected now.
 */
function languageSelect(): HTMLSelectElement {
  const sel = document.createElement("select")
  sel.title = "Document language"
  for (const [value, { label }] of Object.entries(LANGUAGES)) {
    sel.append(new Option(label, value, false, value === lang))
  }
  sel.onchange = () => {
    const next = sel.value as Language
    const url = new URL(location.href)
    if (next === "en") url.searchParams.delete("lang")
    else url.searchParams.set("lang", next)
    window.history.replaceState(null, "", url)
    const current = paginationKey.getState(view.state)!.measurer
    view.updateState(EditorState.create({ doc: buildSeedDoc(next), plugins: view.state.plugins }))
    setMeasurer(view, current)
    toolbar?.sync()
    panel.sync()
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
