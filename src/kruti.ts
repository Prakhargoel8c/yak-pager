/**
 * Unicode Hindi to Kruti Dev 010, the legacy font Indian courts type in.
 *
 * Kruti Dev is not a Unicode font: it draws Devanagari glyphs at Latin code
 * points ("d" is क, "f" is the ि matra), so the text has to be re-encoded,
 * and the font only shows Hindi for text written in its encoding. Two
 * Devanagari rules become reorderings in that encoding: the ि matra is typed
 * before its consonant cluster, and a reph (र् before a cluster) after the
 * syllable, as "Z".
 *
 * Kruti Dev has no Latin letters of its own, so splitKrutiRuns keeps Latin
 * words, digits and the punctuation it lacks as separate runs for the
 * document's other font.
 */

const C = "[क-हक़-य़]़?"
const CLUSTER = `(?:${C}्)*${C}`
const REPH = new RegExp(`(?<!्)र्(${CLUSTER})([ा-ौॅॉ]*)`, "g")
const I_MATRA = new RegExp(`(${CLUSTER})ि`, "g")

/** Full and half forms; a consonant with no half glyph takes full + "~" (virama). */
const CONSONANTS: Record<string, [full: string, half: string | null]> = {
  क: ["d", "D"], ख: ["[k", "["], ग: ["x", "X"], घ: ["?k", "?"], ङ: ["³", null],
  च: ["p", "P"], छ: ["N", null], ज: ["t", "T"], झ: [">", "÷"], ञ: ["¥", null],
  ट: ["V", null], ठ: ["B", null], ड: ["M", null], ढ: ["<", null], ण: [".k", "."],
  त: ["r", "R"], थ: ["Fk", "F"], द: ["n", null], ध: ["/k", "/"], न: ["u", "U"],
  प: ["i", "I"], फ: ["Q", "¶"], ब: ["c", "C"], भ: ["Hk", "H"], म: ["e", "E"],
  य: [";", "¸"], र: ["j", null], ल: ["y", "Y"], ळ: ["G", null], व: ["o", "O"],
  श: ["'k", "'"], ष: ['"k', '"'], स: ["l", "L"], ह: ["g", "º"],
}

/** Ligatures and other multi-character sequences, matched longest first. */
const SEQUENCES: Record<string, string> = {
  "क्ष्": "{", "क्ष": "{k", "त्र्": "«", "त्र": "=", "ज्ञ": "K", "श्र": "J",
  "क्र": "Ø", "प्र": "ç", "फ्र": "Ý", "द्र": "æ", "द्ध": ")", "द्य": "|", "द्व": "}",
  "द्द": "Ì", "द्भ": "˜", "ट्ट": "ê", "ट्ठ": "ë", "ड्ड": "Ï", "ड्ढ": "ï", "क्क": "ô",
  "क्त": "ä", "न्न": "é", "ह्न": "à", "ह्म": "ã", "ह्य": "á", "त्त्": "Ù", "त्त": "Ùk",
  "रु": "#", "रू": ":", "कृ": "Ñ", "दृ": "–", "हृ": "â",
  अ: "v", आ: "vk", इ: "b", ई: "Ã", उ: "m", ऊ: "Å", ए: ",", ऐ: ",s", ओ: "vks", औ: "vkS",
  ऑ: "vkW", ऋ: "_",
  "ा": "k", "ी": "h", "ु": "q", "ू": "w", "ृ": "`", "े": "s", "ै": "S", "ो": "ks", "ौ": "kS",
  "ॉ": "kW", "ॅ": "W", "ं": "a", "ँ": "¡", "ः": "%", "्": "~", "़": "+",
  "।": "A", "॥": "AA", ",": "]", ".": "-", "-": "&", "?": "\\", "(": "¼", ")": "½",
  "/": "@", ";": "(", "‘": "^", "’": "*", "“": "Þ", "”": "ß",
  "\u0001": "f",
}
const SEQ_LENGTHS = [...new Set(Object.keys(SEQUENCES).map((k) => k.length))].sort((a, b) => b - a)

const NUKTA = "़"
const VIRAMA = "्"

function consonant(ch: string, nukta: boolean, half: boolean): string {
  const [full, halfForm] = CONSONANTS[ch]
  if (half) return halfForm ? halfForm + (nukta ? "+" : "") : full + (nukta ? "+" : "") + "~"
  if (!nukta) return full
  return full.endsWith("k") && halfForm ? halfForm + "+k" : full + "+"
}

/** Re-encodes Unicode Devanagari for Kruti Dev 010. Characters it has no glyph for pass through. */
export function unicodeToKruti(text: string): string {
  // Precomposed nukta letters (क़ U+0958 …) as base + nukta.
  let s = text.normalize("NFD")
  s = s.replace(REPH, "$1$2Z")
  s = s.replace(I_MATRA, "\u0001$1")
  let out = ""
  let i = 0
  outer: while (i < s.length) {
    for (const n of SEQ_LENGTHS) {
      const seq = s.slice(i, i + n)
      if (seq.length === n && SEQUENCES[seq] !== undefined) {
        out += SEQUENCES[seq]
        i += n
        continue outer
      }
    }
    const ch = s[i]
    if (CONSONANTS[ch]) {
      let j = i + 1
      const nukta = s[j] === NUKTA
      if (nukta) j++
      if (s[j] === VIRAMA && s[j + 1] === "र") {
        out += consonant(ch, nukta, false) + "z"
        i = j + 2
      } else if (s[j] === VIRAMA) {
        out += consonant(ch, nukta, true)
        i = j + 1
      } else {
        out += consonant(ch, nukta, false)
        i = j
      }
      continue
    }
    out += ch
    i++
  }
  return out.replace(/hZ/g, "Ê").replace(/Za/g, "±")
}

const DEVANAGARI = /[ऀ-ॿ]/
const KRUTI_PUNCT = /[ऀ-ॿ\s,.?()/;‘’“”-]/

export interface Run {
  text: string
  /** True for Kruti Dev text, false for a run in the document's Latin font. */
  kruti: boolean
}

/**
 * Splits Unicode Hindi into Kruti Dev runs (already re-encoded) and runs to
 * keep in a Latin font: words with no Devanagari, and characters Kruti Dev
 * has no glyph for (digits, dashes, ⌘ …). Spaces join the run before them.
 */
export function splitKrutiRuns(text: string): Run[] {
  const runs: Run[] = []
  const push = (t: string, kruti: boolean) => {
    const last = runs[runs.length - 1]
    if (last && last.kruti === kruti) last.text += t
    else runs.push({ text: t, kruti })
  }
  for (const token of text.split(/(\s+)/)) {
    if (token === "") continue
    if (/^\s+$/.test(token)) {
      push(token, runs[runs.length - 1]?.kruti ?? true)
    } else if (!DEVANAGARI.test(token)) {
      push(token, false)
    } else {
      for (const ch of token) push(ch, KRUTI_PUNCT.test(ch))
    }
  }
  return runs.map((r) => (r.kruti ? { text: unicodeToKruti(r.text), kruti: true } : r))
}
