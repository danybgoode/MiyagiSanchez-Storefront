import { getLanguagePreference } from '@/lib/site-language-server'
import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
/* eslint-disable @next/next/no-img-element -- marketplace media hosts are seller-controlled and not finitely allow-listable */
import Link from 'next/link'
import { currentUser } from '@clerk/nextjs/server'
import { searchListings, getAutoFacets, formatPrice, conditionLabel, financingChip } from '@/lib/listings'
import { listingTypeBadge } from '@/lib/listing-query'
import { db } from '@/lib/supabase'
import type { SearchParams } from '@/lib/types'
import SearchBar from './SearchBar'
import CategoryChips from '@/app/components/CategoryChips'
import ListingTypeChips from '@/app/components/ListingTypeChips'
import FavoriteButton from '@/app/components/FavoriteButton'
import type { MarketCode } from '@/lib/markets'
import { resolveMarketPresentation } from '@/lib/market-presentation'
import { listingTypeLabel } from '@/lib/market-vocabulary'
import { PendingMark } from '@/app/components/LinkPending'

function timeAgo(dateStr: string, language: 'es' | 'en'): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 2) return language === 'en' ? 'Just now' : 'Ahora mismo'
  if (mins < 60) return language === 'en' ? `${mins} min ago` : `Hace ${mins} min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return language === 'en' ? `${hrs}h ago` : `Hace ${hrs} h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return language === 'en' ? `${days} day${days === 1 ? '' : 's'} ago` : `Hace ${days} día${days > 1 ? 's' : ''}`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return language === 'en' ? `${weeks} week${weeks === 1 ? '' : 's'} ago` : `Hace ${weeks} semana${weeks > 1 ? 's' : ''}`
  const months = Math.floor(days / 30)
  if (months < 12) return language === 'en' ? `${months} month${months === 1 ? '' : 's'} ago` : `Hace ${months} mes${months > 1 ? 'es' : ''}`
  const years = Math.floor(months / 12)
  return language === 'en' ? `${years} year${years === 1 ? '' : 's'} ago` : `Hace ${years} año${years > 1 ? 's' : ''}`
}

export async function ListingsPage({
  searchParams,
  market = 'mx',
  marketBasePath = '',
}: {
  searchParams: Promise<SearchParams>
  market?: MarketCode
  marketBasePath?: string
}) {
  const [params, user] = await Promise.all([searchParams, currentUser()])
  const presentation = resolveMarketPresentation(market, await getLanguagePreference())
  // Autos facet rail rides alongside the grid fetch (cars-vertical S1.1); modelo
  // options scope to the applied marca. Only for the autos category — every other
  // category skips the extra call. Null (no facet_pool yet / non-autos) ⇒ the
  // SearchBar falls back to its plain free-text autos panel.
  const [{ listings, total, page, market_unavailable: marketUnavailable }, carFacets] = await Promise.all([
    searchListings(params, market),
    params.category === 'autos' ? getAutoFacets(params.brand, market) : Promise.resolve(null),
  ])

  // Fetch user's favorited listing IDs for quick heart rendering
  let favoritedIds = new Set<string>()
  if (user && listings.length > 0) {
    const listingIds = listings.map(l => l.id)
    const { data: favs } = await db
      .from('marketplace_favorites')
      .select('marketplace_listings!inner(medusa_product_id)')
      .eq('clerk_user_id', user.id)
      .in('marketplace_listings.medusa_product_id', listingIds)
    favoritedIds = new Set(
      (favs ?? [])
        .map(f => {
          const listing = f.marketplace_listings as unknown as { medusa_product_id?: string | null } | { medusa_product_id?: string | null }[]
          return Array.isArray(listing) ? listing[0]?.medusa_product_id : listing?.medusa_product_id
        })
        .filter((id): id is string => !!id),
    )
  }
  const isSignedIn = !!user
  const totalPages = Math.ceil(total / 24)

  function pageUrl(p: number) {
    const sp = new URLSearchParams(params as Record<string, string>)
    sp.set('page', String(p))
    return `${marketBasePath}/l?${sp.toString()}`
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <CategoryChips activeCategory={params.category} className="mb-3" marketBasePath={marketBasePath} language={presentation.language} />

      <ListingTypeChips params={params} className="mb-5" marketBasePath={marketBasePath} language={presentation.language} />

      <SearchBar
        params={params}
        initialQ={params.q}
        initialCategory={params.category}
        initialState={params.state}
        initialTotal={total}
        carFacets={carFacets}
        marketBasePath={marketBasePath}
      />

      {marketUnavailable ? (
        <div className="card-panel my-8 px-5 py-10 text-center" data-testid="market-catalog-unavailable" role="status">
          <i className="iconoir-cloud-xmark" style={{ fontSize: 40, color: 'var(--fg-subtle)' }} aria-hidden />
          <p style={{ fontWeight: 600, color: 'var(--fg)', marginTop: 12 }}><BuyerCopyText copyKey="market.catalogUnavailableHeading" /></p>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 5 }}><BuyerCopyText copyKey="market.catalogUnavailableBody" /></p>
        </div>
      ) : <>
      {/* Result count */}
      <div className="flex items-center justify-between mb-4">
        <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{total}</span> <BuyerCopyText copyKey="l.page.9a0dd489" />{params.q && <> <BuyerCopyText copyKey="l.page.e5404318" />{' '}<em>&ldquo;{params.q}&rdquo;</em></>}
        </p>
        {Object.values(params).some(Boolean) && (
          <Link href={`${marketBasePath}/l`} style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'none' }}
            className="hover:text-[var(--fg)]">
            <BuyerCopyText copyKey="l.page.ee06f64a" /></Link>
        )}
      </div>

      {listings.length === 0 ? (
        <div className="py-16 text-center" style={{ color: 'var(--fg-muted)' }}>
          <i className="iconoir-search" style={{ fontSize: 40, display: 'block', marginBottom: 12, color: 'var(--fg-subtle)' }} />
          <p style={{ fontWeight: 500, color: 'var(--fg)', marginBottom: 4 }}><BuyerCopyText copyKey="l.page.a9d00802" /></p>
          <p style={{ fontSize: 13 }}><BuyerCopyText copyKey="l.page.102a7871" /></p>
          {Object.values(params).some(Boolean) && (
            <Link href={`${marketBasePath}/l`} className="btn btn-secondary btn-sm no-underline" style={{ marginTop: 12, display: 'inline-block' }}>
              <BuyerCopyText copyKey="l.page.1da7c9e1" /></Link>
          )}
        </div>
      ) : (
        <>
          {/* 2-col on mobile, 3 on tablet, 3 on desktop */}
          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            {listings.map(listing => (
              <div key={listing.id} style={{ position: 'relative' }}>
                <Link href={`${marketBasePath}/l/${listing.id}`} className="card-tile no-underline block">
                <div style={{ position: 'relative' }}>
                {listing.images?.[0] ? (
                  <img src={listing.images[0].url} alt={listing.title} className="w-full h-40 object-cover" style={listing.in_stock === false ? { opacity: 0.55 } : undefined} />
                ) : (
                  <div className="w-full h-40 flex items-center justify-center" style={{ background: 'var(--bg-sunk)' }}>
                    <i className="iconoir-package" style={{ fontSize: 40, color: 'var(--fg-subtle)' }} />
                  </div>
                )}
                {listing.in_stock === false && (
                  <span style={{ position: 'absolute', top: 8, left: 8, fontSize: 10, fontWeight: 700, color: 'var(--fg-inverse)', background: 'var(--danger)', borderRadius: 'var(--r-pill)', padding: '3px 8px' }}>
                    <BuyerCopyText copyKey="l.page.61907ecb" /></span>
                )}
                </div>
                <div className="p-3">
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', marginBottom: 4 }}>
                    {listing.title}
                  </p>
                  <p className="t-price" style={{ fontSize: 'var(--t-base)' }}>{formatPrice(listing, presentation.htmlLang)}</p>
                  {(() => {
                    const chip = market === 'mx' ? financingChip(listing) : null
                    return chip && <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 1 }}>{chip}</p>
                  })()}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    {listingTypeBadge(listing.listing_type) && (
                      <span className="badge badge-soft" style={{ fontSize: 10, color: 'var(--accent)' }}>
                        {listingTypeLabel(listing.listing_type, listingTypeBadge(listing.listing_type) ?? listing.listing_type, presentation.language)}
                      </span>
                    )}
                    {listing.condition && (
                      <span className="badge badge-soft" style={{ fontSize: 10 }}>
                        {conditionLabel(listing.condition, presentation.language)}
                      </span>
                    )}
                    {listing.location && (
                      <span style={{ fontSize: 11, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}>
                        {listing.location}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                    {listing.shop && (
                      <p style={{ fontSize: 11, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {listing.shop.verified && <i className="iconoir-badge-check" style={{ color: 'var(--accent)', marginRight: 3, verticalAlign: 'middle' }} aria-hidden />}
                        {listing.shop.name}
                      </p>
                    )}
                    <p style={{ fontSize: 11, color: 'var(--fg-subtle)', flexShrink: 0, marginLeft: 4 }}>
                      {timeAgo(listing.created_at, presentation.language)}
                    </p>
                  </div>
                </div>
                  {/* Keeps the tile dimmed for the whole navigation, not just while the finger is down. */}
                  <PendingMark showDot={false} />
                </Link>
                {/* Favorite button — absolute overlay top-right of image */}
                <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 5 }}>
                  <FavoriteButton
                    listingId={listing.id}
                    initialFavorited={favoritedIds.has(listing.id)}
                    isSignedIn={isSignedIn}
                    size="sm"
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
              {page > 1 && (
                <Link href={pageUrl(page - 1)} className="btn btn-secondary btn-sm no-underline">
                  <BuyerCopyText copyKey="l.page.0defb179" /></Link>
              )}
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                const p = Math.max(1, page - 2) + i
                return p <= totalPages ? (
                  <Link
                    key={p}
                    href={pageUrl(p)}
                    className={p === page ? 'btn btn-primary btn-sm no-underline' : 'btn btn-secondary btn-sm no-underline'}
                  >
                    {p}
                  </Link>
                ) : null
              })}
              {page < totalPages && (
                <Link href={pageUrl(page + 1)} className="btn btn-secondary btn-sm no-underline">
                  <BuyerCopyText copyKey="l.page.10c5b69a" /></Link>
              )}
            </div>
          )}
        </>
      )}
      </>}
    </div>
  )
}

export default ListingsPage
