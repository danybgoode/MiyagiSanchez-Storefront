/**
 * lib/setup-guide.ts
 *
 * Pure completion logic for the seller settings index and the "Pon tu tienda en
 * marcha" dashboard guide (seller-portal-setup-guide epic, B.1). Extracted
 * verbatim from `settings/page.tsx`'s `completedSections()` + inline `_ok`
 * derivations — the settings page repoints at `computeShopCompletion` /
 * `completedSectionKeys` with an identical render; nothing in the 12-section
 * logic changed, only its location.
 *
 * `getSetupSteps` is a second, narrower view over the same source of truth: it
 * reuses 3 of the 12 flags (perfil, pagos, envios — the exact fields the epic's
 * step map names) and adds two signals the settings page doesn't track
 * (`productCount`, `shareDone`) to produce the 5-step guide the dashboard card
 * renders.
 */

import { EXISTING_CHANNELS, type TenantIntake } from './onboarding-personalization'
import { canCollect, ownerShopFacts } from './listing-readiness'

export interface ShopRow {
  name: string
  description: string | null
  metadata: Record<string, unknown> | null
  mp_enabled: boolean | null
  custom_domain: string | null
  ucp_webhook_url: string | null
}

export interface ShopCompletionFlags {
  perfil: boolean
  pagos: boolean
  citas: boolean
  canal: boolean
  pedidos: boolean
  politicas: boolean
  envios: boolean
  negociacion: boolean
  notificaciones: boolean
  diseno: boolean
  agentes: boolean
  paginas: boolean
}

/**
 * The native settings editor persists the whole settings tree on every save,
 * so an empty shell (e.g. default accent color, all-null origin address) is
 * NOT "configured". Use value-based checks so a section lights up only when it
 * holds real data — whether typed in by hand or applied by the importer.
 */
export function computeShopCompletion(shop: ShopRow): ShopCompletionFlags {
  const settings = (shop.metadata?.settings ?? {}) as Record<string, unknown>
  const calcomSettings = settings.calcom as { connected?: boolean } | undefined
  const ordersSettings = settings.orders as { processing_time?: string } | undefined
  const returnsPolicySettings = settings.returns_policy as { window?: string } | undefined
  const themeSettings = settings.theme as { banner_url?: string | null; accent_color?: string | null; tagline?: string | null; social?: Record<string, string | null> } | undefined
  const shippingSettings = settings.shipping as { local_pickup?: boolean; envia_enabled?: boolean; pickup_spots?: unknown[]; origin_address?: Record<string, string | null> } | undefined
  const offersSettings = settings.offers as { min_buyer_trust_level?: string; negotiation?: { enabled?: boolean } } | undefined
  const notifSettings = settings.notifications as { email_new_view?: boolean; email_new_message?: boolean } | undefined
  const aboutSettings = settings.about as { body?: string } | null | undefined
  const faqSettings = settings.faq as { items?: unknown[] } | null | undefined

  const hasSocial = !!themeSettings?.social && Object.values(themeSettings.social).some(Boolean)
  const diseno_ok = !!(themeSettings && (themeSettings.banner_url || themeSettings.tagline || hasSocial || (themeSettings.accent_color && themeSettings.accent_color !== '#1d6f42')))
  const hasOrigin = !!shippingSettings?.origin_address && Object.values(shippingSettings.origin_address).some(Boolean)
  const envios_ok = !!(shippingSettings && (shippingSettings.local_pickup || shippingSettings.envia_enabled || hasOrigin || (Array.isArray(shippingSettings.pickup_spots) && shippingSettings.pickup_spots.length > 0)))
  const negociacion_ok = !!(offersSettings && ((offersSettings.min_buyer_trust_level && offersSettings.min_buyer_trust_level !== 'unverified') || offersSettings.negotiation?.enabled))
  const notificaciones_ok = !!(notifSettings && (notifSettings.email_new_view || notifSettings.email_new_message))
  const calcom_ok = !!calcomSettings?.connected
  const orders_ok = !!ordersSettings?.processing_time
  // 'none' = explicitly configured but not a positive trust signal → still mark done
  // '' / undefined = not yet configured → not done
  const returns_ok = !!(returnsPolicySettings?.window)
  const agentes_ok = !!shop.ucp_webhook_url
  const paginas_ok = !!(aboutSettings?.body || (faqSettings?.items?.length ?? 0) > 0)

  return {
    perfil: !!(shop.name && shop.description),
    // NOTE: `shop.mp_enabled` is an opt-OUT column (defaults `true` for every
    // shop — "seller hasn't disabled MP checkout"), NOT a connected-state
    // flag. Using it here made this step read as done for every fresh shop
    // regardless of whether MercadoPago was ever actually connected. Read the
    // real connected state instead (mirrors Pagos.tsx / [section]/page.tsx).
    // The ONE rule's «can collect» (listing-readiness S2.2): this used to count any non-empty CLABE — even 5 digits —
    // and ignore DiMo, so the guide could say «listo» for a shop that cannot take a payment.
    pagos: canCollect(ownerShopFacts(shop.metadata as Record<string, unknown> | null).payments),
    citas: calcom_ok,
    canal: !!shop.custom_domain,
    pedidos: orders_ok,
    politicas: returns_ok,
    envios: envios_ok,
    negociacion: negociacion_ok,
    notificaciones: notificaciones_ok,
    diseno: diseno_ok,
    agentes: agentes_ok,
    paginas: paginas_ok,
  }
}

export function completedSectionKeys(flags: ShopCompletionFlags): Set<string> {
  const done = new Set<string>()
  for (const [key, ok] of Object.entries(flags)) {
    if (ok) done.add(key)
  }
  return done
}

// ── Dashboard setup guide (5-step curated view) ────────────────────────────

export type SetupStepId = 'perfil' | 'catalogo' | 'pagos' | 'envios' | 'comparte'

export interface SetupStep {
  id: SetupStepId
  label: string
  body: string
  estimate?: string
  ctaLabel: string
  ctaHref: string
  done: boolean
  open: boolean
}

interface StepMeta {
  id: SetupStepId
  label: string
  body: string
  estimate?: string
  ctaLabel: string
  ctaHref: string
}

const STEP_META: StepMeta[] = [
  {
    id: 'perfil',
    label: 'Completa el perfil de tu tienda',
    body: 'Agrega un nombre y una descripción claros para que los compradores confíen en tu tienda.',
    ctaLabel: 'Editar perfil',
    ctaHref: '/shop/manage/settings/perfil',
  },
  {
    id: 'catalogo',
    label: 'Publica tu primer producto',
    body: 'Publica al menos un producto, servicio o renta para empezar a vender.',
    ctaLabel: 'Agregar producto',
    ctaHref: '/shop/manage/catalogo',
  },
  {
    id: 'pagos',
    label: 'Activa cómo cobrar',
    body: 'Conecta Mercado Pago, Stripe o SPEI. Sin esto tus compradores no pueden pagarte.',
    estimate: '~4 min',
    ctaLabel: 'Configurar cobros',
    // The settings page, not `/pagos/wizard`. The wizard is one guided path
    // through a section that also holds the direct Stripe/Mercado Pago/SPEI
    // controls, the connection status of each, and the disconnect action — a
    // merchant sent straight into the wizard could not see what was already
    // connected, and the wizard is reachable from the section in one click.
    ctaHref: '/shop/manage/settings/pagos',
  },
  {
    id: 'envios',
    label: 'Configura tus envíos',
    body: 'Define cómo entregas: paquetería, punto de encuentro o recolección.',
    ctaLabel: 'Configurar envíos',
    ctaHref: '/shop/manage/settings/envios',
  },
  {
    id: 'comparte',
    label: 'Comparte tu tienda',
    body: 'Comparte el enlace de tu tienda con tus primeros compradores.',
    ctaLabel: 'Compartir tienda',
    ctaHref: '/shop/manage/canal-propio',
  },
]

export interface GetSetupStepsInput {
  shop: ShopRow
  productCount: number
  shareDone: boolean
}

/**
 * Ordered 5-step guide. `open` marks the one step the card expands.
 *
 * Payments (step 3) is escalated ahead of the normal step order: it's `open`
 * whenever it's incomplete, regardless of what's ahead of it — per the
 * epic's own requirement, "payments named up front (step 3), not sprung
 * after the fact." Without this, a shop created via /sell with an empty
 * (optional) description would leave perfil incomplete and open, silently
 * burying payments behind it, exactly what this guide exists to prevent.
 * Once payments is done, resolution falls back to the first incomplete step
 * in fixed order for the rest. When every step is done, none is open — the
 * card can use that to auto-collapse (B.3).
 */
export function getSetupSteps({ shop, productCount, shareDone }: GetSetupStepsInput): SetupStep[] {
  const flags = computeShopCompletion(shop)
  const doneById: Record<SetupStepId, boolean> = {
    perfil: flags.perfil,
    catalogo: productCount > 0,
    pagos: flags.pagos,
    envios: flags.envios,
    comparte: shareDone,
  }

  const openId: SetupStepId | null = !doneById.pagos
    ? 'pagos'
    : (STEP_META.find((step) => !doneById[step.id])?.id ?? null)

  return STEP_META.map((step) => ({
    ...step,
    done: doneById[step.id],
    open: step.id === openId,
  }))
}

// ── S6 personalization (onboarding three-doors, Sprint 2 · Story 2.3) ──────

/**
 * Additive, fail-safe wrapper over `getSetupSteps`' output: with no intake
 * (or an intake with no existing-channel answer — the ghost path most
 * existing sellers are on, since `tenant_intake` only starts filling from
 * Sprint 1's three-doors flow onward), returns `steps` unchanged — same
 * order, same `done`/`open` flags. With an existing-channel intake, reorders
 * the step ARRAY only (never re-derives `done`/`open`, which stay
 * `getSetupSteps`' fixed pagos-escalation logic) — promotes `catalogo` to
 * the front, reusing the exact "existing channel" signal `personalizeDoors`
 * (Sprint 1) already uses, for one consistent heuristic across the epic.
 */
export function personalizeSetupSteps(steps: SetupStep[], intake: TenantIntake | null): SetupStep[] {
  if (!intake) return steps
  const hasExistingChannel = intake.sellsWhere.some((w) => EXISTING_CHANNELS.includes(w))
  if (!hasExistingChannel) return steps
  const catalogo = steps.find((s) => s.id === 'catalogo')
  if (!catalogo) return steps
  return [catalogo, ...steps.filter((s) => s.id !== 'catalogo')]
}
