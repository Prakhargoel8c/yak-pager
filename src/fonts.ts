/** The doc's `font` attr names the base font; a run in another carries a `fontFamily` mark with its family list. */
import type { EditorState } from "prosemirror-state"
import "@fontsource/gayathri/400.css"
import "@fontsource/gayathri/700.css"

export const FONTS = {
  georgia: { label: "Georgia", family: 'Georgia, "Times New Roman", serif' },
  kruti: { label: "Kruti Dev", family: '"Kruti Dev", Georgia, "Times New Roman", serif' },
  gayathri: { label: "Gayathri", family: 'Gayathri, Georgia, "Times New Roman", serif' },
} as const
export type FontKey = keyof typeof FONTS

export const isFontKey = (k: unknown): k is FontKey => typeof k === "string" && k in FONTS

export const docFont = (state: EditorState): FontKey => (isFontKey(state.doc.attrs.font) ? state.doc.attrs.font : "georgia")

/** The font a family list starts with, or null for one not in FONTS (pasted text). */
export function fontKeyOf(family: string): FontKey | null {
  const first = family.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase()
  for (const [key, font] of Object.entries(FONTS)) {
    if (font.family.split(",")[0].replace(/"/g, "").trim().toLowerCase() === first) return key as FontKey
  }
  return null
}
