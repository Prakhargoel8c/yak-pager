/**
 * The pure core: measured heights and positions in, page breaks out. No
 * DOM, no clocks, so the same input always gives the same breaks, which is
 * what keeps reflow idempotent. Blocks stack in order; a block with `splits`
 * breaks at the last line boundary that fits, else it is pushed whole; a
 * forced break ends its page after the marker, so two in a row give a blank
 * page (authorial intent).
 */

/** Visual height of the band between two pages at 1in margins: bottom margin + desk gap + top margin. */
export const BAND = 216

/** Fewest lines that must stay behind a split (orphan control). */
export const MIN_KEPT_LINES = 1
/** Fewest lines that must move to the new page (widow control). */
export const MIN_CARRIED_LINES = 1

export interface Block {
  pos: number
  height: number
  /** One per visual line after the first, ascending by height; only splittable blocks carry them. */
  splits?: SplitCandidate[]
}

export interface SplitCandidate {
  /** Doc position where the carried part starts. */
  pos: number
  /** From the block's top to the carried line's line-box top: where a gap widget inserted at `pos` gets its top edge. */
  height: number
}

export interface PageBreak {
  /** Doc position of the first content on the new page. */
  pos: number
  /** Ragged space left on the page above (>= 0). */
  remaining: number
}

export interface Solution {
  breaks: PageBreak[]
  /** Flow y of each page's first content pixel; an overflowing page extends the flow by its fill. */
  pageStarts: number[]
  /** Content height on each page. */
  fills: number[]
}

/**
 * The last candidate that fits. Candidate k keeps k - segIdx lines on the
 * current page (segIdx: the candidate used by this block's previous split,
 * -1 before the first) and carries splits.length - k.
 */
function pickSplit(
  splits: SplitCandidate[],
  segIdx: number,
  placed: number,
  room: number
): { cand: SplitCandidate; index: number } | undefined {
  for (let k = splits.length - MIN_CARRIED_LINES; k >= segIdx + MIN_KEPT_LINES; k--) {
    if (splits[k].height - placed <= room) return { cand: splits[k], index: k }
  }
  return undefined
}

export function solve(blocks: Block[], pageHeight: number, forcedBreaks: number[] = [], band = BAND): Solution {
  const forced = new Set(forcedBreaks)
  const breaks: PageBreak[] = []
  const pageStarts: number[] = [0]
  const fills: number[] = []
  let h = 0 // fill of the current page
  let start = 0 // flow y where the current page's content began

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]

    // `placed`, `segPos` and `segIdx` describe the part not yet on a page.
    let placed = 0
    let segPos = b.pos
    let segIdx = -1
    for (;;) {
      const rest = b.height - placed
      if (h + rest <= pageHeight) {
        h += rest
        break
      }

      const s = b.splits ? pickSplit(b.splits, segIdx, placed, pageHeight - h) : undefined
      if (s) {
        const fill = h + (s.cand.height - placed)
        breaks.push({ pos: s.cand.pos, remaining: pageHeight - fill })
        fills.push(fill)
        start += pageHeight + band
        pageStarts.push(start)
        h = 0
        placed = s.cand.height
        segPos = s.cand.pos
        segIdx = s.index
        continue
      }

      // Nothing fits: push the rest to a fresh page and try again there,
      // unless this page is empty, where an oversized block is placed anyway
      // (a page to itself rather than a loop).
      if (h > 0) {
        breaks.push({ pos: segPos, remaining: Math.max(0, pageHeight - h) })
        fills.push(h)
        start += Math.max(h, pageHeight) + band
        pageStarts.push(start)
        h = 0
        continue
      }
      h += rest
      break
    }

    if (forced.has(b.pos) && i + 1 < blocks.length) {
      breaks.push({ pos: blocks[i + 1].pos, remaining: Math.max(0, pageHeight - h) })
      fills.push(h)
      start += Math.max(h, pageHeight) + band
      pageStarts.push(start)
      h = 0
    }
  }
  fills.push(h)
  return { breaks, pageStarts, fills }
}
