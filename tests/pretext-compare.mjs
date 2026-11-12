/**
 * Pretext vs DOM (run: npm run build && npm run pretext-compare) — measures
 * every paragraph and heading both ways in a real browser and fails on any
 * block whose height (to 0.5px) or split candidates differ.
 *
 * Runs on the seed document, then again after appending blocks that stress
 * the line model: long unbreakable words, a URL, hard breaks (including a
 * trailing one), an empty paragraph, mixed font sizes on one line, marks in
 * headings, and justified text.
 *
 * Requires google-chrome on PATH (or CHROME=/path/to/chrome) and a build.
 */
import { spawn } from "node:child_process"
import puppeteer from "puppeteer-core"

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

  // Fails on a height off by 0.5px or more, or a DOM split candidate Pretext
  // doesn't have. Two differences are expected and only listed, as the DOM
  // path (measure.ts) is the inexact side:
  //  - extra Pretext candidates: lines that start inside a whitespace-free
  //    token (after a hyphen, or a long word or URL broken mid-way), which
  //    the DOM path's /\S+/ word grouping never sees as a line start;
  //  - a candidate set lower by Pretext on a line with a larger font: the
  //    DOM path assumes every line has the first line's half-leading.
  const report = async (label) => {
    const { compared, diffs } = await page.evaluate(() => window.__pager.compareWithDom())
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
      for (const s of dom) {
        if (!pt.has(s.pos)) problems.push(`${where}: DOM line start at ${s.pos} (top ${s.height}px) missing from Pretext`)
        else if (pt.get(s.pos) - s.height >= 0.5) notes.push(`${where}: line at ${s.pos} sits ${(pt.get(s.pos) - s.height).toFixed(1)}px lower (larger font on the line)`)
        else if (Math.abs(pt.get(s.pos) - s.height) >= 0.5) problems.push(`${where}: line at ${s.pos} top dom ${s.height} / pretext ${pt.get(s.pos)}`)
      }
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
} finally {
  await browser.close()
  try { process.kill(-server.pid) } catch {}
}
process.exit(failures === 0 ? 0 : 1)
