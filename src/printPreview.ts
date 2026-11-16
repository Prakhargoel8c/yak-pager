/**
 * Print preview: the document cut at the layout's breaks (cutter.ts), so the
 * print engine never decides where a page ends. Approach B is one flow with
 * `break-before: page` and @page margins; approach C is one <section> per
 * page with margins and numbers drawn by us, so preview and printout are the
 * same rendering. A split paragraph becomes two real <p>s: the print document
 * is a throwaway rendering of the doc model, never editor state.
 */
import { DOMSerializer } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import { cutPages } from "./cutter"
import { FONTS, docFont } from "./fonts"
import { DESK_GAP, PX_PER_IN, SHEET_W, SHEET_H } from "./layout"
import type { PageGeometry } from "./layout"
import { paginationKey } from "./paginationPlugin"
import { typographyCSS } from "./typography"
import { isList } from "./units"

const PAGE_SIZE = `${SHEET_W / PX_PER_IN}in ${SHEET_H / PX_PER_IN}in`

/** The editor's @font-face rules, so Kruti Dev and Gayathri print as such. */
function fontFaceCSS(): string {
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) if (rule instanceof CSSFontFaceRule) out.push(rule.cssText)
  }
  return out.join("\n")
}

/** The editor's typography; the explicit-break marker keeps its box but prints nothing. */
function typography(scope: string, family: string): string {
  return `${typographyCSS(scope, family)}
${scope} [data-page-break] { visibility: hidden; }
`
}

function printCSS(approach: "B" | "C", g: PageGeometry, family: string): string {
  const margin = `${g.top}px ${g.right}px ${g.bottom}px ${g.left}px`
  if (approach === "B") {
    return `
${fontFaceCSS()}
/* The page number is a margin box (Chrome 131+; absent on older browsers). */
@page {
  size: ${PAGE_SIZE};
  margin: ${margin};
  @bottom-center {
    content: counter(page);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 11px;
    color: #6b7280;
  }
}
html, body { margin: 0; padding: 0; }
html { --content-w: ${g.contentW}px; }
${typography(".doc", family)}
.new-page { break-before: page; }
`
  }
  return `
${fontFaceCSS()}
@page { size: ${PAGE_SIZE}; margin: 0; }
html, body { margin: 0; padding: 0; }
html { --content-w: ${g.contentW}px; }
.sheet {
  width: ${SHEET_W}px;
  height: ${SHEET_H}px;
  box-sizing: border-box;
  padding: ${margin};
  position: relative;
  page-break-after: always;
}
.sheet:last-child { page-break-after: auto; }
${typography(".sheet", family)}
.page-num {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: ${g.bottom}px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11px;
  color: #6b7280;
}
@media screen {
  body { background: #d8dde5; padding: ${DESK_GAP}px 0; }
  .sheet { margin: 0 auto ${DESK_GAP}px; box-shadow: 0 2px 8px rgba(31, 35, 40, 0.25); }
}
`
}

function renderPages(view: EditorView): HTMLElement[][] {
  const { layout } = paginationKey.getState(view.state)!
  const serializer = DOMSerializer.fromSchema(view.state.schema)
  return cutPages(view.state.doc, layout.breaks).map((page) =>
    page.map((piece) => {
      const el = serializer.serializeNode(piece.node) as HTMLElement
      // The line before a cut is an interior line on screen, so justify keeps
      // it flush; in print it is the last line of a real paragraph.
      if (piece.continued) {
        let [node, dom] = [piece.node, el]
        while (isList(node) || node.type.name === "listItem") [node, dom] = [node.lastChild!, dom.lastElementChild as HTMLElement]
        if (node.attrs.align === "justify") dom.style.setProperty("text-align-last", "justify")
      }
      if (piece.continued && piece.node.type.name === "table") el.classList.add("table-continues")
      if (piece.continuation && piece.node.type.name === "table") el.classList.add("table-continued")
      // An item cut in two keeps its marker on the page where it starts.
      let [node, dom, depth] = [piece.node, el, 1]
      while (depth < piece.continuation && (isList(node) || node.type.name === "listItem")) {
        if (node.type.name === "listItem") dom.classList.add("li-continued")
        ;[node, dom, depth] = [node.firstChild!, dom.firstElementChild as HTMLElement, depth + 1]
      }
      return el
    })
  )
}

/** Blocks are joined with no whitespace: the column is pre-wrap, so a newline would render as a line. */
function buildPrintHTML(view: EditorView, approach: "B" | "C"): string {
  const pages = renderPages(view)
  const body =
    approach === "B"
      ? pages
          .map((group, i) => {
            if (i > 0 && group[0]) group[0].classList.add("new-page")
            return group.map((el) => el.outerHTML).join("")
          })
          .join("")
      : pages
          .map((group, i) => {
            const sec = document.createElement("section")
            sec.className = "sheet"
            sec.append(...group)
            const num = document.createElement("div")
            num.className = "page-num"
            num.textContent = String(i + 1)
            sec.append(num)
            return sec.outerHTML
          })
          .join("")
  const wrapped = approach === "B" ? `<main class="doc">${body}</main>` : body
  const { geometry } = paginationKey.getState(view.state)!.layout
  const family = FONTS[docFont(view.state)].family
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>yak-pager print preview (${approach})</title>
<style>${printCSS(approach, geometry, family)}</style>
</head>
<body>${wrapped}</body>
</html>
`
}

let printFrameB: HTMLIFrameElement | null = null

function printB(view: EditorView): void {
  printFrameB?.remove()
  const frame = document.createElement("iframe")
  printFrameB = frame
  frame.id = "print-frame-b"
  // Off-screen but rendered: some browsers refuse to print a display:none iframe.
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${SHEET_W}px;height:${SHEET_H}px;border:0;`
  frame.srcdoc = buildPrintHTML(view, "B")
  frame.addEventListener("load", () => {
    const w = frame.contentWindow
    if (!w) return
    w.addEventListener("afterprint", () => {
      frame.remove()
      if (printFrameB === frame) printFrameB = null
    })
    w.setTimeout(() => {
      w.focus()
      w.print()
    }, 50)
  })
  document.body.append(frame)
}

let modal: HTMLDivElement | null = null
let refit: (() => void) | null = null

function closeModal(): void {
  modal?.remove()
  modal = null
  refit = null
}

function previewC(view: EditorView): void {
  closeModal()

  const m = document.createElement("div")
  m.id = "print-modal"
  m.classList.add("pm-loading") // visibility: hidden keeps layout, so the iframe measures

  const head = document.createElement("div")
  head.className = "pm-head"
  const title = document.createElement("span")
  title.textContent = "Print preview — approach C: one <section> per page"
  const actions = document.createElement("div")
  actions.className = "pm-actions"
  const printBtn = document.createElement("button")
  printBtn.className = "pm-print"
  printBtn.textContent = "Print…"
  const closeBtn = document.createElement("button")
  closeBtn.textContent = "Close"
  actions.append(printBtn, closeBtn)
  head.append(title, actions)

  const body = document.createElement("div")
  body.className = "pm-body"
  const zoom = document.createElement("div")
  zoom.className = "pm-zoom"
  const frame = document.createElement("iframe")
  frame.className = "pm-frame"
  frame.style.width = `${SHEET_W}px`
  frame.srcdoc = buildPrintHTML(view, "C")
  zoom.append(frame)
  body.append(zoom)
  m.append(head, body)

  const fit = () => {
    const avail = body.clientWidth - 48
    const scale = Math.min(1, avail / SHEET_W)
    zoom.style.transform = `scale(${scale})`
    zoom.style.width = `${SHEET_W * scale}px`
    zoom.style.height = `${frame.offsetHeight * scale}px`
  }
  refit = fit

  frame.addEventListener("load", () => {
    frame.style.height = `${frame.contentDocument?.documentElement.scrollHeight ?? 0}px`
    fit()
    m.classList.remove("pm-loading")
  })

  printBtn.onclick = () => {
    const w = frame.contentWindow
    if (!w) return
    // The print run may account for parent transforms; afterprint restores the preview.
    zoom.style.transform = "none"
    w.addEventListener("afterprint", fit, { once: true })
    w.focus()
    w.print()
  }
  closeBtn.onclick = closeModal

  document.body.append(m)
  modal = m
}

export function buildPrintPreviewButtons(view: EditorView, mount: HTMLElement): void {
  const b = document.createElement("button")
  b.textContent = "Preview B"
  b.title =
    "Approach B: one continuous flow with break-before: page at the layout's break positions; page boxes, margins and numbers come from @page. Opens the browser print dialog."
  b.onclick = () => printB(view)

  const c = document.createElement("button")
  c.textContent = "Preview C"
  c.className = "preview-c"
  c.title =
    "Approach C: real page containers (<section> per page) filled by cutting the document; margins and numbers are DOM. Opens an in-app preview whose own document prints."
  c.onclick = () => previewC(view)

  mount.append(b, c)

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal != null) closeModal()
  })
  window.addEventListener("resize", () => {
    if (modal != null) refit?.()
  })
}
