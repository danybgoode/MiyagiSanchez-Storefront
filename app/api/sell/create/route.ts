import { listingNotReadyRefusal, listingReadiness, ownerShopFacts } from '@/lib/listing-readiness'
import { NextRequest, NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { tg } from '@/lib/telegram'
import { createSubscriptionPrice } from '@/lib/stripe-subscriptions'
import { ensureSupabaseShopMirror, syncSupabaseListingMirror, type MedusaSellerForMirror } from '@/lib/provisioning'
import { notifyShopCreated, retryShopCreatedWelcome } from '@/lib/shop-created-welcome'
import { resolveSellerSignupMarket } from '@/lib/seller-signup-market'
import { sellerListingCurrency } from '@/lib/seller-listing-currency'
import { db } from '@/lib/supabase'
import { uniqueEventSlug } from '@/lib/events'
import { buildRsvpEventDraft, isFreeEventListing, MAX_EVENT_SEATS, EVENT_SEATS_TOO_MANY_MESSAGE, type RsvpEventDraft } from '@/lib/evento-preset'
import { createQuantityForBackend, hasEventBlock, isEventCapableType, SEATS_NEGATIVE_MESSAGE } from '@/lib/event-seats'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

function medusaFetch(path: string, clerkJwt: string, options?: RequestInit) {
  return fetch(`${MEDUSA_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PUB_KEY,
      Authorization: `Bearer ${clerkJwt}`,
      ...(options?.headers ?? {}),
    },
  })
}

interface CreatePayload {
  /** «Publicar como catálogo»: publish a product nobody can pay for online, on purpose (listing-readiness D4). */
  publish_as_catalog?: boolean
  createShop?: {
    name: string
    slug?: string
    state: string
    city?: string
    description?: string
    market?: unknown
  }
  listing: {
    title: string
    description?: string
    price_cents?: number | null
    currency?: string
    condition?: string | null
    quantity?: number | null
    weight_grams?: number | null
    attrs?: Record<string, unknown>
    listing_type: string
    category: string
    state?: string
    municipio?: string
    location?: string
    images: Array<{ url: string; alt: string }>
    digital_file?: {
      path: string
      name: string
      size: number
      mime: string
      label: string
    } | null
    repuve?: { status: 'sin_reporte' | 'con_reporte'; folio?: string } | null
    subscription?: { interval: 'month' | 'year'; content_description?: string } | null
    subscription_tiers?: Array<{
      id: string; label: string; price_cents: number
      interval: 'month' | 'year'; features: string[]; is_highlighted: boolean
    }> | null
    /** Arranged-only delivery (epic, S1.2) — 'carrier' (default) or 'arranged'. */
    delivery_mode?: 'carrier' | 'arranged'
    /**
     * Marketplace publication intent at create time (owned-shop-operating-channel
     * epic, S3.1). Omitted (the default) preserves today's behaviour byte-for-
     * byte — publish into the seller's own market. `null` is "solo mi tienda":
     * buyable on the owned shop, absent from every country marketplace. Only
     * ever sent when `catalog.owned_shop_only_enabled` is ON (SellWizard gates
     * the checkbox on the flag prop it's given); the backend refuses `null` with
     * an actionable 422 while the flag is off regardless, so a stale client is
     * still safe.
     */
    publish_to_market?: 'mx' | null
  }
}

export async function POST(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) {
    return NextResponse.json({ error: 'No autenticado. Inicia sesión para publicar.' }, { status: 401 })
  }

  let body: CreatePayload
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 })
  }

  // ── Validate ─────────────────────────────────────────────────────────────
  const titleClean = body.listing?.title?.trim() ?? ''
  if (titleClean.length < 5) return NextResponse.json({ error: 'El título debe tener al menos 5 caracteres.', field: 'title' }, { status: 422 })
  if (titleClean.length > 100) return NextResponse.json({ error: 'El título no puede superar los 100 caracteres.', field: 'title' }, { status: 422 })
  if (!body.listing.category) return NextResponse.json({ error: 'Selecciona una categoría.', field: 'category' }, { status: 422 })
  // Seats on an event: a negative or fractional count is refused before any shop or product is written.
  if (isEventCapableType(body.listing.listing_type) && hasEventBlock(body.listing.attrs)
    && body.listing.quantity != null && (!Number.isInteger(body.listing.quantity) || body.listing.quantity < 0)) {
    return NextResponse.json({ error: SEATS_NEGATIVE_MESSAGE, field: 'quantity' }, { status: 422 })
  }
  // ...and an absurd one is refused out loud, not capped (the RSVP row used to cap at 100,000 silently).
  if (isEventCapableType(body.listing.listing_type) && hasEventBlock(body.listing.attrs)
    && typeof body.listing.quantity === 'number' && body.listing.quantity > MAX_EVENT_SEATS) {
    return NextResponse.json({ error: EVENT_SEATS_TOO_MANY_MESSAGE, field: 'quantity' }, { status: 422 })
  }

  // A free Evento (service + event block + $0) is also an RSVP event: validate the row it needs before
  // any shop or product is written, so a refused request has changed nothing.
  const freeEvent = isFreeEventListing(body.listing)
  let rsvpDraft: RsvpEventDraft | null = null
  if (freeEvent) {
    const built = buildRsvpEventDraft({
      title: titleClean,
      description: body.listing.description,
      quantity: body.listing.quantity,
      attrs: body.listing.attrs,
      state: body.listing.state,
    })
    if (!built.ok) return NextResponse.json({ error: built.error, field: built.field }, { status: 422 })
    rsvpDraft = built.draft
  }

  const isSubscription = body.listing.listing_type === 'subscription'
  const hasMultiTier = isSubscription && Array.isArray(body.listing.subscription_tiers) && (body.listing.subscription_tiers?.length ?? 0) > 0

  if (isSubscription && !hasMultiTier) {
    if (!body.listing.price_cents || body.listing.price_cents <= 0) {
      return NextResponse.json({ error: 'Las suscripciones deben tener un precio.', field: 'price' }, { status: 422 })
    }
    const interval = body.listing.subscription?.interval
    if (!interval || !['month', 'year'].includes(interval)) {
      return NextResponse.json({ error: 'Selecciona el período de facturación.', field: 'subscription_interval' }, { status: 422 })
    }
  }

  // ── Auth — pass Clerk JWT directly (backend uses extractClerkUserId) ──────
  const clerkJwt = await getToken()
  if (!clerkJwt) return NextResponse.json({ error: 'Error de autenticación.' }, { status: 401 })

  // ── Ensure seller exists (create on first publish) ──────────────────────
  let shopSlug: string
  let sellerId: string | null = null
  let sellerName: string | null = null
  let sellerForMirror: MedusaSellerForMirror | null = null
  {
    const sellerRes = await medusaFetch('/store/sellers/me', clerkJwt)

    if (sellerRes.ok) {
      // Seller already exists — use it
      const sellerData = await sellerRes.json()
      sellerForMirror = sellerData.seller
      shopSlug = sellerForMirror!.slug
      sellerId = sellerForMirror!.id ?? null
      sellerName = sellerForMirror!.name ?? null
      await retryShopCreatedWelcome(sellerForMirror!).catch((error) => {
        console.error('[sell/create] shop welcome retry failed:', sellerId, error)
      })
    } else if (sellerRes.status === 404) {
      // No Medusa seller yet — create one.
      // Use explicit shop name from form (new users) or fall back to Clerk name
      // (legacy Supabase users who skipped the shop creation step).
      let shopName = body.createShop?.name?.trim() ?? ''
      if (!shopName) {
        const clerkUser = await currentUser()
        shopName = [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(' ')
          || clerkUser?.emailAddresses[0]?.emailAddress?.split('@')[0]
          || 'Mi tienda'
      }
      if (shopName.length < 2) {
        return NextResponse.json({ error: 'El nombre de la tienda debe tener al menos 2 caracteres.', field: 'shopName' }, { status: 422 })
      }

      const location = body.createShop
        ? [body.createShop.city?.trim(), body.createShop.state?.trim()].filter(Boolean).join(', ') || null
        : null
      const operatingMarket = resolveSellerSignupMarket(body.createShop?.market)
      const intendedCurrency = sellerListingCurrency(operatingMarket ? { operating_market: operatingMarket } : null)
      if (body.listing.currency && body.listing.currency.toUpperCase() !== intendedCurrency) {
        return NextResponse.json({ error: `La moneda de esta tienda es ${intendedCurrency}.`, field: 'currency' }, { status: 422 })
      }

      const createRes = await medusaFetch('/store/sellers/me', clerkJwt, {
        method: 'POST',
        body: JSON.stringify({
          name: shopName,
          ...(body.createShop?.slug?.trim() && { slug: body.createShop.slug.trim() }),
          description: body.createShop?.description?.trim() || null,
          location,
          ...(operatingMarket ? { operating_market: operatingMarket } : {}),
        }),
      })
      const createData = await createRes.json()
      if (!createRes.ok || !createData.seller) {
        console.error('[sell/create] seller creation failed:', createRes.status, createData)
        return NextResponse.json({ error: 'No se pudo crear la tienda. Inténtalo de nuevo.' }, { status: 500 })
      }
      sellerForMirror = createData.seller
      shopSlug = sellerForMirror!.slug
      sellerId = sellerForMirror!.id ?? null
      sellerName = sellerForMirror!.name ?? null
      // The first-listing path can create the seller without visiting /sell/shop.
      // Send at creation, even if listing setup later fails.
      await notifyShopCreated(userId, sellerForMirror!).catch((error) => {
        console.error('[sell/create] shop welcome failed:', sellerId, error)
      })
    } else {
      // Unexpected error from backend — surface it for easier debugging
      const errBody = await sellerRes.json().catch(() => ({})) as { message?: string }
      console.error('[sell/create] sellers/me failed:', sellerRes.status, errBody)
      return NextResponse.json({
        error: errBody.message ?? `Error ${sellerRes.status} al verificar tu tienda. Inténtalo de nuevo.`,
      }, { status: 500 })
    }
  }

  const listingCurrency = sellerListingCurrency(sellerForMirror?.metadata)
  if (!listingCurrency) {
    console.error('[sell/create] seller has unsupported persisted market:', sellerId)
    return NextResponse.json({ error: 'El mercado de esta tienda no es compatible. Escríbenos para corregirlo.' }, { status: 409 })
  }
  if (body.listing.currency && body.listing.currency.toUpperCase() !== listingCurrency) {
    return NextResponse.json({ error: `La moneda de esta tienda es ${listingCurrency}.`, field: 'currency' }, { status: 422 })
  }

  // ── Can a buyer pay for this online? (listing-readiness S1.2) ─────────────
  // The new-listing form was the one door that never asked: a product went live on a shop with no payment method, a
  // buyer made an offer, the seller accepted it, and nobody could pay (miel-verduras, 2026-11-11). The SAME rule as
  // activation and MCP (lib/listing-readiness.ts) over the owner's private facts. A catalog listing goes live only
  // when the merchant chose «Publicar como catálogo» (`publish_as_catalog`); the 422 carries what is missing so the
  // form can open its readiness panel. Nothing has been written to Medusa yet at this point.
  const readinessRefusal = listingNotReadyRefusal(
    listingReadiness({
      listingType: body.listing.listing_type,
      deliveryMode: body.listing.delivery_mode ?? null,
      shop: ownerShopFacts(sellerForMirror?.metadata ?? null),
    }),
    body.publish_as_catalog === true,
  )
  if (readinessRefusal) {
    return NextResponse.json(
      { error: readinessRefusal.error, code: readinessRefusal.code, missing: readinessRefusal.missing },
      { status: 422 },
    )
  }

  // ── Build product metadata ────────────────────────────────────────────────
  const effectivePriceCents = hasMultiTier
    ? Math.min(...(body.listing.subscription_tiers ?? []).map(t => t.price_cents))
    : (body.listing.price_cents ?? null)

  // For subscription tiers: create Stripe Prices now so we have stripe_price_id in metadata
  type TierWithStripe = {
    id: string; label: string; price_cents: number
    interval: 'month' | 'year'; features: string[]; is_highlighted: boolean
    stripe_price_id?: string
  }
  let tiersWithPriceIds: TierWithStripe[] = []
  if (isSubscription && hasMultiTier && sellerId) {
    tiersWithPriceIds = await Promise.all(
      (body.listing.subscription_tiers ?? []).map(async (t) => {
        try {
          const { priceId } = await createSubscriptionPrice({
            listingId: 'pending', // Will be backfilled after product creation
            shopId: sellerId!,
            title: `${body.listing.title?.trim()} — ${t.label.trim()}`,
            description: null,
            price_cents: t.price_cents,
            currency: listingCurrency.toLowerCase(),
            interval: t.interval,
          })
          return { ...t, label: t.label.trim(), features: t.features.filter(Boolean), stripe_price_id: priceId }
        } catch (e) {
          console.error('[sell/create] Stripe price creation failed for tier:', t.label, e)
          return { ...t, label: t.label.trim(), features: t.features.filter(Boolean) }
        }
      })
    )
  }

  // Single-tier subscription: create one Stripe Price
  let singleTierStripePriceId: string | null = null
  if (isSubscription && !hasMultiTier && body.listing.price_cents && sellerId) {
    try {
      const { priceId } = await createSubscriptionPrice({
        listingId: 'pending',
        shopId: sellerId,
        title: body.listing.title?.trim() ?? 'Suscripción',
        description: null,
        price_cents: body.listing.price_cents,
        currency: listingCurrency.toLowerCase(),
        interval: body.listing.subscription?.interval ?? 'month',
      })
      singleTierStripePriceId = priceId
    } catch (e) {
      console.error('[sell/create] Stripe price creation failed:', e)
    }
  }

  // Free Evento: the RSVP row goes in FIRST so its slug can ride the listing's metadata, and is removed
  // again if the product cannot be created (no orphan event with no listing).
  let rsvpEvent: { id: string; slug: string } | null = null
  if (rsvpDraft) {
    const shopMirror = await ensureSupabaseShopMirror(sellerForMirror!, userId).catch(() => null)
    if (!shopMirror?.id || !sellerId) {
      console.error('[sell/create] free event: no shop mirror')
      return NextResponse.json({ error: 'No se pudo crear el evento. Inténtalo de nuevo.' }, { status: 500 })
    }
    const slug = await uniqueEventSlug(rsvpDraft.title)
    const { data: eventRow, error: eventError } = await db
      .from('marketplace_events')
      .insert({ ...rsvpDraft, slug, shop_id: shopMirror.id, medusa_seller_id: sellerId, created_by: userId, status: 'active' })
      .select('id, slug')
      .single()
    if (eventError || !eventRow) {
      console.error('[sell/create] free event row failed:', eventError?.message ?? 'no row returned')
      return NextResponse.json({ error: 'No se pudo crear el evento. Inténtalo de nuevo.' }, { status: 500 })
    }
    rsvpEvent = { id: eventRow.id as string, slug: eventRow.slug as string }
  }

  const metadata: Record<string, unknown> = {
    ...(body.listing.condition ? { condition: body.listing.condition } : {}),
    ...(body.listing.state ? { state: body.listing.state } : {}),
    ...(body.listing.municipio ? { municipio: body.listing.municipio } : {}),
    ...(body.listing.digital_file ? { digital_file: body.listing.digital_file } : {}),
    ...(rsvpEvent ? { rsvp_event_slug: rsvpEvent.slug } : {}),
    ...(body.listing.repuve?.status ? { repuve: { status: body.listing.repuve.status, folio: body.listing.repuve.folio?.trim().toUpperCase() || null, verified_at: new Date().toISOString() } } : {}),
    ...(isSubscription && !hasMultiTier ? {
      subscription: {
        interval: body.listing.subscription!.interval,
        content_description: body.listing.subscription?.content_description?.trim() || null,
        stripe_price_id: singleTierStripePriceId,
      }
    } : {}),
    ...(isSubscription && hasMultiTier ? { subscription_tiers: tiersWithPriceIds } : {}),
  }

  // ── Create product in Medusa ──────────────────────────────────────────────
  const productRes = await medusaFetch('/store/sellers/me/products', clerkJwt, {
    method: 'POST',
    body: JSON.stringify({
      title: titleClean,
      description: body.listing.description?.trim() || null,
      price_cents: effectivePriceCents,
      currency: listingCurrency,
      condition: body.listing.listing_type === 'product' ? (body.listing.condition ?? null) : null,
      listing_type: body.listing.listing_type ?? 'physical',
      // Arranged-only delivery (epic, S1.2) — a TOP-LEVEL field (not inside
      // `metadata`) so it can't be shadowed by a stray metadata.delivery_mode;
      // the backend forces 'arranged' for service/rental regardless of this value.
      delivery_mode: body.listing.delivery_mode ?? 'carrier',
      category: body.listing.category,
      state: body.listing.state || null,
      municipio: body.listing.municipio || null,
      location: [body.listing.municipio?.trim(), body.listing.state?.trim()].filter(Boolean).join(', ') || null,
      // Products: at least 1. An event: its seats, or nothing — a defaulted 1 would make an
      // untracked event a one-seat event (lib/event-seats.ts).
      // A free Evento keeps its seats in the RSVP row (capacity), not in Medusa inventory.
      quantity: freeEvent ? undefined : createQuantityForBackend(body.listing),
      weight_grams: body.listing.weight_grams ?? null,
      attrs: body.listing.attrs ?? {},
      images: body.listing.images ?? [],
      metadata,
      // "Solo mi tienda" (owned-shop-operating-channel epic, S3.1) — omitted
      // when undefined so every existing caller's request body is byte-identical
      // to before this field existed.
      ...(body.listing.publish_to_market !== undefined && { publish_to_market: body.listing.publish_to_market }),
    }),
  })

  const productData = await productRes.json().catch(() => ({}))
  if (!productRes.ok || !productData.product_id) {
    console.error('[sell/create] product creation failed:', productData)
    if (rsvpEvent) {
      // Report a failed cleanup instead of ignoring it, so an orphan event can be found and removed.
      const { data: removed, error: removeError } = await db.from('marketplace_events').delete().eq('id', rsvpEvent.id).select('id')
      if (removeError || !removed?.length) {
        console.error('[sell/create] orphan free event not removed:', rsvpEvent.id, removeError?.message ?? 'no row matched')
      }
    }
    // Surface the backend's own es-MX refusal (422 cross-market/flag-off, 423,
    // 503 channel-unaddressable — product-publication.ts) instead of a generic
    // 500, same as the listing PUT/PATCH proxy does. Any other status (a real
    // backend fault) still reads as a generic 500 with the fallback copy below.
    const status = productRes.status === 503 || (productRes.status >= 400 && productRes.status < 500)
      ? productRes.status
      : 500
    return NextResponse.json(
      { error: productData.message ?? 'Error al publicar el anuncio. Inténtalo de nuevo.' },
      { status },
    )
  }

  const listingId = productData.product_id

  // ── Backwards-compatible Supabase mirror ────────────────────────────────
  // Medusa now owns sellers/products, but several seller-console features still
  // use Supabase UUID foreign keys. Keep a mirror row so /shop/manage/settings,
  // offers, subscriptions, and order records can find the newly provisioned shop.
  try {
    if (sellerForMirror) {
      const shopMirror = await ensureSupabaseShopMirror(sellerForMirror, userId)
      if (shopMirror?.id) {
        await syncSupabaseListingMirror(shopMirror.id, {
          id: listingId,
          title: titleClean,
          description: body.listing.description?.trim() || null,
          price_cents: effectivePriceCents,
          currency: listingCurrency,
          condition: body.listing.listing_type === 'product' ? (body.listing.condition ?? null) : null,
          listing_type: body.listing.listing_type ?? 'product',
          category: body.listing.category,
          state: body.listing.state || null,
          municipio: body.listing.municipio || null,
          location: [body.listing.municipio?.trim(), body.listing.state?.trim()].filter(Boolean).join(', ') || null,
          images: body.listing.images ?? [],
          status: 'active',
          metadata,
        })
      }
    }
  } catch (e) {
    console.error('[sell/create] Supabase mirror sync failed (non-fatal):', e)
  }

  // ── Register subscription plans in Medusa (non-fatal) ────────────────────
  if (isSubscription && sellerId && clerkJwt) {
    const plansToCreate: Array<{
      label: string; price_cents: number; interval: string
      stripe_price_id?: string; description?: string
    }> = hasMultiTier
      ? tiersWithPriceIds.map(t => ({
          label: t.label,
          price_cents: t.price_cents,
          interval: t.interval,
          stripe_price_id: t.stripe_price_id,
        }))
      : [{
          label: sellerName ? `Suscripción — ${sellerName}` : 'Suscripción',
          price_cents: body.listing.price_cents ?? 0,
          interval: body.listing.subscription?.interval ?? 'month',
          stripe_price_id: singleTierStripePriceId ?? undefined,
        }]

    // Create plans via Medusa backend (fire-and-forget, non-fatal)
    Promise.all(
      plansToCreate.map(plan =>
        medusaFetch('/store/sellers/me/subscription-plans', clerkJwt, {
          method: 'POST',
          body: JSON.stringify({
            product_id: listingId,
            label: plan.label,
            description: plan.description ?? null,
            price_cents: plan.price_cents,
            currency: listingCurrency.toLowerCase(),
            interval: plan.interval,
            stripe_price_id: plan.stripe_price_id ?? null,
            metadata: { listing_id: listingId },
          }),
        }).catch(e => console.error('[sell/create] subscription plan creation failed:', e))
      )
    ).catch(() => {})
  }

  // ── Telegram notification ────────────────────────────────────────────────
  const priceCents = body.listing.price_cents
  const priceFmt = priceCents
    ? new Intl.NumberFormat('es-MX', { style: 'currency', currency: listingCurrency }).format(priceCents / 100)
    : 'Precio a consultar'
  tg.newListing(titleClean, priceFmt, shopSlug, listingId)

  return NextResponse.json({ shopSlug, listingId }, { status: 201 })
}
