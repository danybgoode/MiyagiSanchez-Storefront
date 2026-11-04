/**
 * lib/promoter-grant-server.ts
 *
 * Promoter Funnel v2 · Sprint 4 (US-4.2) — activate a SKU on admin approval of a
 * net-remittance transfer, via the SAME grant primitive every existing paid path
 * already writes with (`buildOneTimeGrant` from lib/domain-entitlement.ts) — no
 * new money/activation path. A NEW, more general writer alongside (not a
 * replacement for) `lib/promoter-subdomain-grant-server.ts#grantFreeSubdomainYear`,
 * which stays exactly as shipped for the $0-price case; this one covers the
 * paid-via-transfer case for all three close-workspace SKUs
 * (custom_domain / subdomain / ml_sync).
 *
 * Mirrors `grantFreeSubdomainYear`'s exact safety discipline: read-modify-write
 * `marketplace_shops.metadata`, verify the write affected a row (a `.eq` matching
 * 0 rows returns no error — the classic silent 0-row write), alert on
 * failure/success rather than silently reporting either.
 *
 * server-only (Supabase + Telegram).
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { tg } from '@/lib/telegram'
import { buildOneTimeGrant } from '@/lib/domain-entitlement'
import { SKU_GRANT_KEYS, type TransferSku } from '@/lib/promoter-transfer'
import { PACKAGES, isPackageSku } from '@/lib/promoter-packages'
import { applyNegocioPayment } from '@/lib/negocio-webhook'

export type ActivateGrantResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Mint the dated one-time grant on a shop's metadata for the given SKU. Reuses
 * the exact grant shape every entitlement reader already derives from
 * (`readDomainGrant` / `SUBDOMAIN_GRANT_KEY` reader / `ML_SYNC_GRANT_KEY`
 * reader), so activation here is indistinguishable from a Stripe-webhook grant.
 * Idempotent: re-running for an already-granted shop just re-stamps the same
 * one-year term (mirrors the webhook's own idempotency — a retry is safe).
 */
export async function activatePromoterOneTimeGrant(input: {
  sku: TransferSku
  shopId: string
  promoterId: string
  sellerClerkId: string
  note?: string
  /** A stable id for this payment (e.g. `transfer:<id>`), so a retried approval can never add Negocio twice. */
  paymentId?: string
}): Promise<ActivateGrantResult> {
  const { sku, shopId, promoterId, sellerClerkId, note = 'S4 transfer' } = input

  // plans-gratis-negocio S4 (D12): a package adds its months of Negocio through the same replay-safe compare-and-swap
  // the yearly payment uses; the free-plan setup grants nothing (the shop's own trial still runs).
  if (isPackageSku(sku)) {
    const months = PACKAGES[sku].negocioMonths
    if (months === 0) return { ok: true }
    try {
      const outcome = await applyNegocioPayment({
        shopId,
        paymentId: input.paymentId ?? `transfer:${promoterId}:${shopId}:${sku}`,
        months,
        note: `promoter ${sku}`,
      })
      if (outcome === 'comp') {
        tg.alert(`⚠️ Paquete aprobado en una tienda que ya tenía Negocio sin costo — revisar reembolso.\nShop: ${shopId}\nPromotor: ${promoterId}`)
        return { ok: true }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('[promoter grant] package activation failed:', message)
      tg.alert(`🚨 Paquete aprobado pero NO se activó Negocio (${sku}) — reparar a mano.\nShop: ${shopId}\nPromotor: ${promoterId}\nError: ${message}`)
      return { ok: false, error: 'No se pudo activar Negocio.' }
    }
    tg.alert(`✅ Paquete aprobado — Negocio ${months} meses\nShop: ${shopId}\nPromotor: ${promoterId}`)
    return { ok: true }
  }
  const grantKey = SKU_GRANT_KEYS[sku]

  try {
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('metadata')
      .eq('id', shopId)
      .maybeSingle()
    if (!shop) throw new Error(`no shop row for id ${shopId}`)
    const meta = (shop.metadata ?? {}) as Record<string, unknown>
    meta[grantKey] = buildOneTimeGrant({ note })
    const { data: updated, error } = await db
      .from('marketplace_shops')
      .update({ metadata: meta })
      .eq('id', shopId)
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) throw new Error(`grant update matched 0 rows for id ${shopId}`)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[promoter grant] transfer activation failed:', message)
    tg.alert(
      `🚨 Transferencia aprobada pero NO se activó (${sku}) — reparar a mano.\n` +
      `Shop: ${shopId}\nSeller: ${sellerClerkId}\nPromotor: ${promoterId}\nError: ${message}`,
    )
    return { ok: false, error: 'No se pudo activar el producto.' }
  }

  tg.alert(`✅ Transferencia aprobada — ${sku} activado\nShop: ${shopId}\nPromotor: ${promoterId}`)
  return { ok: true }
}
