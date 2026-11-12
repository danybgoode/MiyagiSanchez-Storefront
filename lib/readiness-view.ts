/**
 * The new-listing form's «Antes de publicar» panel — the wire shape of `GET /api/sell/readiness` and the pure
 * decisions the panel renders from (epic listing-readiness S2.1). Client-safe: types and pure functions only.
 */
import type { BusinessShape } from './business-shape'
import type { ChooserState } from './prompt-to-shop/cobros'
import type { ListingReadiness, ReadinessMissing } from './listing-readiness'

export type ReadinessView =
  | { readonly state: 'no_shop' }
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'ok'
      readonly readiness: ListingReadiness
      readonly chooser: {
        readonly shopSlug: string
        readonly market: string
        readonly initial: ChooserState
        readonly correosAvailable: boolean
        readonly shape: BusinessShape
      }
    }

export type ChecklistRow = { readonly key: 'delivery' | 'payment'; readonly done: boolean; readonly missing?: ReadinessMissing }

/**
 * What the panel shows. `null` = no panel: the listing sells online, it is not a product, or we could not tell (the
 * server decides at publish, and its LISTING_NOT_READY answer re-opens the panel). Never a false «✓ listo».
 */
export function readinessChecklist(view: ReadinessView | null): readonly ChecklistRow[] | null {
  if (!view || view.state !== 'ok' || view.readiness.mode === 'online') return null
  const missing = view.readiness.missing
  if (missing.includes('manual_payment')) return [{ key: 'payment', done: false, missing: 'manual_payment' }]
  return [
    { key: 'delivery', done: !missing.includes('delivery'), ...(missing.includes('delivery') ? { missing: 'delivery' as const } : {}) },
    { key: 'payment', done: !missing.includes('payment'), ...(missing.includes('payment') ? { missing: 'payment' as const } : {}) },
  ]
}

/** The create route's answer that means "show the panel" (S1.2). */
export function isNotReadyAnswer(status: number, body: unknown): boolean {
  return status === 422 && !!body && typeof body === 'object' && (body as { code?: unknown }).code === 'LISTING_NOT_READY'
}
