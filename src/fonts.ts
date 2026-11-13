/**
 * The editor's fonts. A document records its base font in the doc node's
 * `font` attr; a run in another font carries a `fontFamily` mark holding
 * that font's CSS family list. Pretext measures with the same lists, read
 * back from the editor's computed style and the marks.
 */
import "@fontsource/gayathri/400.css"
import "@fontsource/gayathri/700.css"

export const FONTS = {
  georgia: { label: "Georgia", family: 'Georgia, "Times New Roman", serif' },
  // Legacy encoding: Devanagari drawn at Latin code points ("fd" is कि).
  kruti: { label: "Kruti Dev", family: '"Kruti Dev", Georgia, "Times New Roman", serif' },
  gayathri: { label: "Gayathri", family: 'Gayathri, Georgia, "Times New Roman", serif' },
} as const
export type FontKey = keyof typeof FONTS

export const isFontKey = (k: unknown): k is FontKey => typeof k === "string" && k in FONTS

/** The font a CSS family list starts with, or null for one not in FONTS (pasted text). */
export function fontKeyOf(family: string): FontKey | null {
  const first = family.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase()
  for (const [key, font] of Object.entries(FONTS)) {
    if (font.family.split(",")[0].replace(/"/g, "").trim().toLowerCase() === first) return key as FontKey
  }
  return null
}
