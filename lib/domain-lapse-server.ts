/**
 * lib/domain-lapse-server.ts
 *
 * Custom-domain lapse cleanup — the ONE place a seller's custom domain is
 * released, shared by:
 *   - the Stripe webhook (`customer.subscription.deleted`, recurring cadence), and
 *   - the one-time expiry sweep (epic 08 · promoter-program S2): a `one_time`
 *     grant lapses on READ (the gate closes with no auto-charge), but the physical
 *     provider/Supabase teardown has no webhook to fire it, so a periodic sweep
 *     releases domains whose dated grant has expired.
 *
 * Best-effort by design — a provider hiccup must never throw out of a webhook
 * (Stripe would retry the whole event) or abort the sweep mid-batch.
 *
 * server-only (Cloudflare API + Supabase + Telegram + `next/cache`).
 */
import 'server-only'
import { db } from '@/lib/supabase'
import { removeDomainFromProject } from '@/lib/cloudflare-domains'
import { SHOP_DOMAINS_TAG } from '@/lib/custom-domain'
import { tg } from '@/lib/telegram'
import { readDomainGrant, isOneTimeGrantLive } from '@/lib/domain-entitlement'
import { revalidateTag } from 'next/cache'
import { resolveDomainEntitlement } from '@/lib/domain-entitlement-server'
import { resolvePlan } from '@/lib/plan-server'
import { decideDomainRelease } from '@/lib/plan'

/**
 * Release the seller's custom domain from the provider, null it in Supabase, and
 * stamp `metadata.custom_domain_lapsed` so Canal shows the "re-activate to restore
 * your domain" prompt. The free subdomain + slug are untouched (the shop stays
 * reachable). `reason` only flavors the Telegram alert.
 */
export async function releaseCustomDomainForShop(
  shopId: string | undefined,
  reason: 'subscription_canceled' | 'one_time_expired' | 'negocio_ended' = 'subscription_canceled',
): Promise<void> {
  if (!shopId) return
  try {
    const { data: shop } = await db
      .from('marketplace_shops')
      .select('custom_domain, metadata, clerk_user_id')
      .eq('id', shopId)
      .maybeSingle()
    // A bad/stale shopId would otherwise write 0 rows silently and still alert a
    // "disconnect" — surface it instead of faking success.
    if (!shop) {
      console.error('[custom-domain lapse] no shop row for id', shopId)
      return
    }

    const domain = (shop as { custom_domain?: string | null } | null)?.custom_domain
    // Release only a domain the shop is no longer entitled to by ANY path: its own grant or standalone subscription,
    // or Negocio (plans-gratis-negocio D5). The rule is the pure `decideDomainRelease`.
    const ownerId = (shop as { clerk_user_id?: string | null }).clerk_user_id ?? undefined
    const meta0 = (shop as { metadata?: unknown }).metadata
    const entitled = (await resolveDomainEntitlement(meta0, { sellerClerkId: ownerId, shopId })).entitled
    const planUnavailable = entitled ? false : (await resolvePlan(meta0, { sellerClerkId: ownerId ?? null, shopId })).reason === 'unavailable'
    const decision = decideDomainRelease({ reason, hasDomain: !!domain, entitled, planUnavailable })
    if (decision === 'keep_and_alert') {
      tg.alert(`⚠️ Dominio propio NO liberado: no se pudo leer el plan de la tienda (${reason}). Revisar.\nShop: ${shopId}`)
    }
    if (decision !== 'release') return
    if (domain) {
      try {
        await removeDomainFromProject(domain)
      } catch (err) {
        console.error('[custom-domain lapse] removeDomainFromProject failed:', err)
      }
    }

    const meta = ((shop as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>
    meta.custom_domain_lapsed = { at: new Date().toISOString() }

    await db
      .from('marketplace_shops')
      .update({
        custom_domain: null,
        custom_domain_verified: false,
        custom_domain_vercel_ok: false,
        metadata: meta,
      })
      .eq('id', shopId)

    // Drop the reverse lookup so the platform stops redirecting to the now-dead host.
    revalidateTag(SHOP_DOMAINS_TAG, 'default')
    const why = reason === 'one_time_expired' ? 'pago único expiró' : 'suscripción cancelada'
    tg.alert(`🔻 Dominio propio desconectado (${why})\nShop: ${shopId}\nDominio: ${domain ?? '—'}`)
  } catch (e) {
    console.error('[custom-domain lapse] release failed:', e)
  }
}

/**
 * Sweep: disconnect every shop whose one-time domain grant has expired but still
 * has a live `custom_domain`. The entitlement already reads `none` on expiry (the
 * gate is closed); this completes the physical teardown. Idempotent — a shop with
 * no live domain is skipped, and `releaseCustomDomainForShop` nulls the domain so a
 * re-run is a no-op. Returns the count released. Driven by the daily prod routine.
 */
export async function sweepExpiredOneTimeGrants(now: Date = new Date()): Promise<{ released: number }> {
  // Only shops that still hold a connected custom domain can need teardown.
  const { data, error } = await db
    .from('marketplace_shops')
    .select('id, metadata, custom_domain')
    .not('custom_domain', 'is', null)
  if (error || !data) return { released: 0 }

  let released = 0
  for (const shop of data as Array<{ id: string; metadata: unknown; custom_domain: string | null }>) {
    const grant = readDomainGrant(shop.metadata)
    const expiredOneTime = grant?.type === 'one_time' && !isOneTimeGrantLive(grant, now)
    if (expiredOneTime && shop.custom_domain) {
      await releaseCustomDomainForShop(shop.id, 'one_time_expired')
      released += 1
    }
  }
  return { released }
}
