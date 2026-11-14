/**
 * Seed document — long enough to span 4+ pages, with headings, a horizontal
 * rule, mixed marks (strong / em / fontSize), one justified paragraph, and
 * one explicit pageBreak node so the forced-break path is visible on first
 * load. The words come from src/seed-text/<lang>.json.
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

/**
 * How text() writes the seed's words: the document's base font, and whether
 * Hindi is re-encoded for Kruti Dev. Re-encoded text is split into Kruti
 * Dev runs and Latin runs (Georgia); a run whose font isn't the base font
 * gets a fontFamily mark.
 */
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

/**
 * The seed's words, one file per language. Every language has the same
 * shape, so the document's structure (headings, marks, the justified
 * paragraph, the rule and the explicit break) is the same in all of them.
 * Marked runs are fixed slots: intro = [text, strong, text, em, text],
 * tryIt = [text, strong, text, strong, text], fontSize = [text, 20px, text].
 */
export interface SeedText {
  title: string
  intro: [string, string, string, string, string]
  tryIt: [string, string, string, string, string]
  fontSize: [string, string, string]
  justified: string
  sections: Array<{ title: string; paras: string[] }>
  afterBreak: { title: string; paras: string[]; subtitle: string; subParas: string[] }
}

/**
 * `font` is the document's base font; `kruti` re-encodes the Hindi for Kruti
 * Dev. "mixed" interleaves the English seed with the Hindi one in Kruti Dev
 * on a Georgia document.
 */
export const LANGUAGES: Record<string, { label: string; text: SeedText; font: FontKey; kruti?: boolean }> = {
  en: { label: "English", text: en as SeedText, font: "georgia" },
  hi: { label: "हिन्दी (Kruti Dev)", text: hi as SeedText, font: "kruti", kruti: true },
  "hi-unicode": { label: "हिन्दी (Unicode)", text: hi as SeedText, font: "georgia" },
  mixed: { label: "English + Kruti Dev", text: en as SeedText, font: "georgia", kruti: true },
  ml: { label: "മലയാളം (Gayathri)", text: ml as SeedText, font: "gayathri" },
  kn: { label: "ಕನ್ನಡ", text: kn as SeedText, font: "georgia" },
}
export type Language = keyof typeof LANGUAGES

export function buildSeedDoc(lang: Language = "en"): Node {
  const { font } = LANGUAGES[lang]
  base = font
  kruti = LANGUAGES[lang].kruti ?? false
  if (lang === "mixed") return buildMixedDoc()
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

  for (const section of t.sections) {
    children.push(heading(2, section.title))
    for (const p of section.paras) children.push(para(p))
  }

  // An explicit, authorial page break: this one IS a document node.
  children.push(
    schema.nodes.pageBreak.create(),
    heading(2, t.afterBreak.title),
    ...t.afterBreak.paras.map((p) => para(p)),
    heading(3, t.afterBreak.subtitle),
    ...t.afterBreak.subParas.map((p) => para(p))
  )

  return schema.nodes.doc.create({ font }, children)
}

/**
 * English and Hindi in Kruti Dev in one Georgia document: each English
 * paragraph is followed by its Hindi counterpart, headings carry both, and
 * the Hindi keeps its own Latin words in Georgia, so lines mix the fonts.
 */
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
