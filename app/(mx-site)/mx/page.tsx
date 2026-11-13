import { getLanguagePreference } from '@/lib/site-language-server'
import Link from 'next/link'
import Image from 'next/image'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import {
  getFeaturedListing,
  getCuratedListings,
  getCategoryCounts,
  getRecentListings,
  formatPrice,
  conditionLabel,
} from '@/lib/listings'
import { isRecentForBadge, isNewToday, excludeIds } from '@/lib/home-curation'
import type { Listing } from '@/lib/types'
import CategoryChips from '@/app/components/CategoryChips'
import FavoriteButton from '@/app/components/FavoriteButton'
import FavoritesProvider from '@/app/components/FavoritesProvider'
import HomePersonalizationProvider from '@/app/components/HomePersonalizationProvider'
import HomeRetomaOffers from '@/app/components/HomeRetomaOffers'
import HomeSellerModule from '@/app/components/HomeSellerModule'
import HomeAnnouncementCard from '@/app/components/HomeAnnouncementCard'
import AuthShow from '@/app/components/AuthShow'
import ComparadorTeaserCard from '@/app/components/ComparadorTeaserCard'
import {
  NEIGHBORHOOD_PULSE_COPY,
  printSocialTypeLabel,
  publicSubmitterLabel,
} from '@/lib/neighborhood-pulse'
import { getNeighborhoodPulseItems } from '@/lib/neighborhood-pulse-server'
import { getActiveAnnouncement } from '@/lib/announcements'
import { marketBasePath, type MarketCode } from '@/lib/markets'
import { sellerLandingPath } from '@/lib/seller-acquisition'
import { marketLandingMetadata } from '@/lib/market-seo'
import { resolveMarketPresentation } from '@/lib/market-presentation'
import { PROCESS_MARKET_ENV, resolvePublishableKeyForMarket } from '@/lib/market-medusa'
import type { Metadata } from 'next'
import { categoryLabel } from '@/lib/market-vocabulary'
import { PendingMark } from '@/app/components/LinkPending'

// Prerender `/mx` under its es-MX root document as a static CDN asset, revalidated on the curated-content window
// (= CACHE.LISTING, lib/cache-policy.ts SSOT — kept a literal because Next requires
// `revalidate` to be statically analyzable). This is what turns the homepage from a
// per-request function (~30 s cold-start) into an ISR-prerendered static page.
//
// MOVED VERBATIM from `app/(site)/page.tsx` in the market cutover (epic 07 ·
// market-architecture-foundation, D7): this is the same Mexico marketplace
// homepage at its new canonical address, and `revalidate = 60` is preserved
// because the ISR split it belongs to is what killed a ~30 s cold start
// (marketplace-static-shell). The only edits are the internal marketplace links,
// which now build from MX below instead of hard-coding the bare paths.
// 2026-11-13: per request, not ISR. The chrome follows the visitor's stored ES/EN choice (`lib/site-language.ts`),
// and a cookie-dependent render must never be cached for the next visitor. Data stays cached at the fetch layer.
export const dynamic = 'force-dynamic'

/**
 * The market this page IS. A literal, not a lookup: `app/(site)/mx/` is a
 * literal route segment (D7 — no root-level `[market]` dynamic segment), so the
 * market is known statically and nothing here has to resolve it per request.
 * That is also what keeps the page prerenderable.
 */
export const metadata: Metadata = marketLandingMetadata('mx')

// S3.2 — Recién llegado al barrio: how many cards to show once Selección overlaps
// are excluded (over-fetch past this via getRecentListings so there's room to filter).
const RECIEN_LLEGADO_SIZE = 4
const RECIEN_LLEGADO_FETCH_LIMIT = 12

function timeAgo(dateStr: string, language: 'es' | 'en'): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 2) return language === 'en' ? 'Just now' : 'Ahora mismo'
  if (mins < 60) return language === 'en' ? `${mins} min ago` : `Hace ${mins} min`
  const hrs = Math.floor(mins / 60)
  return language === 'en' ? `${hrs}h ago` : `Hace ${hrs} h`
}

/**
 * Marketplace homepage — the curated shell for EVERYONE, served as a static CDN asset
 * (marketplace-static-shell S2). Every read here is cached (`lib/cache-policy.ts` SSOT),
 * and the page reads no `currentUser()`/`headers()` — so Next prerenders `/` with no
 * per-request function, killing the ~30 s cold-start. Personalization (the retoma rail,
 * offer alerts, seller snapshot) is intentionally dropped here and returns in Phase 2 as
 * client islands (S3 Cloud Run endpoint + S4). Heart-states hydrate client-side via the
 * FavoritesProvider wrapping the curated grid.
 */
export default function HomePage() {
  return MarketHomePage({ market: 'mx' })
}

/** One marketplace home implementation; literal market roots provide context. */
export async function MarketHomePage({ market }: { market: MarketCode }) {
  const presentation = resolveMarketPresentation(market, await getLanguagePreference())
  const marketPath = marketBasePath(market)
  const publishableKey = resolvePublishableKeyForMarket(market, PROCESS_MARKET_ENV)
  // One timestamp for both the featured pick and the grid so their selection is
  // atomic (no 14-day-cutoff divergence between the two reads).
  // This is a server-render snapshot shared by all reads, not client render state.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now()
  // Each read degrades to its empty fallback on failure (`.catch`) — because the page is
  // now prerendered at BUILD time, a thrown Medusa/Supabase fetch (e.g. a transient
  // backend hiccup during the Vercel build) would otherwise fail the whole deploy. Here
  // it just prerenders the empty-state and self-heals on the next ISR revalidation.
  const [featured, grid, categories, pulse, dict, buyerAnnouncement, recentPool] = await Promise.all([
    getFeaturedListing(now, market).catch(() => null),
    getCuratedListings(now, market).catch(() => []),
    getCategoryCounts(market).catch(() => []),
    market === 'mx' ? getNeighborhoodPulseItems(2).catch(() => []) : Promise.resolve([]),
    getOverriddenDictionary(presentation.language),
    market === 'mx' ? getActiveAnnouncement('buyer').catch(() => null) : Promise.resolve(null),
    getRecentListings(RECIEN_LLEGADO_FETCH_LIMIT, market).catch(() => []),
  ])
  const home = dict.home

  const seleccion: Listing[] = [...(featured ? [featured] : []), ...grid]

  // S3.2 — newest-first, excluding anything already shown in Selección, so the two
  // rows never repeat a listing.
  const recienLlegado = excludeIds(recentPool, seleccion.map(l => l.id)).slice(0, RECIEN_LLEGADO_SIZE)

  return (
    <HomePersonalizationProvider
      storeUrl={process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'}
      publishableApiKey={publishableKey.status === 'resolved' ? publishableKey.token : ''}
    >
    <div className="max-w-6xl mx-auto px-4 py-4">
      {/* Hero + trust badges — signed-out first-visit orientation (S3.1). Supersedes the
          value-prop ribbon entirely: for a returning signed-in buyer this job is already
          done, so the personalized rows (HomeRetomaOffers) sit at the top instead (S2.1).
          Prerenders into static HTML for anonymous/loading visitors; hydration removes it
          once Clerk confirms a real session. */}
      <AuthShow when="signed-out">
        <div data-testid="home-hero" className="mb-6" style={{ textAlign: 'center', padding: '20px 12px 4px' }}>
          <h1
            style={{
              fontFamily: 'var(--font-sans)',
              fontWeight: 700,
              fontSize: 'var(--t-xl, 22px)',
              color: 'var(--fg)',
              lineHeight: 1.25,
              margin: '0 0 14px',
            }}
          >
            {home.hero.heading}
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
            {[
              { icon: 'shield-check', label: home.hero.badges[0] },
              { icon: 'chat-bubble', label: home.hero.badges[1] },
              { icon: 'percentage', label: home.hero.badges[2] },
            ].map(badge => (
              <span
                key={badge.icon}
                className="badge badge-soft"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, padding: '5px 10px' }}
              >
                <i className={`iconoir-${badge.icon}`} style={{ fontSize: 14, color: 'var(--accent)' }} aria-hidden />
                {badge.label}
              </span>
            ))}
          </div>
        </div>
      </AuthShow>

      {/* Sprint 3 — understated, dismissable buyer announcement. Real ISR-rendered
          server data (not a client fetch); renders nothing when there's no active
          buyer campaign. */}
      <HomeAnnouncementCard
        announcement={
          buyerAnnouncement && {
            id: buyerAnnouncement.id,
            text: buyerAnnouncement.text,
            ctaLabel: buyerAnnouncement.ctaLabel,
            ctaLink: buyerAnnouncement.ctaLink,
          }
        }
      />

      {/* S4 — signed-in personalization islands (top slot): retoma rail + offer alerts.
          Hydrate client-side from the S3 Cloud Run endpoint; render nothing otherwise so
          the static page is unchanged for signed-out/loading visitors. */}
      <HomeRetomaOffers />

      {/* cost-comparator-homepage epic (08), Sprint 1 · US-1.4 — teaser linking the
          public /comparador tool. A CLIENT island (ComparadorTeaserCard) so this static
          page's own server render is untouched — no new dynamic API, `/` stays a
          prerendered CDN asset (asserted in e2e/home-static.spec.ts). */}
      {market === 'mx' && <ComparadorTeaserCard />}

      {/* S3.2 — Recién llegado al barrio: newest-first, deduped against Selección so no
          listing appears twice. Same card visual language as the Selección grid below. */}
      {recienLlegado.length > 0 && (
        <FavoritesProvider>
          <section className="mb-8" data-testid="home-recien-llegado">
            <div className="flex items-center justify-between mb-4">
              <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 'var(--t-base)', color: 'var(--fg)' }}>
                {home.recienLlegado.heading}
              </h2>
              <Link href={`${marketPath}/l?sort=reciente`} style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}>
                {home.recienLlegado.cta}
              </Link>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {recienLlegado.map(listing => (
                <div key={listing.id} style={{ position: 'relative' }}>
                  <Link href={`${marketPath}/l/${listing.id}`} className="card-tile no-underline block">
                    <div style={{ position: 'relative', aspectRatio: '1 / 1', overflow: 'hidden', background: 'var(--bg-sunk)' }}>
                      {listing.images?.[0] ? (
                        // Not the measured LCP element (that's the Selección featured
                        // card below) — default lazy loading here keeps this section's
                        // bytes from competing with the real LCP fetch.
                        <Image
                          src={listing.images[0].url}
                          alt={listing.images[0].alt ?? listing.title}
                          fill
                          sizes="(min-width: 1024px) 25vw, 50vw"
                          className="object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <i className="iconoir-package" style={{ fontSize: 36, color: 'var(--fg-subtle)' }} />
                        </div>
                      )}
                      {isNewToday(listing.created_at, now) && (
                        <span
                          className="badge badge-soft"
                          style={{ position: 'absolute', bottom: 6, left: 6, fontSize: 10 }}
                        >
                          {home.recienLlegado.newBadge}
                        </span>
                      )}
                    </div>
                    <div className="p-2">
                      <p className="t-price" style={{ fontSize: 16, fontWeight: 600 }}>{formatPrice(listing, presentation.htmlLang)}</p>
                      <p style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', margin: '3px 0' }}>
                        {listing.title}
                      </p>
                      {(listing.location || listing.condition) && (
                        <p style={{ fontSize: 11, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {[listing.location, conditionLabel(listing.condition, presentation.language)].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                    {/* Keeps the tile dimmed for the whole navigation, not just while the finger is down. */}
                    <PendingMark showDot={false} />
                  </Link>
                  <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 5 }}>
                    <FavoriteButton listingId={listing.id} size="sm" />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </FavoritesProvider>
      )}

      <CategoryChips className="mb-6" counts={categories} marketBasePath={marketPath} language={presentation.language} />

      {/* S3.4 — Vecindario live strip: 1–2 real approved pulse items from the same source as
          /vecindario. Empty → the original banner. The "Ver vecindario →" link keeps the
          data-testid so the nav-entry-points spec stays green. */}
      {market === 'mx' && (pulse.length > 0 ? (
        <section className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {NEIGHBORHOOD_PULSE_COPY.eyebrow}
            </p>
            <Link
              href="/vecindario"
              data-testid="vecindario-feed-entry"
              style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap' }}
            >
              {NEIGHBORHOOD_PULSE_COPY.viewFeedCta} →
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {pulse.map(item => (
              <div
                key={item.id}
                className="card-tile"
                style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: 14 }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--bg-sunk)',
                  }}
                >
                  <i
                    className={item.type === 'evento' ? 'iconoir-bell' : 'iconoir-star'}
                    style={{ fontSize: 20, color: 'var(--accent)' }}
                    aria-hidden
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="badge badge-soft" style={{ color: 'var(--accent)', fontSize: 10 }}>
                    {printSocialTypeLabel(item.type)}
                  </span>
                  <p style={{ fontSize: 13, color: 'var(--fg)', lineHeight: 1.4, margin: '6px 0 0', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {item.caption || item.body}
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {[publicSubmitterLabel(item), item.zone, timeAgo(item.created_at, presentation.language)].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <Link
          href="/vecindario"
          data-testid="vecindario-feed-entry"
          className="card-tile no-underline block mb-6"
          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14 }}
        >
          <div
            style={{
              flexShrink: 0,
              width: 44,
              height: 44,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--bg-sunk)',
            }}
          >
            <i className="iconoir-community" style={{ fontSize: 24, color: 'var(--accent)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
              {NEIGHBORHOOD_PULSE_COPY.eyebrow}
            </p>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', marginBottom: 2 }}>
              {NEIGHBORHOOD_PULSE_COPY.navLabel}
            </p>
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {NEIGHBORHOOD_PULSE_COPY.intro}
            </p>
          </div>
          <span style={{ flexShrink: 0, fontSize: 13, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
            {NEIGHBORHOOD_PULSE_COPY.viewFeedCta} →
          </span>
        </Link>
      ))}

      {/* Selección de la semana — a curated pick + grid, price as the loudest element.
          Wrapped in FavoritesProvider: hearts hydrate client-side (one /api/favorites
          fetch) since the static render can't seed favorite state. */}
      {seleccion.length > 0 && (
        <FavoritesProvider>
          <section className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 'var(--t-base)', color: 'var(--fg)' }}>
                {home.selection.heading}
              </h2>
              <Link href={`${marketPath}/l`} style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}>
                {home.selection.cta}
              </Link>
            </div>

            {/* Featured card — full-width 16:9, price 18px loudest */}
            {featured && (
              <div style={{ position: 'relative', marginBottom: 12 }}>
                <Link href={`${marketPath}/l/${featured.id}`} className="card-tile no-underline block">
                  <div style={{ position: 'relative', aspectRatio: '16 / 9', overflow: 'hidden', background: 'var(--bg-sunk)' }}>
                    {featured.images?.[0] ? (
                      // This is the confirmed LCP element (validated PageSpeed run,
                      // 2026-07-14 — the "Flashback (original)" 16:9 featured card).
                      // priority => no lazy + fetchpriority="high" + a dynamic
                      // <link rel=preload> for THIS render's actual image URL (never
                      // a hard-coded one — the row is only known at render time).
                      <Image
                        src={featured.images[0].url}
                        alt={featured.images[0].alt ?? featured.title}
                        fill
                        priority
                        sizes="(min-width: 1024px) 1120px, 100vw"
                        className="object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <i className="iconoir-package" style={{ fontSize: 48, color: 'var(--fg-subtle)' }} />
                      </div>
                    )}
                    <span
                      className="badge"
                      style={{ position: 'absolute', top: 10, left: 10, fontSize: 11, fontWeight: 600, background: 'var(--accent)', color: 'var(--fg-inverse)' }}
                    >
                      {home.featured.badge}
                    </span>
                  </div>
                  <div className="p-3">
                    <p className="t-price" style={{ fontSize: 18, fontWeight: 600 }}>{formatPrice(featured, presentation.htmlLang)}</p>
                    <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--fg)', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', margin: '4px 0' }}>
                      {featured.title}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-muted)', flexWrap: 'wrap' }}>
                      {featured.location && <span>{featured.location}</span>}
                      {featured.location && featured.shop && <span style={{ color: 'var(--fg-subtle)' }}>·</span>}
                      {featured.shop && (
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {featured.shop.verified && <i className="iconoir-badge-check" style={{ color: 'var(--accent)', marginRight: 3, verticalAlign: 'middle' }} aria-hidden />}
                          {featured.shop.name}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Keeps the tile dimmed for the whole navigation, not just while the finger is down. */}
                  <PendingMark showDot={false} />
                </Link>
                <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 5 }}>
                  <FavoriteButton listingId={featured.id} size="sm" />
                </div>
              </div>
            )}

            {/* Grid — price 16px loudest, ONE meta line, <48h timestamp badge */}
            {grid.length > 0 && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {grid.map((listing, idx) => (
                  <div key={listing.id} style={{ position: 'relative' }}>
                    <Link href={`${marketPath}/l/${listing.id}`} className="card-tile no-underline block">
                      <div style={{ position: 'relative', aspectRatio: '1 / 1', overflow: 'hidden', background: 'var(--bg-sunk)' }}>
                        {listing.images?.[0] ? (
                          // First row on mobile (grid-cols-2, the measured viewport) is
                          // idx 0-1 — fetchpriority=high + no lazy, per Story 1.2. The
                          // rest default-lazy so they don't compete for bandwidth.
                          <Image
                            src={listing.images[0].url}
                            alt={listing.images[0].alt ?? listing.title}
                            fill
                            priority={idx < 2}
                            sizes="(min-width: 1024px) 25vw, 50vw"
                            className="object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <i className="iconoir-package" style={{ fontSize: 36, color: 'var(--fg-subtle)' }} />
                          </div>
                        )}
                        {isRecentForBadge(listing.created_at, now) && (
                          <span
                            className="badge badge-soft"
                            style={{ position: 'absolute', bottom: 6, left: 6, fontSize: 10 }}
                          >
                            {timeAgo(listing.created_at, presentation.language)}
                          </span>
                        )}
                      </div>
                      <div className="p-2">
                        <p className="t-price" style={{ fontSize: 16, fontWeight: 600 }}>{formatPrice(listing, presentation.htmlLang)}</p>
                        <p style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', margin: '3px 0' }}>
                          {listing.title}
                        </p>
                        {(listing.location || listing.condition) && (
                          <p style={{ fontSize: 11, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {[listing.location, conditionLabel(listing.condition, presentation.language)].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </div>
                      {/* Keeps the tile dimmed for the whole navigation, not just while the finger is down. */}
                      <PendingMark showDot={false} />
                    </Link>
                    <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 5 }}>
                      <FavoriteButton listingId={listing.id} size="sm" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </FavoritesProvider>
      )}

      {/* Categorías — only categories with ≥1 active listing, with live counts */}
      {categories.length > 0 && (
        <section className="mb-8">
          <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 'var(--t-base)', color: 'var(--fg)', marginBottom: 16 }}>
            {home.categories.heading}
          </h2>
          <div className="card-panel">
            {categories.map((cat, i) => (
              <Link
                key={cat.key}
                href={`${marketPath}/l?category=${cat.key}`}
                className="no-underline cat-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 14px',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                }}
              >
                <i className={`iconoir-${cat.icon}`} style={{ fontSize: 'var(--t-md)', color: 'var(--accent)', flexShrink: 0 }} aria-hidden />
                <span style={{ flex: 1, fontSize: 13.5, color: 'var(--fg)' }}>{categoryLabel(cat.key, presentation.language)}</span>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{cat.count}</span>
                <i className="iconoir-arrow-right" style={{ fontSize: 'var(--t-base)', color: 'var(--fg-subtle)', flexShrink: 0 }} aria-hidden />
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* `recienLlegado` belongs in this test too. Without it the page could render
          "the first listings will appear here soon" directly beneath a listing —
          which is exactly what /us did on the day its first product went live, with
          one uncategorised item: `seleccion` and `categories` were both empty while
          the new-arrivals row was not. MX never exposed it because MX always has
          categories, which is why the original comment here read "marketplace
          non-empty today". The empty state must mean the WHOLE page is empty. */}
      {seleccion.length === 0 && categories.length === 0 && recienLlegado.length === 0 && (
        <div className="text-center py-16" style={{ color: 'var(--fg-muted)' }}>
          <i className="iconoir-shop" style={{ fontSize: 48, color: 'var(--fg-subtle)', display: 'block', marginBottom: 12 }} />
          <p style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>{home.emptyState.heading}</p>
          <p style={{ fontSize: 14, marginBottom: 16 }}>{home.emptyState.body}</p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Recruit CTA is auth-aware: signed-out → this market's landing (prerenders
                into the static HTML), signed-in → /sell publish wizard. Both via the
                client AuthShow, so no headers() and the page stays static.
                (Empty-state path — marketplace non-empty today.) */}
            {/* Each market has its own landing now (`/mx/vende`, `/us/sell`), so this
                is one lookup rather than a per-market ternary. The US arm used to send
                a signed-out visitor STRAIGHT to `/sell?market=us` — the wizard's URL —
                because the only Spanish-free seller page was the one hiding in that
                route's signed-out branch. It has an address of its own now. */}
            <AuthShow when="signed-out">
              <Link
                href={sellerLandingPath(market)}
                className="btn btn-primary btn-sm"
              >{home.emptyState.publishCta}</Link>
            </AuthShow>
            <AuthShow when="signed-in">
              <Link
                href={market === 'mx' ? '/sell' : '/sell?market=us'}
                className="btn btn-primary btn-sm"
              >{home.emptyState.publishCta}</Link>
            </AuthShow>
            {market === 'mx' ? (
              <Link href="/vecindario" className="btn btn-secondary btn-sm">{home.emptyState.secondaryCta}</Link>
            ) : (
              <Link href={`${marketPath}/l`} className="btn btn-secondary btn-sm">{dict.buyerCopy['market.browseCatalog']}</Link>
            )}
          </div>
        </div>
      )}

      {/* S4 — signed-in personalization island (bottom slot): seller snapshot or recruit.
          Same client-island hydration; nothing for signed-out/loading visitors. */}
      {market === 'mx' && <HomeSellerModule />}

      {/* Terminal CTA — a clear next action so the bottom isn't a dead end. Signed-out
          only: gated by the client AuthShow (no headers(), so / stays static) — the
          signed-out HTML still prerenders, then hydrates away for signed-in sessions,
          who get their HomeSellerModule island instead of a duplicate recruit prompt.
          This IS the closing CTA (the separate "Únete a la comunidad" signup row was
          removed as redundant once this card shipped — the CTA below goes straight to
          /sign-up so there's exactly one bottom-of-page ask, not two). */}
      {market === 'mx' && seleccion.length > 0 && (
        <AuthShow when="signed-out">
          <section
            data-testid="home-seller-block"
            className="mb-6"
            style={{
              textAlign: 'left',
              padding: '28px 24px',
              borderRadius: 'var(--r-lg)',
              background: 'var(--selva-800)',
              marginTop: 8,
            }}
          >
            <p className="t-eyebrow" style={{ color: 'var(--selva-300)', marginBottom: 8 }}>
              {home.sellerBlock.eyebrow}
            </p>
            <p style={{ fontWeight: 700, fontSize: 20, color: 'var(--fg-inverse)', lineHeight: 1.25, marginBottom: 18 }}>
              {home.sellerBlock.heading}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 22 }}>
              {home.sellerBlock.reassurances.map(reassurance => (
                <span key={reassurance} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--fg-inverse)' }}>
                  <i className="iconoir-check-circle" style={{ fontSize: 16, color: 'var(--selva-300)', flexShrink: 0 }} aria-hidden />
                  {reassurance}
                </span>
              ))}
            </div>
            <Link href="/sign-up" data-testid="home-seller-block-cta" className="btn btn-inverse">
              {home.sellerBlock.cta}
            </Link>
          </section>
        </AuthShow>
      )}
    </div>
    </HomePersonalizationProvider>
  )
}
