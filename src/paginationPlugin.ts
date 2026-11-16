/**
 * PAGINATION PLUGIN — scheduling, dispatch and widgets around the pass:
 *
 *   pass.ts      MEASURE + SOLVE: doc, geometry, measurers, dirty range and
 *                cache in, layout out. Never dispatches.
 *   this file    DECORATE: turn the layout's breaks into a DecorationSet —
 *                one pooled gap widget per break, between two blocks or
 *                between two words when the break splits a paragraph. The
 *                widget's box (band + --push in CSS) is the entire
 *                inter-page space, so no block DOM is ever touched. It is
 *                moved with insertBefore when a break moves.
 *
 * Scheduling: apply() only does position bookkeeping — it NEVER reads the
 * DOM, because it runs inside the transaction. The plugin's view marks
 * nothing more than "dirty" and runs the pass in a microtask: right after
 * the transaction that dirtied it, before the browser paints, once for all
 * transactions dispatched in the same task. The pass batches all reads
 * first, solves on pure numbers, then everything is applied in ONE
 * meta-transaction. That transaction carries no steps, so it never enters
 * history: Ctrl+Z undoes typing, never pagination.
 *
 * The reflow audit (reflowAudit.ts) records the DOM operations the apply
 * step performed, for the dev panel.
 */
import { Plugin, PluginKey } from "prosemirror-state"
import type { Transaction, EditorState } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"
import type { EditorView } from "prosemirror-view"
import { startMeter, stopMeter } from "./apiMeter"
import { applyGeometry, emptyLayout, geometryOf, makeGapDOM, paintSheets, setGapColspan, setGapVar } from "./layout"
import { breakSite } from "./units"
import type { Layout } from "./layout"
import { domMeasurer, pretextMeasurer } from "./measurers"
import { runPass } from "./pass"
import type { MeasureCache } from "./pass"
import { createReflowAudit } from "./reflowAudit"
import type { ReflowAudit, ReflowReport } from "./reflowAudit"

export interface PaginationState {
  decos: DecorationSet
  layout: Layout
  /** Doc-coordinate range that must be re-measured before the next solve. */
  dirty: { from: number; to: number } | null
  /** How paragraphs and headings are measured; see MeasurerKind. */
  measurer: MeasurerKind
  /**
   * A full re-measure was requested (fonts loaded, resize, measurer or
   * document switch): the next pass also drops what the measurers cached,
   * which may have been measured in a fallback font.
   */
  full: boolean
}

export const paginationKey = new PluginKey<PaginationState>("pagination")

/** Meta: the pass reports fresh layout (no steps — invisible to history). */
interface LayoutMeta {
  type: "layout"
  layout: Layout
}
/** Meta: fonts/resize/image — re-measure everything (heights can change without the doc changing). */
interface FullMeta {
  type: "full"
  /** Switch measurers; the full re-measure that follows uses the new one. */
  measurer?: MeasurerKind
}

export function requestFullRecompute(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(paginationKey, { type: "full" } satisfies FullMeta))
}

export function setMeasurer(view: EditorView, measurer: MeasurerKind) {
  view.dispatch(view.state.tr.setMeta(paginationKey, { type: "full", measurer } satisfies FullMeta))
}

/* ------------------------------------------------------------------ */
/* Position bookkeeping (pure — runs inside transactions)              */
/* ------------------------------------------------------------------ */

function remapRange(r: { from: number; to: number } | null, tr: Transaction) {
  if (!r) return null
  return { from: tr.mapping.map(r.from, -1), to: tr.mapping.map(r.to, 1) }
}

/**
 * tr.changedRange() plus the steps it can't see: adding or removing a mark
 * and setting a node attribute map no positions, so their maps are empty,
 * yet a fontSize or strong mark changes how tall a paragraph is.
 */
function touchedRange(tr: Transaction) {
  let range = tr.changedRange()
  tr.steps.forEach((step, i) => {
    let empty = true
    step.getMap().forEach(() => (empty = false))
    if (!empty) return
    const { from, to, pos } = step as unknown as { from?: number; to?: number; pos?: number }
    const start = from ?? pos
    const end = to ?? (pos != null ? pos + 1 : undefined)
    if (start == null || end == null) return
    const later = tr.mapping.slice(i + 1)
    range = unionRange(range, { from: later.map(start, -1), to: later.map(end, 1) })
  })
  return range
}

function unionRange(
  a: { from: number; to: number } | null,
  b: { from: number; to: number } | null
): { from: number; to: number } | null {
  if (!a) return b
  if (!b) return a
  return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) }
}

/* ------------------------------------------------------------------ */
/* The plugin                                                          */
/* ------------------------------------------------------------------ */

/**
 * "pretext" (the default) computes paragraphs and headings with Pretext and
 * reads only the blocks it can't model from the DOM. "dom" reads every
 * block's layout from the DOM.
 */
export type MeasurerKind = "dom" | "pretext"

export function paginationPlugin(
  options: { onReflow?: (report: ReflowReport) => void; measurer?: MeasurerKind } = {}
) {
  // The widget pools, shared by state.apply and the view: element i is
  // created once and re-inserted forever after. A break between two table
  // rows takes its widget from the row pool, `columns` wide.
  const pool = new Map<number, HTMLElement>()
  const rowPool = new Map<number, HTMLElement>()
  let audit: ReflowAudit | null = null

  const takeFromPool = (i: number, { inset, columns }: { inset: number; columns: number }) => {
    const kind = columns > 0 ? rowPool : pool
    let el = kind.get(i)
    if (!el) {
      el = makeGapDOM(i, columns > 0)
      kind.set(i, el)
      audit?.created(el)
    } else {
      // The break moved and PM is re-creating this widget's desc while the
      // pooled element is still attached at the OLD position. Detach it
      // here: renderDescs then inserts it at the new position with one
      // insertBefore. Left attached, renderDescs would instead "walk" the
      // DOM cursor to the old position by removing and re-inserting every
      // block in between — exactly the churn rule 3 forbids.
      el.remove()
    }
    if (columns > 0) setGapColspan(el, columns)
    setGapVar(el, "--inset", inset)
    return el
  }

  return new Plugin<PaginationState>({
    key: paginationKey,

    state: {
      init: (_, state): PaginationState => ({
        decos: DecorationSet.empty,
        layout: emptyLayout(geometryOf(state.doc.attrs)),
        dirty: null,
        measurer: options.measurer ?? "pretext",
        full: false,
      }),

      /**
       * Pure position bookkeeping. Two jobs:
       *  1. Keep stored positions valid: decorations map themselves through
       *     tr.mapping; the dirty range is remapped the same way.
       *  2. Widen the dirty range by whatever this transaction changed, or
       *     replace the layout entirely when the pass reports in.
       */
      apply(tr: Transaction, prev: PaginationState): PaginationState {
        const full = tr.getMeta(paginationKey) as FullMeta | undefined
        // New margins or base font change every block's layout, and the
        // step that sets a doc attr maps no positions, so it would leave
        // nothing dirty.
        const docAttrsChanged =
          tr.docChanged &&
          (tr.before.attrs.margins !== tr.doc.attrs.margins || tr.before.attrs.font !== tr.doc.attrs.font)
        if (full?.type === "full" || docAttrsChanged) {
          return {
            ...prev,
            measurer: full?.measurer ?? prev.measurer,
            decos: prev.decos.map(tr.mapping, tr.doc),
            dirty: { from: 0, to: tr.doc.content.size },
            full: true,
          }
        }

        // One pass runs per task, so several transactions may precede it:
        // the dirty range carries over, remapped, and widens by this one.
        const dirty = unionRange(remapRange(prev.dirty, tr), touchedRange(tr))
        let next: PaginationState = { ...prev, decos: prev.decos.map(tr.mapping, tr.doc), dirty }

        const meta = tr.getMeta(paginationKey) as LayoutMeta | undefined
        if (meta && meta.type === "layout") {
          const widgets = meta.layout.breaks.map((b, i) => {
            const site = breakSite(tr.doc, b.pos)
            return Decoration.widget(b.pos, () => takeFromPool(i, site), {
              key: site.columns > 0 ? `page-gap-row-${i}-${site.columns}` : `page-gap-${i}-${site.inset}`,
              side: -1,
              marks: [],
            })
          })
          next = {
            ...next,
            layout: meta.layout,
            decos: DecorationSet.create(tr.doc, widgets),
            dirty: null,
            full: false,
          }
        }
        return next
      },
    },

    props: {
      decorations(state: EditorState) {
        return paginationKey.getState(state)!.decos
      },
    },

    view(view: EditorView) {
      const stack = view.dom.parentElement as HTMLElement
      if (!stack) throw new Error("paginationPlugin: editor must be mounted inside .paper-stack")

      const cache: MeasureCache = new WeakMap()
      const reflowAudit = createReflowAudit(stack)
      audit = reflowAudit

      let queued = false
      let pendingFull = false
      let destroyed = false
      let passCount = 0

      const schedule = (full = false) => {
        if (destroyed) return
        if (full) pendingFull = true
        if (queued) return
        queued = true
        // Not synchronously: update() runs inside a dispatch, and the pass
        // dispatches its own meta-transaction.
        queueMicrotask(() => {
          queued = false
          pass()
        })
      }

      const pass = () => {
        if (destroyed) return
        const state = paginationKey.getState(view.state)!
        const full = pendingFull
        pendingFull = false
        // Idempotence guard: with no dirty range and nothing new to measure,
        // a pass must do nothing at all.
        if (!full && state.dirty == null && passCount > 0) return
        const t0 = performance.now()

        // The document's margins set the column width the measurers read
        // and the page height the solver fills; the CSS follows them first.
        const geometry = geometryOf(view.state.doc.attrs)
        applyGeometry(stack, geometry)
        const measureCalls = startMeter()
        const measurers =
          state.measurer === "pretext" ? [pretextMeasurer(view), domMeasurer(view)] : [domMeasurer(view)]
        const result = runPass({ doc: view.state.doc, geometry, measurers, dirty: state.dirty, full, cache })
        stopMeter()
        const { layout } = result

        // DECORATE: one meta-transaction, audited.
        reflowAudit.begin()
        const t2 = performance.now()
        const applyCalls = startMeter()
        paintSheets(stack, layout)
        view.dispatch(view.state.tr.setMeta(paginationKey, { type: "layout", layout } satisfies LayoutMeta))
        // Sync the widget visuals (--push). PM ignores mutations on widgets
        // (ignoreMutation), so these writes never trigger DOM
        // reconciliation. Every write is change-checked: a stable layout
        // performs zero DOM operations.
        for (const p of [pool, rowPool]) layout.breaks.forEach((b, i) => p.has(i) && setGapVar(p.get(i)!, "--push", b.remaining))
        stopMeter()
        const { ops, counts } = reflowAudit.end()
        const t3 = performance.now()

        passCount++
        options.onReflow?.({
          pass: passCount,
          pageCount: layout.pages.length,
          breakPositions: layout.breaks.map((b) => b.pos),
          remainders: layout.breaks.map((b) => b.remaining),
          durationMs: t3 - t0,
          measuredCount: result.measured,
          totalBlocks: result.total,
          phaseMs: { measure: result.ms.measure, solve: result.ms.solve, apply: t3 - t2 },
          apiCalls: { measure: measureCalls, apply: applyCalls },
          fullRecompute: full,
          ops,
          counts,
        })
      }

      schedule()

      return {
        update() {
          const s = paginationKey.getState(view.state)!
          if (s.dirty != null) schedule(s.full)
        },
        destroy() {
          destroyed = true
          reflowAudit.disconnect()
          audit = null
          for (const el of [...pool.values(), ...rowPool.values()]) el.remove()
          pool.clear()
          rowPool.clear()
        },
      }
    },
  })
}
