/**
 * The merchant's WhatsApp, defined once (share-kit D3).
 *
 * The PDP's contact card (`ListingRenderer`), the shop trust card's inputs (`lib/trust-inputs.ts`) and the share kit's
 * catalog all ask the same question — "may a buyer message this shop on WhatsApp, and at which number?" — and the
 * first two answered it with their own copy of the same expression. The consent switch is `checkout.whatsapp_cta`: a
 * number in the settings is not permission to put it on a public button.
 *
 * Pure: no `next/*`, so the `api` Playwright project unit-tests it.
 */

type ShopSettingsLike = {
  checkout?: { whatsapp_cta?: boolean | null; phone?: string | null } | null
  theme?: { social?: { whatsapp?: string | null } | null } | null
} | null | undefined

/** The number a buyer may message, or null when the merchant has not turned the WhatsApp button on. */
export function shopWhatsAppNumber(settings: ShopSettingsLike): string | null {
  if (!settings?.checkout?.whatsapp_cta) return null
  return settings.theme?.social?.whatsapp || settings.checkout.phone || null
}

/** `shopWhatsAppNumber` from a seller's `metadata` (where the settings live on the Medusa seller). */
export function shopWhatsAppNumberFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  return shopWhatsAppNumber((metadata as { settings?: ShopSettingsLike }).settings)
}

/**
 * A Mexican number as `wa.me` wants it: digits only, country code 52 in front unless it is already there. Moved
 * verbatim out of `SellerTrustCard.whatsappUrl`, which now imports it. Null when nothing dialable is left.
 */
export function whatsappDigits(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  return digits.startsWith('52') ? digits : `52${digits}`
}

/** A `wa.me` link to one number with a prefilled message. */
export function whatsappMessageLink(digits: string, text: string): string {
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}
