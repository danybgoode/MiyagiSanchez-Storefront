/**
 * GET /embed/s/[slug] — full-shop EMBED surface (07 · Embeddable Widget, US-5).
 *
 * A seller drops their whole storefront onto another site with an <iframe>:
 *
 *   <iframe src="https://miyagisanchez.com/embed/s/<slug>?key=emb_pk_…"
 *           style="width:100%;height:760px;border:0"></iframe>
 *
 * It reuses the white-label `ChannelLayout` (branded, no platform chrome — the
 * root layout suppresses its header/footer when middleware tags the request as
 * an embed surface). The page is served `Content-Security-Policy: frame-ancestors *`
 * (next.config) so any site can frame it.
 *
 * Buy hands off to OUR hosted flow: each card opens `/l/<id>?channel=embed` in a
 * NEW TOP-LEVEL TAB (target="_blank"). Clerk auth can't run inside a cross-origin
 * iframe (third-party cookies), so checkout MUST break out to our own origin —
 * where the Sprint 1 cookie tags the sale `channel=embed`. No commerce logic here.
 */

import { notFound } from 'next/navigation'
import { getShop, getShopListings, formatPrice } from '@/lib/listings'
import { assertShopNotPreviewPrivate, isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import ChannelLayout from '@/app/(shell)/s/[slug]/ChannelLayout'
import { shopShowsBadge } from '@/lib/plan-badge-server'
import { badgeHref } from '@/lib/plan'
import TrustSignals from '@/app/components/TrustSignals'
import { deriveShopTrustInputs } from '@/lib/trust-inputs'
import { shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import type { Metadata } from 'next'
import ShopChat from '@/components/shop-chat/ShopChat'
import { isShopClaimed } from '@/lib/claim'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const shop = await getShop(slug)
  if (!shop) return { title: 'Tienda no encontrada' }
  if (await isShopPreviewPrivateBySlug(shop.slug, shop.clerk_user_id)) return { title: 'Tienda no encontrada' }
  return {
    title: shop.name,
    // An embed should never compete with the host page in search results.
    robots: { index: false, follow: false },
  }
}

export default async function EmbedShopPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ key?: string }>
}) {
  const { slug } = await params
  const { key } = await searchParams
  const shop = await getShop(slug)
  if (!shop) notFound()
  // Consent-safe previews: the embed is public and framable on any third-party
  // origin, so it must refuse a preview-private shop like every other channel.
  await assertShopNotPreviewPrivate(shop)
  const listings = await getShopListings(shop.slug)

  const settings = ((shop.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
  const theme = (settings.theme ?? {}) as { accent_color?: string | null; tagline?: string | null }
  const accent = theme.accent_color ?? 'var(--accent)'

  // Cross-channel trust parity (#3c · Epic D / D.1): the embed grid renders the same
  // ✓ Verificado badge + payment / returns / pickup signals as the marketplace shop
  // page, via Epic C's presentational <TrustSignals> fed by the shared shop-level deriver.
  const trust = deriveShopTrustInputs(shop.metadata as Record<string, unknown> | null, shop.verified)

  // Buy breaks out of the iframe to our own origin (Clerk can't run framed).
  // Carry the embed key through for attribution where present.
  // The shop-scoped PDP (<shop>/l/<id>), not the marketplace PDP: it also serves
  // «Solo mi tienda» products, which the marketplace PDP 404s (see `ShopBases`).
  const listingHref = (id: string) =>
    `${shopUrlFor(SITE_ORIGIN, shop.slug)}/l/${id}?channel=embed${key ? `&ref_key=${encodeURIComponent(key)}` : ''}`

  return (
    <ChannelLayout
      shopName={shop.name}
      accentColor={accent}
      logoUrl={shop.logo_url ?? null}
      domain=""
      // The Gratis badge (plans-gratis-negocio D7) — the embed is a white-label surface too.
      showBadge={await shopShowsBadge(shop.slug)}
      badgeHref={badgeHref(shop.slug)}
      trust={
        // Epic D / D.2 — the embed shell carries the same platform-assurance strip.
        // paymentProtected suppressed (the shell's lead line carries that assurance).
        <TrustSignals variant="slim" channel="embed" {...trust} paymentProtected={false} />
      }
    >
      <div style={{ '--shop-accent': accent } as React.CSSProperties}>
        <div className="max-w-6xl mx-auto px-4 py-6">
          {/* Shop heading */}
          <div className="mb-5">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold leading-tight" style={{ color: 'var(--embed-fg)' }}>{shop.name}</h1>
              {shop.verified && (
                <span className="text-xs px-2 py-0.5 rounded-full text-white font-medium inline-flex items-center gap-1" style={{ backgroundColor: accent }}>
                  <i className="iconoir-badge-check" aria-hidden /> Verificado
                </span>
              )}
            </div>
            {theme.tagline && <p className="text-sm text-[var(--embed-fg-muted)] mt-0.5 italic">&ldquo;{theme.tagline}&rdquo;</p>}
            <p className="text-xs text-[var(--embed-fg-subtle)] mt-1">{listings.length} anuncios</p>
          </div>

          {/* Trust parity (D.1): payment / returns / pickup signals — Epic C's <TrustSignals>. */}
          <div className="mb-5">
            <TrustSignals channel="embed" {...trust} />
          </div>

          {listings.length === 0 ? (
            <div className="text-center py-16 text-[var(--embed-fg-subtle)]">
              <div className="text-4xl mb-3"><i className="iconoir-package" aria-hidden /></div>
              <p className="font-medium">Esta tienda aún no tiene anuncios.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {listings.map(listing => {
                const img = listing.images?.[0]?.url ?? null
                return (
                  <a
                    key={listing.id}
                    href={listingHref(listing.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-xl overflow-hidden border border-black/10 bg-white no-underline hover:shadow-md transition-shadow"
                  >
                    <div className="aspect-square bg-[var(--embed-surface-sunk)] flex items-center justify-center overflow-hidden">
                      {img
                        ? (
                          // eslint-disable-next-line @next/next/no-img-element -- embed images keep their remote seller origin
                          <img src={img} alt={listing.title} className="w-full h-full object-cover" />
                        )
                        : <span className="text-3xl text-[var(--embed-placeholder)]"><i className="iconoir-shop" aria-hidden /></span>}
                    </div>
                    <div className="p-2.5">
                      <p className="text-[13px] font-semibold text-[var(--embed-fg)] line-clamp-2 leading-snug">{listing.title}</p>
                      <p className="text-[15px] font-extrabold mt-1" style={{ color: 'var(--embed-fg)' }}>{formatPrice(listing)}</p>
                    </div>
                  </a>
                )
              })}
            </div>
          )}
        </div>
      </div>
      {/* The shop's chat inside the embed too (business-infrastructure D15); claimed shops only. */}
      {isShopClaimed(shop) ? <ShopChat slug={shop.slug} shopName={shop.name} siteKey={process.env.TURNSTILE_SITE_KEY || null} bottomOffset={16} /> : null}
    </ChannelLayout>
  )
}
