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

const m = {
  strong: () => schema.marks.strong.create(),
  em: () => schema.marks.em.create(),
  size: (px: number) => schema.marks.fontSize.create({ size: px }),
}

function text(str: string, marks: Mark[] = []) {
  return schema.text(str, marks)
}

function heading(level: 1 | 2 | 3, str: string) {
  return schema.nodes.heading.create({ level }, schema.text(str))
}

function para(...inlines: (string | Node)[]) {
  const content = inlines.map((i) => (typeof i === "string" ? text(i) : i))
  return schema.nodes.paragraph.create(null, content)
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

export const LANGUAGES = {
  en: { label: "English", text: en as SeedText },
  hi: { label: "हिन्दी", text: hi as SeedText },
  ml: { label: "മലയാളം", text: ml as SeedText },
  kn: { label: "ಕನ್ನಡ", text: kn as SeedText },
}
export type Language = keyof typeof LANGUAGES

export function buildSeedDoc(lang: Language = "en"): Node {
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

  return schema.nodes.doc.create(null, children)
}
