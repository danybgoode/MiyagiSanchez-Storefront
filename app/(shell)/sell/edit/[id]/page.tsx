import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import EditForm from './EditForm'
import PublishToMl from './PublishToMl'
import { isEnabled } from '@/lib/flags'
import { getMlConnection } from '@/lib/ml-connection'
import { getMlProductLink } from '@/lib/ml-publish-bridge'
import type { MlLinkView } from '@/lib/ml-publish'
import { readPriceGrid, type PriceGrid } from '@/lib/price-grid'
import { excerptModel } from '@/lib/excerpt'
import { listingUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Editar anuncio' }

export default async function EditListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { userId, getToken } = await auth()
  if (!userId) redirect('/sign-in')

  // Fetch listing + verify ownership
  let { data, error } = await db
    .from('marketplace_listings')
    .select('id, medusa_product_id, title, description, price_cents, currency, listing_type, images, status, metadata, marketplace_shops!inner(clerk_user_id, slug)')
    .eq('medusa_product_id', id)
    .neq('status', 'deleted')
    .maybeSingle()

  if (!data && !error && /^[0-9a-f-]{36}$/i.test(id)) {
    const fallback = await db
      .from('marketplace_listings')
      .select('id, medusa_product_id, title, description, price_cents, currency, listing_type, images, status, metadata, marketplace_shops!inner(clerk_user_id, slug)')
      .eq('id', id)
      .neq('status', 'deleted')
      .maybeSingle()
    data = fallback.data
    error = fallback.error
  }

  if (error || !data) notFound()

  const shop = (data.marketplace_shops as unknown as { clerk_user_id: string; slug: string } | { clerk_user_id: string; slug: string }[])
  const shopData = Array.isArray(shop) ? shop[0] : shop
  if (shopData?.clerk_user_id !== userId) notFound()

  const listing = data as {
    id: string
    medusa_product_id: string | null
    title: string
    description: string | null
    price_cents: number | null
    currency: string
    listing_type: string
    images: Array<{ url: string; alt?: string }>
    status: string
    metadata: Record<string, unknown>
  }

  const medusaProductId = listing.medusa_product_id ?? listing.id

  // Fetch Medusa listing for quantity, attrs, category (view-safe endpoint)
  let availableQuantity: number | null = null
  let medusaAttrs: Record<string, unknown> = {}
  let medusaCategory = ''
  let medusaCustomFields: unknown = []
  // Excerpt (bookshop launchpad S2.1) lives on the Medusa product metadata (same
  // bag as custom_fields), not the Supabase mirror — read it from the same fetch.
  let initialExcerpt = ''
  // Inventory mode (catalog-management epic, Sprint 2 · Story 2.1) — read off
  // the same public listing fetch (these fields are public on ListingShape,
  // unlike unit_cost_cents which is variant-metadata-private).
  let initialManageInventory = true
  let initialAllowBackorder = false
  let initialDispatchEstimate: string | null = null
  // Arranged-only delivery (epic, S1.2) — lives on the live Medusa product
  // metadata (same bag as custom_fields/dispatch_estimate), not the Supabase
  // mirror's stale `metadata` column used for state/municipio below.
  let initialDeliveryMode: 'carrier' | 'arranged' | null = null
  try {
    const base = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
    const pub = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
    const r = await fetch(`${base}/store/listings/${medusaProductId}`, {
      headers: { 'x-publishable-api-key': pub },
      cache: 'no-store',
    })
    if (r.ok) {
      const d = await r.json()
      const ml = d?.listing
      if (ml) {
        // Products, and an event with seats (service/digital that the backend tracks) — an untracked
        // service reads `manage_inventory: false`, so it stays null.
        if (listing.listing_type !== 'subscription') {
          availableQuantity = ml.manage_inventory ? (ml.available_quantity ?? null) : null
        }
        medusaAttrs = (ml.attrs as Record<string, unknown>) ?? {}
        medusaCategory = (ml.category as string) ?? ''
        medusaCustomFields = (ml.metadata as Record<string, unknown> | undefined)?.custom_fields ?? []
        initialExcerpt = excerptModel(ml.metadata as Record<string, unknown> | undefined)?.text ?? ''
        initialManageInventory = ml.manage_inventory !== false
        initialAllowBackorder = ml.allow_backorder === true
        initialDispatchEstimate = (ml.dispatch_estimate as string | undefined) ?? null
        const rawDeliveryMode = (ml.metadata as Record<string, unknown> | undefined)?.delivery_mode
        initialDeliveryMode = rawDeliveryMode === 'arranged' ? 'arranged' : rawDeliveryMode === 'carrier' ? 'carrier' : null
      }
    }
  } catch { /* non-fatal */ }

  // Opciones (custom-print-products Story 2.4): the listing's price-grid — the
  // SAME route the public PDP reads, fetched FRESH (not the unstable_cache'd
  // getPriceGrid) so the editor never shows a stale grid right after a save.
  // The route only serves published listings, so skip drafts/paused (the
  // section shows an "activate first" state instead).
  const isActive = listing.status === 'active'
  let priceGrid: PriceGrid | null = null
  if (isActive && listing.listing_type === 'product') {
    try {
      const base = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
      const pub = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
      const r = await fetch(`${base}/store/listings/${medusaProductId}/price-grid`, {
        headers: { 'x-publishable-api-key': pub },
        cache: 'no-store',
      })
      if (r.ok) priceGrid = readPriceGrid(await r.json())
    } catch { /* non-fatal — section shows a reload state */ }
  }

  // Per-variant unit costs (COGS) — seller-private, so read via the
  // seller-scoped GET (the public listing/price-grid reads never carry them;
  // profit-analyzer S1 · US-1). Non-fatal: cost inputs start blank on error.
  // ML price override (catalog-management S2 · 2.3) rides the same seller-
  // scoped GET, same seller-private discipline.
  const variantCosts: Record<string, number | null> = {}
  const variantMlPrices: Record<string, number | null> = {}
  try {
    const clerkJwt = await getToken()
    if (clerkJwt) {
      const base = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
      const pub = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
      const r = await fetch(`${base}/store/sellers/me/products/${medusaProductId}`, {
        headers: { 'x-publishable-api-key': pub, Authorization: `Bearer ${clerkJwt}` },
        cache: 'no-store',
      })
      if (r.ok) {
        const d = await r.json() as {
          variants?: Array<{ id: string; unit_cost_cents: number | null; ml_price_cents: number | null }>
        }
        for (const v of d.variants ?? []) {
          variantCosts[v.id] = v.unit_cost_cents
          // `?? null` guards the backend-deploy-lag window where an older
          // backend build's response omits `ml_price_cents` entirely
          // (`undefined`, not `null`) — without the coercion, EditForm's
          // `initialMlPriceCents` resolves to `undefined`, which is
          // strictly !== null, so an untouched form would spuriously look
          // "dirty" and send `ml_price_cents: null` on any unrelated save
          // (cross-agent review catch).
          variantMlPrices[v.id] = v.ml_price_cents ?? null
        }
      }
    }
  } catch { /* non-fatal */ }

  const typeLabel: Record<string, string> = {
    product: '📦 Producto',
    service: '🔧 Servicio',
    rental: '🔑 Renta',
    digital: '💻 Digital',
    subscription: '🔔 Suscripción',
  }

  // Mercado Libre publish (epic 03 · S3 · US-7/8/9). Dark behind `ml.publish_enabled`;
  // only for products, only when the shop has a connected ML account. Fails closed.
  let mlPublishLink: MlLinkView | undefined
  if (listing.listing_type === 'product' && shopData?.slug && (await isEnabled('ml.publish_enabled'))) {
    const [{ connection }, link] = await Promise.all([
      getMlConnection(shopData.slug),
      getMlProductLink(medusaProductId),
    ])
    if (connection?.status === 'connected') mlPublishLink = link
  }

  // Excerpt editor (bookshop launchpad S2.1) — only for digital listings, gated
  // on `launchpad.enabled` (fail-safe OFF). The PDP viewer renders on presence.
  const launchpadEnabled = listing.listing_type === 'digital' && (await isEnabled('launchpad.enabled'))

  // Inventory-mode selector (catalog-management epic, Sprint 2 · Story 2.1) —
  // fail-safe OFF: while OFF only today's flat quantity input renders, never a
  // mode a buy box won't honor.
  const inventoryChannelsEnabled = await isEnabled('catalog.inventory_channels_enabled')

  // Entrega toggle (arranged-only-delivery epic, Sprint 1 · S1.2) — fail-safe
  // OFF: while OFF the toggle stays hidden and every listing behaves as carrier.
  const arrangedOnlyEnabled = await isEnabled('shipping.arranged_only_enabled')

  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm mb-6">
        <Link href="/shop/manage" className="text-[var(--color-accent)] hover:underline">
          ← Mi tienda
        </Link>
        <span className="text-[var(--color-muted)]">/</span>
        <span className="text-[var(--color-text)] font-medium">Editar anuncio</span>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[var(--color-text)]">Editar anuncio</h1>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-[var(--color-muted)]">
            {typeLabel[listing.listing_type] ?? listing.listing_type}
          </span>
          <span className="text-xs text-[var(--color-muted)]">·</span>
          <Link
            href={listingUrlFor(SITE_ORIGIN, listing.medusa_product_id ?? listing.id)}
            target="_blank"
            className="text-xs text-[var(--color-accent)] hover:underline"
          >
            Ver anuncio ↗
          </Link>
        </div>
      </div>

      {listing.status === 'paused' && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-[var(--r-md)] px-4 py-3 text-sm mb-6">
          <i className="iconoir-pause" aria-hidden /> Este anuncio está pausado — no es visible para compradores. Actívalo desde &quot;Mi tienda&quot;.
        </div>
      )}

      <EditForm
        id={medusaProductId}
        priceGrid={priceGrid}
        isActive={isActive}
        knownMultiVariant={listing.metadata?.has_variants === true}
        variantCosts={variantCosts}
        variantMlPrices={variantMlPrices}
        launchpadEnabled={launchpadEnabled}
        initialExcerpt={initialExcerpt}
        inventoryChannelsEnabled={inventoryChannelsEnabled}
        arrangedOnlyEnabled={arrangedOnlyEnabled}
        shortlink={{
          shopSlug: shopData?.slug ?? '',
          code: (listing.metadata?.short_code as string | undefined) ?? '',
          slug: (listing.metadata?.short_slug as string | undefined) ?? '',
        }}
        initial={{
          title: listing.title,
          description: listing.description ?? '',
          price_cents: listing.price_cents,
          currency: listing.currency ?? 'MXN',
          listing_type: listing.listing_type,
          category: medusaCategory,
          available_quantity: availableQuantity,
          manage_inventory: initialManageInventory,
          allow_backorder: initialAllowBackorder,
          dispatch_estimate: initialDispatchEstimate,
          attrs: medusaAttrs,
          custom_fields: medusaCustomFields,
          images: (listing.images ?? []) as Array<{ url: string; alt?: string }>,
          state: (listing.metadata?.state as string | undefined) ?? '',
          municipio: (listing.metadata?.municipio as string | undefined) ?? '',
          estado_code: (listing.metadata?.estado_code as string | undefined) ?? '',
          delivery_mode: initialDeliveryMode,
        }}
      />

      {mlPublishLink !== undefined && (
        <PublishToMl productId={medusaProductId} title={listing.title} initialLink={mlPublishLink} />
      )}
    </div>
  )
}
