Editor Pagination — Design Decisions

---

# 1. Pagination is not part of the CRDT

Page breaks are computed locally and rendered as ProseMirror decorations. They never enter the `Y.Doc`.

**Why?**

It is not technically impossible to put break positions within a CRDT. But then conflict resolution becomes tricky. There is no inherently “correct” global page break. They may vary depending on font size, browser engines, and differences in rendering stacks.

It does mean that the document might look different in different systems, but that only remains within the browser. The exported content anyways is not guaranteed to match with the live pagination state. (See point 2).

**What remains in the CRDT:**

- Explicit page breaks (user pressed ctrl-enter)
- Page metadata - margins, header/footer content etc.

**What is local-only:**

- Computed break positions
- Measured block heights.

**Consequences:**

- **No reflow churn.** Typing on page 1 of a 40-page document generates one character insert, not costly DOM operations all throughout the document.
- **Cursors survive.** Content is never deleted-and-reinserted to move between pages, so Yjs Item IDs stay stable and collaborative cursors keep resolving.

---

# 2. No export parity requirement

No point trying to have a 1-1 parity with docx/odt. It’s the same in Google docs as well. I have tested it and the exported docx/odt varies in where the page breaks are generated.

That also makes sense, because Word and LibreOffice have their own rendering engines which run during *file open time*. It is not metadata that you can embed in the file content itself. 

**Alternatives considered:** Run a wasm build of Libreoffice within the browser. But that’s too costly. There’s only one player in the market - ZetaOffice and that doesn’t even work properly. It’s not worth a path going down.

**What we optimize for instead:** live pagination that is correct, fast, and consistent across *our own* clients — plus a print preview that reflects it accurately.

**Caveat**: there are indeed concepts like `w:br w:type="page"` in docx, `fo:break-before` in odt. But it’s not really a solution. Because the downloaded document will never reflow. Those page breaks will become static. It’s only a solution if the downloaded document is meant to be fully static and never edited, which does not sound like a good solution.

---

# 3. Content never moves between pages

There is no page container to move a paragraph between. The document stays a flat list of blocks. Only break positions change.

**Reflow = recomputing break positions, not moving nodes.**

Given blocks `[H, A, B, C, T, D]` and a break currently before `T`:

```
Solve:   accumulate heights → first overflow marks the break
Render:  Decoration.widget(pos, <page gap>)          ← real DOM, contenteditable=false
         Decoration.node(pos, { margin-top: Npx })   ← attribute write on existing node
```

before:  [H, A, B, C, ←break→ T(table), D]   table had the mark
after:   [H, A, B, ←break→ C, T(table), D]   C's <p> has the mark

When B grows and the break moves earlier, the complete set of DOM operations is:

1. B's `<p>` — text updated (the actual edit)
2. C's `<p>` — `setAttribute` class + style
3. `<table>` — `removeAttribute` class + style
4. Gap widget — `insertBefore` to its new position (keyed, so reused not recreated)

No element created or destroyed. No subtree reparented. The `<table>` keeps its identity, children, scroll position, and any focus inside it.

**The page look is CSS.** A fixed-width white column with a shadow.

---

# 4. Alignment lives in the document

Left, center, right, and justified are authorial intent, so alignment is a node attribute on paragraphs and headings — one real transaction with steps, undoable and serialized like any mark, rendered as a `text-align` inline style only when it is not the default. The toolbar's alignment control changes that attr; it never touches CSS classes or plugin state, and it sets the attr per block rather than one blanket `setBlockType`, which would convert a heading inside the selection into a paragraph.

Justification costs pagination nothing: it stretches spaces without changing which words share a line, so measured line boundaries and block heights are identical to the ragged-right case, and the solver sees the same numbers. The one interaction — a justified paragraph split across a page boundary — was already verified in the spike (point 3: justify holds across the floated gap widget) and is now checked by the e2e suite on every run: every line but the last must sit flush at the right margin, including the lines on both sides of the widget.

---

# 5. Measuring text with Pretext

MEASURE for paragraphs and headings uses [Pretext](https://github.com/chenglou/pretext), which computes line breaks and widths from the text and its marks using Canvas measurement and the browser engine's own line-break rules. Everything else (pageBreak, horizontal rules, and any block with inline content other than text and hard breaks) still measures from the DOM. `?measure=dom` (or `measurer: "dom"` on the plugin) measures everything from the DOM, as before.

**Why:** the DOM path reads a Range rect for every word of every changed paragraph. Pretext needs one layout read per pass (the editor's content width); the rest is arithmetic over cached widths. It is also idempotent without the widget subtraction in `measure.ts`, because it never sees the widget.

**What it models** (`src/pretextMeasure.ts`, which must match `styles.css` like `layout.ts` does): the editor font (read from the editor, so a Kruti Dev document measures in Kruti Dev), block sizes, unitless line-heights and paddings; `strong` as `font-weight: bolder`, `em`, the `fontSize` and `fontFamily` marks; `white-space: pre-wrap`; hard breaks, including the extra line a trailing one gets. Line heights follow CSS: each run's inline box sits on the baseline by its font's ascent and descent, and a line spans from the highest top to the lowest bottom, the block's strut included. A line mixing two fonts (Kruti Dev and Georgia) is therefore taller than either alone. Each font and size is probed once from a hidden element, which also picks up WebKit's whole-pixel line heights.

**Kruti Dev.** Hindi documents can use Kruti Dev 010, the legacy font Indian courts type in. It is not a Unicode font: it draws Devanagari at Latin code points ("fd" is कि), so a user types ASCII on a Kruti keyboard layout and the editor stores and measures that ASCII in the Kruti Dev font. `src/kruti.ts` converts the Unicode Hindi seed to this encoding; Latin words keep Georgia through a `fontFamily` mark.

**Fonts.** A document records its base font in the doc node's `font` attr (Georgia, Kruti Dev, or Gayathri for Malayalam), and the editor applies it as its font-family; a run in another font carries a `fontFamily` mark. The mark is inclusive, as in a word processor: typing on from a run keeps its font. The toolbar's font dropdown reads the font at the cursor from the content (the mark, else the doc's font; "Mixed fonts" over a selection that spans several) and sets it on the selection, or on what is typed next; choosing the doc's own font removes the mark. `?lang=mixed` is an English document with Hindi paragraphs and phrases in Kruti Dev. Spellcheck and autocorrect are off in a Kruti Dev document. `pretext-compare` checks the Kruti seed and live Kruti typing against the browser, and judges split tops against the browser's own layout (a cloned paragraph cut at the split), since the DOM path's half-leading assumption is off on mixed-font lines.

**How it was checked:** `npm run pretext-compare` measures every block both ways in Chrome. On the seed plus a set of stress blocks (long words, a URL, hard breaks, an empty paragraph, mixed font sizes, marks in headings, justified text), every height matches to 0.5px and every DOM split candidate is found by Pretext at the same position. The e2e suite gives the same results in both modes (`E2E_QUERY=?measure=dom` for the DOM path), landing checks included. Two differences remain, and in both the DOM path is the inexact side:

- Pretext finds line starts inside a whitespace-free token: after a hyphen (`non-|empty`, `re-|inserted`) or inside a long word or URL. The DOM path groups words with `/\S+/`, so it never sees those lines as split candidates.
- On a line with a larger font, Pretext puts the line-box top 2–3px lower than the DOM path, which assumes every line has the first line's half-leading (the "off by the extra leading" noted above).

**Caveats:** heights are only as right as `pretextMeasure.ts`'s copy of the CSS. Pretext doesn't model `font-variant-ligatures: none`, which the editor sets. No height differed on text with words like "first" and "fit", but that wasn't checked separately, and a font with more ligatures could wrap differently. The column is 640px, not the 624px `layout.ts` implies (`.paper-stack` is content-box), so the width is read from the editor instead of computed from constants.

---

# Open Questions

## How to split paragraphs

So far, we haven't brought up splitting nodes. In the above design, a paragraph that does not fit on a page is pushed whole to the next page. This creates "ragged bottoms", but keeps the logic simple. However, it is not the right user experience because a user will suddenly notice the whole paragraph shifting to the next page.

But at the same time, we cannot split the paragraph nodes. That would put pagination into the document: it would enter history, so Ctrl+Z would fight the reflow, and every keystroke near a page boundary would rewrite document structure. It also breaks rule 1 (no page nodes in the doc).

One proposal is to keep the paragraph as one document node and place the gap widget *between two words* inside it, so the first lines fill the current page and the rest flows onto the next. Then the question becomes of how to exactly render this gap widget inside a paragraph correctly.

The following are two proposals:

- **`display: inline-block; width: 100%`** — simple, but wrong by a few pixels. Every text line behaves as if it held an invisible zero-width character as tall as the paragraph's line-height, and an empty inline-block aligns its bottom edge to the text baseline. So the line box becomes widget height plus that extra leading, and the words after the widget land too low. The error depends on font metrics (it changes with font-size marks) and it accumulates into every break inside a paragraph.
- **`float: left; clear: both; width: 100%`** — floats are ignored by baseline layout, and a cleared line must start below the float's bottom edge. No baseline math, no extra leading: the inserted space is the widget's height, exactly like the block-level case. The price is float quirks (interaction with `text-align: justify`, and the paragraph box growing correctly around a cleared float).

Needs to be verified practically.

**Verified (spike): the float approach is pixel-exact.** The spike lives in `tests/spike-split.html` + `tests/spike.mjs` (run: `npm run spike`). It reproduces the paper geometry and places real spacers at measured line boundaries. Measured in Chrome:

- The float's box bottom lands on the next page's content start to 0.00px in every scenario: plain text, `text-align: justify`, mixed font sizes, and one paragraph spanning three pages (two spacers). The first carried word sits a half-leading (3px) below the page start, which is the exact same place a fresh paragraph starting that page puts its first word — so a split paragraph looks identical to a block-level break.
- Nothing above the split moves and nothing re-wraps. Line-by-line word sequences are identical before and after insertion, horizontal positions are unchanged, and justify holds across the spacer (split lines do not go ragged).
- The paragraph box grows around the float, the flow height grows by exactly the spacer heights, and the next block stacks flush after the paragraph.
- The inline-block variant fails by +10px, exactly as the strut analysis predicted: its own box lands correctly, but the word after it overshoots because the line box grows by the paragraph's line-height. This rules it out.

One measurement subtlety the spike settled: "landing" must be asserted on the spacer's box bottom (which is the carried line's line-box top), not on the word's em-box top. The em-box sits a constant half-leading lower on both sides of the break, so it cancels out.

**Implemented.** Paragraphs now split at line boundaries. The pipeline:

- **MEASURE** (`measureSplitCandidates` in `src/paginationPlugin.ts`) walks a paragraph's words with Ranges, groups them into visual lines, and reports one candidate per line after the first: the line's first word and the height from the paragraph's top to that line's line-box top (the quantity the float aligns to, per the spike). A paragraph that already contains its gap widget is measured with the widget's space subtracted from its height and from the lines below it, so re-measuring a split paragraph reproduces the same numbers — reflow stays idempotent.
- **SOLVE** (`src/solver.ts`) keeps as many lines as fit and breaks before the first line that would cross the page bottom; the remainder continues on the next page and may split again, so a paragraph taller than a page spans several pages. Widow/orphan minimums (2 lines stay, 2 lines move) bound every split; when they cannot be satisfied, the paragraph falls back to being pushed whole, as do all atomic blocks.
- **DECORATE** places the same pooled widget at an inline position between two words (`#paper .ProseMirror p .page-gap { float: left; clear: both; width: 100%; }`). `marks: []` keeps it from inheriting the marks of the text before it.

Two bugs the e2e suite caught during implementation, worth remembering:

- **Split positions must be cached node-local.** The measure cache is keyed by node identity, and an insertion elsewhere in the document preserves the node while shifting its doc positions. Caching absolute positions therefore served stale positions on cache hits, and the widget rendered a line or two away from where the solver's heights said it should be. Candidates are now cached as offsets from the paragraph's content start and made absolute against the current offset at each pass.
- **The e2e state lookup was vacuously passing.** `p.getState?.(p.key ?? "pagination")` passes a key where ProseMirror expects an editor state, so it always returned undefined and the old placement check passed against an empty list. `window.__pager` now exposes the plugin key and the tests read state through it.

The e2e suite verifies the feature end to end: at least one break is inline, every widget sits immediately before its break's content (block or word), and every widget's box bottom lands within 0.5px of the next page's content start — including after typing inside a paragraph that straddles a boundary, where the reflow performs only pooled-widget reuse (insertBefore, text re-splits, `--push` writes).

---
