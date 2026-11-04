/**
 * Promoter Program — Sprint 4 "in-person close" pure helpers.
 *
 * Next-free + dependency-free (no supabase, no `next/*`, no `server-only`) so the
 * WhatsApp-link builder, the synthetic provenance URL, and the paid-by-promoter
 * provenance marker are directly unit-testable (e2e/promoter-close.spec.ts) —
 * same discipline as lib/promoter.ts. The DB / Stripe / Medusa side lives in the
 * route handlers that import these.
 */

import { normalizePromoterCode } from '@/lib/promoter'

/**
 * Stripe Checkout metadata values must be strings — the marker that distinguishes
 * a promoter paying on a seller's behalf from an ordinary seller-self checkout.
 */
export const PAID_BY_PROMOTER_FLAG = '1'

/** The note stamped on the one-time domain grant, so the provenance is auditable
 *  on the shop's metadata (vs the S2 seller-self note). */
export function oneTimeGrantNote(paidByPromoter: boolean): string {
  return paidByPromoter ? 'one-time S4 paid-by-promoter' : 'one-time S2'
}

/**
 * A stable synthetic `source_url` for a promoter-minted unclaimed seller, so the
 * backend `/internal/sellers` mint stays idempotent (re-running setup for the same
 * promoter + shop name returns the existing seller instead of duplicating). Mirrors
 * the `source_url` provenance the supply/gem importer relies on, in a distinct
 * `promoter://` namespace so the two pipelines never collide.
 */
export function promoterSourceUrl(promoterCode: string, shopName: string): string {
  const code = normalizePromoterCode(promoterCode)
  const slug = (shopName ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `promoter://${code}/${slug || 'tienda'}`
}

/**
 * Build a one-tap WhatsApp share link that carries the claim URL + a short es-MX
 * pitch. `https://wa.me/?text=…` opens WhatsApp's share sheet (the promoter picks
 * the merchant's chat) — no phone number required. The claim URL itself is the
 * 24h-expiry signed token from lib/claimJwt (signed by the caller, passed in).
 */
export function buildWhatsAppClaimLink(input: { claimUrl: string; shopName: string }): string {
  const { claimUrl, shopName } = input
  const name = (shopName ?? '').trim() || 'tu tienda'
  const message =
    `¡Hola! Ya dejé lista *${name}* en miyagisanchez.com. ` +
    `Toca este enlace para reclamarla y administrarla tú (vence en 24 h):\n${claimUrl}`
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

/**
 * Is a shop the calling promoter's own? `POST /api/promoter/shop/setup` stamps
 * every promoter-created shop with `source_url: promoter://<CODE>/<name>` (see
 * `promoterSourceUrl` above), so the promoter's own code in that provenance IS the
 * binding — this is the parser for the URL that builder writes.
 *
 * Consent-safe previews (S1.2) needs it because `resolveTargetShop` deliberately
 * does not filter by promoter (a promoter acts on shops they hold no Clerk session
 * for), which would otherwise let a bound promoter mint or revoke a preview link
 * for a DIFFERENT promoter's merchant.
 *
 * NOTE: the pre-existing `close/*` routes share that unscoped shape and do not
 * call this — tightening them is a separate change with its own blast radius,
 * flagged on the epic's PR rather than silently folded in here.
 */
export function isPromoterShopOwner(
  shop: { sourceUrl: string | null },
  promoterCode: string,
): boolean {
  const code = normalizePromoterCode(promoterCode ?? '')
  if (!code || !shop.sourceUrl) return false
  // The trailing slash makes the boundary exact, so `PRM-AB` can't match a
  // `promoter://PRM-ABC/…` shop.
  return shop.sourceUrl.toUpperCase().startsWith(`promoter://${code}/`.toUpperCase())
}

/**
 * May this promoter anchor a preview on this shop? TWO independent conditions,
 * both required — this is the guard that makes a storefront takedown impossible
 * rather than merely undoable:
 *
 *  1. **Promoter binding.** `resolveTargetShop` deliberately doesn't filter by
 *     promoter, so without this any bound promoter could anchor a preview on any
 *     shop they can name — and an anchor hides the storefront.
 *  2. **The shop must be UNCLAIMED.** A claimed shop belongs to a real merchant
 *     who is already trading; it is never a "proposal" awaiting consent. Refusing
 *     to anchor one means no promoter — bound, malicious, or merely mistaken —
 *     can 404 a live merchant's storefront by construction, independently of
 *     whether the binding check above is ever bypassed.
 *
 * Callers map `false` to the same 404 as a missing shop, never confirming that
 * someone else's shop exists.
 */
export function canAnchorPreview(
  shop: { sourceUrl: string | null; clerkUserId: string | null },
  promoterCode: string,
): boolean {
  if (shop.clerkUserId !== null) return false // claimed → never a preview subject
  return isPromoterShopOwner(shop, promoterCode)
}

/**
 * Was this shop opened by the promoter with this code? `promoterSourceUrl` stamps every shop the workspace opens with
 * `promoter://<code>/…`; the package close route accepts only such shops (or a relationship the promoter owns) —
 * plans-gratis-negocio S4.2, Codex security #474.
 */
export function promoterOpenedShop(sourceUrl: string | null | undefined, promoterCode: string): boolean {
  const code = normalizePromoterCode(promoterCode)
  return !!code && typeof sourceUrl === 'string' && sourceUrl.startsWith(`promoter://${code}/`)
}
