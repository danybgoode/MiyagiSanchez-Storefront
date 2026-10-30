/**
 * Restoring a counter sale from sessionStorage after a reload (in-person-sales S1/S2). PURE.
 *
 * The S1 build saved frozen sales WITHOUT a `kind` (it only sold cash). A merchant who reloads
 * across the deploy would restore a sale with `kind` undefined, and an uncertain cash sale would
 * get stuck with no Reintentar. A missing or unknown kind is therefore cash, which is what every
 * sale was before kinds existed.
 */
const KINDS = new Set(['cash', 'card', 'transfer'])

export function parseStoredSale<T extends { sale: { kind: string } }>(raw: string | null): T | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (typeof v?.sale?.clientId !== 'string' || !Array.isArray(v.sale.lines) || !Array.isArray(v.cart?.lines) || typeof v.padText !== 'string') return null
    if (!KINDS.has(v.sale.kind)) v.sale.kind = 'cash'
    return v as T
  } catch {
    return null
  }
}
