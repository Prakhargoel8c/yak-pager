/**
 * REFLOW AUDIT — the empirical rule-3 log shown in the dev panel. A
 * MutationObserver brackets the apply step of every pass and records each
 * DOM operation the reflow performed; classify() reduces the raw records to
 * the logical operations (a widget moved, a push changed, a widget created)
 * and counts anything else as "other". Reporting only: pagination works the
 * same without it.
 */
import type { ApiCounts } from "./apiMeter"

export type OpKind = "setAttribute" | "removeAttribute" | "insertBefore" | "create" | "remove" | "other"

export type ReflowOps = Record<OpKind, number>

export interface ReflowReport {
  pass: number
  pageCount: number
  breakPositions: number[]
  remainders: number[]
  durationMs: number
  measuredCount: number
  totalBlocks: number
  /** Time spent measuring, solving, and applying the result. */
  phaseMs: { measure: number; solve: number; apply: number }
  /** Costly browser API calls made while measuring and while applying (apiMeter.ts). */
  apiCalls: { measure: ApiCounts; apply: ApiCounts }
  fullRecompute: boolean
  ops: Array<{ kind: OpKind; text: string }>
  counts: ReflowOps
}

export interface AuditEnv {
  /** The .paper-stack: attribute writes on it are scaffold, not content. */
  stack: Node
  /** Widgets created during this pass, as opposed to moved. */
  created: Set<Node>
}

const isGap = (n: Node): n is HTMLElement => n.nodeType === 1 && (n as Element).classList.contains("page-gap")
const gapName = (el: HTMLElement) => `.page-gap-${el.dataset.page}`

export function classify(records: MutationRecord[], env: AuditEnv): { ops: ReflowReport["ops"]; counts: ReflowOps } {
  const ops: ReflowReport["ops"] = []
  const counts: ReflowOps = { setAttribute: 0, removeAttribute: 0, insertBefore: 0, create: 0, remove: 0, other: 0 }

  // Widgets first: a move can surface as one record (node in both added and
  // removed) or as separate remove+add records, so reduce to a net
  // disposition per element before classifying.
  const net = new Map<HTMLElement, { added: boolean; removed: boolean }>()
  const otherChildList: MutationRecord[] = []
  const textSplits: MutationRecord[] = []
  for (const r of records) {
    if (r.type !== "childList") continue
    // Moving a widget that sits between two words re-splits the paragraph's
    // text nodes around the new position: part of the move, not churn.
    const nodes = [...r.addedNodes, ...r.removedNodes]
    if (nodes.length > 0 && nodes.every((n) => n.nodeType === 3)) {
      textSplits.push(r)
      continue
    }
    const gaps = nodes.filter(isGap)
    if (gaps.length === 0) otherChildList.push(r)
    for (const g of gaps) {
      const d = net.get(g) ?? { added: false, removed: false }
      if (Array.from(r.addedNodes).includes(g)) d.added = true
      if (Array.from(r.removedNodes).includes(g)) d.removed = true
      net.set(g, d)
    }
  }
  for (const [el, d] of net) {
    if (d.removed && !d.added) {
      ops.push({ kind: "remove", text: `remove ${gapName(el)} (page count shrank)` })
    } else if (d.added && !d.removed && env.created.has(el)) {
      ops.push({ kind: "create", text: `create ${gapName(el)} (page count grew)` })
    } else {
      ops.push({ kind: "insertBefore", text: `insertBefore ${gapName(el)} (element reused, not rebuilt)` })
    }
  }
  for (const r of textSplits) {
    ops.push({ kind: "insertBefore", text: `re-split #text in ${r.target.nodeName.toLowerCase()} (inline widget moved)` })
  }

  // Attribute records: prosemirror-view patches a style decoration by
  // removing the old properties and then appending the new value, so one
  // logical change can appear as two records. Collapse per (element,
  // attribute): first old value → the element's CURRENT value, the final
  // state of the window (classify runs in the same synchronous frame).
  const seen = new Map<HTMLElement, Map<string, string | null>>()
  for (const r of records) {
    if (r.type !== "attributes") continue
    const t = r.target as HTMLElement
    let m = seen.get(t)
    if (!m) seen.set(t, (m = new Map()))
    if (!m.has(r.attributeName!)) m.set(r.attributeName!, r.oldValue)
  }
  for (const [t, attrs] of seen) {
    for (const [name, firstOld] of attrs) {
      const final = t.getAttribute(name)
      // A no-op write: PM re-sets some attributes (the ProseMirror-widget
      // class) unconditionally when re-creating widget descs.
      if (firstOld != null && firstOld === final) continue
      if (t === env.stack) {
        ops.push({ kind: "setAttribute", text: `setAttribute ${name} on .paper-stack (scaffold, not content)` })
      } else if (t.classList.contains("page-gap")) {
        ops.push({
          kind: "setAttribute",
          text: `setAttribute ${name}="${final ?? ""}" on ${gapName(t)} (${name === "style" ? "--push" : "housekeeping"})`,
        })
      } else {
        ops.push({ kind: "other", text: `attribute ${name} on ${t.nodeName}` })
      }
    }
  }
  for (const r of otherChildList) {
    const n = r.addedNodes[0] ?? r.removedNodes[0]
    ops.push({ kind: "other", text: `childList ${r.addedNodes.length ? "+" : "-"}${n?.nodeName ?? "?"} under ${r.target.nodeName}` })
  }

  for (const op of ops) counts[op.kind]++
  return { ops, counts }
}

export interface ReflowAudit {
  /** A widget was created (not reused) during this pass. */
  created(el: HTMLElement): void
  /** The apply step starts: forget everything recorded before now. */
  begin(): void
  /** The apply step ended: the operations it performed. */
  end(): ReturnType<typeof classify>
  disconnect(): void
}

export function createReflowAudit(stack: HTMLElement): ReflowAudit {
  const mo = new MutationObserver(() => {})
  mo.observe(stack, { childList: true, subtree: true, attributes: true, attributeOldValue: true })
  const created = new Set<Node>()
  return {
    created: (el) => created.add(el),
    begin() {
      mo.takeRecords()
    },
    end() {
      const result = classify(mo.takeRecords(), { stack, created })
      created.clear()
      return result
    },
    disconnect: () => mo.disconnect(),
  }
}
