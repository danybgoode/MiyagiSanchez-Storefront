/**
 * lib/share-link.ts
 *
 * Pure "share to WhatsApp" link builder — extracted from components/SuccessCard.tsx
 * (Sprint 2) so the S8 Comparte share card (Sprint 3 · Story 3.2) reuses the exact
 * same implementation instead of a third hand-rolled `wa.me/?text=` builder.
 * Not to be confused with app/components/SellerTrustCard.tsx's `whatsappUrl` — that
 * one messages a SPECIFIC phone number (a buyer contacting a seller); this one is a
 * generic "share to anyone" link with no phone target.
 */
import { SHORTLINK_ORIGIN } from './shortlink'

export function buildWhatsAppShareLink(shareTitle: string, shareUrl: string): string {
  const message = `${shareTitle}: ${shareUrl}`
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

/**
 * A shop slug as the platform mints them: lowercase letters and digits in hyphen-separated runs. Anything else is
 * refused before it is put into a URL, a QR code, a filename or a backend query — the value comes from a database
 * row, and a row is not proof of its own shape.
 */
export const SHOP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isShopSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && SHOP_SLUG.test(value)
}

/**
 * A shop's short branded link, `mschz.org/<slug>` (prompt-to-shop S5.2). The short-link host resolves a single segment
 * to a live shop slug FIRST, so a shop's own slug is its shortest stable link. `null` for a slug that is not one.
 */
export function shopShortLink(slug: string): string | null {
  return isShopSlug(slug) ? `${SHORTLINK_ORIGIN}/${slug}` : null
}

/** What the shop QR route encodes and how it names the download — or nothing, for a slug that is not one. */
export function shopQrPlan(slug: unknown): { url: string; filename: string } | null {
  if (!isShopSlug(slug)) return null
  return { url: `${SHORTLINK_ORIGIN}/${slug}`, filename: `${slug}-qr.png` }
}
