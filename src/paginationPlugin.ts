/**
 * Scheduling and decorating around the pass. apply() only does position
 * bookkeeping (it runs inside the transaction, so it never reads the DOM);
 * the view runs the pass in a microtask after the transaction that dirtied
 * it, before paint, once for all transactions in the same task, and applies
 * the layout in one meta-transaction. That transaction carries no steps, so
 * Ctrl+Z undoes typing, never pagination. Each break is one pooled gap
 * widget, between two blocks or between two words, moved with insertBefore.
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
  /** Must be re-measured before the next solve. */
  dirty: { from: number; to: number } | null
  measurer: MeasurerKind
  /** Fonts loaded, resize, measurer or document switch: the next pass also drops what the measurers cached. */
  full: boolean
}

export const paginationKey = new PluginKey<PaginationState>("pagination")

interface LayoutMeta {
  type: "layout"
  layout: Layout
}
interface FullMeta {
  type: "full"
  measurer?: MeasurerKind
}

export function requestFullRecompute(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(paginationKey, { type: "full" } satisfies FullMeta))
}

export function setMeasurer(view: EditorView, measurer: MeasurerKind) {
  view.dispatch(view.state.tr.setMeta(paginationKey, { type: "full", measurer } satisfies FullMeta))
}

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

/** "pretext" reads only the blocks Pretext can't model from the DOM; "dom" reads every block. */
export type MeasurerKind = "dom" | "pretext"

export function paginationPlugin(
  options: { onReflow?: (report: ReflowReport) => void; measurer?: MeasurerKind } = {}
) {
  // Element i is created once and re-inserted forever after; a break between two rows takes a <tr> from the row pool.
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
      // Still attached at the old position: detached here, renderDescs inserts
      // it at the new one with one insertBefore. Left attached, it would walk
      // its DOM cursor there by removing and re-inserting every block between.
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

      apply(tr: Transaction, prev: PaginationState): PaginationState {
        const full = tr.getMeta(paginationKey) as FullMeta | undefined
        // A doc attr step maps no positions, yet new margins or a new base font change every block.
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
        // update() runs inside a dispatch, and the pass dispatches its own transaction.
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
        if (!full && state.dirty == null && passCount > 0) return
        const t0 = performance.now()

        // The CSS follows the margins before the measurers read the column.
        const geometry = geometryOf(view.state.doc.attrs)
        applyGeometry(stack, geometry)
        const measureCalls = startMeter()
        const measurers =
          state.measurer === "pretext" ? [pretextMeasurer(view), domMeasurer(view)] : [domMeasurer(view)]
        const result = runPass({ doc: view.state.doc, geometry, measurers, dirty: state.dirty, full, cache })
        stopMeter()
        const { layout } = result

        reflowAudit.begin()
        const t2 = performance.now()
        const applyCalls = startMeter()
        paintSheets(stack, layout)
        view.dispatch(view.state.tr.setMeta(paginationKey, { type: "layout", layout } satisfies LayoutMeta))
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
