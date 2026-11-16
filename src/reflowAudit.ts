/**
 * A MutationObserver brackets the apply step of every pass; classify()
 * reduces its records to logical operations (a widget moved, a push changed,
 * a widget created) and counts anything else as "other". Reporting only.
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
  phaseMs: { measure: number; solve: number; apply: number }
  apiCalls: { measure: ApiCounts; apply: ApiCounts }
  fullRecompute: boolean
  ops: Array<{ kind: OpKind; text: string }>
  counts: ReflowOps
}

export interface AuditEnv {
  stack: Node
  created: Set<Node>
}

const isGap = (n: Node): n is HTMLElement => n.nodeType === 1 && (n as Element).classList.contains("page-gap")
const gapName = (el: HTMLElement) => `.page-gap-${el.dataset.page}`

export function classify(records: MutationRecord[], env: AuditEnv): { ops: ReflowReport["ops"]; counts: ReflowOps } {
  const ops: ReflowReport["ops"] = []
  const counts: ReflowOps = { setAttribute: 0, removeAttribute: 0, insertBefore: 0, create: 0, remove: 0, other: 0 }

  // A move can surface as one record or as separate remove+add records.
  const net = new Map<HTMLElement, { added: boolean; removed: boolean }>()
  const otherChildList: MutationRecord[] = []
  const textSplits: MutationRecord[] = []
  for (const r of records) {
    if (r.type !== "childList") continue
    // Moving an inline widget re-splits the text nodes around it: part of the move.
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

  // One logical change can be several records: collapse per (element,
  // attribute) to first old value vs the element's current value.
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
      // PM re-sets the ProseMirror-widget class unconditionally when re-creating widget descs.
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
  created(el: HTMLElement): void
  begin(): void
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
