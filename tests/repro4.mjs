/**
 * Transient-state probe v2: delete the content before/after a straddling
 * paragraph's widget via a real PM transaction, then probe what measureBlock
 * would compute BEFORE the next pass runs, and compare with the layout
 * after the pass and after a forced full re-run.
 */
import { spawn } from "node:child_process"
import puppeteer from "puppeteer-core"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = spawn("npx", ["vite", "preview", "--port", "4185", "--strictPort"], {
  stdio: "ignore",
  detached: true,
})
await sleep(1500)

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-gpu"],
})
const page = await browser.newPage()
page.on("pageerror", (e) => console.log("  [pageerror]", e.message))
await page.goto("http://localhost:4185/", { waitUntil: "networkidle0" })
await sleep(1200)

const MEASURE_FN = `
function measureP(p) {
  const rect = p.getBoundingClientRect()
  const ws = [...p.querySelectorAll('.page-gap')]
  // Same rule as the fixed measureBlock: a widget rect that overhangs the
  // block's rect was never part of the block's height, so it is not
  // subtracted either.
  const wr = ws
    .map((w) => w.getBoundingClientRect())
    .filter((r) => r.bottom <= rect.bottom + 1)
  let height = rect.height - wr.reduce((a, r) => a + r.height, 0)
  const words = []
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement && n.parentElement.closest('.page-gap')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  let t
  while ((t = walker.nextNode())) {
    const s = t.nodeValue || ''
    const re = /\\S+/g
    let m
    while ((m = re.exec(s))) {
      const r = document.createRange()
      r.setStart(t, m.index)
      r.setEnd(t, m.index + m[0].length)
      words.push({ rect: r.getBoundingClientRect() })
    }
  }
  words.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
  const lines = []
  for (const w of words) {
    const cur = lines[lines.length - 1]
    if (cur) {
      const top = Math.min(...cur.map((x) => x.rect.top))
      const bottom = Math.max(...cur.map((x) => x.rect.bottom))
      const overlap = Math.min(bottom, w.rect.bottom) - Math.max(top, w.rect.top)
      if (overlap > 0.5 * Math.min(w.rect.bottom - w.rect.top, bottom - top)) {
        cur.push(w)
        continue
      }
    }
    lines.push([w])
  }
  const lineTops = lines.map((ws2) => Math.min(...ws2.map((w) => w.rect.top)))
  const off = (top) => wr.reduce((a, r) => a + (r.top < top ? r.height : 0), 0)
  const leading = lineTops.length ? lineTops[0] - rect.top - off(lineTops[0]) : 0
  const cands = lineTops.slice(1).map((t2) => t2 - rect.top - off(t2) - leading)
  return {
    height: Math.round(height * 100) / 100,
    leading: Math.round(leading * 100) / 100,
    firstCand: cands.length ? Math.round(cands[0] * 100) / 100 : null,
    lastCand: cands.length ? Math.round(cands[cands.length - 1] * 100) / 100 : null,
    lines: lineTops.length,
    widgetOverhangs: wr.some((r) => r.bottom > rect.bottom + 0.5),
    widgetAtStart: wr.some((r) => Math.abs(r.top - rect.top) < 0.5),
  }
}
`

const probe = () =>
  page.evaluate(`
${MEASURE_FN}
(() => {
  const out = []
  for (const p of document.querySelectorAll('#paper .ProseMirror p')) {
    const ws = [...p.querySelectorAll('.page-gap')]
    if (!ws.length) continue
    const withW = measureP(p)
    for (const w of ws) w.style.display = 'none'
    const withoutW = measureP(p)
    for (const w of ws) w.style.display = ''
    out.push({
      text: (p.textContent || '').slice(0, 35),
      withW,
      withoutW,
      dh: Math.round((withW.height - withoutW.height) * 100) / 100,
      dfirst: withW.firstCand != null && withoutW.firstCand != null ? Math.round((withW.firstCand - withoutW.firstCand) * 100) / 100 : null,
    })
  }
  return out
})()
`)

const breaks = () =>
  page.evaluate(() =>
    window.__pager.key.getState(window.__pager.view.state).breaks.map(
      (b) => b.pos + ":" + Math.round(b.remaining)
    )
  )

const binfo = () =>
  page.evaluate(() => {
    const { view, key } = window.__pager
    const b = key.getState(view.state).breaks[0]
    const $p = view.state.doc.resolve(b.pos)
    return { break: b.pos, start: $p.start(), end: $p.end() }
  })

const summarize = (rows) =>
  rows
    .map(
      (r) =>
        `    "${r.text.slice(0, 25)}" h=${r.withW.height}/${r.withoutW.height} (d=${r.dh}) lead=${r.withW.leading}/${r.withoutW.leading} cand1=${r.withW.firstCand}/${r.withoutW.firstCand} (d=${r.dfirst}) lines=${r.withW.lines}/${r.withoutW.lines} overhang=${r.withW.widgetOverhangs}`
    )
    .join("\n")

const runCase = async (label, from, to) => {
  console.log(`\n=== ${label}: delete [${from}, ${to}]`)
  await page.evaluate(
    ([from, to]) => {
      const { view } = window.__pager
      view.dispatch(view.state.tr.delete(from, to))
    },
    [from, to]
  )
  console.log("  [transient, pre-pass]")
  console.log(summarize(await probe()))
  await sleep(700)
  console.log("  [after the pass] breaks:", JSON.stringify(await breaks()))
  console.log(summarize(await probe()))
  await page.evaluate(() => [...document.querySelectorAll(".panel-buttons button")][0].click())
  await sleep(800)
  console.log("  [after full re-run]   breaks:", JSON.stringify(await breaks()))
  console.log(summarize(await probe()))
  await page.keyboard.down("Control")
  await page.keyboard.press("KeyZ")
  await page.keyboard.up("Control")
  await sleep(800)
  console.log("  [after Ctrl+Z]        breaks:", JSON.stringify(await breaks()))
}

console.log("— seed")
console.log("  breaks:", JSON.stringify(await breaks()))
console.log(summarize(await probe()))

// S1: delete the CARRIED fragment (break pos .. paragraph end)
{
  const i = await binfo()
  await runCase("S1 carried fragment gone (widget lands at paragraph end)", i.break, i.end)
}

// S2: delete the KEPT fragment (paragraph start .. break pos)
{
  const i = await binfo()
  await runCase("S2 kept fragment gone (widget lands at paragraph start)", i.start, i.break)
}

await browser.close()
try {
  process.kill(-server.pid, "SIGTERM")
} catch {}
