/* eslint-disable @next/next/no-img-element -- seller catalog media may use arbitrary remote hosts */
import { Fragment } from 'react'
import { createSellerFormat } from '@/lib/seller-format'
import { getSellerFormatContext } from '@/lib/seller-format-server'
import Link from 'next/link'
import PrintEditionCard from './PrintEditionCard'
import SellerPageHeader from '@/components/seller/SellerPageHeader'
import SetupGuideCard from './SetupGuideCard'
import { pendingSummary as buildPendingSummary } from '@/lib/seller-pending-summary'
import type { SetupStep } from '@/lib/setup-guide'
import { shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ManagedListing {
  id: string
  title: string
  price_cents: number | null
  currency: string
  category: string | null
  listing_type: string
  condition: string | null
  status: string
  views: number
  images: Array<{ url: string; alt?: string }>
  created_at: string
}

interface Shop {
  id: string
  slug: string
  name: string
  location: string | null
}

// ── Main component ────────────────────────────────────────────────────────────
//
// The full "Mis anuncios" grid (search, filters, per-row pause/delete) was
// absorbed into the /shop/manage/catalogo table (catalog-management epic,
// Sprint 1 · Story 1.2) — this stays a compact summary card + link, so the
// dashboard doesn't duplicate a second live-editable listing grid.

export default async function ManageDashboard({
  shop,
  initialListings,
  pendingOffersCount = 0,
  pendingOrdersCount = 0,
  setupSteps,
  guideDismissed = false,
  guideSatisfactionAnswered = false,
}: {
  shop: Shop
  initialListings: ManagedListing[]
  pendingOffersCount?: number
  pendingOrdersCount?: number
  setupSteps: SetupStep[]
  guideDismissed?: boolean
  guideSatisfactionAnswered?: boolean
}) {
  // A SERVER component cannot consume React context, so it cannot use
  // `useSellerFormat()` — it resolves the same three facts through the same
  // `cache()`d server seam the layouts use, and builds the same formatter. One
  // resolver means the server and client halves of the portal cannot disagree.
  const fmt = createSellerFormat(await getSellerFormatContext())
  const totalViews = initialListings.reduce((s, l) => s + (l.views ?? 0), 0)
  const activeCount = initialListings.filter((l) => l.status === 'active').length
  const pausedCount = initialListings.filter((l) => l.status === 'paused').length
  const pendingSummary = buildPendingSummary(pendingOrdersCount, pendingOffersCount)
  const previewThumbs = initialListings.slice(0, 5)

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">

      {/* ── Shop header ─────────────────────────────────────────────────────── */}
      <SellerPageHeader
        title={shop.name}
        meta={
          <>
            {shop.location && (
              <p className="text-sm text-[var(--color-muted)]"><i className="iconoir-map-pin" aria-hidden /> {shop.location}</p>
            )}
            {/* Navigation lives in the SellerNav rail (lib/seller-nav.ts) — the
                dashboard header keeps only the public-shop link + a compact
                pending-work signal (the Pedidos/Ofertas badges' replacement). */}
            <Link
              href={shopUrlFor(SITE_ORIGIN, shop.slug)}
              className="text-xs text-[var(--color-accent)] hover:underline no-underline w-fit"
              target="_blank"
            >
              Ver tienda pública ↗
            </Link>
            {pendingSummary && (
              <span className="text-xs text-[var(--color-muted)] inline-flex flex-wrap items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-[var(--r-pill)] bg-[var(--warning)]" aria-hidden />
                {pendingSummary.segments.map((seg, i) => (
                  <Fragment key={seg.href}>
                    {i > 0 && <span className="text-[var(--color-border)]">·</span>}
                    <Link href={seg.href} className="hover:text-[var(--color-foreground)] no-underline">
                      {seg.text}
                    </Link>
                  </Fragment>
                ))}
                <span>{pendingSummary.suffix}</span>
              </span>
            )}
          </>
        }
        actions={
          <>
            <Link href="/shop/manage/import" className="btn btn-secondary">
              Importar catálogo
            </Link>
            <Link href="/sell" className="btn btn-primary">
              + Nuevo anuncio
            </Link>
          </>
        }
      />

      {/* ── Setup guide (renders nothing once dismissed or all 5 steps done) ──── */}
      <SetupGuideCard
        steps={setupSteps}
        initialDismissed={guideDismissed}
        initialSatisfactionAnswered={guideSatisfactionAnswered}
        shopSlug={shop.slug}
      />

      {/* ── Stats row ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {[
          { label: 'Activos', value: activeCount, color: 'text-[var(--success)]' },
          { label: 'Pausados', value: pausedCount, color: 'text-[var(--warning)]' },
          { label: 'Vistas totales', value: totalViews, color: 'text-[var(--color-foreground)]' },
        ].map(stat => (
          <div key={stat.label} className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4 text-center">
            <div className={`text-xl sm:text-2xl font-bold ${stat.color}`}>{fmt.number(stat.value)}</div>
            <div className="text-xs text-[var(--color-muted)] mt-0.5">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* ── Print edition power-up ──────────────────────────────────────────── */}
      <PrintEditionCard />

      {/* ── Mis anuncios — compact summary card ──────────────────────────────── */}
      <Link
        href="/shop/manage/catalogo"
        className="card-tile p-4"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-sm text-[var(--color-muted)] uppercase tracking-wide">
            Mis anuncios ({initialListings.length})
          </h2>
          <span className="text-xs text-[var(--color-accent)] font-medium flex items-center gap-1">
            Ver catálogo completo <i className="iconoir-arrow-right" />
          </span>
        </div>

        {initialListings.length === 0 ? (
          <div className="py-4 text-center">
            <div className="text-3xl mb-2"><i className="iconoir-package" aria-hidden /></div>
            <p className="text-sm text-[var(--color-muted)]">
              Publica tu primer producto, servicio o renta en menos de 2 minutos.
            </p>
          </div>
        ) : (
          <div className="flex gap-2">
            {previewThumbs.map((listing) => (
              <div key={listing.id} className="w-14 h-14 flex-shrink-0 rounded-[var(--r-md)] overflow-hidden bg-[var(--color-surface-alt)] border border-[var(--color-border)]">
                {listing.images?.[0]?.url ? (
                  <img src={listing.images[0].url} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xl"><i className="iconoir-package" aria-hidden /></div>
                )}
              </div>
            ))}
            {initialListings.length > previewThumbs.length && (
              <div className="w-14 h-14 flex-shrink-0 rounded-[var(--r-md)] flex items-center justify-center bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-muted)]">
                +{initialListings.length - previewThumbs.length}
              </div>
            )}
          </div>
        )}
      </Link>

      {/* ── Trust footer ────────────────────────────────────────────────────── */}
      <p className="text-xs text-center text-[var(--color-muted)] mt-10">
        <i className="iconoir-check" aria-hidden /> Sin comisiones · <i className="iconoir-check" aria-hidden /> Publicación instantánea · <i className="iconoir-check" aria-hidden /> 100% gratis
      </p>
    </div>
  )
}
