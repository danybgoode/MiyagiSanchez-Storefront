import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { resolveDomainEntitlement } from '@/lib/domain-entitlement-server'
import { resolveSubdomainEntitlement } from '@/lib/subdomain-entitlement-server'
import { getSubdomainSubscription } from '@/lib/subdomain-subscription'
import { SellerBreadcrumb } from '../SellerBreadcrumb'
import CanalPropioClient from './CanalPropioClient'
import type { SettingsTree } from '@/lib/shop-settings/types'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Canales — Configuración' }

/**
 * Canal propio — custom domain / subdomain / free-URL / embed federation
 * (catalog-management epic, Sprint 6 · Story 6.2). Split out of the settings
 * `canal` section (formerly `Canal.tsx`, bundled with the support widget) into
 * its own page under the Catálogo nav group. Behavior-preserving: the same
 * entitlement resolution that used to live in `settings/[section]/page.tsx`'s
 * `section === 'canal'` branch moves here wholesale — no logic change, just a
 * new home. The support widget moved to its own settings card instead
 * (`settings/_sections/Apoyo.tsx`, reachable at `/shop/manage/settings/apoyo`).
 */
export default async function CanalPropioPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, slug, custom_domain, custom_domain_verified, metadata')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!shop) redirect('/sell')

  const meta = shop.metadata as Record<string, unknown> | null
  const settings = (meta?.settings ?? {}) as Record<string, unknown>
  const st = settings as SettingsTree

  // Custom-domain paywall: resolve entitlement (epic: custom-domain-paywall).
  const domainEntitled = (await resolveDomainEntitlement(shop.metadata, { sellerClerkId: user.id, shopId: shop.id })).entitled

  // Subdomain paywall (epic 07 · subdomain-pricing): one getSubdomainSubscription
  // call feeds both the entitlement deriver (via hasActiveSubscription, no double
  // round-trip) and the UI's active/monthly flags.
  const subdomainSub = await getSubdomainSubscription(user.id)
  const subdomainEntitled = (await resolveSubdomainEntitlement(shop.metadata, { hasActiveSubscription: subdomainSub?.active })).entitled

  // Promoter Program (promoter.enabled, default OFF / fail-open) — the
  // custom-domain SKU lives here, so the promoter-code field + discount
  // preview gate reads the same flag the settings section used to.
  const promoterEnabled = await isEnabled('promoter.enabled')

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div style={{ marginBottom: 20 }}>
        <SellerBreadcrumb extra={[{ label: 'Canales', href: null }]} />
        <h1 style={{ fontWeight: 700, fontSize: 22, marginTop: 8 }}>Canales</h1>
      </div>

      <CanalPropioClient
        initial={{
          slug: shop.slug,
          custom_domain: shop.custom_domain ?? null,
          custom_domain_verified: shop.custom_domain_verified ?? false,
          accent: st.theme?.accent_color ?? null,
          domain_entitled: domainEntitled,
          domain_lapsed: !!(meta?.custom_domain_lapsed),
          promoter_enabled: promoterEnabled,
          subdomain_entitled: subdomainEntitled,
          subdomain_active: subdomainSub?.active ?? false,
          subdomain_has_monthly: !!subdomainSub?.monthly_stripe_price_id,
          subdomain_lapsed: !!(meta?.subdomain_lapsed),
        }}
      />
    </div>
  )
}
