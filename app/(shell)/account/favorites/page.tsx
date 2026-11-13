import { getLanguagePreference } from '@/lib/site-language-server'
import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
/* eslint-disable @next/next/no-img-element -- marketplace media hosts are seller-controlled and not finitely allow-listable */
import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import Link from 'next/link'
import FavoriteButton from '@/app/components/FavoriteButton'
import type { Metadata } from 'next'
import { browseUrlFor, listingUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import { formatPresentationCurrency, marketCodeForCurrency, resolveMarketPresentation } from '@/lib/market-presentation'

export const metadata: Metadata = { title: { absolute: 'Favoritos — Miyagi Sánchez' } }

function conditionLabel(c: string) {
  const map: Record<string, string> = { new: 'Nuevo', like_new: 'Como nuevo', good: 'Buen estado', fair: 'Aceptable', poor: 'Con detalles' }
  return map[c] ?? c
}

export default async function FavoritesPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in?redirect_url=/account/favorites')
  const language = await getLanguagePreference()

  // No `marketplace_shops.market_code` — it has never been a column on the mirror,
  // and asking for it made PostgREST 400 the whole query. `data` was destructured
  // without `error`, so this page rendered "no tienes favoritos" to everyone who did
  // (found 2026-08-15 by scripts/audit-select-columns.mjs, same defect as /messages).
  const { data, error } = await db
    .from('marketplace_favorites')
    .select(`
      id,
      listing_id,
      price_cents_at_save,
      created_at,
      marketplace_listings (
        id, medusa_product_id, title, price_cents, currency, condition, location, images, status, created_at,
        marketplace_shops ( name, slug, verified )
      )
    `)
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: false })

  // A failed read is not an empty favourites list. Named, so the next outage is
  // visible instead of looking like a user who never saved anything.
  if (error) console.error('[favorites] read failed:', error)

  const favorites = (data ?? []) as unknown as Array<{
    id: string
    listing_id: string
    price_cents_at_save: number | null
    created_at: string
      marketplace_listings: {
        id: string
        medusa_product_id: string | null
        title: string
      price_cents: number | null
      currency: string
      condition: string | null
      location: string | null
      images: Array<{ url: string }> | null
      status: string
      marketplace_shops: { name: string; slug: string; verified: boolean } | null
    } | null
  }>

  const active  = favorites.filter(f => f.marketplace_listings?.status === 'active' && f.marketplace_listings.medusa_product_id)
  const soldOut = favorites.filter(f => f.marketplace_listings?.status !== 'active' || !f.marketplace_listings?.medusa_product_id)

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--danger-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <i className="iconoir-heart-solid" style={{ fontSize: 20, color: 'var(--danger)' }} />
        </div>
        <div>
          <h1 style={{ fontWeight: 700, fontSize: 22 }}><BuyerCopyText copyKey="account.favorites.page.37f173c0" /></h1>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{active.length} <BuyerCopyText copyKey="account.favorites.page.34e5da88" />{active.length !== 1 ? <BuyerCopyText copyKey="account.favorites.page.b9377647" /> : ''} <BuyerCopyText copyKey="account.favorites.page.afa23718" />{active.length !== 1 ? <BuyerCopyText copyKey="account.favorites.page.b9377647" /> : ''}</p>
        </div>
      </div>

      {favorites.length === 0 ? (
        <div style={{ paddingTop: 80, textAlign: 'center' }}>
          <i className="iconoir-heart" style={{ fontSize: 56, display: 'block', marginBottom: 16, color: 'var(--fg-subtle)' }} />
          <p style={{ fontWeight: 600, fontSize: 17, marginBottom: 6 }}><BuyerCopyText copyKey="account.favorites.page.24b1d09e" /></p>
          <p style={{ fontSize: 14, color: 'var(--fg-muted)', marginBottom: 24 }}>
            <BuyerCopyText copyKey="account.favorites.page.3e66f729" /></p>
          <Link href={browseUrlFor(SITE_ORIGIN)} className="btn btn-primary no-underline" style={{ display: 'inline-flex' }}>
            <i className="iconoir-search" style={{ fontSize: 16 }} />
            <BuyerCopyText copyKey="account.favorites.page.538c0c2f" /></Link>
        </div>
      ) : (
        <>
          {/* Active listings grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }} className="sm:grid-cols-3">
            {active.map(fav => {
              const listing = fav.marketplace_listings!
              const presentation = resolveMarketPresentation(marketCodeForCurrency(listing.currency) ?? 'mx', language)
              const formatPrice = (priceCents: number) =>
                formatPresentationCurrency(presentation, priceCents, listing.currency, { maximumFractionDigits: 0 })
              const priceDrop = fav.price_cents_at_save && listing.price_cents && listing.price_cents < fav.price_cents_at_save
              const dropAmount = priceDrop ? fav.price_cents_at_save! - listing.price_cents! : 0

              return (
                <div key={fav.id} style={{ position: 'relative', borderRadius: 'var(--r-lg)', overflow: 'hidden', background: 'var(--bg-elevated)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-1)' }}>
                  <Link href={listingUrlFor(SITE_ORIGIN, listing.medusa_product_id!)} className="no-underline block">
                    <div style={{ position: 'relative', aspectRatio: '1', overflow: 'hidden', background: 'var(--bg-sunk)' }}>
                      {listing.images?.[0] ? (
                        <img src={listing.images[0].url} alt={listing.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <i className="iconoir-package" style={{ fontSize: 40, color: 'var(--fg-subtle)' }} />
                        </div>
                      )}
                      {/* Price drop badge */}
                      {priceDrop && (
                        <div style={{ position: 'absolute', top: 8, left: 8, background: 'var(--danger)', color: 'var(--fg-inverse)', borderRadius: 'var(--r-pill)', padding: '3px 8px', fontSize: 11, fontWeight: 700 }}>
                          ↓ {formatPrice(dropAmount)} <BuyerCopyText copyKey="account.favorites.page.4ebc1327" /></div>
                      )}
                    </div>
                    <div style={{ padding: '10px 12px' }}>
                      <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)', lineHeight: 1.3, marginBottom: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {listing.title}
                      </p>
                      <div className="flex items-center gap-2">
                        <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)' }}>
                          {listing.price_cents ? formatPrice(listing.price_cents) : '—'}
                        </p>
                        {priceDrop && fav.price_cents_at_save && (
                          <p style={{ fontSize: 12, color: 'var(--fg-muted)', textDecoration: 'line-through' }}>
                            {formatPrice(fav.price_cents_at_save)}
                          </p>
                        )}
                      </div>
                      {listing.condition && (
                        <span style={{ fontSize: 10, fontWeight: 500, background: 'var(--bg-sunk)', color: 'var(--fg-muted)', borderRadius: 'var(--r-pill)', padding: '2px 8px', display: 'inline-block', marginTop: 4 }}>
                          {conditionLabel(listing.condition)}
                        </span>
                      )}
                    </div>
                  </Link>
                  {/* Favorite remove button overlay */}
                  <div style={{ position: 'absolute', top: 8, right: 8 }}>
                    <FavoriteButton listingId={listing.medusa_product_id ?? listing.id} initialFavorited={true} isSignedIn={true} size="sm" />
                  </div>
                </div>
              )
            })}
          </div>

          {/* Sold out section */}
          {soldOut.length > 0 && (
            <div style={{ marginTop: 32 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
                <BuyerCopyText copyKey="account.favorites.page.26d3f078" />{soldOut.length})
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {soldOut.map(fav => {
                  const listing = fav.marketplace_listings
                  return (
                    <div key={fav.id} className="flex items-center gap-3" style={{ padding: '10px 14px', background: 'var(--bg-sunk)', borderRadius: 'var(--r-md)', opacity: 0.6 }}>
                      {listing?.images?.[0] ? (
                        <img src={listing.images[0].url} alt={listing.title} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} />
                      ) : (
                        <div style={{ width: 40, height: 40, background: 'var(--bg-sunk)', borderRadius: 8, flexShrink: 0 }} />
                      )}
                      <div className="flex-1 min-w-0">
                        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{listing?.title ?? <BuyerCopyText copyKey="account.favorites.page.51137e79" />}</p>
                        <p style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{listing?.medusa_product_id ? <BuyerCopyText copyKey="account.favorites.page.da07975a" /> : <BuyerCopyText copyKey="account.favorites.page.baaf23d1" />}</p>
                      </div>
                      <FavoriteButton listingId={listing?.medusa_product_id ?? fav.listing_id} initialFavorited={true} isSignedIn={true} size="sm" />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
