import { NextRequest, NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { revalidateTag } from 'next/cache'
import { db } from '@/lib/supabase'
import { syncMedusaSellerProfile } from '@/lib/medusa-seller-sync'
import { ensureShop, type ShopCreateInput } from '@/lib/ensure-shop'
import { resolveSellerSignupMarket } from '@/lib/seller-signup-market'
import { normalizeSupportSettings } from '@/lib/support-widget'
import { httpUrl } from '@/lib/settings-import'
import { validateSectionConfig } from '@/lib/shop-presentation/sections'

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

// ── POST — create the seller/shop on its own (before any listing exists) ──────
// Decouples shop creation from listing creation: the onboarding wizard calls this
// when Step 1 (shop info) completes, so abandoning before publishing a listing
// still leaves a reachable /shop/manage. Idempotent — returns the existing seller
// if one is already provisioned. Delegates to lib/ensure-shop.ts (extracted
// onboarding-three-doors Sprint 1 · Story 1.2b) so the same idempotent
// create-or-get is callable from other server code, not just this route.

export async function POST(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  let body: ShopCreateInput & { market?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 }) }

  const clerkJwt = await getToken()
  if (!clerkJwt) return NextResponse.json({ error: 'Error de autenticación.' }, { status: 401 })

  // ── The intended market (us-marketplace S5.2 / D17) ──────────────────────────
  //
  // The onboarding form sends where the merchant signed up from; this route decides
  // what that means. `resolveSellerSignupMarket` NARROWS an arbitrary string to a
  // real, open market or to nothing — so the body cannot name a market that does not
  // exist, or one that is not accepting shops.
  //
  // It is not a security boundary and does not pretend to be: the backend's
  // `planSellerCreationMarket` refuses an invalid market (422) and refuses to move an
  // existing shop across countries (409). This is the layer that makes the common
  // case correct; that one makes every case safe.
  const result = await ensureShop(userId, clerkJwt, {
    ...body,
    operatingMarket: resolveSellerSignupMarket(body.market),
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error, ...(result.field && { field: result.field }) }, { status: result.status })
  }
  return NextResponse.json({ shopSlug: result.shopSlug }, { status: result.status })
}

// ── PATCH — update shop profile + settings ───────────────────────────────────

interface ShopUpdatePayload {
  name?: string
  description?: string
  state?: string
  city?: string
  logo_url?: string | null
  mp_enabled?: boolean
  stripe_enabled?: boolean
  ucp_webhook_url?: string | null
  ucp_webhook_secret?: string | null
  // metadata.settings fields
  settings?: {
    preset?: string
    checkout?: {
      escrow_mode?: 'off' | 'optional' | 'required'
      payment_methods?: string[]
      show_phone?: boolean
      phone?: string | null
      whatsapp_cta?: boolean
      show_email?: boolean
      contact_email?: string | null
      bank_transfer?: {
        enabled?: boolean
        clabe?: string | null
        bank_name?: string | null
        account_holder?: string | null
      }
    }
    shipping?: {
      mercado_envios?: boolean
      local_pickup?: boolean
      custom_rates?: boolean
      envia_enabled?: boolean
      allowed_carriers?: string[]
      rate_display?: 'recommended' | 'cheapest' | 'all'
      handling_fee_cents?: number
      package_defaults?: {
        weight_grams?: number
        length_cm?: number
        width_cm?: number
        height_cm?: number
      }
      pickup_spots?: Array<{ name?: string; address?: string; instructions?: string }>
      origin_address?: Record<string, string | null>
    }
    notifications?: {
      email_new_view?: boolean
      email_new_message?: boolean
    }
    theme?: {
      banner_url?: string | null
      accent_color?: string | null
      tagline?: string | null
      social?: {
        instagram?: string
        facebook?: string
        whatsapp?: string
        tiktok?: string
        twitter?: string
      }
    }
    // Own-shop premium presentation (epic 07, Sprint 1) — siblings of `theme`,
    // not nested inside it (see lib/shop-settings/types.ts).
    announcement?: { text: string; link?: string | null } | null
    hero?: {
      mode: 'listings' | 'promo'
      pinned_listing_ids?: string[]
      promo_image_url?: string | null
      promo_cta_text?: string | null
      promo_cta_link?: string | null
    } | null
    theme_preset?: string | null
    /**
     * Living Shop (epic 07, Story 3.1) — the controlled information
     * architecture. Typed as `unknown` on purpose: the shape is owned by
     * `lib/shop-presentation/sections.ts`, and re-declaring it here would fork
     * the contract into two places that can disagree. It is validated and
     * normalized through that module below.
     */
    sections?: unknown
    offers?: {
      min_buyer_trust_level?: string
      negotiation?: {
        enabled?: boolean
        auto_accept_pct?: number
        auto_decline_pct?: number
        auto_counter_pct?: number
      }
    }
    scheduling?: {
      links?: Array<{ label: string; url: string }>
    }
    orders?: {
      processing_time?: string
      auto_accept?: boolean
      dispatch_window_days?: number
      auto_confirm_days?: number
    }
    returns_policy?: {
      window?: string
      conditions?: string
      shipping_paid_by?: 'buyer' | 'seller'
      custom_note?: string | null
    } | null
    support?: {
      enabled?: boolean
      preset_amount_cents?: number[]
      custom_min_cents?: number
      custom_max_cents?: number
      currency?: string
      default_visibility?: 'public' | 'private'
      support_product_id?: string | null
    }
    // Bookshop launchpad (epic 03) — writer-submission opt-in + guidelines.
    launchpad?: {
      accepts_manuscripts?: boolean
      guidelines?: string | null
    }
    // Dashboard setup guide (seller-portal-setup-guide epic, B.3) — dismiss/restore
    // + first-share tracking. Absent = show the guide (fail-safe default).
    guide?: {
      guide_dismissed?: boolean
      share_done?: boolean
    }
  }
}

export async function PATCH(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  let body: ShopUpdatePayload
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 }) }

  // ── Validation ────────────────────────────────────────────────────────────
  if (body.name !== undefined) {
    const name = body.name.trim()
    if (name.length < 2) return NextResponse.json({ error: 'El nombre debe tener al menos 2 caracteres.', field: 'name' }, { status: 422 })
    if (name.length > 80) return NextResponse.json({ error: 'El nombre no puede superar los 80 caracteres.', field: 'name' }, { status: 422 })
  }
  if (body.description !== undefined && body.description.length > 500) {
    return NextResponse.json({ error: 'La descripción no puede superar los 500 caracteres.', field: 'description' }, { status: 422 })
  }
  // Own-shop premium presentation (epic 07, Sprint 1) — these render straight into
  // a public href/src (AnnouncementBar/HeroSection), so this route enforces the
  // exact same http(s)-only rule as the MCP/Storefront-as-Code path
  // (lib/settings-import.ts's httpUrl) — the seller-UI save path must not be a
  // second, unvalidated way for a non-http(s) scheme (e.g. `javascript:`) to
  // reach a rendered link.
  const announcementLink = body.settings?.announcement?.link
  if (announcementLink !== undefined && announcementLink !== null && !httpUrl(announcementLink)) {
    return NextResponse.json({ error: 'El enlace del anuncio debe ser una URL http/https.', field: 'announcement' }, { status: 422 })
  }
  const heroPromoImage = body.settings?.hero?.promo_image_url
  if (heroPromoImage !== undefined && heroPromoImage !== null && !httpUrl(heroPromoImage)) {
    return NextResponse.json({ error: 'La imagen del destacado debe ser una URL http/https.', field: 'hero' }, { status: 422 })
  }
  const heroPromoLink = body.settings?.hero?.promo_cta_link
  if (heroPromoLink !== undefined && heroPromoLink !== null && !httpUrl(heroPromoLink)) {
    return NextResponse.json({ error: 'El enlace del botón destacado debe ser una URL http/https.', field: 'hero' }, { status: 422 })
  }
  // Living Shop (epic 07, Story 3.1). Validated through the SAME module the
  // renderer, the importer and the MCP tools use (epic D12) — an agent must not
  // be able to reach a laxer write path than a human. The route REFUSES here
  // rather than normalizing silently: a seller is present to read the reason,
  // which is exactly the difference between this boundary and the renderer's.
  let normalizedSections: unknown
  if (body.settings?.sections !== undefined) {
    const sectionResult = validateSectionConfig(body.settings.sections)
    if (!sectionResult.ok) {
      return NextResponse.json({ error: sectionResult.issues[0], field: 'sections' }, { status: 422 })
    }
    normalizedSections = sectionResult.value
  }

  const launchpadGuidelines = body.settings?.launchpad?.guidelines
  if (launchpadGuidelines !== undefined && launchpadGuidelines !== null && launchpadGuidelines.length > 2000) {
    return NextResponse.json({ error: 'Las indicaciones de la convocatoria no pueden superar los 2000 caracteres.', field: 'launchpad' }, { status: 422 })
  }

  // ── Fetch current shop ────────────────────────────────────────────────────
  const { data: shop, error: fetchErr } = await db
    .from('marketplace_shops')
    .select('id, metadata')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (fetchErr || !shop) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  // ── Build update payload ──────────────────────────────────────────────────
  const location = [body.city?.trim(), body.state?.trim()].filter(Boolean).join(', ') || undefined

  // Deep-merge settings into existing metadata
  const existingMeta = (shop.metadata ?? {}) as Record<string, unknown>
  const existingSettings = (existingMeta.settings ?? {}) as Record<string, unknown>

  let settingsOverride = body.settings ? (body.settings as Record<string, unknown>) : {}
  let clerkJwtForMedusa: string | null = null
  let supportProductId: string | null = null

  const checkoutOverride = (settingsOverride.checkout ?? null) as Record<string, unknown> | null
  if (checkoutOverride && Object.prototype.hasOwnProperty.call(checkoutOverride, 'show_email')) {
    const user = await currentUser()
    const email =
      user?.primaryEmailAddress?.emailAddress ??
      user?.emailAddresses[0]?.emailAddress ??
      null

    settingsOverride = {
      ...settingsOverride,
      checkout: {
        ...checkoutOverride,
        contact_email: checkoutOverride.show_email === true ? email : null,
      },
    }
  }

  if (Object.prototype.hasOwnProperty.call(settingsOverride, 'support')) {
    const normalizedSupport = normalizeSupportSettings(settingsOverride.support)
    if (!normalizedSupport.ok) {
      return NextResponse.json(
        { error: normalizedSupport.error, field: normalizedSupport.field },
        { status: 422 },
      )
    }

    let supportSettings = normalizedSupport.settings
    if (supportSettings.enabled) {
      clerkJwtForMedusa = await getToken()
      if (!clerkJwtForMedusa) return NextResponse.json({ error: 'Error de autenticación.' }, { status: 401 })

      const provisionRes = await medusaFetch('/store/sellers/me/support-product', clerkJwtForMedusa, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      const provisionData = await provisionRes.json().catch(() => ({})) as { product_id?: string; message?: string }
      if (!provisionRes.ok || !provisionData.product_id) {
        console.error('[sell/shop] support product provision failed:', provisionRes.status, provisionData)
        return NextResponse.json(
          { error: provisionData.message ?? 'No se pudo preparar el producto de apoyos.', field: 'support' },
          { status: 502 },
        )
      }
      supportProductId = provisionData.product_id
      supportSettings = { ...supportSettings, support_product_id: supportProductId }
    }

    settingsOverride = { ...settingsOverride, support: supportSettings }
  }

  // Merge stripe_enabled into metadata.settings.stripe
  if (body.stripe_enabled !== undefined) {
    const existingStripe = (existingSettings.stripe ?? {}) as Record<string, unknown>
    settingsOverride = { ...settingsOverride, stripe: { ...existingStripe, enabled: body.stripe_enabled } }
  }

  // The NORMALIZED value is what gets persisted, never the raw body — otherwise
  // a stored order could contain an unknown key that every reader then has to
  // defend against forever.
  if (normalizedSections !== undefined) {
    settingsOverride = { ...settingsOverride, sections: normalizedSections }
  }

  const mergedSettings = Object.keys(settingsOverride).length > 0
    ? deepMerge(existingSettings, settingsOverride)
    : existingSettings

  const updates: Record<string, unknown> = {
    metadata: { ...existingMeta, settings: mergedSettings },
  }
  if (body.name !== undefined) updates.name = body.name.trim()
  if (body.description !== undefined) updates.description = body.description.trim() || null
  if (location !== undefined) updates.location = location
  if (body.logo_url !== undefined) updates.logo_url = body.logo_url
  if (body.mp_enabled !== undefined) updates.mp_enabled = body.mp_enabled
  if (body.ucp_webhook_url !== undefined) updates.ucp_webhook_url = body.ucp_webhook_url
  if (body.ucp_webhook_secret !== undefined) updates.ucp_webhook_secret = body.ucp_webhook_secret

  const { error } = await db
    .from('marketplace_shops')
    .update(updates)
    .eq('id', shop.id)

  if (error) {
    console.error('Shop update error:', error)
    return NextResponse.json({ error: 'Error al guardar cambios.' }, { status: 500 })
  }

  // ── Sync settings to the Medusa seller record ───────────────────────────────
  //
  // 🚨 THIS IS NOT COSMETIC, AND IT USED TO BE SILENT.
  //
  // The PUBLIC shop page reads its settings from the MEDUSA SELLER, not from the
  // `marketplace_shops` row written above. So a merchant's change only reaches
  // their storefront if this sync lands. It was wrapped in a try/catch that
  // logged and swallowed, and the route returned `{ ok: true }` either way —
  // which meant "Guardado." was shown for saves that never reached the shop.
  //
  // Observed in production 2026-08-19: a merchant switched their theme, saw the
  // success toast, and their storefront did not change; Supabase had the new
  // value and Medusa did not. The same divergence had silently stranded two
  // other shops' `theme_preset` for weeks.
  //
  // The sync stays NON-FATAL — the Supabase write already succeeded and failing
  // the whole request would be a lie in the other direction — but the outcome is
  // now REPORTED, and the caller surfaces it. Three states, never two: saved and
  // live, saved but not yet live, or not saved at all.
  let storefrontSynced = true
  let storefrontError: string | null = null
  try {
    const clerkJwt = clerkJwtForMedusa ?? await getToken()
    if (clerkJwt) {
      const medusaPayload: Record<string, unknown> = {}
      if (body.name !== undefined) medusaPayload.name = body.name.trim()
      if (body.description !== undefined) medusaPayload.description = body.description.trim() || null
      if (location !== undefined) medusaPayload.location = location
      if (body.logo_url !== undefined) medusaPayload.logo_url = body.logo_url
      // Store the full settings blob in Medusa seller metadata so the MCP/UCP
      // layer can read payment methods, escrow mode, and scheduling config.
      if (body.settings || body.mp_enabled !== undefined) {
        medusaPayload.metadata = {
          settings: mergedSettings,
          ...(body.mp_enabled !== undefined && { mp_enabled: body.mp_enabled }),
        }
      }
      if (Object.keys(medusaPayload).length > 0) {
        await syncMedusaSellerProfile(clerkJwt, medusaPayload)
      }
    }
  } catch (e) {
    console.error('[shop/settings] Medusa seller sync failed:', e)
    storefrontSynced = false
    storefrontError = e instanceof Error ? e.message : String(e)
  }

  // Bust listing + shop page caches so PDP/storefront reflect new settings immediately
  revalidateTag('listings', 'default')
  revalidateTag('shops', 'default')

  return NextResponse.json({
    ok: true,
    // Whether the change actually reached the public storefront. A caller that
    // shows a success message MUST read this — `ok` alone only means the
    // settings row was written.
    storefront_synced: storefrontSynced,
    ...(storefrontError ? { storefront_error: storefrontError } : {}),
    ...(supportProductId ? { support_product_id: supportProductId } : {}),
  })
}

// ── Utility: shallow/deep merge ───────────────────────────────────────────────

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const key of Object.keys(override)) {
    const bv = base[key]
    const ov = override[key]
    if (ov !== null && typeof ov === 'object' && !Array.isArray(ov) &&
        bv !== null && typeof bv === 'object' && !Array.isArray(bv)) {
      result[key] = deepMerge(bv as Record<string, unknown>, ov as Record<string, unknown>)
    } else {
      result[key] = ov
    }
  }
  return result
}
