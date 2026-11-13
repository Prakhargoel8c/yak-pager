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
      document.getElementById("paper").append(host)
      for (const d of result.diffs) {
        const pretext = new Map((d.pretext.splitCandidates ?? []).map((s) => [s.pos, s.height]))
        d.truth = {}
        for (const s of d.dom.splitCandidates ?? []) {
          if (!pretext.has(s.pos) || Math.abs(pretext.get(s.pos) - s.height) < 0.5) continue
          const clone = view.nodeDOM(d.offset).cloneNode(true)
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

  console.log("— Hindi seed in Kruti Dev")
  await page.goto("http://localhost:4180/?lang=hi", { waitUntil: "networkidle0" })
  await page.evaluate(() => document.fonts.load('16px "Kruti Dev"'))
  await sleep(1200)
  const family = await page.evaluate(() => getComputedStyle(window.__pager.view.dom).fontFamily)
  if (!family.startsWith('"Kruti Dev"')) {
    console.log(`  ✗ editor font is ${family}`)
    failures++
  }
  await report("Kruti Dev seed")

  console.log("— typing in Kruti Dev")
  // A Kruti Dev user types ASCII on a Kruti keyboard layout ("fd" is कि),
  // plus a few non-ASCII keys (Ã, ¡, ±). Type a seed paragraph's own text,
  // keystroke by keystroke and fast, into a new paragraph mid-document, then
  // more at the end of an English run.
  const typed = await page.evaluate(() => {
    const { view } = window.__pager
    let source = ""
    view.state.doc.forEach((n) => {
      if (!source && n.type.name === "paragraph" && n.textContent.length > 300 && !n.content.content.some((c) => c.marks.length)) source = n.textContent
    })
    return source.slice(0, 400)
  })
  const check = (ok, label, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`)
    if (!ok) failures++
  }
  check(
    await page.evaluate(() => window.__pager.view.dom.getAttribute("spellcheck") === "false"),
    "spellcheck is off in a Kruti Dev document"
  )
  await page.evaluate(() => {
    const { view } = window.__pager
    const p = [...view.dom.querySelectorAll(":scope > p")][8]
    const r = document.createRange()
    r.selectNodeContents(p)
    r.collapse(false)
    getSelection().removeAllRanges()
    getSelection().addRange(r)
    view.focus()
  })
  await page.keyboard.press("Enter")
  await page.keyboard.type(typed)
  // The end of an English run (a fontFamily mark): typing there is Kruti Dev.
  const runEnd = await page.evaluate(() => {
    const { view } = window.__pager
    let at = null
    view.state.doc.descendants((n, pos) => {
      if (at === null && n.isText && n.marks.some((m) => m.type.name === "fontFamily") && n.text.trim().length > 3) at = pos + n.nodeSize
    })
    const span = view.domAtPos(at)
    const r = document.createRange()
    r.setStart(span.node, span.offset)
    getSelection().removeAllRanges()
    getSelection().addRange(r)
    view.focus()
    return at
  })
  await page.keyboard.type("dk;Z ")
  await sleep(600)
  const marks = await page.evaluate(() => {
    let found = null
    window.__pager.view.state.doc.descendants((n) => {
      if (!found && n.isText && n.text.includes("dk;Z ")) found = { text: n.text.slice(0, 40), marks: n.marks.map((m) => m.type.name) }
    })
    return found ?? { text: null, marks: [] }
  })
  check(marks.text !== null && !marks.marks.includes("fontFamily"), "text typed after an English run is Kruti Dev, not Georgia", JSON.stringify(marks))
  const typedFamily = await page.evaluate((text) => {
    const p = [...document.querySelectorAll(".ProseMirror > p")].find((el) => el.textContent === text)
    return p ? getComputedStyle(p).fontFamily : null
  }, typed)
  check(typedFamily?.startsWith('"Kruti Dev"'), "the typed paragraph renders in Kruti Dev", typedFamily ?? "paragraph not found")
  await report("after typing in Kruti Dev")
} finally {
  await browser.close()
  try { process.kill(-server.pid) } catch {}
}
process.exit(failures === 0 ? 0 : 1)
