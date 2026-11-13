import { marketBasePath } from '@/lib/markets'
import { getLanguagePreference } from '@/lib/site-language-server'
import Link from 'next/link'
import { currentUser } from '@clerk/nextjs/server'
import SellerNav from '../SellerNav'
import SellerAnnouncementStrip from '../SellerAnnouncementStrip'
import { getActiveAnnouncement } from '@/lib/announcements'
import { isEnabled, type FlagKey } from '@/lib/flags'
import { SELLER_NAV } from '@/lib/seller-nav'
import { db } from '@/lib/supabase'
import { computeShopCompletion, completedSectionKeys, type ShopRow } from '@/lib/setup-guide'
import { orderedSections } from '@/lib/shop-settings/taxonomy'
import { getMySeller } from '@/lib/get-my-seller'
import { resolveSellerLocale } from '@/lib/seller-locale'
import LanguageSwitch from '@/app/components/LanguageSwitch'

/**
 * The seller-distinct shell chrome — dark brand top bar ("Volver a comprar") +
 * the announcement strip + the `SellerNav` rail/bar (incl. the flag-safe nav
 * parity + mobile badges/completion-pill data it needs). Extracted from
 * `app/(shell)/shop/manage/layout.tsx` (catalog-management epic, Sprint 6 ·
 * Story 6.1) so `app/(shell)/sell/layout.tsx` can render the identical shell
 * for a signed-in shop owner on `/sell`/`/sell/setup`, without duplicating this
 * data-fetching. Owns its own `getActiveAnnouncement('seller')` fetch (already
 * `unstable_cache`-backed, so two call sites in one request share the cache
 * entry, not two Supabase round-trips) — callers just render `<SellerShellChrome>`.
 *
 * Callers are responsible for their own white-label defer (checking the same
 * `x-miyagi-embed`/`x-miyagi-channel` headers) BEFORE rendering this — it does
 * not re-check white-label itself, to avoid a third independent header read.
 *
 * Renders unconditionally for whatever page it wraps, including a transiently
 * signed-out visitor (e.g. mid-redirect) — every read here degrades to a safe
 * empty default rather than throwing, same discipline the original
 * `shop/manage/layout.tsx` already followed.
 */
export default async function SellerShellChrome({ children }: { children: React.ReactNode }) {
  const announcement = await getActiveAnnouncement('seller')

  // R13 flag-safe nav parity (catalog-management S5 · Story 5.1): resolve every
  // distinct flag the nav config references via the SAME isEnabled() the gated
  // pages use — never fork the read — so a flagged entry (e.g. Ganancias) only
  // renders when its page would actually resolve.
  const navFlagKeys = Array.from(new Set(
    SELLER_NAV.flatMap(group => group.entries.map(entry => entry.flag)).filter((f): f is FlagKey => !!f)
  ))
  const navFlagResults = await Promise.all(navFlagKeys.map(flag => isEnabled(flag)))
  const enabledFlags = new Set<FlagKey>(navFlagKeys.filter((_, i) => navFlagResults[i]))

  // Mobile bar badges + Configuración pill + "Ver tienda pública" link (catalog-
  // management S5 · Story 5.2). One shop-row fetch feeds both the pending counts
  // and the completion flags (same columns `settings/page.tsx` already selects),
  // so the badge/pill data never drifts from what those pages compute.
  const user = await currentUser()
  const { data: shop, error: shopError } = user
    ? await db
        .from('marketplace_shops')
        .select('id, slug, name, description, metadata, mp_enabled, custom_domain, ucp_webhook_url')
        .eq('clerk_user_id', user.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
    : { data: null, error: null }
  if (shopError) console.error('[SellerShellChrome] shop lookup failed:', shopError)

  let badges: Partial<Record<string, number>> = {}
  let configIncomplete = false
  const shopSlug = (shop?.slug as string | undefined) ?? null

  // The nav language comes from MEDUSA, not from the Supabase mirror above (D17).
  // The mirror is a projection and is explicitly not authoritative for
  // `operating_market`; reading it here would make the portal's language depend on
  // whether a sync had run. `getMySeller` is request-memoized, and the seller shell
  // already calls it upstream, so this costs no extra round-trip.
  const seller = await getMySeller()
  const market = seller?.market ?? 'mx'
  const locale = resolveSellerLocale({
    preference: await getLanguagePreference(),
    market,
  })

  if (shop?.id) {
    const [{ count: pendingOrdersCount, error: ordersError }, { count: pendingOffersCount, error: offersError }] = await Promise.all([
      db.from('marketplace_orders').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).in('status', ['paid', 'processing']),
      db.from('marketplace_offers').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).eq('status', 'pending'),
    ])
    if (ordersError) console.error('[SellerShellChrome] pending-orders count failed:', ordersError)
    if (offersError) console.error('[SellerShellChrome] pending-offers count failed:', offersError)
    badges = { pedidos: pendingOrdersCount ?? 0, ofertas: pendingOffersCount ?? 0 }

    const completion = computeShopCompletion(shop as unknown as ShopRow)
    configIncomplete = completedSectionKeys(completion).size < orderedSections().length
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {/* ── Dark brand top bar ── (brand-accent surface; --fg-inverse on --accent
          is the documented AA pair, theme-safe and design-token-guard clean).

          Mobile-first: the bar carries three things and a phone has room for one
          and a half, so the two long labels collapse to their icons under `sm`
          and only the language toggle — which is already two characters — stays
          at full size. `min-w-0` + `truncate` on the brand is what stops the
          flex row squeezing the toggle instead of the text. */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          background: 'var(--accent)',
          color: 'var(--fg-inverse)',
        }}
      >
        <div
          className="app-shell"
          style={{
            minHeight: 52,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <span
            className="min-w-0"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontWeight: 600,
              fontSize: 14,
              fontFamily: 'var(--font-display, var(--font-sans))',
              color: 'var(--fg-inverse)',
            }}
          >
            <i className="iconoir-shop" style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }} />
            <span className="truncate">
              <span className="hidden sm:inline">Miyagi Sánchez · </span>
              {locale === 'en' ? 'Seller' : 'Vendedor'}
            </span>
          </span>

          <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <LanguageSwitch current={locale} variant="inverse" />
            {/* The seller's own marketplace, not `/` — `/` is the shop builder now, not shopping, and it used to hop the
                visitor by browser language, dropping the language they had just chosen here (2026-11-13). */}
            <Link
              href={marketBasePath(market)}
              title={locale === 'en' ? 'Back to shopping' : 'Volver a comprar'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                textDecoration: 'none',
                fontSize: 13,
                fontFamily: 'var(--font-sans)',
                color: 'var(--fg-inverse)',
                opacity: 0.92,
                // 44px thumb target even when it renders as a bare icon.
                minHeight: 44,
                minWidth: 44,
                justifyContent: 'flex-end',
              }}
            >
              <i className="iconoir-arrow-left" style={{ fontSize: 16, lineHeight: 1 }} />
              <span className="hidden sm:inline">
                {locale === 'en' ? 'Back to shopping' : 'Volver a comprar'}
              </span>
            </Link>
          </span>
        </div>
      </div>

      <SellerAnnouncementStrip
        announcement={
          announcement && { id: announcement.id, text: announcement.text, ctaLabel: announcement.ctaLabel, ctaLink: announcement.ctaLink }
        }
      />

      {/* ── Rail + content ── */}
      <div
        className="app-shell"
        style={{
          display: 'flex',
          gap: 24,
          alignItems: 'flex-start',
          paddingTop: 20,
        }}
      >
        <SellerNav enabledFlags={enabledFlags} badges={badges} configIncomplete={configIncomplete} shopSlug={shopSlug} locale={locale} />
        <main
          style={{
            flex: 1,
            minWidth: 0,
            // Reserve room for the fixed mobile seller bar (no-op on desktop).
            paddingBottom: 'calc(80px + env(safe-area-inset-bottom))',
          }}
        >
          {children}
        </main>
      </div>
    </div>
  )
}
