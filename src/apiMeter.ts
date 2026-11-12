/**
 * Counts calls to browser APIs that cost something while a pagination pass
 * runs, for the dev panel. installApiMeter() wraps the APIs once; until it
 * is called, meter() only runs its function, so the plugin works unmetered.
 *
 * "layout" calls force the browser to compute layout (or style) if it is
 * stale; "text" calls shape or segment text.
 */
export type ApiCounts = Record<string, number>

export const API_KIND: Record<string, "layout" | "text"> = {}

let current: ApiCounts | null = null
let installed = false

function bump(name: string) {
  if (current) current[name] = (current[name] ?? 0) + 1
}

function wrapMethod(proto: object | undefined, method: string, name: string, kind: "layout" | "text") {
  const target = proto as Record<string, unknown> | undefined
  const original = target?.[method]
  if (typeof original !== "function") return
  API_KIND[name] = kind
  target![method] = function (this: unknown, ...args: unknown[]) {
    bump(name)
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  }
}

function wrapGetter(proto: object, prop: string, name: string) {
  const desc = Object.getOwnPropertyDescriptor(proto, prop)
  if (!desc?.get) return
  const get = desc.get
  API_KIND[name] = "layout"
  Object.defineProperty(proto, prop, {
    ...desc,
    get(this: unknown) {
      bump(name)
      return get.call(this)
    },
  })
}

export function installApiMeter() {
  if (installed || typeof window === "undefined") return
  installed = true
  wrapMethod(Element.prototype, "getBoundingClientRect", "Element.getBoundingClientRect", "layout")
  wrapMethod(Element.prototype, "getClientRects", "Element.getClientRects", "layout")
  wrapMethod(Range.prototype, "getBoundingClientRect", "Range.getBoundingClientRect", "layout")
  wrapMethod(Range.prototype, "getClientRects", "Range.getClientRects", "layout")
  wrapMethod(window, "getComputedStyle", "getComputedStyle", "layout")
  for (const prop of ["clientWidth", "clientHeight", "scrollWidth", "scrollHeight", "scrollTop"]) {
    wrapGetter(Element.prototype, prop, `Element.${prop}`)
  }
  for (const prop of ["offsetWidth", "offsetHeight", "offsetTop", "offsetLeft"]) {
    wrapGetter(HTMLElement.prototype, prop, `HTMLElement.${prop}`)
  }
  wrapMethod(globalThis.CanvasRenderingContext2D?.prototype, "measureText", "canvas measureText", "text")
  wrapMethod(globalThis.OffscreenCanvasRenderingContext2D?.prototype, "measureText", "canvas measureText", "text")
  wrapMethod(Intl.Segmenter?.prototype, "segment", "Intl.Segmenter.segment", "text")
}

/** Starts counting into a fresh ApiCounts; stopMeter() ends it. */
export function startMeter(): ApiCounts {
  current = {}
  return current
}

export function stopMeter() {
  current = null
}
