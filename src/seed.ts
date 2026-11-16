/**
 * Seed documents, 4+ pages each: headings, a rule, marks, a justified
 * paragraph and an explicit page break. The words come from
 * src/seed-text/<lang>.json, every language in the same shape.
 */
import { schema } from "./schema"
import type { Node, Mark } from "prosemirror-model"
import en from "./seed-text/en.json"
import hi from "./seed-text/hi.json"
import ml from "./seed-text/ml.json"
import kn from "./seed-text/kn.json"
import { splitKrutiRuns } from "./kruti"
import { FONTS } from "./fonts"
import type { FontKey } from "./fonts"

const m = {
  strong: () => schema.marks.strong.create(),
  em: () => schema.marks.em.create(),
  size: (px: number) => schema.marks.fontSize.create({ size: px }),
}

// How text() writes words: re-encoded Hindi is split into Kruti Dev and Latin
// runs, and a run not in the base font gets a fontFamily mark.
let base: FontKey = "georgia"
let kruti = false

function text(str: string, marks: Mark[] = []): Node[] {
  if (!kruti) return [schema.text(str, marks)]
  return splitKrutiRuns(str).map((r) => {
    const font: FontKey = r.kruti ? "kruti" : "georgia"
    const runMarks = font === base ? marks : schema.marks.fontFamily.create({ family: FONTS[font].family }).addToSet(marks)
    return schema.text(r.text, runMarks)
  })
}

function heading(level: 1 | 2 | 3, str: string) {
  return schema.nodes.heading.create({ level }, text(str))
}

function para(...inlines: (string | Node[])[]) {
  return schema.nodes.paragraph.create(null, inlines.flatMap((i) => (typeof i === "string" ? text(i) : i)))
}

const item = (...blocks: Node[]) => schema.nodes.listItem.create(null, blocks)
const ul = (items: Node[]) => schema.nodes.bulletList.create(null, items)
const ol = (items: Node[], start = 1) => schema.nodes.orderedList.create({ start }, items)

/** Marked runs are fixed slots: intro = [text, strong, text, em, text], tryIt = [text, strong, text, strong, text], fontSize = [text, 20px, text]. */
export interface SeedText {
  title: string
  intro: [string, string, string, string, string]
  tryIt: [string, string, string, string, string]
  fontSize: [string, string, string]
  justified: string
  sections: Array<{ title: string; paras: string[] }>
  afterBreak: { title: string; paras: string[]; subtitle: string; subParas: string[] }
}

/** `kruti` re-encodes the Hindi for Kruti Dev. */
export const LANGUAGES: Record<string, { label: string; text: SeedText; font: FontKey; kruti?: boolean }> = {
  en: { label: "English", text: en as SeedText, font: "georgia" },
  hi: { label: "हिन्दी (Kruti Dev)", text: hi as SeedText, font: "kruti", kruti: true },
  "hi-unicode": { label: "हिन्दी (Unicode)", text: hi as SeedText, font: "georgia" },
  mixed: { label: "English + Kruti Dev", text: en as SeedText, font: "georgia", kruti: true },
  ml: { label: "മലയാളം (Gayathri)", text: ml as SeedText, font: "gayathri" },
  kn: { label: "ಕನ್ನಡ", text: kn as SeedText, font: "georgia" },
  table: { label: "English + tables", text: en as SeedText, font: "georgia" },
  list: { label: "English + lists", text: en as SeedText, font: "georgia" },
}
export type Language = keyof typeof LANGUAGES

export function buildSeedDoc(lang: Language = "en"): Node {
  const { font } = LANGUAGES[lang]
  base = font
  kruti = LANGUAGES[lang].kruti ?? false
  if (lang === "mixed") return buildMixedDoc()
  if (lang === "table") return buildTableDoc()
  if (lang === "list") return buildListDoc()
  const t = LANGUAGES[lang].text
  const children: Node[] = []

  children.push(
    heading(1, t.title),
    para(text(t.intro[0]), text(t.intro[1], [m.strong()]), text(t.intro[2]), text(t.intro[3], [m.em()]), text(t.intro[4])),
    para(text(t.tryIt[0]), text(t.tryIt[1], [m.strong()]), text(t.tryIt[2]), text(t.tryIt[3], [m.strong()]), text(t.tryIt[4])),
    para(text(t.fontSize[0]), text(t.fontSize[1], [m.size(20)]), text(t.fontSize[2])),
    schema.nodes.paragraph.create({ align: "justify" }, text(t.justified)),
    schema.nodes.horizontal_rule.create()
  )
  if (lang === "hi") {
    const [a, b, c] = t.sections
    children.push(
      ol([
        item(para(a.paras[0]), ul([item(para(a.paras[1]), ol([item(para(b.paras[0])), item(para(b.paras[1]))])), item(para(a.paras[2]))])),
        item(para(c.paras[0]), para(c.paras[1])),
        item(para(b.paras[2]), ul([item(para(c.paras[2]))])),
      ])
    )
  }

  for (const section of t.sections) {
    children.push(heading(2, section.title))
    for (const p of section.paras) children.push(para(p))
  }

  children.push(
    schema.nodes.pageBreak.create(),
    heading(2, t.afterBreak.title),
    ...t.afterBreak.paras.map((p) => para(p)),
    heading(3, t.afterBreak.subtitle),
    ...t.afterBreak.subParas.map((p) => para(p))
  )

  return schema.nodes.doc.create({ font }, children)
}

/** Each English paragraph followed by its Hindi counterpart in Kruti Dev; headings carry both, so lines mix the fonts. */
function buildMixedDoc(): Node {
  const e = en as SeedText
  const h = hi as SeedText
  const plain = (str: string, marks: Mark[] = []) => [schema.text(str, marks)]
  const both = (level: 1 | 2 | 3, a: string, b: string) =>
    schema.nodes.heading.create({ level }, [...plain(a + " · "), ...text(b)])
  const children: Node[] = [
    both(1, e.title, h.title),
    para(plain(e.intro[0]), plain(e.intro[1], [m.strong()]), plain(e.intro[2]), plain(e.intro[3], [m.em()]), plain(e.intro[4])),
    para(text(h.intro[0]), text(h.intro[1], [m.strong()]), text(h.intro[2]), text(h.intro[3], [m.em()]), text(h.intro[4])),
    para(plain(e.fontSize[0]), text(h.fontSize[1], [m.size(20)]), plain(e.fontSize[2])),
    schema.nodes.paragraph.create({ align: "justify" }, [...plain(e.justified + " "), ...text(h.justified)]),
    schema.nodes.horizontal_rule.create(),
  ]
  e.sections.forEach((section, i) => {
    children.push(both(2, section.title, h.sections[i].title))
    section.paras.forEach((p, j) => {
      children.push(para(plain(p)))
      if (h.sections[i].paras[j]) children.push(para(text(h.sections[i].paras[j])))
    })
  })
  return schema.nodes.doc.create({ font: "georgia" }, children)
}

/** A small table, a long one that breaks across pages (uneven cells, Kruti Dev, Unicode Hindi, a colspan), and one with resized columns. */
function buildTableDoc(): Node {
  const e = en as SeedText
  const h = hi as SeedText
  const kruti = (str: string) =>
    splitKrutiRuns(str).map((r) =>
      schema.text(r.text, r.kruti ? [schema.marks.fontFamily.create({ family: FONTS.kruti.family })] : [])
    )
  const cell = (content: string | Node[], attrs: Record<string, unknown> | null = null, header = false) =>
    (header ? schema.nodes.tableHeader : schema.nodes.tableCell).create(
      attrs,
      schema.nodes.paragraph.create(null, typeof content === "string" ? schema.text(content) : content)
    )
  const row = (...cells: Node[]) => schema.nodes.tableRow.create(null, cells)
  const head = (...titles: string[]) => row(...titles.map((t) => cell(t, null, true)))
  const table = (...rows: Node[]) => schema.nodes.table.create(null, rows)

  const paras = e.sections.flatMap((s) => s.paras)
  const hiParas = h.sections.flatMap((s) => s.paras)
  const small = table(
    head("Step", "What it reads", "What it writes"),
    row(cell("Measure"), cell("Pretext line boxes"), cell("Heights and split candidates")),
    row(cell("Solve"), cell("Heights"), cell("Break positions")),
    row(cell("Decorate"), cell("Breaks"), cell("One pooled widget per break"))
  )
  const long = table(
    head("#", "Matter", "Notes"),
    ...Array.from({ length: 24 }, (_, i) => {
      const n = cell(String(i + 1))
      if (i === 5) return row(n, cell(kruti(h.sections[0].title)), cell(kruti(hiParas[0].slice(0, 160))))
      if (i === 9) return row(n, cell("हिन्दी (Unicode)"), cell(hiParas[1].slice(0, 140)))
      if (i === 13) return row(n, cell(paras[i % paras.length].slice(0, 120), { colspan: 2 }))
      const words = paras[i % paras.length].split(" ")
      return row(n, cell(words.slice(0, 2 + (i % 4)).join(" ")), cell(words.slice(0, 6 + ((i * 7) % 40)).join(" ")))
    })
  )
  const resized = table(
    row(cell("Column", { colwidth: [120] }, true), cell("Width", null, true), cell("Note", { colwidth: [200] }, true)),
    row(cell("First", { colwidth: [120] }), cell("Shares the rest"), cell(paras[0].slice(0, 90), { colwidth: [200] })),
    row(cell("Last", { colwidth: [120] }), cell(paras[1].slice(0, 160)), cell("Fixed at 200px", { colwidth: [200] }))
  )

  const children: Node[] = []
  buildSeedDoc("en").forEach((node) => {
    children.push(node)
    if (node.type.name !== "heading" || node.attrs.level !== 2) return
    if (node.textContent === e.sections[0].title) children.push(small)
    if (node.textContent === e.sections[1].title) children.push(long)
    if (node.textContent === e.sections[3].title) children.push(resized)
  })
  return schema.nodes.doc.create({ font: "georgia" }, children)
}

/** Lists four levels deep, alternating kinds, items of several paragraphs, an empty item, and a list starting at 5. */
function buildListDoc(): Node {
  const e = en as SeedText
  const paras = [...e.sections.flatMap((s) => s.paras), ...e.afterBreak.paras, ...e.afterBreak.subParas]
  let k = 0
  const next = () => para(paras[k++ % paras.length])
  const deep = (level: number): Node => {
    const wrap = level % 2 ? ul : ol
    if (level === 4) return wrap([item(next(), next()), item(next())])
    return wrap([item(next(), deep(level + 1)), item(next()), item(next(), deep(level + 1))])
  }
  const children: Node[] = [heading(1, e.title), para(e.intro.join("")), schema.nodes.paragraph.create({ align: "justify" }, text(e.justified))]
  e.sections.forEach((section, i) => {
    children.push(heading(2, section.title), next())
    if (i === 0) children.push(ol([item(next(), deep(2)), item(next(), next()), item(para()), item(next(), deep(3))]))
    else if (i === 1) children.push(ul([item(next(), deep(2)), item(next())]))
    else if (i === 2) children.push(next(), ol([item(next()), item(next(), deep(3))], 5))
    else children.push(ol([item(next(), deep(2))]))
  })
  return schema.nodes.doc.create({ font: "georgia" }, children)
}
