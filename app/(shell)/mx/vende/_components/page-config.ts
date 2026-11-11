import { PACKAGES, PACKAGE_FREE_MONTHS, SELLABLE_PACKAGE_SKUS, packageSentence, packageSplit, packagePriceMxn } from '@/lib/promoter-packages'
import type { Dictionary } from '@/lib/dictionary'
import {
  resolveSellerPersonaRoute,
  resolveSellerAcquisitionVariant,
  parseSellerAcquisitionUtm,
  sellerLandingRedirectPath,
  sellerPersonaCtaHref,
  sellerPersonaRouterHref,
  usSellerCtaHref,
  sellerTrustPrompt,
  type SellerAcquisitionVariant,
  type SellerPersonaId,
} from '@/lib/seller-acquisition'
import { buildAgentPrompt } from '@/lib/agent-prompt'
import type { PromoterSettings } from '@/lib/promoter'
import type { PromoterSku } from '@/lib/promoter-skus'
import type { PromoterSkuPrices } from '@/lib/promoter-pricing'
import { fillFixedPricingTokens } from '@/lib/pricing-catalog'
import { SHOP_FEATURES, SHOP_FEATURES_HEADING } from '@/lib/shop-features'
import {
  BUSINESS_TYPE_CARDS,
  BUSINESS_TYPE_COMMON,
  BUSINESS_TYPE_PAGES,
  BUSINESS_PROOF_COPY,
  BUSINESS_TYPE_SLUGS,
  DEMO_SHOPS,
  DEMO_SHOP_COPY,
  businessProofFor,
  businessTypePath,
  isBusinessTypeSlug,
  type BusinessTypeSlug,
  type NewBusinessTypeSlug,
} from '@/lib/business-types'
import type { SellerAcquisitionPageConfig, LandingCallout } from './SellerAcquisitionSections'

type QueryParams = Record<string, string | string[] | undefined | null>
type SellerAcquisitionCopy = Dictionary['sellerAcquisition']
type AnchorCopy = SellerAcquisitionCopy['anchor']
type CreatorCopy = SellerAcquisitionCopy['creadores']
type LocalBusinessCopy = SellerAcquisitionCopy['negocios']
type ServicesCopy = SellerAcquisitionCopy['servicios']
type AutosCopy = SellerAcquisitionCopy['autos']
type MigracionShopifyCopy = SellerAcquisitionCopy['migracionShopify']
type MigracionTiendanubeCopy = SellerAcquisitionCopy['migracionTiendanube']
type MigracionWoocommerceCopy = SellerAcquisitionCopy['migracionWoocommerce']
type MigracionBigcartelCopy = SellerAcquisitionCopy['migracionBigcartel']
type MigracionPlatformCopy =
  | MigracionShopifyCopy
  | MigracionTiendanubeCopy
  | MigracionWoocommerceCopy
  | MigracionBigcartelCopy
type VariantCapablePage = {
  heroTitle: string
  primaryCta: string
  closingCta: string
  variants?: Partial<Record<SellerAcquisitionVariant, Partial<{
    heroTitle: string
    primaryCta: string
    closingCta: string
  }>>>
}

export function buildAnchorPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.anchor

  return {
    ...baseConfig(copy, page, 'vende', query),
    pageId: 'vende',
    // Anchor hero leads with the shared launch trust line (+ "copia el prompt", paired with the visible
    // PromptBlock); personas keep their own per-page trust line. Anchor leads its right panel with the
    // value list (0% · IA · Premium); personas keep their stats.
    trustLine: copy.shared.heroTrustLine,
    heroValues: page.heroValues,
    secondaryCta: {
      label: page.secondaryCta,
      // "¿Qué puedo vender?" jumps to the on-page persona router (which answers exactly that).
      href: '#vende-router-title',
    },
    // Benchmark (with its worked example) + AI-channel + premium-features grid are anchor-only
    // sections; persona builders leave them undefined.
    benchmark: page.benchmark,
    aiChannel: copy.aiChannel,
    // Anchor replaces its social-proof stats block with the premium-features grid.
    premiumFeatures: page.premiumFeatures,
    // root-shop-builder-home D11 — the anchor (now `/`) leads with what a merchant GETS, so its proof
    // block is "Lo que te llevas". Its prices are `{token}`s (pricing-page D8), filled from the one
    // pricing catalog here so no MXN figure is ever hand-typed into copy.
    proofPoints: page.proofPoints.map((point) => ({ ...point, body: fillFixedPricingTokens(point.body, 'es') })),
    sectionOrder: 'anchor',
    marketplaceBonus: {
      title: page.marketplaceBonus.title,
      body: page.marketplaceBonus.body,
      // own-shop-positioning D3: the single Vecindario-benefit line. The marketplace is a benefit of the shop, not the
      // way in, so the old «¿Vienes a comprar?» hero line is gone; a buyer finds the Vecindario in the footer.
      cta: { label: page.marketplaceBonus.ctaLabel, href: '/vecindario', testId: 'vende-marketplace-bonus' },
    },
    // own-shop-positioning S2.1: the six things the shop already does, each linking to the real feature.
    featureStories: {
      title: SHOP_FEATURES_HEADING.es.heading,
      lead: SHOP_FEATURES_HEADING.es.lead,
      items: SHOP_FEATURES.map((feature) => ({
        id: feature.id,
        icon: feature.icon,
        title: feature.es.title,
        tagline: feature.es.tagline,
        body: feature.es.body,
        links: feature.links,
      })),
    },
    // S3.1: one link per kind of business, so a promoter (or a merchant) finds the page that speaks to them.
    businessTypes: {
      title: 'Por tipo de negocio',
      lead: 'Si ya sabes qué vendes, entra a la página hecha para tu tipo de negocio y mira una tienda de ejemplo.',
      cards: BUSINESS_TYPE_SLUGS.map((slug) => ({
        eyebrow: '',
        title: BUSINESS_TYPE_CARDS[slug].title,
        body: BUSINESS_TYPE_CARDS[slug].body,
        icon: BUSINESS_TYPE_CARDS[slug].icon,
        href: businessTypeHref(slug, query),
        testId: `vende-business-type-${slug}`,
      })),
    },
    // D4 — a self-serve page reads the agent line only: no promoter stands behind a visitor who arrived alone.
    support: buildSupportBlock(copy, 'agent'),
    // pricing-page D10 — a link to /mx/precios in the sections, never the hero (prompt-to-shop owns it).
    pricingCallout: {
      title: copy.shared.pricingCallout.title,
      body: fillFixedPricingTokens(copy.shared.pricingCallout.body, 'es'),
      cta: { label: copy.shared.pricingCallout.ctaLabel, href: '/mx/precios', testId: 'vende-pricing-callout' },
    },
    personaRouter: {
      title: page.routerTitle,
      lead: page.routerLead,
      cards: page.routerCards.map((card) => {
        const personaId = card.personaId as SellerPersonaId
        const route = resolveSellerPersonaRoute(personaId)
        return {
          eyebrow: card.eyebrow,
          title: card.title,
          body: card.body,
          icon: card.icon,
          href: sellerPersonaRouterHref(personaId, query),
          statusLabel: card.statusLabel || (route.status === 'upcoming' ? card.statusLabel : undefined),
          testId: `vende-router-${personaId}`,
        }
      }),
    },
  }
}

export function buildCreatorPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.creadores

  return {
    ...baseConfig(copy, page, 'creadores', query),
    pageId: 'creadores',
    secondaryCta: {
      label: page.secondaryCta,
      href: sellerPersonaRouterHref('vende', query),
    },
  }
}

// Platform-migrations epic (03) · Sprint 3 (US-3.2) — negocios/servicios are the personas
// most likely to already run a shop elsewhere, so they get the compact migration nudge;
// the other archetype pages (creadores, mundial, autos) leave it undefined.
function migracionCallout(copy: SellerAcquisitionCopy, testId: string): LandingCallout {
  const callout = copy.shared.migrationCallout
  return {
    title: callout.title,
    body: callout.body,
    cta: { label: callout.ctaLabel, href: '/mx/vende/migracion', testId },
  }
}

export function buildLocalBusinessPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.negocios

  return {
    ...baseConfig(copy, page, 'negocios', query),
    pageId: 'negocios',
    secondaryCta: {
      label: page.secondaryCta,
      href: sellerPersonaRouterHref('vende', query),
    },
    migrationCallout: migracionCallout(copy, 'negocios-migration-callout'),
  }
}

export function buildServicesPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.servicios

  return {
    ...baseConfig(copy, page, 'servicios', query),
    pageId: 'servicios',
    migrationCallout: migracionCallout(copy, 'servicios-migration-callout'),
    secondaryCta: {
      label: page.secondaryCta,
      href: sellerPersonaRouterHref('vende', query),
    },
  }
}

export function buildAutosPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.autos

  return {
    ...baseConfig(copy, page, 'autos', query),
    pageId: 'autos',
    // Unlike the archetype personas (negocios/servicios), the secondary CTA here points at a
    // real, already-live proof — the autos facet browse (cars-vertical-tratocar-parity S1/S2)
    // — instead of routing back into the generic persona picker.
    secondaryCta: {
      label: page.secondaryCta,
      href: '/l?category=autos',
    },
  }
}

/**
 * Platform-migrations epic (03) · Sprint 3 (US-3.1). Standalone content pages — like
 * `/mx/vende/promotor`, they don't sell a seller "archetype" so they deliberately do NOT
 * register as `SellerPersonaId`s. Hrefs are plain strings into the real, already-shipped
 * flows (the Shopify connector, the CSV/paste importer) rather than `sellerPersonaCtaHref`.
 */
type MigracionPlatformSlug = 'shopify' | 'tiendanube' | 'woocommerce' | 'bigcartel'

const MIGRACION_PLATFORM_PATHS: Record<MigracionPlatformSlug, string> = {
  shopify: '/mx/vende/migracion/shopify',
  tiendanube: '/mx/vende/migracion/tiendanube',
  woocommerce: '/mx/vende/migracion/woocommerce',
  bigcartel: '/mx/vende/migracion/bigcartel',
}

function isMigracionPlatformSlug(slug: string): slug is MigracionPlatformSlug {
  return Object.prototype.hasOwnProperty.call(MIGRACION_PLATFORM_PATHS, slug)
}

export function buildMigracionHubPageConfig(
  copy: SellerAcquisitionCopy,
  opts: { migrationPriceMxn?: number | null } = {},
): SellerAcquisitionPageConfig {
  const page = copy.migracion
  const migrationPriceMxn = opts.migrationPriceMxn ?? null

  return {
    pageId: 'migracion',
    variant: 'a',
    eyebrow: page.eyebrow,
    title: page.heroTitle,
    lead: page.heroLead,
    trustLine: page.trustLine,
    trustPrompt: copy.shared.trustPrompt.replaceAll('{url}', 'https://miyagisanchez.com/mx/vende/migracion'),
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: { label: page.primaryCta, href: '/shop/manage/import', testId: 'migracion-primary-cta' },
    secondaryCta: { label: page.secondaryCta, href: '/mx/vende/promotor' },
    // Degrades to the plain hero stats until an admin has configured the migration SKU
    // price (Story 2.1) — never a fabricated/hardcoded number.
    heroStats: migrationPriceMxn != null
      ? [...page.heroStats, { value: `$${migrationPriceMxn}`, label: 'consultor si prefieres que alguien lo haga' }]
      : page.heroStats,
    proofTitle: page.proofTitle,
    proofLead: page.proofLead,
    proofPoints: page.proofPoints,
    personaRouter: {
      title: page.routerTitle,
      lead: page.routerLead,
      cards: page.routerCards.map((card) => ({
        eyebrow: card.eyebrow,
        title: card.title,
        body: card.body,
        icon: card.icon,
        // `card.slug` ultimately comes from admin-editable copy overrides
        // (getOverriddenDictionary), not just the static JSON — a bad/typo'd
        // slug must degrade to the always-valid hub link, never a silent
        // `href={undefined}` (caught in cross-review of this PR).
        href: isMigracionPlatformSlug(card.slug) ? MIGRACION_PLATFORM_PATHS[card.slug] : '/mx/vende/migracion',
        testId: `migracion-router-${card.slug}`,
      })),
    },
    stepsTitle: page.stepsTitle,
    steps: page.steps,
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: page.socialTitle,
    socialBody: page.socialBody,
    socialStats: page.socialStats,
    faqTitle: copy.shared.faqTitle,
    faqs: copy.shared.faqs,
    closingTitle: page.closingTitle,
    closingBody: page.closingBody,
    closingCta: { label: page.closingCta, href: '/shop/manage/import', testId: 'migracion-closing-cta' },
  }
}

function buildMigracionPlatformPageConfig(
  copy: SellerAcquisitionCopy,
  page: MigracionPlatformCopy,
  pageId: 'migracion-shopify' | 'migracion-tiendanube' | 'migracion-woocommerce' | 'migracion-bigcartel',
  pagePath: string,
  primaryHref: string,
): SellerAcquisitionPageConfig {
  return {
    pageId,
    variant: 'a',
    eyebrow: page.eyebrow,
    title: page.heroTitle,
    lead: page.heroLead,
    trustLine: page.trustLine,
    trustPrompt: copy.shared.trustPrompt.replaceAll('{url}', `https://miyagisanchez.com${pagePath}`),
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: { label: page.primaryCta, href: primaryHref, testId: `${pageId}-primary-cta` },
    secondaryCta: { label: page.secondaryCta, href: '/mx/vende/migracion' },
    heroStats: page.heroStats,
    proofTitle: page.proofTitle,
    proofLead: page.proofLead,
    proofPoints: page.proofPoints,
    stepsTitle: page.stepsTitle,
    steps: page.steps,
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: page.socialTitle,
    socialBody: page.socialBody,
    socialStats: page.socialStats,
    faqTitle: copy.shared.faqTitle,
    faqs: copy.shared.faqs,
    closingTitle: page.closingTitle,
    closingBody: page.closingBody,
    closingCta: { label: page.closingCta, href: primaryHref, testId: `${pageId}-closing-cta` },
  }
}

export function buildMigracionShopifyPageConfig(copy: SellerAcquisitionCopy): SellerAcquisitionPageConfig {
  return buildMigracionPlatformPageConfig(copy, copy.migracionShopify, 'migracion-shopify', '/mx/vende/migracion/shopify', '/shop/manage/shopify/import')
}

export function buildMigracionTiendanubePageConfig(copy: SellerAcquisitionCopy): SellerAcquisitionPageConfig {
  return buildMigracionPlatformPageConfig(copy, copy.migracionTiendanube, 'migracion-tiendanube', '/mx/vende/migracion/tiendanube', '/shop/manage/import')
}

export function buildMigracionWoocommercePageConfig(copy: SellerAcquisitionCopy): SellerAcquisitionPageConfig {
  return buildMigracionPlatformPageConfig(copy, copy.migracionWoocommerce, 'migracion-woocommerce', '/mx/vende/migracion/woocommerce', '/shop/manage/import')
}

export function buildMigracionBigcartelPageConfig(copy: SellerAcquisitionCopy): SellerAcquisitionPageConfig {
  return buildMigracionPlatformPageConfig(copy, copy.migracionBigcartel, 'migracion-bigcartel', '/mx/vende/migracion/bigcartel', '/shop/manage/import')
}

/**
 * Promoter resources mini-site (epic 08 · S4 · US-12; rewritten 2026-11-05 around the three options a promoter sells).
 * A STANDALONE content page — it explains the promoter's deal, not a seller archetype — so it deliberately does NOT
 * register as a 6th SellerPersonaId. It reuses the SellerAcquisitionPage component
 * but builds its config directly (plain hrefs to the close workspace + sell-sheet),
 * bypassing the persona-keyed baseConfig. es-MX only (rule #5), like the rest of /mx/vende.
 */
export function buildPromoterPageConfig(
  copy: SellerAcquisitionCopy,
  opts: {
    customDomainPriceMxn: number
    enabled: boolean
    isBoundPromoter?: boolean
    commissionRates?: Record<PromoterSku, number>
    promoterSettings?: PromoterSettings
    /** Accepted for older callers; the page no longer shows per-SKU promoter prices (the three options carry their own). */
    skuPrices?: PromoterSkuPrices
  },
): SellerAcquisitionPageConfig {
  const page = copy.promotor
  const isBoundPromoter = opts.isBoundPromoter ?? false
  const commissionRates: Record<PromoterSku, number> = opts.commissionRates ?? {
    custom_domain: 0,
    print_ad: 0,
    subdomain: 0,
    ml_sync: 0,
    migration: 0,
    negocio_anual: 0,
    negocio_arranque: 0,
    setup_gratis: 0,
    negocio_renewal: 0,
    tienda_anual: 0,
    negocio_semestral: 0,
    tienda_renewal: 0,
    negocio_upgrade: 0,
  }
  const anualKeepMxn = Math.round(packageSplit('negocio_anual', commissionRates.negocio_anual ?? 0).keepCents / 100)
  const tiendaKeepMxn = Math.round(packageSplit('tienda_anual', commissionRates.tienda_anual ?? 0).keepCents / 100)
  const renewalPct = commissionRates.negocio_renewal ?? 0
  const pesosStat = (n: number) => '$' + n.toLocaleString('en-US')
  // The close workspace (`/promotor/cerrar`) 404s when the program is off — hide both CTAs
  // that point there rather than link to a dead page (epic 08 · promoter-funnel-fixes S1.2).
  const closeWorkspaceCta = (label: string, testId: string) =>
    opts.enabled ? { label, href: '/promotor/cerrar', testId } : null
  const APPLY_TEASER_ID = 'promotor-aplica'
  // A visitor who hasn't bound a code yet has nowhere to click "Abrir mi panel" (S1.3) — the
  // self-serve application form doesn't exist until Sprint 2, so the interim CTA anchors to an
  // on-page teaser instead of a dead link. An already-bound promoter keeps the real close-workspace CTA.
  const primaryOrApplyCta = (testId: string) =>
    isBoundPromoter ? closeWorkspaceCta(page.closingCta, testId) : { label: page.applyCta, href: `#${APPLY_TEASER_ID}`, testId }
  return {
    pageId: 'promotor',
    variant: 'a',
    eyebrow: page.eyebrow,
    title: page.heroTitle,
    lead: page.heroLead,
    trustLine: page.trustLine,
    // Single source (epic 08 · promoter-funnel-v2 S1 · US-1.1): the same builder the
    // navbar "Agente IA" sheet uses for this page (resolveAgentContext maps
    // /mx/vende/promotor → kind:'promoter'), so hero and sheet can never drift.
    trustPrompt: buildAgentPrompt({ kind: 'promoter' }),
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: primaryOrApplyCta('promotor-primary-cta'),
    secondaryCta: { label: page.secondaryCta, href: '/mx/vende/promotor/sell-sheet' },
    // Pricing figures — the custom-domain + subdomain prices are fixed numbers; the commission
    // stat is computed from the live admin config (US-1.4) and hidden (not "%"/"0%") until a rate
    // is configured.
    // What a promoter keeps per package, from the live rates (Daniel, 2026-11-05: the money must be the clearest thing
    // on the page). plan-tienda S4.4: the largest and the smallest package on sale; the retired ones are gone.
    heroStats: anualKeepMxn > 0
      ? [
          { value: pesosStat(anualKeepMxn), label: `te quedas por cada ${PACKAGES.negocio_anual.label}` },
          ...(tiendaKeepMxn > 0 ? [{ value: pesosStat(tiendaKeepMxn), label: `te quedas por cada ${PACKAGES.tienda_anual.label}` }] : []),
        ]
      : [],
    proofTitle: page.proofTitle,
    proofLead: page.proofLead,
    // Only the three packages on sale (plan-tienda D11), each with its money first in three plain sentences, then what
    // the merchant gets — the three free months on top. No print ads and no retired packages (Daniel, 2026-11-05).
    proofPoints: SELLABLE_PACKAGE_SKUS.map((sku) => ({
      icon: sku === 'tienda_anual' ? 'iconoir-shop' : 'iconoir-sparks',
      title: PACKAGES[sku].label,
      body: commissionRates[sku]
        ? `${packageSentence(sku, commissionRates[sku])}. ${PACKAGES[sku].summary}: los ${PACKAGE_FREE_MONTHS} meses gratis van además del tiempo pagado.`
        : `Cobras $${packagePriceMxn(sku).toLocaleString('en-US')}; tu parte se confirma con Miyagi Sánchez. ${PACKAGES[sku].summary}.`,
    })),
    stepsTitle: page.stepsTitle,
    steps: page.steps,
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: page.pitchTitle,
    socialBody: page.pitchBody,
    // The 3rd pitch stat becomes a "close N shops/month" earnings example once the representative
    // SKU has a configured rate; degrades to the original placeholder stats until then.
    socialStats: anualKeepMxn > 0
      ? [
          { value: pesosStat(anualKeepMxn), label: `por cada ${PACKAGES.negocio_anual.label}` },
          { value: pesosStat(anualKeepMxn * 5), label: 'al mes, si dejas 5 tiendas así' },
          ...(renewalPct > 0 ? [{ value: `${renewalPct}%`, label: 'de lo que pague el negocio los 12 meses después del paquete' }] : [page.pitchStats[2]]),
        ]
      : page.pitchStats,
    faqTitle: copy.shared.faqTitle,
    // The promoter's own questions: the shared set talks to a MERCHANT about their sales.
    faqs: page.faqs,
    closingTitle: page.closingTitle,
    closingBody: page.closingBody,
    closingCta: primaryOrApplyCta('promotor-closing-cta'),
    applyTeaser: isBoundPromoter
      ? undefined
      : { id: APPLY_TEASER_ID, title: page.apply.title, body: page.apply.body },
  }
}

/**
 * The US recruiting landing rendered on a signed-out `/sell`.
 *
 * It reuses the same `SellerAcquisitionPage` section system the `/mx/vende` family
 * uses, so the two markets stay structurally identical and a layout fix lands on
 * both at once. What differs is entirely COPY and DESTINATION: its own
 * `sellerAcquisition.us` dictionary block (US money and delivery truth, not a
 * translation of the Mexican page) and `usSellerCtaHref`, which carries
 * `market=us` through account creation.
 *
 * Deliberately omits `personaRouter`, `benchmark`, `premiumFeatures` and
 * `aiChannel`: those are anchor-only sections whose content is Mexico-specific
 * (peso benchmarks, the MX persona family), and an empty or translated version of
 * them would be a claim we cannot back in the US yet.
 */
export function buildUsMarketPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.us
  const variant = resolveSellerAcquisitionVariant(query)
  const ctaHref = usSellerCtaHref(query)

  return {
    pageId: 'us',
    variant,
    eyebrow: page.eyebrow,
    title: page.heroTitle,
    lead: page.heroLead,
    trustLine: page.trustLine,
    trustPrompt: copy.shared.trustPrompt,
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: { label: page.primaryCta, href: ctaHref, testId: 'us-primary-cta' },
    secondaryCta: { label: page.secondaryCta, href: '#us-steps-title' },
    heroStats: page.heroStats,
    heroValues: page.heroValues,
    proofTitle: page.proofTitle,
    proofLead: page.proofLead,
    proofPoints: page.proofPoints,
    stepsTitle: page.stepsTitle,
    steps: page.steps,
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: page.socialTitle,
    socialBody: page.socialBody,
    socialStats: page.socialStats,
    // The US block carries its OWN FAQs: the shared set answers with MercadoPago,
    // SPEI and cash, none of which exist on a US checkout.
    faqTitle: page.faqTitle,
    faqs: page.faqs,
    closingTitle: page.closingTitle,
    closingBody: page.closingBody,
    closingCta: { label: page.closingCta, href: ctaHref, testId: 'us-closing-cta' },
  }
}

/**
 * Where a business-type card goes: the page itself, carrying the visitor's campaign (UTM) and A/B variant like every
 * other router card does.
 */
function businessTypeHref(slug: BusinessTypeSlug, query: QueryParams): string {
  const utm = parseSellerAcquisitionUtm(query)
  const params = new URLSearchParams(utm)
  const qs = params.toString()
  return qs ? `${businessTypePath(slug)}?${qs}` : businessTypePath(slug)
}

/**
 * The D4 support block. `promoter` (a business-type page a promoter sends) names the promoter on their own WhatsApp and
 * the merchant's AI agent; `agent` (a self-serve page) names the agent only. There is no platform phone number and no
 * promised hours anywhere in it.
 */
function buildSupportBlock(copy: SellerAcquisitionCopy, mode: 'promoter' | 'agent'): SellerAcquisitionPageConfig['support'] {
  const support = copy.shared.support
  const agent = { icon: 'iconoir-sparks', title: support.agent.title, body: support.agent.body }
  if (mode === 'agent') {
    return { title: support.title, lead: support.agentLead, items: [agent] }
  }
  return {
    title: support.title,
    lead: support.promoterLead,
    items: [{ icon: 'iconoir-chat-bubble', title: support.promoter.title, body: support.promoter.body }, agent],
  }
}

/** A business-type page's primary/closing CTA: the shop builder at `/`, carrying the campaign and which page sent them. */
function businessTypeCtaHref(slug: BusinessTypeSlug, query: QueryParams): string {
  return sellerLandingRedirectPath('mx', { ...query, from: slug })
}

/**
 * One of the eight business-type pages written in `lib/business-types.ts` (own-shop-positioning S3.1). Same section
 * system as every other `/mx/vende/*` page, plus the labelled demo shop, the proof slot and the promoter support block.
 */
export function buildBusinessTypePageConfig(
  copy: SellerAcquisitionCopy,
  slug: NewBusinessTypeSlug,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = BUSINESS_TYPE_PAGES[slug]
  const common = BUSINESS_TYPE_COMMON
  const url = `https://miyagisanchez.com${businessTypePath(slug)}`
  const ctaHref = businessTypeCtaHref(slug, query)

  return {
    pageId: slug,
    variant: resolveSellerAcquisitionVariant(query),
    eyebrow: page.eyebrow,
    title: page.heroTitle,
    lead: page.heroLead,
    trustLine: common.trustLine(url.replace('https://', '')),
    trustPrompt: copy.shared.trustPrompt.replaceAll('{url}', url),
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: { label: common.primaryCta, href: ctaHref, testId: `${slug}-primary-cta` },
    secondaryCta: { label: common.secondaryCta, href: '/mx/precios' },
    heroStats: page.heroStats,
    proofTitle: page.proofTitle,
    proofLead: page.proofLead,
    proofPoints: page.proofPoints,
    demoShop: demoShopBlock(slug),
    realProof: { title: BUSINESS_PROOF_COPY.title, shops: businessProofFor(slug) },
    stepsTitle: common.stepsTitle,
    steps: [...common.steps],
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: '',
    socialBody: '',
    socialStats: [],
    faqTitle: copy.shared.faqTitle,
    faqs: copy.shared.faqs,
    closingTitle: page.closingTitle,
    closingBody: page.closingBody,
    closingCta: { label: common.closingCta, href: ctaHref, testId: `${slug}-closing-cta` },
    support: buildSupportBlock(copy, 'promoter'),
  }
}

function demoShopBlock(slug: BusinessTypeSlug): NonNullable<SellerAcquisitionPageConfig['demoShop']> {
  return {
    badge: DEMO_SHOP_COPY.badge,
    title: DEMO_SHOP_COPY.title,
    disclaimer: DEMO_SHOP_COPY.disclaimer,
    shop: DEMO_SHOPS[slug],
  }
}

/**
 * Where a persona page's CTA goes. `autos` is a business-type page now (S3.1) and says «Abrir mi tienda», so it opens the
 * shop builder at `/` like the other nine; the older personas still go through account creation to the wizard.
 */
function personaCtaHref(personaId: SellerPersonaId, query: QueryParams): string {
  return personaId === 'autos' ? businessTypeCtaHref('autos', query) : sellerPersonaCtaHref(personaId, query)
}

function baseConfig(
  copy: SellerAcquisitionCopy,
  page: AnchorCopy | CreatorCopy | LocalBusinessCopy | ServicesCopy | AutosCopy,
  personaId: SellerPersonaId,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const variant = resolveSellerAcquisitionVariant(query)
  const variantPage = applySellerAcquisitionPageVariant(page, variant)

  return {
    pageId: personaId,
    variant,
    eyebrow: variantPage.eyebrow,
    title: variantPage.heroTitle,
    lead: variantPage.heroLead,
    trustLine: variantPage.trustLine,
    trustPrompt: sellerTrustPrompt(personaId, copy.shared.trustPrompt),
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: {
      label: variantPage.primaryCta,
      href: personaCtaHref(personaId, query),
      testId: `${personaId}-primary-cta`,
    },
    heroStats: variantPage.heroStats,
    proofTitle: variantPage.proofTitle,
    proofLead: variantPage.proofLead,
    proofPoints: variantPage.proofPoints,
    stepsTitle: variantPage.stepsTitle,
    steps: variantPage.steps,
    // Single source for the self-verify aside (replaces every page's old agentTitle/agentBody).
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: variantPage.socialTitle,
    socialBody: variantPage.socialBody,
    socialStats: variantPage.socialStats,
    faqTitle: copy.shared.faqTitle,
    faqs: copy.shared.faqs,
    closingTitle: variantPage.closingTitle,
    closingBody: variantPage.closingBody,
    closingCta: {
      label: variantPage.closingCta,
      href: personaCtaHref(personaId, query),
      testId: `${personaId}-closing-cta`,
    },
    // `autos` and `servicios` are two of the ten business-type pages (S3.1): they gain the same labelled demo shop,
    // proof slot and promoter support block as the eight written ones. The other personas stay as they were.
    ...(isBusinessTypeSlug(personaId)
      ? {
          demoShop: demoShopBlock(personaId),
          realProof: { title: BUSINESS_PROOF_COPY.title, shops: businessProofFor(personaId) },
          support: buildSupportBlock(copy, 'promoter'),
        }
      : { support: buildSupportBlock(copy, 'agent') }),
  }
}

export function applySellerAcquisitionPageVariant<T extends VariantCapablePage>(
  page: T,
  variant: SellerAcquisitionVariant,
): T {
  if (variant === 'a') {
    return page
  }

  const override = page.variants?.[variant]
  if (!override) {
    return page
  }

  return { ...page, ...override }
}
