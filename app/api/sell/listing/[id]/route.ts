import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { sanitizeFieldDefs } from '@/lib/personalization'
import { validateSlug } from '@/lib/slug'
import { isShortlinkSegmentTaken } from '@/lib/shortlink-server'
import { isEnabled } from '@/lib/flags'
import { normalizeExcerpt, type Excerpt } from '@/lib/excerpt'
import { setListingStatus, deleteListing } from '@/lib/listing-status'
import { resolveEventSeller } from '@/lib/events-seller'
import { rsvpEventSlug, rsvpEventSyncPatch } from '@/lib/evento-preset'
import { isMlSyncEntitled, reconcileMlToggle } from '@/lib/ml-channel-toggle'

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

// A free Evento is a listing PLUS a `marketplace_events` row (linked by metadata.rsvp_event_slug). Editing
// the listing's title/date/time/venue must update that row in the same save, or the registration page and
// the listing diverge. The slug comes from the listing's stored metadata and the row is matched on the
// AUTHENTICATED seller's own shop — a slug is never trusted on its own, and the update is `.select()`ed back
// because supabase-js reports no error for an UPDATE that matched nothing.
async function syncFreeEventRow(
  productId: string,
  body: { title?: string; attrs?: Record<string, unknown>; state?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (body.title === undefined && body.attrs === undefined) return { ok: true }
  const { data: row } = await db
    .from('marketplace_listings')
    .select('title, state, metadata')
    .eq('medusa_product_id', productId)
    .maybeSingle()
  const slug = rsvpEventSlug((row?.metadata ?? null) as Record<string, unknown> | null)
  if (!slug) return { ok: true } // not a free Evento
  // Without attrs the date/venue did not change; the row still needs a complete patch, so only a title
  // edit is carried alone.
  const context = await resolveEventSeller()
  if (!context) return { ok: false, error: 'No se pudo actualizar el evento. Inténtalo de nuevo.' }
  const patch = body.attrs !== undefined
    ? rsvpEventSyncPatch({
        title: body.title ?? (row?.title as string),
        attrs: body.attrs,
        state: body.state !== undefined ? body.state : (row?.state as string | null),
      })
    : body.title !== undefined
      ? { title: body.title.trim().slice(0, 100) }
      : null
  if (!patch) return { ok: true } // incomplete event block: leave the row as it is
  const { data, error } = await db
    .from('marketplace_events')
    .update(patch)
    .eq('slug', slug)
    .eq('shop_id', context.shop.id)
    .select('id')
  if (error || !data || data.length === 0) {
    console.error('[sell/listing] free event row not updated:', slug, error)
    return { ok: false, error: 'Se guardó el anuncio, pero no se pudo actualizar el evento. Inténtalo de nuevo.' }
  }
  return { ok: true }
}

// ── PUT — edit listing fields ─────────────────────────────────────────────────

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  const { id } = await params

  let body: {
    title?: string
    description?: string
    price_cents?: number | null
    quantity?: number | null
    weight_grams?: number | null
    attrs?: Record<string, unknown>
    custom_fields?: unknown
    short_slug?: string | null
    // Opciones (custom-print-products 2.4) — priced option dimensions +
    // per-variant quantity tiers. Contract + full validation live in the
    // backend (`_utils/seller-product-update.ts`); the proxy only shape-checks.
    option_dimensions?: Array<{ title: string; values: string[] }>
    variant_prices?: Record<string, number>
    variant_id?: string
    variant_tiers?: Array<{ min_quantity: number; max_quantity: number | null; amount: number }>
    // Unit cost (COGS) in centavos for the targeted variant — seller-private,
    // stored on variant metadata (profit-analyzer S1). null clears it.
    unit_cost_cents?: number | null
    // Optional Mercado Libre-specific price override in centavos for the
    // targeted variant — seller-private, stored on variant metadata
    // (catalog-management S2 · 2.3). null clears it (falls back to price_cents).
    ml_price_cents?: number | null
    // Free "Lee un adelanto" text sample for a digital listing (bookshop
    // launchpad S2.1). Stored on product metadata.excerpt; null/empty clears it.
    // Behind `launchpad.enabled` (checked below).
    excerpt?: string | null
    // Inventory mode (catalog-management S2 · 2.1) — the backend translates
    // to the two native variant flags; validated + gated there.
    inventory_mode?: 'tracked' | 'unlimited' | 'backorder'
    dispatch_estimate?: string | null
    // Per-channel publish toggles (catalog-management S2 · 2.2) — gated on
    // `catalog.inventory_channels_enabled` on the backend.
    miyagi_visible?: boolean
    ml_enabled?: boolean
    // Arranged-only delivery (epic, S1.2) — validated + service/rental-forced
    // on the backend (seller-product-update.ts).
    delivery_mode?: 'carrier' | 'arranged' | null
    // Publish / unpublish an EXISTING product to the country marketplace
    // (owned-shop-operating-channel epic, S3.2 · D11). Same shape as create's
    // `publish_to_market`: 'mx' publishes (adds the marketplace channel), null
    // unpublishes (removes ONLY the marketplace channel — the operating channel,
    // and buyability, are never touched). Gated behind
    // `catalog.owned_shop_only_enabled` on the BACKEND, in both directions
    // (product-publication.ts's `planPublicationChange`) — this proxy validates
    // nothing extra, it forwards the field and the backend's 422/423/503 verbatim.
    publish_to_market?: 'mx' | null
    // The edit form also sends the listing's `state` (Mexican state display name); read here only to
    // pick a free Evento's time zone.
    state?: string | null
  }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 }) }

  // Custom product short slug (mschz.org/[slug]) — validate format + flat-namespace
  // uniqueness up front. Empty/null clears it (falls back to the auto short code).
  let nextShortSlug: string | null | undefined
  if (body.short_slug !== undefined) {
    const raw = (body.short_slug ?? '').trim().toLowerCase()
    if (!raw) {
      nextShortSlug = null
    } else {
      const v = validateSlug(raw)
      if (!v.valid) return NextResponse.json({ error: v.reason, field: 'short_slug' }, { status: 422 })
      if (await isShortlinkSegmentTaken(raw, id)) {
        return NextResponse.json({ error: 'Ese enlace corto ya está en uso.', field: 'short_slug' }, { status: 409 })
      }
      nextShortSlug = raw
    }
  }

  if (body.title !== undefined) {
    const t = body.title.trim()
    if (t.length < 5) return NextResponse.json({ error: 'El título debe tener al menos 5 caracteres.', field: 'title' }, { status: 422 })
    if (t.length > 100) return NextResponse.json({ error: 'El título no puede superar los 100 caracteres.', field: 'title' }, { status: 422 })
  }
  if (body.price_cents !== undefined && body.price_cents !== null && body.price_cents < 0) {
    return NextResponse.json({ error: 'El precio no puede ser negativo.', field: 'price' }, { status: 422 })
  }
  if (body.quantity !== undefined && body.quantity !== null && (body.quantity < 0 || !Number.isFinite(body.quantity))) {
    return NextResponse.json({ error: 'La cantidad no puede ser negativa.', field: 'quantity' }, { status: 422 })
  }
  // Opciones payloads — shape checks only (integer-cents amounts; the backend
  // owns the real validation and its es-MX messages surface verbatim below).
  if (body.variant_prices !== undefined) {
    const vals = Object.values(body.variant_prices ?? {})
    if (vals.length === 0 || vals.some(v => !Number.isInteger(v) || v <= 0)) {
      return NextResponse.json({ error: 'Cada combinación necesita un precio entero en centavos mayor a 0.' }, { status: 422 })
    }
  }
  if (body.variant_tiers !== undefined && (!Array.isArray(body.variant_tiers)
    || body.variant_tiers.some(t => !t || !Number.isInteger(t.amount) || t.amount <= 0))) {
    return NextResponse.json({ error: 'Cada nivel necesita un precio entero en centavos mayor a 0.' }, { status: 422 })
  }
  if (body.unit_cost_cents !== undefined && body.unit_cost_cents !== null
    && (!Number.isInteger(body.unit_cost_cents) || body.unit_cost_cents < 0)) {
    return NextResponse.json({ error: 'El costo unitario debe ser de $0 o más.', field: 'unit_cost' }, { status: 422 })
  }
  if (body.ml_price_cents !== undefined && body.ml_price_cents !== null
    && (!Number.isInteger(body.ml_price_cents) || body.ml_price_cents < 0)) {
    return NextResponse.json({ error: 'El precio de Mercado Libre debe ser de $0 o más.', field: 'ml_price' }, { status: 422 })
  }
  // Turning the ML toggle ON requires the `ml_sync` entitlement — checked
  // here (not just client-side) so a direct PUT can't flip `ml_enabled` in
  // Medusa metadata for a non-entitled shop and leave a confusing
  // "enabled but never published" state (the backend's own gate inside
  // publishOrSyncProduct rejects the actual ML write either way, but
  // catching it before any write happens is the honest response).
  if (body.ml_enabled === true && !(await isMlSyncEntitled(userId))) {
    return NextResponse.json(
      { error: 'Esta tienda no tiene el complemento de Mercado Libre habilitado.', field: 'ml_enabled' },
      { status: 402 },
    )
  }
  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: 'Sin cambios.' }, { status: 422 })
  }

  // Excerpt (bookshop launchpad S2.1) — gated on `launchpad.enabled`. Only touch
  // this field when it's present so the flag never affects an ordinary save; if
  // OFF, reject just this field (the editor is hidden while the flag is off, so
  // this only fires for a direct API call). `undefined` = not sent; `null` clears.
  let excerptUpdate: Excerpt | null | undefined
  if (body.excerpt !== undefined) {
    if (!(await isEnabled('launchpad.enabled'))) {
      return NextResponse.json({ error: 'No disponible.', field: 'excerpt' }, { status: 423 })
    }
    excerptUpdate = normalizeExcerpt(body.excerpt)
  }

  const clerkJwt = await getToken()
  if (!clerkJwt) return NextResponse.json({ error: 'Error de autenticación.' }, { status: 401 })

  // Personalization field definitions → sanitised and stored on the Medusa
  // product metadata (the backend update path merges arbitrary metadata).
  const customFields = body.custom_fields !== undefined ? sanitizeFieldDefs(body.custom_fields) : undefined

  // Only call Medusa when a Medusa-owned field actually changed (a short_slug-only
  // save touches just the Supabase mirror).
  const hasMedusaFields = body.title !== undefined || body.description !== undefined
    || body.price_cents !== undefined || body.quantity !== undefined
    || body.weight_grams !== undefined || body.attrs !== undefined || customFields !== undefined
    || excerptUpdate !== undefined
    || body.option_dimensions !== undefined || body.variant_prices !== undefined
    || body.variant_tiers !== undefined || body.unit_cost_cents !== undefined
    || body.ml_price_cents !== undefined
    || body.inventory_mode !== undefined || body.dispatch_estimate !== undefined
    || body.miyagi_visible !== undefined || body.ml_enabled !== undefined
    || body.delivery_mode !== undefined || body.publish_to_market !== undefined
  // Compose ONE metadata object so custom_fields + excerpt never collide as two
  // `metadata` keys in the literal. The backend shallow-merges body.metadata into
  // the product's existing metadata (seller-product-update.ts), so sending only
  // the changed keys is safe; `excerpt: null` clears it.
  const metadataUpdate: Record<string, unknown> = {}
  if (customFields !== undefined) metadataUpdate.custom_fields = customFields
  if (excerptUpdate !== undefined) metadataUpdate.excerpt = excerptUpdate
  if (hasMedusaFields) {
    const res = await medusaFetch(`/store/sellers/me/products/${id}`, clerkJwt, {
      method: 'PATCH',
      body: JSON.stringify({
        ...(body.title !== undefined && { title: body.title.trim() }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.price_cents !== undefined && { price_cents: body.price_cents }),
        ...(body.quantity !== undefined && body.quantity !== null && { quantity: Math.max(0, Math.floor(body.quantity)) }),
        ...(body.weight_grams !== undefined && { weight_grams: body.weight_grams }),
        ...(body.attrs !== undefined && { attrs: body.attrs }),
        ...(Object.keys(metadataUpdate).length > 0 && { metadata: metadataUpdate }),
        ...(body.option_dimensions !== undefined && { option_dimensions: body.option_dimensions }),
        ...(body.variant_prices !== undefined && { variant_prices: body.variant_prices }),
        ...(body.variant_id !== undefined && { variant_id: body.variant_id }),
        ...(body.variant_tiers !== undefined && { variant_tiers: body.variant_tiers }),
        ...(body.unit_cost_cents !== undefined && { unit_cost_cents: body.unit_cost_cents }),
        ...(body.ml_price_cents !== undefined && { ml_price_cents: body.ml_price_cents }),
        ...(body.inventory_mode !== undefined && { inventory_mode: body.inventory_mode }),
        ...(body.dispatch_estimate !== undefined && { dispatch_estimate: body.dispatch_estimate }),
        ...(body.miyagi_visible !== undefined && { miyagi_visible: body.miyagi_visible }),
        ...(body.ml_enabled !== undefined && { ml_enabled: body.ml_enabled }),
        ...(body.delivery_mode !== undefined && { delivery_mode: body.delivery_mode }),
        ...(body.publish_to_market !== undefined && { publish_to_market: body.publish_to_market }),
      }),
    })

    if (res.status === 403) return NextResponse.json({ error: 'No tienes permiso para modificar este anuncio.' }, { status: 403 })
    if (res.status === 404) return NextResponse.json({ error: 'Anuncio no encontrado.' }, { status: 404 })
    if (!res.ok) {
      // Surface the backend's es-MX message verbatim, preserving 4xx statuses
      // (the Opciones flow shows exact 422 texts — order-history refusal,
      // tier-ladder gaps, mutual-exclusivity — instead of a generic error).
      // 503 is ALSO preserved verbatim (not collapsed into the generic 500 below)
      // — owned-shop-operating-channel epic S3.2's publish/unpublish PATCH can
      // refuse with 503 when the marketplace channel is unaddressable, and that
      // is an infra-outage fact distinct from every 4xx caller-input refusal.
      const d = await res.json().catch(() => ({})) as { message?: string }
      const status = res.status === 503 || (res.status >= 400 && res.status < 500) ? res.status : 500
      return NextResponse.json({ error: d.message ?? 'Error al guardar los cambios.' }, { status })
    }

    // D11 staleness — this repo's own ISR/`unstable_cache` layer (lib/listings.ts)
    // caches channel membership as part of the listing/shop read, and Medusa
    // itself invalidates nothing on this side. Revalidate both tags right after a
    // successful publish/unpublish so `/mx`, the shop page and the listing detail
    // reflect the new membership on the NEXT request rather than after a deploy —
    // the same pair every other seller-facing catalog write in this repo already
    // revalidates (app/api/sell/ml/publish, app/api/sell/shop, …).
    if (body.publish_to_market !== undefined) {
      revalidateTag('listings', 'default')
      revalidateTag('shops', 'default')
    }
  }

  // Merge a custom short slug into the mirror metadata (preserving short_code + the
  // rest). Done as a read-merge-write so we never clobber other metadata. A
  // successful convert also stamps `has_variants: true` — the publish-status-
  // independent multi-variant signal the edit form needs, since the price-grid
  // route can't answer for a paused/draft listing (cross-agent review catch,
  // Antigravity round 2, 2026-07-05). Dimensions can never be removed, so the
  // flag never needs clearing.
  const convertSucceeded = body.option_dimensions !== undefined
  let mirrorMetadata: Record<string, unknown> | undefined
  if (nextShortSlug !== undefined || convertSucceeded) {
    const { data: row } = await db
      .from('marketplace_listings').select('metadata').eq('medusa_product_id', id).maybeSingle()
    const meta = ((row?.metadata ?? {}) as Record<string, unknown>)
    if (nextShortSlug !== undefined) {
      if (nextShortSlug === null) delete (meta as Record<string, unknown>).short_slug
      else meta.short_slug = nextShortSlug
    }
    if (convertSucceeded) meta.has_variants = true
    mirrorMetadata = meta
  }

  // A successful convert replaces the flat price with per-combination prices —
  // keep the mirror's price_cents in sync as the cheapest combination (the
  // "desde $X" display price the Medusa listing shape derives from variants).
  let minVariantPrice = body.option_dimensions !== undefined && body.variant_prices
    ? Math.min(...Object.values(body.variant_prices))
    : undefined

  // A tier edit can change a variant's base (qty=1) price too — recompute the
  // mirror from the live price-grid so "desde $X" never goes stale (cross-agent
  // review catch, Antigravity, 2026-07-05). Same semantic as the backend's
  // toListingShape: min across variants of each variant's LOWEST-min_quantity
  // tier (the grid sorts tiers ascending, so tiers[0] is the base). Best-effort:
  // a failed read just leaves the mirror as-is rather than failing the save.
  if (body.variant_tiers !== undefined && minVariantPrice === undefined) {
    try {
      const gridRes = await fetch(`${MEDUSA_BASE}/store/listings/${id}/price-grid`, {
        headers: { 'x-publishable-api-key': PUB_KEY },
        cache: 'no-store',
      })
      if (gridRes.ok) {
        const grid = (await gridRes.json())?.price_grid as
          | { variants?: Array<{ tiers?: Array<{ amount?: number }> }> }
          | undefined
        const basePrices = (grid?.variants ?? [])
          .map(v => v.tiers?.[0]?.amount)
          .filter((a): a is number => typeof a === 'number' && a > 0)
        if (basePrices.length > 0) minVariantPrice = Math.min(...basePrices)
      }
    } catch { /* best-effort — keep the current mirror price */ }
  }

  // A free Evento's registration row must follow its listing: same title, start and venue.
  const eventSync = await syncFreeEventRow(id, body)

  await db
    .from('marketplace_listings')
    .update({
      ...(body.title !== undefined && { title: body.title.trim() }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.price_cents !== undefined && { price_cents: body.price_cents }),
      ...(minVariantPrice !== undefined && Number.isFinite(minVariantPrice) && { price_cents: minVariantPrice }),
      ...(mirrorMetadata !== undefined && { metadata: mirrorMetadata }),
      updated_at: new Date().toISOString(),
    })
    .eq('medusa_product_id', id)

  if (!eventSync.ok) return NextResponse.json({ error: eventSync.error }, { status: 500 })

  // Reconcile the live ML listing right after a successful ml_enabled toggle
  // write (catalog-management S2 · 2.2) — mirrors the pause/delete cascade.
  const mlToggleResult = body.ml_enabled !== undefined
    ? await reconcileMlToggle(userId, id, body.ml_enabled)
    : {}

  return NextResponse.json({ id, updated: true, short_slug: nextShortSlug, ...mlToggleResult })
}

// ── PATCH — update listing status ─────────────────────────────────────────────
// Checkout-viability check + status-change orchestration now live in
// lib/listing-status.ts (catalog-management S3 · 3.1 extraction) — shared
// with the catalog bulk-apply path.

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  const { id } = await params

  let body: { status?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 }) }

  const allowed = ['active', 'paused']
  if (!body.status || !allowed.includes(body.status)) {
    return NextResponse.json({ error: 'Estado inválido. Usa "active" o "paused".' }, { status: 422 })
  }

  const clerkJwt = await getToken()
  if (!clerkJwt) return NextResponse.json({ error: 'Error de autenticación.' }, { status: 401 })

  // Orchestration (viability gate, metadata.paused, Supabase mirror, ML-close
  // cascade, launchpad notify) lives in lib/listing-status.ts — shared with
  // the catalog bulk-apply path (catalog-management S3 · 3.1) so a bulk pause
  // can't bypass the Sprint 1.3 pausado/borrador fix.
  const result = await setListingStatus(id, body.status as 'active' | 'paused', { userId, clerkJwt })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ id, status: body.status })
}

// ── DELETE — unpublish listing ────────────────────────────────────────────────
// Orchestration (Supabase mirror + ML-close cascade) lives in
// lib/listing-status.ts's deleteListing() — shared with the catalog
// bulk-apply path (catalog-management S3 · 3.2).

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  const { id } = await params

  const clerkJwt = await getToken()
  if (!clerkJwt) return NextResponse.json({ error: 'Error de autenticación.' }, { status: 401 })

  const result = await deleteListing(id, { userId, clerkJwt })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ id, deleted: true })
}
