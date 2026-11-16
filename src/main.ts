import { EditorState } from "prosemirror-state"
import type { Transaction } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { keymap } from "prosemirror-keymap"
import { columnResizing, tableEditing } from "prosemirror-tables"
import { listInputRules, listKeymap } from "./lists"
import { TableView } from "./tables"
import { baseKeymap } from "prosemirror-commands"
import { history, undo, redo } from "prosemirror-history"
import { buildSeedDoc, LANGUAGES } from "./seed"
import type { Language } from "./seed"
import { paginationPlugin, paginationKey, requestFullRecompute, setMeasurer } from "./paginationPlugin"
import type { MeasurerKind } from "./paginationPlugin"
import type { ReflowReport } from "./reflowAudit"
import { compareWithDom } from "./measurers"
import { typographyCSS } from "./typography"
import { buildToolbar, insertPageBreak, insertHardBreak } from "./toolbar"
import { buildPrintPreviewButtons } from "./printPreview"
import { createDevPanel } from "./devPanel"
import { installApiMeter } from "./apiMeter"
import { FONTS, docFont } from "./fonts"
import type { Layout, PageGeometry } from "./layout"
import "./styles.css"

const params = new URLSearchParams(location.search)
const measurer: MeasurerKind = params.get("measure") === "dom" ? "dom" : "pretext"
const langParam = params.get("lang") ?? ""
const lang: Language = langParam in LANGUAGES ? (langParam as Language) : "en"

installApiMeter()

const typography = document.createElement("style")
typography.textContent = typographyCSS("#paper .ProseMirror", FONTS.georgia.family)
document.head.append(typography)

const paperHost = document.getElementById("paper")!
const panel = createDevPanel(document.getElementById("panel")!)

let toolbar: { sync: () => void } | null = null

// The last 200 pass reports, for tests.
const reflows: ReflowReport[] = []
const onReflow = (r: ReflowReport) => {
  reflows.push(r)
  if (reflows.length > 200) reflows.shift()
  panel.report(r)
}

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
      listKeymap(),
      listInputRules(),
      keymap(baseKeymap),
      columnResizing({ View: TableView }),
      tableEditing(),
      paginationPlugin({ onReflow, measurer }),
    ],
  }),
  // Kruti Dev text is ASCII underneath: spellcheck would flag every word and autocorrect rewrite keystrokes.
  attributes: (state): Record<string, string> => {
    const font = docFont(state)
    const attrs: Record<string, string> = { style: `font-family: ${FONTS[font].family}` }
    if (font === "kruti") Object.assign(attrs, { spellcheck: "false", autocorrect: "off", autocapitalize: "off" })
    return attrs
  },
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

// The tests read the layout and geometry from here.
;(window as unknown as {
  __pager: {
    view: EditorView
    key: typeof paginationKey
    measurer: MeasurerKind
    layout: Layout
    geometry: PageGeometry
    reflows: ReflowReport[]
    compareWithDom: () => ReturnType<typeof compareWithDom>
  }
}).__pager = {
  view,
  key: paginationKey,
  reflows,
  get measurer() {
    return paginationKey.getState(view.state)!.measurer
  },
  get layout() {
    return paginationKey.getState(view.state)!.layout
  },
  get geometry() {
    return paginationKey.getState(view.state)!.layout.geometry
  },
  compareWithDom: () => compareWithDom(view),
}

function measurerSelect(): HTMLSelectElement {
  const sel = document.createElement("select")
  sel.title = "How paragraphs and headings are measured"
  for (const [value, label] of [["pretext", "Measure: Pretext"], ["dom", "Measure: DOM"]]) {
    sel.append(new Option(label, value, false, value === measurer))
  }
  sel.onchange = () => {
    const next = sel.value as MeasurerKind
    const url = new URL(location.href)
    if (next === "dom") url.searchParams.set("measure", "dom")
    else url.searchParams.delete("measure")
    window.history.replaceState(null, "", url)
    setMeasurer(view, next)
    view.focus()
  }
  return sel
}

/** A fresh editor state: switching language is not an edit, so it gets its own undo history. */
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

// Heights change without the document changing: fonts, images, resize. A web
// font starts loading when text first uses it, after document.fonts.ready
// may have resolved, hence loadingdone too.
if (typeof document !== "undefined" && "fonts" in document) {
  document.fonts.ready.then(() => requestFullRecompute(view))
  document.fonts.addEventListener("loadingdone", () => requestFullRecompute(view))
}
window.addEventListener("resize", () => requestFullRecompute(view))
// Capture phase: <load> does not bubble.
paperHost.addEventListener(
  "load",
  (e) => {
    if ((e.target as HTMLElement)?.tagName === "IMG") requestFullRecompute(view)
  },
  true
)
