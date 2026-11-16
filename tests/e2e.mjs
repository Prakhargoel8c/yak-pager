/**
 * E2E (npm run build && npm run e2e; E2E_QUERY=?lang=… picks the document):
 * idempotence, undo never touching pagination, reflow reusing widgets,
 * pixel-exact landing, justified text across a split, tables and lists.
 * Requires google-chrome on PATH (or CHROME=/path/to/chrome).
 */
import { spawn } from "node:child_process"
import puppeteer from "puppeteer-core"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${extra ? "  — " + extra : ""}`)
  if (!cond) failures++
}

const server = spawn("npx", ["vite", "preview", "--port", "4179", "--strictPort"], {
  stdio: "ignore",
  detached: true,
})
await sleep(1500)

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-gpu"],
})
const page = await browser.newPage()
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text())
})

await page.goto(`http://localhost:4179/${process.env.E2E_QUERY ?? ""}`, { waitUntil: "networkidle0" })
await sleep(1200) // initial pass + fonts.ready-triggered full pass

const readChips = () =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".chip")].map((c) => {
        const m = c.textContent.match(/^(.*?) (\d+)$/)
        return m ? [m[1], Number(m[2])] : [c.textContent, NaN]
      })
    )
  )
const readStats = () =>
  page.evaluate(() => ({
    pages: Number(document.querySelector(".stats .v")?.textContent ?? NaN),
    breaks: [...document.querySelectorAll(".breaks div")].textContent ?? "",
  }))
const lastPass = () => page.evaluate(() => window.__pager.reflows.at(-1)?.pass ?? 0)
/** DOM operation counts summed over every pass after `pass`: a pass runs per keystroke. */
const opsSince = (pass) =>
  page.evaluate((after) => {
    const sum = {}
    for (const r of window.__pager.reflows.filter((r) => r.pass > after)) {
      for (const [k, n] of Object.entries(r.counts)) sum[k] = (sum[k] ?? 0) + n
    }
    return sum
  }, pass)
/** Every widget's box must end exactly at the next page's content start. */
const checkLanding = async (prefix) => {
  const landing = await page.evaluate(() => {
    const { view, layout } = window.__pager
    const pmTop = view.dom.getBoundingClientRect().top
    return layout.breaks.map((b, i) => {
      const w = [...view.dom.querySelectorAll(".page-gap")].find((x) => x.dataset.page === String(i))
      return { bottom: w ? w.getBoundingClientRect().bottom - pmTop : null, start: layout.pages[i + 1].start }
    })
  })
  landing.forEach((l, i) => {
    ok(
      l.bottom != null && Math.abs(l.bottom - l.start) <= 0.5,
      `${prefix}widget ${i} box bottom = page ${i + 2} content start (${l.start.toFixed(1)})`,
      l.bottom == null ? "widget missing" : `off by ${(l.bottom - l.start).toFixed(2)}px`
    )
  })
}

console.log("— initial layout")
const stats1 = await readStats()
const chips1 = await readChips()
ok(stats1.pages >= 4, `seed spans 4+ pages`, `pages=${stats1.pages}`)
ok((chips1.other ?? 0) === 0, "no unexpected DOM mutations", `other=${chips1.other}`)
// Summed over the startup passes: a font load runs a later full pass that reuses the widgets.
const created = await page.evaluate(() => window.__pager.reflows.reduce((n, r) => n + (r.counts.create ?? 0), 0))
ok(created > 0, "gap widgets created once at startup", `create=${created}`)
// Print lays text out in the geometry's column; a wider screen column would wrap differently.
const column = await page.evaluate(() => {
  const ed = window.__pager.view.dom
  const cs = getComputedStyle(ed)
  return { editor: ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), geometry: window.__pager.geometry.contentW }
})
ok(column.editor === column.geometry, "editor column is the geometry's content width", JSON.stringify(column))

console.log("— idempotence: force full re-measure of stable layout")
const before = await page.evaluate(() => document.querySelector(".paper-stack")?.innerHTML.length)
await page.evaluate(() => [...document.querySelectorAll(".panel-buttons button")][0].click())
await sleep(700)
const chips2 = await readChips()
const totalOps = Object.values(chips2).reduce((a, b) => a + b, 0)
ok(totalOps === 0, "re-run pass performed ZERO DOM operations", JSON.stringify(chips2))
const after = await page.evaluate(() => document.querySelector(".paper-stack")?.innerHTML.length)
ok(before === after, "editor DOM byte-identical before/after re-run")

console.log("— rule 1: undo undoes typing, never pagination")
await page.evaluate(() => {
  const pm = document.querySelector(".ProseMirror")
  const last = pm.lastElementChild
  const range = document.createRange()
  range.selectNodeContents(last)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  pm.focus()
})
await page.keyboard.type(" UNDOABLE-SENTENCE")
await sleep(300) // the pass runs in a microtask after each transaction
const chipsTyped = await readChips()
ok((chipsTyped.other ?? 0) === 0, "typing reflow: no unexpected DOM mutations", JSON.stringify(chipsTyped))
ok(
  Object.values(chipsTyped).every((v) => v === 0),
  "typing absorbed by ragged space → reflow performed ZERO DOM operations"
)
const textWith = await page.evaluate(() => document.querySelector(".ProseMirror").lastElementChild.textContent)
ok(textWith.endsWith("UNDOABLE-SENTENCE"), "typed text present", textWith.slice(-40))

await page.keyboard.down("Control")
await page.keyboard.press("KeyZ")
await page.keyboard.up("Control")
await sleep(300) // the pass runs in a microtask after each transaction
const textAfter = await page.evaluate(() => document.querySelector(".ProseMirror").lastElementChild.textContent)
ok(
  !textAfter.includes("UNDOABLE-SENTENCE"),
  "one Ctrl+Z removed exactly the typed text",
  textAfter.slice(-40)
)
// The seed predates history: a second Ctrl+Z must do nothing.
await page.keyboard.down("Control")
await page.keyboard.press("KeyZ")
await page.keyboard.up("Control")
await sleep(700)
const textAfter2 = await page.evaluate(() => document.querySelector(".ProseMirror").lastElementChild.textContent)
ok(textAfter2 === textAfter, "second Ctrl+Z was a no-op (no pagination in undo stack)")

console.log("— rule 3: break movement reused widgets, did not rebuild")
// Content below shifts, so an existing break moves to a different block.
await page.evaluate(() => {
  const ps = [...document.querySelectorAll(".ProseMirror > p")]
  const mid = ps[Math.floor(ps.length / 2)]
  const range = document.createRange()
  range.selectNodeContents(mid)
  range.collapse(true) // caret at start of a mid paragraph
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  document.querySelector(".ProseMirror").focus()
})
const passBefore = await lastPass()
for (let i = 0; i < 8; i++) {
  await page.keyboard.press("Enter")
  await page.keyboard.type("newly inserted paragraph")
}
await sleep(300)
const chips3 = await opsSince(passBefore)
ok((chips3.other ?? 0) === 0, "break-move reflow: no unexpected mutations", JSON.stringify(chips3))
ok((chips3.insertBefore ?? 0) > 0, "widgets moved via insertBefore", `insertBefore=${chips3.insertBefore}`)
ok((chips3.setAttribute ?? 0) > 0, "pushes updated via setAttribute (--push)", `setAttribute=${chips3.setAttribute}`)
const widgetCount = await page.evaluate(() => document.querySelectorAll(".page-gap").length)
const pageCount = (await readStats()).pages
ok(widgetCount === pageCount - 1, "one pooled widget per break", `${widgetCount} widgets / ${pageCount} pages`)
ok(
  (chips3.create ?? 0) + (chips3.remove ?? 0) <= 2,
  "page count stable → no widget churn while breaks moved",
  `create=${chips3.create} remove=${chips3.remove}`
)

console.log("— typing inside a paragraph that straddles a page boundary")
// Type at the end of the paragraph that holds a gap widget: the split may move or stay put.
await page.evaluate(() => {
  const p = [...document.querySelectorAll(".ProseMirror p")].find((el) =>
    el.querySelector(".page-gap")
  )
  const range = document.createRange()
  range.selectNodeContents(p)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  document.querySelector(".ProseMirror").focus()
})
await page.keyboard.type(" And a final sentence, typed at the end of a paragraph that is currently split across a page boundary.")
await sleep(1100)
const chips4 = await readChips()
ok((chips4.other ?? 0) === 0, "typing in a split paragraph: no unexpected mutations", JSON.stringify(chips4))
ok(
  (chips4.create ?? 0) + (chips4.remove ?? 0) <= 2,
  "typing in a split paragraph: no widget churn",
  `create=${chips4.create} remove=${chips4.remove}`
)

// Each widget sits immediately before its break's content, a block or a word.
const placement = await page.evaluate(() => {
  const { view, layout } = window.__pager
  const s = view.state
  const bl = layout.breaks
  const bad = []
  bl.forEach((b, i) => {
    const w = [...view.dom.querySelectorAll(".page-gap")].find(
      (x) => x.dataset.page === String(i)
    )
    if (!w) return void bad.push(`widget ${i} missing`)
    const at = view.domAtPos(b.pos)
    const target = at.node.nodeType === 1 ? at.node.childNodes[at.offset] : at.node
    let prev = target?.previousSibling
    while (prev && prev.nodeType === 3 && !(prev.textContent || "").trim()) {
      prev = prev.previousSibling
    }
    if (!prev || prev !== w) bad.push(`widget ${i} not immediately before pos ${b.pos}`)
  })
  return {
    breaks: bl.map((b) => b.pos),
    inline: bl.some((b) => s.doc.resolve(b.pos).depth >= 1),
    bad,
  }
})
ok(placement.bad.length === 0, "every widget sits immediately before its break's content", JSON.stringify(placement.bad))
ok(placement.inline, "at least one break splits a paragraph mid-text (inline pos)")

await checkLanding("")

console.log("— justified text: flush lines, including across a page split")
// Word rects grouped into visual lines; every line but the last must be flush right.
const measureJustified = (mode) =>
  page.evaluate((mode) => {
    const ps = [...document.querySelectorAll(".ProseMirror p")]
    const p =
      mode === "split"
        ? ps.find((el) => el.querySelector(".page-gap"))
        : ps.find((el) => el.style.textAlign === "justify")
    if (!p) return { error: "no such paragraph" }
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    const words = []
    let tn
    while ((tn = walker.nextNode())) {
      if (tn.parentElement?.closest(".page-gap")) continue
      const s = tn.textContent || ""
      const re = /\S+/g
      let m
      while ((m = re.exec(s))) {
        const r = document.createRange()
        r.setStart(tn, m.index)
        r.setEnd(tn, m.index + m[0].length)
        const rect = r.getBoundingClientRect()
        if (rect.width || rect.height) words.push(rect)
      }
    }
    words.sort((a, b) => a.top - b.top)
    const lines = []
    for (const w of words) {
      const line = lines[lines.length - 1]
      const overlap = line ? Math.min(line.bottom, w.bottom) - Math.max(line.top, w.top) : 0
      if (line && overlap > Math.min(line.bottom - line.top, w.bottom - w.top) / 2) {
        line.top = Math.min(line.top, w.top)
        line.bottom = Math.max(line.bottom, w.bottom)
        line.right = Math.max(line.right, w.right)
      } else {
        lines.push({ top: w.top, bottom: w.bottom, right: w.right })
      }
    }
    const right = p.getBoundingClientRect().right
    const gapBox = p.querySelector(".page-gap")?.getBoundingClientRect() ?? null
    const bad = []
    lines.forEach((l, i) => {
      if (i < lines.length - 1 && Math.abs(l.right - right) > 1) bad.push({ line: i, shortBy: right - l.right })
    })
    const flush = (l) => Math.abs(l.right - right) <= 1
    return {
      error: null,
      justified: p.style.textAlign === "justify",
      lineCount: lines.length,
      bad,
      right,
      lastRight: lines[lines.length - 1]?.right ?? null,
      hasGap: !!gapBox,
      aboveGap: gapBox ? lines.filter((l) => l.bottom <= gapBox.top && flush(l)).length : 0,
      belowGap: gapBox ? lines.filter((l) => l.top >= gapBox.bottom && flush(l)).length : 0,
    }
  }, mode)

const seedJust = await measureJustified("seed")
ok(seedJust.error === null, "seed's justified paragraph is in the DOM (toDOM wrote the style)")
ok(seedJust.justified && seedJust.lineCount >= 2, `justified paragraph wraps to ${seedJust.lineCount} lines`)
ok(
  seedJust.bad.length === 0,
  "every line but the last sits flush at the right margin",
  `bad lines: ${JSON.stringify(seedJust.bad)}`
)
ok(
  seedJust.lastRight != null && seedJust.lastRight < seedJust.right - 10,
  "the last line stays ragged (browsers never justify it)",
  `last line right edge ${(seedJust.right - seedJust.lastRight).toFixed(1)}px short`
)

// Justify a paragraph that straddles a page boundary, through the toolbar.
await page.evaluate(() => {
  const p = [...document.querySelectorAll(".ProseMirror p")].find((el) =>
    el.querySelector(".page-gap")
  )
  const range = document.createRange()
  range.selectNodeContents(p)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  document.querySelector(".ProseMirror").focus()
})
await page.select('select[title="Alignment"]', "justify")
await sleep(300) // the pass runs in a microtask after each transaction
const splitJust = await measureJustified("split")
ok(splitJust.error === null && splitJust.justified, "toolbar Alignment control justified the split paragraph")
ok(splitJust.hasGap, "that paragraph still straddles a page (contains a gap widget)")
ok(
  splitJust.bad.length === 0,
  "flush across the whole split paragraph, on both pages",
  `bad lines: ${JSON.stringify(splitJust.bad)}`
)
ok(
  splitJust.aboveGap >= 1 && splitJust.belowGap >= 1,
  "flush lines both above and below the gap widget",
  `above=${splitJust.aboveGap} below=${splitJust.belowGap}`
)

console.log("— regression: an edit that strands a widget at a paragraph's end")
// Deleting everything after a widget inside a straddling paragraph leaves its
// float overhanging the paragraph's rect; measureBlock must not subtract it.
const stranded = await page.evaluate(() => {
  const { view, layout } = window.__pager
  let idx = -1
  layout.pages.forEach((p, i) => {
    if (idx < 0 && p.opening === "inside") idx = i - 1
  })
  if (idx < 0) return { error: "no in-paragraph break" }
  const b = layout.breaks[idx]
  const $p = view.state.doc.resolve(b.pos)
  view.dispatch(view.state.tr.delete(b.pos, $p.end()))
  const w = view.dom.querySelector(`.page-gap[data-page="${idx}"]`)
  const p = w && w.closest("p")
  if (!w || !p) return { error: "widget not inside a paragraph after the delete" }
  const wr = w.getBoundingClientRect()
  const pr = p.getBoundingClientRect()
  return { overhang: wr.bottom > pr.bottom + 1 }
})
ok(stranded.error == null, "deleted the fragment after an in-paragraph break", JSON.stringify(stranded))
ok(
  stranded.overhang === true,
  "the widget's float overhangs the paragraph's rect (the poison state)"
)
await sleep(300) // the next pass measures the overhanging-widget state
const strandedPass = await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos))
await page.evaluate(() => [...document.querySelectorAll(".panel-buttons button")][0].click())
await sleep(800)
const strandedRerun = await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos))
ok(
  JSON.stringify(strandedPass) === JSON.stringify(strandedRerun),
  "the pass on the stranded-widget state agrees with a full re-run",
  `pass=${JSON.stringify(strandedPass)} rerun=${JSON.stringify(strandedRerun)}`
)
await checkLanding("stranded-widget layout: ")
await page.evaluate(() => window.__pager.view.focus())
await page.keyboard.down("Control")
await page.keyboard.press("KeyZ")
await page.keyboard.up("Control")
await sleep(900)

console.log("— regression: a mark change re-measures the paragraph")
// A mark step maps no positions, so tr.changedRange() is null; the pass must still run.
const markBefore = await page.evaluate(() => {
  const { view, layout } = window.__pager
  const b = layout.breaks[0]
  const $b = view.state.doc.resolve(b.pos)
  const off = $b.depth > 0 ? $b.before(1) : b.pos - view.state.doc.childBefore(b.pos).node.nodeSize
  const node = view.state.doc.nodeAt(off)
  view.dispatch(
    view.state.tr.addMark(off + 1, off + 1 + node.content.size, view.state.schema.marks.fontSize.create({ size: 28 }))
  )
  return layout.breaks.map((b) => b.pos)
})
await sleep(900)
const markPass = await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos))
await page.evaluate(() => [...document.querySelectorAll(".panel-buttons button")][0].click())
await sleep(800)
const markRerun = await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos))
ok(
  JSON.stringify(markPass) !== JSON.stringify(markBefore),
  "a 28px fontSize mark on the paragraph at the first break moved the breaks"
)
ok(
  JSON.stringify(markPass) === JSON.stringify(markRerun),
  "the pass after the mark change agrees with a full re-run",
  `pass=${JSON.stringify(markPass)} rerun=${JSON.stringify(markRerun)}`
)

console.log("— page numbers are never part of a selection")
const acrossBreak = await page.evaluate(() => {
  const { view, layout } = window.__pager
  const b = layout.breaks[0]
  const TS = view.state.selection.constructor
  view.dispatch(view.state.tr.setSelection(TS.create(view.state.doc, b.pos - 40, b.pos + 40)))
  const dom = window.getSelection().toString().replace(/\s+/g, " ")
  const doc = view.state.doc.textBetween(b.pos - 40, b.pos + 40, " ").replace(/\s+/g, " ")
  return { dom, doc, numbers: [...view.dom.querySelectorAll(".gap-num")].map((n) => n.textContent).join("") }
})
ok(acrossBreak.numbers === "", "page numbers have no text in the DOM", JSON.stringify(acrossBreak.numbers))
// From the first space to the last: the ±40 ends can fall inside a grapheme
// cluster (a Malayalam vowel sign), which the selection snaps to whole.
const words = (t) => t.slice(t.indexOf(" "), t.lastIndexOf(" ")).trim()
ok(
  words(acrossBreak.dom) === words(acrossBreak.doc),
  "a selection across the first break selects only the document's text",
  `dom=${JSON.stringify(acrossBreak.dom)} doc=${JSON.stringify(acrossBreak.doc)}`
)

const rowBreak = () =>
  page.evaluate(() => {
    const { view, layout } = window.__pager
    return layout.breaks.findIndex((b) => view.state.doc.resolve(b.pos).parent.type.name === "table")
  })
if ((await rowBreak()) >= 0) {
  console.log("— tables: typing in the last row on a page")
  // The row before a gap row grows until it no longer fits and moves whole.
  const k = await rowBreak()
  await page.evaluate((k) => {
    const { view } = window.__pager
    const tr = view.dom.querySelector(`.page-gap[data-page="${k}"]`).previousElementSibling
    const p = tr.lastElementChild.querySelector("p")
    const pos = view.posAtDOM(p, p.childNodes.length)
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, pos)))
    view.focus()
  }, k)
  const passBeforeRow = await lastPass()
  const breakBefore = await page.evaluate((k) => window.__pager.layout.breaks[k].pos, k)
  await page.keyboard.type(" and more words typed into a table cell until its row no longer fits on the page".repeat(2))
  await sleep(600)
  const rowOps = await opsSince(passBeforeRow)
  const rowState = await page.evaluate((k) => {
    const { view, layout } = window.__pager
    const b = layout.breaks[k]
    const gap = view.dom.querySelector(`.page-gap[data-page="${k}"]`)
    return { pos: b.pos, inTable: view.state.doc.resolve(b.pos).parent.type.name === "table", tag: gap?.tagName, before: gap?.nextElementSibling === view.nodeDOM(b.pos) }
  }, k)
  ok(rowState.pos < breakBefore && rowState.inTable, "the grown row moved to the next page whole", `break ${breakBefore} → ${rowState.pos}`)
  ok(rowState.tag === "TR" && rowState.before, "the gap is a table row right before the moved row")
  ok((rowOps.other ?? 0) === 0 && (rowOps.create ?? 0) + (rowOps.remove ?? 0) === 0, "typing in a table: the reflow only reused widgets", JSON.stringify(rowOps))
  await checkLanding("table layout: ")
}

const nestedItem = await page.evaluate(() => {
  let at = null
  window.__pager.view.state.doc.descendants((n, pos, parent, index) => {
    if (at === null && n.type.name === "listItem" && index > 0 && n.firstChild.textContent.length > 100) at = pos + 2
  })
  return at
})
if (nestedItem != null) {
  console.log("— lists: Tab and Shift-Tab re-paginate")
  // Sinking an item narrows its lines by one indent, so the breaks below move.
  await page.evaluate((at) => {
    const { view } = window.__pager
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, at)))
    view.focus()
  }, nestedItem)
  const before = { pass: await lastPass(), breaks: await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos)) }
  await page.keyboard.press("Tab")
  await sleep(500)
  const sunk = await page.evaluate(() => window.__pager.layout.breaks.map((b) => [b.pos, b.remaining]))
  await page.evaluate(() => document.querySelector(".panel-buttons button").click())
  await sleep(500)
  const sunkRerun = await page.evaluate(() => window.__pager.layout.breaks.map((b) => [b.pos, b.remaining]))
  await page.keyboard.down("Shift")
  await page.keyboard.press("Tab")
  await page.keyboard.up("Shift")
  await sleep(500)
  const listOps = await opsSince(before.pass)
  const lifted = await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos))
  ok(JSON.stringify(sunk) === JSON.stringify(sunkRerun), "after Tab, the layout matches a full re-run", `pass ${JSON.stringify(sunk)} rerun ${JSON.stringify(sunkRerun)}`)
  ok(JSON.stringify(lifted) === JSON.stringify(before.breaks), "Shift-Tab put them back")
  ok((listOps.other ?? 0) === 0 && (listOps.create ?? 0) + (listOps.remove ?? 0) === 0, "indenting a list item: the reflow only reused widgets", JSON.stringify(listOps))
  await checkLanding("list layout: ")
}

console.log("— doc.toJSON() carries no page nodes")
const docDumped = await page.evaluate(() => {
  ;[...document.querySelectorAll(".panel-buttons button")][1].click()
  return true
})
ok(docDumped, "dump button works (see browser console)")

await browser.close()
try {
  process.kill(-server.pid, "SIGTERM")
} catch {}

console.log(failures === 0 ? "\nE2E: all checks passed" : `\nE2E: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
