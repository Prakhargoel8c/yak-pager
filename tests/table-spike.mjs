/**
 * Table spike (run: npm run build && node tests/table-spike.mjs) — HTML
 * <table> or CSS grid for paginated tables? Clones every table of the
 * ?lang=table document into hidden copies, renders each copy one way, and
 * compares every row's height with the Pretext prediction the pass uses.
 * Then inserts a gap before a row in each rendering and checks the row
 * after it lands on the gap's bottom edge, and that nothing above moved.
 * Last, drives prosemirror-tables in the live editor (cell selection by
 * drag, column resize) with the tables rendered as a grid.
 */
import { spawn } from "node:child_process"
import puppeteer from "puppeteer-core"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const server = spawn("npx", ["vite", "preview", "--port", "4181", "--strictPort"], { stdio: "ignore", detached: true })
await sleep(1500)
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"] })

const GRID_CSS = `
#paper .ProseMirror.grid-tables table { display: grid; }
#paper .ProseMirror.grid-tables tbody, #paper .ProseMirror.grid-tables tr:not(.page-gap) { display: contents; }
#paper .ProseMirror.grid-tables tr.page-gap { display: block; grid-column: 1 / -1; }
#paper .ProseMirror.grid-tables colgroup { display: none; }
#paper .ProseMirror.grid-tables [colspan="2"] { grid-column: span 2; }
#paper .ProseMirror.grid-tables [colspan="3"] { grid-column: span 3; }
`

try {
  const page = await browser.newPage()
  for (const query of ["?lang=table", "?lang=hi"]) {
    await page.goto(`http://localhost:4181/${query}`, { waitUntil: "networkidle0" })
    await page.evaluate(() => document.fonts.load('16px "Kruti Dev"'))
    await sleep(1200)
    if (query === "?lang=hi") {
      await page.evaluate(() => {
        const { view } = window.__pager
        const { schema } = view.state
        const texts = []
        view.state.doc.descendants((n) => {
          if (n.isText && n.text.length > 40 && texts.length < 9) texts.push(n.text)
        })
        const cell = (s, type = schema.nodes.tableCell) => type.create(null, schema.nodes.paragraph.create(null, schema.text(s)))
        const rows = [0, 3, 6].map((i, r) => schema.nodes.tableRow.create(null, [cell(texts[i].slice(0, 20), r ? undefined : schema.nodes.tableHeader), cell(texts[i + 1]), cell(texts[i + 2].slice(0, 60 + 30 * r))]))
        view.dispatch(view.state.tr.insert(view.state.doc.child(0).nodeSize, schema.nodes.table.create(null, rows)))
      })
      await sleep(600)
    }
    const result = await page.evaluate((GRID_CSS) => {
      const style = document.createElement("style")
      style.textContent = GRID_CSS + `#paper .spike.grid-tables table { display: grid; } #paper .spike.grid-tables tbody, #paper .spike.grid-tables tr { display: contents; } #paper .spike.grid-tables colgroup { display: none; }`
      document.head.append(style)
      const { view } = window.__pager
      const predicted = new Map(window.__pager.compareWithDom().rows.map((r) => [r.pos, r.pretext]))
      const cs = getComputedStyle(view.dom)
      const host = document.createElement("div")
      host.className = "ProseMirror spike"
      host.style.cssText = `position:absolute;visibility:hidden;top:0;left:0;box-sizing:border-box;width:${view.dom.getBoundingClientRect().width}px;padding:0 ${cs.paddingRight} 0 ${cs.paddingLeft};font-family:${cs.fontFamily}`
      document.getElementById("paper").append(host)

      const tables = []
      view.state.doc.forEach((node, pos) => {
        if (node.type.name !== "table") return
        const rows = []
        node.forEach((row, offset) => rows.push(pos + 1 + offset))
        tables.push({ el: view.nodeDOM(pos), rows })
      })

      const copy = (t) => {
        const el = t.el.cloneNode(true)
        el.querySelectorAll(".page-gap, .column-resize-handle").forEach((g) => g.remove())
        host.replaceChildren(el)
        return el
      }
      const rowHeights = (el) => [...el.querySelectorAll("tbody > tr:not(.page-gap)")].map((tr) => (getComputedStyle(tr).display === "contents" ? tr.firstElementChild : tr).getBoundingClientRect().height)
      const asGrid = (el) => {
        host.classList.remove("grid-tables")
        const widths = [...el.querySelectorAll("col")].map((c) => c.getBoundingClientRect().width)
        host.classList.add("grid-tables")
        const table = el.querySelector("table")
        table.style.gridTemplateColumns = widths.map((w) => `${w}px`).join(" ")
        for (const cell of el.querySelectorAll("td, th")) if (cell.colSpan > 1) cell.style.gridColumn = `span ${cell.colSpan}`
      }
      const VARIANTS = {
        "table, separate borders (implemented)": () => {},
        "table, border-collapse: collapse": (el) => (el.querySelector("table").style.borderCollapse = "collapse"),
        "table, auto layout (no colgroup widths)": (el) => {
          el.querySelector("colgroup").remove()
          Object.assign(el.querySelector("table").style, { tableLayout: "auto", width: "100%" })
        },
        "CSS grid, display: contents rows": asGrid,
      }
      const out = {}
      for (const [name, apply] of Object.entries(VARIANTS)) {
        host.classList.remove("grid-tables")
        let n = 0, off = 0, worst = 0
        const samples = []
        for (const t of tables) {
          const el = copy(t)
          apply(el)
          rowHeights(el).forEach((h, i) => {
            const p = predicted.get(t.rows[i])
            if (p === undefined) return
            n++
            const d = h - p
            if (Math.abs(d) >= 0.5) off++
            if (Math.abs(d) > Math.abs(worst)) worst = d
            if (samples.length < 6 && Math.abs(d) >= 0.5) samples.push(`row ${i}: actual ${h.toFixed(2)} predicted ${p.toFixed(2)}`)
          })
        }
        out[name] = { rows: n, off, worst: +worst.toFixed(3), samples }
      }

      // A 200px gap before row 3 of the longest table, rendered each way.
      const t = tables.reduce((a, b) => (b.rows.length > a.rows.length ? b : a))
      const GAP = 200
      const gapTest = (name, setup, makeGap) => {
        host.classList.remove("grid-tables")
        const el = copy(t)
        setup(el)
        const trs = [...el.querySelectorAll("tbody > tr")]
        const K = Math.min(3, trs.length - 1)
        const top = (tr) => (getComputedStyle(tr).display === "contents" ? tr.firstElementChild : tr).getBoundingClientRect().top
        const before = trs.map(top)
        const heights = rowHeights(el)
        const gap = makeGap(el)
        trs[K].before(gap)
        const after = trs.map(top)
        const g = gap.getBoundingClientRect()
        return {
          name,
          gapHeight: +g.height.toFixed(3),
          landsOnGap: +(after[K] - g.bottom).toFixed(3),
          rowsAboveMoved: before.slice(0, K).some((y, i) => Math.abs(y - after[i]) > 0.01),
          rowsBelowShift: [...new Set(after.slice(K).map((y, i) => +(y - before[i + K]).toFixed(3)))],
          heightsChanged: rowHeights(el).some((h, i) => Math.abs(h - heights[i]) > 0.01),
        }
      }
      const trGap = (el) => {
        const tr = document.createElement("tr")
        tr.className = "page-gap"
        tr.style.setProperty("--push", `${GAP - parseFloat(getComputedStyle(view.dom.parentElement).getPropertyValue("--band"))}px`)
        const td = tr.appendChild(document.createElement("td"))
        td.colSpan = el.querySelectorAll("col").length
        return tr
      }
      const divGap = () => {
        const div = document.createElement("div")
        div.style.cssText = `grid-column: 1 / -1; height: ${GAP}px`
        return div
      }
      const gaps = [
        gapTest("table, separate: <tr> gap widget", () => {}, trGap),
        gapTest("table, collapse: <tr> gap widget", (el) => (el.querySelector("table").style.borderCollapse = "collapse"), trGap),
        gapTest("table, separate: bare <div> in <tbody>", () => {}, divGap),
        gapTest("CSS grid: <div> spanning all columns", asGrid, divGap),
      ]
      host.remove()
      return { variants: out, gaps, table: t.rows.length }
    }, GRID_CSS)
    console.log(`— ${query}: predicted (Pretext) vs actual row heights`)
    for (const [name, r] of Object.entries(result.variants)) {
      console.log(`  ${r.off === 0 ? "✓" : "✗"} ${name}: ${r.rows} rows, ${r.off} off by ≥0.5px, worst ${r.worst}px`)
      for (const s of r.samples) console.log(`      ${s}`)
    }
    console.log(`— ${query}: a 200px gap before row 3 (or the last) of a ${result.table}-row table`)
    for (const g of result.gaps) console.log(`  ${g.name}: gap ${g.gapHeight}px, row 3 top − gap bottom ${g.landsOnGap}px, rows above moved: ${g.rowsAboveMoved}, rows below shifted by ${g.rowsBelowShift.join("/")}px, row heights changed: ${g.heightsChanged}`)
  }

  // prosemirror-tables in the live editor, as a table and as a grid.
  for (const grid of [false, true]) {
    const page = await browser.newPage()
    await page.goto("http://localhost:4181/?lang=table", { waitUntil: "load" })
    await sleep(1000)
    const r = await page.evaluate((GRID_CSS, grid) => {
      if (grid) {
        const style = document.createElement("style")
        style.textContent = GRID_CSS
        document.head.append(style)
        const { view } = window.__pager
        ;[...view.dom.children].forEach((el, i) => {
          const cols = [...el.querySelectorAll(":scope > table > colgroup > col")].map((c) => `${c.getBoundingClientRect().width}px`)
          if (cols.length) style.textContent += `#paper .ProseMirror.grid-tables > :nth-child(${i + 1}) > table { grid-template-columns: ${cols.join(" ")}; }\n`
        })
        view.dom.classList.add("grid-tables")
        document.querySelector(".panel-buttons button").click()
      }
      const t = window.__pager.view.dom.querySelector("table")
      t.scrollIntoView({ block: "center" })
      const cells = [...t.querySelectorAll("tr:nth-child(2) > td, tr:nth-child(3) > td")].map((c) => { const b = c.getBoundingClientRect(); return { left: b.left, top: b.top } })
      return { from: cells[0], to: cells[4], edge: cells[0] }
    }, GRID_CSS, grid)
    await sleep(500)
    const landing = await page.evaluate(() => {
      const { view, layout } = window.__pager
      const origin = view.dom.getBoundingClientRect().top
      return [...view.dom.querySelectorAll(".page-gap")].map((g) => +(g.getBoundingClientRect().bottom - origin - layout.pages[+g.dataset.page + 1].start).toFixed(2))
    })
    await page.mouse.move(r.from.left + 10, r.from.top + 10)
    await page.mouse.down()
    await page.mouse.move(r.to.left + 10, r.to.top + 10, { steps: 6 })
    await page.mouse.up()
    const sel = await page.evaluate(() => {
      const s = window.__pager.view.state.selection
      return { type: s.$anchorCell ? "CellSelection" : "TextSelection", cells: document.querySelectorAll(".selectedCell").length }
    })
    // Drag the first column's right edge 60px to the right.
    const edge = await page.evaluate(() => {
      const c = window.__pager.view.dom.querySelector("table tr:nth-child(2) > td").getBoundingClientRect()
      return { x: c.right - 2, y: c.top + c.height / 2 }
    })
    const widthBefore = await page.evaluate(() => window.__pager.view.dom.querySelector("table tr:nth-child(2) > td").getBoundingClientRect().width)
    await page.mouse.move(edge.x, edge.y)
    await page.mouse.move(edge.x + 1, edge.y)
    await page.mouse.down()
    await page.mouse.move(edge.x + 30, edge.y, { steps: 3 })
    const during = await page.evaluate(() => window.__pager.view.dom.querySelector("table tr:nth-child(2) > td").getBoundingClientRect().width)
    await page.mouse.move(edge.x + 60, edge.y, { steps: 3 })
    await page.mouse.up()
    await sleep(300)
    const resized = await page.evaluate(() => ({
      colwidth: window.__pager.view.state.doc.nodeAt(window.__pager.view.posAtDOM(window.__pager.view.dom.querySelector("table tr:nth-child(2) > td"), 0) - 1)?.attrs.colwidth ?? null,
      width: window.__pager.view.dom.querySelector("table tr:nth-child(2) > td").getBoundingClientRect().width,
    }))
    console.log(`— prosemirror-tables in the editor, rendered as ${grid ? "a CSS grid" : "a <table>"}`)
    console.log(`  gap widgets: next page lands off by ${landing.join(", ")}px`)
    console.log(`  drag across cells: ${sel.type}, ${sel.cells} cells highlighted`)
    console.log(`  column resize: first column ${widthBefore}px → ${during}px mid-drag → ${resized.width}px after (colwidth ${JSON.stringify(resized.colwidth)})`)
  }
} finally {
  await browser.close()
  try { process.kill(-server.pid) } catch {}
}
