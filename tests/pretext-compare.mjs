/**
 * Pretext vs DOM (run: npm run build && npm run pretext-compare) — measures
 * every paragraph and heading both ways in a real browser and fails on any
 * block whose height (to 0.5px) or split candidates differ.
 *
 * Runs on the seed document, then again after appending blocks that stress
 * the line model: long unbreakable words, a URL, hard breaks (including a
 * trailing one), an empty paragraph, mixed font sizes on one line, marks in
 * headings, and justified text. Then once more with Indic and mixed-script
 * text (tests/indic-samples.json): every sample as a paragraph, plus Indic
 * headings, marks, font sizes and hard breaks. Last, the Hindi seed in
 * Kruti Dev 010 (?lang=hi): legacy-encoded text in a web font, with Latin
 * runs in Georgia on the same lines.
 *
 * Requires google-chrome on PATH (or CHROME=/path/to/chrome) and a build.
 */
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import puppeteer from "puppeteer-core"

const INDIC = JSON.parse(readFileSync(new URL("./indic-samples.json", import.meta.url), "utf8"))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = spawn("npx", ["vite", "preview", "--port", "4180", "--strictPort"], { stdio: "ignore", detached: true })
await sleep(1500)
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-gpu"],
})
let failures = 0
try {
  const page = await browser.newPage()
  await page.goto("http://localhost:4180/", { waitUntil: "networkidle0" })
  await sleep(1200)

  // Fails on a height off by 0.5px or more, a DOM split candidate Pretext
  // doesn't have, or a split top where Pretext is wrong. Split tops are
  // judged against the browser itself: the paragraph is cloned, cut at the
  // split, and its height is the carried line's line-box top. The DOM path
  // is not the reference there, as it assumes every line has the first
  // line's half-leading, which is off when a line holds a larger font or
  // a second font (Latin runs in a Kruti Dev document). Expected, and only
  // listed: extra Pretext candidates, lines that start inside a
  // whitespace-free token (after a hyphen, or a long word or URL broken
  // mid-way), which the DOM path's /\S+/ word grouping never sees.
  const report = async (label) => {
    const { compared, diffs } = await page.evaluate(() => {
      const { view } = window.__pager
      const result = window.__pager.compareWithDom()
      const host = document.createElement("div")
      host.className = "ProseMirror"
      host.style.cssText = `position:absolute;visibility:hidden;top:0;left:0;box-sizing:border-box;width:${view.dom.getBoundingClientRect().width}px`
      // The document's font is an inline style on the editor (its doc attr).
      host.style.fontFamily = getComputedStyle(view.dom).fontFamily
      document.getElementById("paper").append(host)
      for (const d of result.diffs) {
        const pretext = new Map((d.pretext.splitCandidates ?? []).map((s) => [s.pos, s.height]))
        d.truth = {}
        for (const s of d.dom.splitCandidates ?? []) {
          if (!pretext.has(s.pos) || Math.abs(pretext.get(s.pos) - s.height) < 0.5) continue
          const original = view.nodeDOM(d.offset)
          const clone = original.cloneNode(true)
          // A paragraph in a list is laid out at its level's width.
          clone.style.width = `${original.getBoundingClientRect().width}px`
          clone.querySelectorAll(".page-gap").forEach((g) => g.remove())
          clone.style.marginTop = ""
          host.replaceChildren(clone)
          const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
          let seen = 0
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (seen + n.data.length >= s.pos) {
              const cut = document.createRange()
              cut.setStart(n, s.pos - seen)
              cut.setEndAfter(clone.lastChild)
              cut.deleteContents()
              break
            }
            seen += n.data.length
          }
          d.truth[s.pos] = clone.getBoundingClientRect().height - parseFloat(getComputedStyle(clone).paddingBottom)
        }
      }
      host.remove()
      return result
    })
    const problems = []
    const notes = []
    for (const d of diffs) {
      const where = `#${d.index} ${d.type} "${d.text.slice(0, 50)}…"`
      if (Math.abs(d.dom.height - d.pretext.height) >= 0.5) {
        problems.push(`${where}: height dom ${d.dom.height.toFixed(2)} / pretext ${d.pretext.height.toFixed(2)}`)
        continue
      }
      const pt = new Map((d.pretext.splitCandidates ?? []).map((s) => [s.pos, s.height]))
      const dom = d.dom.splitCandidates ?? []
      let domOff = 0
      for (const s of dom) {
        if (!pt.has(s.pos)) problems.push(`${where}: DOM line start at ${s.pos} (top ${s.height}px) missing from Pretext`)
        else if (d.truth[s.pos] === undefined) continue
        else if (Math.abs(pt.get(s.pos) - d.truth[s.pos]) >= 0.5) problems.push(`${where}: line at ${s.pos} top ${d.truth[s.pos]} / pretext ${pt.get(s.pos)}`)
        else domOff++
      }
      if (domOff) notes.push(`${where}: ${domOff} line top(s) where the DOM path is off and Pretext matches the browser`)
      const domPos = new Set(dom.map((s) => s.pos))
      const extra = (d.pretext.splitCandidates ?? []).filter((s) => !domPos.has(s.pos))
      if (extra.length) notes.push(`${where}: ${extra.length} line start(s) inside a token only Pretext finds, at ${extra.map((s) => s.pos).join(", ")}`)
    }
    console.log(`${problems.length === 0 ? "  ✓" : "  ✗"} ${label}: ${compared} blocks, ${problems.length} disagreement(s)`)
    for (const line of problems) console.log(`      ✗ ${line}`)
    for (const line of notes) console.log(`      · ${line}`)
    failures += problems.length
  }

  console.log("— seed document")
  await report("seed")

  console.log("— stress blocks")
  await page.evaluate(() => {
    const { view } = window.__pager
    const { schema } = view.state
    const t = (s, ...marks) => schema.text(s, marks)
    const strong = schema.marks.strong.create()
    const em = schema.marks.em.create()
    const size = (px) => schema.marks.fontSize.create({ size: px })
    const p = (attrs, ...content) => schema.nodes.paragraph.create(attrs, content)
    const br = () => schema.nodes.hard_break.create()
    const h = (level, ...content) => schema.nodes.heading.create({ level }, content)
    const long = "Pneumonoultramicroscopicsilicovolcanoconiosis".repeat(3)
    const blocks = [
      p(null, t(`A word longer than the column: ${long} and then ordinary words continue after it for a while.`)),
      p(null, t("Order available at https://example.org/orders/2026/11/a-very-long-path-segment-without-any-spaces-at-all/final.pdf for reference.")),
      p(null, t("First line"), br(), t("second line after a hard break"), br(), br(), t("after an empty line")),
      p(null, t("Ends with a hard break"), br()),
      p(null),
      p(null, t("Normal text, then "), t("much larger text", size(28)), t(" back to normal, and "), t("tiny", size(10)), t(" text that keeps wrapping across several lines so the taller line sits in the middle of the paragraph rather than at its start or end.")),
      p(null, t("Bold ", strong), t("and italic ", em), t("and both together ", strong, em), t("mixed into one long sentence that has to wrap at least twice in the column so that each style lands at a line edge somewhere.".repeat(2))),
      h(1, t("A heading with "), t("emphasis", em), t(" that is long enough to wrap onto a second line in the column")),
      h(3, t("Strong inside a semibold heading", strong)),
      p({ align: "justify" }, t("Justified text stretches the spaces on every line but the last, and it should not change where any line breaks, which is exactly what this paragraph checks against the browser. ".repeat(3))),
      p(null, t("Spaces   kept   by   pre-wrap,    several   in   a   row,   between   words   that   wrap   across   the   column   edge   more   than   once   here.")),
    ]
    const tr = view.state.tr.insert(view.state.doc.content.size, blocks)
    view.dispatch(tr)
  })
  await sleep(600)
  await report("seed + stress blocks")

  console.log("— Indic and mixed-script blocks")
  await page.evaluate((samples) => {
    const { view } = window.__pager
    const { schema } = view.state
    const t = (s, ...marks) => schema.text(s, marks)
    const strong = schema.marks.strong.create()
    const em = schema.marks.em.create()
    const size = (px) => schema.marks.fontSize.create({ size: px })
    const p = (attrs, ...content) => schema.nodes.paragraph.create(attrs, content)
    const br = () => schema.nodes.hard_break.create()
    const h = (level, ...content) => schema.nodes.heading.create({ level }, content)
    const [hi1, hi2] = samples.hi
    const [ml1] = samples.ml
    const [ta1] = samples.ta
    const blocks = [
      ...Object.values(samples).flat().map((text) => p(null, t(text))),
      h(1, t("उच्च न्यायालय, दिल्ली — रिट याचिका (सिविल) संख्या 4821/2025 में आदेश")),
      h(2, t("ഹൈക്കോടതി ഉത്തരവ് "), t("(കേരളം)", em)),
      h(3, t("சென்னை உயர் நீதிமன்றம்", strong)),
      p(null, t(hi1.slice(0, 60), strong), t(hi1.slice(60, 140)), t(hi1.slice(140), em)),
      p(null, t(hi2.slice(0, 50)), t(hi2.slice(50, 90), size(26)), t(hi2.slice(90))),
      p(null, t(ml1.slice(0, 80)), br(), t(ml1.slice(80)), br(), br(), t(ta1)),
      p({ align: "justify" }, t(hi1 + " " + hi2)),
    ]
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, blocks))
  }, INDIC)
  await sleep(600)
  await report("seed + stress + Indic blocks")

  const check = (ok, label, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`)
    if (!ok) failures++
  }
  // Web fonts load when text first uses them; wait for them, and for the
  // full re-measure their loading triggers.
  const open = async (query) => {
    await page.goto(`http://localhost:4180/${query}`, { waitUntil: "networkidle0" })
    await page.evaluate(() => Promise.all([document.fonts.load('16px "Kruti Dev"'), document.fonts.load("16px Gayathri", "മ")]))
    await sleep(1200)
  }
  const editorFont = () => page.evaluate(() => getComputedStyle(window.__pager.view.dom).fontFamily)
  const fontSelect = () => page.evaluate(() => document.querySelector(".font-select").value)
  /** Puts the cursor (or a selection to `to`) at document positions, then lets the toolbar sync. */
  const select = (from, to = from) =>
    page.evaluate(([from, to]) => {
      const { view } = window.__pager
      const sel = view.state.selection.constructor.create(view.state.doc, from, to)
      view.dispatch(view.state.tr.setSelection(sel))
      view.focus()
    }, [from, to])
  /** The position at the end of the nth top-level paragraph. */
  const endOfParagraph = (nth) =>
    page.evaluate((nth) => {
      let k = 0, at = null
      window.__pager.view.state.doc.forEach((node, offset) => {
        if (node.type.name === "paragraph" && k++ === nth) at = offset + node.nodeSize - 1
      })
      return at
    }, nth)
  /** Start and end of the first text run with (or without) a fontFamily mark, at least 4 characters. */
  const run = (marked) =>
    page.evaluate((marked) => {
      let at = null
      window.__pager.view.state.doc.descendants((n, pos) => {
        if (at === null && n.isText && n.text.trim().length > 3 && n.marks.some((m) => m.type.name === "fontFamily") === marked) at = [pos, pos + n.nodeSize]
      })
      return at
    }, marked)

  console.log("— switching to a web font from the language menu")
  // First of the Kruti Dev stages, so the font is not in the browser yet.
  // The first pass after the switch runs before Kruti Dev has loaded, so it
  // measures in the fallback font; the full pass the font load triggers must
  // drop those widths and line boxes. A direct ?lang=hi load is the reference.

  await page.goto("http://localhost:4180/", { waitUntil: "networkidle0" })
  await sleep(800)
  await page.select('select[title="Document language"]', "hi")
  await page.evaluate(() => document.fonts.load('16px "Kruti Dev"'))
  await sleep(1200)
  const switched = await page.evaluate(() => ({
    breaks: window.__pager.layout.breaks.map((b) => b.pos),
    full: window.__pager.reflows.some((r) => r.fullRecompute),
  }))
  check(switched.full, "a font load runs a full re-measure")
  await report("Kruti Dev via the language menu")
  await open("?lang=hi")
  const directHi = await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos))
  check(JSON.stringify(switched.breaks) === JSON.stringify(directHi), "same page breaks as loading ?lang=hi directly", `menu ${JSON.stringify(switched.breaks)} direct ${JSON.stringify(directHi)}`)


  console.log("— Hindi seed in Kruti Dev")
  await open("?lang=hi")
  const family = await editorFont()
  check(/^"?Kruti Dev"?,/.test(family), "the document's font is Kruti Dev (doc attr)", family)
  await report("Kruti Dev seed")

  console.log("— print preview of the Kruti Dev document")
  // Approach C renders the document's pages in an iframe: it must use the
  // document's font (and Georgia for the Latin runs), hold exactly the
  // layout's pages with the text between the editor's breaks, and keep
  // every line inside its sheet's writable area.
  await page.$eval(".preview-c", (el) => el.click())
  await page.waitForSelector("#print-modal:not(.pm-loading)")
  const print = await page.evaluate(async () => {
    const { view, layout } = window.__pager
    const doc = view.state.doc
    const frame = document.querySelector(".pm-frame").contentDocument
    await frame.fonts.ready
    const sheets = [...frame.querySelectorAll(".sheet")]
    const bounds = [0, ...layout.breaks.map((b) => b.pos), doc.content.size]
    const fonts = [...frame.fonts].map((f) => `${f.family}:${f.status}`)
    const textMismatch = []
    const outside = []
    sheets.forEach((sheet, k) => {
      const blocks = [...sheet.children].filter((el) => !el.classList.contains("page-num"))
      const printed = blocks.map((el) => el.textContent).join("")
      const expected = doc.textBetween(bounds[k], bounds[k + 1], "", "")
      if (printed !== expected) textMismatch.push(k)
      const cs = getComputedStyle(sheet)
      const r = sheet.getBoundingClientRect()
      const top = r.top + parseFloat(cs.paddingTop)
      const bottom = r.bottom - parseFloat(cs.paddingBottom)
      const walker = frame.createTreeWalker(sheet, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest(".page-num") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      })
      const range = frame.createRange()
      while (walker.nextNode()) {
        range.selectNodeContents(walker.currentNode)
        for (const rr of range.getClientRects()) {
          if (rr.height > 0 && (rr.top < top - 0.5 || rr.bottom > bottom + 0.5)) outside.push(`sheet ${k + 1}: ${walker.currentNode.data.slice(0, 20)}`)
        }
      }
    })
    const latin = frame.querySelector('.sheet span[style*="Georgia"]')
    return {
      sheets: sheets.length,
      pages: layout.pages.length,
      family: getComputedStyle(sheets[0]).fontFamily,
      latinFamily: latin ? getComputedStyle(latin).fontFamily : null,
      fonts,
      textMismatch,
      outside,
    }
  })
  check(print.sheets === print.pages, "one printed sheet per layout page", `${print.sheets} sheets, ${print.pages} pages`)
  check(/^"?Kruti Dev"?,/.test(print.family), "the print document is in Kruti Dev", print.family)
  check(print.fonts.some((f) => /Kruti Dev:loaded/.test(f)), "Kruti Dev is loaded in the print document", print.fonts.join(" "))
  check(print.latinFamily != null && /^Georgia,/.test(print.latinFamily), "a Latin run prints in Georgia", print.latinFamily ?? "no Latin run")
  check(print.textMismatch.length === 0, "every sheet holds the text between the editor's breaks", `mismatch on sheets ${print.textMismatch.join(", ")}`)
  check(print.outside.length === 0, "every printed line sits inside its sheet's writable area", print.outside.slice(0, 3).join("; "))
  await page.keyboard.press("Escape")

  console.log("— font dropdown")
  const latin = await run(true)
  const krutiRun = await run(false)
  await select(krutiRun[0] + 1)
  check((await fontSelect()) === "kruti", "cursor in Kruti Dev text reads Kruti Dev", await fontSelect())
  await select(latin[0] + 1)
  check((await fontSelect()) === "georgia", "cursor in an English run reads Georgia", await fontSelect())
  await select(Math.min(krutiRun[0], latin[0]), Math.max(krutiRun[1], latin[1]))
  check((await fontSelect()) === "mixed", "a selection over both reads Mixed fonts", await fontSelect())

  console.log("— typing in Kruti Dev")
  // A Kruti Dev user types ASCII on a Kruti keyboard layout ("fd" is कि),
  // plus a few non-ASCII keys (Ã, ¡, ±). Type a seed paragraph's own text,
  // keystroke by keystroke and fast, into a new paragraph mid-document.
  const typed = await page.evaluate(() => {
    let source = ""
    window.__pager.view.state.doc.descendants((n) => {
      if (n.isText && !n.marks.length && source.length < 400) source += n.text
    })
    return source.slice(0, 400)
  })
  check(typed.length === 400, "found 400 characters of Kruti Dev text to type", `${typed.length}`)
  check(await page.evaluate(() => window.__pager.view.dom.getAttribute("spellcheck") === "false"), "spellcheck is off in a Kruti Dev document")
  await select(await endOfParagraph(8))
  await page.keyboard.press("Enter")
  await page.keyboard.type(typed)
  const typedFamily = await page.evaluate((text) => {
    const p = [...document.querySelectorAll(".ProseMirror > p")].find((el) => el.textContent.startsWith(text.slice(0, 40)))
    if (!p) return null
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    const first = walker.nextNode()
    return `${getComputedStyle(first.parentElement).fontFamily} | ${p.textContent.length}/${text.length} chars`
  }, typed)
  check(/^"?Kruti Dev"?,/.test(typedFamily ?? ""), "the typed paragraph renders in Kruti Dev", typedFamily ?? "paragraph not found")
  // Typing on from an English run stays English (the mark is inclusive, as
  // in a word processor); choosing Kruti Dev in the dropdown switches.
  const latinNow = await run(true)
  await select(latinNow[1])
  await page.keyboard.type("on ")
  await page.select(".font-select", "kruti")
  await page.keyboard.type("dk;Z ")
  await sleep(600)
  const runs = await page.evaluate(() => {
    const out = {}
    window.__pager.view.state.doc.descendants((n) => {
      if (n.isText) for (const t of ["on ", "dk;Z "]) if (n.text.includes(t) && !(t in out)) out[t] = n.marks.some((m) => m.type.name === "fontFamily")
    })
    return out
  })
  check(runs["on "] === true, "typing on from an English run stays Georgia", JSON.stringify(runs))
  check(runs["dk;Z "] === false, "after choosing Kruti Dev in the dropdown, typing is Kruti Dev", JSON.stringify(runs))
  check((await fontSelect()) === "kruti", "the dropdown reads Kruti Dev while typing it", await fontSelect())
  await report("after typing in Kruti Dev")

  console.log("— English mixed with Kruti Dev")
  await open("?lang=mixed")
  check(/^Georgia,/.test(await editorFont()), "the document's font is Georgia", await editorFont())
  const krutiInMixed = await page.evaluate(() => {
    let n = 0
    window.__pager.view.state.doc.descendants((t) => {
      if (t.isText && t.marks.some((m) => m.type.name === "fontFamily" && /Kruti Dev/.test(m.attrs.family))) n++
    })
    return n
  })
  check(krutiInMixed > 20, "Hindi runs carry the Kruti Dev mark", `${krutiInMixed} runs`)
  await report("mixed English + Kruti Dev")
  // Choose Kruti Dev on an empty paragraph in the English document and type.
  await select(await endOfParagraph(5))
  await page.keyboard.press("Enter")
  await page.select(".font-select", "kruti")
  await page.keyboard.type(typed.slice(0, 200))
  await page.select(".font-select", "georgia")
  await page.keyboard.type(" and back to English")
  await sleep(600)
  const mixedTyping = await page.evaluate(() => {
    const out = {}
    window.__pager.view.state.doc.descendants((n) => {
      if (n.isText && n.text.includes(" and back to English")) out.english = n.marks.map((m) => m.type.name)
      if (n.isText && n.text.length >= 150 && n.marks.some((m) => /Kruti Dev/.test(m.attrs.family ?? ""))) out.kruti = (out.kruti ?? 0) + 1
    })
    return out
  })
  check(mixedTyping.kruti >= 1 && !(mixedTyping.english ?? ["?"]).includes("fontFamily"), "switching fonts while typing in an English document", JSON.stringify(mixedTyping))
  await report("mixed, after typing")

  console.log("— Malayalam in Gayathri")
  await open("?lang=ml")
  check(/^"?Gayathri"?,/.test(await editorFont()), "the document's font is Gayathri", await editorFont())
  check(await page.evaluate(() => document.fonts.check("16px Gayathri", "മ")), "Gayathri has loaded")
  await report("Malayalam in Gayathri")

  console.log("— Page margins")
  // For each preset and a lopsided custom set: the geometry follows the
  // margins, the editor's column is the geometry's, every gap widget is
  // band + push tall and lands the next page at its layout start, the
  // sheets are painted there, and no line of text sits outside a page's
  // writable area. Then undo returns to 1in margins.
  const MARGINS = [
    ["narrow", { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 }],
    ["moderate", { top: 1, right: 0.75, bottom: 1, left: 0.75 }],
    ["wide", { top: 1, right: 2, bottom: 1, left: 2 }],
    ["edit", { top: 0.6, right: 0.5, bottom: 1.4, left: 1.25 }],
  ]
  for (const lang of ["", "?lang=hi", "?lang=mixed", "?lang=ml", "?lang=table", "?lang=list"]) {
    await open(lang)
    for (const [preset, m] of MARGINS) {
      await page.select(".margins-select", preset)
      if (preset === "edit") {
        for (const side of ["top", "right", "bottom", "left"]) {
          await page.$eval(`.margins-pop input[name=${side}]`, (el, v) => (el.value = String(v)), m[side])
        }
        await page.click(".margins-pop button[type=submit]")
      }
      await sleep(400)
      const errs = await page.evaluate((m) => {
        const { view: v, layout, geometry: g } = window.__pager
        const stack = v.dom.parentElement
        const out = []
        if (["top", "right", "bottom", "left"].some((side) => Math.abs(g[side] - m[side] * 96) > 0.01)) out.push(`geometry ${JSON.stringify(g)}`)
        const { contentH } = g
        const cs = getComputedStyle(v.dom)
        const col = v.dom.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        if (Math.abs(col - g.contentW) > 0.01) out.push(`column ${col}`)
        const starts = layout.pages.map((p) => p.start)
        const painted = stack.style.backgroundPosition.split(",").map((p) => parseFloat(p.trim().split(" ")[1]))
        if (painted.join() !== starts.join()) out.push(`sheets painted at ${painted.join()}`)
        const origin = v.dom.getBoundingClientRect().top
        const gaps = [...v.dom.querySelectorAll(".page-gap")].sort((a, b) => a.dataset.page - b.dataset.page)
        if (gaps.length !== layout.breaks.length) out.push(`${gaps.length} gaps for ${layout.breaks.length} breaks`)
        gaps.forEach((gap, k) => {
          const r = gap.getBoundingClientRect()
          if (Math.abs(r.height - (g.band + layout.breaks[k].remaining)) > 0.5) out.push(`gap ${k} is ${r.height}px`)
          if (Math.abs(r.bottom - origin - starts[k + 1]) > 0.5) out.push(`page ${k + 2} lands at ${r.bottom - origin}, not ${starts[k + 1]}`)
        })
        const range = document.createRange()
        const walker = document.createTreeWalker(v.dom, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => (n.parentElement.closest(".page-gap") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
        })
        let outside = 0
        while (walker.nextNode()) {
          range.selectNodeContents(walker.currentNode)
          for (const r of range.getClientRects()) {
            if (r.height === 0) continue
            const k = starts.findLastIndex((s) => s <= r.top - origin + 0.5)
            if (k < 0 || r.bottom - origin > starts[k] + contentH + 0.5) outside++
          }
        }
        if (outside) out.push(`${outside} text rects outside a page`)
        return out
      }, m)
      check(errs.length === 0, `${lang || "English"} margins ${preset === "edit" ? "custom" : preset}`, errs.slice(0, 4).join("; "))
    }
    await page.focus(".ProseMirror")
    for (let i = 0; i < MARGINS.length; i++) {
      await page.keyboard.down("Meta")
      await page.keyboard.press("z")
      await page.keyboard.up("Meta")
    }
    await sleep(400)
    const back = await page.evaluate(() => ({
      margins: window.__pager.view.state.doc.attrs.margins,
      select: document.querySelector(".margins-select").value,
      padding: getComputedStyle(window.__pager.view.dom).paddingLeft,
    }))
    check(back.margins.top === 1 && back.margins.left === 1 && back.select === "normal" && back.padding === "96px", `${lang || "English"} undo restores 1in margins`, JSON.stringify(back))
  }

  // Tables paginate row by row. Every row's Pretext height (each cell's
  // blocks at its column's width) must match its <tr>, every page must
  // open at a row or block boundary with the row whole on one page, and
  // the gap between two rows must be a row of the table landing the next
  // row exactly on the next page's content start.
  const tableLayout = async (label) => {
    const r = await page.evaluate(() => {
      const { view, layout, geometry } = window.__pager
      const { rows } = window.__pager.compareWithDom()
      const origin = view.dom.getBoundingClientRect().top
      const starts = layout.pages.map((p) => p.start)
      const out = []
      let worst = 0
      for (const row of rows) worst = Math.max(worst, Math.abs(row.dom - row.pretext))
      for (const tr of view.dom.querySelectorAll("tr:not(.page-gap)")) {
        const b = tr.getBoundingClientRect()
        const k = starts.findLastIndex((s) => s <= b.top - origin + 0.5)
        if (k < 0 || b.bottom - origin > starts[k] + geometry.contentH + 0.5) out.push(`row "${tr.textContent.slice(0, 20)}" crosses a page edge`)
        if (tr.querySelector(".page-gap")) out.push(`a gap inside row "${tr.textContent.slice(0, 20)}"`)
      }
      let between = 0
      layout.breaks.forEach((br, i) => {
        const parent = view.state.doc.resolve(br.pos).parent
        const gap = view.dom.querySelector(`.page-gap[data-page="${i}"]`)
        if (!gap) return void out.push(`gap ${i} missing`)
        if (Math.abs(gap.getBoundingClientRect().bottom - origin - starts[i + 1]) > 0.5) out.push(`gap ${i} lands ${gap.getBoundingClientRect().bottom - origin}, page starts ${starts[i + 1]}`)
        if (parent.type.name !== "table") return
        between++
        if (gap.tagName !== "TR" || gap.parentElement.tagName !== "TBODY") out.push(`gap ${i} is a ${gap.tagName} in a ${gap.parentElement.tagName}`)
        if (gap.nextElementSibling !== view.nodeDOM(br.pos)) out.push(`gap ${i} is not right before its row`)
      })
      return { rows: rows.length, worst, between, out }
    })
    check(r.rows > 0 && r.worst < 0.5, `${label}: ${r.rows} rows, Pretext row heights match the DOM`, `worst ${r.worst.toFixed(2)}px`)
    check(r.between > 0, `${label}: ${r.between} page break(s) between table rows`)
    check(r.out.length === 0, `${label}: rows whole on their page, gaps land the next row on its page`, r.out.slice(0, 4).join("; "))
  }

  console.log("— Tables")
  await open("?lang=table")
  await report("tables")
  await tableLayout("table document")

  // Grow the last row on the first page that ends inside a table until it
  // no longer fits: the row moves whole to the next page.
  const lastRowBefore = await page.evaluate(() => {
    const { view, layout } = window.__pager
    const k = layout.breaks.findIndex((b) => view.state.doc.resolve(b.pos).parent.type.name === "table")
    const tr = view.dom.querySelector(`.page-gap[data-page="${k}"]`).previousElementSibling
    const cell = tr.lastElementChild.querySelector("p")
    const pos = view.posAtDOM(cell, cell.childNodes.length)
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, pos)))
    view.focus()
    return { k, pos: view.posAtDOM(tr, 0) - 1, breaks: layout.breaks.map((b) => b.pos) }
  })
  await page.keyboard.type(" and more words typed into a cell, enough to make its row taller than the room left on the page.".repeat(2))
  await sleep(600)
  const moved = await page.evaluate((k) => window.__pager.layout.breaks[k].pos, lastRowBefore.k)
  check(moved !== lastRowBefore.breaks[lastRowBefore.k], "typing into the last row on a page moves the break above that row", `${lastRowBefore.breaks[lastRowBefore.k]} → ${moved}`)
  await tableLayout("after typing into a cell")

  await page.select(".margins-select", "narrow")
  await sleep(400)
  await tableLayout("narrow margins")
  await page.select(".margins-select", "wide")
  await sleep(400)
  await tableLayout("wide margins")

  console.log("— print preview of the table document")
  await open("?lang=table")
  await page.$eval(".preview-c", (el) => el.click())
  await page.waitForSelector("#print-modal:not(.pm-loading)")
  const printed = await page.evaluate(async () => {
    const { view, layout } = window.__pager
    const frame = document.querySelector(".pm-frame").contentDocument
    await frame.fonts.ready
    const sheets = [...frame.querySelectorAll(".sheet")]
    const bounds = [0, ...layout.breaks.map((b) => b.pos), view.state.doc.content.size]
    const mismatch = []
    const outside = []
    const rowsDiffer = []
    const live = [...view.dom.querySelectorAll("tr:not(.page-gap)")].map((tr) => tr.getBoundingClientRect().height)
    const print = [...frame.querySelectorAll("tr")].map((tr) => tr.getBoundingClientRect().height)
    live.forEach((h, i) => Math.abs(h - print[i]) > 0.5 && rowsDiffer.push(i))
    sheets.forEach((sheet, k) => {
      const text = [...sheet.children].filter((el) => !el.classList.contains("page-num")).map((el) => el.textContent).join("")
      if (text !== view.state.doc.textBetween(bounds[k], bounds[k + 1], "", "")) mismatch.push(k + 1)
      const cs = getComputedStyle(sheet)
      const r = sheet.getBoundingClientRect()
      const bottom = r.bottom - parseFloat(cs.paddingBottom)
      for (const tr of sheet.querySelectorAll("tr")) if (tr.getBoundingClientRect().bottom > bottom + 0.5) outside.push(`sheet ${k + 1}: ${tr.textContent.slice(0, 20)}`)
    })
    return { sheets: sheets.length, pages: layout.pages.length, tables: frame.querySelectorAll("table").length, mismatch, outside, rowsDiffer, rows: print.length }
  })
  await page.keyboard.press("Escape")
  check(printed.sheets === printed.pages, "one printed sheet per layout page", `${printed.sheets} sheets, ${printed.pages} pages`)
  check(printed.mismatch.length === 0, "every sheet holds the text between the editor's breaks", `mismatch on sheets ${printed.mismatch.join(", ")}`)
  check(printed.outside.length === 0, "every printed row sits inside its sheet's writable area", printed.outside.slice(0, 3).join("; "))
  check(printed.rowsDiffer.length === 0, `${printed.rows} printed rows as tall as on screen, in ${printed.tables} printed table pieces`, `rows ${printed.rowsDiffer.slice(0, 5).join(", ")}`)

  console.log("— a table in the Kruti Dev document, from the toolbar")
  await open("?lang=hi")
  const krutiText = await page.evaluate(() => {
    let s = ""
    window.__pager.view.state.doc.descendants((n) => {
      if (n.isText && !n.marks.length && s.length < 300) s += n.text
    })
    return s
  })
  await select(await endOfParagraph(6))
  await page.click(".insert-table")
  for (let i = 0; i < 9; i++) {
    await page.keyboard.type(krutiText.slice(i * 25, i * 25 + 12 + ((i * 37) % 80)))
    await page.keyboard.press("Tab")
  }
  await sleep(600)
  const inserted = await page.evaluate(() => {
    let rows = 0, header = 0
    window.__pager.view.state.doc.descendants((n) => {
      if (n.type.name === "tableRow") rows++
      if (n.type.name === "tableHeader") header++
    })
    return { rows, header }
  })
  check(inserted.rows === 3 && inserted.header === 3, "the toolbar inserts a 3 × 3 table with a header row", JSON.stringify(inserted))
  await report("Kruti Dev table")
  // Push the table down to a page edge with empty paragraphs above it.
  await select(await endOfParagraph(5))
  for (let i = 0; i < 40; i++) {
    const brk = await page.evaluate(() => window.__pager.layout.breaks.some((b) => window.__pager.view.state.doc.resolve(b.pos).parent.type.name === "table"))
    if (brk) break
    await page.keyboard.press("Enter")
    await sleep(30)
  }
  await sleep(400)
  await tableLayout("Kruti Dev table at a page edge")

  // Lists: every paragraph of every item is measured at its level's width
  // (the column less LIST.indent per level) and splits at line boundaries,
  // so the report above must find 0 disagreements at every level; every gap
  // must land the next page's first line, and no line may leave its page.
  const listLayout = async (label) => {
    const r = await page.evaluate(() => {
      const { view, layout, geometry } = window.__pager
      const origin = view.dom.getBoundingClientRect().top
      const starts = layout.pages.map((p) => p.start)
      const out = []
      const levels = {}
      for (const p of view.dom.querySelectorAll("li p")) {
        let n = 0
        for (let el = p; el !== view.dom; el = el.parentElement) if (el.tagName === "UL" || el.tagName === "OL") n++
        levels[n] = (levels[n] ?? 0) + 1
      }
      layout.breaks.forEach((b, i) => {
        const gap = view.dom.querySelector(`.page-gap[data-page="${i}"]`)
        if (!gap) return void out.push(`gap ${i} missing`)
        const d = gap.getBoundingClientRect().bottom - origin - starts[i + 1]
        if (Math.abs(d) > 0.5) out.push(`gap ${i} off by ${d.toFixed(2)}`)
      })
      const range = document.createRange()
      const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest(".page-gap") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      })
      while (walker.nextNode()) {
        range.selectNodeContents(walker.currentNode)
        for (const rr of range.getClientRects()) {
          if (rr.height === 0) continue
          const k = starts.findLastIndex((s) => s <= rr.top - origin + 0.5)
          if (k < 0 || rr.bottom - origin > starts[k] + geometry.contentH + 0.5) out.push(`text outside a page: ${walker.currentNode.data.slice(0, 20)}`)
        }
      }
      // Breaks inside a paragraph, by how many lists enclose it.
      const splits = {}
      for (const b of layout.breaks) {
        const $p = view.state.doc.resolve(b.pos)
        if ($p.parent.type.name !== "paragraph") continue
        let n = 0
        for (let d = 1; d <= $p.depth; d++) if (/List$/.test($p.node(d).type.name)) n++
        splits[n] = (splits[n] ?? 0) + 1
      }
      return { levels, splits, breaks: layout.breaks.map((b) => b.pos), out }
    })
    check(r.out.length === 0, `${label}: gaps land on the next page, no line leaves its page`, r.out.slice(0, 4).join("; "))
    return r
  }
  const rerun = async () => {
    const before = await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos))
    await page.evaluate(() => document.querySelector(".panel-buttons button").click())
    await sleep(500)
    const after = await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos))
    return { before, after, same: JSON.stringify(before) === JSON.stringify(after) }
  }

  console.log("— Nested lists")
  await open("?lang=list")
  await report("nested lists")
  const listed = await listLayout("nested lists")
  check(Object.keys(listed.levels).length >= 4, "list paragraphs at every level, 1 to 4", JSON.stringify(listed.levels))
  check(Object.keys(listed.splits).some((n) => n >= 3), "a paragraph three or more levels deep splits across a page edge", `inline breaks by level ${JSON.stringify(listed.splits)}`)
  for (const preset of ["narrow", "moderate", "wide"]) {
    await page.select(".margins-select", preset)
    await sleep(400)
    await report(`nested lists, ${preset} margins`)
    await listLayout(`nested lists, ${preset} margins`)
  }
  await page.select(".margins-select", "normal")
  await sleep(400)

  // Type at the end of the deepest paragraph that straddles a page edge.
  const deepSplit = await page.evaluate(() => {
    const { view, layout } = window.__pager
    let best = null
    for (const b of layout.breaks) {
      const $p = view.state.doc.resolve(b.pos)
      if ($p.parent.type.name !== "paragraph") continue
      if (!best || $p.depth > best.depth) best = { depth: $p.depth, end: $p.end() }
    }
    return best
  })
  await select(deepSplit.end)
  await page.keyboard.type(" Typed into a nested item that straddles a page edge, long enough to carry another line or two onto the next page.")
  await sleep(600)
  await report("after typing into a nested item")
  await listLayout("after typing into a nested item")
  const typedRerun = await rerun()
  check(typedRerun.same, "after typing into a nested item, the breaks match a full re-run", JSON.stringify(typedRerun))

  // Tab sinks an item a level, Shift-Tab lifts it back.
  const sinkable = await page.evaluate(() => {
    let at = null
    window.__pager.view.state.doc.descendants((n, pos, parent, index) => {
      if (at === null && n.type.name === "listItem" && index > 0 && n.firstChild.textContent.length > 200) at = pos + 2
    })
    return at
  })
  const original = await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos))
  await select(sinkable)
  await page.keyboard.press("Tab")
  await sleep(500)
  const sunk = await page.evaluate((at) => {
    const $p = window.__pager.view.state.doc.resolve(at)
    let n = 0
    for (let d = 1; d <= $p.depth; d++) if (/List$/.test($p.node(d).type.name)) n++
    return n
  }, sinkable)
  check(sunk >= 2, "Tab sinks the item a level", `${sunk} lists around it`)
  await report("after Tab")
  await listLayout("after Tab")
  check((await rerun()).same, "after Tab, the breaks match a full re-run")
  await page.keyboard.down("Shift")
  await page.keyboard.press("Tab")
  await page.keyboard.up("Shift")
  await sleep(500)
  await report("after Shift-Tab")
  await listLayout("after Shift-Tab")
  const lifted = await page.evaluate(() => window.__pager.layout.breaks.map((b) => b.pos))
  check(JSON.stringify(lifted) === JSON.stringify(original), "Shift-Tab restores the original breaks", `${JSON.stringify(original)} → ${JSON.stringify(lifted)}`)

  console.log("— print preview of the nested lists")
  await open("?lang=list")
  await page.$eval(".preview-c", (el) => el.click())
  await page.waitForSelector("#print-modal:not(.pm-loading)")
  const printedList = await page.evaluate(async () => {
    const { view, layout } = window.__pager
    const frame = document.querySelector(".pm-frame").contentDocument
    await frame.fonts.ready
    const sheets = [...frame.querySelectorAll(".sheet")]
    const bounds = [0, ...layout.breaks.map((b) => b.pos), view.state.doc.content.size]
    const depth = (el, root) => {
      let n = 0
      for (; el && el !== root; el = el.parentElement) if (el.tagName === "UL" || el.tagName === "OL") n++
      return n
    }
    // Item numbers in document order: on screen every numbered item; in
    // print every item but the continuation of one cut in two.
    const number = (li) => li.parentElement.start + [...li.parentElement.children].filter((c) => c.tagName === "LI").indexOf(li)
    const screenNumbers = [...view.dom.querySelectorAll("ol > li")].map(number)
    const printNumbers = [...frame.querySelectorAll(".sheet ol > li:not(.li-continued)")].map(number)
    const wrongNumber = screenNumbers.flatMap((n, i) => (printNumbers[i] === n ? [] : [`item ${i}: printed ${printNumbers[i]}, on screen ${n}`]))
    // Paragraph nesting levels in document order; a paragraph split across
    // pages prints once per page.
    const screenDepths = [...view.dom.querySelectorAll("p")].flatMap((p) => Array(1 + p.querySelectorAll(".page-gap").length).fill(depth(p, view.dom)))
    const printDepths = [...frame.querySelectorAll(".sheet p")].map((p) => depth(p, p.closest(".sheet")))
    const wrongDepth = screenDepths.flatMap((d, i) => (printDepths[i] === d ? [] : [`paragraph ${i}: printed ${printDepths[i]} deep, on screen ${d}`]))
    if (screenNumbers.length !== printNumbers.length) wrongNumber.push(`${printNumbers.length} printed numbers, ${screenNumbers.length} on screen`)
    if (screenDepths.length !== printDepths.length) wrongDepth.push(`${printDepths.length} printed paragraphs, ${screenDepths.length} on screen`)
    const continuedItems = frame.querySelectorAll(".li-continued").length
    const numbered = printNumbers.length
    const mismatch = [], outside = []
    sheets.forEach((sheet, k) => {
      const text = [...sheet.children].filter((el) => !el.classList.contains("page-num")).map((el) => el.textContent).join("")
      if (text !== view.state.doc.textBetween(bounds[k], bounds[k + 1], "", "")) mismatch.push(k + 1)
      const cs = getComputedStyle(sheet)
      const r = sheet.getBoundingClientRect()
      const top = r.top + parseFloat(cs.paddingTop), bottom = r.bottom - parseFloat(cs.paddingBottom)
      const walker = frame.createTreeWalker(sheet, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest(".page-num") ? 2 : 1) })
      const range = frame.createRange()
      while (walker.nextNode()) {
        range.selectNodeContents(walker.currentNode)
        for (const rr of range.getClientRects()) if (rr.height > 0 && (rr.top < top - 0.5 || rr.bottom > bottom + 0.5)) outside.push(`sheet ${k + 1}`)
      }
    })
    return { sheets: sheets.length, pages: layout.pages.length, mismatch, wrongNumber, wrongDepth, outside, numbered, continuedItems, depths: printDepths.length }
  })
  await page.keyboard.press("Escape")
  check(printedList.sheets === printedList.pages, "one printed sheet per layout page", `${printedList.sheets} sheets, ${printedList.pages} pages`)
  check(printedList.mismatch.length === 0, "every sheet holds the text between the editor's breaks", `mismatch on sheets ${printedList.mismatch.join(", ")}`)
  check(printedList.numbered > 0 && printedList.wrongNumber.length === 0, `${printedList.numbered} printed items carry their on-screen numbers, in order (${printedList.continuedItems} continued items unnumbered)`, printedList.wrongNumber.slice(0, 3).join("; "))
  check(printedList.wrongDepth.length === 0, `${printedList.depths} printed paragraphs each at its on-screen nesting level`, printedList.wrongDepth.slice(0, 3).join("; "))
  check(printedList.outside.length === 0, "every printed line sits inside its sheet's writable area", printedList.outside.slice(0, 3).join("; "))

  console.log("— the nested list in the Kruti Dev document")
  await open("?lang=hi")
  await report("Kruti Dev with a nested list")
  const krutiList = await listLayout("Kruti Dev with a nested list")
  check(Object.keys(krutiList.levels).length >= 3, "Kruti Dev list paragraphs at three levels", JSON.stringify(krutiList.levels))
  for (const preset of ["narrow", "wide"]) {
    await page.select(".margins-select", preset)
    await sleep(400)
    await report(`Kruti Dev nested list, ${preset} margins`)
    await listLayout(`Kruti Dev nested list, ${preset} margins`)
  }
} finally {
  await browser.close()
  try { process.kill(-server.pid) } catch {}
}
process.exit(failures === 0 ? 0 : 1)
