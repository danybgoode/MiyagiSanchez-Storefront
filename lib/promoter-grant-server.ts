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
import { applyPackageGrants, isPackageSku } from '@/lib/promoter-packages'
import { PACKAGE_GRANT_DEPS, packageGrantsLine } from '@/lib/promoter-package-server'

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
  /** A stable id for this payment (e.g. `transfer:<id>`), so a retried approval can never add a package's months twice. */
  paymentId?: string
}): Promise<ActivateGrantResult> {
  const { sku, shopId, promoterId, sellerClerkId, note = 'S4 transfer' } = input

  // plan-tienda S4 (D11): a package writes its grants — Negocio, and for `tienda_anual` Tienda after it — dated from
  // the APPROVAL (the moment the platform confirms its share arrived), through the same replay-safe compare-and-swap
  // the card path uses. All under `transfer:<id>`, so an approval retried after a released claim completes a missing
  // half and repeats nothing (applyPackageGrants).
  //
  // The one `negocio_anual` transfer pending on 2026-11-09, if approved after this deploys, grants FIFTEEN months
  // (3 free + 12), not the 12 it was sold with: D11 decides the package's grants at approval time, and the merchant
  // gains three months. A retired package's pending transfer (none live on 2026-11-09) is still approved with its
  // original grants: only the SALE of a retired package is refused.
  if (isPackageSku(sku)) {
    let outcome: Awaited<ReturnType<typeof applyPackageGrants>>
    try {
      outcome = await applyPackageGrants(
        { sku, shopId, paymentId: input.paymentId ?? `transfer:${promoterId}:${shopId}:${sku}` },
        PACKAGE_GRANT_DEPS,
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('[promoter grant] package activation failed:', message)
      tg.alert(`🚨 Paquete aprobado pero el plan NO quedó completo (${sku}) — volver a aprobar lo completa sin repetir nada.\nShop: ${shopId}\nPromotor: ${promoterId}\nError: ${message}`)
      return { ok: false, error: 'No se pudo activar el plan.' }
    }
    if (outcome === 'comp') {
      tg.alert(`⚠️ Paquete aprobado en una tienda que ya tenía Negocio sin costo — revisar reembolso.\nShop: ${shopId}\nPromotor: ${promoterId}`)
      return { ok: true }
    }
    // Only when this approval wrote a grant: a re-approval that finds every grant counted (`replay`) says nothing new.
    if (outcome === 'written') tg.alert(`✅ Paquete aprobado — ${packageGrantsLine(sku)}\nShop: ${shopId}\nPromotor: ${promoterId}`)
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
